import fs from 'node:fs';
import path from 'node:path';
import { AzkayangStore, assertSafeSegment } from './telegram-azkayang-store.js';
import type { TelegramAzkayangApi } from './telegram-azkayang-api.js';
import type { BatchGenerationTask } from './telegram-azkayang-types.js';

export function permutationPairs(count = 4): [number, number][] {
  return Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => [i, j] as [number, number]))
    .flat().filter(([i, j]) => i !== j);
}

export function formatHeartProgress(pct: number, length = 10): string {
  const value = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  const filled = Math.round(value / 100 * length);
  return `[${'🩷'.repeat(filled)}${'🤍'.repeat(length - filled)}] ${value}%`;
}

export function parseGenerateCommand(text: string): { batchCount: number; bahanFolder: string; promptFile: string } | null {
  const match = text.trim().match(/^\/generate(?:@\w+)?\s+([1-3])\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))$/i);
  if (!match) return null;
  const bahanFolder = (match[2] || match[3] || match[4]).trim();
  let promptFile = (match[5] || match[6] || match[7]).trim();
  if (!promptFile.endsWith('.json')) promptFile += '.json';
  try { assertSafeSegment(bahanFolder); assertSafeSegment(promptFile); } catch { return null; }
  return { batchCount: Number(match[1]), bahanFolder, promptFile };
}

type Generate = (opts: any, progress?: (msg: string, pct?: number) => void) => Promise<{ savePath?: string }>;
type Merge = (files: string[], output: string, audio?: string, opts?: any) => Promise<any>;
export interface AzkayangWorkerOptions {
  store: AzkayangStore;
  api: Pick<TelegramAzkayangApi, 'sendMessage' | 'editMessageText' | 'sendVideo'>;
  outputRootDir?: string;
  generateGrokVideoFn?: Generate;
  mergeVideosFn?: Merge;
  sleep?: (ms: number) => Promise<void>;
}
type Output = { file: string; sent: boolean; messageId?: number; error?: string };
type Manifest = { task: BatchGenerationTask; status: string; error?: string; outputs: Output[] };
type Prepared = { task: BatchGenerationTask; dir: string; prompt: string; images: string[]; audio: string; accounts: string[]; manifest: Manifest };
const QUOTA_MESSAGE = 'Yahh kuotanya abizz bebeb. Nnti isi lagi yach.';

export class AzkayangWorker {
  private queue: Prepared[] = [];
  private processing = false;
  private stopped = false;
  private readonly store: AzkayangStore;
  private readonly api: AzkayangWorkerOptions['api'];
  private readonly outputRoot: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private generate?: Generate;
  private merge?: Merge;
  private limited = new Map<string, number>();

  constructor(options: AzkayangWorkerOptions) {
    this.store = options.store;
    this.api = options.api;
    this.outputRoot = options.outputRootDir || path.join(this.store.rootDir, 'grok-downloads', 'azkayang');
    this.generate = options.generateGrokVideoFn;
    this.merge = options.mergeVideosFn;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  get busy(): boolean { return this.processing; }
  get pendingSize(): number { return this.queue.length; }

  async enqueue(input: BatchGenerationTask): Promise<number> {
    if (this.stopped) throw new Error('Worker sedang dihentikan');
    if (this.queue.length >= 10) throw new Error('Antrean penuh, maksimal 10 tugas menunggu');
    if (!Number.isInteger(input.batchCount) || input.batchCount < 1 || input.batchCount > 3) throw new Error('Batch harus 1–3');
    assertSafeSegment(input.id);
    const accounts = this.store.load().grokAccounts;
    if (accounts.length !== 2 || !accounts.every(Boolean) || accounts[0] === accounts[1]) throw new Error('Admin wajib memilih dua akun Grok berbeda');
    for (const account of accounts) assertSafeSegment(account);
    const prompt = this.store.readPrompt(input.promptFile);
    const names = this.store.listImages(input.bahanFolder);
    if (!names.length) throw new Error('Stok bahan belum berisi foto');
    const audioSource = path.join(this.store.rootDir, 'audio', 'merge-upload-default.wav');
    if (!fs.existsSync(audioSource) || fs.lstatSync(audioSource).isSymbolicLink() || !fs.statSync(audioSource).isFile()) {
      throw new Error('Sound wajib tersedia di audio/merge-upload-default.wav');
    }
    const task = { ...input };
    const dir = path.join(this.outputRoot, task.id);
    fs.mkdirSync(this.outputRoot, { recursive: true });
    fs.mkdirSync(dir); // Never overwrite an earlier job.
    const manifest: Manifest = { task, status: 'queued', outputs: [] };
    try {
      const inputs = path.join(dir, 'inputs');
      fs.mkdirSync(inputs);
      const images = names.map((name, i) => {
        const source = this.store.imageUploadPath(task.bahanFolder, name);
        if (fs.statSync(source).size > 20 * 1024 * 1024) throw new Error('Foto bahan melebihi 20MB');
        const dest = path.join(inputs, `${i}${path.extname(name)}`);
        fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
        return dest;
      });
      fs.writeFileSync(path.join(inputs, 'prompt.json'), JSON.stringify({ prompt }));
      const audio = path.join(inputs, 'sound.wav');
      fs.copyFileSync(audioSource, audio, fs.constants.COPYFILE_EXCL);
      const job = { task, dir, prompt, images, audio, accounts: [...accounts], manifest };
      this.save(job);
      const position = this.queue.length + (this.processing ? 1 : 0);
      this.queue.push(job);
      void this.drain();
      return position;
    } catch (err) {
      manifest.status = 'rejected'; manifest.error = (err as Error).message;
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      throw err;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.queue) { job.manifest.status = 'cancelled'; this.save(job); }
    this.queue = [];
  }
  async idle(): Promise<void> {
    while (this.processing || this.queue.length) await new Promise(resolve => setTimeout(resolve, 10));
  }
  private checkStop(): void { if (this.stopped) throw new Error('Proses dihentikan. File parsial dipertahankan.'); }
  private save(job: Prepared): void {
    const target = path.join(job.dir, 'manifest.json');
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(job.manifest, null, 2));
    fs.renameSync(`${target}.tmp`, target);
  }
  private async drain(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        try {
          job.manifest.status = 'running'; this.save(job);
          await this.execute(job);
          job.manifest.status = 'completed'; this.save(job);
        } catch (err) {
          job.manifest.status = this.stopped ? 'cancelled' : 'failed';
          job.manifest.error = (err as Error).message;
          this.save(job);
          const message = (err as Error).message === QUOTA_MESSAGE ? QUOTA_MESSAGE :
            `Proses gagal: ${(err as Error).message}\nHasil parsial tersimpan di grok-downloads/azkayang/${job.task.id}.`;
          await this.api.sendMessage(job.task.chatId, message).catch(() => {});
        }
      }
    } finally { this.processing = false; }
  }

  private async execute(job: Prepared): Promise<void> {
    if (!this.generate) this.generate = (await import('./grok_browser_client.js')).generateGrokVideoBrowser;
    if (!this.merge) this.merge = (await import('./video-merger.js')).mergeVideosCopyWithOptionalAudio;
    const { task } = job;
    const message = await this.api.sendMessage(task.chatId, 'Tungguin ya cayanggg lagi generate🩷🩷🩷🩷');
    let lastEdit = 0;
    let highest = 0;
    let editing = Promise.resolve();
    const progress = (phase: string, value: number, force = false): Promise<void> => {
      if (!force && Date.now() - lastEdit < 2500) return editing;
      lastEdit = Date.now();
      highest = Math.max(highest, value);
      const text = `Tungguin ya cayanggg lagi generate🩷🩷🩷🩷\n${phase}\n${formatHeartProgress(highest)}`;
      editing = editing.then(() => this.api.editMessageText(task.chatId, message.message_id, text)).catch(() => {});
      return editing;
    };
    let active = 0;
    for (let b = 0; b < task.batchCount; b++) {
      this.checkStop();
      const dir = path.join(job.dir, `batch-${b + 1}`);
      fs.mkdirSync(dir);
      const raw: string[] = [];
      const total = (pct: number) => ((b + pct / 100) / task.batchCount) * 100;
      for (let r = 0; r < 4; r++) {
        this.checkStop();
        let result: { savePath?: string } | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          this.checkStop();
          if ((this.limited.get(job.accounts[active]) || 0) > Date.now()) active = 1 - active;
          if (job.accounts.every(a => (this.limited.get(a) || 0) > Date.now())) throw new Error(QUOTA_MESSAGE);
          const account = job.accounts[active];
          await progress(`Batch ${b + 1}/${task.batchCount}: lagi generate raw ${r + 1}/4 sayangku, akun ${active + 1}`, total(r * 20), true);
          try {
            result = await this.generate!({
              stateName: account.replace(/^grok-state-/, '').replace(/\.json$/i, ''), promptText: job.prompt,
              imagePath: job.images[r % job.images.length], resolution: '720p', duration: '10s', aspectRatio: '9:16', headless: true,
            }, (phase, pct = 0) => {
              void progress(`Batch ${b + 1}/${task.batchCount}, raw ${r + 1}/4: ${phase}`, total(r * 20 + Math.max(0, Math.min(100, pct)) * .2));
            });
            break;
          } catch (err) {
            if (!/rate[ _-]?limit|terlalu banyak permintaan|\bquota\b|\bkuota\b|too many requests|\b429\b|coba lagi nanti|try again later/i.test((err as Error).message)) throw err;
            this.limited.set(account, Date.now() + 15 * 60_000);
            active = 1 - active;
            if (job.accounts.every(a => (this.limited.get(a) || 0) > Date.now())) throw new Error(QUOTA_MESSAGE);
          }
        }
        if (!result?.savePath || !fs.existsSync(result.savePath)) throw new Error('Grok tidak menghasilkan file video');
        const dest = path.join(dir, `raw_${r + 1}.mp4`);
        fs.copyFileSync(result.savePath, dest);
        raw.push(dest);
      }
      const outputs: Output[] = [];
      for (const [i, j] of permutationPairs()) {
        this.checkStop();
        const file = path.join(dir, `grok_merged_${i + 1}${j + 1}.mp4`);
        await this.merge!([raw[i], raw[j]], file, job.audio, { tempDir: dir, durationSeconds: 20 });
        const output = { file, sent: false };
        outputs.push(output); job.manifest.outputs.push(output); this.save(job);
        await progress(`Batch ${b + 1}/${task.batchCount}: lagi gabung ${outputs.length}/12 sayangku`, total(80 + outputs.length / 12 * 15));
      }
      for (let i = 0; i < outputs.length; i++) {
        this.checkStop();
        try {
          const sent = await this.api.sendVideo(task.chatId, outputs[i].file, `Ini hasilnya ya cayanggg🩷 Video ${i + 1}/12, batch ${b + 1}/${task.batchCount}`);
          outputs[i].sent = true; outputs[i].messageId = sent?.message_id; this.save(job);
        } catch (err) { outputs[i].error = (err as Error).message; this.save(job); throw err; }
        await progress(`Batch ${b + 1}/${task.batchCount}: mengirim ${i + 1}/12`, Math.min(99, total(95 + (i + 1) / 12 * 5)));
        if (i + 1 < outputs.length) await this.sleep(1500);
      }
    }
    this.checkStop();
    await progress('Semua batch selesai dikirim ya cayanggg!', 100, true);
  }
}
