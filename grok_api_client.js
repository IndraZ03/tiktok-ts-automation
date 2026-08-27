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
export async function generateGrokVideoV2(options, onProgress) {
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
    log(`Memulai Headless Browser (State: ${stateName}, API baru)...`, 5);
    const browser = await chromium.launch({ headless: options.headless ?? true, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'], ignoreDefaultArgs: ['--enable-automation'] });
    try {
        const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', locale: 'en-US', timezoneId: 'Asia/Makassar', storageState: statePath, acceptDownloads: true });
        const page = await context.newPage();
        await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
        log('Membuka Grok Imagine...', 12);
        await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        const genPromise = page.evaluate(async (o) => {
            const STATE = { status: 'running', progress: 0, message: '', videoUrl: '', videoId: '', assetId: '', conversationId: '', error: '', rateLimited: false, availableAt: null };
            window.__GROK_NEW_STATE = STATE;
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const readLines = async (resp, onLine) => {
                if (!resp.body) {
                    resp.text().then(t => t.split('\n').forEach(onLine));
                    return;
                }
                const reader = resp.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buf += dec.decode(value, { stream: true });
                    while (true) {
                        const i = buf.indexOf('\n');
                        if (i < 0)
                            break;
                        onLine(buf.slice(0, i));
                        buf = buf.slice(i + 1);
                    }
                }
                if (buf.trim())
                    onLine(buf.trim());
            };
            const findVideo = (obj) => {
                if (!obj || typeof obj !== 'object')
                    return null;
                if (Array.isArray(obj)) {
                    for (const it of obj) {
                        const v = findVideo(it);
                        if (v)
                            return v;
                    }
                    return null;
                }
                if (typeof obj.videoUrl === 'string' && obj.videoUrl.includes('generated_video'))
                    return obj.videoUrl;
                for (const k of Object.keys(obj)) {
                    const v = findVideo(obj[k]);
                    if (v)
                        return v;
                }
                return null;
            };
            const handleLine = (line) => {
                if (!line)
                    return;
                if (line.startsWith('data:'))
                    line = line.replace(/^data:\s*/, '').trim();
                if (!line.startsWith('{'))
                    return;
                let o2 = null;
                try {
                    o2 = JSON.parse(line);
                }
                catch {
                    return;
                }
                const result = o2 && o2.result;
                if (!result)
                    return;
                if (result.conversation && result.conversation.conversationId)
                    STATE.conversationId = result.conversation.conversationId;
                const r = result.response || {};
                if (r.streamingVideoGenerationResponse) {
                    const sv = r.streamingVideoGenerationResponse;
                    if (typeof sv.progress === 'number')
                        STATE.progress = Math.min(88, 38 + sv.progress * 0.5);
                    if (sv.videoUrl)
                        STATE.videoUrl = sv.videoUrl;
                    if (sv.videoId)
                        STATE.videoId = sv.videoId;
                    if (sv.progress >= 100)
                        STATE.status = 'done';
                }
                if (r.error)
                    STATE.error = String(r.error);
            };
            try {
                let assetId = null;
                if (o.imageData) {
                    STATE.message = 'Mengunggah gambar referensi ke Grok...';
                    STATE.progress = 20;
                    const bin = atob(o.imageData);
                    const arr = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++)
                        arr[i] = bin.charCodeAt(i);
                    const fd = new FormData();
                    fd.append('file', new File([arr], o.imageName, { type: o.imageMime }));
                    const up = await fetch('https://grok.com/http/upload-file-v2/direct', { method: 'POST', body: fd });
                    const t = await up.text();
                    if (!up.ok)
                        throw new Error('Upload gambar gagal HTTP ' + up.status + ': ' + t.slice(0, 200));
                    let j = null;
                    try {
                        j = JSON.parse(t);
                    }
                    catch { }
                    assetId = (j && j.fileMetadata && j.fileMetadata.fileMetadataId) || (j && j.fileMetadataId) || null;
                    if (!assetId)
                        throw new Error('Upload gambar tanpa fileMetadataId: ' + t.slice(0, 200));
                    STATE.message = 'Gambar terunggah';
                    STATE.progress = 28;
                }
                const body = {
                    modelName: 'imagine-video-gen',
                    message: prompt + ' --mode=custom',
                    enableImageStreaming: true,
                    enableSideBySide: true,
                    sendFinalMetadata: true,
                    responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } },
                    mediaGenInput: { imageToVideo: { prompt, inputAssets: assetId ? [assetId] : [], aspectRatio: o.aspectRatio, duration: o.duration, resolutionName: o.resolution, mode: 'custom' } },
                    kind: 'CONVERSATION_KIND_IMAGINE'
                };
                STATE.message = 'Membuat permintaan generasi video...';
                STATE.progress = 32;
                const resp = await fetch('https://grok.com/rest/app-chat/conversations/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if (!resp.ok) {
                    const t = await resp.text();
                    if (/rate\s*limit|limit/i.test(t)) {
                        STATE.rateLimited = true;
                        STATE.error = t.slice(0, 300);
                    }
                    else
                        throw new Error('Generate video gagal HTTP ' + resp.status + ': ' + t.slice(0, 300));
                    return STATE;
                }
                STATE.progress = 35;
                STATE.message = 'Memproses prompt (0 - 100%)...';
                await readLines(resp, handleLine);
                if (!STATE.videoUrl && STATE.conversationId) {
                    STATE.message = 'Menunggu video (polling responses)...';
                    for (let k = 0; k < 40; k++) {
                        await sleep(3000);
                        try {
                            const rr = await fetch('https://grok.com/rest/app-chat/conversations/' + STATE.conversationId + '/responses?conversationKind=CONVERSATION_KIND_IMAGINE');
                            const tt = await rr.text();
                            let jj = null;
                            try {
                                jj = JSON.parse(tt);
                            }
                            catch { }
                            const v = findVideo(jj);
                            if (v) {
                                STATE.videoUrl = v;
                                STATE.status = 'done';
                                break;
                            }
                        }
                        catch { }
                    }
                }
                if (STATE.videoUrl)
                    STATE.status = 'done';
                STATE.progress = 90;
                STATE.message = 'Selesai, siap diunduh';
            }
            catch (e) {
                STATE.status = 'error';
                STATE.error = String((e && e.message) || e);
            }
            return STATE;
        }, { prompt, imageData, imageMime, imageName, duration: durationNum, resolution, aspectRatio });
        // Polling progress
        let rateLimitDetectedAt = null;
        const poll = setInterval(async () => {
            try {
                const st = await page.evaluate(() => window.__GROK_NEW_STATE);
                if (st) {
                    if (typeof st.progress === 'number')
                        log(`Proses generate: ${st.progress}% - ${st.message || ''}`, Math.round(st.progress));
                    if (st.rateLimited) {
                        rateLimitDetectedAt = { availableAt: st.availableAt || null };
                        log('Rate limit terdeteksi');
                    }
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
        if (result?.rateLimited || rateLimitDetectedAt) {
            const availableAt = result?.availableAt || rateLimitDetectedAt?.availableAt || null;
            log('Rate limit! Tersedia kembali: ' + (availableAt || 'tidak diketahui'));
            await browser.close();
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
        try {
            const dr = await page.evaluate(async (relUrl) => {
                const readBlob = async (url) => {
                    const r = await fetch(url, { credentials: 'include' });
                    if (!r.ok)
                        return null;
                    const b = await r.blob();
                    const rd = new FileReader();
                    return await new Promise(res => { rd.onloadend = () => res({ ok: true, data: rd.result }); rd.onerror = () => res({ ok: false }); rd.readAsDataURL(b); });
                };
                if (relUrl.startsWith('http://') || relUrl.startsWith('https://')) {
                    try {
                        const d = await readBlob(relUrl);
                        if (d && d.ok)
                            return d;
                    }
                    catch { }
                }
                for (const url of ['https://assets.grok.com/' + relUrl, 'https://grok.com/' + relUrl]) {
                    try {
                        const d = await readBlob(url);
                        if (d && d.ok)
                            return d;
                    }
                    catch { }
                }
                return { ok: false, error: 'Semua URL unduhan gagal' };
            }, result.videoUrl);
            if (dr?.ok && dr.data) {
                fs.writeFileSync(savePath, Buffer.from(dr.data.split(',')[1], 'base64'));
                saved = true;
            }
        }
        catch (e) {
            log('Peringatan mengunduh: ' + e.message);
        }
        await browser.close();
        if (!saved)
            throw new Error(`Gagal menyimpan file video ke ${savePath}`);
        log(`Video berhasil disimpan di ${savePath}`, 100);
        return { success: true, filename: fname, savePath, downloadUrl: `/api/grok/video-file/${stateName}/${fname}`, rawUrl: result.videoUrl || '' };
    }
    catch (error) {
        try {
            await browser.close();
        }
        catch { }
        log('Error: ' + error.message);
        throw error;
    }
}
if (process.argv[1]?.includes('grok_api_client')) {
    checkGrokQuota('indra').then(res => console.log('Quota:', JSON.stringify(res, null, 2))).catch(console.error);
}
