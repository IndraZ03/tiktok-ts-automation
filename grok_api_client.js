// grok_api_client.ts - Client untuk memanggil API Grok Imagine secara Headless dengan State JSON
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export async function checkGrokQuota(stateName = 'indra') {
    const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
    if (!fs.existsSync(statePath)) {
        throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);
    }
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: statePath });
    const page = await context.newPage();
    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded' });
    const quota = await page.evaluate(async () => {
        const res = await fetch('https://grok.com/rest/media/imagine/quota_info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        return res.json();
    });
    const session = await page.evaluate(async () => {
        const res = await fetch('https://grok.com/api/auth/session');
        return res.json();
    });
    await browser.close();
    return {
        account: session.session ? `${session.session.givenName} (${session.session.email})` : 'Unauthenticated',
        quota
    };
}
export async function generateGrokVideoV2(options, onProgress) {
    const stateName = options.stateName || 'indra';
    const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
    if (!fs.existsSync(statePath)) {
        throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);
    }
    const log = (msg, pct = 0) => {
        console.log(`[GROK_V2_API] ${msg}`);
        if (onProgress)
            onProgress(msg, pct);
    };
    log(`Memulai Headless Browser Context (State: ${stateName})...`, 5);
    const browser = await chromium.launch({
        headless: options.headless ?? true,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        ignoreDefaultArgs: ['--enable-automation'],
    });
    try {
        const context = await browser.newContext({
            viewport: { width: 1366, height: 768 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'Asia/Makassar',
            storageState: statePath,
            acceptDownloads: true,
        });
        const page = await context.newPage();
        await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
        log('Membuka Grok Imagine secara Headless...', 15);
        await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        // Inject automation script grok_autoV2.js
        const scriptPath = path.join(process.cwd(), 'grok_autoV2.js');
        if (!fs.existsSync(scriptPath)) {
            throw new Error(`grok_autoV2.js tidak ditemukan di ${scriptPath}`);
        }
        const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
        await page.evaluate(scriptContent);
        await page.waitForTimeout(1000);
        let imageBase64 = null;
        let imageName = null;
        if (options.imagePath && fs.existsSync(options.imagePath)) {
            log(`Membaca file bahan gambar: ${path.basename(options.imagePath)}...`, 25);
            const imgBuffer = fs.readFileSync(options.imagePath);
            imageBase64 = imgBuffer.toString('base64');
            imageName = path.basename(options.imagePath);
        }
        log(`Memulai proses pengiriman prompt & konfigurasi video...`, 35);
        const genCfg = {
            prompt: options.promptText,
            mode: (options.mode || 'video').toLowerCase() === 'image' ? 'image' : 'video',
            image: imageBase64,
            imageName: imageName || 'ref.jpg',
            timeout: 600000,
            upscale: false,
            useImageRef: !!imageBase64,
            genMode: options.mode || 'Video',
            resolution: options.resolution || '720p',
            duration: options.duration || '5s',
            aspectRatio: options.aspectRatio || '9:16',
        };
        const genPromise = page.evaluate(async (cfg) => window.__grokGenerate(cfg), genCfg);
        const poll = setInterval(async () => {
            try {
                const st = await page.evaluate(() => window.__grokGetState());
                if (st && st.progress >= 0) {
                    log(`Proses generate: ${st.progress}%`, Math.min(90, 35 + Math.floor(st.progress * 0.55)));
                }
            }
            catch { }
        }, 2500);
        let result;
        try {
            result = await genPromise;
        }
        finally {
            clearInterval(poll);
        }
        if (!result || result.status !== 'done') {
            throw new Error(result?.error || 'Generasi video gagal di Grok');
        }
        log(`Video berhasil di-generate! Mengunduh file hasil...`, 92);
        const downloadDir = path.join(process.cwd(), 'grok-downloads', stateName);
        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
        }
        const fname = `grok_v2_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
        const savePath = path.join(downloadDir, fname);
        let saved = false;
        // Direct download strategy via fetch inside page context
        if (result.videoUrl?.startsWith('https://')) {
            try {
                const dr = await page.evaluate(async (url) => {
                    try {
                        const r = await fetch(url, { credentials: 'include' });
                        if (!r.ok)
                            return { ok: false, error: `HTTP ${r.status}` };
                        const b = await r.blob();
                        const rd = new FileReader();
                        return new Promise(res => {
                            rd.onloadend = () => res({ ok: true, data: rd.result });
                            rd.onerror = () => res({ ok: false });
                            rd.readAsDataURL(b);
                        });
                    }
                    catch (e) {
                        return { ok: false, error: e.message };
                    }
                }, result.videoUrl);
                if (dr?.ok && dr.data) {
                    fs.writeFileSync(savePath, Buffer.from(dr.data.split(',')[1], 'base64'));
                    saved = true;
                }
            }
            catch (e) {
                log(`Peringatan download Strategy A: ${e.message}`);
            }
        }
        await browser.close();
        if (!saved) {
            throw new Error(`Gagal menyimpan file video ke ${savePath}`);
        }
        log(`✅ Video berhasil disimpan di ${savePath}`, 100);
        return {
            success: true,
            filename: fname,
            savePath,
            downloadUrl: `/api/grok/video-file/${stateName}/${fname}`,
            rawUrl: result.videoUrl || ''
        };
    }
    catch (error) {
        try {
            await browser.close();
        }
        catch { }
        log(`❌ Error: ${error.message}`);
        throw error;
    }
}
// Test runner
if (process.argv[1]?.includes('grok_api_client')) {
    checkGrokQuota('indra').then(res => {
        console.log('✅ Auth & Quota Result:', JSON.stringify(res, null, 2));
    }).catch(console.error);
}
