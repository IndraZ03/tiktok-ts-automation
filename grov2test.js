#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  grokv2test.js — Debug runner: generate 1 VIDEO via Grok V2 API
//  (metode newgroksystem: upload file -> POST /rest/app-chat/conversations/new)
//  Log LENGKAP di tiap tahap + tangkap seluruh fetch di dalam halaman
//  (status, durasi, dan body error 429/403), supaya bisa debugging
//  "Too Many Requests" dan "refresh/reload to continue".
//
//  Cara pakai (dari root project):
//    node grokv2test.js --state inovasi --prompt "drone view" [--image "bahan/tab_xprime/gambar.jpg"]
//    node grokv2test.js --state inovasi --prompt-file "prompt/Test.json" --bahan "bahan/tab_xprime" --headed
//    node grokv2test.js --state indra --prompt "tes ..." --image "..." --resolution 720p --duration 10s --aspect-ratio 9:16
//
//  Argumen:
//    --state <nama>        nama state di grok-states/ (default: inovasi)
//    --prompt "<teks>"     prompt langsung
//    --prompt-file <path>  file JSON {prompt} atau {prompts:[...]}
//    --image <path>        gambar referensi (image-to-video)
//    --bahan <folder>      folder gambar -> pilih 1 acak
//    --resolution 720p|1080p
//    --duration 5s|10s
//    --aspect-ratio 9:16|1:1|16:9
//    --headed              pakai browser terlihat (default headless)
//    --refresh-retries N   maks. retry saat Grok minta refresh (default 2)
//    --gen-timeout-ms M    timeout proses generate (default 480000)
//    --no-download         jangan unduh video hasil
// ═══════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const ROOT = process.cwd();

// ─────────────────────────── Utilities ───────────────────────────
function parseArgs(argv) {
  const opts = {
    state: 'inovasi',
    prompt: null,
    promptFile: null,
    image: null,
    bahan: null,
    resolution: '720p',
    duration: '10s',
    aspectRatio: '9:16',
    headless: true,
    refreshRetries: 2,
    genTimeoutMs: 480000,
    noDownload: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--state') opts.state = next();
    else if (a === '--prompt') opts.prompt = next();
    else if (a === '--prompt-file') opts.promptFile = next();
    else if (a === '--image') opts.image = next();
    else if (a === '--bahan') opts.bahan = next();
    else if (a === '--resolution') opts.resolution = next();
    else if (a === '--duration') opts.duration = next();
    else if (a === '--aspect-ratio') opts.aspectRatio = next();
    else if (a === '--headed' || a === '--headful') opts.headless = false;
    else if (a === '--headless') opts.headless = true;
    else if (a === '--refresh-retries') opts.refreshRetries = Number(next()) || 0;
    else if (a === '--gen-timeout-ms') opts.genTimeoutMs = Number(next()) || 480000;
    else if (a === '--no-download') opts.noDownload = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(1, 30).join('\n'));
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function createLogger(logFilePath) {
  const lines = [];
  if (logFilePath) fs.writeFileSync(logFilePath, '');
  const push = (msg) => {
    const line = `[${ts()}] ${msg}`;
    lines.push(line);
    console.log(line);
    if (logFilePath) {
      try { fs.appendFileSync(logFilePath, line + '\n'); } catch {}
    }
  };
  return { push, lines };
}

function banner(log, title) {
  const bar = '='.repeat(70);
  log.push('');
  log.push(bar);
  log.push(`  ${title}`);
  log.push(bar);
}

// Laporan kesehatan cookie dari file state (diagnosis "refresh"/403)
function cookieStatusReport(statePath, log) {
  if (!fs.existsSync(statePath)) {
    log.push(`  x State file tidak ditemukan: ${statePath}`);
    return;
  }
  let data = null;
  try { data = JSON.parse(fs.readFileSync(statePath, 'utf-8')); }
  catch (e) { log.push(`  x Gagal parse state JSON: ${e.message}`); return; }
  const nowSec = Date.now() / 1000;
  const cookies = data.cookies || [];
  log.push(`  [Cookie] Isi cookie penting di ${path.basename(statePath)}:`);
  const names = ['sso', 'sso-rw', 'x-userid', 'grok_device_id', 'cf_clearance', '__cf_bm'];
  for (const c of cookies) {
    if (!c || !names.includes(c.name)) continue;
    const expTxt = c.expires ? new Date(c.expires * 1000).toISOString() : '(session)';
    const ok = !c.expires || c.expires > nowSec;
    log.push(`     ${ok ? '[OK]' : '[EXPIRED]'} ${c.name.padEnd(14)} exp=${expTxt}`);
    if (c.name === 'cf_clearance' || c.name === '__cf_bm') {
      log.push(`        value=${String(c.value).slice(0, 48)}...`);
    }
  }
  const hasClearance = cookies.some(c => c.name === 'cf_clearance');
  if (!hasClearance) {
    log.push(`  [WARN] TIDAK ADA cf_clearance di state! Cloudflare clearance habis.`);
    log.push(`         Kemungkinan besar penyebab Grok minta 'refresh'. Re-export state dari Chrome asli!`);
  }
}

// ───────────────── Siapkan inject script (browser-side) ─────────────────
function buildInitScript(browserScriptPath, log) {
  if (!fs.existsSync(browserScriptPath)) throw new Error(`Browser script tidak ada: ${browserScriptPath}`);
  const browserScript = fs.readFileSync(browserScriptPath, 'utf-8');

  // 1) Patch fetch GLOBAL - catat SEMUA request dari dalam halaman
  //    (method, url, status, durasi ms, body error utk 4xx/5xx / 429 / refresh).
  const fetchPatch = `(function () {
  window.__GROK_FETCH_LOG = [];
  function _logFetch(e) {
    window.__GROK_FETCH_LOG.push(e);
    var line = '[GROK-FETCH] ' + e.method + ' ' + (e.status || 'ERR') + ' ' + e.ms + 'ms ' + String(e.url).slice(0, 170) + (e.note ? ' | ' + e.note : '');
    try { console.log(line); } catch (_) {}
  }
  var _orig = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var t0 = performance.now();
    try {
      var res = await _orig(input, init);
      var ms = Math.round(performance.now() - t0);
      var note = '';
      if (!res.ok) {
        try {
          var clone = res.clone();
          var body = await clone.text();
          note = 'BODY: ' + body.slice(0, 350).replace(/\\s+/g, ' ');
        } catch (e) { note = '(gagal baca body)'; }
      }
      _logFetch({ t: Date.now(), ms: ms, method: method, url: url, status: res.status, ok: res.ok, note: note });
      return res;
    } catch (e) {
      _logFetch({ t: Date.now(), ms: Math.round(performance.now() - t0), method: method, url: url, status: 0, ok: false, note: 'FETCH ERROR: ' + String((e && e.message) || e).slice(0, 250) });
      throw e;
    }
  };
})();
`;

  // 2) Wrapper generate() - log awal & akhir lengkap hasilnya.
  const apiHook = `(function () {
  var _g = window.__GROK_API_V2_GENERATE;
  if (typeof _g === 'function') {
    window.__GROK_API_V2_GENERATE = async function (o) {
      console.log('[GROK-V2-BR] generate START config=' + JSON.stringify({
        prompt: String((o.prompt || '').slice(0, 80)),
        adaGambar: !!o.imageData,
        imageName: o.imageName || '',
        resolusi: o.resolution,
        durasi: o.duration,
        rasio: o.aspectRatio,
        statsigId: !!o.statsigId
      }));
      var t0 = performance.now();
      var st = await _g(o);
      var ms = Math.round(performance.now() - t0);
      console.log('[GROK-V2-BR] generate END ' + ms + 'ms | status=' + st.status +
        ' rateLimited=' + st.rateLimited + ' httpStatus=' + st.httpStatus +
        ' transient=' + st.transientRateLimit + ' retryAfterMs=' + st.retryAfterMs +
        ' stale=' + (st.stalePage || false) + ' videoUrl=' + (st.videoUrl || '') +
        ' err=' + String(st.error || '').slice(0, 200));
      return st;
    };
  } else {
    console.log('[GROK-V2-BR] PERINGATAN: __GROK_API_V2_GENERATE tidak terpasang!');
  }
})();
`;

  // 3) Spoof webdriver secara aman dan idempotent. Pada Chrome tertentu
  // properti ini non-configurable sehingga defineProperty langsung memicu
  // "Cannot redefine property: webdriver".
  const webdriverPatch = `(function () {
  try {
    if (window.__GROK_WEBDRIVER_SPOOFED) return;
    window.__GROK_WEBDRIVER_SPOOFED = true;
    var descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    if (descriptor && descriptor.configurable === false) return;
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      get: function () { return undefined; }
    });
  } catch (_) {}
})();`;

  const combined = fetchPatch + '\n' + browserScript + '\n' + apiHook + '\n' + webdriverPatch;
  log.push(`  [Build] Init script disusun (${combined.length} chars): fetch-logger + grok_api_browser.js + wrapper generate`);
  return { content: combined };
}

// ────────────────── Wait hingga halaman Grok siap dipakai ──────────────────
async function waitGrokReady(page, context, log, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastSummary = '';
  try { await page.waitForLoadState('load', { timeout: 30000 }); } catch {}
  try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}

  while (Date.now() < deadline) {
    const cookies = await context.cookies('https://grok.com');
    const hasClearance = cookies.some(c => c.name === 'cf_clearance');
    const stat = await page.evaluate(async () => {
      const hasApi = typeof window.__GROK_API_V2_GENERATE === 'function';
      let authenticated = false, stale = false, statusCode = 0, bodyHead = '';
      try {
        const r = await fetch('https://grok.com/api/auth/session', { credentials: 'include' });
        statusCode = r.status;
        const t = await r.text();
        bodyHead = t.slice(0, 150);
        authenticated = r.ok && /"session"\s*:/.test(t) && !/"session"\s*:\s*null/.test(t);
        stale = r.status === 403 && /out of date|reload to continue/i.test(t);
      } catch (e) { bodyHead = 'fetch error: ' + String((e && e.message) || e); }
      return { hasApi, authenticated, stale, statusCode, bodyHead, readyState: document.readyState };
    });

    const summary = `hasApi=${stat.hasApi} auth=${stat.authenticated} stale=${stat.stale} http=${stat.statusCode} cf_clearance=${hasClearance} ready=${stat.readyState}`;
    if (summary !== lastSummary) {
      log.push(`  [Ready] ${summary}`);
      log.push(`          sessionBody=${stat.bodyHead}`);
      lastSummary = summary;
    }

    if (stat.stale) {
      // Code 7 invalidates the current browser context. Repeating reload on
      // the same document only reproduces the stale response.
      throw new Error('GROK_STALE_PAGE: code:7 / This page is out of date; buat sesi browser baru.');
    } else if (stat.hasApi && stat.authenticated && (hasClearance || Date.now() + 15000 > deadline)) {
      log.push(`  [Ready] Halaman siap dipakai: API ada, auth OK, cf_clearance=${hasClearance}`);
      await page.waitForTimeout(8000);
      return { ...stat, hasClearance };
    }
    await page.waitForTimeout(2000);
  }

  const finalCheck = await page.evaluate(() => ({ hasApi: typeof window.__GROK_API_V2_GENERATE === 'function' }));
  throw new Error(`Grok Imagine tidak siap setelah ${timeoutMs}ms. Final hasApi=${finalCheck.hasApi}`);
}

// ──────────────────── Pre-check kuota & identitas akun ────────────────────
async function checkQuotaAndSession(page, log) {
  banner(log, 'PRE-CHECK: Kuota & Session');
  const quota = await page.evaluate(async () => {
    const r = await fetch('https://grok.com/rest/media/imagine/quota_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: '{}'
    });
    return { status: r.status, text: await r.text() };
  });
  log.push(`  quota_info  -> HTTP ${quota.status}: ${quota.text.slice(0, 600)}`);
  if (quota.status === 429 || /too many|rate limit/i.test(quota.text)) {
    log.push(`  [WARN] quota_info KENA LIMIT! Cek body di atas.`);
  }

  const sess = await page.evaluate(async () => {
    const r = await fetch('https://grok.com/api/auth/session', { credentials: 'include' });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  });
  const account = sess.json && sess.json.session
    ? `${sess.json.session.givenName || ''} <${sess.json.session.email || ''}>`
    : '(tidak dapat identitas)';
  log.push(`  /api/auth/session -> HTTP ${sess.status}: account=${account}`);
}

// ──────────────────── Muat prompt (file atau teks) ────────────────────
function loadPrompt(opts, log) {
  if (opts.prompt) {
    log.push(`  [Prompt] Dipakai langsung dari --prompt (${opts.prompt.length} chars)`);
    return opts.prompt.trim();
  }
  if (opts.promptFile) {
    const p = path.isAbsolute(opts.promptFile) ? opts.promptFile : path.join(ROOT, opts.promptFile);
    if (!fs.existsSync(p)) throw new Error(`File prompt tidak ada: ${p}`);
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    let prompt = null;
    if (typeof data.prompt === 'string') prompt = data.prompt;
    else if (Array.isArray(data.prompts) && data.prompts.length > 0) prompt = data.prompts[Math.floor(Math.random() * data.prompts.length)];
    else {
      for (const v of Object.values(data)) {
        if (typeof v === 'string' && v.length > 5) { prompt = v; break; }
      }
    }
    if (!prompt) throw new Error(`Prompt tidak ditemukan di ${p}`);
    log.push(`  [Prompt] Dari file ${p} (${prompt.length} chars)`);
    return prompt.trim();
  }
  throw new Error('Prompt kosong — gunakan --prompt atau --prompt-file');
}

// ──────────────────── Pilih gambar referensi ────────────────────
function pickImage(opts, log) {
  let img = opts.image;
  if (!img && opts.bahan) {
    const dir = path.isAbsolute(opts.bahan) ? opts.bahan : path.join(ROOT, opts.bahan);
    if (!fs.existsSync(dir)) throw new Error(`Folder bahan tidak ada: ${dir}`);
    const files = fs.readdirSync(dir)
      .filter(f => /\.(jpe?g|png|webp|bmp)$/i.test(f))
      .map(f => path.join(dir, f));
    if (files.length === 0) throw new Error(`Tidak ada file gambar di ${dir}`);
    img = files[Math.floor(Math.random() * files.length)];
    log.push(`  [Gambar] Auto-pilih dari ${dir}: ${path.basename(img)}`);
  }
  if (!img) {
    log.push(`  [Gambar] Tanpa gambar referensi (text-to-video)`);
    return null;
  }
  const full = path.isAbsolute(img) ? img : path.join(ROOT, img);
  if (!fs.existsSync(full)) throw new Error(`File gambar tidak ada: ${full}`);
  const stat = fs.statSync(full);
  log.push(`  [Gambar] ${full} (${stat.size} bytes, ${path.extname(full)})`);
  return full;
}

// ──────────────────── Unduh video hasil ────────────────────
async function downloadVideo(page, videoUrl, log, opts) {
  if (opts.noDownload) {
    log.push(`  [Download] --no-download aktif, dilewati. videoUrl=${videoUrl}`);
    return null;
  }
  const dlDir = path.join(ROOT, 'grov2test-downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  log.push(`  [Download] Memanggil __GROK_API_V2_DOWNLOAD('${String(videoUrl).slice(0, 120)}') ...`);
  const res = await page.evaluate(async (u) => {
    try {
      return await window.__GROK_API_V2_DOWNLOAD(u);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }, videoUrl);
  if (!res || !res.ok) {
    log.push(`  [Download] GAGAL: ${JSON.stringify(res)}`);
    return null;
  }
  const b64 = String(res.data || '');
  const commaIdx = b64.indexOf(',');
  const raw = commaIdx >= 0 ? b64.slice(commaIdx + 1) : b64;
  const bytes = Buffer.from(raw, 'base64');
  const fname = `grov2test_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
  const fpath = path.join(dlDir, fname);
  fs.writeFileSync(fpath, bytes);
  log.push(`  [Download] ✅ Tersimpan: ${fpath} (${bytes.length} bytes)`);
  return fpath;
}
// ═══════════════════════════════ MAIN ═══════════════════════════════
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFile = path.join(ROOT, `grov2test-${opts.state}-${runStamp}.log`);
  const log = createLogger(logFile);

  banner(log, `GROK V2 TEST - generate 1 video (state=${opts.state})`);
  log.push(`  Argumen: ${JSON.stringify({ state: opts.state, resolution: opts.resolution, duration: opts.duration, aspectRatio: opts.aspectRatio, headless: opts.headless, refreshRetries: opts.refreshRetries, genTimeoutMs: opts.genTimeoutMs, noDownload: opts.noDownload })}`);
  log.push(`  Log file: ${logFile}`);

  // 1) Cek state
  const statePath = path.join(ROOT, 'grok-states', `grok-state-${opts.state}.json`);
  if (!fs.existsSync(statePath)) {
    log.push(`  [FATAL] State file tidak ditemukan: ${statePath}`);
    log.push(`         Isi folder grok-states:`);
    if (fs.existsSync(path.join(ROOT, 'grok-states'))) {
      fs.readdirSync(path.join(ROOT, 'grok-states')).forEach(f => log.push(`           - ${f}`));
    }
    return 1;
  }
  cookieStatusReport(statePath, log);

  // 2) Prompt & gambar
  let prompt;
  try {
    prompt = loadPrompt(opts, log);
    log.push(`  [Prompt] ${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}`);
  } catch (e) { log.push(`  [FATAL] ${e.message}`); return 1; }
  let imagePath = null;
  try { imagePath = pickImage(opts, log); } catch (e) { log.push(`  [FATAL] ${e.message}`); return 1; }

  // 3) Browser session
  banner(log, 'LAUNCH BROWSER');
  let browser = null;
  try {
    log.push(`  chromium.launch(headless=${opts.headless}, channel=chrome)`);
    browser = await chromium.launch({
      headless: opts.headless,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const context = await browser.newContext({
      storageState: statePath,
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Asia/Makassar',
      acceptDownloads: true,
    });
    const page = await context.newPage();

    // 4) Init script: fetch-logger + API browser + wrapper
    const init = buildInitScript(path.join(ROOT, 'grok_api_browser.js'), log);
    await page.addInitScript(init);

    // 5) Instrument halaman (console / error / failed request)
    page.on('console', msg => {
      const t = msg.text();
      // Semua GROK-FETCH (sukses & error) masuk log — lengkap untuk debugging.
      if (t.startsWith('[GROK-FETCH]') || t.startsWith('[GROK-V2-BR]')) {
        log.push(`  ${t.slice(0, 300)}`);
        return;
      }
      log.push(`  [PAGE-CONSOLE] ${t.slice(0, 200)}`);
    });
    page.on('pageerror', err => log.push(`  [PAGE-ERROR] ${err.stack || err.message}`));
    page.on('requestfailed', req => log.push(`  [REQ-FAILED] ${req.method()} ${req.url().slice(0, 160)} ${req.failure()?.errorText || ''}`));
    page.on('dialog', async d => { log.push(`  [DIALOG] ${d.type()}: ${d.message()}`); await d.dismiss().catch(() => {}); });

    const session = { browser, context, page, stateName: opts.state, statsigId: '', requestMetadata: {} };
    const metadataHeaders = ['baggage', 'sentry-trace', 'traceparent'];
    page.on('request', request => {
      if (!request.url().startsWith('https://grok.com/')) return;
      const headers = request.headers();
      if (!session.statsigId && headers['x-statsig-id']) session.statsigId = headers['x-statsig-id'];
      for (const name of metadataHeaders) {
        if (!session.requestMetadata[name] && headers[name]) session.requestMetadata[name] = headers[name];
      }
    });

    // 6) Navigasi + tunggu siap
    banner(log, 'NAVIGASI KE GROK IMAGINE');
    log.push(`  page.goto('https://grok.com/imagine?fresh=...') ...`);
    await page.goto(`https://grok.com/imagine?fresh=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
    await waitGrokReady(page, context, log, 120000);
    log.push(`  [Info] statsigId=${session.statsigId ? 'tertangkap' : 'KOSONG'} requestMetadata=${JSON.stringify(session.requestMetadata)}`);

    // 7) Cek kuota & akun
    await checkQuotaAndSession(page, log);

    // 8) Siapkan konfigurasi generate
    banner(log, 'GENERATE VIDEO (1x)');
    const durationNum = parseInt(String(opts.duration).replace(/\D/g, ''), 10) || 10;
    const genCfg = {
      prompt,
      imageData: imagePath ? fs.readFileSync(imagePath).toString('base64') : null,
      imageMime: imagePath ? (path.extname(imagePath).toLowerCase() === '.png' ? 'image/png'
        : path.extname(imagePath).toLowerCase() === '.webp' ? 'image/webp'
        : path.extname(imagePath).toLowerCase() === '.bmp' ? 'image/bmp' : 'image/jpeg') : 'image/jpeg',
      imageName: imagePath ? path.basename(imagePath) : 'ref.jpg',
      resolution: opts.resolution === '1080p' ? '1080p' : '720p',
      duration: durationNum,
      aspectRatio: opts.aspectRatio,
      statsigId: session.statsigId || '',
      requestMetadata: session.requestMetadata,
    };
    log.push(`  Config: resolution=${genCfg.resolution} duration=${genCfg.duration}s aspectRatio=${genCfg.aspectRatio} image=${imagePath ? path.basename(imagePath) : '-'}`);

    // 9) Jalankan generate sekali. Jika code:7 muncul, sesi ini dianggap
    // rusak; jangan reload halaman yang sama berulang-ulang.
    const runGeneration = () => {
      const p = page.evaluate((o) => window.__GROK_API_V2_GENERATE(o), genCfg);
      if (!opts.genTimeoutMs) return p;
      return Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`GENERATE TIMEOUT setelah ${opts.genTimeoutMs}ms`)), opts.genTimeoutMs)),
      ]);
    };
    let lastProgressSignature = '';
    let lastProgressLogAt = 0;
    const generationStartedAt = Date.now();
    const poll = setInterval(async () => {
      try {
        const st = await page.evaluate(() => window.__GROK_NEW_STATE);
        if (st) {
          const progress = Number(st.progress) || 0;
          const phase = st.message || (progress < 20 ? 'Menyiapkan request' : progress < 35 ? 'Mengirim request ke Grok' : 'Menunggu respons/video dari Grok');
          const signature = `${progress}|${phase}|${st.status}|${st.httpStatus}|${st.rateLimited}|${st.videoUrl ? 'video' : ''}`;
          const now = Date.now();
          if (signature !== lastProgressSignature || now - lastProgressLogAt >= 10000) {
            lastProgressSignature = signature;
            lastProgressLogAt = now;
            const elapsed = Math.round((now - generationStartedAt) / 1000);
            log.push(`  [Progress +${elapsed}s] ${progress}% | tahap=${phase} | status=${st.status || 'running'} | rateLimited=${!!st.rateLimited} | http=${st.httpStatus || 0}${st.videoUrl ? ' | video URL ditemukan' : ''}`);
          }
        }
      } catch {}
    }, 2500);

    let result = null;
    try {
      log.push('  --- Percobaan generate #1 ---');
      result = await runGeneration();
      if (result && (result.stalePage || result.status === 'stale')) {
        log.push('  [STALE] Code:7 terdeteksi. Tidak reload halaman; sesi ini harus dibuat ulang.');
      }
    } finally {
      clearInterval(poll);
    }

    // 10) Analisis hasil
    banner(log, 'ANALISIS HASIL');
    if (!result) {
      log.push(`  [FATAL] generate() tidak mengembalikan hasil (null).`);
      throw new Error('generate() mengembalikan null');
    }
    log.push(`  status=${result.status} progress=${result.progress} rateLimited=${result.rateLimited}`);
    log.push(`  httpStatus=${result.httpStatus} transientRateLimit=${result.transientRateLimit} retryAfterMs=${result.retryAfterMs}`);
    log.push(`  availableAt=${result.availableAt || '-'} stalePage=${result.stalePage || false}`);
    log.push(`  videoUrl=${result.videoUrl || '(belum ada)'} conversationId=${result.conversationId || '-'} assetId=${result.assetId || '-'}`);
    log.push(`  error=${result.error ? result.error.slice(0, 500) : '-'}`);

    const isRateLimited = !!result.rateLimited || !!result.transientRateLimit || result.httpStatus === 429;
    const isStale = !!result.stalePage || result.status === 'stale';
    const isDone = !!result.videoUrl;

    let savedPath = null;
    if (isDone) {
      log.push(`  [OK] Video ditemukan, lanjut download.`);
      savedPath = await downloadVideo(page, result.videoUrl, log, opts);
    } else if (isRateLimited) {
      log.push(`  [RATE-LIMIT] ${result.transientRateLimit ? 'TOO MANY REQUESTS (429)' : 'Rate limit akun'}.`);
      log.push(`     Baca body error 429/403 di log [GROK-FETCH] di atas untuk detail pesan Grok.`);
      if (result.availableAt) log.push(`     Tersedia kembali: ${result.availableAt}`);
    } else if (isStale) {
      log.push(`  [STALE] Grok meminta REFRESH (session out of date / reload to continue).`);
      log.push(`     Penyebab paling umum: cookie cf_clearance/__cf_bm di state sudah basi/hilang.`);
    } else {
      log.push(`  [ERROR] status=${result.status} -> ${result.error || '(tanpa pesan)'}`);
    }

    // 11) Dump fetch log ke file JSON
    banner(log, 'DUMP FETCH LOG');
    let fetchLog = [];
    try { fetchLog = await page.evaluate(() => window.__GROK_FETCH_LOG || []); } catch {}
    log.push(`  Total fetch tercatat di dalam halaman: ${fetchLog.length}`);
    const capturedPath = path.join(ROOT, `grov2test-captured-${opts.state}-${runStamp}.json`);
    fs.writeFileSync(capturedPath, JSON.stringify({
      capturedAt: new Date().toISOString(),
      opts,
      fetchLog,
      resultSnippet: {
        status: result.status, httpStatus: result.httpStatus, rateLimited: result.rateLimited,
        transientRateLimit: result.transientRateLimit, stalePage: result.stalePage || false,
        videoUrl: result.videoUrl, error: (result.error || '').slice(0, 500), availableAt: result.availableAt,
      },
    }, null, 2));
    log.push(`  Captured JSON: ${capturedPath}`);

    // 12) Cookie setelah generate
    banner(log, 'COOKIE SETELAH GENERATE');
    const afterCookies = await context.cookies('https://grok.com');
    for (const c of afterCookies) {
      if (['sso', 'sso-rw', 'cf_clearance', '__cf_bm'].includes(c.name)) {
        log.push(`  ${c.name.padEnd(14)} exp=${c.expires ? new Date(c.expires * 1000).toISOString() : '(session)'} value=${String(c.value).slice(0, 40)}...`);
      }
    }

    // 13) Ringkasan
    banner(log, 'RINGKASAN');
    if (isDone) log.push(`  RESULT: BERHASIL 🎉 video=${savedPath || '(tidak diunduh)'}`);
    else if (isRateLimited) log.push(`  RESULT: RATE LIMIT / TOO MANY REQUESTS (${result.httpStatus || 429})`);
    else if (isStale) log.push(`  RESULT: STALE / GROK MINTA REFRESH`);
    else log.push(`  RESULT: GAGAL (${result.error || 'unknown'})`);
    log.push(`  Log file : ${logFile}`);
    log.push(`  Captured : ${capturedPath}`);

    await browser.close();
    log.push('');
    log.push(`  SELESAI. Lihat ${logFile} untuk log lengkap.`);
    return isDone ? 0 : 2;
  } catch (error) {
    log.push(`  [FATAL] ${error.stack || error.message}`);
    return 1;
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

// jalankan
main().then(code => {
  if (code) process.exitCode = code;
}).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
