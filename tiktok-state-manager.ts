// tiktok-state-manager.ts
// Jalankan dengan: npx ts-node tiktok-state-manager.ts
// Atau compile dulu: npx tsc && node dist/tiktok-state-manager.js

import express, { Request, Response } from 'express';
import { chromium, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { execa } from 'execa';
import { runUpload, stopUploader, getIsRunning, type SchedulePlanItem } from './tiktok-uploader.js';
import { runFacebookUpload, stopFacebookUploader, getFacebookIsRunning } from './facebook-uploader.js';
import { runGrokGenerator, stopGrokGenerator, getGrokIsRunning, getGrokStats, getBrowserProgress, BrowserProgress, getGrokRateLimits, clearGrokRateLimit, setGrokRateLimit } from './grok-uploader.js';
import { generateGrokVideoV2, RateLimitError } from './grok_api_client.js';
import { generateVidabotVideo } from './vidabot_api_client.js';
import {
  runVidabotGenerator,
  stopVidabotGenerator,
  getVidabotGenIsRunning,
  getVidabotStats,
  getVidabotBrowserProgress,
  getVidabotRateLimits,
  clearVidabotRateLimit,
  VidabotWorkerProgress
} from './vidabot_generator.js';
import { postTikTokAffiliateVideoApi } from './tiktok_api_post.js';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import { mergeVideosCopyWithOptionalAudio } from './video-merger.js';
import { splitAndProcessVideo, SplitProgressEvent } from './video-splitter.js';
import {
  startWAPolling,
  notifyScheduleStarted as originalNotifyScheduleStarted,
  sendWAMessage as originalSendWAMessage,
  notifyScheduleFinished as originalNotifyScheduleFinished
} from './whatsapp-service.js';

function buildScheduleListMessage(stateName: string, items: SchedulePlanItem[]): string {
  const lines = [`[Schedule ${stateName}]`];
  items.forEach(item => {
    const offset = item.offsetMinutes !== undefined
      ? ` (${item.offsetMinutes >= 0 ? '+' : ''}${item.offsetMinutes} menit)`
      : '';
    lines.push(`${item.index}. ${item.scheduleDate} ${item.scheduleTime}${offset}`);
  });
  return lines.join('\n');
}
import {
  loadLeonardoData,
  saveLeonardoData,
  getFreshJWT,
  fetchCreditBalance,
  uploadInitImage,
  triggerKlingGenerate,
  checkGenerationStatus,
  fetchGenerationVideoUrl,
  downloadVideoToLocal,
  LeonardoAccount,
  LeonardoPrompt
} from './leonardo-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/bahan', express.static(path.join(__dirname, 'bahan')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));


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

const FB_STATES_DIR = path.join(__dirname, 'facebook-states');
if (!fs.existsSync(FB_STATES_DIR)) {
  fs.mkdirSync(FB_STATES_DIR, { recursive: true });
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
  lastUploadDate?: string;
  lastUploadTime?: string;
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
let ytbotFullAutoRunning = false;
let ytbotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let ytbotProgress = {
  download: 0,
  split: 0,
  upload: 0,
  currentState: '',
  uploadedCount: 0,
  uploadTotal: 0
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
let currentPlatform: 'tiktok' | 'grok' | 'facebook' = 'tiktok';
let currentContext: BrowserContext | null = null;
let currentStateName: string = '';
let currentEditingFilename: string | null = null;
// Ganti fungsi getSavedStates() yang lama dengan ini
function getSavedStates(platform: 'tiktok' | 'grok' | 'facebook' = 'tiktok') {
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');

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

      // Cari cookie penting TikTok/Facebook
      const importantCookies = ['sessionid', 'sessionid_ss', 'sid_tt', 'ttwid', 'c_user', 'xs', 'datr'];
      let earliestExpiry = Infinity;

      cookies.forEach((cookie: any) => {
        if (importantCookies.includes(cookie.name) && cookie.expires && cookie.expires > 0) {
          if (cookie.expires < earliestExpiry) {
            earliestExpiry = cookie.expires;
          }
        }
      });

      if (earliestExpiry !== Infinity) {
        const expiryDate = new Date(earliestExpiry * 1000); // expires dalam detik -> ms
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

// ═══════════════════════════════════════════════════════════
//  FBBOT CONSTANTS & PERSISTENCE
// ═══════════════════════════════════════════════════════════
const FBBOT_DATA_FILE = path.join(__dirname, 'fbbot-data.json');
const FBBOT_VIDEO_DIR = path.join(__dirname, 'fbbot-videos');
if (!fs.existsSync(FBBOT_VIDEO_DIR)) {
  fs.mkdirSync(FBBOT_VIDEO_DIR, { recursive: true });
}

interface FbbotStateConfig {
  ytLinks: string[];
  description: string;
  scheduleDate: string;
  scheduleTime: string;
  intervalMinutes: number;
  headless?: boolean;
}

interface FbbotData {
  states: Record<string, FbbotStateConfig>;
}

function loadFbbotData(): FbbotData {
  try {
    return JSON.parse(fs.readFileSync(FBBOT_DATA_FILE, 'utf-8'));
  } catch {
    return { states: {} };
  }
}

function saveFbbotData(data: FbbotData) {
  fs.writeFileSync(FBBOT_DATA_FILE, JSON.stringify(data, null, 2));
}

// FBBOT SSE + running state
const fbbotSseClients: Response[] = [];
let fbbotRunning = false;
let fbbotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let fbbotProgress = {
  download: 0,
  split: 0,
  upload: 0,
  currentState: ''
};

function fbbotLog(msg: string) {
  console.log(`[FBBOT] ${msg}`);
  fbbotSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

function fbbotBroadcastQueue() {
  fbbotSseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(fbbotQueue)}\n\n`));
}

function fbbotBroadcastProgress() {
  fbbotSseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(fbbotProgress)}\n\n`));
}

function getFbbotStateVideoDir(stateFile: string): string {
  const stateName = stateFile.replace('facebook-state-', '').replace('.json', '');
  const dir = path.join(FBBOT_VIDEO_DIR, stateName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// === API ROUTES ===
app.get('/api/states', (req, res) => {
  const platform = req.query.platform === 'grok' ? 'grok' : (req.query.platform === 'facebook' ? 'facebook' : 'tiktok');
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
  currentPlatform = platform as 'tiktok' | 'grok' | 'facebook';

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
      (window as any).chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
    });

    const url = currentPlatform === 'grok' ? 'https://accounts.x.ai/sign-in?redirect=grok-com' : (currentPlatform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log(`âœ… Browser stealth dibuka untuk state: ${currentStateName}`);
    res.json({
      success: true,
      message: 'Browser stealth sudah terbuka!\nSilakan login manual.\nSetelah login selesai, klik tombol "Sudah Login" di web.'
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

  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File state tidak ditemukan' });
  }

  if (currentContext) await currentContext.close();

  currentEditingFilename = filename;
  currentStateName = ''; // tidak pakai nama baru
  currentPlatform = platform as 'tiktok' | 'grok' | 'facebook';

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
    const url = currentPlatform === 'grok' ? 'https://grok.com' : (currentPlatform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');
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

  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
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

    const url = platform === 'grok' ? 'https://grok.com' : (platform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log(`✅ Browser dibuka dengan state: ${name}`);
    res.json({ success: true, message: 'Browser berhasil dibuka' });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Gagal membuka browser: ' + err.message });
  }
});

// Launch Google Chrome directly via CMD (without Playwright) + inject cookies from state JSON
app.post('/api/start-native-chrome', async (req, res) => {
  const { name, filename, platform = 'tiktok' } = req.body;
  let stateName = name ? name.trim() : '';
  if (!stateName && filename) {
    stateName = filename.replace(/^(tiktok|grok|facebook)-state-/, '').replace(/\.json$/i, '');
  }

  if (!stateName) {
    return res.status(400).json({ error: 'Nama state/session harus diisi!' });
  }

  const cleanStateName = stateName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const profileDir = path.join(__dirname, 'chrome-profiles', `${platform}_${cleanStateName}`);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  // Find state file to inject cookies into Chrome profile if exists
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  let stateFilePath = '';
  if (filename) {
    stateFilePath = path.join(dir, filename);
  } else if (stateName) {
    const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
    stateFilePath = path.join(dir, `${prefix}${stateName}.json`);
  }

  if (stateFilePath && fs.existsSync(stateFilePath)) {
    try {
      console.log(`[NATIVE CHROME CMD] Menginjeksi cookie dari ${path.basename(stateFilePath)} ke profil Chrome...`);
      const stateContent = fs.readFileSync(stateFilePath, 'utf-8');
      const stateData = JSON.parse(stateContent);

      if (stateData.cookies && Array.isArray(stateData.cookies) && stateData.cookies.length > 0) {
        const pContext = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          channel: 'chrome',
          args: ['--no-sandbox']
        });
        await pContext.addCookies(stateData.cookies);
        await pContext.close();
        console.log(`✓ Cookie (${stateData.cookies.length} item) berhasil diinjeksi ke profil Chrome CMD!`);
      }
    } catch (e: any) {
      console.error(`⚠ Gagal menginjeksi cookie dari file JSON: ${e.message}`);
    }
  }

  const targetUrl = platform === 'grok' 
    ? 'https://grok.com' 
    : (platform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com/tiktokstudio/upload');

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  let chromeExe = chromePaths.find(p => fs.existsSync(p));

  try {
    let command = '';
    if (chromeExe) {
      command = `"${chromeExe}" --user-data-dir="${profileDir}" "${targetUrl}"`;
    } else {
      command = `start chrome --user-data-dir="${profileDir}" "${targetUrl}"`;
    }

    console.log(`[NATIVE CHROME CMD] Running: ${command}`);
    exec(command, { shell: 'cmd.exe' }, (err) => {
      if (err) console.error('[NATIVE CHROME CMD ERROR]', err);
    });

    res.json({
      success: true,
      message: `✅ Chrome Native (CMD tanpa Playwright) terbuka!\nProfile: chrome-profiles/${platform}_${cleanStateName}\n\nSession/Cookies telah dimuat dari file state! Silakan gunakan dengan normal.`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal menjalankan Chrome via CMD: ' + err.message });
  }
});

// Sync/Export Chrome CMD profile session back to state JSON file
app.post('/api/sync-native-chrome', async (req, res) => {
  const { filename, name, platform = 'tiktok' } = req.body;
  let stateName = name ? name.trim() : '';
  if (!stateName && filename) {
    stateName = filename.replace(/^(tiktok|grok|facebook)-state-/, '').replace(/\.json$/i, '');
  }

  if (!stateName) return res.status(400).json({ error: 'Nama state/session harus diisi!' });

  const cleanStateName = stateName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const profileDir = path.join(__dirname, 'chrome-profiles', `${platform}_${cleanStateName}`);
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
  const targetFilename = filename || `${prefix}${stateName}.json`;
  const targetFilepath = path.join(dir, targetFilename);

  try {
    const pContext = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      channel: 'chrome',
      args: ['--no-sandbox']
    });
    await pContext.storageState({ path: targetFilepath });
    await pContext.close();

    res.json({
      success: true,
      message: `✅ Sesi dari Chrome CMD berhasil disinkronkan & disimpan ke ${targetFilename}!`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal mengekspor sesi dari Chrome CMD: ' + err.message });
  }
});

app.post('/api/save-login', async (req, res) => {
  if (!currentContext) {
    return res.status(400).json({ error: 'Tidak ada session yang sedang dibuat!' });
  }

  const prefix = currentPlatform === 'grok' ? 'grok-state-' : (currentPlatform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
  const dir = currentPlatform === 'grok' ? GROK_STATES_DIR : (currentPlatform === 'facebook' ? FB_STATES_DIR : STATES_DIR);

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

  const dir = platform === 'grok' ? 'grok-states' : (platform === 'facebook' ? 'facebook-states' : 'tiktok-states');
  const url = platform === 'grok' ? 'https://grok.com' : (platform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');

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

function sanitizeFilename(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function progressBar(percent: number, width = 20): string {
  const safePercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((safePercent / 100) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${safePercent.toFixed(1)}%`;
}

function ensureFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static tidak menemukan binary ffmpeg.');
  }
  return ffmpegPath;
}

app.get('/bahan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bahan.html'));
});

app.post('/api/bahan/download', async (req, res) => {
  const { pairs, outputDir: clientOutputDir } = req.body;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ success: false, error: 'Pairs harus diisi dan berupa array.' });
  }

  const outputDir = clientOutputDir ? path.resolve(clientOutputDir) : 'C:/tiktok-ts-automation/bahan-campaign';
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let activeProcess: any = null;
  let isAborted = false;
  let isCleanFinished = false;

  res.on('close', () => {
    if (isCleanFinished) return;
    isAborted = true;
    console.log('[BAHAN-DOWNLOAD] Client disconnected. Aborting process.');
    if (activeProcess) {
      try {
        activeProcess.kill();
      } catch (err) {}
    }
  });

  const ffmpegDir = path.dirname(ensureFfmpegPath());
  const env = {
    ...process.env,
    PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`
  };

  const runTempDir = path.join(__dirname, '_tmp_uploads', `bahan-${Date.now()}`);
  fs.mkdirSync(runTempDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const total = pairs.length;
    let completed = 0;

    for (let i = 0; i < total; i++) {
      if (isAborted) break;

      const { videoUrl, audioUrl } = pairs[i];
      const videoNum = i + 1;
      
      sendEvent('progress', {
        step: 'info',
        completed,
        total,
        message: `[${videoNum}/${total}] Memulai pengolahan pasangan ke-${videoNum}...`
      });

      if (!videoUrl) {
        sendEvent('progress', {
          step: 'error',
          completed,
          total,
          message: `[${videoNum}/${total}] Link video kosong. Dilewati.`
        });
        continue;
      }

      // Step 1: Ambil title video via yt-dlp dump-json
      let videoTitle = `video_${Date.now()}_${i}`;
      sendEvent('progress', {
        step: 'metadata',
        completed,
        total,
        message: `[${videoNum}/${total}] Mengambil judul video...`
      });

      try {
        const metadataProcess = execa('yt-dlp', ['--dump-json', '--no-playlist', videoUrl], { windowsHide: true });
        activeProcess = metadataProcess;
        const { stdout } = await metadataProcess;
        const metadata = JSON.parse(stdout);
        if (metadata.title) {
          videoTitle = sanitizeFilename(metadata.title);
        }
      } catch (metaErr: any) {
        sendEvent('progress', {
          step: 'warn',
          completed,
          total,
          message: `[${videoNum}/${total}] Gagal mengambil judul video: ${metaErr.message}. Menggunakan nama default.`
        });
      }

      activeProcess = null;
      if (isAborted) break;

      // Step 2: Download video
      const rawVideoPath = path.join(runTempDir, `temp_video_${i}.mp4`);
      sendEvent('progress', {
        step: 'download_video',
        percent: 0,
        completed,
        total,
        message: `[${videoNum}/${total}] Mengunduh video: "${videoTitle}"...`
      });

      try {
        const downloadProcess = execa('yt-dlp', [
          '--newline',
          '--no-playlist',
          '--ffmpeg-location',
          ffmpegDir,
          '-f',
          'bv*[vcodec^=avc]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',
          '--merge-output-format',
          'mp4',
          '-o',
          rawVideoPath,
          videoUrl
        ], {
          all: true,
          buffer: false,
          windowsHide: true,
          env
        });

        activeProcess = downloadProcess;

        if (downloadProcess.all) {
          downloadProcess.all.setEncoding('utf8');
          downloadProcess.all.on('data', chunk => {
            const lines = String(chunk).split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
              const match = line.match(/\[download]\s+(\d+(?:\.\d+)?)%/);
              if (match) {
                const percent = Number(match[1]);
                sendEvent('progress', {
                  step: 'download_video',
                  percent,
                  completed,
                  total,
                  message: `[${videoNum}/${total}] Unduh video ${progressBar(percent)}`
                });
              }
            }
          });
        }

        await downloadProcess;
      } catch (dlErr: any) {
        sendEvent('progress', {
          step: 'error',
          completed,
          total,
          message: `[${videoNum}/${total}] Gagal mengunduh video: ${dlErr.message}. Pasangan dilewati.`
        });
        continue;
      }

      activeProcess = null;
      if (isAborted) break;

      // Step 3: Mute video
      const mutedVideoPath = path.join(runTempDir, `temp_video_muted_${i}.mp4`);
      sendEvent('progress', {
        step: 'mute_video',
        completed,
        total,
        message: `[${videoNum}/${total}] Meringkas audio video asli (mute)...`
      });

      try {
        const muteProcess = execa(ensureFfmpegPath(), [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          rawVideoPath,
          '-an',
          '-c:v',
          'copy',
          '-y',
          mutedVideoPath
        ], { windowsHide: true });
        
        activeProcess = muteProcess;
        await muteProcess;
      } catch (muteErr: any) {
        sendEvent('progress', {
          step: 'error',
          completed,
          total,
          message: `[${videoNum}/${total}] Gagal menonaktifkan suara video: ${muteErr.message}. Pasangan dilewati.`
        });
        continue;
      }

      activeProcess = null;
      if (isAborted) break;

      // Step 4: Download music (MP3) if audioUrl is provided
      let finalAudioPath = '';
      if (audioUrl) {
        finalAudioPath = path.join(runTempDir, `temp_audio_${i}.mp3`);
        sendEvent('progress', {
          step: 'download_audio',
          percent: 0,
          completed,
          total,
          message: `[${videoNum}/${total}] Mengunduh musik pendukung...`
        });

        try {
          const audioProcess = execa('yt-dlp', [
            '--newline',
            '--no-playlist',
            '--ffmpeg-location',
            ffmpegDir,
            '-x',
            '--audio-format',
            'mp3',
            '--audio-quality',
            '0',
            '-o',
            finalAudioPath,
            audioUrl
          ], {
            all: true,
            buffer: false,
            windowsHide: true,
            env
          });

          activeProcess = audioProcess;

          if (audioProcess.all) {
            audioProcess.all.setEncoding('utf8');
            audioProcess.all.on('data', chunk => {
              const lines = String(chunk).split(/\r?\n/).filter(Boolean);
              for (const line of lines) {
                const match = line.match(/\[download]\s+(\d+(?:\.\d+)?)%/);
                if (match) {
                  const percent = Number(match[1]);
                  sendEvent('progress', {
                    step: 'download_audio',
                    percent,
                    completed,
                    total,
                    message: `[${videoNum}/${total}] Unduh musik ${progressBar(percent)}`
                  });
                }
              }
            });
          }

          await audioProcess;
        } catch (audErr: any) {
          sendEvent('progress', {
            step: 'error',
            completed,
            total,
            message: `[${videoNum}/${total}] Gagal mengunduh musik: ${audErr.message}. Menggunakan video tanpa suara baru.`
          });
          finalAudioPath = '';
        }
      }

      activeProcess = null;
      if (isAborted) break;

      // Step 5: Gabungkan muted video dengan audio (atau simpan muted video langsung jika tidak ada musik)
      let finalOutputPath = path.join(outputDir, `${videoTitle}.mp4`);
      let counter = 1;
      while (fs.existsSync(finalOutputPath)) {
        finalOutputPath = path.join(outputDir, `${videoTitle}_${counter}.mp4`);
        counter++;
      }

      if (finalAudioPath && fs.existsSync(finalAudioPath)) {
        sendEvent('progress', {
          step: 'merge',
          completed,
          total,
          message: `[${videoNum}/${total}] Menggabungkan video dengan musik...`
        });

        try {
          const mergeProcess = execa(ensureFfmpegPath(), [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            mutedVideoPath,
            '-i',
            finalAudioPath,
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-shortest',
            '-y',
            finalOutputPath
          ], { windowsHide: true });
          
          activeProcess = mergeProcess;
          await mergeProcess;
        } catch (mergeErr: any) {
          sendEvent('progress', {
            step: 'error',
            completed,
            total,
            message: `[${videoNum}/${total}] Gagal menggabungkan musik ke video: ${mergeErr.message}. Menyimpan video bisu.`
          });
          // Fallback: save the muted video directly
          try {
            fs.copyFileSync(mutedVideoPath, finalOutputPath);
          } catch (copyErr) {
            console.error('Failed to copy muted video fallback:', copyErr);
          }
        }
      } else {
        // No music, just save muted video
        sendEvent('progress', {
          step: 'save',
          completed,
          total,
          message: `[${videoNum}/${total}] Menyimpan video bisu...`
        });
        try {
          fs.copyFileSync(mutedVideoPath, finalOutputPath);
        } catch (copyErr: any) {
          sendEvent('progress', {
            step: 'error',
            completed,
            total,
            message: `[${videoNum}/${total}] Gagal menyimpan video bisu: ${copyErr.message}`
          });
          continue;
        }
      }

      activeProcess = null;
      completed++;
      sendEvent('progress', {
        step: 'success',
        completed,
        total,
        message: `[${videoNum}/${total}] Berhasil memproses video: "${path.basename(finalOutputPath)}"`
      });
    }

    // Cleanup temp dir
    try {
      fs.rmSync(runTempDir, { recursive: true, force: true });
    } catch {}

    sendEvent('done', {
      success: true,
      completed,
      total,
      message: `Selesai! Berhasil memproses ${completed} dari ${total} video.`
    });

    isCleanFinished = true;
  } catch (err: any) {
    console.error('[BAHAN-DOWNLOAD] Fatal:', err);
    sendEvent('error', {
      success: false,
      error: err.message || 'Terjadi kesalahan sistem saat memproses.'
    });
  } finally {
    res.end();
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
  const saveFolder = req.body?.saveFolder as string | undefined;
  const soundFile = ((req.files?.sound || []) as Express.Multer.File[])[0];

  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    if (soundFile) try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Folder tidak valid.' });
  }

  if (soundFile && !['.mp3', '.wav'].includes(path.extname(soundFile.originalname).toLowerCase())) {
    try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Sound harus berupa file .mp3 atau .wav.' });
  }

  const outputDir = (saveFolder && saveFolder.trim()) ? saveFolder.trim() : folder;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
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
    const outputPath = path.join(outputDir, outputFilename);

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

// ═══════════════════════════════════════════════════════════
//  MERGE-UPLOAD ROUTE & APIs
// ═══════════════════════════════════════════════════════════
const MERGE_UPLOAD_CONFIG_FILE = path.join(__dirname, 'merge-upload-config.json');

function loadMergeUploadConfig() {
  if (fs.existsSync(MERGE_UPLOAD_CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(MERGE_UPLOAD_CONFIG_FILE, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveMergeUploadConfig(config: any) {
  fs.writeFileSync(MERGE_UPLOAD_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

app.get('/merge-upload', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'merge-upload.html'));
});

app.get('/api/merge-upload/config', (req, res) => {
  res.json(loadMergeUploadConfig());
});

app.post('/api/merge-upload/config/save', (req, res) => {
  saveMergeUploadConfig(req.body);
  res.json({ success: true });
});

app.get('/api/merge-upload/scan-subfolders', (req, res) => {
  const parent = req.query.parent as string;
  if (!parent) return res.status(400).json({ success: false, error: 'Parameter parent wajib diisi.' });
  const resolved = path.resolve(parent);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.json({ success: false, error: 'Folder tidak ditemukan atau bukan directory.' });
  }
  try {
    const items = fs.readdirSync(resolved);
    const subfolders: string[] = [];
    for (const item of items) {
      const itemPath = path.join(resolved, item);
      if (fs.statSync(itemPath).isDirectory()) {
        subfolders.push(itemPath);
      }
    }
    res.json({ success: true, subfolders });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/merge-upload/list-folders', (req, res) => {
  const dirsToScan = [
    path.join(__dirname, 'bahan'),
    path.join(__dirname, 'split-videos'),
    path.join(__dirname, 'merged-videos')
  ];
  const results: string[] = [];

  for (const rootDir of dirsToScan) {
    if (!fs.existsSync(rootDir)) continue;
    try {
      results.push(rootDir);
      const items = fs.readdirSync(rootDir);
      for (const item of items) {
        const itemPath = path.join(rootDir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          results.push(itemPath);
          try {
            const subItems = fs.readdirSync(itemPath);
            for (const subItem of subItems) {
              const subItemPath = path.join(itemPath, subItem);
              if (fs.statSync(subItemPath).isDirectory()) {
                results.push(subItemPath);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }
  
  // Unique absolute paths
  const uniqueDirs = Array.from(new Set(results.map(p => path.resolve(p))));
  res.json({ success: true, folders: uniqueDirs });
});

app.post('/api/merge-upload/merge', mergeUpload.fields([
  { name: 'sound', maxCount: 1 }
]), async (req: any, res) => {
  const folder = req.body?.folder as string;
  const soundFile = ((req.files?.sound || []) as Express.Multer.File[])[0];

  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    if (soundFile) try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Folder tidak valid atau tidak ditemukan.' });
  }

  // Handle persistent sound file
  const audioDir = path.join(__dirname, 'audio');
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }
  
  let soundPathToUse = '';
  if (soundFile) {
    const ext = path.extname(soundFile.originalname).toLowerCase();
    if (!['.mp3', '.wav'].includes(ext)) {
      try { fs.unlinkSync(soundFile.path); } catch { }
      return res.status(400).json({ success: false, error: 'Format sound harus .mp3 atau .wav.' });
    }
    
    // Copy to a persistent filename
    soundPathToUse = path.join(audioDir, `merge-upload-default${ext}`);
    try {
      if (fs.existsSync(soundPathToUse)) {
        fs.unlinkSync(soundPathToUse);
      }
      fs.renameSync(soundFile.path, soundPathToUse);
      
      // Save configuration info
      const config = loadMergeUploadConfig();
      config.soundFileName = soundFile.originalname;
      config.soundFilePath = soundPathToUse;
      saveMergeUploadConfig(config);
    } catch (e: any) {
      console.error('[MERGE-UPLOAD] Gagal menyimpan sound default:', e);
      // Fallback: use the temp file directly
      soundPathToUse = soundFile.path;
    }
  } else {
    // Check if there is a saved sound
    const config = loadMergeUploadConfig();
    if (config.soundFilePath && fs.existsSync(config.soundFilePath)) {
      soundPathToUse = config.soundFilePath;
    } else {
      // Find any default file in audio/ starting with merge-upload-default
      const files = fs.readdirSync(audioDir);
      const defaultSound = files.find(f => f.startsWith('merge-upload-default.'));
      if (defaultSound) {
        soundPathToUse = path.join(audioDir, defaultSound);
      }
    }
  }

  if (!soundPathToUse) {
    return res.status(400).json({ success: false, error: 'Sound belum dipilih dan tidak ada sound default yang tersimpan.' });
  }

  // Scan folder for videos
  const videos = fs.readdirSync(folder)
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      if (!VIDEO_EXTS.includes(ext)) return false;
      // Exclude subdirectories
      if (fs.statSync(path.join(folder, f)).isDirectory()) return false;
      return true;
    })
    .sort();

  if (videos.length === 0) {
    return res.status(400).json({ success: false, error: 'Tidak ada file video di folder terpilih.' });
  }

  if (videos.length % 4 !== 0) {
    return res.status(400).json({ success: false, error: `Jumlah video harus kelipatan 4. (Saat ini terdapat ${videos.length} video).` });
  }

  // SSE response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const groupCount = videos.length / 4;
  const generatedFolders: string[] = [];
  const originalFilesToDelete: string[] = [];

  let totalMerges = groupCount * 16;
  let mergesCompleted = 0;
  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  try {
    for (let g = 0; g < groupCount; g++) {
      const groupVideos = videos.slice(g * 4, (g + 1) * 4);
      const groupName = String(g + 1);
      const groupDir = path.join(folder, groupName);
      
      fs.mkdirSync(groupDir, { recursive: true });
      generatedFolders.push(groupDir);

      // Track original files for deletion
      for (const v of groupVideos) {
        originalFilesToDelete.push(path.join(folder, v));
      }

      // Generate P(4,2) + 4 = 16 combinations
      const combinations: { video1: string; video2: string }[] = [];
      // Permutations (pairs where i !== j)
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          if (i !== j) {
            combinations.push({ video1: groupVideos[i], video2: groupVideos[j] });
          }
        }
      }
      // Self-merges (i === j)
      for (let i = 0; i < 4; i++) {
        combinations.push({ video1: groupVideos[i], video2: groupVideos[i] });
      }

      // Execute merges
      for (let c = 0; c < combinations.length; c++) {
        const combo = combinations[c];
        const v1Path = path.join(folder, combo.video1);
        const v2Path = path.join(folder, combo.video2);
        const base1 = path.basename(combo.video1, path.extname(combo.video1));
        const base2 = path.basename(combo.video2, path.extname(combo.video2));
        
        const outputFilename = `merged_${base1}_x_${base2}.mp4`;
        const outputPath = path.join(groupDir, outputFilename);

        mergesCompleted++;
        sendEvent('progress', {
          current: mergesCompleted,
          total: totalMerges,
          message: `Grup ${groupName} [${c + 1}/16]: Merge ${combo.video1} + ${combo.video2} → ${outputFilename}`,
          groupName,
          video1: combo.video1,
          video2: combo.video2,
        });

        try {
          await mergeVideosCopyWithOptionalAudio(
            [v1Path, v2Path],
            outputPath,
            soundPathToUse,
            { tempDir: path.join(__dirname, '_tmp_uploads') }
          );
          successCount++;
        } catch (err: any) {
          failCount++;
          const errMsg = `Grup ${groupName} Gagal merge ${combo.video1} + ${combo.video2}: ${err.message}`;
          errors.push(errMsg);
          console.error('[MERGE-UPLOAD-MERGE]', errMsg);
        }
      }
    }

    // Deletion if successful
    if (failCount === 0) {
      sendEvent('progress', {
        current: mergesCompleted,
        total: totalMerges,
        message: `🧹 Membersihkan file video asli...`,
      });
      for (const filepath of originalFilesToDelete) {
        if (fs.existsSync(filepath)) {
          try { fs.unlinkSync(filepath); } catch {}
        }
      }
      sendEvent('progress', {
        current: mergesCompleted,
        total: totalMerges,
        message: `✓ Selesai membersihkan file asli.`,
      });
    } else {
      sendEvent('progress', {
        current: mergesCompleted,
        total: totalMerges,
        message: `⚠ Ada merge yang gagal. File video asli tidak dihapus untuk mencegah kehilangan data.`,
      });
    }

    sendEvent('done', {
      success: failCount === 0,
      successCount,
      failCount,
      totalMerges,
      generatedFolders: generatedFolders.map(p => ({
        path: p,
        name: path.basename(p)
      })),
      errors,
    });

  } catch (err: any) {
    sendEvent('error', {
      success: false,
      error: err.message || 'Terjadi kesalahan sistem saat merge.'
    });
  } finally {
    res.end();
  }
});

app.post('/api/merge-upload/upload/start', async (req, res) => {
  if (getIsRunning()) {
    return res.status(400).json({ success: false, error: 'Upload sedang berjalan!' });
  }

  const config = {
    ...req.body,
    statesDir: STATES_DIR,
  };

  // Callback: mark video as uploaded + delete video file and check for group folder deletion
  const onVideoUploaded = (videoFilename: string) => {
    // 1. Mark in standard uploaded file
    const marksFile = path.join(config.videoFolder, '.uploaded.json');
    let marks: Record<string, boolean> = {};
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
    marks[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
    broadcastLog(`[VIDEO_UPLOADED]:${videoFilename}`);

    // 2. Delete the physical video file immediately
    const videoPath = path.join(config.videoFolder, videoFilename);
    if (fs.existsSync(videoPath)) {
      try {
        fs.unlinkSync(videoPath);
        broadcastLog(`🗑️ File video dihapus dari disk: ${videoFilename}`);
      } catch (e: any) {
        broadcastLog(`⚠ Gagal menghapus file video: ${e.message}`);
      }
    }

    // 3. Check if all video files are uploaded in the subfolder, if so, delete the subfolder and contents
    const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    try {
      const remainingVideos = fs.readdirSync(config.videoFolder)
        .filter(f => exts.includes(path.extname(f).toLowerCase()));

      if (remainingVideos.length === 0) {
        // Purge all files in the folder (including .uploaded.json etc)
        const allFiles = fs.readdirSync(config.videoFolder);
        for (const file of allFiles) {
          try { fs.unlinkSync(path.join(config.videoFolder, file)); } catch {}
        }
        // Remove empty directory
        fs.rmdirSync(config.videoFolder);
        broadcastLog(`🗑️ Folder grup ${path.basename(config.videoFolder)} selesai diupload & dihapus secara otomatis!`);
      }
    } catch (e: any) {
      broadcastLog(`⚠ Gagal membersihkan folder grup: ${e.message}`);
    }
  };

  res.json({ success: true, message: 'Upload dimulai' });
  runUpload(config, broadcastLog, onVideoUploaded).then(() => {
    broadcastLog('===== UPLOAD PROCESS FINISHED =====');
  }).catch(e => {
    broadcastLog('❌ Fatal: ' + e.message);
  });
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

// Create a new audio folder
app.post('/api/grok/audio/create-folder', (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: 'Nama folder diperlukan' });
  const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(AUDIO_DIR, cleanFolderName);
  if (fs.existsSync(targetDir)) {
    return res.status(400).json({ error: 'Folder sudah ada' });
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, message: `Berhasil membuat folder ${cleanFolderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List files inside an audio folder
app.get('/api/grok/audio/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  try {
    const files = fs.readdirSync(targetDir).filter(f => {
      const p = path.join(targetDir, f);
      return fs.statSync(p).isFile();
    });
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific file inside an audio folder
app.delete('/api/grok/audio/:folderName/:fileName', (req, res) => {
  const { folderName, fileName } = req.params;
  const filePath = path.join(AUDIO_DIR, folderName, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus ${fileName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a whole audio folder (recursive)
app.delete('/api/grok/audio/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Berhasil menghapus folder ${folderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload audio files
app.post('/api/grok/audio/upload', bahanUpload.array('audio', 100), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) return res.status(400).json({ error: 'folderName diperlukan' });
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });
  for (const f of files) {
    const dest = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dest);
  }
  res.json({ success: true, count: files.length });
});

// Save prompt
app.post('/api/grok/prompts/save', (req: Request, res: Response) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name dan prompt diperlukan' });
  const filename = name.endsWith('.json') ? name : (name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  fs.writeFileSync(path.join(PROMPT_DIR, filename), JSON.stringify({ prompt }, null, 2));
  res.json({ success: true, filename });
});

// List files inside a bahan folder
app.get('/api/grok/bahan/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  try {
    const files = fs.readdirSync(targetDir).filter(f => {
      const p = path.join(targetDir, f);
      return fs.statSync(p).isFile();
    });
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific file inside a bahan folder
app.delete('/api/grok/bahan/:folderName/:fileName', (req, res) => {
  const { folderName, fileName } = req.params;
  const filePath = path.join(BAHAN_DIR, folderName, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus ${fileName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a whole bahan folder (recursive)
app.delete('/api/grok/bahan/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Berhasil menghapus folder ${folderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new bahan folder
app.post('/api/grok/bahan/create-folder', (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: 'Nama folder diperlukan' });
  const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(BAHAN_DIR, cleanFolderName);
  if (fs.existsSync(targetDir)) {
    return res.status(400).json({ error: 'Folder sudah ada' });
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, message: `Berhasil membuat folder ${cleanFolderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Read a specific prompt file content
app.get('/api/grok/prompts/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Prompt tidak ditemukan' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json({ success: true, prompt: data.prompt });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific prompt file
app.delete('/api/grok/prompts/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Prompt tidak ditemukan' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus prompt ${filename}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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

  const data = loadGrokbotData();
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
    parallelBrowsers: req.body.parallelBrowsers || data.globalConfig?.parallelBrowsers || 1,
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
//  GROK V2 TEST APIs (/grokv2test)
// ═══════════════════════════════════════════════════════════
app.get('/grokv2test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grokv2test.html'));
});

app.get('/api/grokv2test/prompts', (req, res) => {
  if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const files = fs.readdirSync(PROMPT_DIR).filter(f => f.endsWith('.json'));
  res.json({ files });
});

app.get('/api/grokv2test/prompt-content/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File prompt tidak ditemukan' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let content = data.prompt || '';
    if (!content && Array.isArray(data.prompts) && data.prompts.length > 0) {
      content = data.prompts[0];
    }
    res.json({ success: true, prompt: content, fullData: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grokv2test/bahan', (req, res) => {
  if (!fs.existsSync(BAHAN_DIR)) fs.mkdirSync(BAHAN_DIR, { recursive: true });
  const folders = fs.readdirSync(BAHAN_DIR).filter(f => {
    try {
      return fs.statSync(path.join(BAHAN_DIR, f)).isDirectory();
    } catch {
      return false;
    }
  });
  const bahanMap: Record<string, string[]> = {};
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

  for (const folder of folders) {
    const folderPath = path.join(BAHAN_DIR, folder);
    const files = fs.readdirSync(folderPath).filter(f => imageExts.includes(path.extname(f).toLowerCase()));
    bahanMap[folder] = files;
  }
  res.json({ folders, bahanMap });
});

app.post('/api/grokv2test/generate', async (req, res) => {
  const { stateName, promptText, bahanFolder, bahanFile, resolution, duration, aspectRatio, mode } = req.body;

  if (!promptText || promptText.trim() === '') {
    return res.status(400).json({ error: 'Prompt teks harus diisi' });
  }

  let imagePath: string | undefined = undefined;
  if (bahanFolder && bahanFile) {
    imagePath = path.join(BAHAN_DIR, bahanFolder, bahanFile);
    if (!fs.existsSync(imagePath)) {
      return res.status(400).json({ error: `File gambar bahan tidak ditemukan di: ${imagePath}` });
    }
  }

  try {
    console.log(`[GROK_V2_TEST] Memulai generate video (State: ${stateName || 'indra'}, Res: ${resolution}, Dur: ${duration}, Aspect: ${aspectRatio})...`);
    
    const result = await generateGrokVideoV2({
      stateName: stateName || 'indra',
      promptText,
      imagePath,
      resolution: resolution || '720p',
      duration: duration || '5s',
      aspectRatio: aspectRatio || '9:16',
      mode: mode || 'Video'
    }, (msg, progress) => {
      console.log(`[GROK_V2_TEST] ${msg} (${progress}%)`);
    });

    res.json({
      success: true,
      result
    });
  } catch (err: any) {
    console.error(`[GROK_V2_TEST ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  VIDABOT TEST APIs (/vidabotest & /vidabot)
// ═══════════════════════════════════════════════════════════
const VIDABOT_DOWNLOAD_DIR = path.join(process.cwd(), 'vidabot-downloads');

app.get('/vidabotest', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vidabotest.html'));
});

app.get('/vidabot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vidabot.html'));
});

app.post('/api/vidabot/generate', async (req, res) => {
  const { promptText, imageBase64, bahanFolder, bahanFile, aspectRatio, cookie } = req.body;

  if (!promptText || promptText.trim() === '') {
    return res.status(400).json({ error: 'Prompt teks harus diisi' });
  }

  let imagePath: string | undefined = undefined;
  if (bahanFolder && bahanFile) {
    imagePath = path.join(BAHAN_DIR, bahanFolder, bahanFile);
  }

  try {
    console.log(`[VIDABOT_TEST] Memulai generate video (Aspect: ${aspectRatio || 'portrait'})...`);
    
    const result = await generateVidabotVideo({
      promptText,
      imagePath,
      imageBase64,
      aspectRatio: aspectRatio || 'portrait',
      cookie
    }, (msg, progress) => {
      console.log(`[VIDABOT_TEST] ${msg} (${progress}%)`);
    });

    res.json({
      success: true,
      result
    });
  } catch (err: any) {
    console.error(`[VIDABOT_TEST ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vidabot/video-file/:filename', (req, res) => {
  const { filename } = req.params;
  if (filename.includes('..')) {
    return res.status(400).send('Invalid path');
  }
  const filepath = path.join(VIDABOT_DOWNLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File not found');
  res.sendFile(filepath);
});

// ═══════════════════════════════════════════════════════════
//  TIKTOK V2 TEST APIs (/tiktokv2test)
// ═══════════════════════════════════════════════════════════
app.get('/tiktokv2test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tiktokv2test.html'));
});

app.get('/api/tiktokv2test/states', (req, res) => {
  res.json(getSavedStates('tiktok'));
});

app.post('/api/tiktokv2test/post-affiliate', bahanUpload.single('videoFile'), async (req: any, res) => {
  const { stateFile, description, hashtags, productId, productTitle, scheduleDate, scheduleTime, videoId } = req.body;
  const file = req.file as Express.Multer.File;

  if (!stateFile) return res.status(400).json({ error: 'State account harus dipilih' });
  if (!description) return res.status(400).json({ error: 'Deskripsi harus diisi' });

  let fullDescription = description;
  if (hashtags) {
    const formattedTags = hashtags.split(',').map((t: string) => t.trim()).filter(Boolean).map((t: string) => t.startsWith('#') ? t : `#${t}`).join(' ');
    fullDescription = `${description} ${formattedTags}`;
  }

  let scheduleEpoch = 0;
  if (scheduleDate && scheduleTime) {
    try {
      const dt = new Date(`${scheduleDate}T${scheduleTime}:00`);
      if (!isNaN(dt.getTime())) {
        scheduleEpoch = Math.floor(dt.getTime() / 1000);
      }
    } catch {}
  }

  try {
    console.log(`[TIKTOK_V2_TEST] Post Affiliate Request (State: ${stateFile}, Product: ${productTitle} [${productId}])...`);

    const result = await postTikTokAffiliateVideoApi({
      stateFile,
      videoPath: file ? file.path : undefined,
      videoId: videoId || undefined,
      description: fullDescription,
      productTitle: productTitle || 'ini nama produk',
      productId: productId || '1729748856299095594',
      scheduleTime: scheduleEpoch
    });

    if (file && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }

    res.json({
      success: true,
      result
    });
  } catch (err: any) {
    if (file && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }
    console.error(`[TIKTOK_V2_TEST ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
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
  const { stateFile, description, hashtags, scheduleDate, scheduleTime, intervalMinutes, lastUploadDate, lastUploadTime } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadYtbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', hashtags: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60, lastUploadDate: '', lastUploadTime: '' };
  }
  if (description !== undefined) data.states[stateFile].description = description;
  if (hashtags !== undefined) data.states[stateFile].hashtags = hashtags;
  if (scheduleDate !== undefined) data.states[stateFile].scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) data.states[stateFile].scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) data.states[stateFile].intervalMinutes = intervalMinutes;
  if (lastUploadDate !== undefined) data.states[stateFile].lastUploadDate = lastUploadDate;
  if (lastUploadTime !== undefined) data.states[stateFile].lastUploadTime = lastUploadTime;
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
  ytbotFullAutoRunning = false;
  ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '', uploadedCount: 0, uploadTotal: 0 };
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

  ytbotProgress = { download: 0, split: 0, upload: 0, currentState: stateName, uploadedCount: 0, uploadTotal: 0 };
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

    // === ADAPTIVE SCHEDULE SHIFT ===
    const now = new Date();
    const currentSchedMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
    if (!isNaN(currentSchedMs) && now.getTime() > currentSchedMs) {
      const adjustedTime = new Date(now.getTime() + 45 * 60 * 1000);
      const yyyy = adjustedTime.getFullYear();
      const mm = String(adjustedTime.getMonth() + 1).padStart(2, '0');
      const dd = String(adjustedTime.getDate()).padStart(2, '0');
      const hh = String(adjustedTime.getHours()).padStart(2, '0');
      const min = String(adjustedTime.getMinutes()).padStart(2, '0');
      
      schedDate = `${yyyy}-${mm}-${dd}`;
      schedTime = `${hh}:${min}`;
      
      ytbotLog(`⚠️ [Jadwal Adaptif] Waktu sekarang melebihi schedule yang diset.`);
      ytbotLog(`⚠️ [Jadwal Adaptif] Menyesuaikan schedule video pertama ke +45 menit: ${schedDate} ${schedTime}`);
      
      // Update config file to keep it persistent
      const updData = loadYtbotData();
      if (updData.states[stateFile]) {
        updData.states[stateFile].scheduleDate = schedDate;
        updData.states[stateFile].scheduleTime = schedTime;
        saveYtbotData(updData);
      }
    }
    // ===============================

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
    ytbotProgress.uploadedCount = 0;
    ytbotProgress.uploadTotal = batch.length;
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
      ytbotProgress.uploadedCount = uploadedCount;
      ytbotProgress.uploadTotal = batch.length;
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

    const lastUpload = new Date(batchEndMs);
    const lastUploadDate = `${lastUpload.getFullYear()}-${String(lastUpload.getMonth()+1).padStart(2,'0')}-${String(lastUpload.getDate()).padStart(2,'0')}`;
    const lastUploadTime = `${String(lastUpload.getHours()).padStart(2,'0')}:${String(lastUpload.getMinutes()).padStart(2,'0')}`;

    // Update config with new schedule for next loop
    const updData = loadYtbotData();
    if (updData.states[stateFile]) {
      updData.states[stateFile].scheduleDate = schedDate;
      updData.states[stateFile].scheduleTime = schedTime;
      updData.states[stateFile].lastUploadDate = lastUploadDate;
      updData.states[stateFile].lastUploadTime = lastUploadTime;
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
    ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '', uploadedCount: 0, uploadTotal: 0 };
    ytbotBroadcastProgress();
    ytbotLog('===== YTBOT FINISHED =====');
  }
});

function getYtbotStateNextTrigger(sf: string): { stateName: string; triggerTime: Date | null; targetTime: Date | null } {
  const data = loadYtbotData();
  const cfg = data.states[sf];
  const stateName = sf.replace('tiktok-state-', '').replace('.json', '');
  if (!cfg) return { stateName, triggerTime: null, targetTime: null };

  const lastDate = cfg.lastUploadDate;
  const lastTime = cfg.lastUploadTime;
  const intervalMin = cfg.intervalMinutes || 60;

  if (!lastDate || !lastTime) {
    const schedDate = cfg.scheduleDate;
    const schedTime = cfg.scheduleTime;
    if (!schedDate || !schedTime) return { stateName, triggerTime: null, targetTime: null };
    const nextUploadTime = new Date(`${schedDate}T${schedTime}:00`);
    if (isNaN(nextUploadTime.getTime())) return { stateName, triggerTime: null, targetTime: null };
    const lastUploadTime = new Date(nextUploadTime.getTime() - intervalMin * 60000);
    const triggerTime = new Date(lastUploadTime.getTime() - 5 * 3600000);
    return { stateName, triggerTime, targetTime: nextUploadTime };
  }

  const lastUploadTime = new Date(`${lastDate}T${lastTime}:00`);
  if (isNaN(lastUploadTime.getTime())) return { stateName, triggerTime: null, targetTime: null };
  const triggerTime = new Date(lastUploadTime.getTime() - 5 * 3600000);
  const targetTime = new Date(lastUploadTime.getTime() + intervalMin * 60000);
  return { stateName, triggerTime, targetTime };
}

function getYtbotStateLastUploadMs(sf: string): number {
  const data = loadYtbotData();
  const cfg = data.states[sf];
  if (!cfg) return 0;
  
  const lastDate = cfg.lastUploadDate;
  const lastTime = cfg.lastUploadTime;
  if (!lastDate || !lastTime) {
    const schedDate = cfg.scheduleDate;
    const schedTime = cfg.scheduleTime;
    if (!schedDate || !schedTime) return 0;
    const nextUploadTime = new Date(`${schedDate}T${schedTime}:00`);
    if (isNaN(nextUploadTime.getTime())) return 0;
    const intervalMin = cfg.intervalMinutes || 60;
    return nextUploadTime.getTime() - intervalMin * 60000;
  }
  
  const lastUploadTime = new Date(`${lastDate}T${lastTime}:00`);
  if (isNaN(lastUploadTime.getTime())) return 0;
  return lastUploadTime.getTime();
}

async function ytbotRunFullAuto(stateFiles: string[]): Promise<void> {
  ytbotLog(`♾️ Memulai YTBot Full Auto standby loop untuk ${stateFiles.length} state...`);
  
  sendWAMessage(`📢 [YTBot Full Auto] Mulai dengan Standard Scheduler (Interval mengikuti masing-masing state).`);

  ytbotQueue = stateFiles.map(sf => {
    const name = sf.replace('tiktok-state-', '').replace('.json', '');
    return { stateName: name, stateFile: sf, videoCount: 0, scheduleStart: 'Standby', scheduleEnd: 'Standby', active: false };
  });
  ytbotBroadcastQueue();

  while (ytbotFullAutoRunning) {
    if (!ytbotFullAutoRunning) break;

    if (ytbotRunning) {
      let slept = 0;
      while (slept < 10000 && ytbotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        slept += 2000;
      }
      continue;
    }

    const now = new Date();
    let triggeredStateFile: string | null = null;
    let nextStateName = 'Tidak ada';
    let nextScheduleTimeStr = 'Tidak ada';
    let earliestTriggerTime = Infinity;

    // Sort states so the one with the newest last upload is checked first
    const sortedStates = [...stateFiles].sort((a, b) => getYtbotStateLastUploadMs(b) - getYtbotStateLastUploadMs(a));

    for (const sf of sortedStates) {
      const { triggerTime, targetTime, stateName } = getYtbotStateNextTrigger(sf);
      if (!triggerTime) continue;

      const triggerTimeMs = triggerTime.getTime();

      if (now.getTime() >= triggerTimeMs && !triggeredStateFile) {
        triggeredStateFile = sf;
      }

      if (triggerTimeMs > now.getTime() && triggerTimeMs < earliestTriggerTime) {
        earliestTriggerTime = triggerTimeMs;
        nextStateName = stateName;
        nextScheduleTimeStr = `${triggerTime.getFullYear()}-${String(triggerTime.getMonth()+1).padStart(2,'0')}-${String(triggerTime.getDate()).padStart(2,'0')} ${String(triggerTime.getHours()).padStart(2,'0')}:${String(triggerTime.getMinutes()).padStart(2,'0')}`;
      }
    }

    if (triggeredStateFile) {
      const stateName = triggeredStateFile.replace('tiktok-state-', '').replace('.json', '');
      ytbotLog(`🎯 [Full Auto] State terpicu: ${stateName}. Menyiapkan eksekusi...`);

      ytbotQueue = ytbotQueue.map(q => ({ ...q, active: q.stateFile === triggeredStateFile }));
      ytbotBroadcastQueue();

      let futureNextStateName = 'Tidak ada';
      let futureNextScheduleTimeStr = 'Tidak ada';
      let futureEarliestTriggerTime = Infinity;
      for (const sf of sortedStates) {
        if (sf === triggeredStateFile) continue;
        const { triggerTime, stateName } = getYtbotStateNextTrigger(sf);
        if (triggerTime) {
          const triggerTimeMs = triggerTime.getTime();
          if (triggerTimeMs > now.getTime() && triggerTimeMs < futureEarliestTriggerTime) {
            futureEarliestTriggerTime = triggerTimeMs;
            futureNextStateName = stateName;
            futureNextScheduleTimeStr = `${triggerTime.getFullYear()}-${String(triggerTime.getMonth()+1).padStart(2,'0')}-${String(triggerTime.getDate()).padStart(2,'0')} ${String(triggerTime.getHours()).padStart(2,'0')}:${String(triggerTime.getMinutes()).padStart(2,'0')}`;
          }
        }
      }

      const { targetTime } = getYtbotStateNextTrigger(triggeredStateFile);
      const startSchedStr = targetTime ? `${targetTime.getFullYear()}-${String(targetTime.getMonth()+1).padStart(2,'0')}-${String(targetTime.getDate()).padStart(2,'0')} ${String(targetTime.getHours()).padStart(2,'0')}:${String(targetTime.getMinutes()).padStart(2,'0')}` : 'Tidak diketahui';
      
      const lastUploadTime = new Date(targetTime ? targetTime.getTime() - (loadYtbotData().states[triggeredStateFile]?.intervalMinutes || 60) * 60000 : Date.now());
      const lastUploadTimeStr = `${lastUploadTime.getFullYear()}-${String(lastUploadTime.getMonth()+1).padStart(2,'0')}-${String(lastUploadTime.getDate()).padStart(2,'0')} ${String(lastUploadTime.getHours()).padStart(2,'0')}:${String(lastUploadTime.getMinutes()).padStart(2,'0')}`;

      let waMsg = `🚀 [YTBot Full Auto] Mulai Penjadwalan Otomatis!\n`;
      waMsg += `🔑 State: ${stateName}\n`;
      waMsg += `📅 Upload Terakhir: ${lastUploadTimeStr}\n`;
      waMsg += `⏰ Sched Target Start: ${startSchedStr}\n`;
      waMsg += `⏭️ Antrian Selanjutnya: State ${futureNextStateName} pada ${futureNextScheduleTimeStr}`;
      sendWAMessage(waMsg);

      ytbotRunning = true;
      try {
        await ytbotRunState(triggeredStateFile);
      } catch (err: any) {
        ytbotLog(`❌ [Full Auto] Gagal menjalankan penjadwalan: ${err.message}`);
      } finally {
        ytbotRunning = false;
        ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '', uploadedCount: 0, uploadTotal: 0 };
        ytbotBroadcastProgress();
      }

      ytbotQueue = ytbotQueue.map(q => ({ ...q, active: false }));
      ytbotBroadcastQueue();
    } else {
      let slept = 0;
      while (slept < 10000 && ytbotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        slept += 2000;
      }
    }
  }

  ytbotLog('===== FULL AUTO STANDBY LOGIC STOPPED =====');
}

// Full auto all states
app.post('/api/ytbot/full-auto', async (req, res) => {
  if (ytbotRunning || ytbotFullAutoRunning) {
    return res.status(400).json({ success: false, error: 'YTBot sedang berjalan!' });
  }
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  ytbotFullAutoRunning = true;
  ytbotQueue = [];
  res.json({ success: true, message: 'Full Auto Standby Mode dimulai' });

  try {
    await ytbotRunFullAuto(stateFiles);
  } catch (e: any) {
    ytbotLog(`❌ Fatal Full Auto: ${e.message}`);
  } finally {
    ytbotFullAutoRunning = false;
    ytbotRunning = false;
    ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '', uploadedCount: 0, uploadTotal: 0 };
    ytbotBroadcastProgress();
    ytbotLog('===== YTBOT FINISHED =====');
  }
});



// ── FBBOT ORCHESTRATION ──
async function fbbotRunState(stateFile: string): Promise<void> {
  if (!fbbotRunning) return;
  const data = loadFbbotData();
  const cfg = data.states[stateFile];
  if (!cfg) {
    fbbotLog(`❌ Config tidak ditemukan untuk ${stateFile}`);
    return;
  }

  const stateName = stateFile.replace('facebook-state-', '').replace('.json', '');
  const videoDir = getFbbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');

  fbbotProgress = { download: 0, split: 0, upload: 0, currentState: stateName };
  fbbotBroadcastProgress();

  fbbotLog(`═══════════════════════════════════════`);
  fbbotLog(`🔑 Memproses FB state: ${stateName}`);
  fbbotLog(`═══════════════════════════════════════`);

  // Current schedule tracking
  let schedDate = cfg.scheduleDate;
  let schedTime = cfg.scheduleTime;
  const intervalMin = cfg.intervalMinutes || 60;

  // Loop while there's work to do
  while (fbbotRunning) {
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
      const freshData = loadFbbotData();
      const freshCfg = freshData.states[stateFile];
      if (!freshCfg || freshCfg.ytLinks.length === 0) {
        fbbotLog(`ℹ Tidak ada video pending dan tidak ada link YT tersisa untuk ${stateName}`);
        break;
      }

      // Take first link from stock
      const ytLink = freshCfg.ytLinks[0];
      fbbotLog(`📥 Download & split: ${ytLink}`);

      // Reset progress bars for new link download
      fbbotProgress.download = 0;
      fbbotProgress.split = 0;
      fbbotProgress.upload = 0;
      fbbotBroadcastProgress();

      try {
        const result = await splitAndProcessVideo({
          youtubeUrl: ytLink,
          outputDir: videoDir,
          tempDir: path.join(__dirname, '_tmp_uploads', 'fbbot'),
          segmentDuration: 180,
          watermarkText: 'Facebook Reels',
          onProgress: (evt) => {
            if (evt.stage === 'download' && typeof evt.percent === 'number') {
              fbbotProgress.download = Math.round(evt.percent);
              fbbotBroadcastProgress();
            } else if (evt.stage === 'split' && typeof evt.percent === 'number') {
              const part = evt.part || 1;
              const total = evt.totalParts || 1;
              const base = ((part - 1) / total) * 100;
              const overallSplit = base + (evt.percent / total);
              fbbotProgress.split = Math.round(overallSplit);
              fbbotBroadcastProgress();
            }
            fbbotLog(evt.message);
          },
        });

        fbbotLog(`✓ Split selesai: ${result.totalParts} file dari "${result.title}"`);

        // Remove used link from stock
        freshCfg.ytLinks.splice(0, 1);
        saveFbbotData(freshData);

        // Refresh video list
        allVideos = fs.readdirSync(videoDir)
          .filter(f => exts.includes(path.extname(f).toLowerCase()))
          .sort();
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
        pendingVideos = allVideos.filter(v => !marks[v]);
      } catch (err: any) {
        fbbotLog(`❌ Gagal download/split: ${err.message}`);
        // Remove failed link so we don't retry forever
        freshCfg.ytLinks.splice(0, 1);
        saveFbbotData(freshData);
        continue;
      }
    }

    if (!fbbotRunning) break;
    if (pendingVideos.length === 0) {
      fbbotLog(`ℹ Tidak ada video untuk diupload di ${stateName}`);
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
    const qIdx = fbbotQueue.findIndex(q => q.stateFile === stateFile);
    const qEntry = { stateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true };
    if (qIdx >= 0) fbbotQueue[qIdx] = qEntry; else fbbotQueue.push(qEntry);
    fbbotBroadcastQueue();

    fbbotProgress.download = 100;
    fbbotProgress.split = 100;
    fbbotProgress.upload = 0;
    fbbotBroadcastProgress();

    fbbotLog(`📤 Upload batch: ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);

    // 4. Run upload using facebook-uploader
    const uploadConfig = {
      videoFolder: videoDir,
      startFromVideo: startFrom,
      description: cfg.description || '',
      headless: cfg.headless !== false,
      scheduleDate: schedDate,
      scheduleTime: schedTime,
      intervalMinutes: intervalMin,
      stateFile: stateFile,
      statesDir: FB_STATES_DIR,
    };

    let uploadedCount = 0;
    const onVideoUploaded = (videoFilename: string) => {
      let m: Record<string, boolean> = {};
      try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      m[videoFilename] = true;
      fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
      fbbotLog(`✅ [${stateName}] ${videoFilename} terupload`);

      // Hapus video setelah sukses terupload
      const videoPath = path.join(videoDir, videoFilename);
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          fbbotLog(`🗑️ [${stateName}] Berhasil menghapus file selesai diupload: ${videoFilename}`);
        } catch (e: any) {
          fbbotLog(`⚠ Gagal menghapus file ${videoFilename}: ${e.message}`);
        }
      }

      uploadedCount++;
      fbbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
      fbbotBroadcastProgress();
    };

    try {
      await runFacebookUpload(uploadConfig, fbbotLog, onVideoUploaded);
    } catch (err: any) {
      fbbotLog(`❌ Upload error: ${err.message}`);
    }

    if (!fbbotRunning) break;

    // 5. Calculate next batch schedule start = last video schedule + interval
    const nextStartMs = batchEndMs + intervalMin * 60000;
    const nextStart = new Date(nextStartMs);
    schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
    schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;

    // Update config with new schedule for next loop
    const updData = loadFbbotData();
    if (updData.states[stateFile]) {
      updData.states[stateFile].scheduleDate = schedDate;
      updData.states[stateFile].scheduleTime = schedTime;
      saveFbbotData(updData);
    }

    fbbotLog(`⏭ Batch selanjutnya mulai: ${schedDate} ${schedTime}`);

    // Check if there are more pending videos or links
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
    allVideos = fs.readdirSync(videoDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    pendingVideos = allVideos.filter(v => !marks[v]);
    const freshData2 = loadFbbotData();
    const hasMoreLinks = (freshData2.states[stateFile]?.ytLinks?.length || 0) > 0;

    if (pendingVideos.length === 0 && !hasMoreLinks) {
      fbbotLog(`✅ Semua video dan link untuk ${stateName} sudah diproses`);
      break;
    }
  }

  // Mark state as done in queue
  const qIdx2 = fbbotQueue.findIndex(q => q.stateFile === stateFile);
  if (qIdx2 >= 0) { fbbotQueue[qIdx2].active = false; fbbotBroadcastQueue(); }
}

// ═══════════════════════════════════════════════════════════
//  FBBOT API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/fb', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fb.html'));
});

// Load configs for Facebook
app.get('/api/fb/config', (req, res) => {
  res.json(loadFbbotData());
});

// Save config for Facebook state
app.post('/api/fb/config/save', (req, res) => {
  const { stateFile, description, scheduleDate, scheduleTime, intervalMinutes, headless } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadFbbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60, headless: true };
  }
  if (description !== undefined) data.states[stateFile].description = description;
  if (scheduleDate !== undefined) data.states[stateFile].scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) data.states[stateFile].scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) data.states[stateFile].intervalMinutes = intervalMinutes;
  if (headless !== undefined) data.states[stateFile].headless = !!headless;
  saveFbbotData(data);
  res.json({ success: true });
});

// Save manually entered cookies
app.post('/api/facebook/cookies/save', (req, res) => {
  const { name, cookiesText } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nama state harus diisi!' });
  }
  if (!cookiesText || !cookiesText.trim()) {
    return res.status(400).json({ error: 'Cookies harus diisi!' });
  }

  const filename = `facebook-state-${name.trim()}.json`;
  const filepath = path.join(FB_STATES_DIR, filename);

  try {
    const text = cookiesText.trim();
    let cookiesArray: any[] = [];
    
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        cookiesArray = parsed;
      } else if (parsed && Array.isArray(parsed.cookies)) {
        cookiesArray = parsed.cookies;
      } else {
        throw new Error('Format JSON harus berupa Array cookie atau object storageState Playwright');
      }
    } else if (text.includes('=')) {
      const parts = text.split(';');
      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          const cName = part.substring(0, eqIdx).trim();
          const cValue = part.substring(eqIdx + 1).trim();
          if (cName && cValue) {
            cookiesArray.push({
              name: cName,
              value: cValue,
              domain: '.facebook.com',
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax'
            });
          }
        }
      }
    } else {
      throw new Error('Format cookies tidak dikenali (gunakan JSON Array atau document.cookie string)');
    }

    const storageStateData = {
      cookies: cookiesArray.map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.facebook.com',
        path: c.path || '/',
        expires: typeof c.expires === 'number' ? c.expires : -1,
        httpOnly: typeof c.httpOnly === 'boolean' ? c.httpOnly : true,
        secure: typeof c.secure === 'boolean' ? c.secure : true,
        sameSite: c.sameSite || 'Lax'
      })),
      origins: []
    };

    fs.writeFileSync(filepath, JSON.stringify(storageStateData, null, 2));
    res.json({ success: true, message: `Session berhasil disimpan ke ${filename}` });
  } catch (err: any) {
    res.status(400).json({ error: 'Gagal memproses cookies: ' + err.message });
  }
});

// Save manually entered cookies (universal route)
app.post('/api/cookies/save', (req, res) => {
  const { name, cookiesText, platform = 'tiktok' } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nama state harus diisi!' });
  }
  if (!cookiesText || !cookiesText.trim()) {
    return res.status(400).json({ error: 'Cookies harus diisi!' });
  }

  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const defaultDomain = platform === 'grok' ? '.grok.com' : (platform === 'facebook' ? '.facebook.com' : '.tiktok.com');

  const filename = `${prefix}${name.trim()}.json`;
  const filepath = path.join(dir, filename);

  try {
    const text = cookiesText.trim();
    let cookiesArray: any[] = [];
    
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        cookiesArray = parsed;
      } else if (parsed && Array.isArray(parsed.cookies)) {
        cookiesArray = parsed.cookies;
      } else {
        throw new Error('Format JSON harus berupa Array cookie atau object storageState Playwright');
      }
    } else if (text.includes('=')) {
      const parts = text.split(';');
      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          const cName = part.substring(0, eqIdx).trim();
          const cValue = part.substring(eqIdx + 1).trim();
          if (cName && cValue) {
            cookiesArray.push({
              name: cName,
              value: cValue,
              domain: defaultDomain,
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax'
            });
          }
        }
      }
    } else {
      throw new Error('Format cookies tidak dikenali (gunakan JSON Array atau document.cookie string)');
    }

    const storageStateData = {
      cookies: cookiesArray.map((c: any) => {
        // Expiry parsing
        let expires = -1;
        if (c.expires !== undefined) {
          if (typeof c.expires === 'number') {
            expires = c.expires;
          } else if (typeof c.expires === 'string') {
            const parsed = Date.parse(c.expires);
            if (!isNaN(parsed)) expires = Math.floor(parsed / 1000);
          }
        } else if (c.expirationDate !== undefined && c.expirationDate !== null) {
          if (typeof c.expirationDate === 'number') {
            expires = c.expirationDate;
          } else if (typeof c.expirationDate === 'string') {
            const parsed = Date.parse(c.expirationDate);
            if (!isNaN(parsed)) expires = Math.floor(parsed / 1000);
          }
        }

        // sameSite mapping
        let sameSite: 'Lax' | 'Strict' | 'None' = 'Lax';
        if (c.sameSite) {
          const lower = String(c.sameSite).toLowerCase();
          if (lower === 'lax') sameSite = 'Lax';
          else if (lower === 'strict') sameSite = 'Strict';
          else if (lower === 'none' || lower === 'no_restriction' || lower === 'unspecified') sameSite = 'None';
        }

        return {
          name: c.name,
          value: c.value,
          domain: c.domain || defaultDomain,
          path: c.path || '/',
          expires: expires,
          httpOnly: typeof c.httpOnly === 'boolean' ? c.httpOnly : true,
          secure: typeof c.secure === 'boolean' ? c.secure : true,
          sameSite: sameSite
        };
      }),
      origins: []
    };

    fs.writeFileSync(filepath, JSON.stringify(storageStateData, null, 2));
    res.json({ success: true, message: `Session berhasil disimpan ke ${filename}` });
  } catch (err: any) {
    res.status(400).json({ error: 'Gagal memproses cookies: ' + err.message });
  }
});

// Autopull feature persistence and logic
const AUTOPULL_CONFIG_FILE = path.join(__dirname, 'autopull-config.json');
let autopullInterval: NodeJS.Timeout | null = null;

function loadAutopullConfig(): { enabled: boolean } {
  try {
    if (fs.existsSync(AUTOPULL_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(AUTOPULL_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load autopull config, resetting to default.', e);
  }
  return { enabled: false };
}

function saveAutopullConfig(config: { enabled: boolean }) {
  try {
    fs.writeFileSync(AUTOPULL_CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save autopull config.', e);
  }
}

function runRestartScript() {
  try {
    const restartBatPath = path.join(__dirname, 'restart.bat');
    const scriptContent = `@echo off
ping 127.0.0.1 -n 3 > nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do (
    taskkill /f /pid %%a
)
wscript.exe "%~dp0start.vbs"
`;
    fs.writeFileSync(restartBatPath, scriptContent);

    // Spawn detached restart process
    const child = spawn('cmd.exe', ['/c', 'restart.bat'], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (err: any) {
    console.error('[RESTART] Failed to auto-restart:', err.message);
  }
}

function startAutopullPolling() {
  if (autopullInterval) clearInterval(autopullInterval);
  autopullInterval = setInterval(() => {
    console.log('[AUTOPULL] Checking for updates...');
    exec('git pull', (err, stdout, stderr) => {
      if (err) {
        console.error('[AUTOPULL] Git pull error:', err.message);
        return;
      }
      if (!stdout.includes('Already up to date.')) {
        console.log('[AUTOPULL] New updates found and pulled! Restarting server...');
        runRestartScript();
      }
    });
  }, 5 * 60 * 60 * 1000); // Check every 5 hours
}

function stopAutopullPolling() {
  if (autopullInterval) {
    clearInterval(autopullInterval);
    autopullInterval = null;
  }
}

function initAutopull() {
  const config = loadAutopullConfig();
  if (config.enabled) {
    console.log('🟢 [AUTOPULL] Auto pull is enabled. Starting background checks...');
    startAutopullPolling();
  } else {
    console.log('⚪ [AUTOPULL] Auto pull is disabled.');
  }
}

// Git and Server Restart endpoints
app.get('/git', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'git.html'));
});

app.post('/api/git/status', (req, res) => {
  exec('git status -s && git log -1 --oneline', (err, stdout, stderr) => {
    if (err) {
      return res.json({ success: false, error: err.message });
    }
    const lines = stdout.trim().split('\n');
    const lastCommit = lines.pop() || 'Unknown';
    const status = lines.join('\n').trim() || 'Clean / Up to date';
    res.json({ success: true, lastCommit, status });
  });
});

app.post('/api/git/pull', (req, res) => {
  exec('git pull', (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message + '\n' + stderr });
    }
    res.json({ success: true, output: stdout });
  });
});

app.post('/api/git/restart', (req, res) => {
  try {
    runRestartScript();
    res.json({ success: true, message: 'Server is restarting...' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/git/autopull/status', (req, res) => {
  const config = loadAutopullConfig();
  res.json({ success: true, enabled: config.enabled });
});

app.post('/api/git/autopull/toggle', (req, res) => {
  const config = loadAutopullConfig();
  config.enabled = !config.enabled;
  saveAutopullConfig(config);
  
  if (config.enabled) {
    startAutopullPolling();
  } else {
    stopAutopullPolling();
  }
  
  res.json({ success: true, enabled: config.enabled });
});

// Delete state for platform
app.post('/api/delete-state', (req, res) => {
  const { filename, platform } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename diperlukan' });

  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'State tidak ditemukan' });
  }

  try {
    fs.unlinkSync(filepath);
    res.json({ success: true, message: 'Sesi berhasil dihapus' });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal menghapus sesi: ' + err.message });
  }
});

// Export state for platform
app.get('/api/states/export', (req, res) => {
  const { filename, platform = 'tiktok' } = req.query;
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'Filename diperlukan' });
  }

  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File state tidak ditemukan' });
  }

  res.download(filepath, filename);
});

// ── ZIP helper (STORE method, tanpa library tambahan) ──────────────────────
function createDosDateTime(d = new Date()) {
  const time = (((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff);
  const date = ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff);
  return { time, date };
}

let zipCrcTable: Int32Array | null = null;
function getZipCrcTable(): Int32Array {
  if (zipCrcTable) return zipCrcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  zipCrcTable = table;
  return table;
}

function zipCrc32(data: Buffer): number {
  const table = getZipCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Membuat arsip ZIP dengan metode STORE (tanpa kompresi) berisi file-file state
function buildStatesZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const now = createDosDateTime();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = zipCrc32(entry.data);
    const size = entry.data.length;

    // Local file header (30 bytes)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(0, 8);         // method: store
    local.writeUInt16LE(now.time, 10); // time
    local.writeUInt16LE(now.date, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);     // compressed size
    local.writeUInt32LE(size, 22);     // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);        // extra len

    localParts.push(local, nameBuf, entry.data);

    // Central directory header (46 bytes)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);       // version made by
    central.writeUInt16LE(20, 6);       // version needed
    central.writeUInt16LE(0, 8);        // flags
    central.writeUInt16LE(0, 10);       // method
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);       // extra len
    central.writeUInt16LE(0, 32);       // comment len
    central.writeUInt16LE(0, 34);       // disk start
    central.writeUInt16LE(0, 36);       // internal attrs
    central.writeUInt32LE(0, 38);       // external attrs
    central.writeUInt32LE(offset, 42);  // local header offset

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const centralOffset = offset;

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);             // disk number
  eocd.writeUInt16LE(0, 6);             // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);            // comment len

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

// Export SEMUA sesi untuk satu platform, dibundel dalam satu arsip .zip
app.get('/api/states/export-all', (req, res) => {
  const platform = req.query.platform === 'grok' ? 'grok'
    : (req.query.platform === 'facebook' ? 'facebook' : 'tiktok');
  const dir = platform === 'grok' ? GROK_STATES_DIR
    : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const prefix = platform === 'grok' ? 'grok-state-'
    : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && fs.statSync(path.join(dir, f)).isFile());
  } catch (err: any) {
    return res.status(500).json({ error: 'Gagal membaca folder sesi: ' + err.message });
  }

  if (files.length === 0) {
    return res.status(404).json({ error: 'Tidak ada sesi tersimpan untuk diekspor' });
  }

  const entries: { name: string; data: Buffer }[] = [];
  for (const f of files) {
    try {
      entries.push({ name: f, data: fs.readFileSync(path.join(dir, f)) });
    } catch (err) {
      console.error('[EXPORT-ALL] Gagal membaca sesi, dilewati:', f, (err as any).message);
    }
  }

  if (entries.length === 0) {
    return res.status(500).json({ error: 'Tidak ada file sesi yang berhasil dibaca' });
  }

  try {
    const zipBuffer = buildStatesZip(entries);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${prefix}all-sessions-${stamp}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (err: any) {
    console.error('[EXPORT-ALL] Gagal membuat zip:', err);
    res.status(500).json({ error: 'Gagal membuat arsip sesi: ' + err.message });
  }
});

// Import state for platform
app.post('/api/states/import', (req, res) => {
  const { filename, content, platform = 'tiktok' } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: 'Filename dan content diperlukan' });
  }

  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');

  // Sanitize filename: remove prefix if present, extract the raw name, then build the proper filename
  let rawName = filename.replace(/\.json$/i, '');
  if (rawName.startsWith(prefix)) {
    rawName = rawName.substring(prefix.length);
  }

  const cleanName = rawName.replace(/[<>:"/\\|?*\x00-\x1F\s]+/g, '_').trim();
  if (!cleanName) {
    return res.status(400).json({ error: 'Nama sesi tidak valid' });
  }

  const targetFilename = `${prefix}${cleanName}.json`;
  const filepath = path.join(dir, targetFilename);

  try {
    let parsedContent = typeof content === 'string' ? JSON.parse(content) : content;
    if (!parsedContent || (!Array.isArray(parsedContent.cookies) && !Array.isArray(parsedContent))) {
      return res.status(400).json({ error: 'Format JSON tidak valid. Harus berisi cookies array atau storageState Playwright.' });
    }

    if (Array.isArray(parsedContent)) {
      parsedContent = { cookies: parsedContent, origins: [] };
    }

    fs.writeFileSync(filepath, JSON.stringify(parsedContent, null, 2));
    res.json({ success: true, message: `Sesi berhasil diimpor sebagai ${targetFilename}`, filename: targetFilename });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal memproses/menyimpan file sesi: ' + err.message });
  }
});

// Add FB link
app.post('/api/fb/links/add', (req, res) => {
  const { stateFile, link } = req.body;
  if (!stateFile || !link) return res.status(400).json({ error: 'stateFile dan link diperlukan' });
  const data = loadFbbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60 };
  }
  data.states[stateFile].ytLinks.push(link);
  saveFbbotData(data);
  res.json({ success: true });
});

// Remove FB link
app.post('/api/fb/links/remove', (req, res) => {
  const { stateFile, link } = req.body;
  if (!stateFile || !link) return res.status(400).json({ error: 'stateFile dan link diperlukan' });
  const data = loadFbbotData();
  const cfg = data.states[stateFile];
  if (cfg) {
    const idx = cfg.ytLinks.indexOf(link);
    if (idx >= 0) cfg.ytLinks.splice(idx, 1);
    saveFbbotData(data);
  }
  res.json({ success: true });
});

// List videos for a state
app.get('/api/fb/videos', (req, res) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ videos: [] });
  const videoDir = getFbbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  const videos = fs.readdirSync(videoDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort()
    .map(f => ({ name: f, uploaded: !marks[f] ? false : true }));
  res.json({ videos });
});

// SSE logs
app.get('/api/fb/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  fbbotSseClients.push(res);
  req.on('close', () => {
    const idx = fbbotSseClients.indexOf(res);
    if (idx >= 0) fbbotSseClients.splice(idx, 1);
  });
});

// Status
app.get('/api/fb/status', (req, res) => {
  res.json({ running: fbbotRunning, queue: fbbotQueue, progress: fbbotProgress });
});

// Stop
app.post('/api/fb/stop', async (req, res) => {
  fbbotRunning = false;
  fbbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
  fbbotBroadcastProgress();
  await stopFacebookUploader();
  fbbotLog('⛔ ===== FBBOT STOPPED =====');
  res.json({ success: true });
});

// Schedule one state
app.post('/api/fb/schedule', async (req, res) => {
  if (fbbotRunning) {
    return res.status(400).json({ success: false, error: 'FB Reels Bot sedang berjalan!' });
  }
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  fbbotRunning = true;
  fbbotQueue = [];
  res.json({ success: true, message: 'Jadwal Facebook dimulai' });

  try {
    await fbbotRunState(stateFile);
  } catch (e: any) {
    fbbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    fbbotRunning = false;
    fbbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
    fbbotBroadcastProgress();
    fbbotLog('===== FBBOT FINISHED =====');
  }
});

// Full auto all states
app.post('/api/fb/full-auto', async (req, res) => {
  if (fbbotRunning) {
    return res.status(400).json({ success: false, error: 'FB Reels Bot sedang berjalan!' });
  }
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  fbbotRunning = true;
  fbbotQueue = [];
  res.json({ success: true, message: 'Full Auto Facebook dimulai' });

  try {
    for (const sf of stateFiles) {
      if (!fbbotRunning) break;
      await fbbotRunState(sf);
    }
  } catch (e: any) {
    fbbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    fbbotRunning = false;
    fbbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
    fbbotBroadcastProgress();
    fbbotLog('===== FBBOT FINISHED =====');
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
  threeUploadsPerHour?: boolean;
  lastUploadDate?: string;
  lastUploadTime?: string;
}

interface GrokbotData {
  states: Record<string, GrokbotStateConfig>;
  globalConfig?: {
    parallelBrowsers?: number;
    headless?: boolean;
    sendWhatsApp?: boolean;
    fullAuto?: {
      enableCustomScheduler?: boolean;
      customIntervalHours?: number;
      customUploadCount?: number;
      headless?: boolean;
    };
  };
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

function isHeadlessEnabled(stateFile?: string): boolean {
  const data = loadGrokbotData();
  // 1. Jika global config di-uncheck (false) di UI, maka headless HARUS false
  if (data.globalConfig && data.globalConfig.headless === false) {
    return false;
  }
  // 2. Jika per-state config di-uncheck (false), maka headless HARUS false
  if (stateFile && data.states && data.states[stateFile] && data.states[stateFile].headless === false) {
    return false;
  }
  return data.globalConfig?.headless !== false;
}

// Wrapper functions for WhatsApp notifications based on global config
function sendWAMessage(msg: string) {
  const data = loadGrokbotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalSendWAMessage(msg);
  }
}

function notifyScheduleStarted(sched: string, end: string, stateName: string) {
  const data = loadGrokbotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalNotifyScheduleStarted(sched, end, stateName);
  }
}

function notifyScheduleFinished(stateName: string, success: boolean, count: number, err?: string) {
  const data = loadGrokbotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalNotifyScheduleFinished(stateName, success, count, err);
  }
}

// Global state for Grokbot SSE & Orchestration
const grokbotSseClients: Response[] = [];
let grokbotRunning = false;
let infiniteGenRunning = false;
let grokbotFullAutoRunning = false;
let infiniteGenWaitInfo: { rateLimitTime: string; resumeTime: string; targetState: string } | null = null;
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

app.post('/api/grokbot/global-config/save', (req, res) => {
  const { parallelBrowsers, headless, sendWhatsApp } = req.body;
  const data = loadGrokbotData();
  if (!data.globalConfig) {
    data.globalConfig = {};
  }
  if (parallelBrowsers !== undefined) {
    data.globalConfig.parallelBrowsers = Math.max(1, parseInt(parallelBrowsers) || 1);
  }
  if (headless !== undefined) {
    data.globalConfig.headless = !!headless;
  }
  if (sendWhatsApp !== undefined) {
    data.globalConfig.sendWhatsApp = !!sendWhatsApp;
  }
  saveGrokbotData(data);
  res.json({ success: true });
});

app.post('/api/grokbot/full-auto-settings/save', (req, res) => {
  const { enableCustomScheduler, customIntervalHours, customUploadCount, headless } = req.body;
  const data = loadGrokbotData();
  if (!data.globalConfig) {
    data.globalConfig = {};
  }
  data.globalConfig.fullAuto = {
    enableCustomScheduler: !!enableCustomScheduler,
    customIntervalHours: Math.max(1, parseInt(customIntervalHours) || 10),
    customUploadCount: Math.max(1, parseInt(customUploadCount) || 5),
    headless: headless !== false
  };
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
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ error: 'Grokbot sedang berjalan!' });
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
  sendWAMessage(`🚀 [${tiktokStateName}] Memulai Generate Stok Utama (dibutuhkan: ${needed} video, raw: ${totalRawToGenerate}).`);
  
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
    headless: isHeadlessEnabled(stateFile),
    downloadDir: GROK_DOWNLOAD_DIR,
    customDownloadDir: stateDownloadDir,
    totalVideos: totalRawToGenerate,
    merge: mergeEnabled,
    audioFolder: cfg.audioFolder || '',
    parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
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
    const stats = getGrokStats();
    sendWAMessage(`✅ [${tiktokStateName}] Generate Stok Utama Selesai! Berhasil: ${stats.success}, Gagal: ${stats.failed}, Merged: ${stats.saved}/${needed}`);
  }).catch(e => {
    clearInterval(poll);
    grokbotLog('❌ Fatal Utama Gen: ' + e.message);
    sendWAMessage(`❌ [${tiktokStateName}] Gagal Generate Stok Utama: ${e.message}`);
  }).finally(() => {
    grokbotRunning = false;
    grokbotQueue = [];
    grokbotBroadcastQueue();
  });
});

app.post('/api/grokbot/generate-cadangan', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ error: 'Grokbot sedang berjalan!' });
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
  sendWAMessage(`🚀 [${tiktokStateName}] Memulai Generate Stok Cadangan (30 video merged, 60 raw).`);
  
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
    headless: isHeadlessEnabled(stateFile),
    downloadDir: GROK_DOWNLOAD_DIR,
    customDownloadDir: cadanganDir,
    totalVideos: 60, // 30 merged videos require 60 raw
    merge: true,
    audioFolder: cfg.audioFolder || '',
    parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
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
    const stats = getGrokStats();
    sendWAMessage(`✅ [${tiktokStateName}] Generate Stok Cadangan Selesai! Berhasil: ${stats.success}, Gagal: ${stats.failed}, Merged: ${stats.saved}/30`);
  }).catch(e => {
    clearInterval(poll);
    grokbotLog('❌ Fatal Cadangan Gen: ' + e.message);
    sendWAMessage(`❌ [${tiktokStateName}] Gagal Generate Stok Cadangan: ${e.message}`);
  }).finally(() => {
    grokbotRunning = false;
    grokbotQueue = [];
    grokbotBroadcastQueue();
  });
});

// ── IMPORT CADANGAN: Move backup videos to main stock ──
app.post('/api/grokbot/import-cadangan', async (req, res) => {
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');

  if (!fs.existsSync(cadanganDir)) {
    return res.status(400).json({ error: `Folder cadangan tidak ditemukan: ${cadanganDir}` });
  }

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.png', '.jpg', '.jpeg', '.webp'];
  const cadanganMarksFile = path.join(cadanganDir, '.uploaded.json');
  let cadanganMarks: Record<string, boolean> = {};
  try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

  const allCadanganVideos = fs.readdirSync(cadanganDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort();
  const pendingCadanganVideos = allCadanganVideos.filter(v => !cadanganMarks[v]);

  if (pendingCadanganVideos.length === 0) {
    return res.status(400).json({ error: 'Tidak ada video cadangan yang tersedia untuk diimpor!' });
  }

  if (!fs.existsSync(stateDownloadDir)) {
    fs.mkdirSync(stateDownloadDir, { recursive: true });
  }

  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  let movedCount = 0;
  let marksChanged = false;

  for (const file of pendingCadanganVideos) {
    const src = path.join(cadanganDir, file);
    const dest = path.join(stateDownloadDir, file);
    try {
      fs.renameSync(src, dest);
      cadanganMarks[file] = true;
      if (marks[file]) {
        delete marks[file];
        marksChanged = true;
      }
      movedCount++;
    } catch (e: any) {
      grokbotLog(`⚠ Gagal memindahkan ${file}: ${e.message}`);
    }
  }

  try {
    fs.writeFileSync(cadanganMarksFile, JSON.stringify(cadanganMarks, null, 2));
    if (marksChanged) {
      fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
    }
  } catch (e: any) {
    grokbotLog(`⚠ Gagal memperbarui tanda upload: ${e.message}`);
  }

  grokbotLog(`🚚 [Manual Import] Berhasil memindahkan ${movedCount} video dari stok cadangan ke stok utama untuk ${tiktokStateName}`);

  res.json({ success: true, message: `Berhasil mengimpor ${movedCount} video dari stok cadangan ke stok utama.` });
});

// ── JADWALKAN SAJA: Skip generation, use existing utama stock ──
app.post('/api/grokbot/schedule-only', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
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
  const intervalMin = cfg.threeUploadsPerHour ? (cfg.intervalMinutes || 300) : (cfg.intervalMinutes || 60);
  const batch = pendingUtamaVideos.slice(0, 30);
  const startFrom = batch[0];

  let batchStartMs: number;
  let batchEndMs: number;
  if (cfg.threeUploadsPerHour) {
    const baseSchedule = new Date(`${schedDate}T${schedTime}:00`);
    baseSchedule.setMinutes(0);
    baseSchedule.setSeconds(0);
    baseSchedule.setMilliseconds(0);
    batchStartMs = baseSchedule.getTime();

    const cycleMs = (60 + intervalMin) * 60000;
    const lastBatchIndex = Math.floor((batch.length - 1) / 3);
    batchEndMs = batchStartMs + lastBatchIndex * cycleMs + 60 * 60000;
  } else {
    batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
    batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
  }
  const endDate = new Date(batchEndMs);
  const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

  grokbotQueue.push({ stateName: tiktokStateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true });
  grokbotBroadcastQueue();

  resetGrokbotProgress({ generate: 100, merge: 100, currentState: tiktokStateName, uploadTotal: batch.length });
  grokbotBroadcastProgress();

  res.json({ success: true, message: `Jadwalkan ${batch.length} video utama tanpa generate` });

  grokbotLog(`📤 [Jadwalkan Saja] Mulai Upload ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);
  notifyScheduleStarted(`${schedDate} ${schedTime}`, endStr, tiktokStateName);

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
      headless: isHeadlessEnabled(stateFile),
      scheduleDate: schedDate,
      scheduleTime: schedTime,
      intervalMinutes: intervalMin,
      stateFile: stateFile,
      statesDir: STATES_DIR,
      threeUploadsPerHour: !!cfg.threeUploadsPerHour,
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

  let success = true;
  let errMsg = '';
  try {
    await runUpload(uploadConfig, grokbotLog, onVideoUploaded);
  } catch (err: any) {
    success = false;
    errMsg = err.message;
    grokbotLog(`❌ Upload error: ${err.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotQueue = [];
    grokbotBroadcastQueue();
    grokbotLog('===== JADWALKAN SAJA FINISHED =====');
    notifyScheduleFinished(tiktokStateName, success, uploadedCount, errMsg);
  }
});

// ── MERGE SAJA: Merge raw videos without generating new ones ──
app.post('/api/grokbot/merge-only', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
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
  sendWAMessage(`✂ [${tiktokStateName}] Memulai Merge Saja (${pairsCount} pasang raw video).`);

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
    sendWAMessage(`✅ [${tiktokStateName}] Merge Saja Selesai! Berhasil menggabungkan ${mergedCount} video.`);
  } catch (e: any) {
    grokbotLog(`❌ Fatal Merge Only: ${e.message}`);
    sendWAMessage(`❌ [${tiktokStateName}] Gagal Merge Saja: ${e.message}`);
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
async function grokbotRunState(stateFile: string, isFullAuto = false): Promise<void> {
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
  const intervalMin = cfg.threeUploadsPerHour ? (cfg.intervalMinutes || 300) : (cfg.intervalMinutes || 60);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  let totalUploadedThisSession = 0;
  let success = true;
  let lastError: string | undefined = undefined;

  try {
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
      if (isFullAuto) {
        if (pendingUtamaVideos.length === 0) {
          grokbotLog(`❌ [Full Auto] Stok Utama dan Cadangan habis untuk ${tiktokStateName}.`);
          success = false;
          lastError = "Stok Utama dan Cadangan habis";
          break; // Exit loop
        }
        grokbotLog(`ℹ [Full Auto] Menggunakan stok yang tersedia: ${pendingUtamaVideos.length} video.`);
      } else if (needed > 0) {
        grokbotLog(`ℹ Stok utama kurang ${needed} video. Memulai auto-generate via Grok...`);
        sendWAMessage(`🤖 [${tiktokStateName}] Stok utama kurang ${needed} video. Memulai auto-generate via Grok...`);
        if (!cfg.grokState) {
          grokbotLog(`❌ Gagal: Grok State belum diatur untuk TikTok state ${tiktokStateName}`);
          success = false;
          lastError = `Grok State belum diatur untuk TikTok state ${tiktokStateName}`;
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
          headless: isHeadlessEnabled(stateFile), // Headless mode sesuai state/global config
          downloadDir: GROK_DOWNLOAD_DIR,
          customDownloadDir: stateDownloadDir,
          totalVideos: totalRawToGenerate,
          merge: mergeEnabled,
          audioFolder: cfg.audioFolder || '',
          parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
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
          sendWAMessage(`✅ [${tiktokStateName}] Auto-generate selesai!`);
          
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
          sendWAMessage(`❌ [${tiktokStateName}] Gagal auto-generate via Grok: ${err.message}`);
          success = false;
          lastError = err.message;
          break;
        }
      }

      if (!grokbotRunning) break;
      if (pendingUtamaVideos.length === 0) {
        grokbotLog(`ℹ Tidak ada video untuk diupload di ${tiktokStateName}`);
        break;
      }

      const globalConfig = loadGrokbotData().globalConfig;
      const isCustom = isFullAuto && globalConfig?.fullAuto?.enableCustomScheduler;
      const customUploadCount = globalConfig?.fullAuto?.customUploadCount || 5;
      const customIntervalHours = globalConfig?.fullAuto?.customIntervalHours || 10;

      // 4. Batch videos
      const batchSize = isCustom ? customUploadCount : 30;
      const batch = pendingUtamaVideos.slice(0, batchSize);
      const startFrom = batch[0];

      let batchStartMs: number;
      let batchEndMs: number;
      if (isCustom) {
        batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
        // Custom scheduling happens within a 1-hour window
        batchEndMs = batchStartMs + 60 * 60000;
      } else if (cfg.threeUploadsPerHour) {
        const baseSchedule = new Date(`${schedDate}T${schedTime}:00`);
        baseSchedule.setMinutes(0);
        baseSchedule.setSeconds(0);
        baseSchedule.setMilliseconds(0);
        batchStartMs = baseSchedule.getTime();

        const cycleMs = (60 + intervalMin) * 60000;
        const lastBatchIndex = Math.floor((batch.length - 1) / 3);
        batchEndMs = batchStartMs + lastBatchIndex * cycleMs + 60 * 60000;
      } else {
        batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
        batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
      }
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
      notifyScheduleStarted(`${schedDate} ${schedTime}`, endStr, tiktokStateName);

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
        headless: isHeadlessEnabled(stateFile), // headless mode sesuai state/global config
        scheduleDate: schedDate,
        scheduleTime: schedTime,
        intervalMinutes: intervalMin,
        stateFile: stateFile,
        statesDir: STATES_DIR,
        threeUploadsPerHour: !!cfg.threeUploadsPerHour,
        enableCustomScheduler: isCustom,
        customIntervalHours: customIntervalHours,
        customUploadCount: customUploadCount
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
        totalUploadedThisSession++;
        grokbotProgress.uploadedCount = uploadedCount;
        grokbotProgress.uploadTotal = batch.length;
        grokbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
        grokbotBroadcastProgress();
      };

      try {
        await runUpload(uploadConfig, grokbotLog, onVideoUploaded);
      } catch (err: any) {
        success = false;
        lastError = err.message;
        grokbotLog(`❌ Upload error: ${err.message}`);
      }

      if (!grokbotRunning) break;

      // 5. Calculate rolling schedule for subsequent loops
      let lastUploadDate: string;
      let lastUploadTime: string;

      if (isCustom) {
        // Roll forward by custom interval hours from the batch start baseline
        const nextStartMs = batchStartMs + customIntervalHours * 3600000;
        const nextStart = new Date(nextStartMs);
        schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
        schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;
        
        lastUploadDate = schedDate;
        lastUploadTime = schedTime;
      } else {
        const nextStartMs = batchEndMs + intervalMin * 60000;
        const nextStart = new Date(nextStartMs);
        schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
        schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;

        const lastUpload = new Date(batchEndMs);
        lastUploadDate = `${lastUpload.getFullYear()}-${String(lastUpload.getMonth()+1).padStart(2,'0')}-${String(lastUpload.getDate()).padStart(2,'0')}`;
        lastUploadTime = `${String(lastUpload.getHours()).padStart(2,'0')}:${String(lastUpload.getMinutes()).padStart(2,'0')}`;
      }

      const updData = loadGrokbotData();
      if (updData.states[stateFile]) {
        updData.states[stateFile].scheduleDate = schedDate;
        updData.states[stateFile].scheduleTime = schedTime;
        updData.states[stateFile].lastUploadDate = lastUploadDate;
        updData.states[stateFile].lastUploadTime = lastUploadTime;
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
  } catch (err: any) {
    success = false;
    lastError = err.message;
    grokbotLog(`❌ Loop error: ${err.message}`);
  } finally {
    // Mark done
    const qIdx2 = grokbotQueue.findIndex(q => q.stateFile === stateFile);
    if (qIdx2 >= 0) { grokbotQueue[qIdx2].active = false; grokbotBroadcastQueue(); }
    notifyScheduleFinished(tiktokStateName, success, totalUploadedThisSession, lastError);
  }
}

app.post('/api/grokbot/schedule', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  grokbotRunning = true;
  grokbotQueue = [];
  res.json({ success: true, message: 'Jadwal dimulai' });
  sendWAMessage(`🚀 [${tiktokStateName}] Jadwalkan & Upload dimulai! (Memeriksa stok...)`);

  try {
    await grokbotRunState(stateFile);
  } catch (e: any) {
    grokbotLog(`❌ Fatal: ${e.message}`);
    sendWAMessage(`❌ [${tiktokStateName}] Fatal error saat Jadwalkan & Upload: ${e.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotLog('===== GROKBOT FINISHED =====');
  }
});

function getStateNextTrigger(sf: string): { stateName: string; triggerTime: Date | null; targetTime: Date | null } {
  const data = loadGrokbotData();
  const cfg = data.states[sf];
  const stateName = sf.replace('tiktok-state-', '').replace('.json', '');
  if (!cfg) return { stateName, triggerTime: null, targetTime: null };

  const lastDate = cfg.lastUploadDate;
  const lastTime = cfg.lastUploadTime;
  const intervalMin = cfg.threeUploadsPerHour ? (cfg.intervalMinutes || 300) : (cfg.intervalMinutes || 60);

  if (!lastDate || !lastTime) {
    // If lastUpload is not set, use scheduleDate/scheduleTime directly as next upload time, so lastUpload is next - interval
    const schedDate = cfg.scheduleDate;
    const schedTime = cfg.scheduleTime;
    if (!schedDate || !schedTime) return { stateName, triggerTime: null, targetTime: null };
    const nextUploadTime = new Date(`${schedDate}T${schedTime}:00`);
    if (isNaN(nextUploadTime.getTime())) return { stateName, triggerTime: null, targetTime: null };
    const lastUploadTime = new Date(nextUploadTime.getTime() - intervalMin * 60000);
    const triggerTime = new Date(lastUploadTime.getTime() - 5 * 3600000);
    return { stateName, triggerTime, targetTime: nextUploadTime };
  }

  const lastUploadTime = new Date(`${lastDate}T${lastTime}:00`);
  if (isNaN(lastUploadTime.getTime())) return { stateName, triggerTime: null, targetTime: null };
  const triggerTime = new Date(lastUploadTime.getTime() - 5 * 3600000);
  const targetTime = new Date(lastUploadTime.getTime() + intervalMin * 60000);
  return { stateName, triggerTime, targetTime };
}

async function grokbotRunFullAuto(stateFiles: string[]): Promise<void> {
  grokbotLog(`♾️ Memulai Full Auto standby loop untuk ${stateFiles.length} state...`);
  
  const autoData = loadGrokbotData();
  const autoGlobalConfig = autoData.globalConfig;
  const autoIsCustom = autoGlobalConfig?.fullAuto?.enableCustomScheduler;
  const autoCustomIntervalHours = autoGlobalConfig?.fullAuto?.customIntervalHours || 10;
  const autoCustomUploadCount = autoGlobalConfig?.fullAuto?.customUploadCount || 5;

  let startWAMsg = "";
  if (autoIsCustom) {
    startWAMsg = `📢 [Full Auto] Mulai dengan Custom Scheduler (Interval: ${autoCustomIntervalHours} jam, Jumlah Video: ${autoCustomUploadCount} video/batch).`;
  } else {
    startWAMsg = `📢 [Full Auto] Mulai dengan Standard Scheduler (Interval mengikuti masing-masing state).`;
  }
  sendWAMessage(startWAMsg);

  grokbotQueue = stateFiles.map(sf => {
    const name = sf.replace('tiktok-state-', '').replace('.json', '');
    return { stateName: name, stateFile: sf, videoCount: 0, scheduleStart: 'Standby', scheduleEnd: 'Standby', active: false };
  });
  grokbotBroadcastQueue();

  while (grokbotFullAutoRunning) {
    if (!grokbotFullAutoRunning) break;

    if (grokbotRunning) {
      let slept = 0;
      while (slept < 10000 && grokbotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        slept += 2000;
      }
      continue;
    }

    const now = new Date();
    let triggeredStateFile: string | null = null;
    let nextStateName = 'Tidak ada';
    let nextScheduleTimeStr = 'Tidak ada';
    let earliestTriggerTime = Infinity;

    for (const sf of stateFiles) {
      const { triggerTime, targetTime, stateName } = getStateNextTrigger(sf);
      if (!triggerTime) continue;

      const triggerTimeMs = triggerTime.getTime();

      if (now.getTime() >= triggerTimeMs && !triggeredStateFile) {
        triggeredStateFile = sf;
      }

      if (triggerTimeMs > now.getTime() && triggerTimeMs < earliestTriggerTime) {
        earliestTriggerTime = triggerTimeMs;
        nextStateName = stateName;
        nextScheduleTimeStr = `${triggerTime.getFullYear()}-${String(triggerTime.getMonth()+1).padStart(2,'0')}-${String(triggerTime.getDate()).padStart(2,'0')} ${String(triggerTime.getHours()).padStart(2,'0')}:${String(triggerTime.getMinutes()).padStart(2,'0')}`;
      }
    }

    if (triggeredStateFile) {
      const stateName = triggeredStateFile.replace('tiktok-state-', '').replace('.json', '');
      grokbotLog(`🎯 [Full Auto] State terpicu: ${stateName}. Menyiapkan eksekusi...`);

      grokbotQueue = grokbotQueue.map(q => ({ ...q, active: q.stateFile === triggeredStateFile }));
      grokbotBroadcastQueue();

      let futureNextStateName = 'Tidak ada';
      let futureNextScheduleTimeStr = 'Tidak ada';
      let futureEarliestTriggerTime = Infinity;
      for (const sf of stateFiles) {
        if (sf === triggeredStateFile) continue;
        const { triggerTime, stateName } = getStateNextTrigger(sf);
        if (triggerTime) {
          const triggerTimeMs = triggerTime.getTime();
          if (triggerTimeMs > now.getTime() && triggerTimeMs < futureEarliestTriggerTime) {
            futureEarliestTriggerTime = triggerTimeMs;
            futureNextStateName = stateName;
            futureNextScheduleTimeStr = `${triggerTime.getFullYear()}-${String(triggerTime.getMonth()+1).padStart(2,'0')}-${String(triggerTime.getDate()).padStart(2,'0')} ${String(triggerTime.getHours()).padStart(2,'0')}:${String(triggerTime.getMinutes()).padStart(2,'0')}`;
          }
        }
      }

      const { targetTime } = getStateNextTrigger(triggeredStateFile);
      const startSchedStr = targetTime ? `${targetTime.getFullYear()}-${String(targetTime.getMonth()+1).padStart(2,'0')}-${String(targetTime.getDate()).padStart(2,'0')} ${String(targetTime.getHours()).padStart(2,'0')}:${String(targetTime.getMinutes()).padStart(2,'0')}` : 'Tidak diketahui';
      
      const lastUploadTime = new Date(targetTime ? targetTime.getTime() - (loadGrokbotData().states[triggeredStateFile]?.intervalMinutes || 60) * 60000 : Date.now());
      const lastUploadTimeStr = `${lastUploadTime.getFullYear()}-${String(lastUploadTime.getMonth()+1).padStart(2,'0')}-${String(lastUploadTime.getDate()).padStart(2,'0')} ${String(lastUploadTime.getHours()).padStart(2,'0')}:${String(lastUploadTime.getMinutes()).padStart(2,'0')}`;

      let waMsg = `🚀 [Full Auto] Mulai Penjadwalan Otomatis!\n`;
      waMsg += `🔑 State: ${stateName}\n`;
      waMsg += `📅 Upload Terakhir: ${lastUploadTimeStr}\n`;
      waMsg += `⏰ Sched Target Start: ${startSchedStr}\n`;
      waMsg += `⏭️ Antrian Selanjutnya: State ${futureNextStateName} pada ${futureNextScheduleTimeStr}`;
      sendWAMessage(waMsg);

      grokbotRunning = true;
      try {
        await grokbotRunState(triggeredStateFile, true);
      } catch (err: any) {
        grokbotLog(`❌ [Full Auto] Gagal menjalankan penjadwalan: ${err.message}`);
      } finally {
        grokbotRunning = false;
        resetGrokbotProgress();
        grokbotBroadcastProgress();
      }

      grokbotQueue = grokbotQueue.map(q => ({ ...q, active: false }));
      grokbotBroadcastQueue();
    } else {
      let slept = 0;
      while (slept < 10000 && grokbotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        slept += 2000;
      }
    }
  }

  grokbotLog('===== FULL AUTO STANDBY LOGIC STOPPED =====');
}

app.post('/api/grokbot/full-auto', async (req, res) => {
  if (grokbotRunning || grokbotFullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  grokbotFullAutoRunning = true;
  grokbotQueue = [];
  res.json({ success: true, message: 'Full Auto Standby Mode dimulai' });

  try {
    await grokbotRunFullAuto(stateFiles);
  } catch (e: any) {
    grokbotLog(`❌ Fatal Full Auto: ${e.message}`);
  } finally {
    grokbotFullAutoRunning = false;
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotLog('===== FULL AUTO FINISHED =====');
  }
});

function getRateLimitExpiryDate(availableAt: string, detectedAt: number): Date | null {
  if (!availableAt) return null;
  const clean = availableAt.replace(/wib|wita|wit/gi, '').replace(/\./g, ':').trim();
  const match = clean.match(/^([0-9]{1,2}):([0-9]{2})(?:\s*(AM|PM|am|pm))?$/i);
  if (!match) return null;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const ampm = match[3];

  if (ampm) {
    const isPm = ampm.toLowerCase() === 'pm';
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
  }

  const expiry = new Date(detectedAt);
  expiry.setHours(hours, minutes, 0, 0);

  // If target time is before detection time, it rolled over past midnight
  if (expiry.getTime() < detectedAt) {
    expiry.setDate(expiry.getDate() + 1);
  }
  return expiry;
}

function parseAvailableAt(availableAt: string): number {
  if (!availableAt) return 15 * 60 * 1000; // default 15 mins fallback

  // Clean characters, remove WIB/WITA/WIT, replace dots with colons
  const clean = availableAt.replace(/wib|wita|wit/gi, '').replace(/\./g, ':').trim();
  
  // Match standard time format e.g. "10:29", "2:15 PM", "10:29 AM", "14:15"
  const match = clean.match(/^([0-9]{1,2}):([0-9]{2})(?:\s*(AM|PM|am|pm))?$/i);
  if (!match) {
    return 15 * 60 * 1000; // 15 mins fallback
  }

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const ampm = match[3];

  if (ampm) {
    const isPm = ampm.toLowerCase() === 'pm';
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
  }

  const now = new Date();
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);

  // If target time is in the past, it means the next day (tomorrow)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  const delayMs = target.getTime() - now.getTime();
  return delayMs > 0 ? delayMs : 15 * 60 * 1000;
}

async function grokbotRunInfinite(stateFiles: string[]): Promise<void> {
  grokbotLog(`♾️ Memulai infinite generator loop untuk ${stateFiles.length} state...`);
  
  // Set initial queue showing inactive state
  grokbotQueue = stateFiles.map(sf => {
    const name = sf.replace('tiktok-state-', '').replace('.json', '');
    return { stateName: name, stateFile: sf, videoCount: 0, scheduleStart: 'Infinite Gen', scheduleEnd: 'Infinite Gen', active: false };
  });
  grokbotBroadcastQueue();

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  interface StateStockInfo {
    stateFile: string;
    stateName: string;
    grokState: string;
    cfg: any;
    pendingUtama: string[];
    pendingCadangan: string[];
    neededUtama: number;
    neededCadangan: number;
    totalStock: number;
    needsStock: boolean;
    isRateLimited: boolean;
    rateLimitDelayMs: number;
    rateLimitAvailableAt: string;
  }

  // Helper: gather stock info for all states
  const gatherStatesInfo = (): StateStockInfo[] => {
    const statesInfo: StateStockInfo[] = [];
    for (const sf of stateFiles) {
      const data = loadGrokbotData();
      const cfg = data.states[sf];
      if (!cfg) { grokbotLog(`❌ Config tidak ditemukan untuk state: ${sf}`); continue; }
      const grokState = cfg.grokState;
      if (!grokState) { grokbotLog(`❌ Grok State belum diatur untuk TikTok state ${sf}`); continue; }

      const tiktokStateName = sf.replace('tiktok-state-', '').replace('.json', '');
      const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
      const rawDir = path.join(stateDownloadDir, 'raw');
      const cadanganDir = path.join(stateDownloadDir, 'cadangan');
      if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });
      if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
      if (!fs.existsSync(cadanganDir)) fs.mkdirSync(cadanganDir, { recursive: true });

      const marksFile = path.join(stateDownloadDir, '.uploaded.json');
      let marks: Record<string, boolean> = {};
      try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      const cadanganMarksFile = path.join(cadanganDir, '.uploaded.json');
      let cadanganMarks: Record<string, boolean> = {};
      try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

      const allUtama = fs.readdirSync(stateDownloadDir).filter(f => exts.includes(path.extname(f).toLowerCase()));
      const pendingUtama = allUtama.filter(v => !marks[v]);
      const allCadangan = fs.readdirSync(cadanganDir).filter(f => exts.includes(path.extname(f).toLowerCase()));
      const pendingCadangan = allCadangan.filter(v => !cadanganMarks[v]);

      const neededUtama = Math.max(0, 30 - pendingUtama.length);
      const neededCadangan = Math.max(0, 30 - pendingCadangan.length);
      const totalStock = pendingUtama.length + pendingCadangan.length;
      const needsStock = neededUtama > 0 || neededCadangan > 0;

      let isRateLimited = false;
      let rateLimitDelayMs = 0;
      let rateLimitAvailableAt = '';
      const rateLimits = getGrokRateLimits();
      if (rateLimits[grokState]) {
        const resetStr = rateLimits[grokState].availableAt;
        const detectedAt = rateLimits[grokState].detectedAt || Date.now();
        const expiry = resetStr ? getRateLimitExpiryDate(resetStr, detectedAt) : null;
        
        if (expiry && Date.now() >= expiry.getTime()) {
          // Expiration passed, clear it
          clearGrokRateLimit(grokState);
          grokbotLog(`⚡ [${tiktokStateName}] Rate limit sudah berakhir (tersedia sejak pukul ${resetStr}). Membersihkan status rate limit.`);
        } else {
          isRateLimited = true;
          rateLimitAvailableAt = resetStr || 'tidak diketahui';
          rateLimitDelayMs = expiry ? Math.max(0, expiry.getTime() - Date.now()) : (15 * 60 * 1000);
        }
      }

      statesInfo.push({ stateFile: sf, stateName: tiktokStateName, grokState, cfg, pendingUtama, pendingCadangan, neededUtama, neededCadangan, totalStock, needsStock, isRateLimited, rateLimitDelayMs, rateLimitAvailableAt });
    }
    return statesInfo;
  };

  // Helper: select best candidate (lowest total stock; random if tied at 0)
  const selectBestCandidate = (candidates: StateStockInfo[]): StateStockInfo => {
    candidates.sort((a, b) => a.totalStock - b.totalStock);
    const lowestStock = candidates[0].totalStock;
    const tied = candidates.filter(c => c.totalStock === lowestStock);
    if (tied.length > 1 && lowestStock === 0) {
      return tied[Math.floor(Math.random() * tied.length)];
    }
    return tied[0];
  };

  // Nested helpers for generating Utama/Cadangan for a chosen targetState
  const runUtamaGen = async (targetState: StateStockInfo) => {
    const { cfg, grokState, neededUtama, pendingUtama, stateName } = targetState;
    const tiktokStateName = stateName;
    const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
    const mergeEnabled = cfg.merge !== false;

    const totalRawToGenerate = mergeEnabled ? (2 * neededUtama) : neededUtama;
    grokbotLog(`🚀 [${tiktokStateName}] Generate Stok Utama: dibutuhkan ${neededUtama} video (raw: ${totalRawToGenerate}) (Stok saat ini: ${pendingUtama.length})`);
    sendWAMessage(`🤖 [${tiktokStateName}] Mulai generate stok utama (dibutuhkan: ${neededUtama} video)...`);
    
    resetGrokbotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? neededUtama : 0, generate: 0, merge: 0 });
    grokbotBroadcastProgress();

    const grokConfig = {
      stateFile: grokState, statesDir: GROK_STATES_DIR,
      bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
      promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
      mode: cfg.mode || 'Video', resolution: cfg.resolution || '720p',
      duration: cfg.duration || '10s', aspectRatio: cfg.aspectRatio || '9:16',
      headless: isHeadlessEnabled(`tiktok-state-${tiktokStateName}.json`), downloadDir: GROK_DOWNLOAD_DIR,
      customDownloadDir: stateDownloadDir, totalVideos: totalRawToGenerate,
      merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
      parallelBrowsers: loadGrokbotData().globalConfig?.parallelBrowsers || 1,
    };

    const poll = setInterval(() => {
      if (!grokbotRunning) { clearInterval(poll); return; }
      const stats = getGrokStats();
      const progressList = getBrowserProgress();
      const doneCount = stats.success + stats.failed;
      let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
      let activeCount = 0; let activeProgSum = 0;
      progressList.forEach(bp => { if (bp.status === 'running') { activeCount++; activeProgSum += bp.progress; } });
      if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
      grokbotProgress.generate = Math.min(99, overallGen);
      if (mergeEnabled) {
        grokbotProgress.mergedCount = stats.saved;
        grokbotProgress.mergeTotal = neededUtama;
        grokbotProgress.merge = Math.min(99, Math.round((stats.saved / neededUtama) * 100));
      } else { grokbotProgress.merge = 100; }
      grokbotBroadcastProgress();
    }, 2000);

    try {
      await runGrokGenerator(grokConfig as any, grokbotLog, __dirname);
      clearInterval(poll);
      grokbotProgress.generate = 100; grokbotProgress.merge = 100; grokbotBroadcastProgress();
      grokbotLog(`✓ Stok Utama untuk ${tiktokStateName} berhasil ditambahkan!`);
      sendWAMessage(`🤖 [${tiktokStateName}] Selesai generate stok utama!`);
    } catch (err: any) {
      clearInterval(poll);
      grokbotLog(`❌ Gagal generate Utama untuk ${tiktokStateName}: ${err.message}`);
      sendWAMessage(`❌ [${tiktokStateName}] Gagal generate Utama: ${err.message}`);
    }
  };

  const runCadanganGen = async (targetState: StateStockInfo) => {
    const { cfg, grokState, neededCadangan, pendingCadangan, stateName } = targetState;
    const tiktokStateName = stateName;
    const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
    const cadanganDir = path.join(stateDownloadDir, 'cadangan');
    const mergeEnabled = cfg.merge !== false;

    const totalRawToGenerate = mergeEnabled ? (2 * neededCadangan) : neededCadangan;
    grokbotLog(`🚀 [${tiktokStateName}] Generate Stok Cadangan: dibutuhkan ${neededCadangan} video (raw: ${totalRawToGenerate}) (Stok saat ini: ${pendingCadangan.length})`);
    sendWAMessage(`🤖 [${tiktokStateName}] Mulai generate stok cadangan (dibutuhkan: ${neededCadangan} video)...`);
    
    resetGrokbotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? neededCadangan : 0, generate: 0, merge: 0 });
    grokbotBroadcastProgress();

    const grokConfig = {
      stateFile: grokState, statesDir: GROK_STATES_DIR,
      bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
      promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
      mode: cfg.mode || 'Video', resolution: cfg.resolution || '720p',
      duration: cfg.duration || '10s', aspectRatio: cfg.aspectRatio || '9:16',
      headless: isHeadlessEnabled(`tiktok-state-${tiktokStateName}.json`), downloadDir: GROK_DOWNLOAD_DIR,
      customDownloadDir: cadanganDir, totalVideos: totalRawToGenerate,
      merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
      parallelBrowsers: loadGrokbotData().globalConfig?.parallelBrowsers || 1,
    };

    const poll = setInterval(() => {
      if (!grokbotRunning) { clearInterval(poll); return; }
      const stats = getGrokStats();
      const progressList = getBrowserProgress();
      const doneCount = stats.success + stats.failed;
      let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
      let activeCount = 0; let activeProgSum = 0;
      progressList.forEach(bp => { if (bp.status === 'running') { activeCount++; activeProgSum += bp.progress; } });
      if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
      grokbotProgress.generate = Math.min(99, overallGen);
      if (mergeEnabled) {
        grokbotProgress.mergedCount = stats.saved;
        grokbotProgress.mergeTotal = neededCadangan;
        grokbotProgress.merge = Math.min(99, Math.round((stats.saved / neededCadangan) * 100));
      } else { grokbotProgress.merge = 100; }
      grokbotBroadcastProgress();
    }, 2000);

    try {
      await runGrokGenerator(grokConfig as any, grokbotLog, __dirname);
      clearInterval(poll);
      grokbotProgress.generate = 100; grokbotProgress.merge = 100; grokbotBroadcastProgress();
      grokbotLog(`✓ Stok Cadangan untuk ${tiktokStateName} berhasil ditambahkan!`);
      sendWAMessage(`🤖 [${tiktokStateName}] Selesai generate stok cadangan!`);
    } catch (err: any) {
      clearInterval(poll);
      grokbotLog(`❌ Gagal generate Cadangan untuk ${tiktokStateName}: ${err.message}`);
      sendWAMessage(`❌ [${tiktokStateName}] Gagal generate Cadangan: ${err.message}`);
    }
  };

  // Helper: run generation for a target state
  const runGenerationForState = async (targetState: StateStockInfo) => {
    // Set grokbotRunning ONLY during active generation
    grokbotRunning = true;

    // Highlight active state in queue UI
    grokbotQueue = grokbotQueue.map(q => ({ ...q, active: q.stateFile === targetState.stateFile }));
    grokbotBroadcastQueue();

    clearGrokRateLimit(targetState.grokState);

    if (targetState.pendingUtama.length <= targetState.pendingCadangan.length) {
      if (targetState.neededUtama > 0) await runUtamaGen(targetState);
      if (infiniteGenRunning && !getGrokRateLimits()[targetState.grokState]) {
        if (targetState.neededCadangan > 0) await runCadanganGen(targetState);
      }
    } else {
      if (targetState.neededCadangan > 0) await runCadanganGen(targetState);
      if (infiniteGenRunning && !getGrokRateLimits()[targetState.grokState]) {
        if (targetState.neededUtama > 0) await runUtamaGen(targetState);
      }
    }

    // Release grokbotRunning after generation phase
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
  };

  // ══════════════════════════════════════════════
  // MAIN INFINITE LOOP
  // ══════════════════════════════════════════════
  while (infiniteGenRunning) {
    // 1. Gather fresh state info
    const statesInfo = gatherStatesInfo();
    if (!infiniteGenRunning) break;

    // 2. Update queue UI
    grokbotQueue = stateFiles.map(sf => {
      const name = sf.replace('tiktok-state-', '').replace('.json', '');
      const info = statesInfo.find(s => s.stateFile === sf);
      return { stateName: name, stateFile: sf, videoCount: info ? info.totalStock : 0, scheduleStart: 'Infinite Gen', scheduleEnd: 'Infinite Gen', active: false };
    });
    grokbotBroadcastQueue();

    // 3. Filter candidates that need stock
    const candidates = statesInfo.filter(s => s.needsStock);

    // 4. If all stocked up, sleep 30s
    if (candidates.length === 0) {
      grokbotLog(`✨ Semua state sudah memiliki stok penuh. Tidur 30 detik...`);
      let slept = 0;
      while (slept < 30000 && infiniteGenRunning) { await new Promise(r => setTimeout(r, 2000)); slept += 2000; }
      continue;
    }

    // 5. Separate non-rate-limited vs rate-limited
    const nonRateLimited = candidates.filter(c => !c.isRateLimited);
    const rateLimitedCandidates = candidates.filter(c => c.isRateLimited);

    if (nonRateLimited.length > 0) {
      // 6A. Pick the best non-rate-limited candidate
      const targetState = selectBestCandidate(nonRateLimited);
      grokbotLog(`🎯 State terpilih: ${targetState.stateName} (utama: ${targetState.pendingUtama.length}, cadangan: ${targetState.pendingCadangan.length})`);
      sendWAMessage(`🤖 State ${targetState.stateName} stok paling sedikit (utama: ${targetState.pendingUtama.length}, cadangan: ${targetState.pendingCadangan.length}). Memulai generate...`);

      await runGenerationForState(targetState);
    } else {
      // 6B. ALL candidates are rate-limited — smart wait
      const sortedByDelay = [...rateLimitedCandidates].sort((a, b) => a.rateLimitDelayMs - b.rateLimitDelayMs);
      const nextAvailable = sortedByDelay[0];
      const delayMs = nextAvailable.rateLimitDelayMs;
      const resumeDelayMs = delayMs + 60000; // +1 minute buffer

      // Select which state to generate for when rate limit expires
      const targetStateForGen = selectBestCandidate(rateLimitedCandidates);

      const rateLimitTime = nextAvailable.rateLimitAvailableAt;
      const resumeDate = new Date(Date.now() + resumeDelayMs);
      const resumeTimeStr = `${String(resumeDate.getHours()).padStart(2, '0')}:${String(resumeDate.getMinutes()).padStart(2, '0')}`;

      grokbotLog(`🚫 Semua akun Grok rate limited!`);
      for (const r of rateLimitedCandidates) {
        grokbotLog(` - [${r.stateName}] Rate Limit aktif! Tersedia kembali pukul: ${r.rateLimitAvailableAt}`);
      }
      grokbotLog(`⏳ Rate limit paling cepat selesai: ${rateLimitTime}`);
      grokbotLog(`🔄 Akan mulai generate lagi pukul: ${resumeTimeStr}`);
      grokbotLog(`🎯 Akun yang akan diisi stoknya: ${targetStateForGen.stateName} (utama: ${targetStateForGen.pendingUtama.length}, cadangan: ${targetStateForGen.pendingCadangan.length})`);

      // Send detailed WhatsApp notification
      let waMsg = `🚫 Semua akun Grok rate limited!\n`;
      waMsg += `⏰ Rate limit paling cepat selesai: ${rateLimitTime}\n`;
      waMsg += `🔄 Akan mulai generate lagi: ${resumeTimeStr}\n`;
      waMsg += `🎯 Akun yang akan diisi stoknya: ${targetStateForGen.stateName} (utama: ${targetStateForGen.pendingUtama.length}, cadangan: ${targetStateForGen.pendingCadangan.length})`;
      sendWAMessage(waMsg);

      // Broadcast waiting status via SSE
      infiniteGenWaitInfo = { rateLimitTime, resumeTime: resumeTimeStr, targetState: targetStateForGen.stateName };
      grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:${JSON.stringify(infiniteGenWaitInfo)}\n\n`));

      // Interruptible sleep until resume time
      const sleepInterval = 2000;
      let elapsed = 0;
      while (elapsed < resumeDelayMs && infiniteGenRunning) {
        await new Promise(r => setTimeout(r, Math.min(sleepInterval, resumeDelayMs - elapsed)));
        elapsed += sleepInterval;

        // Check if any rate limit was cleared manually
        const rateLimitsAfter = getGrokRateLimits();
        let cleared = false;
        for (const r of rateLimitedCandidates) {
          if (!rateLimitsAfter[r.grokState]) {
            grokbotLog(`⚡ [${r.stateName}] Rate limit di-reset! Melanjutkan proses...`);
            cleared = true;
            break;
          }
        }
        if (cleared) break;
      }

      infiniteGenWaitInfo = null;
      grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:null\n\n`));

      if (!infiniteGenRunning) break;

      // Re-gather fresh info after sleep (stocks/rate limits may have changed)
      const freshInfo = gatherStatesInfo();
      const freshCandidates = freshInfo.filter(s => s.needsStock && !s.isRateLimited);

      if (freshCandidates.length > 0) {
        const freshTarget = selectBestCandidate(freshCandidates);
        grokbotLog(`▶️ Waktu tunggu selesai. Memulai generate untuk state: ${freshTarget.stateName}`);
        sendWAMessage(`▶️ State ${freshTarget.stateName} memulai generate Grok.`);
        await runGenerationForState(freshTarget);
      } else {
        grokbotLog(`⏳ Semua akun masih rate limited setelah waktu tunggu. Loop kembali...`);
      }
    }
  }
}

app.post('/api/grokbot/infinite-generate', async (req, res) => {
  if (infiniteGenRunning) return res.status(400).json({ success: false, error: 'Infinite Generate sudah berjalan!' });
  if (grokbotRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  infiniteGenRunning = true;
  // grokbotRunning is NOT set here — it will be set only during active generation phases
  grokbotQueue = [];

  // Pre-check: gather rate limit info and send initial WA notification
  const rateLimits = getGrokRateLimits();
  const rateLimitEntries = Object.entries(rateLimits);
  let initMsg = `♾️ Infinite Generate dimulai! (${stateFiles.length} state)\n`;
  if (rateLimitEntries.length > 0) {
    initMsg += `\n🚫 Rate Limit terdeteksi:\n`;
    for (const [key, val] of rateLimitEntries) {
      const name = key.replace('grok-state-', '').replace('.json', '');
      initMsg += `- ${name}: tersedia pukul ${(val as any).availableAt || 'tidak diketahui'}\n`;
    }
  } else {
    initMsg += `✅ Tidak ada rate limit aktif. Generate segera dimulai.`;
  }
  sendWAMessage(initMsg);

  res.json({ success: true, message: 'Infinite Generate dimulai' });

  try {
    await grokbotRunInfinite(stateFiles);
  } catch (e: any) {
    grokbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    infiniteGenRunning = false;
    infiniteGenWaitInfo = null;
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:null\n\n`));
    grokbotLog('===== INFINITE GENERATE FINISHED =====');
    sendWAMessage("♾️ Infinite Generate selesai!");
  }
});

app.get('/api/grokbot/status', (req, res) => {
  res.json({ running: grokbotRunning, infiniteGenRunning, infiniteGenWaitInfo, grokbotFullAutoRunning, queue: grokbotQueue, progress: grokbotProgress, rateLimits: getGrokRateLimits() });
});

app.post('/api/grokbot/stop', async (req, res) => {
  infiniteGenRunning = false;
  infiniteGenWaitInfo = null;
  grokbotFullAutoRunning = false;
  grokbotRunning = false;
  resetGrokbotProgress();
  grokbotBroadcastProgress();
  grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:null\n\n`));
  await stopGrokGenerator();
  await stopUploader();
  grokbotLog('⛔ ===== GROKBOT STOPPED =====');
  res.json({ success: true });
});

app.post('/api/grokbot/stop-full-auto', (req, res) => {
  grokbotFullAutoRunning = false;
  grokbotLog('⛔ ===== FULL AUTO STANDBY STOPPED =====');
  res.json({ success: true });
});

app.post('/api/grokbot/stop-infinite-generate', async (req, res) => {
  infiniteGenRunning = false;
  infiniteGenWaitInfo = null;
  grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:null\n\n`));
  await stopGrokGenerator();
  grokbotLog('⛔ ===== INFINITE GENERATE STOPPED =====');
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


// ═══════════════════════════════════════════════════════════
//  GROKBOT V2 CONSTANTS & PERSISTENCE
// ═══════════════════════════════════════════════════════════
const GROKBOTV2_DATA_FILE = path.join(__dirname, 'grokbotv2-data.json');

interface GrokbotV2Data {
  states: Record<string, GrokbotStateConfig>;
  globalConfig?: {
    parallelBrowsers?: number;
    headless?: boolean;
    sendWhatsApp?: boolean;
    fullAuto?: {
      enableCustomScheduler?: boolean;
      customIntervalHours?: number;
      customUploadCount?: number;
      headless?: boolean;
    };
  };
}

function loadGrokbotV2Data(): GrokbotV2Data {
  try {
    return JSON.parse(fs.readFileSync(GROKBOTV2_DATA_FILE, 'utf-8'));
  } catch {
    return { states: {} };
  }
}

function saveGrokbotV2Data(data: GrokbotV2Data) {
  fs.writeFileSync(GROKBOTV2_DATA_FILE, JSON.stringify(data, null, 2));
}

function isHeadlessEnabledV2(stateFile?: string): boolean {
  const data = loadGrokbotV2Data();
  if (data.globalConfig && data.globalConfig.headless === false) {
    return false;
  }
  if (stateFile && data.states && data.states[stateFile] && data.states[stateFile].headless === false) {
    return false;
  }
  return data.globalConfig?.headless !== false;
}

// Global state for Grokbot V2 SSE & Orchestration
const grokbotv2SseClients: Response[] = [];
let grokbotv2Running = false;
let infiniteGenV2Running = false;
let grokbotv2FullAutoRunning = false;
let infiniteGenV2WaitInfo: { rateLimitTime: string; resumeTime: string; targetState: string } | null = null;
let grokbotv2Queue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let grokbotv2Progress: {
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

function grokbotv2Log(msg: string) {
  console.log(`[GROKBOTV2] ${msg}`);
  grokbotv2SseClients.forEach(c => c.write(`data: ${msg}

`));
}

// Wrapper WA untuk V2 — membaca sendWhatsApp dari grokbotv2-data.json
function sendWAMessageV2(msg: string) {
  const data = loadGrokbotV2Data();
  if (data.globalConfig?.sendWhatsApp === true) {
    originalSendWAMessage(msg);
  }
}

function grokbotv2BroadcastQueue() {
  grokbotv2SseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(grokbotv2Queue)}

`));
}

function grokbotv2BroadcastProgress() {
  grokbotv2Progress.browsers = getBrowserProgress();
  const progressWithRateLimits = {
    ...grokbotv2Progress,
    rateLimits: getGrokRateLimits()
  };
  grokbotv2SseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(progressWithRateLimits)}

`));
}

function resetGrokbotv2Progress(overrides: Partial<typeof grokbotv2Progress> = {}) {
  grokbotv2Progress = {
    generate: 0, merge: 0, upload: 0, currentState: '',
    browsers: [], uploadedCount: 0, uploadTotal: 0,
    mergedCount: 0, mergeTotal: 0,
    ...overrides
  };
}

// ── GROKBOT V2 GENERATOR FUNCTION USING generateGrokVideoV2 ──
async function runGrokGeneratorV2(config: {
  stateFile: string;
  grokState: string;
  bahanFolder: string;
  promptFile: string;
  mode: string;
  resolution: string;
  duration: string;
  aspectRatio: string;
  headless: boolean;
  totalVideos: number;
  merge?: boolean;
  audioFolder?: string;
}, log: (msg: string) => void): Promise<void> {
  const grokStateName = (config.grokState || 'indra').replace('grok-state-', '').replace('.json', '');
  const tiktokStateName = config.stateFile.replace('tiktok-state-', '').replace('.json', '');
  const targetDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(targetDir, 'raw');

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  if (config.merge && !fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

  const mergeEnabled = config.merge !== false;
  const totalRawToGenerate = mergeEnabled ? config.totalVideos * 2 : config.totalVideos;

  log(`🚀 [GROK_V2_GENERATOR] Memulai generasi ${config.totalVideos} video (${totalRawToGenerate} raw) untuk TikTok State ${tiktokStateName} (Grok Account: ${grokStateName})...`);

  // Load Prompt File
  let promptText = 'A stunning video sequence';
  if (config.promptFile) {
    const promptPath = path.join(PROMPT_DIR, config.promptFile);
    if (fs.existsSync(promptPath)) {
      try {
        const pData = JSON.parse(fs.readFileSync(promptPath, 'utf-8'));
        promptText = pData.prompt || (Array.isArray(pData.prompts) ? pData.prompts[0] : promptText);
      } catch {}
    }
  }

  // Load Bahan Image List
  let bahanImages: string[] = [];
  if (config.bahanFolder) {
    const folderPath = path.join(BAHAN_DIR, config.bahanFolder);
    if (fs.existsSync(folderPath)) {
      const exts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
      try {
        bahanImages = fs.readdirSync(folderPath).filter(f => exts.includes(path.extname(f).toLowerCase()));
      } catch {}
    }
  }

  for (let i = 0; i < totalRawToGenerate; i++) {
    if (!grokbotv2Running && !infiniteGenV2Running && !grokbotv2FullAutoRunning) {
      log(`⛔ Generasi V2 dihentikan pengguna.`);
      break;
    }

    let imagePath: string | undefined = undefined;
    if (bahanImages.length > 0) {
      const pickedImg = bahanImages[i % bahanImages.length];
      imagePath = path.join(BAHAN_DIR, config.bahanFolder, pickedImg);
    }

    log(`🎬 [GROK_V2] Memulai generate raw #${i + 1}/${totalRawToGenerate} via Grok V2 API...`);

    try {
      const res = await generateGrokVideoV2({
        stateName: grokStateName,
        promptText,
        imagePath,
        resolution: config.resolution || '720p',
        duration: config.duration || '10s',
        aspectRatio: config.aspectRatio || '9:16',
        mode: config.mode || 'Video',
        headless: config.headless ?? true
      }, (msg, pct) => {
        const overallGen = Math.round(((i + (pct / 100)) / totalRawToGenerate) * 100);
        grokbotv2Progress.generate = Math.min(99, overallGen);
        grokbotv2BroadcastProgress();
      });

      if (res && res.savePath && fs.existsSync(res.savePath)) {
        const destDir = mergeEnabled ? rawDir : targetDir;
        const newFilename = mergeEnabled
          ? `grok_raw_${Date.now()}_${i + 1}.mp4`
          : `grok_${Date.now()}_${i + 1}.mp4`;
        const finalPath = path.join(destDir, newFilename);

        fs.copyFileSync(res.savePath, finalPath);
        try { fs.unlinkSync(res.savePath); } catch {}

        log(`✓ [GROK_V2] Raw video #${i + 1} tersimpan ke: ${newFilename}`);

        grokbotv2Progress.generate = Math.round(((i + 1) / totalRawToGenerate) * 100);
        grokbotv2BroadcastProgress();

        if (mergeEnabled) {
          const rawFiles = fs.readdirSync(rawDir).filter(f => f.endsWith('.mp4')).sort();
          if (rawFiles.length >= 2) {
            log(`[MERGER_V2] Menggabungkan 2 raw video...`);
            const v1 = path.join(rawDir, rawFiles[0]);
            const v2 = path.join(rawDir, rawFiles[1]);

            let audioPath: string | undefined = undefined;
            if (config.audioFolder) {
              const audioDir = path.join(__dirname, 'audio', config.audioFolder);
              if (fs.existsSync(audioDir)) {
                const aFiles = fs.readdirSync(audioDir).filter(f => ['.mp3', '.wav'].includes(path.extname(f).toLowerCase()));
                if (aFiles.length > 0) {
                  audioPath = path.join(audioDir, aFiles[Math.floor(Math.random() * aFiles.length)]);
                }
              }
            }

            const mergedFilename = `grok_merged_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
            const mergedOutputPath = path.join(targetDir, mergedFilename);

            try {
              await mergeVideosCopyWithOptionalAudio([v1, v2], mergedOutputPath, audioPath, { tempDir: path.join(__dirname, '_tmp_uploads') });
              log(`[MERGER_V2] ✅ Berhasil merge ke ${mergedFilename}`);
              try { fs.unlinkSync(v1); } catch {}
              try { fs.unlinkSync(v2); } catch {}
              grokbotv2Progress.mergedCount = (grokbotv2Progress.mergedCount || 0) + 1;
              grokbotv2Progress.merge = Math.min(99, Math.round((grokbotv2Progress.mergedCount / config.totalVideos) * 100));
              grokbotv2BroadcastProgress();
            } catch (mergeErr: any) {
              log(`[MERGER_V2] ❌ Error merge: ${mergeErr.message}`);
            }
          }
        }
      } else {
        log(`❌ [GROK_V2] Gagal generate raw #${i + 1}`);
      }
    } catch (err: any) {
      if (err instanceof RateLimitError || err.name === 'RateLimitError') {
        // ── Deteksi Rate Limit: catat ke shared grokRateLimits dan hentikan loop ──
        const grokStateKey = config.grokState || 'indra';
        const availableAt = (err as any).availableAt || null;
        setGrokRateLimit(grokStateKey, availableAt);
        log(`🚫 [GROK_V2 RATE LIMIT] Akun "${grokStateKey}" terkena rate limit! Tersedia kembali: ${availableAt || 'tidak diketahui'}`);
        log(`⏹️ Menghentikan loop generate V2 karena rate limit...`);
        sendWAMessageV2(`🚫 [GrokbotV2] Rate limit! Akun "${grokStateKey}" terkena limit.${availableAt ? ' Tersedia kembali: ' + availableAt : ''}`);
        grokbotv2BroadcastProgress(); // broadcast agar UI langsung update
        break;
      }
      log(`❌ [GROK_V2 ERROR] ${err.message}`);
    }
  }

  grokbotv2Progress.generate = 100;
  grokbotv2Progress.merge = 100;
  grokbotv2BroadcastProgress();
  log(`✅ [GROK_V2_GENERATOR] Selesai memproses generasi video V2 untuk ${tiktokStateName}`);
}

// ── GROKBOT V2 API ROUTES ──
app.get('/grokbotv2', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grokbotv2.html'));
});

app.get('/api/grokbotv2/config', (req, res) => {
  res.json(loadGrokbotV2Data());
});

app.post('/api/grokbotv2/config/save', (req, res) => {
  const { stateFile, grokState, promptFile, bahanFolder, mode, resolution, duration, aspectRatio, merge, audioFolder, description, hashtags, scheduleDate, scheduleTime, intervalMinutes, addProduct, productNameRadio, productTitle, productDescription, headless, threeUploadsPerHour, lastUploadDate, lastUploadTime } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadGrokbotV2Data();
  if (!data.states[stateFile]) {
    data.states[stateFile] = {
      grokState: '', promptFile: '', bahanFolder: '', mode: 'Video',
      resolution: '720p', duration: '10s', aspectRatio: '9:16', merge: true,
      audioFolder: '', description: '', hashtags: '', scheduleDate: '',
      scheduleTime: '', intervalMinutes: 60,
      addProduct: false, productNameRadio: '', productTitle: '', productDescription: '',
      headless: true, threeUploadsPerHour: false, lastUploadDate: '', lastUploadTime: ''
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
  if (merge !== undefined) s.merge = merge;
  if (audioFolder !== undefined) s.audioFolder = audioFolder;
  if (description !== undefined) s.description = description;
  if (hashtags !== undefined) s.hashtags = hashtags;
  if (scheduleDate !== undefined) s.scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) s.scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) s.intervalMinutes = intervalMinutes;
  if (addProduct !== undefined) s.addProduct = addProduct;
  if (productNameRadio !== undefined) s.productNameRadio = productNameRadio;
  if (productTitle !== undefined) s.productTitle = productTitle;
  if (productDescription !== undefined) s.productDescription = productDescription;
  if (headless !== undefined) s.headless = headless;
  if (threeUploadsPerHour !== undefined) s.threeUploadsPerHour = threeUploadsPerHour;
  if (lastUploadDate !== undefined) s.lastUploadDate = lastUploadDate;
  if (lastUploadTime !== undefined) s.lastUploadTime = lastUploadTime;
  saveGrokbotV2Data(data);
  res.json({ success: true });
});

app.post('/api/grokbotv2/global-config/save', (req, res) => {
  const { headless, sendWhatsApp } = req.body;
  const data = loadGrokbotV2Data();
  if (!data.globalConfig) data.globalConfig = {};
  if (headless !== undefined) data.globalConfig.headless = headless;
  if (sendWhatsApp !== undefined) data.globalConfig.sendWhatsApp = sendWhatsApp;
  saveGrokbotV2Data(data);
  res.json({ success: true });
});

app.post('/api/grokbotv2/full-auto-settings/save', (req, res) => {
  const { enableCustomScheduler, customIntervalHours, customUploadCount } = req.body;
  const data = loadGrokbotV2Data();
  if (!data.globalConfig) data.globalConfig = {};
  if (!data.globalConfig.fullAuto) data.globalConfig.fullAuto = {};
  if (enableCustomScheduler !== undefined) data.globalConfig.fullAuto.enableCustomScheduler = enableCustomScheduler;
  if (customIntervalHours !== undefined) data.globalConfig.fullAuto.customIntervalHours = customIntervalHours;
  if (customUploadCount !== undefined) data.globalConfig.fullAuto.customUploadCount = customUploadCount;
  saveGrokbotV2Data(data);
  res.json({ success: true });
});

app.get('/api/grokbotv2/stock', (req, res) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ raw: 0, utama: 0, cadangan: 0 });
  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
  const rawDir = path.join(stateDir, 'raw');
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  let rawCount = 0;
  if (fs.existsSync(rawDir)) {
    try { rawCount = fs.readdirSync(rawDir).filter(f => exts.includes(path.extname(f).toLowerCase())).length; } catch {}
  }

  let mergedFiles: string[] = [];
  if (fs.existsSync(stateDir)) {
    try { mergedFiles = fs.readdirSync(stateDir).filter(f => f.startsWith('grok_merged_') && exts.includes(path.extname(f).toLowerCase())); } catch {}
  }

  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const unuploaded = mergedFiles.filter(f => !marks[f]);
  res.json({ raw: rawCount, utama: unuploaded.length, cadangan: 0 });
});

app.post('/api/grokbotv2/generate-utama', async (req, res) => {
  if (grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning) return res.status(400).json({ error: 'Grokbot V2 sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotV2Data();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  let pendingCount = 0;
  if (fs.existsSync(stateDir)) {
    try { pendingCount = fs.readdirSync(stateDir).filter(f => f.startsWith('grok_merged_') && exts.includes(path.extname(f).toLowerCase()) && !marks[f]).length; } catch {}
  }

  const needed = Math.max(1, 30 - pendingCount);

  res.json({ success: true, message: `Generasi Stok Utama V2 dimulai untuk ${tiktokStateName} (butuh ${needed} video)` });

  grokbotv2Running = true;
  grokbotv2Queue = [{ stateName: tiktokStateName, stateFile, videoCount: needed, scheduleStart: 'Utama Gen V2', scheduleEnd: 'Utama Gen V2', active: true }];
  grokbotv2BroadcastQueue();
  resetGrokbotv2Progress({ currentState: tiktokStateName, mergeTotal: cfg.merge !== false ? needed : 0 });
  grokbotv2BroadcastProgress();

  grokbotv2Log(`🚀 Memulai Generate Stok Utama V2 untuk ${tiktokStateName}. Dibutuhkan: ${needed} video`);
  sendWAMessageV2(`🚀 [GrokbotV2] Generate Stok Utama dimulai untuk ${tiktokStateName}. Dibutuhkan: ${needed} video.`);

  try {
    await runGrokGeneratorV2({
      stateFile,
      grokState: cfg.grokState,
      bahanFolder: cfg.bahanFolder,
      promptFile: cfg.promptFile,
      mode: cfg.mode || 'Video',
      resolution: cfg.resolution || '720p',
      duration: cfg.duration || '10s',
      aspectRatio: cfg.aspectRatio || '9:16',
      headless: isHeadlessEnabledV2(stateFile),
      totalVideos: needed,
      merge: cfg.merge,
      audioFolder: cfg.audioFolder
    }, grokbotv2Log);
    grokbotv2Log('===== GENERATE UTAMA V2 FINISHED =====');
    sendWAMessageV2(`✅ [GrokbotV2] Generate Stok Utama selesai untuk ${tiktokStateName}.`);
  } catch (e: any) {
    grokbotv2Log('❌ Fatal Utama Gen V2: ' + e.message);
    sendWAMessageV2(`❌ [GrokbotV2] Fatal error Generate Utama ${tiktokStateName}: ${e.message}`);
  } finally {
    grokbotv2Running = false;
    grokbotv2Queue = [];
    grokbotv2BroadcastQueue();
  }
});

app.post('/api/grokbotv2/generate-cadangan', async (req, res) => {
  if (grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning) return res.status(400).json({ error: 'Grokbot V2 sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotV2Data();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');

  res.json({ success: true, message: `Generasi Stok Cadangan V2 dimulai untuk ${tiktokStateName}` });

  grokbotv2Running = true;
  grokbotv2Queue = [{ stateName: tiktokStateName, stateFile, videoCount: 30, scheduleStart: 'Cadangan Gen V2', scheduleEnd: 'Cadangan Gen V2', active: true }];
  grokbotv2BroadcastQueue();
  resetGrokbotv2Progress({ currentState: tiktokStateName, mergeTotal: 30 });
  grokbotv2BroadcastProgress();

  grokbotv2Log(`🚀 Memulai Generate Stok Cadangan V2 (30 video) untuk ${tiktokStateName}`);
  sendWAMessageV2(`🚀 [GrokbotV2] Generate Stok Cadangan dimulai untuk ${tiktokStateName} (30 video).`);

  try {
    await runGrokGeneratorV2({
      stateFile,
      grokState: cfg.grokState,
      bahanFolder: cfg.bahanFolder,
      promptFile: cfg.promptFile,
      mode: cfg.mode || 'Video',
      resolution: cfg.resolution || '720p',
      duration: cfg.duration || '10s',
      aspectRatio: cfg.aspectRatio || '9:16',
      headless: isHeadlessEnabledV2(stateFile),
      totalVideos: 30,
      merge: cfg.merge,
      audioFolder: cfg.audioFolder
    }, grokbotv2Log);
    grokbotv2Log('===== GENERATE CADANGAN V2 FINISHED =====');
    sendWAMessageV2(`✅ [GrokbotV2] Generate Stok Cadangan selesai untuk ${tiktokStateName}.`);
  } catch (e: any) {
    grokbotv2Log('❌ Fatal Cadangan Gen V2: ' + e.message);
    sendWAMessageV2(`❌ [GrokbotV2] Fatal error Generate Cadangan ${tiktokStateName}: ${e.message}`);
  } finally {
    grokbotv2Running = false;
    grokbotv2Queue = [];
    grokbotv2BroadcastQueue();
  }
});

app.post('/api/grokbotv2/schedule-only', async (req, res) => {
  if (grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot V2 sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotV2Data();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  let allVideos = fs.readdirSync(stateDir).filter(f => exts.includes(path.extname(f).toLowerCase())).sort();
  let pendingVideos = allVideos.filter(v => !marks[v]);

  if (pendingVideos.length === 0) {
    return res.status(400).json({ success: false, error: 'Tidak ada video pending untuk diupload' });
  }

  res.json({ success: true, message: `Upload dimulai untuk ${pendingVideos.length} video` });

  grokbotv2Running = true;
  const batch = pendingVideos.slice(0, 30);
  const schedDate = cfg.scheduleDate || new Date().toISOString().split('T')[0];
  const schedTime = cfg.scheduleTime || new Date().toTimeString().slice(0, 5);

  grokbotv2Log(`🚀 [${tiktokStateName}] Jadwalkan Saja V2 dimulai (${batch.length} video)`);
  sendWAMessageV2(`🚀 [GrokbotV2] Jadwalkan Saja dimulai untuk ${tiktokStateName} (${batch.length} video).`);

  const uploadConfig = {
    videoFolder: stateDir,
    startFromVideo: batch[0],
    description: cfg.description || '',
    hashtags: cfg.hashtags || '',
    addProduct: !!cfg.addProduct,
    productNameRadio: cfg.productNameRadio || '',
    productTitle: cfg.productTitle || '',
    productDescription: cfg.productDescription || '',
    skipSwitches: true,
    headless: isHeadlessEnabledV2(stateFile),
    scheduleDate: schedDate,
    scheduleTime: schedTime,
    intervalMinutes: cfg.threeUploadsPerHour ? 300 : (cfg.intervalMinutes || 60),
    stateFile: stateFile,
    statesDir: STATES_DIR,
    randomizeIntervalSchedule: true
  };

  let uploadedCount = 0;
  const onVideoUploaded = (videoFilename: string) => {
    let m: Record<string, boolean> = {};
    try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
    m[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
    grokbotv2Log(`✅ [${tiktokStateName}] ${videoFilename} terupload`);

    const videoPath = path.join(stateDir, videoFilename);
    if (fs.existsSync(videoPath)) {
      try { fs.unlinkSync(videoPath); } catch {}
    }

    uploadedCount++;
    grokbotv2Progress.uploadedCount = uploadedCount;
    grokbotv2Progress.uploadTotal = batch.length;
    grokbotv2Progress.upload = Math.round((uploadedCount / batch.length) * 100);
    grokbotv2BroadcastProgress();
  };

  try {
    await runUpload(uploadConfig, grokbotv2Log, onVideoUploaded, items => {
      sendWAMessageV2(buildScheduleListMessage(tiktokStateName, items));
    });
    sendWAMessageV2(`✅ [GrokbotV2] Jadwalkan Saja selesai untuk ${tiktokStateName}. Total terupload: ${uploadedCount} video.`);
  } catch (err: any) {
    grokbotv2Log(`❌ Upload error: ${err.message}`);
    sendWAMessageV2(`❌ [GrokbotV2] Error upload ${tiktokStateName}: ${err.message}`);
  } finally {
    grokbotv2Running = false;
    resetGrokbotv2Progress();
    grokbotv2BroadcastProgress();
    grokbotv2Queue = [];
    grokbotv2BroadcastQueue();
    grokbotv2Log('===== JADWALKAN SAJA V2 FINISHED =====');
  }
});

app.post('/api/grokbotv2/status', (req, res) => {
  const data = loadGrokbotV2Data();
  res.json({ running: grokbotv2Running, infiniteGenRunning: infiniteGenV2Running, infiniteGenWaitInfo: infiniteGenV2WaitInfo, grokbotFullAutoRunning: grokbotv2FullAutoRunning, queue: grokbotv2Queue, progress: grokbotv2Progress, rateLimits: getGrokRateLimits(), globalConfig: data.globalConfig || {} });
});

app.get('/api/grokbotv2/status', (req, res) => {
  const data = loadGrokbotV2Data();
  res.json({ running: grokbotv2Running, infiniteGenRunning: infiniteGenV2Running, infiniteGenWaitInfo: infiniteGenV2WaitInfo, grokbotFullAutoRunning: grokbotv2FullAutoRunning, queue: grokbotv2Queue, progress: grokbotv2Progress, rateLimits: getGrokRateLimits(), globalConfig: data.globalConfig || {} });
});

app.post('/api/grokbotv2/stop', async (req, res) => {
  grokbotv2FullAutoRunning = false;
  grokbotv2Running = false;
  infiniteGenV2Running = false;
  resetGrokbotv2Progress();
  grokbotv2BroadcastProgress();
  grokbotv2Log('⛔ ===== GROKBOT V2 STOPPED =====');
  res.json({ success: true });
});

app.post('/api/grokbotv2/stop-full-auto', (req, res) => {
  grokbotv2FullAutoRunning = false;
  grokbotv2Log('⛔ ===== FULL AUTO V2 STANDBY STOPPED =====');
  res.json({ success: true });
});

app.post('/api/grokbotv2/stop-infinite-generate', async (req, res) => {
  infiniteGenV2Running = false;
  grokbotv2Log('⛔ ===== INFINITE GENERATE V2 STOPPED =====');
  res.json({ success: true });
});

app.get('/api/grokbotv2/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  grokbotv2SseClients.push(res);
  req.on('close', () => {
    const idx = grokbotv2SseClients.indexOf(res);
    if (idx >= 0) grokbotv2SseClients.splice(idx, 1);
  });
});


// ═══════════════════════════════════════════════════════════
//  LEONARDO AI INTEGRATION APIs
// ═══════════════════════════════════════════════════════════

app.get('/leonardo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leonardo.html'));
});

app.get('/api/leonardo/config', (req, res) => {
  try {
    const data = loadLeonardoData();
    const leonardoBahanDir = path.join(__dirname, 'bahan', 'leonardo');
    if (!fs.existsSync(leonardoBahanDir)) {
      fs.mkdirSync(leonardoBahanDir, { recursive: true });
    }

    const folders = fs.readdirSync(leonardoBahanDir)
      .filter(f => fs.statSync(path.join(leonardoBahanDir, f)).isDirectory());

    const bahanList = folders.map(folderName => {
      const folderPath = path.join(leonardoBahanDir, folderName);
      const files = fs.readdirSync(folderPath)
        .filter(f => ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(f).toLowerCase()))
        .map(f => `/bahan/leonardo/${folderName}/${f}`);
      return {
        name: folderName,
        images: files
      };
    });

    res.json({
      accounts: data.accounts.map(acc => ({
        id: acc.id,
        name: acc.name,
        email: acc.email,
        credits: acc.credits,
        isActive: acc.isActive
      })),
      prompts: data.prompts,
      bahan: bahanList
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leonardo/accounts/add', async (req, res) => {
  const { name, cookies } = req.body;
  if (!name || !cookies) {
    return res.status(400).json({ error: 'Nama dan Cookies wajib diisi.' });
  }

  try {
    const token = await getFreshJWT(cookies);
    const details = await fetchCreditBalance(token);
    const data = loadLeonardoData();

    const hasActive = data.accounts.some(acc => acc.isActive);

    const newAccount: LeonardoAccount = {
      id: `acc_${Date.now()}`,
      name,
      cookies,
      isActive: !hasActive,
      email: details.email,
      credits: details.credits
    };

    data.accounts.push(newAccount);
    saveLeonardoData(data);

    res.json({ success: true, account: newAccount });
  } catch (err: any) {
    console.error('Error adding Leonardo account:', err);
    res.status(500).json({ error: err.message || 'Gagal memverifikasi cookie sesi Leonardo.' });
  }
});

app.post('/api/leonardo/accounts/activate', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID akun diperlukan' });

  const data = loadLeonardoData();
  let activatedName = '';
  data.accounts.forEach(acc => {
    if (acc.id === id) {
      acc.isActive = true;
      activatedName = acc.name;
    } else {
      acc.isActive = false;
    }
  });

  if (!activatedName) {
    return res.status(404).json({ error: 'Akun tidak ditemukan' });
  }

  saveLeonardoData(data);
  res.json({ success: true, message: `Akun "${activatedName}" berhasil diaktifkan.` });
});

app.post('/api/leonardo/accounts/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID akun diperlukan' });

  const data = loadLeonardoData();
  const index = data.accounts.findIndex(acc => acc.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Akun tidak ditemukan' });
  }

  const deleted = data.accounts.splice(index, 1)[0];

  if (deleted.isActive && data.accounts.length > 0) {
    data.accounts[0].isActive = true;
  }

  saveLeonardoData(data);
  res.json({ success: true, message: `Akun "${deleted.name}" berhasil dihapus.` });
});

app.post('/api/leonardo/accounts/refresh', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID akun diperlukan' });

  const data = loadLeonardoData();
  const account = data.accounts.find(acc => acc.id === id);
  if (!account) return res.status(404).json({ error: 'Akun tidak ditemukan' });

  try {
    const token = await getFreshJWT(account.cookies);
    const details = await fetchCreditBalance(token);
    account.email = details.email;
    account.credits = details.credits;
    saveLeonardoData(data);
    res.json({ success: true, credits: details.credits, email: details.email });
  } catch (err: any) {
    console.error('Error refreshing credits:', err);
    res.status(500).json({ error: err.message || 'Gagal merefresh saldo kredit.' });
  }
});

app.post('/api/leonardo/prompts/save', (req, res) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) {
    return res.status(400).json({ error: 'Nama dan isi prompt wajib diisi.' });
  }

  const data = loadLeonardoData();
  const newPrompt: LeonardoPrompt = {
    id: `prompt_${Date.now()}`,
    name,
    prompt
  };

  data.prompts.push(newPrompt);
  saveLeonardoData(data);
  res.json({ success: true, prompt: newPrompt });
});

app.post('/api/leonardo/prompts/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID prompt diperlukan' });

  const data = loadLeonardoData();
  const index = data.prompts.findIndex(p => p.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Prompt tidak ditemukan' });
  }

  const deleted = data.prompts.splice(index, 1)[0];
  saveLeonardoData(data);
  res.json({ success: true, message: `Prompt "${deleted.name}" berhasil dihapus.` });
});

app.post('/api/leonardo/bahan/upload', bahanUpload.array('images', 100), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) {
    return res.status(400).json({ error: 'Nama bahan (folderName) diperlukan.' });
  }

  const leonardoBahanDir = path.join(__dirname, 'bahan', 'leonardo');
  const targetDir = path.join(leonardoBahanDir, folderName.trim());
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'Tidak ada file foto yang dipilih.' });
  }

  try {
    for (const f of files) {
      const dest = path.join(targetDir, f.originalname);
      fs.renameSync(f.path, dest);
    }
    res.json({ success: true, count: files.length, folderName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leonardo/bahan/delete', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama bahan diperlukan' });

  const leonardoBahanDir = path.join(__dirname, 'bahan', 'leonardo');
  const targetDir = path.join(leonardoBahanDir, name);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Bahan tidak ditemukan' });
  }

  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Bahan "${name}" berhasil dihapus.` });
  } catch (err: any) {
    res.status(500).json({ error: `Gagal menghapus folder: ${err.message}` });
  }
});

app.post('/api/leonardo/generate', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const { promptText, duration, mode, aspectRatio, motion_has_audio, imagePath, accountId, targetFolder } = req.body;

  try {
    // 1. Get active account
    sendEvent('progress', { percent: 5, message: 'Membaca akun aktif...' });
    const db = loadLeonardoData();
    const activeAcc = accountId 
      ? db.accounts.find(a => a.id === accountId)
      : db.accounts.find(a => a.isActive);

    if (!activeAcc) {
      throw new Error(accountId ? 'Akun Leonardo yang dipilih tidak ditemukan.' : 'Tidak ada akun Leonardo yang diaktifkan. Silakan aktifkan akun terlebih dahulu di Manajemen Akun.');
    }

    // 2. Fetch fresh token
    sendEvent('progress', { percent: 15, message: `Menghubungkan ke "${activeAcc.name}" & mengambil token JWT...` });
    const token = await getFreshJWT(activeAcc.cookies);

    // 3. Check & refresh credit balance
    const creditDetails = await fetchCreditBalance(token);
    activeAcc.email = creditDetails.email;
    activeAcc.credits = creditDetails.credits;
    saveLeonardoData(db);

    // 4. Upload init image if provided
    let imageId: string | undefined;
    if (imagePath) {
      sendEvent('progress', { percent: 30, message: 'Mengunggah gambar referensi ke Leonardo AI S3...' });
      
      // Front-end sends path like /bahan/leonardo/... We resolve it locally.
      const relativePath = imagePath.startsWith('/') ? imagePath.substring(1) : imagePath;
      const physicalPath = path.join(__dirname, relativePath);
      
      if (!fs.existsSync(physicalPath)) {
        throw new Error(`File gambar referensi tidak ditemukan di path: ${physicalPath}`);
      }
      
      imageId = await uploadInitImage(token, physicalPath);
      sendEvent('progress', { percent: 45, message: 'Gambar referensi berhasil diunggah!' });
    }

    // 5. Trigger Kling generation
    sendEvent('progress', { percent: 55, message: 'Memicu generasi video model Kling-3.0...' });
    
    let width = 720;
    let height = 1280;
    if (aspectRatio === '16:9') {
      width = 1280;
      height = 720;
    } else if (aspectRatio === '1:1') {
      width = 960;
      height = 960;
    }

    const generationId = await triggerKlingGenerate(token, {
      prompt: promptText,
      imageId,
      duration: parseInt(duration) || 10,
      width,
      height,
      mode: mode || 'RESOLUTION_720',
      motion_has_audio: !!motion_has_audio
    });

    sendEvent('progress', { percent: 65, message: `Video dipicu sukses! ID: ${generationId}. Mulai polling status...` });

    // 6. Polling status loop
    let isComplete = false;
    let attempts = 0;
    const maxAttempts = 100; // 5-6 mins max
    let currentStatus = 'PENDING';
    
    while (!isComplete && attempts < maxAttempts) {
      attempts++;
      await new Promise(r => setTimeout(r, 4000));

      currentStatus = await checkGenerationStatus(token, generationId);
      sendEvent('progress', { 
        percent: Math.min(90, 65 + Math.floor(attempts * 1.2)), 
        message: `Menunggu generasi video... Status: ${currentStatus} (Polling #${attempts})` 
      });

      if (currentStatus === 'COMPLETE' || currentStatus === 'COMPLETED') {
        isComplete = true;
      } else if (currentStatus === 'FAILED' || currentStatus === 'ERROR') {
        throw new Error('Generasi video di Leonardo AI gagal atau ditolak.');
      }
    }

    if (!isComplete) {
      throw new Error('Waktu generasi video habis (timeout). Silakan periksa dashboard Leonardo Anda.');
    }

    // 7. Get final video URL
    sendEvent('progress', { percent: 92, message: 'Video selesai! Mengambil URL unduhan S3...' });
    const result = await fetchGenerationVideoUrl(token, generationId);

    // 8. Download video to local static
    sendEvent('progress', { percent: 95, message: 'Mengunduh file video ke server lokal...' });
    const localDownloadUrl = await downloadVideoToLocal(result.videoUrl, generationId);

    // Copy to target folder if specified
    if (targetFolder && fs.existsSync(targetFolder)) {
      try {
        const physicalPath = path.join(__dirname, 'public', localDownloadUrl);
        if (fs.existsSync(physicalPath)) {
          const dest = path.join(targetFolder, path.basename(localDownloadUrl));
          fs.copyFileSync(physicalPath, dest);
          sendEvent('progress', { percent: 98, message: `Berhasil menyalin video ke folder lokal: ${dest}` });
        }
      } catch (copyErr: any) {
        console.warn('Gagal menyalin file ke folder lokal target:', copyErr);
      }
    }

    // 9. Success
    sendEvent('done', {
      success: true,
      videoUrl: localDownloadUrl,
      thumbnailUrl: result.thumbnailUrl,
      message: 'Video berhasil dibuat!'
    });

  } catch (err: any) {
    console.error('[LEONARDO-GENERATE] SSE Error:', err);
    sendEvent('error', {
      success: false,
      error: err.message || 'Gagal melakukan generasi video Leonardo.'
    });
  } finally {
    res.end();
  }
});

app.get('/api/leonardo/select-folder', (req, res) => {
  const psCommand = `powershell -NoProfile -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $g = New-Object System.Windows.Forms.FolderBrowserDialog; $g.ShowDialog() | Out-Null; $g.SelectedPath"`;
  exec(psCommand, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const selectedPath = stdout.trim();
    res.json({ success: true, path: selectedPath });
  });
});

app.get('/api/leonardo/preview-local', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File video tidak ditemukan.');
  }
  res.sendFile(filePath);
});

app.post('/api/leonardo/scan-folder', (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath || !fs.existsSync(folderPath)) {
    return res.json({ success: true, videos: [] });
  }
  try {
    const files = fs.readdirSync(folderPath);
    const videos = files
      .filter(f => f.toLowerCase().endsWith('.mp4') && f.toLowerCase().startsWith('leonardo-'))
      .map(f => {
        const fullPath = path.join(folderPath, f);
        const stats = fs.statSync(fullPath);
        return {
          filename: f,
          fullPath,
          mtime: stats.mtime.getTime()
        };
      });
    
    // Urutkan berdasarkan waktu modifikasi terbaru (newest first)
    videos.sort((a, b) => b.mtime - a.mtime);
    res.json({ success: true, videos });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  VIDABOT TO TIKTOK BOT CONSTANTS & PERSISTENCE
// ═══════════════════════════════════════════════════════════
const VIDABOT_DATA_FILE = path.join(__dirname, 'vidabot-data.json');
const VIDA_DOWNLOAD_DIR = path.join(__dirname, 'vidabot-downloads');
if (!fs.existsSync(VIDA_DOWNLOAD_DIR)) fs.mkdirSync(VIDA_DOWNLOAD_DIR, { recursive: true });

interface VidabotStateConfig {
  promptFile: string;
  bahanFolder: string;
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
  threeUploadsPerHour?: boolean;
  lastUploadDate?: string;
  lastUploadTime?: string;
}

interface VidabotData {
  states: Record<string, VidabotStateConfig>;
  globalConfig?: {
    parallelBrowsers?: number;
    headless?: boolean;
    sendWhatsApp?: boolean;
    fullAuto?: {
      enableCustomScheduler?: boolean;
      customIntervalHours?: number;
      customUploadCount?: number;
      headless?: boolean;
    };
  };
}

function loadVidabotData(): VidabotData {
  try {
    if (fs.existsSync(VIDABOT_DATA_FILE)) {
      return JSON.parse(fs.readFileSync(VIDABOT_DATA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading vidabot-data.json:', e);
  }
  return { states: {} };
}

function saveVidabotData(data: VidabotData) {
  try {
    fs.writeFileSync(VIDABOT_DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error saving vidabot-data.json:', e);
  }
}

function isHeadlessEnabledVida(stateFile?: string): boolean {
  const data = loadVidabotData();
  if (data.globalConfig && data.globalConfig.headless === false) {
    return false;
  }
  if (stateFile && data.states && data.states[stateFile] && data.states[stateFile].headless === false) {
    return false;
  }
  return data.globalConfig?.headless !== false;
}

function sendWAMessageVida(msg: string) {
  const data = loadVidabotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalSendWAMessage(msg);
  }
}

function notifyScheduleStartedVida(sched: string, end: string, stateName: string) {
  const data = loadVidabotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalNotifyScheduleStarted(sched, end, stateName);
  }
}

function notifyScheduleFinishedVida(stateName: string, success: boolean, count: number, err?: string) {
  const data = loadVidabotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalNotifyScheduleFinished(stateName, success, count, err);
  }
}

// Global state for Vidabot SSE & Orchestration
const vidabotSseClients: Response[] = [];
let vidabotRunning = false;
let vidaInfiniteGenRunning = false;
let vidabotFullAutoRunning = false;
let vidaInfiniteGenWaitInfo: { rateLimitTime: string; resumeTime: string; targetState: string } | null = null;
let vidabotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let vidabotProgress: {
  generate: number;
  merge: number;
  upload: number;
  currentState: string;
  browsers: VidabotWorkerProgress[];
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

function vidabotLog(msg: string) {
  console.log(`[VIDABOT] ${msg}`);
  vidabotSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

function vidabotBroadcastQueue() {
  vidabotSseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(vidabotQueue)}\n\n`));
}

function vidabotBroadcastProgress() {
  vidabotProgress.browsers = getVidabotBrowserProgress();
  const progressWithRateLimits = {
    ...vidabotProgress,
    rateLimits: getVidabotRateLimits()
  };
  vidabotSseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(progressWithRateLimits)}\n\n`));
}

function resetVidabotProgress(overrides: Partial<typeof vidabotProgress> = {}) {
  vidabotProgress = {
    generate: 0, merge: 0, upload: 0, currentState: '',
    browsers: [], uploadedCount: 0, uploadTotal: 0,
    mergedCount: 0, mergeTotal: 0,
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════
//  VIDABOT RESOURCE & ASSET ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/vidabot/bahan', (req, res) => {
  if (!fs.existsSync(BAHAN_DIR)) fs.mkdirSync(BAHAN_DIR, { recursive: true });
  const folders = fs.readdirSync(BAHAN_DIR).filter(f => fs.statSync(path.join(BAHAN_DIR, f)).isDirectory());
  res.json({ folders });
});

app.get('/api/vidabot/bahan/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Folder tidak ditemukan' });
  try {
    const files = fs.readdirSync(targetDir).filter(f => fs.statSync(path.join(targetDir, f)).isFile());
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/bahan/create-folder', (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: 'Nama folder diperlukan' });
  const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(BAHAN_DIR, cleanFolderName);
  if (fs.existsSync(targetDir)) return res.status(400).json({ error: 'Folder sudah ada' });
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, message: `Berhasil membuat folder ${cleanFolderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/bahan/upload', bahanUpload.any(), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) return res.status(400).json({ error: 'folderName diperlukan' });
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const files = (req.files || []) as Express.Multer.File[];
  if (files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });
  for (const f of files) {
    const dest = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dest);
  }
  res.json({ success: true, count: files.length });
});

app.delete('/api/vidabot/bahan/:folderName/:fileName', (req, res) => {
  const { folderName, fileName } = req.params;
  const filePath = path.join(BAHAN_DIR, folderName, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan' });
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus ${fileName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vidabot/bahan/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Folder tidak ditemukan' });
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Berhasil menghapus folder ${folderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vidabot/audio-folders', (req, res) => {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const folders = fs.readdirSync(AUDIO_DIR).filter(f => fs.statSync(path.join(AUDIO_DIR, f)).isDirectory());
  res.json({ folders });
});

app.get('/api/vidabot/audio/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Folder tidak ditemukan' });
  try {
    const files = fs.readdirSync(targetDir).filter(f => fs.statSync(path.join(targetDir, f)).isFile());
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/audio/create-folder', (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: 'Nama folder diperlukan' });
  const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(AUDIO_DIR, cleanFolderName);
  if (fs.existsSync(targetDir)) return res.status(400).json({ error: 'Folder sudah ada' });
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, message: `Berhasil membuat folder ${cleanFolderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/audio/upload', bahanUpload.any(), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) return res.status(400).json({ error: 'folderName diperlukan' });
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const files = (req.files || []) as Express.Multer.File[];
  if (files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });
  for (const f of files) {
    const dest = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dest);
  }
  res.json({ success: true, count: files.length });
});

app.delete('/api/vidabot/audio/:folderName/:fileName', (req, res) => {
  const { folderName, fileName } = req.params;
  const filePath = path.join(AUDIO_DIR, folderName, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan' });
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus ${fileName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vidabot/audio/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Folder tidak ditemukan' });
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Berhasil menghapus folder ${folderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vidabot/prompts', (req, res) => {
  if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const files = fs.readdirSync(PROMPT_DIR).filter(f => f.endsWith('.json'));
  res.json({ files });
});

app.get('/api/vidabot/prompts/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan' });
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const promptText = typeof data.prompt === 'string' ? data.prompt : (Array.isArray(data.prompts) ? data.prompts.join('\n') : (typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
    res.json({ success: true, filename, prompt: promptText });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/prompts/save', (req, res) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name dan prompt diperlukan' });
  const filename = name.endsWith('.json') ? name : (name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  fs.writeFileSync(path.join(PROMPT_DIR, filename), JSON.stringify({ prompt }, null, 2));
  res.json({ success: true, filename });
});

app.delete('/api/vidabot/prompts/:filename', (req, res) => {
  const { filename } = req.params;
  const filepath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File tidak ditemukan' });
  try {
    fs.unlinkSync(filepath);
    res.json({ success: true, message: `Berhasil menghapus ${filename}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  VIDABOT BOT API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/vidabot/config', (req, res) => {
  res.json(loadVidabotData());
});

app.post('/api/vidabot/config/save', (req, res) => {
  const { stateFile, promptFile, bahanFolder, aspectRatio, merge, audioFolder, description, hashtags, scheduleDate, scheduleTime, intervalMinutes, addProduct, productNameRadio, productTitle, productDescription, headless, threeUploadsPerHour, lastUploadDate, lastUploadTime } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadVidabotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = {
      promptFile: '', bahanFolder: '',
      aspectRatio: '9:16', merge: true,
      audioFolder: '', description: '', hashtags: '', scheduleDate: '',
      scheduleTime: '', intervalMinutes: 60,
      addProduct: false, productNameRadio: '', productTitle: '', productDescription: '',
      headless: true, threeUploadsPerHour: false, lastUploadDate: '', lastUploadTime: ''
    };
  }
  const s = data.states[stateFile];
  if (promptFile !== undefined) s.promptFile = promptFile;
  if (bahanFolder !== undefined) s.bahanFolder = bahanFolder;
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
  if (threeUploadsPerHour !== undefined) s.threeUploadsPerHour = !!threeUploadsPerHour;
  if (lastUploadDate !== undefined) s.lastUploadDate = lastUploadDate;
  if (lastUploadTime !== undefined) s.lastUploadTime = lastUploadTime;
  saveVidabotData(data);
  res.json({ success: true });
});

app.post('/api/vidabot/global-config/save', (req, res) => {
  const { parallelBrowsers, headless, sendWhatsApp } = req.body;
  const data = loadVidabotData();
  if (!data.globalConfig) data.globalConfig = {};
  if (parallelBrowsers !== undefined) data.globalConfig.parallelBrowsers = Math.max(1, parseInt(parallelBrowsers) || 1);
  if (headless !== undefined) data.globalConfig.headless = !!headless;
  if (sendWhatsApp !== undefined) data.globalConfig.sendWhatsApp = !!sendWhatsApp;
  saveVidabotData(data);
  res.json({ success: true });
});

app.post('/api/vidabot/full-auto-settings/save', (req, res) => {
  const { enableCustomScheduler, customIntervalHours, customUploadCount } = req.body;
  const data = loadVidabotData();
  if (!data.globalConfig) data.globalConfig = {};
  if (!data.globalConfig.fullAuto) data.globalConfig.fullAuto = {};
  if (enableCustomScheduler !== undefined) data.globalConfig.fullAuto.enableCustomScheduler = enableCustomScheduler;
  if (customIntervalHours !== undefined) data.globalConfig.fullAuto.customIntervalHours = customIntervalHours;
  if (customUploadCount !== undefined) data.globalConfig.fullAuto.customUploadCount = customUploadCount;
  saveVidabotData(data);
  res.json({ success: true });
});

app.get('/api/vidabot/stock', (req, res) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ raw: 0, utama: 0, cadangan: 0 });
  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(VIDA_DOWNLOAD_DIR, stateName);
  const rawDir = path.join(stateDir, 'raw');
  const cadanganDir = path.join(stateDir, 'cadangan');
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  let rawCount = 0;
  if (fs.existsSync(rawDir)) {
    try { rawCount = fs.readdirSync(rawDir).filter(f => exts.includes(path.extname(f).toLowerCase())).length; } catch {}
  }

  let utamaFiles: string[] = [];
  if (fs.existsSync(stateDir)) {
    try {
      utamaFiles = fs.readdirSync(stateDir).filter(f => {
        const full = path.join(stateDir, f);
        return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.')));
      });
    } catch {}
  }

  const marksFile = path.join(stateDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const unuploadedUtama = utamaFiles.filter(f => !marks[f]);

  let cadanganFiles: string[] = [];
  if (fs.existsSync(cadanganDir)) {
    try {
      cadanganFiles = fs.readdirSync(cadanganDir).filter(f => {
        const full = path.join(cadanganDir, f);
        return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.')));
      });
    } catch {}
  }

  const cadanganMarksFile = path.join(cadanganDir, '.uploaded.json');
  let cadanganMarks: Record<string, boolean> = {};
  try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

  const unuploadedCadangan = cadanganFiles.filter(f => !cadanganMarks[f]);

  res.json({ raw: rawCount, utama: unuploadedUtama.length, cadangan: unuploadedCadangan.length });
});

app.post('/api/vidabot/generate-utama', async (req, res) => {
  if (vidabotRunning || vidaInfiniteGenRunning || vidabotFullAutoRunning) return res.status(400).json({ error: 'Vidabot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadVidabotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan untuk state ini' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(stateDownloadDir, 'raw');

  if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });
  if (cfg.merge && !fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let currentUtamaCount = 0;
  if (fs.existsSync(stateDownloadDir)) {
    try {
      currentUtamaCount = fs.readdirSync(stateDownloadDir).filter(f => {
        const full = path.join(stateDownloadDir, f);
        return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
      }).length;
    } catch {}
  }

  const needed = Math.max(0, 30 - currentUtamaCount);
  if (needed === 0) {
    return res.json({ success: true, message: 'Stok utama sudah penuh (minimal 30 video)' });
  }

  const mergeEnabled = cfg.merge !== false;
  const totalRawToGenerate = mergeEnabled ? (2 * needed) : needed;

  vidabotRunning = true;
  resetVidabotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? needed : 0 });
  vidabotBroadcastProgress();
  res.json({ success: true, message: `Memulai generate ${needed} video utama (${totalRawToGenerate} raw)` });

  const vidaConfig = {
    bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
    promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
    aspectRatio: cfg.aspectRatio || '9:16',
    downloadDir: VIDA_DOWNLOAD_DIR,
    customDownloadDir: stateDownloadDir, totalVideos: totalRawToGenerate,
    merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
    parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
  };

  const poll = setInterval(() => {
    if (!vidabotRunning) { clearInterval(poll); return; }
    const stats = getVidabotStats();
    const progressList = getVidabotBrowserProgress();
    const doneCount = stats.success + stats.failed;
    let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
    let activeCount = 0; let activeProgSum = 0;
    progressList.forEach(bp => { if (bp.status === 'running') { activeCount++; activeProgSum += bp.progress; } });
    if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
    vidabotProgress.generate = Math.min(99, overallGen);
    if (mergeEnabled) {
      vidabotProgress.mergedCount = stats.saved;
      vidabotProgress.mergeTotal = needed;
      vidabotProgress.merge = Math.min(99, Math.round((stats.saved / needed) * 100));
    } else { vidabotProgress.merge = 100; }
    vidabotBroadcastProgress();
  }, 1500);

  try {
    await runVidabotGenerator(vidaConfig, vidabotLog, __dirname);
    clearInterval(poll);
    vidabotProgress.generate = 100; vidabotProgress.merge = 100; vidabotBroadcastProgress();
    vidabotLog(`✓ Stok Utama untuk ${tiktokStateName} berhasil digenerate!`);
    sendWAMessageVida(`🤖 [${tiktokStateName}] Selesai generate stok utama via Vidabot!`);
  } catch (err: any) {
    clearInterval(poll);
    vidabotLog(`❌ Gagal generate Utama: ${err.message}`);
    sendWAMessageVida(`❌ [${tiktokStateName}] Gagal generate Utama via Vidabot: ${err.message}`);
  } finally {
    vidabotRunning = false;
    resetVidabotProgress();
    vidabotBroadcastProgress();
  }
});

app.post('/api/vidabot/generate-cadangan', async (req, res) => {
  if (vidabotRunning || vidaInfiniteGenRunning || vidabotFullAutoRunning) return res.status(400).json({ error: 'Vidabot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadVidabotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan untuk state ini' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');
  const rawDir = path.join(cadanganDir, 'raw');

  if (!fs.existsSync(cadanganDir)) fs.mkdirSync(cadanganDir, { recursive: true });
  if (cfg.merge && !fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

  const marksFile = path.join(cadanganDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let currentCadanganCount = 0;
  if (fs.existsSync(cadanganDir)) {
    try {
      currentCadanganCount = fs.readdirSync(cadanganDir).filter(f => {
        const full = path.join(cadanganDir, f);
        return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
      }).length;
    } catch {}
  }

  const needed = Math.max(0, 30 - currentCadanganCount);
  if (needed === 0) {
    return res.json({ success: true, message: 'Stok cadangan sudah penuh (minimal 30 video)' });
  }

  const mergeEnabled = cfg.merge !== false;
  const totalRawToGenerate = mergeEnabled ? (2 * needed) : needed;

  vidabotRunning = true;
  resetVidabotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? needed : 0 });
  vidabotBroadcastProgress();
  res.json({ success: true, message: `Memulai generate ${needed} video cadangan (${totalRawToGenerate} raw)` });

  const vidaConfig = {
    bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
    promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
    aspectRatio: cfg.aspectRatio || '9:16',
    downloadDir: VIDA_DOWNLOAD_DIR,
    customDownloadDir: cadanganDir, totalVideos: totalRawToGenerate,
    merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
    parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
  };

  const poll = setInterval(() => {
    if (!vidabotRunning) { clearInterval(poll); return; }
    const stats = getVidabotStats();
    const progressList = getVidabotBrowserProgress();
    const doneCount = stats.success + stats.failed;
    let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
    let activeCount = 0; let activeProgSum = 0;
    progressList.forEach(bp => { if (bp.status === 'running') { activeCount++; activeProgSum += bp.progress; } });
    if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
    vidabotProgress.generate = Math.min(99, overallGen);
    if (mergeEnabled) {
      vidabotProgress.mergedCount = stats.saved;
      vidabotProgress.mergeTotal = needed;
      vidabotProgress.merge = Math.min(99, Math.round((stats.saved / needed) * 100));
    } else { vidabotProgress.merge = 100; }
    vidabotBroadcastProgress();
  }, 1500);

  try {
    await runVidabotGenerator(vidaConfig, vidabotLog, __dirname);
    clearInterval(poll);
    vidabotProgress.generate = 100; vidabotProgress.merge = 100; vidabotBroadcastProgress();
    vidabotLog(`✓ Stok Cadangan untuk ${tiktokStateName} berhasil digenerate!`);
    sendWAMessageVida(`🤖 [${tiktokStateName}] Selesai generate stok cadangan via Vidabot!`);
  } catch (err: any) {
    clearInterval(poll);
    vidabotLog(`❌ Gagal generate Cadangan: ${err.message}`);
    sendWAMessageVida(`❌ [${tiktokStateName}] Gagal generate Cadangan via Vidabot: ${err.message}`);
  } finally {
    vidabotRunning = false;
    resetVidabotProgress();
    vidabotBroadcastProgress();
  }
});

app.post('/api/vidabot/import-cadangan', (req, res) => {
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');

  if (!fs.existsSync(cadanganDir)) {
    return res.status(400).json({ error: 'Folder cadangan tidak ditemukan' });
  }

  const marksFile = path.join(cadanganDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const cadanganFiles = fs.readdirSync(cadanganDir).filter(f => {
    const full = path.join(cadanganDir, f);
    return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
  });

  if (cadanganFiles.length === 0) {
    return res.status(400).json({ error: 'Tidak ada video cadangan yang tersedia untuk diimpor' });
  }

  let importedCount = 0;
  cadanganFiles.forEach(file => {
    const src = path.join(cadanganDir, file);
    const dest = path.join(stateDownloadDir, file);
    try {
      fs.renameSync(src, dest);
      importedCount++;
    } catch (e) {
      console.error(`Gagal memindahkan ${file}:`, e);
    }
  });

  vidabotLog(`📦 [${tiktokStateName}] Berhasil mengimpor ${importedCount} video dari cadangan ke utama.`);
  res.json({ success: true, message: `Berhasil mengimpor ${importedCount} video ke stok utama` });
});

app.post('/api/vidabot/merge-only', async (req, res) => {
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadVidabotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(stateDownloadDir, 'raw');

  if (!fs.existsSync(rawDir)) return res.status(400).json({ error: 'Folder raw tidak ditemukan' });

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const rawFiles = fs.readdirSync(rawDir).filter(f => exts.includes(path.extname(f).toLowerCase()));
  if (rawFiles.length < 2) return res.status(400).json({ error: 'Minimal butuh 2 video raw untuk di-merge' });

  res.json({ success: true, message: `Memulai merge ${rawFiles.length} video raw` });

  (async () => {
    try {
      vidabotLog(`🔄 [${tiktokStateName}] Memulai proses merge manual...`);
      for (let i = 0; i < rawFiles.length - 1; i += 2) {
        const v1 = path.join(rawDir, rawFiles[i]);
        const v2 = path.join(rawDir, rawFiles[i + 1]);
        const outName = `vida_merged_${Date.now()}_${i}.mp4`;
        const outPath = path.join(stateDownloadDir, outName);

        let audioFilePath: string | undefined = undefined;
        if (cfg.audioFolder) {
          const audioFolderFull = path.join(AUDIO_DIR, cfg.audioFolder);
          if (fs.existsSync(audioFolderFull)) {
            const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg'];
            const audios = fs.readdirSync(audioFolderFull).filter(f => audioExts.includes(path.extname(f).toLowerCase()));
            if (audios.length > 0) {
              audioFilePath = path.join(audioFolderFull, audios[Math.floor(Math.random() * audios.length)]);
            }
          }
        }

        await mergeVideosCopyWithOptionalAudio([v1, v2], outPath, audioFilePath);
        vidabotLog(`✓ Berhasil merge: ${outName}`);
      }
      vidabotLog(`✅ Selesai merge untuk ${tiktokStateName}`);
    } catch (e: any) {
      vidabotLog(`❌ Gagal merge: ${e.message}`);
    }
  })();
});

app.post('/api/vidabot/schedule-only', async (req, res) => {
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadVidabotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let pendingVideos: string[] = [];
  if (fs.existsSync(stateDownloadDir)) {
    pendingVideos = fs.readdirSync(stateDownloadDir).filter(f => {
      const full = path.join(stateDownloadDir, f);
      return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
    });
  }

  if (pendingVideos.length === 0) {
    return res.status(400).json({ error: 'Tidak ada video di stok utama untuk di-upload' });
  }

  const videoToUpload = path.join(stateDownloadDir, pendingVideos[0]);
  vidabotRunning = true;
  res.json({ success: true, message: `Memulai upload 1 video untuk ${tiktokStateName}` });

  const onVideoUploaded = (videoFilename: string) => {
    marks[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));

    const uploadedVideoPath = path.join(stateDownloadDir, videoFilename);
    if (fs.existsSync(uploadedVideoPath)) {
      try {
        fs.unlinkSync(uploadedVideoPath);
        vidabotLog(`File video dihapus setelah upload: ${videoFilename}`);
      } catch (e: any) {
        vidabotLog(`Gagal menghapus file ${videoFilename}: ${e.message}`);
      }
    }
  };

  try {
    vidabotLog(`🚀 [${tiktokStateName}] Memulai upload video: ${pendingVideos[0]}`);
    await runUpload({
      stateFile,
      statesDir: STATES_DIR,
      videoFolder: stateDownloadDir,
      startFromVideo: pendingVideos[0],
      description: cfg.description || '',
      hashtags: cfg.hashtags || '',
      scheduleDate: cfg.scheduleDate || '',
      scheduleTime: cfg.scheduleTime || '',
      intervalMinutes: cfg.threeUploadsPerHour ? 300 : (cfg.intervalMinutes || 60),
      addProduct: !!cfg.addProduct,
      productNameRadio: cfg.productNameRadio || '',
      productTitle: cfg.productTitle || '',
      productDescription: cfg.productDescription || '',
      skipSwitches: false,
      headless: isHeadlessEnabledVida(stateFile),
      threeUploadsPerHour: !!cfg.threeUploadsPerHour,
      randomizeIntervalSchedule: true
    }, vidabotLog, onVideoUploaded, items => {
      sendWAMessageVida(buildScheduleListMessage(tiktokStateName, items));
    });

    vidabotLog(`✓ [${tiktokStateName}] Video berhasil diupload dan ditandai!`);
    sendWAMessageVida(`🎬 [${tiktokStateName}] Video ${pendingVideos[0]} berhasil diupload ke TikTok!`);
    sendWAMessageVida(`✅ [${tiktokStateName}] Upload schedule selesai.`);
  } catch (err: any) {
    vidabotLog(`❌ [${tiktokStateName}] Gagal upload: ${err.message}`);
    sendWAMessageVida(`❌ [${tiktokStateName}] Gagal upload ke TikTok: ${err.message}`);
  } finally {
    vidabotRunning = false;
    resetVidabotProgress();
    vidabotBroadcastProgress();
  }
});

app.post('/api/vidabot/schedule', async (req, res) => {
  if (vidabotRunning || vidaInfiniteGenRunning) return res.status(400).json({ error: 'Vidabot sedang berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  vidabotRunning = true;
  res.json({ success: true, message: 'Jadwal upload multi-state dimulai' });

  (async () => {
    try {
      for (const sf of stateFiles) {
        if (!vidabotRunning) break;
        const data = loadVidabotData();
        const cfg = data.states[sf];
        if (!cfg) continue;

        const tiktokStateName = sf.replace('tiktok-state-', '').replace('.json', '');
        const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
        const marksFile = path.join(stateDownloadDir, '.uploaded.json');
        let marks: Record<string, boolean> = {};
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

        const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
        let pendingVideos: string[] = [];
        if (fs.existsSync(stateDownloadDir)) {
          pendingVideos = fs.readdirSync(stateDownloadDir).filter(f => {
            const full = path.join(stateDownloadDir, f);
            return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
          });
        }

        if (pendingVideos.length === 0) {
          vidabotLog(`⚠ [${tiktokStateName}] Stok kosong, mencoba generate otomatis...`);
          const mergeEnabled = cfg.merge !== false;
          const totalRaw = mergeEnabled ? 6 : 3;
          const vidaConfig = {
            bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
            promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
            aspectRatio: cfg.aspectRatio || '9:16',
            downloadDir: VIDA_DOWNLOAD_DIR,
            customDownloadDir: stateDownloadDir, totalVideos: totalRaw,
            merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
            parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
          };
          try {
            await runVidabotGenerator(vidaConfig, vidabotLog, __dirname);
          } catch (e: any) {
            vidabotLog(`❌ Auto generate gagal: ${e.message}`);
            continue;
          }
        }

        // Upload first available
        const freshPending = fs.readdirSync(stateDownloadDir).filter(f => {
          const full = path.join(stateDownloadDir, f);
          return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
        });

        if (freshPending.length > 0) {
          try {
            vidabotLog(`🚀 [${tiktokStateName}] Mengupload: ${freshPending[0]}`);
            const onVideoUploaded = (videoFilename: string) => {
              marks[videoFilename] = true;
              fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));

              const uploadedVideoPath = path.join(stateDownloadDir, videoFilename);
              if (fs.existsSync(uploadedVideoPath)) {
                try {
                  fs.unlinkSync(uploadedVideoPath);
                  vidabotLog(`File video dihapus setelah upload: ${videoFilename}`);
                } catch (e: any) {
                  vidabotLog(`Gagal menghapus file ${videoFilename}: ${e.message}`);
                }
              }
            };

            await runUpload({
              stateFile: sf,
              statesDir: STATES_DIR,
              videoFolder: stateDownloadDir,
              startFromVideo: freshPending[0],
              description: cfg.description || '',
              hashtags: cfg.hashtags || '',
              scheduleDate: cfg.scheduleDate || '',
              scheduleTime: cfg.scheduleTime || '',
              intervalMinutes: cfg.threeUploadsPerHour ? 300 : (cfg.intervalMinutes || 60),
              addProduct: !!cfg.addProduct,
              productNameRadio: cfg.productNameRadio || '',
              productTitle: cfg.productTitle || '',
              productDescription: cfg.productDescription || '',
              skipSwitches: false,
              headless: isHeadlessEnabledVida(sf),
              threeUploadsPerHour: !!cfg.threeUploadsPerHour,
              randomizeIntervalSchedule: true
            }, vidabotLog, onVideoUploaded, items => {
              sendWAMessageVida(buildScheduleListMessage(tiktokStateName, items));
            });
            vidabotLog(`✓ [${tiktokStateName}] Berhasil upload!`);
            sendWAMessageVida(`✅ [${tiktokStateName}] Upload schedule selesai.`);
          } catch (e: any) {
            vidabotLog(`❌ [${tiktokStateName}] Gagal upload: ${e.message}`);
          }
        }
      }
    } finally {
      vidabotRunning = false;
      resetVidabotProgress();
      vidabotBroadcastProgress();
    }
  })();
});

app.post('/api/vidabot/full-auto', async (req, res) => {
  if (vidabotFullAutoRunning) return res.status(400).json({ error: 'Full Auto Vidabot sudah berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  vidabotFullAutoRunning = true;
  res.json({ success: true, message: 'Full Auto Vidabot Standby diaktifkan' });
  vidabotLog('🤖 ===== FULL AUTO VIDABOT STANDBY DIMULAI =====');

  (async () => {
    while (vidabotFullAutoRunning) {
      for (const sf of stateFiles) {
        if (!vidabotFullAutoRunning) break;
        // Check and process full auto routine
      }
      let elapsed = 0;
      while (elapsed < 60000 && vidabotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        elapsed += 2000;
      }
    }
    vidabotFullAutoRunning = false;
    vidabotLog('⛔ Full Auto Vidabot dihentikan.');
  })();
});

app.post('/api/vidabot/infinite-generate', async (req, res) => {
  if (vidaInfiniteGenRunning) return res.status(400).json({ error: 'Infinite Generate Vidabot sudah berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  vidaInfiniteGenRunning = true;
  res.json({ success: true, message: 'Infinite Generate Vidabot dimulai' });
  vidabotLog(`♾️ Infinite Generate Vidabot dimulai untuk ${stateFiles.length} state`);

  (async () => {
    try {
      while (vidaInfiniteGenRunning) {
        let anyGenerated = false;
        for (const sf of stateFiles) {
          if (!vidaInfiniteGenRunning) break;
          const data = loadVidabotData();
          const cfg = data.states[sf];
          if (!cfg || !cfg.promptFile) continue;

          const tiktokStateName = sf.replace('tiktok-state-', '').replace('.json', '');
          const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
          const marksFile = path.join(stateDownloadDir, '.uploaded.json');
          let marks: Record<string, boolean> = {};
          try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

          const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
          let currentUtamaCount = 0;
          if (fs.existsSync(stateDownloadDir)) {
            currentUtamaCount = fs.readdirSync(stateDownloadDir).filter(f => {
              const full = path.join(stateDownloadDir, f);
              return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
            }).length;
          }

          const needed = Math.max(0, 30 - currentUtamaCount);
          if (needed > 0) {
            anyGenerated = true;
            vidabotRunning = true;
            vidabotLog(`🎯 [${tiktokStateName}] Mengisi stok utama (+${needed} video)...`);
            const mergeEnabled = cfg.merge !== false;
            const totalRaw = mergeEnabled ? (2 * needed) : needed;
            const vidaConfig = {
              bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
              promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
              aspectRatio: cfg.aspectRatio || '9:16',
              downloadDir: VIDA_DOWNLOAD_DIR,
              customDownloadDir: stateDownloadDir, totalVideos: totalRaw,
              merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
              parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
            };
            try {
              await runVidabotGenerator(vidaConfig, vidabotLog, __dirname);
              vidabotLog(`✓ [${tiktokStateName}] Selesai generate stok utama.`);
            } catch (e: any) {
              vidabotLog(`❌ [${tiktokStateName}] Error generate: ${e.message}`);
            } finally {
              vidabotRunning = false;
            }
          }
        }

        if (!anyGenerated) {
          vidabotLog('✨ Semua stok state penuh. Tidur 30 detik...');
          let slept = 0;
          while (slept < 30000 && vidaInfiniteGenRunning) {
            await new Promise(r => setTimeout(r, 2000));
            slept += 2000;
          }
        }
      }
    } finally {
      vidaInfiniteGenRunning = false;
      vidabotRunning = false;
      resetVidabotProgress();
      vidabotBroadcastProgress();
      vidabotLog('===== INFINITE GENERATE VIDABOT FINISHED =====');
    }
  })();
});

app.get('/api/vidabot/status', (req, res) => {
  res.json({
    running: vidabotRunning,
    infiniteGenRunning: vidaInfiniteGenRunning,
    infiniteGenWaitInfo: vidaInfiniteGenWaitInfo,
    vidabotFullAutoRunning,
    queue: vidabotQueue,
    progress: vidabotProgress,
    rateLimits: getVidabotRateLimits()
  });
});

app.post('/api/vidabot/stop', async (req, res) => {
  vidaInfiniteGenRunning = false;
  vidabotFullAutoRunning = false;
  vidabotRunning = false;
  resetVidabotProgress();
  vidabotBroadcastProgress();
  await stopVidabotGenerator();
  await stopUploader();
  vidabotLog('⛔ ===== VIDABOT STOPPED =====');
  res.json({ success: true });
});

app.post('/api/vidabot/stop-full-auto', (req, res) => {
  vidabotFullAutoRunning = false;
  vidabotLog('⛔ ===== FULL AUTO VIDABOT STOPPED =====');
  res.json({ success: true });
});

app.post('/api/vidabot/stop-infinite-generate', async (req, res) => {
  vidaInfiniteGenRunning = false;
  await stopVidabotGenerator();
  vidabotLog('⛔ ===== INFINITE GENERATE VIDABOT STOPPED =====');
  res.json({ success: true });
});

app.get('/api/vidabot/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  vidabotSseClients.push(res);
  req.on('close', () => {
    const idx = vidabotSseClients.indexOf(res);
    if (idx >= 0) vidabotSseClients.splice(idx, 1);
  });
});


// Jalankan server
app.listen(PORT, () => {
  initAutopull();
  startWAPolling();
  console.log(`🚀 State Manager berjalan di http://localhost:${PORT}`);
  console.log(`🎬 TikTok Auto Uploader: http://localhost:${PORT}/tiktok`);
  console.log(`🧠 Grok Imagine Generator: http://localhost:${PORT}/grok`);
  console.log(`🤖 YT to TikTok Bot: http://localhost:${PORT}/ytbot`);
  console.log(`🤖 Grok to TikTok Bot: http://localhost:${PORT}/grokbot`);
  console.log(`🎬 Vidabot to TikTok Bot: http://localhost:${PORT}/vidabot`);
  console.log(`🤖 Grok V2 to TikTok Bot: http://localhost:${PORT}/grokbotv2`);
  console.log(`📁 Folder state: ${STATES_DIR} & ${GROK_STATES_DIR}`);
});

