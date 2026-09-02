// vidabot-generator.ts
// Generator video paralel berbasis API Vidabot (Veo) — kontrak setara runGrokGenerator:
// menghasilkan raw video ke <downloadDir>/raw (jika merge) atau langsung ke downloadDir,
// lalu menggabungkan pasangan raw menjadi vida_merged_*.mp4 dengan audio acak.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mergeVideosCopyWithOptionalAudio } from './video-merger.js';
import { generateVidabotVideo } from './vidabot_api_client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Types ──
export interface VidabotGenConfig {
  bahanFolder: string;
  bahanDir: string;
  promptFile: string;
  promptDir: string;
  aspectRatio: string;      // '9:16' | '16:9' | '1:1'
  downloadDir: string;
  totalVideos: number;      // total raw videos yang dibagi ke workers
  merge?: boolean;
  audioFolder?: string;
  customDownloadDir?: string;
  parallelBrowsers?: number; // dipakai sebagai jumlah worker paralel (API)
  cookie?: string;           // cookie Vidabot opsional
  rateLimitKey?: string;     // identitas state untuk pelacakan rate limit
}

export interface VidabotGenStats {
  success: number;
  failed: number;
  saved: number;
}

export interface VidabotWorkerProgress {
  id: number;
  status: 'idle' | 'running' | 'done' | 'error';
  current: number;
  total: number;
  progress: number;
  message: string;
}

type LogFn = (msg: string) => void;

let isRunning = false;
let stats: VidabotGenStats = { success: 0, failed: 0, saved: 0 };
let workerProgress: VidabotWorkerProgress[] = [];

export function getVidabotGenIsRunning() { return isRunning; }
export function getVidabotStats(): VidabotGenStats { return { ...stats }; }
export function getVidabotBrowserProgress(): VidabotWorkerProgress[] { return workerProgress.map(w => ({ ...w })); }

// Vidabot berbasis API — tidak ada rate limit browser. No-op agar kompatibel dengan orkestrasi.
const vidabotRateLimits: Record<string, { availableAt: string | null; detectedAt: number }> = {};
export function getVidabotRateLimits() { return { ...vidabotRateLimits }; }
export function clearVidabotRateLimit(_key: string) { delete vidabotRateLimits[_key]; }

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /rate[\s_-]*limit|too many requests|quota|http\s*429|\b429\b|limit(?:ed)? reached|limit.*(?:exceed|habis|tercapai)/i.test(message);
}

export async function stopVidabotGenerator() {
  isRunning = false;
}


// ── Helpers ──
function pickRandomImage(folderPath: string): string | null {
  if (!fs.existsSync(folderPath)) return null;
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
  const images = fs.readdirSync(folderPath)
    .filter(f => exts.includes(path.extname(f).toLowerCase()));
  if (images.length === 0) return null;
  const pick = images[Math.floor(Math.random() * images.length)];
  return path.join(folderPath, pick);
}

function loadPromptFromFile(filepath: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    // Support { prompt: "..." } or { prompts: ["...", "..."] }
    if (typeof data.prompt === 'string') return data.prompt;
    if (Array.isArray(data.prompts) && data.prompts.length > 0) {
      return data.prompts[Math.floor(Math.random() * data.prompts.length)];
    }
    for (const val of Object.values(data)) {
      if (typeof val === 'string' && val.length > 5) return val;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Video Merger and Lock Queue ──
let mergeLockPromise: Promise<void> = Promise.resolve();

async function acquireMergeLock(): Promise<() => void> {
  let release: () => void = () => {};
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const currentLock = mergeLockPromise;
  mergeLockPromise = currentLock.then(() => nextLock).catch(() => nextLock);
  await currentLock;
  return release;
}

function mapAspectRatio(ratio: string): 'portrait' | 'landscape' | 'square' {
  if (ratio === '16:9') return 'landscape';
  if (ratio === '1:1') return 'square';
  return 'portrait';
}


async function checkAndMergeVideos(downloadDir: string, audioFolder: string | undefined, log: LogFn): Promise<void> {
  const release = await acquireMergeLock();
  try {
    const rawDir = path.join(downloadDir, 'raw');
    if (!fs.existsSync(rawDir)) {
      fs.mkdirSync(rawDir, { recursive: true });
    }

    // 1. Retrieve all .mp4 files in rawDir sorted by modification time (oldest first)
    let files = fs.readdirSync(rawDir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const p = path.join(rawDir, f);
        return { name: f, path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);

    // 2. Loop and merge pairs
    while (files.length >= 2 && isRunning) {
      const pair = files.splice(0, 2);
      const [v1, v2] = pair;

      log(`[MERGER] Menggabungkan raw video: ${v1.name} dan ${v2.name}`);

      // 3. Pick random audio file from audio/audioFolder
      let pickedAudioPath: string | undefined = undefined;
      if (audioFolder) {
        const audioDir = path.join(__dirname, 'audio', audioFolder);
        if (fs.existsSync(audioDir)) {
          const audioExts = ['.mp3', '.wav'];
          const audioFiles = fs.readdirSync(audioDir)
            .filter(f => audioExts.includes(path.extname(f).toLowerCase()));
          if (audioFiles.length > 0) {
            pickedAudioPath = path.join(audioDir, audioFiles[Math.floor(Math.random() * audioFiles.length)]);
          }
        }
      }

      const mergedFname = `vida_merged_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
      const finalOutputPath = path.join(downloadDir, mergedFname);

      try {
        log(`[MERGER] Memulai merge ke ${mergedFname}...`);
        await mergeVideosCopyWithOptionalAudio(
          [v1.path, v2.path],
          finalOutputPath,
          pickedAudioPath,
          { tempDir: path.join(__dirname, '_tmp_uploads') }
        );

        stats.saved++;
        log(`[MERGER] Berhasil menggabungkan video! Tersimpan ke ${mergedFname}`);

        try { fs.unlinkSync(v1.path); } catch {}
        try { fs.unlinkSync(v2.path); } catch {}
      } catch (err: any) {
        log(`[MERGER] Gagal menggabungkan video: ${err.message}`);
        break;
      }
    }
  } catch (err: any) {
    log(`[MERGER] Error di checkAndMergeVideos: ${err.message}`);
  } finally {
    release();
  }
}

// ════════════════════════════════════════════════════════════
//  ORCHESTRATOR — N workers paralel via API Vidabot
// ════════════════════════════════════════════════════════════
export async function runVidabotGenerator(config: VidabotGenConfig, log: LogFn, _baseDir: string): Promise<void> {
  isRunning = true;
  stats = { success: 0, failed: 0, saved: 0 };

  const bahanFolderPath = path.join(config.bahanDir, config.bahanFolder);
  const promptFilePath = path.join(config.promptDir, config.promptFile);
  if (config.bahanFolder && !fs.existsSync(bahanFolderPath)) { log('⚠ Folder bahan tidak ditemukan — lanjut tanpa gambar'); }
  if (!fs.existsSync(promptFilePath)) { log('❌ Prompt file tidak ditemukan: ' + promptFilePath); isRunning = false; return; }

  const downloadDir = config.customDownloadDir || config.downloadDir;
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const total = Math.max(1, config.totalVideos || 1);
  const numWorkers = Math.min(total, config.parallelBrowsers || 1);

  // Distribute evenly
  const perWorker: number[] = [];
  const base = Math.floor(total / numWorkers);
  const remainder = total % numWorkers;
  for (let i = 0; i < numWorkers; i++) perWorker.push(base + (i < remainder ? 1 : 0));

  log(`🚀 ${numWorkers} worker × [${perWorker.join(',')}] = ${total} total video (API Vidabot)`);
  log(`📂 ${downloadDir}`);
  log(`⚙️ Aspect: ${config.aspectRatio} → ${mapAspectRatio(config.aspectRatio)}${config.merge ? ' | Merge: ON' : ''}`);

  workerProgress = perWorker.map((t, i) => ({
    id: i, status: 'idle' as const, current: 0, total: t, progress: 0, message: 'Menunggu...',
  }));

  const workers = perWorker.map((count, idx) =>
    runVidabotWorker(idx, count, config, downloadDir, bahanFolderPath, promptFilePath, log)
  );
  await Promise.allSettled(workers);

  isRunning = false;
  log(`\n✅ Semua selesai — ✅ ${stats.success} | ❌ ${stats.failed} | 💾 ${stats.saved}`);
}

// ════════════════════════════════════════════════════════════
//  PER-WORKER GENERATION
// ════════════════════════════════════════════════════════════
async function runVidabotWorker(
  idx: number, count: number, config: VidabotGenConfig,
  downloadDir: string,
  bahanFolderPath: string, promptFilePath: string,
  log: LogFn,
): Promise<void> {
  const tag = `[W${idx}]`;
  const bp = workerProgress[idx];
  bp.status = 'running'; bp.message = 'Menyiapkan...';

  const useMerge = !!config.merge;

  for (let i = 0; i < count && isRunning; i++) {
    bp.current = i; bp.progress = 0; bp.message = `Generating ${i + 1}/${count}`;

    const prompt = loadPromptFromFile(promptFilePath);
    if (!prompt) { log(`${tag} ❌ Prompt error`); stats.failed++; bp.status = 'error'; break; }

    let imageBase64: string | undefined = undefined;
    if (config.bahanFolder && fs.existsSync(bahanFolderPath)) {
      const imgPath = pickRandomImage(bahanFolderPath);
      if (imgPath) imageBase64 = fs.readFileSync(imgPath).toString('base64');
    }

    log(`${tag} 🎬 #${i + 1}/${count} — "${prompt.substring(0, 50)}..."`);

    try {
      await generateVidabotVideo({
        promptText: prompt,
        imageBase64,
        aspectRatio: mapAspectRatio(config.aspectRatio),
        cookie: config.cookie,
        outputDir: useMerge ? path.join(downloadDir, 'raw') : downloadDir,
        filenamePrefix: 'vida',
      }, (msg, pct) => {
        log(`${tag} ${msg}`);
        if (typeof pct === 'number' && pct >= 0) bp.progress = Math.max(0, Math.min(100, pct));
      });

      bp.progress = 100;
      stats.success++;

      if (!isRunning) break;

      if (useMerge) {
        bp.message = `Saved raw #${i + 1}`;
        await checkAndMergeVideos(downloadDir, config.audioFolder, log);
      } else {
        stats.saved++;
        bp.message = `Saved #${i + 1}`;
      }
    } catch (e: any) {
      log(`${tag} ❌ Error: ${e.message}`);
      stats.failed++;
      bp.message = `Error: ${e.message}`.substring(0, 80);
      if (isRateLimitError(e)) {
        const key = config.rateLimitKey || 'vidabot';
        vidabotRateLimits[key] = { availableAt: null, detectedAt: Date.now() };
        isRunning = false;
        bp.status = 'error';
        log(`${tag} 🚫 Rate limit Vidabot terdeteksi. Semua worker dihentikan.`);
        break;
      }
    }

    bp.current = i + 1;
  }
  bp.status = 'done'; bp.current = count; bp.progress = 100; bp.message = `Done (${count})`;
  log(`${tag} ✅ Worker done`);
}
