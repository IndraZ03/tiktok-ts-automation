import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import ffmpegPath from 'ffmpeg-static';

export interface SoundItem {
  id: string;
  originalUrl: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  title?: string;
  filename?: string;
  filePath?: string;
  error?: string;
}

export interface SoundJob {
  id: string;
  status: 'queued' | 'running' | 'completed';
  items: SoundItem[];
  createdAt: number;
  completedAt?: number;
  expiresAt?: number;
}

export interface RunnerDeps {
  execaRunner: typeof execa;
  ffmpegBinary: string;
  tempBaseDir: string;
  now: () => number;
  itemTimeoutMs: number;
  maxSourceBytes: number;
  maxWavBytes: number;
}

const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com']);
const JOB_TTL_MS = 30 * 60 * 1000;

export function validateTikTokUrl(input: unknown): { valid: boolean; error?: string; cleanUrl?: string } {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096) {
    return { valid: false, error: 'URL harus berupa teks, tidak kosong, dan maksimal 4096 karakter' };
  }
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { return { valid: false, error: 'Format URL tidak valid' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    return { valid: false, error: 'Gunakan HTTP(S), tanpa autentikasi atau port kustom' };
  }
  const host = url.hostname.toLowerCase();
  if (!TIKTOK_HOSTS.has(host)) return { valid: false, error: 'Host bukan domain TikTok yang didukung' };
  const shortHost = host === 'vm.tiktok.com' || host === 'vt.tiktok.com';
  const supportedPath = shortHost
    ? /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    : /^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname)
      || /^\/t\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      || /^\/(?:v|share\/video)\/\d+(?:\.html)?\/?$/.test(url.pathname);
  if (!supportedPath) return { valid: false, error: 'Gunakan link video atau short-link TikTok, bukan profil/pencarian' };
  url.hash = '';
  return { valid: true, cleanUrl: url.toString() };
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_').trim().slice(0, 80).replace(/[. ]+$/, '') || 'TikTok Sound';
}

export function isWavFile(filePath: string): boolean {
  let fd: number | undefined;
  try {
    if (fs.statSync(filePath).size < 44) return false;
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function directorySize(directory: string): number {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((size, entry) => {
    if (!entry.isFile()) return size;
    return size + fs.statSync(path.join(directory, entry.name)).size;
  }, 0);
}

export class SoundttService {
  private jobs = new Map<string, SoundJob>();
  private activeItems = 0;
  private activeDownloads = new Map<string, number>();
  private controllers = new Set<AbortController>();
  private cleanupTimer: NodeJS.Timeout;
  private stopped = false;
  private deps: RunnerDeps;

  constructor(deps: Partial<RunnerDeps> = {}) {
    this.deps = {
      execaRunner: deps.execaRunner ?? execa,
      ffmpegBinary: deps.ffmpegBinary ?? (typeof ffmpegPath === 'string' ? ffmpegPath : 'ffmpeg'),
      tempBaseDir: deps.tempBaseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'soundtt-')),
      now: deps.now ?? Date.now,
      itemTimeoutMs: deps.itemTimeoutMs ?? 3 * 60 * 1000,
      maxSourceBytes: deps.maxSourceBytes ?? 100 * 1024 * 1024,
      maxWavBytes: deps.maxWavBytes ?? 110 * 1024 * 1024,
    };
    fs.mkdirSync(this.deps.tempBaseDir, { recursive: true });
    this.cleanupTimer = setInterval(() => this.cleanupExpiredJobs(), 60_000);
    this.cleanupTimer.unref();
  }

  public stop() {
    this.stopped = true;
    clearInterval(this.cleanupTimer);
    for (const controller of this.controllers) controller.abort();
  }

  public createJob(urls: unknown):
    | { success: true; job: SoundJob }
    | { success: false; error: string; code?: string; invalidUrls?: { index: number; reason: string }[] } {
    this.cleanupExpiredJobs();
    if (!Array.isArray(urls) || !urls.length || urls.length > 50) {
      return { success: false, error: 'Masukkan 1–50 link TikTok per antrean' };
    }
    const unique = new Set<string>();
    const invalidUrls: { index: number; reason: string }[] = [];
    urls.forEach((raw, index) => {
      const result = validateTikTokUrl(raw);
      if (!result.valid) invalidUrls.push({ index, reason: result.error! });
      else unique.add(result.cleanUrl!);
    });
    if (invalidUrls.length) return { success: false, error: 'Perbaiki link yang tidak valid', invalidUrls };
    const unfinished = [...this.jobs.values()].filter(job => job.status !== 'completed').length;
    // Cap retained batches as well as running work to bound temporary storage.
    if (this.stopped || unfinished >= 3 || this.jobs.size >= 10) {
      return { success: false, code: 'QUEUE_FULL', error: 'Antrean penuh. Tunggu proses selesai atau file lama kedaluwarsa.' };
    }
    const job: SoundJob = {
      id: randomUUID(), status: 'queued', createdAt: this.deps.now(),
      items: [...unique].map(originalUrl => ({ id: randomUUID(), originalUrl, status: 'queued' })),
    };
    this.jobs.set(job.id, job);
    queueMicrotask(() => this.processNextItems());
    return { success: true, job };
  }

  public getJob(jobId: string): SoundJob | null {
    this.cleanupExpiredJobs();
    return this.jobs.get(jobId) ?? null;
  }

  public getPublicJobView(job: SoundJob) {
    return {
      id: job.id, status: job.status, createdAt: job.createdAt,
      completedAt: job.completedAt, expiresAt: job.expiresAt,
      items: job.items.map(({ filePath: _filePath, ...item }) => ({
        ...item,
        downloadUrl: item.status === 'ready' ? `/api/soundtt/jobs/${job.id}/items/${item.id}/download` : undefined,
      })),
      total: job.items.length,
      readyCount: job.items.filter(item => item.status === 'ready').length,
      failedCount: job.items.filter(item => item.status === 'failed').length,
    };
  }

  public getItemFile(jobId: string, itemId: string) {
    const item = this.getJob(jobId)?.items.find(entry => entry.id === itemId);
    if (!item || item.status !== 'ready' || !item.filePath || !fs.existsSync(item.filePath)) return null;
    return { filePath: item.filePath, filename: item.filename! };
  }

  public retainDownload(filePath: string) {
    this.activeDownloads.set(filePath, (this.activeDownloads.get(filePath) ?? 0) + 1);
  }

  public releaseDownload(filePath: string) {
    const count = this.activeDownloads.get(filePath) ?? 0;
    if (count <= 1) this.activeDownloads.delete(filePath);
    else this.activeDownloads.set(filePath, count - 1);
  }

  private processNextItems() {
    if (this.stopped) return;
    for (const job of this.jobs.values()) {
      for (const item of job.items) {
        if (this.activeItems >= 2) return;
        if (item.status !== 'queued') continue;
        job.status = 'running';
        item.status = 'processing';
        this.activeItems++;
        void this.processSingleItem(job, item).finally(() => {
          this.activeItems--;
          if (job.items.every(entry => entry.status === 'ready' || entry.status === 'failed')) {
            job.status = 'completed';
            job.completedAt = this.deps.now();
            job.expiresAt = job.completedAt + JOB_TTL_MS;
          }
          this.processNextItems();
        });
      }
    }
  }

  private async processSingleItem(job: SoundJob, item: SoundItem) {
    const directory = path.join(this.deps.tempBaseDir, job.id, item.id);
    const controller = new AbortController();
    this.controllers.add(controller);
    let failure = 'Gagal mengambil audio TikTok. Video mungkin privat, dihapus, atau tidak dapat diakses yt-dlp.';
    let sizeLimit = this.deps.maxSourceBytes;
    const timeout = setTimeout(() => {
      failure = 'Proses melebihi batas waktu. Coba lagi nanti.';
      controller.abort();
    }, this.deps.itemTimeoutMs);
    timeout.unref();
    const monitor = setInterval(() => {
      try {
        if (directorySize(directory) > sizeLimit) {
          failure = 'Ukuran media melebihi batas unduhan.';
          controller.abort();
        }
      } catch { /* Directory may not exist yet or has already been removed. */ }
    }, 250);
    monitor.unref();
    const options = {
      cancelSignal: controller.signal, forceKillAfterDelay: 1000,
      timeout: this.deps.itemTimeoutMs, maxBuffer: 2 * 1024 * 1024,
      cwd: path.dirname(this.deps.tempBaseDir), windowsHide: true,
    };
    const baseArgs = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '20', '--retries', '1'];
    try {
      fs.mkdirSync(directory, { recursive: true });
      const metadata = await this.deps.execaRunner('yt-dlp', [...baseArgs, '--dump-single-json', '--', item.originalUrl], { ...options, timeout: 30_000 });
      const info = JSON.parse(String(metadata.stdout));
      if (typeof info.duration === 'number' && info.duration > 600) {
        failure = 'Video melebihi batas durasi 10 menit.';
        throw new Error('duration limit');
      }
      item.title = typeof info.title === 'string' ? info.title.slice(0, 200) : 'TikTok Sound';
      await this.deps.execaRunner('yt-dlp', [
        ...baseArgs, '--max-filesize', String(this.deps.maxSourceBytes),
        '--ffmpeg-location', this.deps.ffmpegBinary, '-f', 'ba/b',
        '-o', path.join(directory, 'source.%(ext)s'), '--', item.originalUrl,
      ], options);
      const sources = fs.readdirSync(directory).filter(name => /^source\.[a-zA-Z0-9]+$/.test(name) && !name.endsWith('.part') && !name.endsWith('.ytdl'));
      if (sources.length !== 1 || directorySize(directory) > this.deps.maxSourceBytes) throw new Error('invalid source');
      const sourcePath = path.join(directory, sources[0]);
      const wavPath = path.join(directory, 'audio.wav');
      failure = 'Gagal mengonversi audio menjadi WAV. Pastikan video memiliki audio.';
      sizeLimit = this.deps.maxSourceBytes + this.deps.maxWavBytes;
      await this.deps.execaRunner(this.deps.ffmpegBinary, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
        '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
        '-fs', String(this.deps.maxWavBytes), wavPath,
      ], options);
      if (controller.signal.aborted || !isWavFile(wavPath) || fs.statSync(wavPath).size >= this.deps.maxWavBytes) throw new Error('invalid WAV');
      fs.unlinkSync(sourcePath);
      item.filename = `${sanitizeFilename(item.title || 'TikTok Sound')}_${item.id.slice(0, 8)}.wav`;
      item.filePath = wavPath;
      item.status = 'ready';
    } catch {
      item.status = 'failed';
      item.error = failure;
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    } finally {
      clearTimeout(timeout);
      clearInterval(monitor);
      this.controllers.delete(controller);
    }
  }

  public cleanupExpiredJobs() {
    for (const [id, job] of this.jobs) {
      if (job.status !== 'completed' || !job.expiresAt || this.deps.now() < job.expiresAt) continue;
      if (job.items.some(item => item.filePath && this.activeDownloads.has(item.filePath))) continue;
      try {
        fs.rmSync(path.join(this.deps.tempBaseDir, id), { recursive: true, force: true });
        this.jobs.delete(id);
      } catch { /* Retry on next cleanup when Windows releases file handles. */ }
    }
  }
}
