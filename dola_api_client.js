// dola_api_client.js
// Client generate video Image-to-Video via Dola AI (https://www.dola.com).
//
// ══════════════════════════════════════════════════════════════════
//  ANALISIS DARI CAPTURE (C:\tiktok-ts-automation\dolaai & \newdola)
//  Flow nyata di browser saat: upload -> generate -> download:
//   1) POST /im/chain/recent_conv (dan /im/chain/single)  -> buka/refresh percakapan
//   2) Upload gambar memakai service IMAGEX (imagex-ap-southeast-1.bytevcloudapi.com):
//        GET  ?Action=ApplyImageUpload&FileSize=..&FileExtension=.png
//             => dapat StoreUri "tos-mya-i-<ServiceId>/<hash>.png",
//                Auth (token upload), UploadID, SessionKey, UploadHosts.
//        PUT  https://<UploadHost>/<StoreUri>?uploads=<UploadID>   (upload file asli)
//        POST ?Action=CommitImageUpload  => URI final gambar siap dipakai.
//   3) POST /alice/message/pre_handle_v2_without_conv -> mulai pesan baru + lampiran.
//   4) POST /chat/completion (SSE text/event-stream)   -> GENERATE (inti).
//        body: lampiran gambar (uri + width/height) + teks prompt.
//        *Durasi* & *rasio* diekpresikan lewat prompt ("10-second ..."), dan rasio
//        output mengikuti dimensi gambar input (contoh 941x1672 = 9:16).
//   5) SSE berisi metadata output: muncul attachment video CDN (message_type video).
//   6) GET https://v16-dola.dola.com/<key>/<key>/video/tos/.../tos-mya-ve-50851/<file>/?..&download=true
//        -> unduh file mp4 (HTTP 206 partial). Ini request GAMBAR tsb.
//
//  Parameter "a_bogus" & "msToken" (dan sejenisnya) dihasilkan di sisi klien oleh
//  JS signature ByteDance. Oleh karena itu client ini menjalankan BROWSER ASLI
//  (Playwright + Chrome) memakai SESSION (cookie) dari dolaai/dola-session.json,
//  sehingga seluruh signature dibuat otomatis oleh situs, lalu memindai hasil video
//  di DOM/network dan mengunduh videonya di server.
// ══════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ffmpegPath = ffmpegStatic;
const DOLA_DOWNLOAD_DIR = path.join(__dirname, 'dola-downloads');
const SESSION_FILE = path.join(__dirname, 'dolaai', 'dola-session.json');

if (!fs.existsSync(DOLA_DOWNLOAD_DIR)) fs.mkdirSync(DOLA_DOWNLOAD_DIR, { recursive: true });

// ── Parse cookie string "a=1; b=2" jadi array cookies Playwright ──
export function parseCookieStringToArray(cookieStr, domain = 'www.dola.com') {
    return cookieStr.split(';').map((s) => s.trim()).filter(Boolean).map((p) => {
        const eq = p.indexOf('=');
        if (eq <= 0) return null;
        return {
            name: p.slice(0, eq).trim(),
            value: p.slice(eq + 1).trim(),
            domain,
            path: '/',
            httpOnly: false,
            secure: true,
            expires: -1,
        };
    }).filter(Boolean);
}

// Load session: prioritas `cookie` dari input; fallback dolaai/dola-session.json.
export function loadDolaSession(customCookie) {
    if (customCookie && customCookie.trim()) {
        return { cookies: parseCookieStringToArray(customCookie.trim()), site: 'https://www.dola.com' };
    }
    if (fs.existsSync(SESSION_FILE)) {
        try {
            const d = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
            return {
                cookies: (d.cookies || []).map((c) => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain || 'www.dola.com',
                    path: c.path || '/',
                    secure: c.secure !== false,
                    httpOnly: !!c.httpOnly,
                    expires: typeof c.expires === 'number' ? c.expires : -1,
                })),
                site: d.site || 'https://www.dola.com',
                botId: d.bot_id || '7339470689562525703',
            };
        }
        catch (e) {
            console.warn('[DOLA] Gagal baca dola-session.json:', e.message);
        }
    }
    throw new Error('Tidak ada session Dola. Berikan cookie atau lengkapi dolaai/dola-session.json');
}

// ══ Pre-process gambar ke rasio tujuan (ffmpeg pad+scale) ══
function ffmpegRun(buffer, args) {
    return new Promise((resolve, reject) => {
        const tmpIn = path.join(__dirname, '_tmp_uploads', `dola_in_${Date.now()}_${Math.random().toString(36).slice(2)}.img`);
        const tmpOut = path.join(__dirname, '_tmp_uploads', `dola_out_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
        fs.writeFileSync(tmpIn, buffer);
        execFile(ffmpegPath, ['-y', '-i', tmpIn, ...args, tmpOut], (err) => {
            try { fs.unlinkSync(tmpIn); } catch (e) { }
            if (err) { try { fs.unlinkSync(tmpOut); } catch (e2) { } return reject(err); }
            if (!fs.existsSync(tmpOut)) return reject(new Error('ffmpeg output tidak ada'));
            const out = fs.readFileSync(tmpOut);
            try { fs.unlinkSync(tmpOut); } catch (e3) { }
            resolve(out);
        });
    });
}

const RATIO_RES = {
    '9:16': { w: 720, h: 1280 },
    '16:9': { w: 1280, h: 720 },
    '1:1': { w: 1024, h: 1024 },
};
async function prepForRatio(buffer, ratio) {
    const r = RATIO_RES[ratio];
    if (!r) return buffer;
    try {
        return await ffmpegRun(buffer, [
            '-vf',
            `scale=${r.w}:${r.h}:force_original_aspect_ratio=decrease,pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2:color=black`,
        ]);
    }
    catch (e) {
        console.warn('[DOLA] gagal preprocess rasio:', e.message);
        return buffer;
    }
}

// ══ Ekstraksi URL video mp4 dari teks / HTML / SSE ══
function findVideoUrlInText(text) {
    if (!text) return null;
    const t = String(text || '');
    const patterns = [
        /https:\/\/[a-z0-9.-]*dola\.dola\.com[^\s"'<>)]+/i,
        /https?:\/\/[^"'<>\s]*?\btos-mya-ve[^"'<>\s]*/i,
        /"url"\s*:\s*"([^"]*\.(?:mp4|m3u8)[^"]*)"/i,
        /"video_url"\s*:\s*"([^"]+)"/i,
        /"download_url"\s*:\s*"([^"]+)"/i,
    ];
    for (const re of patterns) {
        const m = t.match(re);
        if (m && m[0]) return normalizeUrl(m[0]);
    }
    return null;
}
function normalizeUrl(u) {
    return (u || '').replace(/\\u002F/g, '/').replace(/\\\//g, '/').trim();
}

async function downloadVideoFromUrl(url, cookieStr, log) {
    log(`Mengunduh video dari URL CDN: ${url.slice(0, 90)}...`, 90);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'Accept': 'application/octet-stream,*/*',
        'Referer': 'https://www.dola.com/',
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Dest': 'video',
        'Range': 'bytes=0-',
    };
    if (cookieStr) headers['Cookie'] = cookieStr;
    const res = await fetch(url, { headers, redirect: 'follow' });
    if (!res.ok && res.status !== 206) throw new Error(`CDN HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('0 byte dari CDN');
    return buf;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN  generateDolaVideo(options, onProgress)
//  options: {
//    promptText, aspectRatio ('9:16'|'16:9'|'1:1'), duration (detik, default 10),
//    imageBase64 (dataURL/pure), imagePath, cookie, outputDir, filenamePrefix,
//    headless (bool, default false = tampil browser)
//  }
// ═══════════════════════════════════════════════════════════════
export async function generateDolaVideo(options, onProgress) {
    const log = (msg, p = 0) => {
        console.log(`[DOLA_API] ${msg}`);
        if (onProgress) onProgress(msg, p);
    };

    log('Memulai persiapan generasi video Dola AI...', 5);
    const ratio = options.aspectRatio || '9:16';
    const duration = Number(options.duration) > 0 ? Number(options.duration) : 10;
    const promptBase = (options.promptText || '').trim();
    if (!promptBase) throw new Error('Prompt harus diisi');

    // 0) Siapkan buffer gambar
    let imageBase64 = options.imageBase64 || '';
    if (imageBase64 && imageBase64.includes('base64,')) imageBase64 = imageBase64.split('base64,')[1];
    let rawBuffer = imageBase64 ? Buffer.from(imageBase64, 'base64') : null;
    if (!rawBuffer && options.imagePath && fs.existsSync(options.imagePath)) {
        rawBuffer = fs.readFileSync(options.imagePath);
    }
    if (!rawBuffer) throw new Error('Wajib menyertakan gambar (imageBase64 / imagePath) untuk Image-to-Video Dola');

    // 1) Pre-process ke rasio tujuan supaya output video mengikuti rasio tsb
    let imgBuffer = rawBuffer;
    try { imgBuffer = await prepForRatio(rawBuffer, ratio); }
    catch (e) { log('Gagal preprocess rasio, pakai gambar original.', 8); }
    const tmpImage = path.join(__dirname, '_tmp_uploads', `dola_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(tmpImage, imgBuffer);
    log(`Gambar siap: ${path.basename(tmpImage)} (rasio ${ratio})`, 10);

    // 2) Susun prompt akhir (pastikan durasi & rasio disebutkan)
    const ratioLabel = ratio === '9:16' ? 'vertical 9:16 portrait' : (ratio === '16:9' ? 'horizontal 16:9 landscape' : 'square 1:1');
    const durLine = new RegExp(`\\b${duration}[ -]?second`, 'i').test(promptBase) ? '' : ` Produce a ${duration}-second video.`;
    const ratioLine = /aspect ratio|9:16|16:9|1:1|portrait|landscape|square/i.test(promptBase) ? '' : ` Use ${ratioLabel} aspect ratio.`;
    const finalPrompt = `${promptBase.trim()}${durLine}${ratioLine}`.trim();
    log(`Prompt: ${finalPrompt.slice(0, 160)}...`, 12);

    // 3) Buka browser asli + muat session dolaai
    const session = loadDolaSession(options.cookie);
    const headless = options.headless !== undefined ? !!options.headless : (process.env.DOLA_HEADLESS === '1');
    let browser = null, context = null;
    try {
        browser = await chromium.launch({
            headless,
            channel: 'chrome',
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
            ignoreDefaultArgs: ['--enable-automation'],
        });
        context = await browser.newContext({
            viewport: { width: 1366, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'Asia/Jakarta',
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        });
        await context.addCookies(session.cookies);
        const page = await context.newPage();
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {}, app: {}, csi: () => { }, loadTimes: () => { } };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });

        // Simpan cookie string utk unduh CDN
        const cookieHeader = session.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

        log('Membuka Dola (www.dola.com/chat)...', 15);
        await page.goto('https://www.dola.com/chat', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(6000);

        // Validasi login
        const bodyText = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : ''));
        if (/sign in|log in/i.test(bodyText) && !/log out/i.test(bodyText)) {
            throw new Error('Session Dola expired / tidak dikenali. Perbarui dolaai/dola-session.json');
        }
        log('Session diterima, mencari kolom input chat...', 20);

        // 4) Cari elemen input chat (contenteditable)
        let chatEditor = null;
        try {
            chatEditor = await page.waitForSelector('[contenteditable="true"],[contenteditable="plaintext-only"],textarea,div[class*="editor"]', { timeout: 25000 });
        }
        catch {
            throw new Error('Elemen input chat tidak ditemukan. Halaman Dola tidak terbuka normal.');
        }

        // 5) Upload gambar lewat input type=file
        let fileInput = null;
        try { fileInput = await page.waitForSelector('input[type="file"]', { timeout: 12000 }); }
        catch { /* mungkin butuh buka menu lampiran */ }
        if (!fileInput) {
            const attachBtn = await page.$('[aria-label*="upload" i],[title*="upload" i],[class*="upload" i] button,[class*="plus" i],[data-testid*="attach" i]');
            if (attachBtn) { try { await attachBtn.click(); await page.waitForTimeout(1200); } catch (e) { } }
            try { fileInput = await page.waitForSelector('input[type="file"]', { timeout: 8000 }); }
            catch (e) { fileInput = null; }
        }
        if (fileInput) {
            await fileInput.setInputFiles(tmpImage);
            log('Gambar berhasil di-upload ke chat Dola.', 35);
            await page.waitForTimeout(3500);
        }
        else {
            log('Input file tidak ditemukan; lanjut dengan prompt saja (tidak image-to-video).', 35);
        }

        // 6) Ketik prompt lalu kirim (Enter)
        await chatEditor.click();
        await page.keyboard.type(finalPrompt, { delay: 6 });
        await page.keyboard.press('Enter');
        log('Prompt & gambar dikirim ke Dola. Menunggu video diproses (1-6 menit)...', 45);
        await page.waitForTimeout(2500);

        // 7) Tunggu video muncul di DOM / network
        const videoUrl = await waitForVideoUrl(page, log);
        if (!videoUrl) {
            throw new Error('Dola tidak menghasilkan video dalam batas waktu. Coba lagi / cek session / cek prompt.');
        }

        // 8) Unduh file video dari CDN
        const buffer = await downloadVideoFromUrl(videoUrl, cookieHeader, log);

        const outputDir = options.outputDir || DOLA_DOWNLOAD_DIR;
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const fname = `${options.filenamePrefix || 'dola'}_${Date.now()}_${Math.floor(Math.random() * 9999)}.mp4`;
        const savePath = path.join(outputDir, fname);
        fs.writeFileSync(savePath, buffer);
        try { fs.unlinkSync(tmpImage); } catch (e) { }
        log(`Video berhasil: ${savePath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`, 100);
        return {
            success: true,
            filename: fname,
            savePath,
            downloadUrl: `/api/dola/video-file/${fname}`,
            sizeBytes: buffer.length,
            prompt: finalPrompt,
            aspectRatio: ratio,
            duration,
        };
    }
    finally {
        if (context) { try { await context.close(); } catch (e) { } }
        if (browser) { try { await browser.close(); } catch (e) { } }
        try { fs.unlinkSync(tmpImage); } catch (e) { }
    }
}

// ═══════════════════════════════════════════════════════════════
//  waitForVideoUrl: pantau DOM (video/source) + network (v16-dola)
//  sampai URL video mp4 didapat.
// ═══════════════════════════════════════════════════════════════
async function waitForVideoUrl(page, log) {
    let found = null;
    // a) tangkap URL dari request/response yang mengandung tos-mya-ve / v16-dola
    const onResponse = async (resp) => {
        const u = resp.url();
        if (found) return;
        if (u.includes('v16-dola.dola.com') || u.includes('tos-mya-ve')) {
            if (/download=true|\.mp4|video\//i.test(u)) found = u;
        }
    };
    page.on('response', onResponse);

    const start = Date.now();
    const timeout = 6 * 60 * 1000; // 6 menit
    while (!found && Date.now() - start < timeout) {
        // b) cek <video>/<source> di DOM
        try {
            const dom = await page.evaluate(() => {
                const set = new Set();
                document.querySelectorAll('video,source').forEach((el) => {
                    const s = el.getAttribute('src') || (el.currentSrc) || '';
                    if (s) set.add(s);
                });
                return Array.from(set);
            });
            for (const u of dom) {
                const nu = normalizeUrl(u);
                if (/v16-dola|tos-mya-ve|\.mp4|video\//i.test(nu)) { found = nu; break; }
            }
        }
        catch (e) { }
        if (!found) await page.waitForTimeout(3000);
    }
    page.removeListener('response', onResponse);
    return found ? normalizeUrl(found) : null;
}