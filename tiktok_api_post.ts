// tiktok_api_post.ts
// Modul API Direct POST untuk TikTok Affiliate Video Posting (Bypass DOM/UI Automation)
import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TikTokAffiliatePostOptions {
  stateFile: string;         // Contoh: 'tiktok-state-herbalily.json'
  statesDir?: string;        // Path ke folder tiktok-states
  videoPath?: string;        // Path file video lokal (.mp4)
  videoId?: string;          // ID Video (contoh: 'v29025g50000d9hojbvog65lt7g8r410')
  description: string;       // Deskripsi postingan (contoh: 'tes grok ini deskripsi')
  productTitle: string;      // Nama produk showcase (contoh: 'ini nama produk')
  productId: string;         // ID produk affiliate (contoh: '1729748856299095594')
  scheduleTime?: number;     // Epoch timestamp dalam detik jika dijadwalkan
  creationId?: string;       // ID kreasi unik (opsional)
  videoWidth?: number;       // Lebar video
  videoHeight?: number;      // Tinggi video
  durationMs?: number;       // Durasi video dalam ms (contoh: 18720)
  page?: Page;               // Optional existing Playwright page context
}

function extractVideoMetadata(videoPath: string): { width: number; height: number; durationMs: number } {
  try {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -show_entries format=duration -of json "${videoPath}"`;
    const out = execSync(cmd, { encoding: 'utf-8' });
    const parsed = JSON.parse(out);
    const stream = parsed.streams?.[0] || {};
    const format = parsed.format || {};
    const width = stream.width || 816;
    const height = stream.height || 1104;
    const durationSec = parseFloat(stream.duration || format.duration || '18.72');
    const durationMs = Math.round(durationSec * 1000);
    return { width, height, durationMs };
  } catch (e) {
    return { width: 816, height: 1104, durationMs: 18720 };
  }
}

export async function postTikTokAffiliateVideoApi(options: TikTokAffiliatePostOptions) {
  const statesDir = options.statesDir || path.join(process.cwd(), 'tiktok-states');
  const stateFilePath = path.join(statesDir, options.stateFile);

  if (!options.page && !fs.existsSync(stateFilePath)) {
    throw new Error(`File state tidak ditemukan: ${stateFilePath}`);
  }

  const log = (msg: string) => console.log(`[TIKTOK_API_POST] ${msg}`);
  log(`Memulai proses posting API Affiliate (State: ${options.stateFile})...`);

  // Ekstrak info video otomatis jika file video diberikan
  let videoWidth = options.videoWidth;
  let videoHeight = options.videoHeight;
  let durationMs = options.durationMs;

  if (options.videoPath && fs.existsSync(options.videoPath)) {
    const meta = extractVideoMetadata(options.videoPath);
    if (!videoWidth) videoWidth = meta.width;
    if (!videoHeight) videoHeight = meta.height;
    if (!durationMs) durationMs = meta.durationMs;
    log(`🎬 Meta video terdeteksi: ${videoWidth}x${videoHeight}, durasi: ${durationMs}ms`);
  }
  videoWidth = videoWidth || 816;
  videoHeight = videoHeight || 1104;
  durationMs = durationMs || 18720;

  let browser = null;
  let page = options.page;

  // State variables untuk intercepted data
  let finalVideoId = options.videoId || '';
  let detectedMusicPreCheckId = '';
  let ticketGuardPublicKey = '';

  if (!page) {
    log(`Membuka background context Playwright dengan state: ${options.stateFile}...`);
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
      storageState: stateFilePath,
    });

    page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    // ═══════════════════════════════════════════════════════════
    // PENTING: Set up request interceptor SEBELUM navigasi
    // Untuk menangkap Tt-Ticket-Guard-Public-Key dari request
    // yang dibuat oleh JavaScript TikTok sendiri saat page load
    // ═══════════════════════════════════════════════════════════
    page.on('request', (request) => {
      if (!ticketGuardPublicKey && request.url().includes('tiktok.com')) {
        const headers = request.headers();
        const pk = headers['tt-ticket-guard-public-key'];
        if (pk && pk.length > 10) {
          ticketGuardPublicKey = pk;
          log(`🔑 Captured Ticket Guard Public Key: ${pk.substring(0, 30)}...`);
        }
      }
    });

    log('Navigasi ke TikTok Studio Upload...');
    await page.goto('https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(3000);
  } else {
    // Page sudah diberikan, coba capture Ticket Guard dari request berikutnya
    page.on('request', (request) => {
      if (!ticketGuardPublicKey && request.url().includes('tiktok.com')) {
        const headers = request.headers();
        const pk = headers['tt-ticket-guard-public-key'];
        if (pk && pk.length > 10) {
          ticketGuardPublicKey = pk;
          log(`🔑 Captured Ticket Guard Public Key: ${pk.substring(0, 30)}...`);
        }
      }
    });
  }

  // Ekstrak CSRF Token langsung dari Cookie Jar Playwright (termasuk HttpOnly cookies)
  const allCookies = await page.context().cookies('https://www.tiktok.com');
  const csrfCookie = allCookies.find(c => c.name === 'tt_csrf_token' || c.name === 'csrf_session_id');
  const csrfToken = csrfCookie ? csrfCookie.value : '';
  const msTokenCookie = allCookies.find(c => c.name === 'msToken');
  const msToken = msTokenCookie ? msTokenCookie.value : '';
  log(`🔍 Status Cookie Context: Total ${allCookies.length} cookie. CSRF Token: ${csrfToken ? '✓ Ada (' + csrfToken.substring(0, 8) + '...)' : '❌ KOSONG (Periksa Login State)'}`);
  log(`🔑 Ticket Guard Public Key: ${ticketGuardPublicKey ? '✓ Ada (' + ticketGuardPublicKey.substring(0, 20) + '...)' : '❌ Belum terdeteksi (menunggu...)'}`);

  if (!csrfToken) {
    throw new Error(`Sesi login untuk ${options.stateFile} tidak memiliki tt_csrf_token. Silakan login ulang state account ini.`);
  }

  // Intercept response presisi untuk menangkap video_id, music_pre_check_id, dan log API responses
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (url.includes('.js') || url.includes('.css') || url.includes('.png') || url.includes('.svg') || url.includes('.jpeg') || url.includes('.jpg') || url.includes('.gif') || url.includes('.woff')) {
        return;
      }

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json') && !contentType.includes('text')) return;

      const text = await response.text().catch(() => '');
      if (!text || text.length < 10) return;

      // Log API responses dari TikTok untuk debugging (hanya JSON API, bukan HTML)
      if (url.includes('/tiktok/') || url.includes('/api/')) {
        const shortUrl = url.split('?')[0];
        const statusCode = response.status();
        log(`📡 API Response [${statusCode}]: ${shortUrl} (${text.length} bytes)`);
      }

      // Cari video_id
      const matchVid = text.match(/"video_id"\s*:\s*"(v[0-9a-zA-Z]{25,35})"/i) || text.match(/"vid"\s*:\s*"(v[0-9a-zA-Z]{25,35})"/i);
      if (matchVid && matchVid[1]) {
        const detectedVid = matchVid[1];
        if (detectedVid !== 'v29025g50000d9hojbvog65lt7g8r410' && !detectedVid.includes('XMLHttpRequest') && !detectedVid.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ')) {
          finalVideoId = detectedVid;
          log(`🎯 Terdeteksi video_id asli dari sesi: ${finalVideoId}`);
        }
      }

      // Cari music_pre_check_id (broad pattern matching)
      if (!detectedMusicPreCheckId) {
        const matchMusic = text.match(/"music_pre_check_id"\s*:\s*"([^"]+)"/i)
          || text.match(/"pre_check_id"\s*:\s*"([^"]+)"/i)
          || text.match(/"preCheckId"\s*:\s*"([^"]+)"/i);
        if (matchMusic && matchMusic[1] && matchMusic[1].length > 5) {
          detectedMusicPreCheckId = matchMusic[1];
          log(`🎵 Terdeteksi music_pre_check_id: ${detectedMusicPreCheckId}`);
        }
      }

      // Cari music_pre_check_id dari URL musik-specific
      if (!detectedMusicPreCheckId && (url.includes('music') || url.includes('pre_check') || url.includes('precheck'))) {
        log(`🎵 Music-related API response: ${url.split('?')[0]}`);
        const idMatch = text.match(/([A-Z]{2,10}_\d+_\d{10,})/);
        if (idMatch) {
          detectedMusicPreCheckId = idMatch[1];
          log(`🎵 Terdeteksi music_pre_check_id dari music API: ${detectedMusicPreCheckId}`);
        }
      }
    } catch {}
  });

  // Upload file video jika videoPath diberikan
  if (options.videoPath && fs.existsSync(options.videoPath)) {
    log(`Mengunggah file video ke TikTok Studio: ${path.basename(options.videoPath)}...`);
    try {
      let fileInput = page.locator('input[type="file"][accept*="video"]').first();
      if (await fileInput.count() === 0) {
        fileInput = page.locator('input[type="file"]').first();
      }
      await fileInput.waitFor({ state: 'attached', timeout: 10000 });
      await fileInput.setInputFiles(options.videoPath);
      log('✓ File video dimasukkan ke input upload');
      
      log('⏳ Menunggu TikTok Studio memproses video & menerbitkan video_id...');
      for (let i = 0; i < 30; i++) {
        if (finalVideoId && finalVideoId !== 'v29025g50000d9hojbvog65lt7g8r410') {
          break;
        }
        if (i % 3 === 0) {
          try {
            const pageVid: any = await page.evaluate(`(() => {
              try {
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const s of scripts) {
                  const txt = s.textContent || '';
                  const m = txt.match(/"video_id"\\s*:\\s*"(v[0-9a-zA-Z]{25,35})"/i) || txt.match(/"vid"\\s*:\\s*"(v[0-9a-zA-Z]{25,35})"/i);
                  if (m && m[1] && m[1] !== 'v29025g50000d9hojbvog65lt7g8r410') return m[1];
                }
                return '';
              } catch(e) { return ''; }
            })()`);
            if (pageVid && typeof pageVid === 'string' && pageVid.length > 10) {
              finalVideoId = pageVid;
              log(`🎯 Terdeteksi video_id dari page state DOM: ${finalVideoId}`);
              break;
            }
          } catch {}
        }
        await page.waitForTimeout(1000);
      }
    } catch (e: any) {
      log(`⚠ Info upload file video: ${e.message}`);
    }
  }

  if (!finalVideoId || finalVideoId === 'v29025g50000d9hojbvog65lt7g8r410') {
    throw new Error('Gagal mendapatkan video_id asli milik akun sesi ini. Pastikan file video valid dan TikTok Studio telah memproses unggahan.');
  }

  log(`Menggunakan video_id asli milik akun: ${finalVideoId}`);

  // ═══════════════════════════════════════════════════════════
  // Tunggu music_pre_check_id setelah video_id terdeteksi
  // TikTok Studio memproses audio copyright check setelah upload selesai
  // ═══════════════════════════════════════════════════════════
  if (!detectedMusicPreCheckId && options.videoPath) {
    log('🎵 Menunggu music_pre_check_id dari TikTok Studio (max 20 detik)...');
    for (let i = 0; i < 20; i++) {
      if (detectedMusicPreCheckId) break;

      // Setiap 3 detik, coba extract dari page state
      if (i % 3 === 0) {
        try {
          const extracted: any = await page.evaluate(`(() => {
            try {
              // Cari di semua elemen script
              var scripts = Array.from(document.querySelectorAll('script'));
              for (var s of scripts) {
                var txt = s.textContent || '';
                var m = txt.match(/"music_pre_check_id"\\s*:\\s*"([^"]+)"/i) || txt.match(/"preCheckId"\\s*:\\s*"([^"]+)"/i);
                if (m && m[1] && m[1].length > 5) return m[1];
              }
              // Cari di window state objects
              for (var key of Object.getOwnPropertyNames(window)) {
                try {
                  if (key.startsWith('__') || key === 'location' || key === 'chrome' || key === 'performance') continue;
                  var val = window[key];
                  if (val && typeof val === 'object') {
                    var json = JSON.stringify(val);
                    if (json && json.includes('music_pre_check_id')) {
                      var m2 = json.match(/"music_pre_check_id"\\s*:\\s*"([^"]+)"/);
                      if (m2 && m2[1]) return m2[1];
                    }
                  }
                } catch(e) {}
              }
              return '';
            } catch(e) { return ''; }
          })()`);
          if (extracted && typeof extracted === 'string' && extracted.length > 5) {
            detectedMusicPreCheckId = extracted;
            log(`🎵 Terdeteksi music_pre_check_id dari page state: ${detectedMusicPreCheckId}`);
            break;
          }
        } catch {}
      }
      await page.waitForTimeout(1000);
    }
  }

  // Fallback: konstruksi music_pre_check_id dari IDC cookie + upload context
  if (!detectedMusicPreCheckId) {
    const idcCookie = allCookies.find(c => c.name === 'store-idc');
    const idcRegion = idcCookie ? idcCookie.value.toUpperCase() : 'ALISG';

    // Coba extract creation task ID dari page (TikTok Studio biasanya set ini setelah upload)
    try {
      const taskId: any = await page.evaluate(`(() => {
        try {
          // Cari creation_id / task_id dari page state
          var bodyText = document.body.innerText || '';
          // Cari pattern numerik 19-digit yang mirip TikTok ID
          var scripts = Array.from(document.querySelectorAll('script'));
          for (var s of scripts) {
            var txt = s.textContent || '';
            var m = txt.match(/"(?:creation_task_id|upload_id|music_id|item_id)"\\s*:\\s*"(\\d{15,22})"/i);
            if (m && m[1]) return m[1];
          }
          return '';
        } catch(e) { return ''; }
      })()`);
      if (taskId && taskId.length > 10) {
        detectedMusicPreCheckId = `${idcRegion}_6_${taskId}`;
        log(`🎵 Konstruksi music_pre_check_id fallback: ${detectedMusicPreCheckId}`);
      }
    } catch {}
  }

  if (!detectedMusicPreCheckId) {
    log('⚠ music_pre_check_id tidak terdeteksi - melanjutkan tanpa nilai (mungkin gagal)');
  }

  // Generate creation_id 21-karakter alfanumerik persis seperti TikTok Studio (contoh: qkBA5RZGadfx9JOaunE0S)
  const generateCreationId = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let res = '';
    for (let i = 0; i < 21; i++) {
      res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
  };
  const creationId = options.creationId || generateCreationId();

  // TikTok Web Studio API mengharuskan post_type: 3 (Terjadwal) dengan schedule_time di masa depan (minimal +20 menit, dibulatkan kelipatan 5 menit / 300s)
  const nowEpoch = Math.floor(Date.now() / 1000);
  const minScheduleTime = nowEpoch + (20 * 60);
  const rawSchedule = (options.scheduleTime && options.scheduleTime > minScheduleTime)
    ? options.scheduleTime
    : (nowEpoch + 25 * 60);

  // Bulatkan ke atas kelipatan 300 detik (5 menit)
  const targetSchedule = Math.ceil(rawSchedule / 300) * 300;

  log(`📅 Menggunakan Post Tipe 3 (Terjadwal) untuk Epoch: ${targetSchedule} (${new Date(targetSchedule * 1000).toLocaleString('id-ID')})`);

  const featureItem: any = {
    schedule_time: targetSchedule,
    geofencing_regions: [],
    playlist_name: "",
    playlist_id: "",
    tcm_params: JSON.stringify({ commerce_toggle_info: {} }),
    sound_exemption: 0,
    music_copyright: { result: 1 },
    anchors: options.productId ? [
      {
        type: 33, // Type 33 untuk TikTok Affiliate Showcase Product Anchor
        keyword: options.productTitle || "Produk Affiliate",
        content: {
          product_id: String(options.productId),
          keyword: options.productTitle || "Produk Affiliate",
          add_from: 2
        }
      }
    ] : [],
    aigc_info: { aigc_label_type: 1 },
    vedit_common_info: {
      draft: "",
      video_id: finalVideoId
    },
    privacy_setting_info: {
      visibility_type: 0,
      allow_duet: null,
      allow_stitch: null,
      allow_comment: 1,
      allow_content_reuse: 1,
      allow_ai_remix: 1
    },
    content_check_id: ""
  };

  const payload = {
    post_common_info: {
      creation_id: creationId,
      enter_post_page_from: 1,
      post_type: 3
    },
    feature_common_info_list: [featureItem],
    single_post_req_list: [
      {
        batch_index: 0,
        video_id: finalVideoId,
        is_long_video: 0,
        single_post_feature_info: {
          text: options.description,
          text_extra: [],
          markup_text: options.description,
          music_info: {
            music_pre_check_id: detectedMusicPreCheckId || "",
            origin_volume: "100"
          },
          poster_delay: 0,
          cloud_edit_video_height: videoHeight,
          cloud_edit_video_width: videoWidth,
          cloud_edit_is_use_video_canvas: false,
          has_original_audio: 1,
          is_upload_audio_track: false,
          video_track_time_range_list: [
            { start_time_in_ms: 0, end_time_in_ms: durationMs }
          ]
        }
      }
    ]
  };

  // Jika Ticket Guard Public Key belum terdeteksi, coba extract dari page JS
  if (!ticketGuardPublicKey) {
    log('🔑 Mencoba extract Ticket Guard Public Key dari page JavaScript...');
    try {
      const extractedKey: any = await page.evaluate(`(() => {
        try {
          // Cari di window globals
          var w = window;
          if (w.__TICKET_GUARD_PUBLIC_KEY__) return w.__TICKET_GUARD_PUBLIC_KEY__;
          if (w._ticketGuardPublicKey) return w._ticketGuardPublicKey;
          // Cari di performance entries (request headers dari navigasi/API calls)
          var entries = performance.getEntriesByType('resource');
          for (var e of entries) {
            if (e.name && e.name.includes('tiktok.com') && e.serverTiming) {
              // serverTiming available but headers not directly accessible
            }
          }
          return '';
        } catch(e) { return ''; }
      })()`);
      if (extractedKey && typeof extractedKey === 'string' && extractedKey.length > 10) {
        ticketGuardPublicKey = extractedKey;
        log(`🔑 Ticket Guard Public Key dari page JS: ${ticketGuardPublicKey.substring(0, 30)}...`);
      }
    } catch {}
  }

  // Trigger API call via XMLHttpRequest (TikTok SDK intercepts XHR, not raw fetch) untuk capture Ticket Guard Public Key
  if (!ticketGuardPublicKey) {
    log('🔑 Triggering XHR + extracting Ticket Guard Public Key...');
    try {
      // Metode 1: Trigger XHR (TikTok SDK biasanya intercept XMLHttpRequest.prototype.open/send)
      await page.evaluate(`(() => {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', 'https://www.tiktok.com/tiktok/v1/creator/publish_setting/?aid=1988', true);
          xhr.withCredentials = true;
          xhr.send();
        } catch(e) {}
      })()`);
      await page.waitForTimeout(2000);
    } catch {}
    
    // Metode 2: Extract dari IndexedDB di mana TikTok mungkin menyimpan public key
    if (!ticketGuardPublicKey) {
      try {
        const dbKey: any = await page.evaluate(`(async () => {
          try {
            // Cari di IndexedDB - TikTok sering simpan key di sini
            var dbs = await indexedDB.databases();
            for (var dbInfo of dbs) {
              try {
                var db = await new Promise((resolve, reject) => {
                  var req = indexedDB.open(dbInfo.name);
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                });
                var storeNames = Array.from(db.objectStoreNames || []);
                for (var storeName of storeNames) {
                  try {
                    var tx = db.transaction(storeName, 'readonly');
                    var store = tx.objectStore(storeName);
                    var allKeys = await new Promise((resolve, reject) => {
                      var req = store.getAll();
                      req.onsuccess = () => resolve(req.result);
                      req.onerror = () => reject(req.error);
                    });
                    var json = JSON.stringify(allKeys);
                    if (json.includes('public') || json.includes('Public') || json.includes('ECDH') || json.includes('ticket')) {
                      // Cari base64 encoded public key pattern
                      var m = json.match(/B[A-Za-z0-9+\\/=]{40,100}/);
                      if (m) return { key: m[0], source: 'indexeddb:' + dbInfo.name + '/' + storeName };
                    }
                  } catch(e) {}
                }
                db.close();
              } catch(e) {}
            }
            return null;
          } catch(e) { return null; }
        })()`);
        if (dbKey && dbKey.key) {
          ticketGuardPublicKey = dbKey.key;
          log(`🔑 Ticket Guard Public Key dari ${dbKey.source}: ${ticketGuardPublicKey.substring(0, 30)}...`);
        }
      } catch {}
    }

    log(`🔑 Ticket Guard Public Key setelah trigger: ${ticketGuardPublicKey ? '✓ Ada' : '❌ Masih kosong'}`);
  }

  log(`📦 Payload Debug: music_pre_check_id="${detectedMusicPreCheckId}", video_id="${finalVideoId}", size=${videoWidth}x${videoHeight}, duration=${durationMs}ms, schedule=${targetSchedule}`);
  log(`🔑 Final Ticket Guard Key: ${ticketGuardPublicKey ? ticketGuardPublicKey.substring(0, 40) + '...' : 'KOSONG'}`);
  log(`Mengirim POST Request ke TikTok Studio API (Product ID: ${options.productId}, Schedule Epoch: ${targetSchedule}, Creation ID: ${creationId})...`);

  // URL dengan msToken dari cookie (seperti captured successful request)
  const postUrl = 'https://www.tiktok.com/tiktok/web/project/post/v1/?app_name=tiktok_web&channel=tiktok_web&device_platform=web&tz_name=Asia%2FJakarta&aid=1988'
    + (msToken ? '&msToken=' + encodeURIComponent(msToken) : '');

  // Self-Invoking IIFE String yang dieksekusi murni di browser
  // PENTING: Header harus match dengan captured successful request.
  // tt-ticket-guard-result: 1001 = public key missing → HARUS kirim Tt-Ticket-Guard-Public-Key
  // tt-ticket-guard-result: 1104 = validation passed (success)
  const evalScript = `(async () => {
    try {
      var csrfToken = ${JSON.stringify(csrfToken)};
      if (!csrfToken) {
        var match = document.cookie.match(/(?:^|; )tt_csrf_token=([^;]*)/) || document.cookie.match(/(?:^|; )csrf_session_id=([^;]*)/);
        csrfToken = match ? decodeURIComponent(match[1]) : '';
      }

      // Build headers matching captured successful request
      var headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Tt-Ticket-Guard-Web-Version': '1',
        'Tt-Ticket-Guard-Version': '2',
        'Tt-Ticket-Guard-Iteration-Version': '0'
      };

      // Include Ticket Guard Public Key jika tersedia
      var publicKey = ${JSON.stringify(ticketGuardPublicKey)};
      if (publicKey) {
        headers['Tt-Ticket-Guard-Public-Key'] = publicKey;
      }

      var res = await fetch(${JSON.stringify(postUrl)}, {
        method: 'POST',
        credentials: 'include',
        headers: headers,
        body: ${JSON.stringify(JSON.stringify(payload))}
      });
      var data = await res.json();
      var respHeaders = {};
      try { res.headers.forEach(function(v, k) { respHeaders[k] = v; }); } catch(e) {}
      return { ok: res.ok, status: res.status, data: data, csrfToken: csrfToken, responseHeaders: respHeaders };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })()`;

  const response: any = await page.evaluate(evalScript);

  if (browser) {
    await browser.close().catch(() => {});
  }

  log(`Hasil respons API: ${JSON.stringify(response)}`);

  if (response?.data?.status_code === 0) {
    log(`✅ Video Affiliate berhasil diposting via API! (Project ID: ${response.data.project_id})`);
    return {
      success: true,
      projectId: response.data.project_id,
      itemId: response.data.single_post_resp_list?.[0]?.item_id || '',
      response: response.data
    };
  } else {
    const errorMsg = response?.data?.status_msg || response?.error || `HTTP ${response?.status}`;
    log(`❌ Gagal posting via API (Status Code: ${response?.data?.status_code}): ${errorMsg}`);
    if (response?.responseHeaders) {
      log(`📋 Response Headers: ${JSON.stringify(response.responseHeaders)}`);
    }
    throw new Error(`TikTok Post API Error (${response?.data?.status_code || 'Fail'}): ${errorMsg}`);
  }
}

// Test script runner
if (process.argv[1]?.includes('tiktok_api_post')) {
  console.log('🧪 Memulai tes posting TikTok Affiliate API...');
  postTikTokAffiliateVideoApi({
    stateFile: 'tiktok-state-herbalily.json',
    description: 'tes grok ini deskripsi',
    productTitle: 'ini nama produk',
    productId: '1729748856299095594'
  }).then(res => console.log('Result:', res))
    .catch(console.error);
}
