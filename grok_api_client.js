// grok_api_client.ts - Client API Grok Imagine (State JSON, headless)
// DIPERBARUI: Pakai REST API baru (newgroksystem/generate.txt)
// Upload gambar -> POST /rest/app-chat/conversations/new (stream) -> unduh video.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
export class RateLimitError extends Error {
    availableAt;
    constructor(availableAt) {
        super(`Rate limit reached${availableAt ? '. Tersedia kembali: ' + availableAt : ''}`);
        this.name = 'RateLimitError';
        this.availableAt = availableAt;
    }
}
async function waitForGrokImagineReady(page, context, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    try {
        await page.waitForLoadState('load', { timeout: 30000 });
    }
    catch { }
    try {
        await page.waitForLoadState('networkidle', { timeout: 30000 });
    }
    catch { }
    while (Date.now() < deadline) {
        const cookies = await context.cookies('https://grok.com');
        const hasClearance = cookies.some(cookie => cookie.name === 'cf_clearance');
        const state = await page.evaluate(async () => {
            const hasApi = typeof window.__GROK_API_V2_GENERATE === 'function';
            let authenticated = false;
            let stale = false;
            try {
                const res = await fetch('https://grok.com/api/auth/session', { credentials: 'include' });
                const text = await res.text();
                authenticated = res.ok && /"session"\s*:/.test(text) && !/"session"\s*:\s*null/.test(text);
                stale = res.status === 403 && /out of date|reload to continue/i.test(text);
            }
            catch { }
            return { hasApi, authenticated, stale, readyState: document.readyState };
        });
        if (state.stale) {
            await page.reload({ waitUntil: 'load', timeout: 60000 });
            try {
                await page.waitForLoadState('networkidle', { timeout: 30000 });
            }
            catch { }
        }
        else if (state.hasApi && state.authenticated && (hasClearance || Date.now() + 15000 > deadline)) {
            await page.waitForTimeout(8000);
            return;
        }
        await page.waitForTimeout(2000);
    }
    throw new Error('Grok Imagine belum siap setelah menunggu halaman selesai loading.');
}
export async function checkGrokQuota(stateName = 'indra') {
    const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
    if (!fs.existsSync(statePath))
        throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: statePath });
    const page = await context.newPage();
    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded' });
    const quota = await page.evaluate(async () => {
        const res = await fetch('https://grok.com/rest/media/imagine/quota_info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        return res.json();
    });
    const session = await page.evaluate(async () => {
        const res = await fetch('https://grok.com/api/auth/session');
        return res.json();
    });
    await browser.close();
    return { account: session.session ? `${session.session.givenName} (${session.session.email})` : 'Unauthenticated', quota };
}
export async function createGrokV2Session(stateName = 'indra', headless = true, options = {}) {
    const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
    if (!fs.existsSync(statePath))
        throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);
    const browser = await chromium.launch({ headless, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'], ignoreDefaultArgs: ['--enable-automation'] });
    try {
        const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', locale: 'en-US', timezoneId: 'Asia/Makassar', storageState: statePath, acceptDownloads: true });
        const page = await context.newPage();
        const session = { browser, context, page, stateName, statsigId: '', requestMetadata: {} };
        const metadataHeaders = ['baggage', 'sentry-trace', 'traceparent'];
        page.on('request', request => {
            if (!request.url().startsWith('https://grok.com/'))
                return;
            const headers = request.headers();
            if (headers['x-statsig-id'])
                session.statsigId = headers['x-statsig-id'];
            for (const name of metadataHeaders) {
                if (!session.requestMetadata[name] && headers[name])
                    session.requestMetadata[name] = headers[name];
            }
        });
        // Opsi debug (grokv2-debug.js):
        //   options.initExtraScript  = string init-script tambahan (fetch logger, dll)
        //   options.afterPageCreated = async (page, context) => {} dipanggil sebelum navigasi
        if (options && typeof options.afterPageCreated === 'function') {
            await options.afterPageCreated(page, context);
        }
        const browserScriptPath = path.join(process.cwd(), 'grok_api_browser.js');
        if (!fs.existsSync(browserScriptPath))
            throw new Error(`File browser script tidak ditemukan: ${browserScriptPath}`);
        const browserScript = fs.readFileSync(browserScriptPath, 'utf-8');
        const extraInit = (options && typeof options.initExtraScript === 'string') ? options.initExtraScript : '';
        await page.addInitScript({ content: browserScript + `
      Object.defineProperty(navigator, 'webdriver', {
        get: function () { return undefined; }
      });
    ` + (extraInit ? '\n' + extraInit : '') });
        await page.goto('https://grok.com/imagine', { waitUntil: 'load', timeout: 60000 });
        await waitForGrokImagineReady(page, context);
        return session;
    }
    catch (error) {
        try {
            await browser.close();
        }
        catch { }
        throw error;
    }
}
export class TooManyRequestsError extends Error {
    retryAfterMs;
    constructor(retryAfterMs = 0) {
        super('Grok mengirim HTTP 429 Too Many Requests');
        this.name = 'TooManyRequestsError';
        this.retryAfterMs = retryAfterMs;
    }
}
async function grabFetchTrace(page, limit = 60) {
    if (!page)
        return [];
    try {
        return await page.evaluate((n) => Array.isArray(window.__GROK_FETCH_LOG) ? window.__GROK_FETCH_LOG.slice(-n) : [], limit);
    }
    catch (_) {
        return [];
    }
}
function fetchTraceLegend(trace, max = 25) {
    const rows = [];
    for (const e of trace || []) {
        const important = (e.status >= 400 && e.status !== 404) || e.status === 0
            || String(e.url).includes('conversations') || String(e.url).includes('quota_info')
            || String(e.url).includes('upload-file-v2');
        if (important) {
            rows.push(`${e.method || '?'} ${e.status || 'ERR'} ${e.ms}ms ${String(e.url).slice(0, 100)}${e.note ? ' | ' + e.note.slice(0, 160) : ''}`);
        }
        if (rows.length >= max)
            break;
    }
    return rows;
}
export async function closeGrokV2Session(session) {
    if (!session)
        return;
    try {
        await session.browser.close();
    }
    catch { }
}
export async function generateGrokVideoV2(options, onProgress, sharedSession) {
    const stateName = options.stateName || 'indra';
    const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
    if (!fs.existsSync(statePath))
        throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);
    const log = (msg, pct = 0) => { console.log(`[GROK_V2_NEW] ${msg}`); if (onProgress)
        onProgress(msg, pct); };
    let imageData = null;
    let imageMime = 'image/png';
    let imageName = 'image.png';
    if (options.imagePath) {
        const imgPath = path.isAbsolute(options.imagePath) ? options.imagePath : path.join(process.cwd(), options.imagePath);
        if (!fs.existsSync(imgPath))
            throw new Error(`File gambar tidak ditemukan: ${imgPath}`);
        const ext = path.extname(imgPath).toLowerCase();
        imageMime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
        imageName = path.basename(imgPath);
        imageData = fs.readFileSync(imgPath).toString('base64');
        log(`Membaca gambar referensi: ${imageName}`, 8);
    }
    const durationNum = parseInt(String(options.duration || '10s').replace(/\D/g, ''), 10) || 10;
    const resolution = options.resolution === '1080p' ? '1080p' : '720p';
    const aspectRatio = options.aspectRatio || '9:16';
    const prompt = (options.promptText || '').trim() || 'A stunning cinematic video sequence';
    if (sharedSession && sharedSession.stateName !== stateName) {
        throw new Error(`Sesi Grok untuk akun ${sharedSession.stateName} tidak cocok dengan akun ${stateName}`);
    }
    const ownsSession = !sharedSession;
    log(ownsSession
        ? `Memulai Headless Browser (State: ${stateName}, API baru)...`
        : `Menggunakan sesi Grok yang sudah terbuka (State: ${stateName})...`, 5);
    const session = sharedSession || await createGrokV2Session(stateName, options.headless ?? true);
    const { browser, context, page } = session;
    try {
        if (ownsSession)
            log('Grok Imagine siap dipakai untuk batch ini.', 12);
        if (session.statsigId || Object.keys(session.requestMetadata).length > 0)
            log('Metadata request Grok terdeteksi', 13);
        const runGeneration = () => page.evaluate((o) => {
            const generate = window.__GROK_API_V2_GENERATE;
            if (typeof generate !== 'function')
                throw new Error('Grok browser API script tidak terpasang');
            return generate(o);
        }, { prompt, imageData, imageMime, imageName, duration: durationNum, resolution, aspectRatio, statsigId: session.statsigId, requestMetadata: session.requestMetadata });
        // Polling progress
        let rateLimitDetectedAt = null;
        const poll = setInterval(async () => {
            try {
                const st = await page.evaluate(() => window.__GROK_NEW_STATE);
                if (st) {
                    if (typeof st.progress === 'number')
                        log(`Proses generate: ${st.progress}% - ${st.message || ''}`, Math.round(st.progress));
                    if (st.rateLimited) {
                        rateLimitDetectedAt = {
                            availableAt: st.availableAt || null,
                            transient: !!st.transientRateLimit || st.httpStatus === 429,
                            retryAfterMs: Number(st.retryAfterMs) || 0
                        };
                        log(st.transientRateLimit ? 'Too many requests terdeteksi' : 'Rate limit terdeteksi');
                    }
                }
            }
            catch { }
        }, 2500);
        let result;
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                result = await runGeneration();
                if (!result?.stalePage)
                    break;
                if (attempt >= 2)
                    break;
                log(`Grok meminta halaman dimuat ulang, refresh fresh attempt ${attempt + 1}/2...`, 14);
                session.statsigId = '';
                session.requestMetadata = {};
                await page.goto(`https://grok.com/imagine?fresh=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
                await waitForGrokImagineReady(page, context);
                await page.waitForTimeout(5000);
            }
        }
        finally {
            clearInterval(poll);
        }
        const detectedRateLimit = rateLimitDetectedAt;
        if (result?.rateLimited || detectedRateLimit) {
            const availableAt = result?.availableAt || detectedRateLimit?.availableAt || null;
            const isTooManyRequests = !!result?.transientRateLimit
                || result?.httpStatus === 429
                || !!detectedRateLimit?.transient;
            if (isTooManyRequests) {
                const retryAfterMs = Number(result?.retryAfterMs) || detectedRateLimit?.retryAfterMs || 0;
                const fetchTrace = await grabFetchTrace(page);
                const traceLegend = fetchTraceLegend(fetchTrace);
                if (traceLegend.length > 0) {
                    log('Trace fetch rate-limit (http 429):\n' + traceLegend.join('\n'));
                }
                log('Too many requests. Menunggu sebelum mencoba raw yang sama lagi.');
                if (ownsSession)
                    await closeGrokV2Session(session);
                const err429 = new TooManyRequestsError(retryAfterMs);
                err429.fetchTrace = fetchTrace;
                throw err429;
            }
            const fetchTrace = await grabFetchTrace(page);
            const traceLegend = fetchTraceLegend(fetchTrace);
            if (traceLegend.length > 0) {
                log('Trace fetch rate-limit (kuota akun):\n' + traceLegend.join('\n'));
            }
            log('Rate limit! Tersedia kembali: ' + (availableAt || 'tidak diketahui'));
            if (ownsSession)
                await closeGrokV2Session(session);
            throw new RateLimitError(availableAt);
        }
        if (!result || result.status !== 'done' || !result.videoUrl) {
            throw new Error(result?.error || 'Generasi video gagal di Grok (API baru).');
        }
        log(`Video berhasil di-generate! Mengunduh file hasil...`, 92);
        const downloadDir = path.join(process.cwd(), 'grok-downloads', stateName);
        if (!fs.existsSync(downloadDir))
            fs.mkdirSync(downloadDir, { recursive: true });
        const fname = `grok_v2_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
        const savePath = path.join(downloadDir, fname);
        let saved = false;
        const rawVideoUrl = String(result.videoUrl || '');
        const mediaPath = rawVideoUrl.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+/, '');
        const downloadUrls = /^https?:\/\//i.test(rawVideoUrl)
            ? [rawVideoUrl]
            : [`https://assets.grok.com/${mediaPath}`, `https://grok.com/${mediaPath}`];
        for (const downloadUrl of downloadUrls) {
            try {
                // Match the successful browser request captured in methodgrok/download-grokk.md.
                // APIRequestContext shares cookies with this BrowserContext and avoids CORS.
                log(`Mengunduh via request langsung: ${downloadUrl.substring(0, 90)}...`);
                const response = await context.request.get(downloadUrl, {
                    headers: { Accept: '*/*', Range: 'bytes=0-', Referer: 'https://grok.com/' },
                    timeout: 120000,
                    failOnStatusCode: false
                });
                if (!response.ok()) {
                    log(`Download HTTP ${response.status()} dari ${new URL(downloadUrl).hostname}`);
                    continue;
                }
                const videoBytes = await response.body();
                if (videoBytes.length === 0) {
                    log('Download mengembalikan body kosong');
                    continue;
                }
                fs.writeFileSync(savePath, videoBytes);
                saved = true;
                log(`Download berhasil (${response.status()}, ${videoBytes.length} bytes)`);
                break;
            }
            catch (e) {
                log(`Peringatan mengunduh dari ${downloadUrl.substring(0, 70)}: ${e.message}`);
            }
        }
        if (ownsSession)
            await closeGrokV2Session(session);
        if (!saved)
            throw new Error(`Gagal menyimpan file video ke ${savePath}`);
        log(`Video berhasil disimpan di ${savePath}`, 100);
        return { success: true, filename: fname, savePath, downloadUrl: `/api/grok/video-file/${stateName}/${fname}`, rawUrl: result.videoUrl || '' };
    }
    catch (error) {
        if (ownsSession)
            await closeGrokV2Session(session);
        log('Error: ' + error.message);
        throw error;
    }
}
if (process.argv[1]?.includes('grok_api_client')) {
    checkGrokQuota('indra').then(res => console.log('Quota:', JSON.stringify(res, null, 2))).catch(console.error);
}
