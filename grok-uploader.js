// grok-uploader.ts
// Playwright-driven Grok Imagine automation – multi-browser parallel
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
let activeBrowsers = [];
let isRunning = false;
let stats = { success: 0, failed: 0, saved: 0 };
let browserProgress = [];
export function getGrokIsRunning() { return isRunning; }
export function getGrokStats() { return { ...stats }; }
export function getBrowserProgress() { return browserProgress.map(b => ({ ...b })); }
export async function stopGrokGenerator() {
    isRunning = false;
    for (const b of activeBrowsers) {
        try {
            await b.close();
        }
        catch { }
    }
    activeBrowsers = [];
}
// ── Helpers ──
async function waitAndLog(page, log, ms, reason) {
    log(`⏳ Menunggu ${ms / 1000}s (${reason})...`);
    await page.waitForTimeout(ms);
}
function pickRandomImage(folderPath) {
    if (!fs.existsSync(folderPath))
        return null;
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
    const images = fs.readdirSync(folderPath)
        .filter(f => exts.includes(path.extname(f).toLowerCase()));
    if (images.length === 0)
        return null;
    const pick = images[Math.floor(Math.random() * images.length)];
    return path.join(folderPath, pick);
}
function loadPromptFromFile(filepath) {
    try {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        // Support { prompt: "..." } or { prompts: ["...", "..."] }
        if (typeof data.prompt === 'string')
            return data.prompt;
        if (Array.isArray(data.prompts) && data.prompts.length > 0) {
            return data.prompts[Math.floor(Math.random() * data.prompts.length)];
        }
        // Fallback: first string value in the object
        for (const val of Object.values(data)) {
            if (typeof val === 'string' && val.length > 5)
                return val;
        }
        return null;
    }
    catch {
        return null;
    }
}
function imageToBase64(filepath) {
    const buf = fs.readFileSync(filepath);
    return buf.toString('base64');
}
// ── Read the grok_autoV2.js script once ──
let grokScript = null;
function getGrokScript(baseDir) {
    if (grokScript)
        return grokScript;
    const scriptPath = path.join(baseDir, 'grok_autoV2.js');
    if (!fs.existsSync(scriptPath)) {
        throw new Error('grok_autoV2.js not found at: ' + scriptPath);
    }
    grokScript = fs.readFileSync(scriptPath, 'utf-8');
    return grokScript;
}
// ════════════════════════════════════════════════════════════
//  ORCHESTRATOR — N browsers, 1 state, videos split evenly
// ════════════════════════════════════════════════════════════
export async function runGrokGenerator(config, log, baseDir) {
    isRunning = true;
    stats = { success: 0, failed: 0, saved: 0 };
    activeBrowsers = [];
    const stateFilePath = path.join(config.statesDir, config.stateFile);
    if (!fs.existsSync(stateFilePath)) {
        log('❌ State file tidak ditemukan: ' + stateFilePath);
        isRunning = false;
        return;
    }
    const bahanFolderPath = path.join(config.bahanDir, config.bahanFolder);
    const promptFilePath = path.join(config.promptDir, config.promptFile);
    if (config.bahanFolder && !fs.existsSync(bahanFolderPath)) {
        log('⚠ Folder bahan tidak ditemukan — lanjut tanpa gambar');
    }
    if (!fs.existsSync(promptFilePath)) {
        log('❌ Prompt file tidak ditemukan: ' + promptFilePath);
        isRunning = false;
        return;
    }
    const stateName = config.stateFile.replace('grok-state-', '').replace('.json', '');
    const stateDownloadDir = path.join(config.downloadDir, stateName);
    if (!fs.existsSync(stateDownloadDir))
        fs.mkdirSync(stateDownloadDir, { recursive: true });
    const total = Math.max(1, config.totalVideos || 1);
    const numBrowsers = Math.min(total, 5); // auto: 1 browser per video, max 5
    // Distribute evenly
    const perBrowser = [];
    const base = Math.floor(total / numBrowsers);
    const remainder = total % numBrowsers;
    for (let i = 0; i < numBrowsers; i++)
        perBrowser.push(base + (i < remainder ? 1 : 0));
    log(`🚀 ${numBrowsers} browser × [${perBrowser.join(',')}] = ${total} total video`);
    log(`📂 grok-downloads/${stateName}/`);
    log(`⚙️ ${config.mode} | ${config.resolution} | ${config.duration} | ${config.aspectRatio}`);
    browserProgress = perBrowser.map((t, i) => ({
        id: i, status: 'idle', current: 0, total: t, progress: 0, message: 'Menunggu...',
    }));
    const script = getGrokScript(baseDir);
    const workers = perBrowser.map((count, idx) => runBrowserWorker(idx, count, config, stateFilePath, stateDownloadDir, bahanFolderPath, promptFilePath, script, log));
    await Promise.allSettled(workers);
    for (const b of activeBrowsers) {
        try {
            await b.close();
        }
        catch { }
    }
    activeBrowsers = [];
    isRunning = false;
    log(`\n✅ Semua selesai — ✅ ${stats.success} | ❌ ${stats.failed} | 💾 ${stats.saved}`);
}
// ════════════════════════════════════════════════════════════
//  PER-BROWSER WORKER
// ════════════════════════════════════════════════════════════
async function runBrowserWorker(idx, count, config, stateFilePath, downloadDir, bahanFolderPath, promptFilePath, script, log) {
    const tag = `[B${idx}]`;
    const bp = browserProgress[idx];
    bp.status = 'running';
    bp.message = 'Launching...';
    try {
        const browser = await chromium.launch({
            headless: config.headless ?? true, slowMo: 80, channel: 'chrome',
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
            ignoreDefaultArgs: ['--enable-automation'],
        });
        activeBrowsers.push(browser);
        const context = await browser.newContext({
            viewport: { width: 1366, height: 768 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            locale: 'en-US', timezoneId: 'Asia/Makassar',
            permissions: ['geolocation'],
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
            storageState: stateFilePath, acceptDownloads: true,
        });
        const page = await context.newPage();
        await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
        log(`${tag} 🌐 Browser launched`);
        bp.message = 'Navigating...';
        await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        await page.evaluate(script);
        await page.waitForTimeout(1000);
        const injected = await page.evaluate(() => !!window.__GROK_AUTO_V2_INJECTED);
        if (!injected) {
            log(`${tag} ❌ Inject gagal`);
            bp.status = 'error';
            bp.message = 'Inject failed';
            return;
        }
        log(`${tag} ✅ Ready`);
        for (let i = 0; i < count && isRunning; i++) {
            bp.current = i;
            bp.progress = 0;
            bp.message = `Generating ${i + 1}/${count}`;
            const prompt = loadPromptFromFile(promptFilePath);
            if (!prompt) {
                log(`${tag} ❌ Prompt error`);
                stats.failed++;
                bp.status = 'error';
                break;
            }
            let imageBase64 = null;
            let imageName = null;
            if (config.bahanFolder && fs.existsSync(bahanFolderPath)) {
                const imgPath = pickRandomImage(bahanFolderPath);
                if (imgPath) {
                    imageBase64 = imageToBase64(imgPath);
                    imageName = path.basename(imgPath);
                }
            }
            if (i > 0) {
                await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForTimeout(3000);
                await page.evaluate(script);
                await page.waitForTimeout(500);
            }
            log(`${tag} 🎬 #${i + 1}/${count} — "${prompt.substring(0, 50)}..."`);
            const genCfg = {
                prompt, mode: config.mode.toLowerCase() === 'image' ? 'image' : 'video',
                image: imageBase64, imageName: imageName || 'ref.jpg', timeout: 600000,
                upscale: false, useImageRef: !!imageBase64,
                genMode: config.mode, resolution: config.resolution,
                duration: config.duration, aspectRatio: config.aspectRatio,
            };
            const genPromise = page.evaluate(async (cfg) => window.__grokGenerate(cfg), genCfg);
            const poll = setInterval(async () => {
                try {
                    if (!isRunning) {
                        clearInterval(poll);
                        return;
                    }
                    const st = await page.evaluate(() => window.__grokGetState());
                    if (st && st.progress >= 0)
                        bp.progress = st.progress;
                }
                catch { }
            }, 2500);
            let result;
            try {
                result = await genPromise;
            }
            catch (e) {
                log(`${tag} ❌ Error: ${e.message}`);
                stats.failed++;
                clearInterval(poll);
                continue;
            }
            clearInterval(poll);
            bp.progress = 100;
            if (!isRunning)
                break;
            if (result?.status === 'done') {
                stats.success++;
                log(`${tag} ✅ Generate done! videoUrl: ${result.videoUrl || 'NONE'} | keys: ${Object.keys(result).join(',')}`);
                const ext = config.mode.toLowerCase() === 'image' ? '.png' : '.mp4';
                const fname = `grok_${Date.now()}_b${idx}_${i + 1}${ext}`;
                const savePath = path.join(downloadDir, fname);
                log(`${tag} 📂 savePath: ${savePath}`);
                let saved = false;
                // Strategy A: fetch videoUrl with credentials from page context
                if (result.videoUrl?.startsWith('https://')) {
                    log(`${tag} 📥 Strategy A: fetch ${result.videoUrl.substring(0, 60)}...`);
                    try {
                        const dr = await page.evaluate(async (url) => {
                            try {
                                const r = await fetch(url, { credentials: 'include' });
                                if (!r.ok)
                                    return { ok: false, error: `HTTP ${r.status}` };
                                const b = await r.blob();
                                const rd = new FileReader();
                                return new Promise(res => { rd.onloadend = () => res({ ok: true, data: rd.result }); rd.onerror = () => res({ ok: false }); rd.readAsDataURL(b); });
                            }
                            catch (e) {
                                return { ok: false, error: e.message };
                            }
                        }, result.videoUrl);
                        if (dr?.ok && dr.data) {
                            fs.writeFileSync(savePath, Buffer.from(dr.data.split(',')[1], 'base64'));
                            saved = true;
                            log(`${tag} ✅ Strategy A berhasil`);
                        }
                        else {
                            log(`${tag} ⚠ Strategy A gagal: ${dr?.error || 'no data'}`);
                        }
                    }
                    catch (e) {
                        log(`${tag} ⚠ Strategy A error: ${e.message}`);
                    }
                }
                // Strategy B: click download button + intercept download/new-tab
                if (!saved) {
                    log(`${tag} 📥 Strategy B: click download button...`);
                    try {
                        const dlP = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
                        const ppP = page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null);
                        await page.evaluate(() => {
                            // Try specific selectors first
                            for (const s of ['button[aria-label="Download"]', 'button[aria-label="Unduh"]', 'a[download]']) {
                                const el = document.querySelector(s);
                                if (el) {
                                    el.click();
                                    return;
                                }
                            }
                            // Fallback: find any download-like button
                            document.querySelectorAll('button').forEach(b => {
                                const t = (b.textContent || '').toLowerCase();
                                const l = (b.getAttribute('aria-label') || '').toLowerCase();
                                if (t.includes('download') || l.includes('download'))
                                    b.click();
                            });
                        });
                        const [dl, np] = await Promise.all([dlP, ppP]);
                        if (dl) {
                            await dl.saveAs(savePath);
                            saved = true;
                            log(`${tag} ✅ Strategy B berhasil (download event)`);
                        }
                        else if (np) {
                            const tabUrl = np.url();
                            await np.close();
                            log(`${tag} 📥 Strategy B: new tab → ${tabUrl.substring(0, 60)}...`);
                            if (tabUrl?.startsWith('https://')) {
                                const fr = await page.evaluate(async (u) => {
                                    try {
                                        const r = await fetch(u, { credentials: 'include' });
                                        if (!r.ok)
                                            return { ok: false, error: `HTTP ${r.status}` };
                                        const b = await r.blob();
                                        const rd = new FileReader();
                                        return new Promise(res => { rd.onloadend = () => res({ ok: true, data: rd.result }); rd.readAsDataURL(b); });
                                    }
                                    catch (e) {
                                        return { ok: false, error: e.message };
                                    }
                                }, tabUrl);
                                if (fr?.ok && fr.data) {
                                    fs.writeFileSync(savePath, Buffer.from(fr.data.split(',')[1], 'base64'));
                                    saved = true;
                                    log(`${tag} ✅ Strategy B berhasil (new-tab fetch)`);
                                }
                                else {
                                    log(`${tag} ⚠ Strategy B new-tab fetch gagal: ${fr?.error || 'no data'}`);
                                }
                            }
                        }
                        else {
                            log(`${tag} ⚠ Strategy B: no download event or new tab`);
                        }
                    }
                    catch (e) {
                        log(`${tag} ⚠ Strategy B error: ${e.message}`);
                    }
                }
                // Strategy C: find video/image src in DOM and fetch
                if (!saved) {
                    log(`${tag} 📥 Strategy C: extract media src from DOM...`);
                    try {
                        const mediaUrl = await page.evaluate(() => {
                            // Try video element
                            const vid = document.querySelector('video source');
                            if (vid?.src)
                                return vid.src;
                            const vidEl = document.querySelector('video');
                            if (vidEl?.src)
                                return vidEl.src;
                            // Try image
                            const imgs = document.querySelectorAll('img[src*="assets.grok"]');
                            if (imgs.length > 0)
                                return imgs[imgs.length - 1].src;
                            return null;
                        });
                        if (mediaUrl) {
                            log(`${tag} 📥 Strategy C: fetching ${mediaUrl.substring(0, 60)}...`);
                            const cr = await page.evaluate(async (u) => {
                                try {
                                    const r = await fetch(u, { credentials: 'include' });
                                    if (!r.ok)
                                        return { ok: false, error: `HTTP ${r.status}` };
                                    const b = await r.blob();
                                    const rd = new FileReader();
                                    return new Promise(res => { rd.onloadend = () => res({ ok: true, data: rd.result }); rd.readAsDataURL(b); });
                                }
                                catch (e) {
                                    return { ok: false, error: e.message };
                                }
                            }, mediaUrl);
                            if (cr?.ok && cr.data) {
                                fs.writeFileSync(savePath, Buffer.from(cr.data.split(',')[1], 'base64'));
                                saved = true;
                                log(`${tag} ✅ Strategy C berhasil`);
                            }
                            else {
                                log(`${tag} ⚠ Strategy C gagal: ${cr?.error || 'no data'}`);
                            }
                        }
                        else {
                            log(`${tag} ⚠ Strategy C: no media element found in DOM`);
                        }
                    }
                    catch (e) {
                        log(`${tag} ⚠ Strategy C error: ${e.message}`);
                    }
                }
                if (saved) {
                    stats.saved++;
                    log(`${tag} 📥 ${fname}`);
                    bp.message = `Saved #${i + 1}`;
                }
                else {
                    log(`${tag} ⚠ DL gagal #${i + 1}`);
                    bp.message = `DL fail #${i + 1}`;
                }
            }
            else if (result?.status === 'rate_limited') {
                log(`${tag} 🚫 Rate limited! Menghentikan semua proses...`);
                stats.failed++;
                bp.message = 'Rate limited!';
                stopGrokGenerator();
                break;
            }
            else {
                log(`${tag} ❌ ${result?.error || 'unknown'}`);
                stats.failed++;
            }
            bp.current = i + 1;
            if (isRunning && i < count - 1)
                await page.waitForTimeout(2000);
        }
        bp.status = 'done';
        bp.current = count;
        bp.progress = 100;
        bp.message = `Done (${count})`;
        log(`${tag} ✅ Worker done`);
    }
    catch (e) {
        log(`${tag} ❌ Fatal: ${e.message}`);
        bp.status = 'error';
        bp.message = e.message;
    }
}
