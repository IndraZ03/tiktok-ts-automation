// vidabot_api_client.ts - Client untuk memanggil API Vidabot (Veo)
import fs from 'fs';
import path from 'path';
const DEFAULT_COOKIE = `remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d=eyJpdiI6IkRseGo3VUJucFF0YndvbDVwUFFwS3c9PSIsInZhbHVlIjoiSWNsQzBhbEVuZTM4UXVScGJnS29SYk1aTXJZcjlCb0NwU1dVZlNhbG1icUdtYVBnRW0yTGdyZ2RHdjZSUU5wN2szSlJocDF1VzhmN29qdjFvT0Ewd2I4U1U4VTFSTFNZbDZINm1xeDd1aFZicWdMaENTMGIxSC9UMytQc1VoV1o2QllJMW1ZYlNXZDJXYmZFTlkxd3lRWFFMWmZROUpJbUNVYTdLREdzRDI2WjFma3puYVQvSDZ3Zlp6N1F1SVJJUjIvdm9kOHdGSlN0dzNmdTdtOGlqeXBZOWxCK1k5UFVNLzhqQUlqSmZ0TT0iLCJtYWMiOiIzYTRiY2U3ZmI1OTExN2IyM2VjOWIzZWI4MDQzZThjNzE2YTM1NTAxMzk1NzliYzc1ZWYyZDg3YWJkMzIzMGE3IiwidGFnIjoiIn0%3D; XSRF-TOKEN=eyJpdiI6IlJKVTBwRXJpNk1leGY3Z0Y3RHBjYnc9PSIsInZhbHVlIjoidVNpQ0MvN1FkR2tLVjdBRngrSmFuUjFWWlNadzdaTitBM1MrdTh6NXhmT21GZWIreE5HNmxSVTMyckRYYWxQRWhaSGdidFRSNE5lZEI5TzNRMDRRK2UxSTY5N0FOM3gzcWJBUVhuMUdOMFFkTGZncWpVNHhoSEE0OThEYk9WbkYiLCJtYWMiOiIxMGJlOTRhNTcxM2U1OTBhOWY4MjM3MDMxZDFlODRiMmY0NmU3Y2Q5OGZmODJiODY5YWIwOGRkNjUxZTQ5YjY0IiwidGFnIjoiIn0%3D; laravel_session=eyJpdiI6IjFwTTRWYThONDZmQVFTdFlOdUxLcHc9PSIsInZhbHVlIjoiUWNvQmZUUncyWlRzM0pTejVMcW1tNEppeHo5L1oxb1hLRkI2bHNlcVZVKzFRMDEvQVdmWXNzTkZoQzFCQmIzYmE4UTZZZFBNVXBra2xMVmg4WlRCOFlpSVRMVFlVeXgwRk5pcDJxenl1cjlpc3Y5ajZCK1FZa2dkWXhRaEl5MTkiLCJtYWMiOiIyZjczYzljMDk1OGM1NjNiYmQ0YjdhZDZjZDlhYTUwMjMyNzIyNDZmNDhmOTZkOTY0NmFkYmYwNTA0NzYzN2UwIiwidGFnIjoiIn0%3D`;
function updateCookies(existingCookie, response) {
    let setCookies = [];
    if (typeof response.headers.getSetCookie === 'function') {
        setCookies = response.headers.getSetCookie();
    }
    else {
        const sc = response.headers.get('set-cookie');
        if (sc)
            setCookies = [sc];
    }
    if (!setCookies || setCookies.length === 0)
        return existingCookie;
    const cookieMap = new Map();
    existingCookie.split(';').forEach(c => {
        const parts = c.trim().split('=');
        if (parts.length >= 2) {
            cookieMap.set(parts[0].trim(), parts.slice(1).join('=').trim());
        }
    });
    setCookies.forEach(sc => {
        const firstPart = sc.split(';')[0].trim();
        const parts = firstPart.split('=');
        if (parts.length >= 2) {
            cookieMap.set(parts[0].trim(), parts.slice(1).join('=').trim());
        }
    });
    const result = [];
    cookieMap.forEach((v, k) => result.push(`${k}=${v}`));
    return result.join('; ');
}
function getXsrfToken(cookieStr) {
    const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/);
    if (match && match[1]) {
        try {
            return decodeURIComponent(match[1]);
        }
        catch {
            return match[1];
        }
    }
    return null;
}
function findVideoUrlInJson(obj) {
    if (!obj || typeof obj !== 'object')
        return null;
    if (typeof obj.videoUrl === 'string' && obj.videoUrl)
        return obj.videoUrl;
    if (typeof obj.video_url === 'string' && obj.video_url)
        return obj.video_url;
    if (typeof obj.downloadUrl === 'string' && obj.downloadUrl)
        return obj.downloadUrl;
    if (typeof obj.download_url === 'string' && obj.download_url)
        return obj.download_url;
    if (typeof obj.url === 'string' && obj.url && (obj.url.includes('/video/') || obj.url.endsWith('.mp4') || obj.url.includes('flow-content')))
        return obj.url;
    if (Array.isArray(obj.prompts)) {
        for (const p of obj.prompts) {
            const url = findVideoUrlInJson(p) || findVideoUrlInJson(p?.result);
            if (url)
                return url;
        }
    }
    if (obj.result) {
        const url = findVideoUrlInJson(obj.result);
        if (url)
            return url;
    }
    return null;
}
async function downloadVideoBuffer(videoUrl, cookie) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    };
    if (videoUrl.includes('vidabot.markasai.com')) {
        headers['Origin'] = 'https://vidabot.markasai.com';
        headers['Referer'] = 'https://vidabot.markasai.com/public/app/generate-veo3';
        if (cookie)
            headers['Cookie'] = cookie;
    }
    const res = await fetch(videoUrl, { headers, redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`Gagal mengunduh video dari ${videoUrl} (HTTP ${res.status})`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}
export async function generateVidabotVideo(options, onProgress) {
    const log = (msg, pct = 0) => {
        console.log(`[VIDABOT_API] ${msg}`);
        if (onProgress)
            onProgress(msg, pct);
    };
    log(`Memulai persiapan generasi video Vidabot...`, 5);
    let base64Image = options.imageBase64 || '';
    if (!base64Image && options.imagePath && fs.existsSync(options.imagePath)) {
        log(`Membaca file bahan gambar: ${path.basename(options.imagePath)}...`, 10);
        const imgBuf = fs.readFileSync(options.imagePath);
        base64Image = imgBuf.toString('base64');
    }
    if (base64Image.includes('base64,')) {
        base64Image = base64Image.split('base64,')[1];
    }
    let activeCookie = options.cookie?.trim() || DEFAULT_COOKIE;
    const headers = {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': 'https://vidabot.markasai.com',
        'Referer': 'https://vidabot.markasai.com/public/app/generate-veo3',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'Cookie': activeCookie,
    };
    const xsrf = getXsrfToken(activeCookie);
    if (xsrf) {
        headers['X-XSRF-TOKEN'] = xsrf;
    }
    const payload = {
        mode: 'i2v_start',
        prompts: [{ text: options.promptText }],
        aspectRatio: options.aspectRatio || 'portrait',
        images: base64Image ? [{ base64: base64Image }] : []
    };
    log(`Mengirim POST request ke Vidabot (https://vidabot.markasai.com/api/veo/video-generate)...`, 20);
    const startRes = await fetch('https://vidabot.markasai.com/api/veo/video-generate', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });
    activeCookie = updateCookies(activeCookie, startRes);
    headers['Cookie'] = activeCookie;
    if (!startRes.ok) {
        const errText = await startRes.text();
        log(`❌ HTTP Error ${startRes.status}: ${errText.slice(0, 300)}`);
        throw new Error(`Gagal menghubungi API Vidabot (HTTP ${startRes.status}): ${errText.slice(0, 200)}`);
    }
    const startData = await startRes.json();
    if (!startData.jobId) {
        log(`❌ Response API tidak memiliki jobId: ${JSON.stringify(startData)}`);
        throw new Error(startData.message || startData.error || 'Server Vidabot tidak mengembalikan jobId valid');
    }
    const jobId = startData.jobId;
    log(`✅ Job berhasil dibuat! Job ID: ${jobId} (Status: ${startData.status || 'queued'})`, 30);
    const pollUrl = `https://vidabot.markasai.com/api/veo/video-generate/${jobId}`;
    const startTime = Date.now();
    const TIMEOUT_MS = 600000; // 10 minutes max
    let attempts = 0;
    while (Date.now() - startTime < TIMEOUT_MS) {
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
        const estimatedProgress = Math.min(92, 30 + Math.floor(attempts * 3));
        log(`Memeriksa status progress (Job ID: ${jobId})...`, estimatedProgress);
        try {
            const checkRes = await fetch(pollUrl, {
                method: 'GET',
                headers,
                redirect: 'manual'
            });
            activeCookie = updateCookies(activeCookie, checkRes);
            headers['Cookie'] = activeCookie;
            const location = checkRes.headers.get('location');
            if ([301, 302, 303, 307, 308].includes(checkRes.status) || location) {
                const targetUrl = location || pollUrl;
                log(`🎬 Redirect video terdeteksi (HTTP ${checkRes.status})! Mengunduh video dari: ${targetUrl.slice(0, 100)}...`, 95);
                const buffer = await downloadVideoBuffer(targetUrl, activeCookie);
                if (buffer.length === 0) {
                    throw new Error('Ukuran file video yang diunduh 0 byte');
                }
                const downloadDir = options.outputDir || path.join(process.cwd(), 'vidabot-downloads');
                if (!fs.existsSync(downloadDir)) {
                    fs.mkdirSync(downloadDir, { recursive: true });
                }
                const fname = `${options.filenamePrefix || 'vidabot'}_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
                const savePath = path.join(downloadDir, fname);
                fs.writeFileSync(savePath, buffer);
                log(`✅ Video berhasil di-generate dan disimpan ke: ${savePath}`, 100);
                return {
                    success: true,
                    jobId,
                    filename: fname,
                    savePath,
                    downloadUrl: `/api/vidabot/video-file/${fname}`,
                    sizeBytes: buffer.length
                };
            }
            const contentType = checkRes.headers.get('content-type') || '';
            // If response is direct video file stream
            if (contentType.includes('video/') || contentType.includes('octet-stream') || checkRes.status === 206) {
                log(`🎬 Stream video terdeteksi! Mengunduh file video...`, 95);
                const arrayBuffer = await checkRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                if (buffer.length === 0) {
                    throw new Error('Ukuran file video yang diterima 0 byte');
                }
                const downloadDir = options.outputDir || path.join(process.cwd(), 'vidabot-downloads');
                if (!fs.existsSync(downloadDir)) {
                    fs.mkdirSync(downloadDir, { recursive: true });
                }
                const fname = `${options.filenamePrefix || 'vidabot'}_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
                const savePath = path.join(downloadDir, fname);
                fs.writeFileSync(savePath, buffer);
                log(`✅ Video berhasil di-generate dan disimpan ke: ${savePath}`, 100);
                return {
                    success: true,
                    jobId,
                    filename: fname,
                    savePath,
                    downloadUrl: `/api/vidabot/video-file/${fname}`,
                    sizeBytes: buffer.length
                };
            }
            // Otherwise, read JSON status
            const checkText = await checkRes.text();
            let checkData = {};
            try {
                checkData = JSON.parse(checkText);
            }
            catch {
                log(`Respon non-JSON (HTTP ${checkRes.status}): ${checkText.slice(0, 150)}`);
            }
            log(`[DEBUG] Check response JSON: ${JSON.stringify(checkData)}`);
            const statusLower = String(checkData.status || '').toLowerCase();
            const isDone = statusLower === 'done' || statusLower === 'completed' || statusLower === 'success' || statusLower === 'finished';
            const rawVideoUrl = findVideoUrlInJson(checkData);
            if (isDone || rawVideoUrl) {
                log(`🎉 Job selesai (Status: ${checkData.status || 'done'})! Mengunduh file hasil video...`, 95);
                let targetUrl = rawVideoUrl;
                if (targetUrl && targetUrl.startsWith('/')) {
                    targetUrl = `https://vidabot.markasai.com${targetUrl}`;
                }
                let buffer = null;
                if (targetUrl) {
                    try {
                        log(`Mengunduh video dari URL: ${targetUrl.slice(0, 100)}...`);
                        buffer = await downloadVideoBuffer(targetUrl, activeCookie);
                    }
                    catch (e) {
                        log(`Peringatan download dari videoUrl: ${e.message}. Mencoba fallback pollUrl...`);
                    }
                }
                // Fallback: if no videoUrl or download failed, try fetching pollUrl with redirect: 'follow'
                if (!buffer || buffer.length === 0) {
                    log(`Mencoba mengunduh video dari pollUrl langsung (${pollUrl})...`);
                    const directRes = await fetch(pollUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
                            'Cookie': activeCookie,
                            'Accept': 'video/mp4,application/octet-stream,*/*'
                        },
                        redirect: 'follow'
                    });
                    if (directRes.ok) {
                        const ab = await directRes.arrayBuffer();
                        const buf = Buffer.from(ab);
                        if (buf.length > 500) {
                            buffer = buf;
                        }
                    }
                }
                if (!buffer || buffer.length === 0) {
                    throw new Error('Gagal mengunduh file video (Buffer 0 byte atau URL tidak ditemukan)');
                }
                const downloadDir = options.outputDir || path.join(process.cwd(), 'vidabot-downloads');
                if (!fs.existsSync(downloadDir)) {
                    fs.mkdirSync(downloadDir, { recursive: true });
                }
                const fname = `${options.filenamePrefix || 'vidabot'}_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
                const savePath = path.join(downloadDir, fname);
                fs.writeFileSync(savePath, buffer);
                log(`✅ Video berhasil di-generate dan disimpan di: ${savePath}`, 100);
                return {
                    success: true,
                    jobId,
                    filename: fname,
                    savePath,
                    downloadUrl: `/api/vidabot/video-file/${fname}`,
                    sizeBytes: buffer.length
                };
            }
            if (statusLower === 'failed') {
                log(`❌ Status job failed: ${checkData.message || checkData.error || 'Generasi gagal'}`);
                throw new Error(checkData.error || checkData.message || 'Generasi video gagal di server Vidabot');
            }
            if (checkData.status || checkData.queuePosition !== undefined) {
                log(`Status Job: ${checkData.status}${checkData.queuePosition !== undefined ? ` (Queue Pos: ${checkData.queuePosition})` : ''}`, estimatedProgress);
            }
            else if (checkData.message) {
                log(`Status: ${checkData.message}`, estimatedProgress);
            }
        }
        catch (err) {
            log(`Peringatan saat polling: ${err.message}`);
        }
    }
    throw new Error('Proses generate video di Vidabot melebihi batas waktu (Timeout 10 Menit)');
}
