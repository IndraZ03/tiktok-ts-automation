// patch.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, 'tiktok-state-manager.ts');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add imports at the top
content = content.replace(
  /import \{ runUpload, stopUploader, getIsRunning \} from '\.\/tiktok-uploader\.js';/,
  "import { runUpload, stopUploader, getIsRunning } from './tiktok-uploader.js';\nimport { runFacebookUpload, stopFacebookUploader, getFacebookIsRunning } from './facebook-uploader.js';"
);

// 1b. Update child_process imports
content = content.replace(
  "import { exec } from 'child_process';",
  "import { exec, spawn } from 'child_process';"
);

// 2. Add FB_STATES_DIR config
content = content.replace(
  /const GROK_STATES_DIR = path\.join\(__dirname, 'grok-states'\);\s*if \(!fs\.existsSync\(GROK_STATES_DIR\)\) \{\s*fs\.mkdirSync\(GROK_STATES_DIR, \{ recursive: true \}\);\s*\}/,
  `const GROK_STATES_DIR = path.join(__dirname, 'grok-states');
if (!fs.existsSync(GROK_STATES_DIR)) {
  fs.mkdirSync(GROK_STATES_DIR, { recursive: true });
}

const FB_STATES_DIR = path.join(__dirname, 'facebook-states');
if (!fs.existsSync(FB_STATES_DIR)) {
  fs.mkdirSync(FB_STATES_DIR, { recursive: true });
}`
);

// 3. Replace the entire getSavedStates function block
const getSavedStatesStart = content.indexOf('// Ganti fungsi getSavedStates() yang lama dengan ini');
const apiRoutesStart = content.indexOf('// === API ROUTES ===');

if (getSavedStatesStart === -1 || apiRoutesStart === -1) {
  console.error("Error: Could not find getSavedStates comments in the file!");
  process.exit(1);
}

const newGetSavedStatesImplementation = `// Ganti fungsi getSavedStates() yang lama dengan ini
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
  console.log(\`[FBBOT] \${msg}\`);
  fbbotSseClients.forEach(c => c.write(\`data: \${msg}\\n\\n\`));
}

function fbbotBroadcastQueue() {
  fbbotSseClients.forEach(c => c.write(\`data: [QUEUE_UPDATE]:\${JSON.stringify(fbbotQueue)}\\n\\n\`));
}

function fbbotBroadcastProgress() {
  fbbotSseClients.forEach(c => c.write(\`data: [PROGRESS_UPDATE]:\${JSON.stringify(fbbotProgress)}\\n\\n\`));
}

function getFbbotStateVideoDir(stateFile: string): string {
  const stateName = stateFile.replace('facebook-state-', '').replace('.json', '');
  const dir = path.join(FBBOT_VIDEO_DIR, stateName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

`;

content = content.substring(0, getSavedStatesStart) + newGetSavedStatesImplementation + content.substring(apiRoutesStart);

// 4. Update types & API routes platform references
content = content.replace(
  "let currentPlatform: 'tiktok' | 'grok' = 'tiktok';",
  "let currentPlatform: 'tiktok' | 'grok' | 'facebook' = 'tiktok';"
);

// 5. Update /api/states
content = content.replace(
  /const platform = req\.query\.platform === 'grok' \? 'grok' : 'tiktok';/,
  "const platform = req.query.platform === 'grok' ? 'grok' : (req.query.platform === 'facebook' ? 'facebook' : 'tiktok');"
);

// 6. Update /api/start-login
content = content.replace(
  /currentPlatform = platform as 'tiktok' \| 'grok';/,
  "currentPlatform = platform as 'tiktok' | 'grok' | 'facebook';"
);
content = content.replace(
  /const url = currentPlatform === 'grok' \? 'https:\/\/accounts\.x\.ai\/sign-in\?redirect=grok-com' : 'https:\/\/www\.tiktok\.com';/,
  "const url = currentPlatform === 'grok' ? 'https://accounts.x.ai/sign-in?redirect=grok-com' : (currentPlatform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');"
);
content = content.replace(
  `message: 'Browser stealth sudah terbuka!\\nSilakan login manual di TikTok.\\nSetelah login selesai, klik tombol "Sudah Login" di web.'`,
  `message: 'Browser stealth sudah terbuka!\\nSilakan login manual.\\nSetelah login selesai, klik tombol "Sudah Login" di web.'`
);

// 7. Update /api/start-login-with-state
content = content.replace(
  /const dir = platform === 'grok' \? GROK_STATES_DIR : STATES_DIR;/,
  "const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);"
);
content = content.replace(
  /currentPlatform = platform as 'tiktok' \| 'grok';/,
  "currentPlatform = platform as 'tiktok' | 'grok' | 'facebook';"
);
content = content.replace(
  /const url = currentPlatform === 'grok' \? 'https:\/\/grok\.com' : 'https:\/\/www\.tiktok\.com';/g,
  "const url = currentPlatform === 'grok' ? 'https://grok.com' : (currentPlatform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');"
);

// 8. Update /api/open-state
content = content.replace(
  /const prefix = platform === 'grok' \? 'grok-state-' : 'tiktok-state-';\s*const dir = platform === 'grok' \? GROK_STATES_DIR : STATES_DIR;/,
  "const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');\n  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);"
);
content = content.replace(
  /const url = platform === 'grok' \? 'https:\/\/grok\.com' : 'https:\/\/www\.tiktok\.com';/g,
  "const url = platform === 'grok' ? 'https://grok.com' : (platform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');"
);

// 9. Update /api/save-login
content = content.replace(
  /const prefix = currentPlatform === 'grok' \? 'grok-state-' : 'tiktok-state-';\s*const dir = currentPlatform === 'grok' \? GROK_STATES_DIR : STATES_DIR;/,
  "const prefix = currentPlatform === 'grok' ? 'grok-state-' : (currentPlatform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');\n  const dir = currentPlatform === 'grok' ? GROK_STATES_DIR : (currentPlatform === 'facebook' ? FB_STATES_DIR : STATES_DIR);"
);

// 10. Update /api/codegen-command
content = content.replace(
  "const dir = platform === 'grok' ? 'grok-states' : 'tiktok-states';",
  "const dir = platform === 'grok' ? 'grok-states' : (platform === 'facebook' ? 'facebook-states' : 'tiktok-states');"
);
content = content.replace(
  "const url = platform === 'grok' ? 'https://grok.com' : 'https://www.tiktok.com';",
  "const url = platform === 'grok' ? 'https://grok.com' : (platform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');"
);
// 11. Insert FBBOT orchestration and API routes right before GROKBOT CONSTANTS & PERSISTENCE
const grokbotPattern = "//  GROKBOT CONSTANTS & PERSISTENCE";
const grokbotIndex = content.indexOf(grokbotPattern);

if (grokbotIndex === -1) {
  console.error("Error: Could not find GROKBOT CONSTANTS & PERSISTENCE in the file!");
  process.exit(1);
}

// Move back to find the line starting with separator
let insertIndex = grokbotIndex;
const prevSeparator = content.lastIndexOf("// ════", grokbotIndex);
if (prevSeparator !== -1 && grokbotIndex - prevSeparator < 100) {
  insertIndex = prevSeparator;
}

const facebookOrchestrationAndRoutes = `

// ── FBBOT ORCHESTRATION ──
async function fbbotRunState(stateFile: string): Promise<void> {
  if (!fbbotRunning) return;
  const data = loadFbbotData();
  const cfg = data.states[stateFile];
  if (!cfg) {
    fbbotLog(\`❌ Config tidak ditemukan untuk \${stateFile}\`);
    return;
  }

  const stateName = stateFile.replace('facebook-state-', '').replace('.json', '');
  const videoDir = getFbbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');

  fbbotProgress = { download: 0, split: 0, upload: 0, currentState: stateName };
  fbbotBroadcastProgress();

  fbbotLog(\`═══════════════════════════════════════\`);
  fbbotLog(\`🔑 Memproses FB state: \${stateName}\`);
  fbbotLog(\`═══════════════════════════════════════\`);

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
        fbbotLog(\`ℹ Tidak ada video pending dan tidak ada link YT tersisa untuk \${stateName}\`);
        break;
      }

      // Take first link from stock
      const ytLink = freshCfg.ytLinks[0];
      fbbotLog(\`📥 Download & split: \${ytLink}\`);

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

        fbbotLog(\`✓ Split selesai: \${result.totalParts} file dari "\${result.title}"\`);

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
        fbbotLog(\`❌ Gagal download/split: \${err.message}\`);
        // Remove failed link so we don't retry forever
        freshCfg.ytLinks.splice(0, 1);
        saveFbbotData(freshData);
        continue;
      }
    }

    if (!fbbotRunning) break;
    if (pendingVideos.length === 0) {
      fbbotLog(\`ℹ Tidak ada video untuk diupload di \${stateName}\`);
      break;
    }

    // 3. Take max 30 videos for this batch
    const batch = pendingVideos.slice(0, 30);
    const startFrom = batch[0];

    // Calculate schedule end for queue display
    const batchStartMs = new Date(\`\${schedDate}T\${schedTime}:00\`).getTime();
    const batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
    const endDate = new Date(batchEndMs);
    const endStr = \`\${endDate.getFullYear()}-\${String(endDate.getMonth()+1).padStart(2,'0')}-\${String(endDate.getDate()).padStart(2,'0')} \${String(endDate.getHours()).padStart(2,'0')}:\${String(endDate.getMinutes()).padStart(2,'0')}\`;

    // Update queue
    const qIdx = fbbotQueue.findIndex(q => q.stateFile === stateFile);
    const qEntry = { stateName, stateFile, videoCount: batch.length, scheduleStart: \`\${schedDate} \${schedTime}\`, scheduleEnd: endStr, active: true };
    if (qIdx >= 0) fbbotQueue[qIdx] = qEntry; else fbbotQueue.push(qEntry);
    fbbotBroadcastQueue();

    fbbotProgress.download = 100;
    fbbotProgress.split = 100;
    fbbotProgress.upload = 0;
    fbbotBroadcastProgress();

    fbbotLog(\`📤 Upload batch: \${batch.length} video, schedule \${schedDate} \${schedTime} → \${endStr}\`);

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
      fbbotLog(\`✅ [\${stateName}] \${videoFilename} terupload\`);

      // Hapus video setelah sukses terupload
      const videoPath = path.join(videoDir, videoFilename);
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          fbbotLog(\`🗑️ [\${stateName}] Berhasil menghapus file selesai diupload: \${videoFilename}\`);
        } catch (e: any) {
          fbbotLog(\`⚠ Gagal menghapus file \${videoFilename}: \${e.message}\`);
        }
      }

      uploadedCount++;
      fbbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
      fbbotBroadcastProgress();
    };

    try {
      await runFacebookUpload(uploadConfig, fbbotLog, onVideoUploaded);
    } catch (err: any) {
      fbbotLog(\`❌ Upload error: \${err.message}\`);
    }

    if (!fbbotRunning) break;

    // 5. Calculate next batch schedule start = last video schedule + interval
    const nextStartMs = batchEndMs + intervalMin * 60000;
    const nextStart = new Date(nextStartMs);
    schedDate = \`\${nextStart.getFullYear()}-\${String(nextStart.getMonth()+1).padStart(2,'0')}-\${String(nextStart.getDate()).padStart(2,'0')}\`;
    schedTime = \`\${String(nextStart.getHours()).padStart(2,'0')}:\${String(nextStart.getMinutes()).padStart(2,'0')}\`;

    // Update config with new schedule for next loop
    const updData = loadFbbotData();
    if (updData.states[stateFile]) {
      updData.states[stateFile].scheduleDate = schedDate;
      updData.states[stateFile].scheduleTime = schedTime;
      saveFbbotData(updData);
    }

    fbbotLog(\`⏭ Batch selanjutnya mulai: \${schedDate} \${schedTime}\`);

    // Check if there are more pending videos or links
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
    allVideos = fs.readdirSync(videoDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    pendingVideos = allVideos.filter(v => !marks[v]);
    const freshData2 = loadFbbotData();
    const hasMoreLinks = (freshData2.states[stateFile]?.ytLinks?.length || 0) > 0;

    if (pendingVideos.length === 0 && !hasMoreLinks) {
      fbbotLog(\`✅ Semua video dan link untuk \${stateName} sudah diproses\`);
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

  const filename = \`facebook-state-\${name.trim()}.json\`;
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
    res.json({ success: true, message: \`Session berhasil disimpan ke \${filename}\` });
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

  const filename = \`\${prefix}\${name.trim()}.json\`;
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
    res.json({ success: true, message: \`Session berhasil disimpan ke \${filename}\` });
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
    const scriptContent = \`@echo off
ping 127.0.0.1 -n 3 > nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do (
    taskkill /f /pid %%a
)
wscript.exe "%~dp0start.vbs"
\`;
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
  }, 20000); // Check every 20 seconds
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
    const lines = stdout.trim().split('\\n');
    const lastCommit = lines.pop() || 'Unknown';
    const status = lines.join('\\n').trim() || 'Clean / Up to date';
    res.json({ success: true, lastCommit, status });
  });
});

app.post('/api/git/pull', (req, res) => {
  exec('git pull', (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message + '\\n' + stderr });
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
    fbbotLog(\`❌ Fatal: \${e.message}\`);
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
    fbbotLog(\`❌ Fatal: \${e.message}\`);
  } finally {
    fbbotRunning = false;
    fbbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
    fbbotBroadcastProgress();
    fbbotLog('===== FBBOT FINISHED =====');
  }
});

`;

content = content.substring(0, insertIndex) + facebookOrchestrationAndRoutes + content.substring(insertIndex);

// 12. Initialize autopull inside app.listen
content = content.replace(
  `app.listen(PORT, () => {
  console.log(\`🚀 State Manager berjalan di http://localhost:\${PORT}\`);`,
  `app.listen(PORT, () => {
  initAutopull();
  console.log(\`🚀 State Manager berjalan di http://localhost:\${PORT}\`);`
);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch completed successfully!');
