// tiktok-state-manager.ts
// Jalankan dengan: npx ts-node tiktok-state-manager.ts
// Atau compile dulu: npx tsc && node dist/tiktok-state-manager.js

import express, { Request, Response } from 'express';
import { chromium, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { runUpload, stopUploader, getIsRunning } from './tiktok-uploader.js';
import { runGrokGenerator, stopGrokGenerator, getGrokIsRunning, getGrokStats, getBrowserProgress, BrowserProgress, getGrokRateLimits, clearGrokRateLimit } from './grok-uploader.js';
import multer from 'multer';
import { mergeVideosCopyWithOptionalAudio } from './video-merger.js';
import { splitAndProcessVideo, SplitProgressEvent } from './video-splitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.static('public'));

// Multer for bahan image uploads
const bahanUpload = multer({ dest: path.join(__dirname, '_tmp_uploads') });
const mergeUpload = multer({ dest: path.join(__dirname, '_tmp_uploads', 'merge') });

const STATES_DIR = path.join(__dirname, 'tiktok-states');
if (!fs.existsSync(STATES_DIR)) {
  fs.mkdirSync(STATES_DIR, { recursive: true });
}

const GROK_STATES_DIR = path.join(__dirname, 'grok-states');
if (!fs.existsSync(GROK_STATES_DIR)) {
  fs.mkdirSync(GROK_STATES_DIR, { recursive: true });
}

const MERGED_VIDEO_DIR = path.join(__dirname, 'merged-videos');
if (!fs.existsSync(MERGED_VIDEO_DIR)) {
  fs.mkdirSync(MERGED_VIDEO_DIR, { recursive: true });
}

const SPLIT_VIDEO_DIR = path.join(__dirname, 'split-videos');
if (!fs.existsSync(SPLIT_VIDEO_DIR)) {
  fs.mkdirSync(SPLIT_VIDEO_DIR, { recursive: true });
}

// ═══════════════════════════════════════════════════════════
//  YTBOT CONSTANTS
// ═══════════════════════════════════════════════════════════
const YTBOT_DATA_FILE = path.join(__dirname, 'ytbot-data.json');
const YTBOT_VIDEO_DIR = path.join(__dirname, 'ytbot-videos');
if (!fs.existsSync(YTBOT_VIDEO_DIR)) {
  fs.mkdirSync(YTBOT_VIDEO_DIR, { recursive: true });
}

interface YtbotStateConfig {
  ytLinks: string[];
  description: string;
  hashtags: string;
  scheduleDate: string;
  scheduleTime: string;
  intervalMinutes: number;
}

interface YtbotData {
  states: Record<string, YtbotStateConfig>;
}

function loadYtbotData(): YtbotData {
  try {
    return JSON.parse(fs.readFileSync(YTBOT_DATA_FILE, 'utf-8'));
  } catch {
    return { states: {} };
  }
}

function saveYtbotData(data: YtbotData) {
  fs.writeFileSync(YTBOT_DATA_FILE, JSON.stringify(data, null, 2));
}

function getYtbotStateVideoDir(stateFile: string): string {
  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const dir = path.join(YTBOT_VIDEO_DIR, stateName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// YTBOT SSE + running state
const ytbotSseClients: Response[] = [];
let ytbotRunning = false;
let ytbotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let ytbotProgress = {
  download: 0,
  split: 0,
  upload: 0,
  currentState: ''
};

function ytbotLog(msg: string) {
  console.log(`[YTBOT] ${msg}`);
  ytbotSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

function ytbotBroadcastQueue() {
  ytbotSseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(ytbotQueue)}\n\n`));
}

function ytbotBroadcastProgress() {
  ytbotSseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(ytbotProgress)}\n\n`));
}


// Variabel global untuk session yang sedang dibuat (hanya 1 pada satu waktu)
let currentPlatform: 'tiktok' | 'grok' = 'tiktok';
let currentContext: BrowserContext | null = null;
let currentStateName: string = '';
let currentEditingFilename: string | null = null;
// Ganti fungsi getSavedStates() yang lama dengan ini
function getSavedStates(platform: 'tiktok' | 'grok' = 'tiktok') {
  const dir = platform === 'grok' ? GROK_STATES_DIR : STATES_DIR;
  const prefix = platform === 'grok' ? 'grok-state-' : 'tiktok-state-';

  const files = fs.readdirSync(dir)
    .filter(file => file.startsWith(prefix) && file.endsWith('.json'));

  return files.map(file => {
    const name = file.replace(prefix, '').replace('.json', '');
    const filepath = path.join(dir, file);

    let expiryInfo = {
      expiresAt: null as string | null,
      daysLeft: null as number | null,
      status: 'unknown' as 'safe' | 'warning' | 'expired' | 'unknown'
    };

    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      const cookies = data.cookies || [];

      // Cari cookie penting TikTok (yang biasanya paling cepat expired)
      const importantCookies = ['sessionid', 'sessionid_ss', 'sid_tt', 'ttwid'];
      let earliestExpiry = Infinity;

      cookies.forEach((cookie: any) => {
        if (importantCookies.includes(cookie.name) && cookie.expires && cookie.expires > 0) {
          if (cookie.expires < earliestExpiry) {
            earliestExpiry = cookie.expires;
          }
        }
      });

      if (earliestExpiry !== Infinity) {
        const expiryDate = new Date(earliestExpiry * 1000); // expires dalam detik â†’ ms
        const now = Date.now();
        const diffMs = expiryDate.getTime() - now;
        const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        expiryInfo = {
          expiresAt: expiryDate.toLocaleString('id-ID', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          }),
          daysLeft: daysLeft > 0 ? daysLeft : 0,
          status: daysLeft > 7 ? 'safe' : (daysLeft > 0 ? 'warning' : 'expired')
        };
      }
    } catch (e) {
      // kalau file rusak, tetap tampil tanpa expiry
    }

    return { name, filename: file, expiry: expiryInfo };
  });
}

// === API ROUTES ===
app.get('/api/states', (req, res) => {
  const platform = req.query.platform === 'grok' ? 'grok' : 'tiktok';
  res.json(getSavedStates(platform));
});

app.post('/api/start-login', async (req, res) => {
  const { name, platform = 'tiktok' } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Nama state harus diisi!' });
  }

  if (currentContext) {
    await currentContext.close();
  }

  currentStateName = name.trim();
  currentPlatform = platform as 'tiktok' | 'grok';

  try {
    // â”€â”€â”€â”€â”€â”€â”€â”€ LAUNCH BROWSER (ini yang diperbaiki) â”€â”€â”€â”€â”€â”€â”€â”€
    const browser = await chromium.launch({
      headless: false,
      slowMo: 150,
      channel: 'chrome',                    // pakai Google Chrome asli
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
      ignoreDefaultArgs: ['--enable-automation'],   // â† dipindah ke sini
    });

    // â”€â”€â”€â”€â”€â”€â”€â”€ NEW CONTEXT â”€â”€â”€â”€â”€â”€â”€â”€
    currentContext = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
    });

    const page = await currentContext.newPage();

    // Stealth tambahan (hapus jejak automation)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const url = currentPlatform === 'grok' ? 'https://accounts.x.ai/sign-in?redirect=grok-com' : 'https://www.tiktok.com';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log(`âœ… Browser stealth dibuka untuk state: ${currentStateName}`);
    res.json({
      success: true,
      message: 'Browser stealth sudah terbuka!\nSilakan login manual di TikTok.\nSetelah login selesai, klik tombol "Sudah Login" di web.'
    });
  } catch (err: any) {
    console.error(err);
    currentContext = null;
    res.status(500).json({ error: 'Gagal membuka browser: ' + err.message });
  }
});

app.post('/api/start-login-with-state', async (req, res) => {
  const { filename, platform = 'tiktok' } = req.body;

  if (!filename) return res.status(400).json({ error: 'Filename diperlukan' });

  const dir = platform === 'grok' ? GROK_STATES_DIR : STATES_DIR;
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File state tidak ditemukan' });
  }

  if (currentContext) await currentContext.close();

  currentEditingFilename = filename;
  currentStateName = ''; // tidak pakai nama baru
  currentPlatform = platform as 'tiktok' | 'grok';

  try {
    const browser = await chromium.launch({
      headless: false,
      slowMo: 150,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    currentContext = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: { 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
      storageState: filepath,   // â† langsung load session yang sudah ada
    });

    const page = await currentContext.newPage();
    const url = currentPlatform === 'grok' ? 'https://grok.com' : 'https://www.tiktok.com';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    res.json({ success: true, message: `âœ… Browser terbuka dengan session: ${filename}\nLakukan apa saja, lalu klik "Sudah Login"` });
  } catch (err: any) {
    currentContext = null;
    currentEditingFilename = null;
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/open-state', async (req, res) => {
  const { name, platform = 'tiktok' } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Nama state harus diisi!' });
  }

  const prefix = platform === 'grok' ? 'grok-state-' : 'tiktok-state-';
  const dir = platform === 'grok' ? GROK_STATES_DIR : STATES_DIR;
  const filename = `${prefix}${name}.json`;
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'State tidak ditemukan!' });
  }

  try {
    const browser = await chromium.launch({
      headless: false,
      slowMo: 150,
      channel: 'chrome',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
      storageState: filepath
    });

    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const url = platform === 'grok' ? 'https://grok.com' : 'https://www.tiktok.com';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log(`âœ… Browser dibuka dengan state: ${name}`);
    res.json({ success: true, message: 'Browser berhasil dibuka' });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Gagal membuka browser: ' + err.message });
  }
});

app.post('/api/save-login', async (req, res) => {
  if (!currentContext) {
    return res.status(400).json({ error: 'Tidak ada session yang sedang dibuat!' });
  }

  const prefix = currentPlatform === 'grok' ? 'grok-state-' : 'tiktok-state-';
  const dir = currentPlatform === 'grok' ? GROK_STATES_DIR : STATES_DIR;

  let filename: string;
  if (currentEditingFilename) {
    filename = currentEditingFilename;                    // update session lama
  } else {
    filename = `${prefix}${currentStateName}.json`;   // state baru
  }

  const filepath = path.join(dir, filename);

  try {
    await currentContext.storageState({ path: filepath });
    await currentContext.close();

    currentContext = null;
    currentStateName = '';
    currentEditingFilename = null;

    res.json({
      success: true,
      message: `âœ… Session berhasil disimpan ke ${filename}`,
      filename
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menyimpan session' });
  }
});
// === API untuk generate command codegen dengan session ===
app.get('/api/codegen-command', (req, res) => {
  const { filename, platform = 'tiktok' } = req.query;
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'Filename diperlukan' });
  }

  const dir = platform === 'grok' ? 'grok-states' : 'tiktok-states';
  const url = platform === 'grok' ? 'https://grok.com' : 'https://www.tiktok.com';

  const command = `npx playwright codegen \\
  --config playwright.config.ts \\
  --target typescript \\
  --load-storage=${dir}/${filename} \\
  ${url}`;

  res.json({ command });
});

// === TikTok Auto Uploader APIs ===
const sseClients: Response[] = [];

function broadcastLog(msg: string) {
  console.log(`[UPLOADER] ${msg}`);
  sseClients.forEach(client => {
    client.write(`data: ${msg}\n\n`);
  });
}

// SSE endpoint for live logs
app.get('/api/tiktok/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// Browse folder dialog (Windows PowerShell)
app.get('/api/browse-folder', (req, res) => {
  const psScript = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Pilih folder video'; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}`;
  exec(`powershell -NoProfile -Command "${psScript}"`, { timeout: 120000 }, (err, stdout) => {
    if (err) {
      return res.json({ success: false, folder: '' });
    }
    const folder = (stdout || '').trim();
    res.json({ success: !!folder, folder });
  });
});

// List videos in a folder
app.get('/api/tiktok/videos', (req, res) => {
  const folder = req.query.folder as string;
  if (!folder || !fs.existsSync(folder)) {
    return res.json({ videos: [] });
  }
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const videos = fs.readdirSync(folder)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort();
  res.json({ videos });
});

// Get uploaded marks for a folder
app.get('/api/tiktok/uploaded', (req, res) => {
  const folder = req.query.folder as string;
  if (!folder) return res.json({ uploaded: {} });
  const marksFile = path.join(folder, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  res.json({ uploaded: marks });
});

// Mark/unmark a video as uploaded
app.post('/api/tiktok/mark-uploaded', (req, res) => {
  const { folder, video, uploaded } = req.body;
  if (!folder || !video) return res.status(400).json({ error: 'Missing params' });
  const marksFile = path.join(folder, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  if (uploaded) {
    marks[video] = true;
  } else {
    delete marks[video];
  }
  fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
  res.json({ success: true });
});

// Delete uploaded video file + remove mark
app.post('/api/tiktok/delete-uploaded-video', (req, res) => {
  const { folder, video } = req.body;
  if (!folder || !video) return res.status(400).json({ error: 'Missing params' });
  const filepath = path.join(folder, video);
  if (fs.existsSync(filepath)) {
    try { fs.unlinkSync(filepath); } catch {}
  }
  // Also remove from uploaded marks
  const marksFile = path.join(folder, '.uploaded.json');
  try {
    const marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8'));
    delete marks[video];
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
  } catch {}
  res.json({ success: true });
});

// Start upload (multi-video sequential)
app.post('/api/tiktok/start', async (req, res) => {
  if (getIsRunning()) {
    return res.status(400).json({ success: false, error: 'Upload sedang berjalan!' });
  }
  const config = {
    ...req.body,
    statesDir: STATES_DIR,
  };

  // Callback: mark video as uploaded + broadcast event
  const onVideoUploaded = (videoFilename: string) => {
    const marksFile = path.join(config.videoFolder, '.uploaded.json');
    let marks: Record<string, boolean> = {};
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
    marks[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
    broadcastLog(`[VIDEO_UPLOADED]:${videoFilename}`);
  };

  res.json({ success: true, message: 'Upload dimulai' });
  // Run in background with onVideoUploaded callback
  runUpload(config, broadcastLog, onVideoUploaded).then(() => {
    broadcastLog('===== UPLOAD PROCESS FINISHED =====');
  }).catch(e => {
    broadcastLog('âŒ Fatal: ' + e.message);
  });
});

// Stop upload
app.post('/api/tiktok/stop', async (req, res) => {
  await stopUploader();
  res.json({ success: true, message: 'Upload dihentikan' });
});

async function extractTokopediaProductName(url: string): Promise<string> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for redirect to happen (if we are on vt.tokopedia.com)
    try {
      await page.waitForURL(u => !u.toString().includes('vt.tokopedia.com'), { timeout: 10000 });
    } catch (err) {}

    // Wait 2 seconds for hydration
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    let productName = '';

    // 1. Try extracting from URL og_info parameter
    try {
      const urlObj = new URL(currentUrl);
      const ogInfoParam = urlObj.searchParams.get('og_info');
      if (ogInfoParam) {
        const ogInfo = JSON.parse(decodeURIComponent(ogInfoParam));
        if (ogInfo && ogInfo.title) {
          productName = ogInfo.title;
        }
      }
    } catch (err) {
      console.error('[NAMAPRODUK] Gagal parse og_info dari URL:', err);
    }

    // 2. Try DOM selectors if not found in URL (e.g. if it redirected to a standard desktop page)
    if (!productName) {
      try {
        await page.waitForSelector('[data-fmp="true"]', { timeout: 5000 });
        productName = await page.locator('[data-fmp="true"]').first().innerText();
      } catch (e) {
        const fallbacks = [
          'h1[data-testid="lblPDPProductName"]',
          '[data-testid="pdpProductName"]',
          'h1'
        ];
        for (const selector of fallbacks) {
          try {
            const loc = page.locator(selector).first();
            if (await loc.isVisible()) {
              productName = await loc.innerText();
              if (productName.trim()) break;
          }
          } catch {}
        }
      }
    }

    return productName.trim();
  } finally {
    await browser.close();
  }
}

app.post('/api/namaproduk', async (req: Request, res: Response) => {
  const url = req.body?.url || req.query?.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'url wajib diisi.' });
  }

  try {
    const name = await extractTokopediaProductName(url);
    if (name) {
      res.json({ success: true, name });
    } else {
      res.status(404).json({ success: false, error: 'Gagal mengambil nama produk. Elemen tidak ditemukan.' });
    }
  } catch (error: any) {
    console.error('[NAMAPRODUK] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Terjadi kesalahan saat memproses link.' });
  }
});

app.get('/api/namaproduk', async (req: Request, res: Response) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'url wajib diisi.' });
  }

  try {
    const name = await extractTokopediaProductName(url);
    if (name) {
      res.json({ success: true, name });
    } else {
      res.status(404).json({ success: false, error: 'Gagal mengambil nama produk. Elemen tidak ditemukan.' });
    }
  } catch (error: any) {
    console.error('[NAMAPRODUK] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Terjadi kesalahan saat memproses link.' });
  }
});

app.get('/tiktok', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tiktok.html'));
});
app.get('/grok', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grok.html'));
});

app.get('/merge', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'merge.html'));
});

app.get('/namaproduk', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'namaproduk.html'));
});

app.get('/splitter', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YouTube Splitter</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      color: #101828;
      background: #f5f7fb;
    }
    main {
      width: min(920px, calc(100% - 32px));
      margin: 32px auto;
    }
    h1 {
      margin: 0 0 18px;
      font-size: 28px;
      font-weight: 700;
    }
    form {
      display: grid;
      grid-template-columns: 1fr 180px;
      gap: 12px;
      margin-bottom: 16px;
    }
    input, button {
      min-height: 44px;
      border-radius: 6px;
      font-size: 15px;
    }
    input {
      border: 1px solid #cfd6e4;
      padding: 0 12px;
      background: white;
    }
    button {
      border: 0;
      color: white;
      background: #1677ff;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.65;
    }
    progress {
      width: 100%;
      height: 18px;
      margin: 8px 0 14px;
    }
    pre {
      min-height: 360px;
      margin: 0;
      padding: 16px;
      overflow: auto;
      border: 1px solid #d9e1ef;
      border-radius: 8px;
      background: #0b1220;
      color: #d8e2f2;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    a { color: #9bd2ff; }
    @media (max-width: 680px) {
      main { width: min(100% - 24px, 920px); margin: 20px auto; }
      form { grid-template-columns: 1fr; }
      h1 { font-size: 23px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>YouTube Splitter</h1>
    <form id="splitter-form">
      <input id="youtube-url" name="url" type="url" placeholder="https://www.youtube.com/watch?v=..." required>
      <button id="submit-button" type="submit">Split Video</button>
    </form>
    <progress id="progress" value="0" max="100"></progress>
    <pre id="log"></pre>
  </main>
  <script>
    const form = document.getElementById('splitter-form');
    const input = document.getElementById('youtube-url');
    const button = document.getElementById('submit-button');
    const progress = document.getElementById('progress');
    const log = document.getElementById('log');

    function appendLog(message) {
      log.textContent += message + '\\n';
      log.scrollTop = log.scrollHeight;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      progress.value = 0;
      log.textContent = '';
      appendLog('Mulai proses...');

      try {
        const response = await fetch('/splitter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: input.value }),
        });

        if (!response.ok || !response.body) {
          appendLog('Gagal memulai proses: HTTP ' + response.status);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\\n\\n');
          buffer = chunks.pop() || '';

          for (const chunk of chunks) {
            const eventLine = chunk.split('\\n').find(line => line.startsWith('event: '));
            const dataLine = chunk.split('\\n').find(line => line.startsWith('data: '));
            if (!dataLine) continue;

            const eventName = eventLine ? eventLine.slice(7) : 'message';
            const data = JSON.parse(dataLine.slice(6));

            if (eventName === 'progress') {
              if (typeof data.percent === 'number') progress.value = data.percent;
              appendLog(data.message + (typeof data.percent === 'number' ? ' - ' + data.percent.toFixed(1) + '%' : ''));
            }

            if (eventName === 'done') {
              progress.value = 100;
              appendLog('Selesai.');
              for (const file of data.outputFiles || []) {
                appendLog(file.filename + ' -> ' + file.downloadUrl);
              }
            }

            if (eventName === 'error') {
              appendLog('Error: ' + data.error);
            }
          }
        }
      } catch (error) {
        appendLog('Error: ' + error.message);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`);
});

app.post('/splitter', async (req, res) => {
  const youtubeUrl = req.body?.url || req.body?.youtubeUrl;
  if (!youtubeUrl || typeof youtubeUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'url atau youtubeUrl wajib diisi.' });
  }

  const jobId = `split-${Date.now()}`;
  const jobOutputDir = path.join(SPLIT_VIDEO_DIR, jobId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sendProgress = (event: SplitProgressEvent) => {
    sendEvent('progress', event);
  };

  try {
    const result = await splitAndProcessVideo({
      youtubeUrl,
      outputDir: jobOutputDir,
      tempDir: path.join(__dirname, '_tmp_uploads', 'splitter'),
      segmentDuration: 180,
      watermarkText: req.body?.watermarkText || 'TikTok Automation',
      onProgress: sendProgress,
    });

    sendEvent('done', {
      success: true,
      ...result,
      outputFiles: result.outputFiles.map(filePath => ({
        path: filePath,
        filename: path.basename(filePath),
        downloadUrl: `/api/splitter/download/${jobId}/${encodeURIComponent(path.basename(filePath))}`,
      })),
    });
  } catch (err: any) {
    console.error('[SPLITTER] Fatal:', err);
    sendEvent('error', {
      success: false,
      error: err.message || 'Gagal split video YouTube.',
    });
  } finally {
    res.end();
  }
});

app.get('/api/splitter/download/:jobId/:filename', (req, res) => {
  const jobId = path.basename(req.params.jobId);
  const filename = path.basename(req.params.filename);
  const filepath = path.join(SPLIT_VIDEO_DIR, jobId, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File tidak ditemukan');
  res.download(filepath, filename);
});


app.post('/api/merge', mergeUpload.fields([
  { name: 'videos', maxCount: 2 },
  { name: 'sound', maxCount: 1 },
]), async (req: any, res) => {
  const videoFiles = ((req.files?.videos || []) as Express.Multer.File[]);
  const soundFile = ((req.files?.sound || []) as Express.Multer.File[])[0];
  const uploadedFiles = [...videoFiles, ...(soundFile ? [soundFile] : [])];

  if (videoFiles.length !== 2) {
    for (const file of uploadedFiles) {
      try { fs.unlinkSync(file.path); } catch { }
    }
    return res.status(400).json({ success: false, error: 'Pilih tepat 2 video untuk digabung.' });
  }

  if (soundFile && !['.mp3', '.wav'].includes(path.extname(soundFile.originalname).toLowerCase())) {
    for (const file of uploadedFiles) {
      try { fs.unlinkSync(file.path); } catch { }
    }
    return res.status(400).json({ success: false, error: 'Sound harus berupa file .mp3 atau .wav.' });
  }

  const saveFolder = req.body?.saveFolder as string | undefined;
  const outputDir = (saveFolder && saveFolder.trim()) ? saveFolder.trim() : MERGED_VIDEO_DIR;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputFilename = `merged-${Date.now()}.mp4`;
  const outputPath = path.join(outputDir, outputFilename);

  try {
    const result = await mergeVideosCopyWithOptionalAudio(
      videoFiles.map(file => file.path),
      outputPath,
      soundFile?.path,
      { tempDir: path.join(__dirname, '_tmp_uploads') }
    );

    res.json({
      success: true,
      filename: outputFilename,
      savedTo: outputPath,
      downloadUrl: `/api/merge/download?path=${encodeURIComponent(outputPath)}`,
      inputCount: result.inputCount,
      audioReplaced: result.audioReplaced,
    });
  } catch (err: any) {
    try { fs.unlinkSync(outputPath); } catch { }
    res.status(500).json({ success: false, error: err.message || 'Gagal merge video.' });
  } finally {
    for (const file of uploadedFiles) {
      try { fs.unlinkSync(file.path); } catch { }
    }
  }
});

app.get('/api/merge/download', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).send('Path diperlukan');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return res.status(404).send('File tidak ditemukan');
  res.download(resolved, path.basename(resolved));
});

// ─── Permutation Merge APIs ──────────────────────────────
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

app.get('/api/merge/scan-folder', (req, res) => {
  const folder = req.query.folder as string;
  if (!folder || typeof folder !== 'string') {
    return res.status(400).json({ success: false, error: 'Parameter folder wajib diisi.' });
  }
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return res.status(400).json({ success: false, error: 'Folder tidak ditemukan atau bukan directory.' });
  }

  const videos = fs.readdirSync(folder)
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      if (!VIDEO_EXTS.includes(ext)) return false;
      // Exclude previously merged permutation outputs
      if (f.startsWith('perm_')) return false;
      return fs.statSync(path.join(folder, f)).isFile();
    })
    .sort();

  if (videos.length < 1) {
    return res.json({ success: false, error: 'Tidak ada file video di folder ini.' });
  }

  // Generate P(n,2) + n combinations = n²
  const combinations: { video1: string; video2: string }[] = [];
  // Permutations (ordered pairs where video1 ≠ video2)
  for (let i = 0; i < videos.length; i++) {
    for (let j = 0; j < videos.length; j++) {
      if (i !== j) {
        combinations.push({ video1: videos[i], video2: videos[j] });
      }
    }
  }
  // Self-merges (video + itself)
  for (const v of videos) {
    combinations.push({ video1: v, video2: v });
  }

  res.json({
    success: true,
    folder,
    videos,
    videoCount: videos.length,
    totalCombinations: combinations.length,
    combinations,
  });
});

app.post('/api/merge/permutation', mergeUpload.fields([
  { name: 'sound', maxCount: 1 },
]), async (req: any, res) => {
  const folder = req.body?.folder as string;
  const soundFile = ((req.files?.sound || []) as Express.Multer.File[])[0];

  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    if (soundFile) try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Folder tidak valid.' });
  }

  if (soundFile && !['.mp3', '.wav'].includes(path.extname(soundFile.originalname).toLowerCase())) {
    try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Sound harus berupa file .mp3 atau .wav.' });
  }

  const videos = fs.readdirSync(folder)
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      if (!VIDEO_EXTS.includes(ext)) return false;
      if (f.startsWith('perm_')) return false;
      return fs.statSync(path.join(folder, f)).isFile();
    })
    .sort();

  if (videos.length < 1) {
    if (soundFile) try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Tidak ada video di folder.' });
  }

  // Build combinations: P(n,2) + n = n²
  const combinations: { video1: string; video2: string }[] = [];
  for (let i = 0; i < videos.length; i++) {
    for (let j = 0; j < videos.length; j++) {
      if (i !== j) combinations.push({ video1: videos[i], video2: videos[j] });
    }
  }
  for (const v of videos) {
    combinations.push({ video1: v, video2: v });
  }

  // SSE response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  for (let idx = 0; idx < combinations.length; idx++) {
    const combo = combinations[idx];
    const v1Path = path.join(folder, combo.video1);
    const v2Path = path.join(folder, combo.video2);
    const baseName1 = path.basename(combo.video1, path.extname(combo.video1));
    const baseName2 = path.basename(combo.video2, path.extname(combo.video2));
    const outputFilename = `perm_${baseName1}_x_${baseName2}_${Date.now()}.mp4`;
    const outputPath = path.join(folder, outputFilename);

    sendEvent('progress', {
      current: idx + 1,
      total: combinations.length,
      message: `Merge: ${combo.video1} + ${combo.video2} → ${outputFilename}`,
      video1: combo.video1,
      video2: combo.video2,
    });

    try {
      await mergeVideosCopyWithOptionalAudio(
        [v1Path, v2Path],
        outputPath,
        soundFile?.path,
        { tempDir: path.join(__dirname, '_tmp_uploads') }
      );
      successCount++;
    } catch (err: any) {
      failCount++;
      const errMsg = `Gagal merge ${combo.video1} + ${combo.video2}: ${err.message}`;
      errors.push(errMsg);
      console.error('[MERGE-PERM]', errMsg);
    }
  }

  sendEvent('done', {
    success: true,
    successCount,
    failCount,
    totalCombinations: combinations.length,
    errors,
  });

  // Cleanup sound file
  if (soundFile) {
    try { fs.unlinkSync(soundFile.path); } catch { }
  }

  res.end();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ═══════════════════════════════════════════════════════════
//  GROK IMAGINE GENERATOR APIs
// ═══════════════════════════════════════════════════════════
const BAHAN_DIR = path.join(__dirname, 'bahan');
const PROMPT_DIR = path.join(__dirname, 'prompt');
const GROK_DOWNLOAD_DIR = path.join(__dirname, 'grok-downloads');
const AUDIO_DIR = path.join(__dirname, 'audio');
if (!fs.existsSync(BAHAN_DIR)) fs.mkdirSync(BAHAN_DIR, { recursive: true });
if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
if (!fs.existsSync(GROK_DOWNLOAD_DIR)) fs.mkdirSync(GROK_DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// List bahan folders
app.get('/api/grok/bahan', (req, res) => {
  const folders = fs.readdirSync(BAHAN_DIR)
    .filter(f => fs.statSync(path.join(BAHAN_DIR, f)).isDirectory());
  res.json({ folders });
});

// List audio category subfolders
app.get('/api/grok/audio-folders', (req, res) => {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const folders = fs.readdirSync(AUDIO_DIR)
    .filter(f => fs.statSync(path.join(AUDIO_DIR, f)).isDirectory());
  res.json({ folders });
});

// Upload bahan images
app.post('/api/grok/bahan/upload', bahanUpload.array('images', 100), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) return res.status(400).json({ error: 'folderName diperlukan' });
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });
  for (const f of files) {
    const dest = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dest);
  }
  res.json({ success: true, count: files.length });
});

// List prompt files
app.get('/api/grok/prompts', (req: Request, res: Response) => {
  const files = fs.readdirSync(PROMPT_DIR)
    .filter(f => f.endsWith('.json'));
  res.json({ files });
});

// Save prompt
app.post('/api/grok/prompts/save', (req: Request, res: Response) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name dan prompt diperlukan' });
  const filename = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  fs.writeFileSync(path.join(PROMPT_DIR, filename), JSON.stringify({ prompt }, null, 2));
  res.json({ success: true, filename });
});

// Grok SSE logs
const grokSseClients: Response[] = [];
function grokBroadcastLog(msg: string) {
  console.log(`[GROK] ${msg}`);
  grokSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

app.get('/api/grok/logs', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  grokSseClients.push(res);
  req.on('close', () => {
    const idx = grokSseClients.indexOf(res);
    if (idx >= 0) grokSseClients.splice(idx, 1);
  });
});

// Stats
app.get('/api/grok/stats', (req: Request, res: Response) => {
  res.json({ ...getGrokStats(), running: getGrokIsRunning(), browsers: getBrowserProgress(), rateLimits: getGrokRateLimits() });
});

app.get('/api/grok/rate-limits', (req: Request, res: Response) => {
  res.json(getGrokRateLimits());
});

app.post('/api/grok/clear-rate-limit', (req: Request, res: Response) => {
  const { stateFile } = req.body;
  if (stateFile) {
    clearGrokRateLimit(stateFile);
  }
  res.json({ success: true });
});

// Start generate
app.post('/api/grok/start', async (req: Request, res: Response) => {
  if (getGrokIsRunning()) {
    return res.status(400).json({ success: false, error: 'Generate sedang berjalan!' });
  }

  const merge = req.body.merge === 'ya' || req.body.merge === true;
  const totalVideos = Math.max(1, parseInt(req.body.totalVideos) || 1);
  if (merge && totalVideos % 2 !== 0) {
    return res.status(400).json({ success: false, error: 'Jumlah video harus genap jika memilih merge ya!' });
  }

  const config = {
    stateFile: req.body.stateFile,
    statesDir: GROK_STATES_DIR,
    bahanFolder: req.body.bahanFolder || '',
    bahanDir: BAHAN_DIR,
    promptFile: req.body.promptFile,
    promptDir: PROMPT_DIR,
    mode: req.body.mode || 'Video',
    resolution: req.body.resolution || '720p',
    duration: req.body.duration || '10s',
    aspectRatio: req.body.aspectRatio || '9:16',
    headless: req.body.headless !== undefined ? !!req.body.headless : true,
    downloadDir: GROK_DOWNLOAD_DIR,
    totalVideos: totalVideos,
    merge: merge,
    audioFolder: req.body.audioFolder || '',
  };

  res.json({ success: true, message: 'Generate dimulai' });
  runGrokGenerator(config, grokBroadcastLog, __dirname).then(() => {
    grokBroadcastLog('===== GENERATE PROCESS FINISHED =====');
  }).catch(e => {
    grokBroadcastLog('❌ Fatal: ' + e.message);
  });
});

// Stop generate
app.post('/api/grok/stop', async (req: Request, res: Response) => {
  await stopGrokGenerator();
  res.json({ success: true, message: 'Generate dihentikan' });
});

app.get('/api/grok/videos', (req: Request, res: Response) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ videos: [] });
  const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
  if (!fs.existsSync(stateDir)) return res.json({ videos: [] });

  // Load downloaded marks
  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { }

  const exts = ['.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.webp'];
  
  // List top-level files
  let files: any[] = [];
  try {
    files = fs.readdirSync(stateDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stat = fs.statSync(path.join(stateDir, f));
        return {
          filename: f,
          size: stat.size,
          created: stat.birthtime.toISOString(),
          downloaded: !!marks[f],
          isRaw: !f.startsWith('grok_merged_'),
          isMerged: f.startsWith('grok_merged_')
        };
      });
  } catch (e) { }

  // Check if raw folder exists
  const rawDir = path.join(stateDir, 'raw');
  if (fs.existsSync(rawDir)) {
    try {
      const rawFiles = fs.readdirSync(rawDir)
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .map(f => {
          const stat = fs.statSync(path.join(rawDir, f));
          const relativeFilename = `raw/${f}`;
          return {
            filename: relativeFilename,
            size: stat.size,
            created: stat.birthtime.toISOString(),
            downloaded: !!marks[relativeFilename],
            isRaw: true,
            isMerged: false
          };
        });
      files = files.concat(rawFiles);
    } catch (e) { }
  }

  // Sort newest first
  files.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

  res.json({ videos: files, stateName });
});

// Serve video file
app.get('/api/grok/video-file/:state/:filename', (req, res) => {
  const { state, filename } = req.params;
  if (filename.includes('..') || state.includes('..')) {
    return res.status(400).send('Invalid path');
  }
  const filepath = path.join(GROK_DOWNLOAD_DIR, state, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// Serve raw video file
app.get('/api/grok/video-file/:state/raw/:filename', (req, res) => {
  const { state, filename } = req.params;
  if (filename.includes('..') || state.includes('..')) {
    return res.status(400).send('Invalid path');
  }
  const filepath = path.join(GROK_DOWNLOAD_DIR, state, 'raw', filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// Mark video as downloaded by user
app.post('/api/grok/mark-downloaded', (req, res) => {
  const { stateFile, filename, filenames } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'Missing stateFile' });

  const list = Array.isArray(filenames) ? filenames : (filename ? [filename] : []);
  if (list.length === 0) return res.status(400).json({ error: 'Missing filename or filenames' });

  for (const f of list) {
    if (typeof f !== 'string' || f.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
  }

  const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { }
  
  list.forEach((f) => {
    marks[f] = true;
  });
  
  fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
  res.json({ success: true });
});

// Delete a video file
app.post('/api/grok/delete-video', (req, res) => {
  const { stateFile, filename, filenames } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'Missing stateFile' });

  const list = Array.isArray(filenames) ? filenames : (filename ? [filename] : []);
  if (list.length === 0) return res.status(400).json({ error: 'Missing filename or filenames' });

  for (const f of list) {
    if (typeof f !== 'string' || f.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
  }

  const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
  const marksFile = path.join(GROK_DOWNLOAD_DIR, stateName, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { }

  let deletedCount = 0;
  let errors: string[] = [];

  list.forEach((f) => {
    const filepath = path.join(GROK_DOWNLOAD_DIR, stateName, f);
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
        delete marks[f];
        deletedCount++;
      } catch (err: any) {
        errors.push(`Gagal menghapus ${f}: ${err.message}`);
      }
    } else {
      errors.push(`File tidak ditemukan: ${f}`);
    }
  });

  try {
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
  } catch { }

  if (errors.length > 0 && deletedCount === 0) {
    return res.status(500).json({ success: false, error: errors.join(', ') });
  }

  res.json({ success: true, deletedCount, errors: errors.length > 0 ? errors : undefined });
});

// ═══════════════════════════════════════════════════════════
//  YTBOT API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/ytbot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ytbot.html'));
});

// Load all configs
app.get('/api/ytbot/config', (req, res) => {
  res.json(loadYtbotData());
});

// Save config for one state
app.post('/api/ytbot/config/save', (req, res) => {
  const { stateFile, description, hashtags, scheduleDate, scheduleTime, intervalMinutes } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadYtbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', hashtags: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60 };
  }
  if (description !== undefined) data.states[stateFile].description = description;
  if (hashtags !== undefined) data.states[stateFile].hashtags = hashtags;
  if (scheduleDate !== undefined) data.states[stateFile].scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) data.states[stateFile].scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) data.states[stateFile].intervalMinutes = intervalMinutes;
  saveYtbotData(data);
  res.json({ success: true });
});

// Add YT link
app.post('/api/ytbot/links/add', (req, res) => {
  const { stateFile, link } = req.body;
  if (!stateFile || !link) return res.status(400).json({ error: 'stateFile dan link diperlukan' });
  const data = loadYtbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', hashtags: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60 };
  }
  data.states[stateFile].ytLinks.push(link);
  saveYtbotData(data);
  res.json({ success: true });
});

// Remove YT link
app.post('/api/ytbot/links/remove', (req, res) => {
  const { stateFile, link } = req.body;
  if (!stateFile || !link) return res.status(400).json({ error: 'stateFile dan link diperlukan' });
  const data = loadYtbotData();
  const cfg = data.states[stateFile];
  if (cfg) {
    const idx = cfg.ytLinks.indexOf(link);
    if (idx >= 0) cfg.ytLinks.splice(idx, 1);
    saveYtbotData(data);
  }
  res.json({ success: true });
});

// List videos for a state
app.get('/api/ytbot/videos', (req, res) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ videos: [] });
  const videoDir = getYtbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  const videos = fs.readdirSync(videoDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort()
    .map(f => ({ name: f, uploaded: !!marks[f] }));
  res.json({ videos });
});

// SSE logs
app.get('/api/ytbot/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  ytbotSseClients.push(res);
  req.on('close', () => {
    const idx = ytbotSseClients.indexOf(res);
    if (idx >= 0) ytbotSseClients.splice(idx, 1);
  });
});

// Status
app.get('/api/ytbot/status', (req, res) => {
  res.json({ running: ytbotRunning, queue: ytbotQueue, progress: ytbotProgress });
});

// Stop
app.post('/api/ytbot/stop', async (req, res) => {
  ytbotRunning = false;
  ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
  ytbotBroadcastProgress();
  await stopUploader();
  ytbotLog('⛔ ===== YTBOT STOPPED =====');
  res.json({ success: true });
});

// ── YTBOT ORCHESTRATION ──
async function ytbotRunState(stateFile: string): Promise<void> {
  if (!ytbotRunning) return;
  const data = loadYtbotData();
  const cfg = data.states[stateFile];
  if (!cfg) {
    ytbotLog(`❌ Config tidak ditemukan untuk ${stateFile}`);
    return;
  }

  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const videoDir = getYtbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');

  ytbotProgress = { download: 0, split: 0, upload: 0, currentState: stateName };
  ytbotBroadcastProgress();

  ytbotLog(`═══════════════════════════════════════`);
  ytbotLog(`🔑 Memproses state: ${stateName}`);
  ytbotLog(`═══════════════════════════════════════`);

  // Current schedule tracking
  let schedDate = cfg.scheduleDate;
  let schedTime = cfg.scheduleTime;
  const intervalMin = cfg.intervalMinutes || 60;

  // Loop while there's work to do
  while (ytbotRunning) {
    // 1. Check existing unuploaded videos
    let marks: Record<string, boolean> = {};
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

    let allVideos = fs.readdirSync(videoDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    let pendingVideos = allVideos.filter(v => !marks[v]);

    // 2. If no pending videos, download & split from YT stock
    if (pendingVideos.length === 0) {
      // Reload data to get fresh links
      const freshData = loadYtbotData();
      const freshCfg = freshData.states[stateFile];
      if (!freshCfg || freshCfg.ytLinks.length === 0) {
        ytbotLog(`ℹ Tidak ada video pending dan tidak ada link YT tersisa untuk ${stateName}`);
        break;
      }

      // Take first link from stock
      const ytLink = freshCfg.ytLinks[0];
      ytbotLog(`📥 Download & split: ${ytLink}`);

      // Reset progress bars for new link download
      ytbotProgress.download = 0;
      ytbotProgress.split = 0;
      ytbotProgress.upload = 0;
      ytbotBroadcastProgress();

      try {
        const result = await splitAndProcessVideo({
          youtubeUrl: ytLink,
          outputDir: videoDir,
          tempDir: path.join(__dirname, '_tmp_uploads', 'ytbot'),
          segmentDuration: 180,
          watermarkText: 'TikTok Automation',
          onProgress: (evt) => {
            if (evt.stage === 'download' && typeof evt.percent === 'number') {
              ytbotProgress.download = Math.round(evt.percent);
              ytbotBroadcastProgress();
            } else if (evt.stage === 'split' && typeof evt.percent === 'number') {
              const part = evt.part || 1;
              const total = evt.totalParts || 1;
              const base = ((part - 1) / total) * 100;
              const overallSplit = base + (evt.percent / total);
              ytbotProgress.split = Math.round(overallSplit);
              ytbotBroadcastProgress();
            }
            ytbotLog(evt.message);
          },
        });

        ytbotLog(`✓ Split selesai: ${result.totalParts} file dari "${result.title}"`);

        // Remove used link from stock
        freshCfg.ytLinks.splice(0, 1);
        saveYtbotData(freshData);

        // Refresh video list
        allVideos = fs.readdirSync(videoDir)
          .filter(f => exts.includes(path.extname(f).toLowerCase()))
          .sort();
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
        pendingVideos = allVideos.filter(v => !marks[v]);
      } catch (err: any) {
        ytbotLog(`❌ Gagal download/split: ${err.message}`);
        // Remove failed link so we don't retry forever
        freshCfg.ytLinks.splice(0, 1);
        saveYtbotData(freshData);
        continue;
      }
    }

    if (!ytbotRunning) break;
    if (pendingVideos.length === 0) {
      ytbotLog(`ℹ Tidak ada video untuk diupload di ${stateName}`);
      break;
    }

    // 3. Take max 30 videos for this batch
    const batch = pendingVideos.slice(0, 30);
    const startFrom = batch[0];

    // Calculate schedule end for queue display
    const batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
    const batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
    const endDate = new Date(batchEndMs);
    const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

    // Update queue
    const qIdx = ytbotQueue.findIndex(q => q.stateFile === stateFile);
    const qEntry = { stateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true };
    if (qIdx >= 0) ytbotQueue[qIdx] = qEntry; else ytbotQueue.push(qEntry);
    ytbotBroadcastQueue();

    ytbotProgress.download = 100;
    ytbotProgress.split = 100;
    ytbotProgress.upload = 0;
    ytbotBroadcastProgress();

    ytbotLog(`📤 Upload batch: ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);

    // 4. Run upload using existing tiktok-uploader
    const uploadConfig = {
      videoFolder: videoDir,
      startFromVideo: startFrom,
      description: cfg.description || '',
      hashtags: cfg.hashtags || '',
      addProduct: false,
      productNameRadio: '',
      productTitle: '',
      productDescription: '',
      skipSwitches: true,
      headless: true,
      scheduleDate: schedDate,
      scheduleTime: schedTime,
      intervalMinutes: intervalMin,
      stateFile: stateFile,
      statesDir: STATES_DIR,
    };

    let uploadedCount = 0;
    const onVideoUploaded = (videoFilename: string) => {
      let m: Record<string, boolean> = {};
      try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      m[videoFilename] = true;
      fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
      ytbotLog(`✅ [${stateName}] ${videoFilename} terupload`);

      // Hapus video setelah sukses terupload
      const videoPath = path.join(videoDir, videoFilename);
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          ytbotLog(`🗑️ [${stateName}] Berhasil menghapus file yang selesai diupload: ${videoFilename}`);
        } catch (e: any) {
          ytbotLog(`⚠ Gagal menghapus file ${videoFilename}: ${e.message}`);
        }
      }

      uploadedCount++;
      ytbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
      ytbotBroadcastProgress();
    };

    try {
      await runUpload(uploadConfig, ytbotLog, onVideoUploaded);
    } catch (err: any) {
      ytbotLog(`❌ Upload error: ${err.message}`);
    }

    if (!ytbotRunning) break;

    // 5. Calculate next batch schedule start = last video schedule + interval
    const nextStartMs = batchEndMs + intervalMin * 60000;
    const nextStart = new Date(nextStartMs);
    schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
    schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;

    // Update config with new schedule for next loop
    const updData = loadYtbotData();
    if (updData.states[stateFile]) {
      updData.states[stateFile].scheduleDate = schedDate;
      updData.states[stateFile].scheduleTime = schedTime;
      saveYtbotData(updData);
    }

    ytbotLog(`⏭ Batch selanjutnya mulai: ${schedDate} ${schedTime}`);

    // Check if there are more pending videos or links
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
    allVideos = fs.readdirSync(videoDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    pendingVideos = allVideos.filter(v => !marks[v]);
    const freshData2 = loadYtbotData();
    const hasMoreLinks = (freshData2.states[stateFile]?.ytLinks?.length || 0) > 0;

    if (pendingVideos.length === 0 && !hasMoreLinks) {
      ytbotLog(`✅ Semua video dan link untuk ${stateName} sudah diproses`);
      break;
    }
  }

  // Mark state as done in queue
  const qIdx2 = ytbotQueue.findIndex(q => q.stateFile === stateFile);
  if (qIdx2 >= 0) { ytbotQueue[qIdx2].active = false; ytbotBroadcastQueue(); }
}

// Schedule one state
app.post('/api/ytbot/schedule', async (req, res) => {
  if (ytbotRunning) {
    return res.status(400).json({ success: false, error: 'YTBot sedang berjalan!' });
  }
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  ytbotRunning = true;
  ytbotQueue = [];
  res.json({ success: true, message: 'Jadwal dimulai' });

  try {
    await ytbotRunState(stateFile);
  } catch (e: any) {
    ytbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    ytbotRunning = false;
    ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
    ytbotBroadcastProgress();
    ytbotLog('===== YTBOT FINISHED =====');
  }
});

// Full auto all states
app.post('/api/ytbot/full-auto', async (req, res) => {
  if (ytbotRunning) {
    return res.status(400).json({ success: false, error: 'YTBot sedang berjalan!' });
  }
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  ytbotRunning = true;
  ytbotQueue = [];
  res.json({ success: true, message: 'Full Auto dimulai' });

  try {
    for (const sf of stateFiles) {
      if (!ytbotRunning) break;
      await ytbotRunState(sf);
    }
  } catch (e: any) {
    ytbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    ytbotRunning = false;
    ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
    ytbotBroadcastProgress();
    ytbotLog('===== YTBOT FINISHED =====');
  }
});

// ═══════════════════════════════════════════════════════════
//  GROKBOT CONSTANTS & PERSISTENCE
// ═══════════════════════════════════════════════════════════
const GROKBOT_DATA_FILE = path.join(__dirname, 'grokbot-data.json');

interface GrokbotStateConfig {
  grokState: string;
  promptFile: string;
  bahanFolder: string;
  mode: string;
  resolution: string;
  duration: string;
  aspectRatio: string;
  merge: boolean;
  audioFolder: string;
  description: string;
  hashtags: string;
  scheduleDate: string;
  scheduleTime: string;
  intervalMinutes: number;
  addProduct?: boolean;
  productNameRadio?: string;
  productTitle?: string;
  productDescription?: string;
  headless?: boolean;
}

interface GrokbotData {
  states: Record<string, GrokbotStateConfig>;
}

function loadGrokbotData(): GrokbotData {
  try {
    return JSON.parse(fs.readFileSync(GROKBOT_DATA_FILE, 'utf-8'));
  } catch {
    return { states: {} };
  }
}

function saveGrokbotData(data: GrokbotData) {
  fs.writeFileSync(GROKBOT_DATA_FILE, JSON.stringify(data, null, 2));
}

// Global state for Grokbot SSE & Orchestration
const grokbotSseClients: Response[] = [];
let grokbotRunning = false;
let grokbotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let grokbotProgress: {
  generate: number;
  merge: number;
  upload: number;
  currentState: string;
  browsers: BrowserProgress[];
  uploadedCount: number;
  uploadTotal: number;
  mergedCount: number;
  mergeTotal: number;
} = {
  generate: 0,
  merge: 0,
  upload: 0,
  currentState: '',
  browsers: [],
  uploadedCount: 0,
  uploadTotal: 0,
  mergedCount: 0,
  mergeTotal: 0,
};

function grokbotLog(msg: string) {
  console.log(`[GROKBOT] ${msg}`);
  grokbotSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

function grokbotBroadcastQueue() {
  grokbotSseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(grokbotQueue)}\n\n`));
}

function grokbotBroadcastProgress() {
  // Always attach fresh browser progress from grok-uploader
  grokbotProgress.browsers = getBrowserProgress();
  const progressWithRateLimits = {
    ...grokbotProgress,
    rateLimits: getGrokRateLimits()
  };
  grokbotSseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(progressWithRateLimits)}\n\n`));
}

function resetGrokbotProgress(overrides: Partial<typeof grokbotProgress> = {}) {
  grokbotProgress = {
    generate: 0, merge: 0, upload: 0, currentState: '',
    browsers: [], uploadedCount: 0, uploadTotal: 0,
    mergedCount: 0, mergeTotal: 0,
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════
//  GROKBOT API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/grokbot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grokbot.html'));
});

app.get('/api/grokbot/config', (req, res) => {
  res.json(loadGrokbotData());
});

app.post('/api/grokbot/config/save', (req, res) => {
  const { stateFile, grokState, promptFile, bahanFolder, mode, resolution, duration, aspectRatio, merge, audioFolder, description, hashtags, scheduleDate, scheduleTime, intervalMinutes, addProduct, productNameRadio, productTitle, productDescription, headless } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadGrokbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = {
      grokState: '', promptFile: '', bahanFolder: '', mode: 'Video',
      resolution: '720p', duration: '10s', aspectRatio: '9:16', merge: true,
      audioFolder: '', description: '', hashtags: '', scheduleDate: '',
      scheduleTime: '', intervalMinutes: 60,
      addProduct: false, productNameRadio: '', productTitle: '', productDescription: '',
      headless: true
    };
  }
  const s = data.states[stateFile];
  if (grokState !== undefined) s.grokState = grokState;
  if (promptFile !== undefined) s.promptFile = promptFile;
  if (bahanFolder !== undefined) s.bahanFolder = bahanFolder;
  if (mode !== undefined) s.mode = mode;
  if (resolution !== undefined) s.resolution = resolution;
  if (duration !== undefined) s.duration = duration;
  if (aspectRatio !== undefined) s.aspectRatio = aspectRatio;
  if (merge !== undefined) s.merge = !!merge;
  if (audioFolder !== undefined) s.audioFolder = audioFolder;
  if (description !== undefined) s.description = description;
  if (hashtags !== undefined) s.hashtags = hashtags;
  if (scheduleDate !== undefined) s.scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) s.scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) s.intervalMinutes = intervalMinutes;
  if (addProduct !== undefined) s.addProduct = !!addProduct;
  if (productNameRadio !== undefined) s.productNameRadio = productNameRadio;
  if (productTitle !== undefined) s.productTitle = productTitle;
  if (productDescription !== undefined) s.productDescription = productDescription;
  if (headless !== undefined) s.headless = !!headless;
  saveGrokbotData(data);
  res.json({ success: true });
});

app.get('/api/grokbot/stock', (req, res) => {
  const stateFile = req.query.stateFile || req.query.state;
  if (!stateFile || typeof stateFile !== 'string') return res.status(400).json({ error: 'stateFile atau state diperlukan' });
  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  
  const rawDir = path.join(stateDownloadDir, 'raw');
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');
  
  const countFiles = (dir: string) => {
    if (!fs.existsSync(dir)) return 0;
    const exts = ['.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.webp'];
    try {
      return fs.readdirSync(dir).filter(f => {
        const p = path.join(dir, f);
        return fs.statSync(p).isFile() && exts.includes(path.extname(f).toLowerCase());
      }).length;
    } catch { return 0; }
  };
  
  let utamaCount = 0;
  if (fs.existsSync(stateDownloadDir)) {
    const exts = ['.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.webp'];
    try {
      utamaCount = fs.readdirSync(stateDownloadDir).filter(f => {
        const p = path.join(stateDownloadDir, f);
        return fs.statSync(p).isFile() && exts.includes(path.extname(f).toLowerCase());
      }).length;
    } catch {}
  }
  
  res.json({
    raw: countFiles(rawDir),
    utama: utamaCount,
    cadangan: countFiles(cadanganDir)
  });
});

app.post('/api/grokbot/generate-utama', async (req, res) => {
  if (grokbotRunning) return res.status(400).json({ error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  
  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config state belum disimpan!' });
  if (!cfg.grokState) return res.status(400).json({ error: 'Grok state belum dipilih!' });
  
  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });
  
  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let allUtamaVideos = fs.existsSync(stateDownloadDir) ? fs.readdirSync(stateDownloadDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort() : [];
  let pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);
  
  const currentCount = pendingUtamaVideos.length;
  if (currentCount >= 30) {
    return res.status(400).json({ error: 'Stok Utama sudah penuh (ada 30 atau lebih video pending)!' });
  }
  
  const needed = 30 - currentCount;
  const mergeEnabled = cfg.merge !== false;
  const totalRawToGenerate = mergeEnabled ? (2 * needed) : needed;
  
  grokbotRunning = true;
  grokbotQueue = [{ stateName: tiktokStateName, stateFile, videoCount: needed, scheduleStart: 'Utama Gen', scheduleEnd: 'Utama Gen', active: true }];
  grokbotBroadcastQueue();
  
  resetGrokbotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? needed : 0 });
  grokbotBroadcastProgress();
  
  res.json({ success: true, message: `Mulai generate ${needed} video utama` });
  
  grokbotLog(`🚀 Memulai Generate Stok Utama untuk ${tiktokStateName}. Dibutuhkan: ${needed} video (raw: ${totalRawToGenerate})`);
  
  const grokConfig = {
    stateFile: cfg.grokState,
    statesDir: GROK_STATES_DIR,
    bahanFolder: cfg.bahanFolder || '',
    bahanDir: BAHAN_DIR,
    promptFile: cfg.promptFile,
    promptDir: PROMPT_DIR,
    mode: cfg.mode || 'Video',
    resolution: cfg.resolution || '720p',
    duration: cfg.duration || '10s',
    aspectRatio: cfg.aspectRatio || '9:16',
    headless: cfg.headless !== false,
    downloadDir: GROK_DOWNLOAD_DIR,
    customDownloadDir: stateDownloadDir,
    totalVideos: totalRawToGenerate,
    merge: mergeEnabled,
    audioFolder: cfg.audioFolder || '',
  };
  
  const poll = setInterval(() => {
    if (!grokbotRunning) { clearInterval(poll); return; }
    const stats = getGrokStats();
    const progressList = getBrowserProgress();
    const doneCount = stats.success + stats.failed;
    let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
    let activeCount = 0;
    let activeProgSum = 0;
    progressList.forEach(bp => {
      if (bp.status === 'running') {
        activeCount++;
        activeProgSum += bp.progress;
      }
    });
    if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
    grokbotProgress.generate = Math.min(99, overallGen);
    if (mergeEnabled) {
      grokbotProgress.mergedCount = stats.saved;
      grokbotProgress.mergeTotal = needed;
      grokbotProgress.merge = Math.min(99, Math.round((stats.saved / needed) * 100));
    } else {
      grokbotProgress.merge = 100;
    }
    grokbotBroadcastProgress();
  }, 2000);
  
  runGrokGenerator(grokConfig as any, grokbotLog, __dirname).then(() => {
    clearInterval(poll);
    grokbotProgress.generate = 100;
    grokbotProgress.merge = 100;
    grokbotBroadcastProgress();
    grokbotLog('===== GENERATE UTAMA FINISHED =====');
  }).catch(e => {
    clearInterval(poll);
    grokbotLog('❌ Fatal Utama Gen: ' + e.message);
  }).finally(() => {
    grokbotRunning = false;
    grokbotQueue = [];
    grokbotBroadcastQueue();
  });
});

app.post('/api/grokbot/generate-cadangan', async (req, res) => {
  if (grokbotRunning) return res.status(400).json({ error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  
  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config state belum disimpan!' });
  if (!cfg.grokState) return res.status(400).json({ error: 'Grok state belum dipilih!' });
  
  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');
  if (!fs.existsSync(cadanganDir)) fs.mkdirSync(cadanganDir, { recursive: true });
  
  grokbotRunning = true;
  grokbotQueue = [{ stateName: tiktokStateName, stateFile, videoCount: 30, scheduleStart: 'Cadangan Gen', scheduleEnd: 'Cadangan Gen', active: true }];
  grokbotBroadcastQueue();
  
  resetGrokbotProgress({ currentState: tiktokStateName, mergeTotal: 30 });
  grokbotBroadcastProgress();
  
  res.json({ success: true, message: `Mulai generate 30 video cadangan (merged)` });
  
  grokbotLog(`🚀 Memulai Generate Stok Cadangan (30 video merged, 60 raw) untuk ${tiktokStateName}`);
  
  const grokConfig = {
    stateFile: cfg.grokState,
    statesDir: GROK_STATES_DIR,
    bahanFolder: cfg.bahanFolder || '',
    bahanDir: BAHAN_DIR,
    promptFile: cfg.promptFile,
    promptDir: PROMPT_DIR,
    mode: cfg.mode || 'Video',
    resolution: cfg.resolution || '720p',
    duration: cfg.duration || '10s',
    aspectRatio: cfg.aspectRatio || '9:16',
    headless: cfg.headless !== false,
    downloadDir: GROK_DOWNLOAD_DIR,
    customDownloadDir: cadanganDir,
    totalVideos: 60, // 30 merged videos require 60 raw
    merge: true,
    audioFolder: cfg.audioFolder || '',
  };
  
  const poll = setInterval(() => {
    if (!grokbotRunning) { clearInterval(poll); return; }
    const stats = getGrokStats();
    const progressList = getBrowserProgress();
    const doneCount = stats.success + stats.failed;
    let overallGen = Math.round((doneCount / 60) * 100);
    let activeCount = 0;
    let activeProgSum = 0;
    progressList.forEach(bp => {
      if (bp.status === 'running') {
        activeCount++;
        activeProgSum += bp.progress;
      }
    });
    if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / 60);
    grokbotProgress.generate = Math.min(99, overallGen);
    grokbotProgress.mergedCount = stats.saved;
    grokbotProgress.mergeTotal = 30;
    grokbotProgress.merge = Math.min(99, Math.round((stats.saved / 30) * 100));
    grokbotBroadcastProgress();
  }, 2000);
  
  runGrokGenerator(grokConfig as any, grokbotLog, __dirname).then(() => {
    clearInterval(poll);
    grokbotProgress.generate = 100;
    grokbotProgress.merge = 100;
    grokbotBroadcastProgress();
    grokbotLog('===== GENERATE CADANGAN FINISHED =====');
  }).catch(e => {
    clearInterval(poll);
    grokbotLog('❌ Fatal Cadangan Gen: ' + e.message);
  }).finally(() => {
    grokbotRunning = false;
    grokbotQueue = [];
    grokbotBroadcastQueue();
  });
});

// ── JADWALKAN SAJA: Skip generation, use existing utama stock ──
app.post('/api/grokbot/schedule-only', async (req, res) => {
  if (grokbotRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config state belum disimpan!' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  if (!fs.existsSync(stateDownloadDir)) return res.status(400).json({ error: 'Folder download belum ada untuk state ini.' });

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const allUtamaVideos = fs.readdirSync(stateDownloadDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort();
  const pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);

  if (pendingUtamaVideos.length === 0) {
    return res.status(400).json({ error: 'Tidak ada video utama yang bisa dijadwalkan. Stok utama kosong.' });
  }

  grokbotRunning = true;
  grokbotQueue = [];

  const schedDate = cfg.scheduleDate || new Date().toISOString().split('T')[0];
  const schedTime = cfg.scheduleTime || new Date().toTimeString().slice(0, 5);
  const intervalMin = cfg.intervalMinutes || 60;
  const batch = pendingUtamaVideos.slice(0, 30);
  const startFrom = batch[0];

  const batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
  const batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
  const endDate = new Date(batchEndMs);
  const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

  grokbotQueue.push({ stateName: tiktokStateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true });
  grokbotBroadcastQueue();

  resetGrokbotProgress({ generate: 100, merge: 100, currentState: tiktokStateName, uploadTotal: batch.length });
  grokbotBroadcastProgress();

  res.json({ success: true, message: `Jadwalkan ${batch.length} video utama tanpa generate` });

  grokbotLog(`📤 [Jadwalkan Saja] Mulai Upload ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);

    const uploadConfig = {
      videoFolder: stateDownloadDir,
      startFromVideo: startFrom,
      description: cfg.description || '',
      hashtags: cfg.hashtags || '',
      addProduct: !!cfg.addProduct,
      productNameRadio: cfg.productNameRadio || '',
      productTitle: cfg.productTitle || '',
      productDescription: cfg.productDescription || '',
      skipSwitches: false,
      headless: cfg.headless !== false,
      scheduleDate: schedDate,
      scheduleTime: schedTime,
      intervalMinutes: intervalMin,
      stateFile: stateFile,
      statesDir: STATES_DIR,
    };

  let uploadedCount = 0;
  const onVideoUploaded = (videoFilename: string) => {
    let m: Record<string, boolean> = {};
    try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
    m[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
    grokbotLog(`✅ [${tiktokStateName}] ${videoFilename} terupload`);

    // Hapus video setelah sukses terupload
    const videoPath = path.join(stateDownloadDir, videoFilename);
    if (fs.existsSync(videoPath)) {
      try {
        fs.unlinkSync(videoPath);
        grokbotLog(`🗑️ [${tiktokStateName}] Berhasil menghapus file yang selesai diupload: ${videoFilename}`);
      } catch (e: any) {
        grokbotLog(`⚠ Gagal menghapus file ${videoFilename}: ${e.message}`);
      }
    }

    uploadedCount++;
    grokbotProgress.uploadedCount = uploadedCount;
    grokbotProgress.uploadTotal = batch.length;
    grokbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
    grokbotBroadcastProgress();
  };

  try {
    await runUpload(uploadConfig, grokbotLog, onVideoUploaded);
  } catch (err: any) {
    grokbotLog(`❌ Upload error: ${err.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotQueue = [];
    grokbotBroadcastQueue();
    grokbotLog('===== JADWALKAN SAJA FINISHED =====');
  }
});

// ── MERGE SAJA: Merge raw videos without generating new ones ──
app.post('/api/grokbot/merge-only', async (req, res) => {
  if (grokbotRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config state belum disimpan!' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(stateDownloadDir, 'raw');

  if (!fs.existsSync(rawDir)) {
    return res.status(400).json({ error: `Folder raw tidak ada: grok-downloads/${tiktokStateName}/raw/` });
  }

  const rawFiles = fs.readdirSync(rawDir)
    .filter(f => f.endsWith('.mp4'))
    .sort();

  if (rawFiles.length < 2) {
    return res.status(400).json({ error: `Minimal 2 raw video dibutuhkan untuk merge. Saat ini: ${rawFiles.length}` });
  }

  const pairsCount = Math.floor(rawFiles.length / 2);

  grokbotRunning = true;
  grokbotQueue = [{ stateName: tiktokStateName, stateFile, videoCount: pairsCount, scheduleStart: 'Merge Only', scheduleEnd: 'Merge Only', active: true }];
  grokbotBroadcastQueue();
  resetGrokbotProgress({ generate: 100, currentState: tiktokStateName, mergeTotal: pairsCount });
  grokbotBroadcastProgress();

  res.json({ success: true, message: `Memulai merge ${pairsCount} pasang raw video dari grok-downloads/${tiktokStateName}/raw/` });

  grokbotLog(`✂ [Merge Saja] Memulai merge ${pairsCount} pasang raw video untuk ${tiktokStateName}`);
  grokbotLog(`📂 Raw dir: grok-downloads/${tiktokStateName}/raw/ (${rawFiles.length} file)`);

  try {
    if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });

    // Read and sort raw files by modification time
    let files = fs.readdirSync(rawDir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const p = path.join(rawDir, f);
        return { name: f, path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);

    let mergedCount = 0;
    while (files.length >= 2 && grokbotRunning) {
      const pair = files.splice(0, 2);
      const [v1, v2] = pair;

      grokbotLog(`[MERGER] Menggabungkan: ${v1.name} + ${v2.name}`);

      // Pick random audio
      let pickedAudioPath: string | undefined = undefined;
      const audioFolder = cfg.audioFolder || '';
      if (audioFolder) {
        const audioDir = path.join(__dirname, 'audio', audioFolder);
        if (fs.existsSync(audioDir)) {
          const audioExts = ['.mp3', '.wav'];
          const audioFiles = fs.readdirSync(audioDir)
            .filter(f => audioExts.includes(path.extname(f).toLowerCase()));
          if (audioFiles.length > 0) {
            const pick = audioFiles[Math.floor(Math.random() * audioFiles.length)];
            pickedAudioPath = path.join(audioDir, pick);
            grokbotLog(`[MERGER] Audio terpilih: ${pick}`);
          }
        }
      }

      const mergedFname = `grok_merged_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
      const finalOutputPath = path.join(stateDownloadDir, mergedFname);

      try {
        await mergeVideosCopyWithOptionalAudio(
          [v1.path, v2.path],
          finalOutputPath,
          pickedAudioPath,
          { tempDir: path.join(__dirname, '_tmp_uploads') }
        );
        mergedCount++;
        grokbotLog(`[MERGER] ✅ Berhasil: ${mergedFname}`);

        // Delete raw source files
        try { fs.unlinkSync(v1.path); } catch {}
        try { fs.unlinkSync(v2.path); } catch {}

        grokbotProgress.mergedCount = mergedCount;
        grokbotProgress.mergeTotal = pairsCount;
        grokbotProgress.merge = Math.round((mergedCount / pairsCount) * 100);
        grokbotBroadcastProgress();
      } catch (err: any) {
        grokbotLog(`[MERGER] ❌ Gagal merge: ${err.message}`);
      }
    }

    grokbotLog(`✅ [Merge Saja] Selesai. ${mergedCount} video merged ke grok-downloads/${tiktokStateName}/`);
  } catch (e: any) {
    grokbotLog(`❌ Fatal Merge Only: ${e.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotQueue = [];
    grokbotBroadcastQueue();
    grokbotLog('===== MERGE SAJA FINISHED =====');
  }
});

// ── GROKBOT ORCHESTRATION LOOP ──
async function grokbotRunState(stateFile: string): Promise<void> {
  if (!grokbotRunning) return;
  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) {
    grokbotLog(`❌ Config tidak ditemukan untuk ${stateFile}`);
    return;
  }

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(stateDownloadDir, 'raw');
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');

  if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });
  if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
  if (!fs.existsSync(cadanganDir)) fs.mkdirSync(cadanganDir, { recursive: true });

  resetGrokbotProgress({ currentState: tiktokStateName });
  grokbotBroadcastProgress();

  grokbotLog(`═══════════════════════════════════════`);
  grokbotLog(`🔑 Memproses state TikTok: ${tiktokStateName}`);
  grokbotLog(`═══════════════════════════════════════`);

  let schedDate = cfg.scheduleDate;
  let schedTime = cfg.scheduleTime;
  const intervalMin = cfg.intervalMinutes || 60;
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  while (grokbotRunning) {
    // 1. Check existing unuploaded videos in Utama
    const marksFile = path.join(stateDownloadDir, '.uploaded.json');
    let marks: Record<string, boolean> = {};
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

    let allUtamaVideos = fs.readdirSync(stateDownloadDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    let pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);

    let needed = 30 - pendingUtamaVideos.length;

    // 2. Replenish from backup (cadangan) if needed
    if (needed > 0) {
      grokbotLog(`ℹ Stok utama memiliki ${pendingUtamaVideos.length} video pending. Mencari stok cadangan untuk memenuhi target 30 video...`);
      const cadanganMarksFile = path.join(cadanganDir, '.uploaded.json');
      let cadanganMarks: Record<string, boolean> = {};
      try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

      let allCadanganVideos = fs.existsSync(cadanganDir) ? fs.readdirSync(cadanganDir)
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .sort() : [];
      let pendingCadanganVideos = allCadanganVideos.filter(v => !cadanganMarks[v]);

      if (pendingCadanganVideos.length > 0) {
        const toMove = pendingCadanganVideos.slice(0, needed);
        grokbotLog(`🚚 Memindahkan ${toMove.length} video dari stok cadangan ke stok utama...`);
        for (const file of toMove) {
          const src = path.join(cadanganDir, file);
          const dest = path.join(stateDownloadDir, file);
          try {
            fs.renameSync(src, dest);
            // Mark as uploaded in cadangan
            cadanganMarks[file] = true;
          } catch (e: any) {
            grokbotLog(`⚠ Gagal memindahkan ${file}: ${e.message}`);
          }
        }
        fs.writeFileSync(cadanganMarksFile, JSON.stringify(cadanganMarks, null, 2));

        // Refresh utama
        allUtamaVideos = fs.readdirSync(stateDownloadDir)
          .filter(f => exts.includes(path.extname(f).toLowerCase()))
          .sort();
        pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);
        needed = 30 - pendingUtamaVideos.length;
      }
    }

    // 3. If still under 30 videos, generate via Grok
    if (needed > 0) {
      grokbotLog(`ℹ Stok utama kurang ${needed} video. Memulai auto-generate via Grok...`);
      if (!cfg.grokState) {
        grokbotLog(`❌ Gagal: Grok State belum diatur untuk TikTok state ${tiktokStateName}`);
        break;
      }

      const mergeEnabled = cfg.merge !== false;
      const totalRawToGenerate = mergeEnabled ? (2 * needed) : needed;

      grokbotProgress.generate = 0;
      grokbotProgress.merge = 0;
      grokbotProgress.upload = 0;
      grokbotProgress.mergeTotal = mergeEnabled ? needed : 0;
      grokbotProgress.mergedCount = 0;
      grokbotProgress.uploadedCount = 0;
      grokbotProgress.uploadTotal = 0;
      grokbotBroadcastProgress();

      const grokConfig = {
        stateFile: cfg.grokState,
        statesDir: GROK_STATES_DIR,
        bahanFolder: cfg.bahanFolder || '',
        bahanDir: BAHAN_DIR,
        promptFile: cfg.promptFile,
        promptDir: PROMPT_DIR,
        mode: cfg.mode || 'Video',
        resolution: cfg.resolution || '720p',
        duration: cfg.duration || '10s',
        aspectRatio: cfg.aspectRatio || '9:16',
        headless: cfg.headless !== false, // Headless mode sesuai config
        downloadDir: GROK_DOWNLOAD_DIR,
        customDownloadDir: stateDownloadDir,
        totalVideos: totalRawToGenerate,
        merge: mergeEnabled,
        audioFolder: cfg.audioFolder || '',
      };

      const poll = setInterval(() => {
        if (!grokbotRunning) { clearInterval(poll); return; }
        const stats = getGrokStats();
        const progressList = getBrowserProgress();
        const doneCount = stats.success + stats.failed;
        let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
        let activeCount = 0;
        let activeProgSum = 0;
        progressList.forEach(bp => {
          if (bp.status === 'running') {
            activeCount++;
            activeProgSum += bp.progress;
          }
        });
        if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
        grokbotProgress.generate = Math.min(99, overallGen);
        if (mergeEnabled) {
          grokbotProgress.mergedCount = stats.saved;
          grokbotProgress.mergeTotal = needed;
          grokbotProgress.merge = Math.min(99, Math.round((stats.saved / needed) * 100));
        } else {
          grokbotProgress.merge = 100;
        }
        grokbotBroadcastProgress();
      }, 2000);

      try {
        await runGrokGenerator(grokConfig as any, grokbotLog, __dirname);
        clearInterval(poll);
        grokbotLog(`✓ Auto-generate selesai!`);
        
        grokbotProgress.generate = 100;
        grokbotProgress.merge = 100;
        grokbotBroadcastProgress();

        // Refresh utama
        allUtamaVideos = fs.readdirSync(stateDownloadDir)
          .filter(f => exts.includes(path.extname(f).toLowerCase()))
          .sort();
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
        pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);
      } catch (err: any) {
        clearInterval(poll);
        grokbotLog(`❌ Gagal auto-generate via Grok: ${err.message}`);
        break;
      }
    }

    if (!grokbotRunning) break;
    if (pendingUtamaVideos.length === 0) {
      grokbotLog(`ℹ Tidak ada video untuk diupload di ${tiktokStateName}`);
      break;
    }

    // 4. Batch 30 videos
    const batch = pendingUtamaVideos.slice(0, 30);
    const startFrom = batch[0];

    const batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
    const batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
    const endDate = new Date(batchEndMs);
    const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

    // Update Queue
    const qIdx = grokbotQueue.findIndex(q => q.stateFile === stateFile);
    const qEntry = { stateName: tiktokStateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true };
    if (qIdx >= 0) grokbotQueue[qIdx] = qEntry; else grokbotQueue.push(qEntry);
    grokbotBroadcastQueue();

    grokbotProgress.generate = 100;
    grokbotProgress.merge = 100;
    grokbotProgress.upload = 0;
    grokbotProgress.uploadedCount = 0;
    grokbotProgress.uploadTotal = batch.length;
    grokbotBroadcastProgress();

    grokbotLog(`📤 Mulai Upload batch: ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);

    const uploadConfig = {
      videoFolder: stateDownloadDir,
      startFromVideo: startFrom,
      description: cfg.description || '',
      hashtags: cfg.hashtags || '',
      addProduct: !!cfg.addProduct,
      productNameRadio: cfg.productNameRadio || '',
      productTitle: cfg.productTitle || '',
      productDescription: cfg.productDescription || '',
      skipSwitches: false, // jangan centang skip switches
      headless: cfg.headless !== false, // headless mode sesuai config
      scheduleDate: schedDate,
      scheduleTime: schedTime,
      intervalMinutes: intervalMin,
      stateFile: stateFile,
      statesDir: STATES_DIR,
    };

    let uploadedCount = 0;
    const onVideoUploaded = (videoFilename: string) => {
      let m: Record<string, boolean> = {};
      try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      m[videoFilename] = true;
      fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
      grokbotLog(`✅ [${tiktokStateName}] ${videoFilename} terupload`);

      // Hapus video setelah sukses terupload
      const videoPath = path.join(stateDownloadDir, videoFilename);
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          grokbotLog(`🗑️ [${tiktokStateName}] Berhasil menghapus file yang selesai diupload: ${videoFilename}`);
        } catch (e: any) {
          grokbotLog(`⚠ Gagal menghapus file ${videoFilename}: ${e.message}`);
        }
      }

      uploadedCount++;
      grokbotProgress.uploadedCount = uploadedCount;
      grokbotProgress.uploadTotal = batch.length;
      grokbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
      grokbotBroadcastProgress();
    };

    try {
      await runUpload(uploadConfig, grokbotLog, onVideoUploaded);
    } catch (err: any) {
      grokbotLog(`❌ Upload error: ${err.message}`);
    }

    if (!grokbotRunning) break;

    // 5. Calculate rolling schedule for subsequent loops
    const nextStartMs = batchEndMs + intervalMin * 60000;
    const nextStart = new Date(nextStartMs);
    schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
    schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;

    const updData = loadGrokbotData();
    if (updData.states[stateFile]) {
      updData.states[stateFile].scheduleDate = schedDate;
      updData.states[stateFile].scheduleTime = schedTime;
      saveGrokbotData(updData);
    }

    grokbotLog(`⏭ Batch selanjutnya akan dijadwalkan mulai: ${schedDate} ${schedTime}`);

    // Refresh utama
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
    allUtamaVideos = fs.readdirSync(stateDownloadDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);

    if (pendingUtamaVideos.length === 0) {
      grokbotLog(`✅ Semua video dan link untuk ${tiktokStateName} sudah diproses`);
      break;
    }
  }

  // Mark done
  const qIdx2 = grokbotQueue.findIndex(q => q.stateFile === stateFile);
  if (qIdx2 >= 0) { grokbotQueue[qIdx2].active = false; grokbotBroadcastQueue(); }
}

app.post('/api/grokbot/schedule', async (req, res) => {
  if (grokbotRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  grokbotRunning = true;
  grokbotQueue = [];
  res.json({ success: true, message: 'Jadwal dimulai' });

  try {
    await grokbotRunState(stateFile);
  } catch (e: any) {
    grokbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotLog('===== GROKBOT FINISHED =====');
  }
});

app.post('/api/grokbot/full-auto', async (req, res) => {
  if (grokbotRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  grokbotRunning = true;
  grokbotQueue = [];
  res.json({ success: true, message: 'Full Auto dimulai' });

  try {
    for (const sf of stateFiles) {
      if (!grokbotRunning) break;
      await grokbotRunState(sf);
    }
  } catch (e: any) {
    grokbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotLog('===== GROKBOT FINISHED =====');
  }
});

app.get('/api/grokbot/status', (req, res) => {
  res.json({ running: grokbotRunning, queue: grokbotQueue, progress: grokbotProgress, rateLimits: getGrokRateLimits() });
});

app.post('/api/grokbot/stop', async (req, res) => {
  grokbotRunning = false;
  resetGrokbotProgress();
  grokbotBroadcastProgress();
  await stopGrokGenerator();
  await stopUploader();
  grokbotLog('⛔ ===== GROKBOT STOPPED =====');
  res.json({ success: true });
});

app.get('/api/grokbot/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  grokbotSseClients.push(res);
  req.on('close', () => {
    const idx = grokbotSseClients.indexOf(res);
    if (idx >= 0) grokbotSseClients.splice(idx, 1);
  });
});

// Jalankan server
app.listen(PORT, () => {
  console.log(`🚀 State Manager berjalan di http://localhost:${PORT}`);
  console.log(`🎬 TikTok Auto Uploader: http://localhost:${PORT}/tiktok`);
  console.log(`🧠 Grok Imagine Generator: http://localhost:${PORT}/grok`);
  console.log(`🤖 YT to TikTok Bot: http://localhost:${PORT}/ytbot`);
  console.log(`🤖 Grok to TikTok Bot: http://localhost:${PORT}/grokbot`);
  console.log(`📁 Folder state: ${STATES_DIR} & ${GROK_STATES_DIR}`);
});

