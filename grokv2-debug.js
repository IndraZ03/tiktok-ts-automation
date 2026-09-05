// ═══════════════════════════════════════════════════════════════════════
//  grokv2-debug.js — Sistem debug/log lengkap untuk generasi video Grok V2
//  (dipakai oleh grokbotv2 via tiktok-state-manager; sumber logika berasal
//   dari grokv2test.js).
//
//  Isi modul:
//    - GROK_FETCH_LOGGER_SRC        : inject script fetch-logger (catat SEMUA
//                                     fetch di dalam halaman Grok + body error
//                                     4xx/5xx untuk debugging 429 / refresh).
//    - GROK_GENERATE_WRAPPER_SRC    : wrapper __GROK_API_V2_GENERATE (log awal/
//                                     akhir setiap generasi + status lengkap).
//    - buildDebugInitScript()       : gabungkan fetch-logger + grok_api_browser.
//    - attachPageDebugListeners()   : pasang listener console/pageerror/
//                                     requestfailed/dialog pada page.
//    - collectFetchLog()            : ambil array fetch log dari window.
//    - filterFetchLogLegends()      : ambil baris penting (error/429/403/SSE).
//    - dumpFetchLogToFile()         : tulis fetch log ke file JSON ber-stempel.
// ═══════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

// ── Fetch logger (dijalankan DI DALAM halaman Grok) ────────────────────
export const GROK_FETCH_LOGGER_SRC = `(function () {
  if (window.__GROK_DEBUG_INSTALLED) return;
  window.__GROK_DEBUG_INSTALLED = true;
  window.__GROK_FETCH_LOG = [];
  function _logFetch(e) {
    window.__GROK_FETCH_LOG.push(e);
    if (window.__GROK_FETCH_LOG.length > 5000) window.__GROK_FETCH_LOG.shift();
    var important = (e.status >= 400 && e.status !== 404) || e.status === 0;
    if (important) {
      try { console.log('[GROK-FETCH-ERR] ' + e.method + ' ' + (e.status || 'ERR') + ' ' + e.ms + 'ms ' + String(e.url).slice(0, 170) + (e.note ? ' | ' + e.note : '')); } catch (_) {}
    } else if (String(e.url).indexOf('conversations') >= 0 || String(e.url).indexOf('upload-file-v2') >= 0 || String(e.url).indexOf('quota_info') >= 0) {
      try { console.log('[GROK-FETCH] ' + e.method + ' ' + e.status + ' ' + e.ms + 'ms ' + String(e.url).slice(0, 160)); } catch (_) {}
    }
  }
  var _origGrokFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var t0 = performance.now();
    var isGrok = !!url && (url.indexOf('grok.com') >= 0 || url.indexOf('x.ai') >= 0);
    try {
      var res = await _origGrokFetch(input, init);
      var ms = Math.round(performance.now() - t0);
      var note = '';
      if (!res.ok && isGrok) {
        try { var clone = res.clone(); var body = await clone.text(); note = 'BODY: ' + body.slice(0, 350).replace(/\\s+/g, ' '); } catch (e) { note = '(gagal baca body)'; }
      }
      if (isGrok) _logFetch({ t: Date.now(), ms: ms, method: method, url: url, status: res.status, ok: res.ok, note: note });
      return res;
    } catch (e) {
      if (isGrok) _logFetch({ t: Date.now(), ms: Math.round(performance.now() - t0), method: method, url: url, status: 0, ok: false, note: 'FETCH ERROR: ' + String((e && e.message) || e).slice(0, 250) });
      throw e;
    }
  };
})();
`;

// ── Wrapper generate (log awal/akhir di console halaman) ────────────────
export const GROK_GENERATE_WRAPPER_SRC = `(function () {
  var _g = window.__GROK_API_V2_GENERATE;
  if (typeof _g === 'function') {
    window.__GROK_API_V2_GENERATE = async function (o) {
      try { console.log('[GROK-V2-BR] generate START prompt=' + String((o.prompt || '').slice(0, 60)) + ' image=' + (!!o.imageData) + ' ' + (o.resolution || '') + ' ' + (o.duration || '') + ' ' + (o.aspectRatio || '')); } catch (_) {}
      var t0 = performance.now();
      var st = await _g(o);
      var ms = Math.round(performance.now() - t0);
      try {
        console.log('[GROK-V2-BR] generate END ' + ms + 'ms status=' + st.status + ' rateLimited=' + st.rateLimited + ' http=' + st.httpStatus + ' transient=' + st.transientRateLimit + ' stale=' + (st.stalePage || false) + ' video=' + (st.videoUrl ? 'YA' : 'TIDAK') + ' err=' + String(st.error || '').slice(0, 160));
      } catch (_) {}
      return st;
    };
  }
})();
`;

// ── Spoof webdriver (sama dengan client asli) ──────────────────────────
export const GROK_WEBDRIVER_SPOOF_SRC = `(function () {
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

// ── Gabungkan semua init script ────────────────────────────────────────
export function buildDebugInitScript(browserScript) {
  return GROK_FETCH_LOGGER_SRC + '\n' + browserScript + '\n' + GROK_GENERATE_WRAPPER_SRC + '\n' + GROK_WEBDRIVER_SPOOF_SRC;
}
// ── Listener page -> callback (event, detail) ───────────────────────────
export function attachPageDebugListeners(page, onEvent) {
  const emit = (event, message) => { try { onEvent && onEvent(event, message); } catch (_) {} };
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[GROK-FETCH]') || text.startsWith('[GROK-FETCH-ERR]') || text.startsWith('[GROK-V2-BR]')) {
      emit('console:fetch', text);
    } else if (msg.type() === 'error' || msg.type() === 'warning') {
      emit('console', `${msg.type()}: ${text.slice(0, 300)}`);
    }
  });
  page.on('pageerror', (err) => emit('pageerror', String((err && err.stack) || (err && err.message) || err).slice(0, 800)));
  page.on('requestfailed', (req) => emit('requestfailed', `${req.method()} ${req.url().slice(0, 170)} ${(req.failure() && req.failure().errorText) || ''}`));
  page.on('dialog', async (d) => {
    emit('dialog', `${d.type()}: ${d.message().slice(0, 200)}`);
    try { await d.dismiss(); } catch (_) {}
  });
}

// ── Ambil fetch log dari halaman ───────────────────────────────────────
export async function collectFetchLog(page) {
  try {
    return await page.evaluate(() => Array.isArray(window.__GROK_FETCH_LOG) ? window.__GROK_FETCH_LOG : []);
  } catch (_) {
    return [];
  }
}

// ── Baris penting untuk ditampilkan ringkas ────────────────────────────
export function filterFetchLogLegends(entries, max = 40) {
  const critical = (entries || []).filter(e => (e.status >= 400 && e.status !== 404) || e.status === 0);
  const interesting = (entries || []).filter(e => !critical.includes(e)
    && (String(e.url).includes('conversations') || String(e.url).includes('upload-file-v2')
      || String(e.url).includes('quota_info') || String(e.url).includes('/rest/assets/')));
  const pick = critical.concat(interesting).slice(0, max);
  if (pick.length === 0) return ['  (tidak ada fetch log terkait)'];
  return pick.map(e => `  ${e.method || '?'} ${e.status || 'ERR'} ${e.ms}ms ${String(e.url).slice(0, 130)}${e.note ? ' | ' + e.note.slice(0, 220) : ''}`);
}

// ── Tulis fetch log ke file JSON ber-stempel waktu ─────────────────────
export async function dumpFetchLogToFile(page, dir, label) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entries = await collectFetchLog(page);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fname = `${label || 'grok-debug'}-${stamp}.json`;
    fs.writeFileSync(path.join(dir, fname), JSON.stringify({ capturedAt: new Date().toISOString(), entries }, null, 2));
    return { fname, count: entries.length };
  } catch (e) {
    return { fname: null, count: 0, error: String((e && e.message) || e) };
  }
}
