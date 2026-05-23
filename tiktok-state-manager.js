// tiktok-state-manager.ts
// Jalankan dengan: npx ts-node tiktok-state-manager.ts
// Atau compile dulu: npx tsc && node dist/tiktok-state-manager.js
import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runUpload, stopUploader, getIsRunning } from './tiktok-uploader.js';
import { runGrokGenerator, stopGrokGenerator, getGrokIsRunning, getGrokStats, getBrowserProgress } from './grok-uploader.js';
import multer from 'multer';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 5000;
app.use(express.json());
app.use(express.static('public'));
// Multer for bahan image uploads
const bahanUpload = multer({ dest: path.join(__dirname, '_tmp_uploads') });
const STATES_DIR = path.join(__dirname, 'tiktok-states');
if (!fs.existsSync(STATES_DIR)) {
    fs.mkdirSync(STATES_DIR, { recursive: true });
}
const GROK_STATES_DIR = path.join(__dirname, 'grok-states');
if (!fs.existsSync(GROK_STATES_DIR)) {
    fs.mkdirSync(GROK_STATES_DIR, { recursive: true });
}
// Variabel global untuk session yang sedang dibuat (hanya 1 pada satu waktu)
let currentPlatform = 'tiktok';
let currentContext = null;
let currentStateName = '';
let currentEditingFilename = null;
// Ganti fungsi getSavedStates() yang lama dengan ini
function getSavedStates(platform = 'tiktok') {
    const dir = platform === 'grok' ? GROK_STATES_DIR : STATES_DIR;
    const prefix = platform === 'grok' ? 'grok-state-' : 'tiktok-state-';
    const files = fs.readdirSync(dir)
        .filter(file => file.startsWith(prefix) && file.endsWith('.json'));
    return files.map(file => {
        const name = file.replace(prefix, '').replace('.json', '');
        const filepath = path.join(dir, file);
        let expiryInfo = {
            expiresAt: null,
            daysLeft: null,
            status: 'unknown'
        };
        try {
            const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
            const cookies = data.cookies || [];
            // Cari cookie penting TikTok (yang biasanya paling cepat expired)
            const importantCookies = ['sessionid', 'sessionid_ss', 'sid_tt', 'ttwid'];
            let earliestExpiry = Infinity;
            cookies.forEach((cookie) => {
                if (importantCookies.includes(cookie.name) && cookie.expires && cookie.expires > 0) {
                    if (cookie.expires < earliestExpiry) {
                        earliestExpiry = cookie.expires;
                    }
                }
            });
            if (earliestExpiry !== Infinity) {
                const expiryDate = new Date(earliestExpiry * 1000); // expires dalam detik → ms
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
        }
        catch (e) {
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
    currentPlatform = platform;
    try {
        // ──────── LAUNCH BROWSER (ini yang diperbaiki) ────────
        const browser = await chromium.launch({
            headless: true,
            slowMo: 150,
            channel: 'chrome', // pakai Google Chrome asli
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
            ],
            ignoreDefaultArgs: ['--enable-automation'], // ← dipindah ke sini
        });
        // ──────── NEW CONTEXT ────────
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
        await page.goto(url, { waitUntil: 'networkidle' });
        console.log(`✅ Browser stealth dibuka untuk state: ${currentStateName}`);
        res.json({
            success: true,
            message: 'Browser stealth sudah terbuka!\nSilakan login manual di TikTok.\nSetelah login selesai, klik tombol "Sudah Login" di web.'
        });
    }
    catch (err) {
        console.error(err);
        currentContext = null;
        res.status(500).json({ error: 'Gagal membuka browser: ' + err.message });
    }
});
app.post('/api/start-login-with-state', async (req, res) => {
    const { filename, platform = 'tiktok' } = req.body;
    if (!filename)
        return res.status(400).json({ error: 'Filename diperlukan' });
    const dir = platform === 'grok' ? GROK_STATES_DIR : STATES_DIR;
    const filepath = path.join(dir, filename);
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'File state tidak ditemukan' });
    }
    if (currentContext)
        await currentContext.close();
    currentEditingFilename = filename;
    currentStateName = ''; // tidak pakai nama baru
    currentPlatform = platform;
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
            storageState: filepath, // ← langsung load session yang sudah ada
        });
        const page = await currentContext.newPage();
        const url = currentPlatform === 'grok' ? 'https://grok.com' : 'https://www.tiktok.com';
        await page.goto(url, { waitUntil: 'networkidle' });
        res.json({ success: true, message: `✅ Browser terbuka dengan session: ${filename}\nLakukan apa saja, lalu klik "Sudah Login"` });
    }
    catch (err) {
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
        await page.goto(url, { waitUntil: 'networkidle' });
        console.log(`✅ Browser dibuka dengan state: ${name}`);
        res.json({ success: true, message: 'Browser berhasil dibuka' });
    }
    catch (err) {
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
    let filename;
    if (currentEditingFilename) {
        filename = currentEditingFilename; // update session lama
    }
    else {
        filename = `${prefix}${currentStateName}.json`; // state baru
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
            message: `✅ Session berhasil disimpan ke ${filename}`,
            filename
        });
    }
    catch (err) {
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
const sseClients = [];
function broadcastLog(msg) {
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
        if (idx >= 0)
            sseClients.splice(idx, 1);
    });
});
// List videos in a folder
app.get('/api/tiktok/videos', (req, res) => {
    const folder = req.query.folder;
    if (!folder || !fs.existsSync(folder)) {
        return res.json({ videos: [] });
    }
    const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    const videos = fs.readdirSync(folder)
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .sort();
    res.json({ videos });
});
// Start upload
app.post('/api/tiktok/start', async (req, res) => {
    if (getIsRunning()) {
        return res.status(400).json({ success: false, error: 'Upload sedang berjalan!' });
    }
    const config = {
        ...req.body,
        statesDir: STATES_DIR,
    };
    res.json({ success: true, message: 'Upload dimulai' });
    // Run in background
    runUpload(config, broadcastLog).then(() => {
        broadcastLog('===== UPLOAD PROCESS FINISHED =====');
    }).catch(e => {
        broadcastLog('❌ Fatal: ' + e.message);
    });
});
// Stop upload
app.post('/api/tiktok/stop', async (req, res) => {
    await stopUploader();
    res.json({ success: true, message: 'Upload dihentikan' });
});
app.get('/tiktok', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tiktok.html'));
});
app.get('/grok', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'grok.html'));
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
if (!fs.existsSync(BAHAN_DIR))
    fs.mkdirSync(BAHAN_DIR, { recursive: true });
if (!fs.existsSync(PROMPT_DIR))
    fs.mkdirSync(PROMPT_DIR, { recursive: true });
if (!fs.existsSync(GROK_DOWNLOAD_DIR))
    fs.mkdirSync(GROK_DOWNLOAD_DIR, { recursive: true });
// List bahan folders
app.get('/api/grok/bahan', (req, res) => {
    const folders = fs.readdirSync(BAHAN_DIR)
        .filter(f => fs.statSync(path.join(BAHAN_DIR, f)).isDirectory());
    res.json({ folders });
});
// Upload bahan images
app.post('/api/grok/bahan/upload', bahanUpload.array('images', 100), (req, res) => {
    const folderName = req.body.folderName;
    if (!folderName)
        return res.status(400).json({ error: 'folderName diperlukan' });
    const targetDir = path.join(BAHAN_DIR, folderName);
    if (!fs.existsSync(targetDir))
        fs.mkdirSync(targetDir, { recursive: true });
    const files = req.files;
    if (!files || files.length === 0)
        return res.status(400).json({ error: 'Tidak ada file' });
    for (const f of files) {
        const dest = path.join(targetDir, f.originalname);
        fs.renameSync(f.path, dest);
    }
    res.json({ success: true, count: files.length });
});
// List prompt files
app.get('/api/grok/prompts', (req, res) => {
    const files = fs.readdirSync(PROMPT_DIR)
        .filter(f => f.endsWith('.json'));
    res.json({ files });
});
// Save prompt
app.post('/api/grok/prompts/save', (req, res) => {
    const { name, prompt } = req.body;
    if (!name || !prompt)
        return res.status(400).json({ error: 'name dan prompt diperlukan' });
    const filename = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
    fs.writeFileSync(path.join(PROMPT_DIR, filename), JSON.stringify({ prompt }, null, 2));
    res.json({ success: true, filename });
});
// Grok SSE logs
const grokSseClients = [];
function grokBroadcastLog(msg) {
    console.log(`[GROK] ${msg}`);
    grokSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}
app.get('/api/grok/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    grokSseClients.push(res);
    req.on('close', () => {
        const idx = grokSseClients.indexOf(res);
        if (idx >= 0)
            grokSseClients.splice(idx, 1);
    });
});
// Stats
app.get('/api/grok/stats', (req, res) => {
    res.json({ ...getGrokStats(), running: getGrokIsRunning(), browsers: getBrowserProgress() });
});
// Start generate
app.post('/api/grok/start', async (req, res) => {
    if (getGrokIsRunning()) {
        return res.status(400).json({ success: false, error: 'Generate sedang berjalan!' });
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
        totalVideos: Math.max(1, parseInt(req.body.totalVideos) || 1),
    };
    res.json({ success: true, message: 'Generate dimulai' });
    runGrokGenerator(config, grokBroadcastLog, __dirname).then(() => {
        grokBroadcastLog('===== GENERATE PROCESS FINISHED =====');
    }).catch(e => {
        grokBroadcastLog('❌ Fatal: ' + e.message);
    });
});
// Stop generate
app.post('/api/grok/stop', async (req, res) => {
    await stopGrokGenerator();
    res.json({ success: true, message: 'Generate dihentikan' });
});
// List generated videos for a state
app.get('/api/grok/videos', (req, res) => {
    const stateFile = req.query.state;
    if (!stateFile)
        return res.json({ videos: [] });
    const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
    const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
    if (!fs.existsSync(stateDir))
        return res.json({ videos: [] });
    // Load downloaded marks
    const marksFile = path.join(stateDir, '.downloaded.json');
    let marks = {};
    try {
        marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8'));
    }
    catch { }
    const exts = ['.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.webp'];
    const videos = fs.readdirSync(stateDir)
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .sort()
        .reverse() // newest first
        .map(f => {
        const stat = fs.statSync(path.join(stateDir, f));
        return {
            filename: f,
            size: stat.size,
            created: stat.birthtime.toISOString(),
            downloaded: !!marks[f],
        };
    });
    res.json({ videos, stateName });
});
// Serve video file
app.get('/api/grok/video-file/:state/:filename', (req, res) => {
    const { state, filename } = req.params;
    const filepath = path.join(GROK_DOWNLOAD_DIR, state, filename);
    if (!fs.existsSync(filepath))
        return res.status(404).send('Not found');
    res.sendFile(filepath);
});
// Mark video as downloaded by user
app.post('/api/grok/mark-downloaded', (req, res) => {
    const { stateFile, filename } = req.body;
    if (!stateFile || !filename)
        return res.status(400).json({ error: 'Missing params' });
    const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
    const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
    const marksFile = path.join(stateDir, '.downloaded.json');
    let marks = {};
    try {
        marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8'));
    }
    catch { }
    marks[filename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
    res.json({ success: true });
});
// Delete a video file
app.post('/api/grok/delete-video', (req, res) => {
    const { stateFile, filename } = req.body;
    if (!stateFile || !filename)
        return res.status(400).json({ error: 'Missing params' });
    const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
    const filepath = path.join(GROK_DOWNLOAD_DIR, stateName, filename);
    if (!fs.existsSync(filepath))
        return res.status(404).json({ error: 'File not found' });
    fs.unlinkSync(filepath);
    // Also remove from marks
    const marksFile = path.join(GROK_DOWNLOAD_DIR, stateName, '.downloaded.json');
    try {
        const marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8'));
        delete marks[filename];
        fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
    }
    catch { }
    res.json({ success: true });
});
// Jalankan server
app.listen(PORT, () => {
    console.log(`🚀 State Manager berjalan di http://localhost:${PORT}`);
    console.log(`🎬 TikTok Auto Uploader: http://localhost:${PORT}/tiktok`);
    console.log(`🧠 Grok Imagine Generator: http://localhost:${PORT}/grok`);
    console.log(`📁 Folder state: ${STATES_DIR} & ${GROK_STATES_DIR}`);
});
