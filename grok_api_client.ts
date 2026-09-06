// grok_api_client.ts - Client API Grok Imagine (State JSON, headless)
// DIPERBARUI: Pakai REST API baru (newgroksystem/generate.txt)
// Upload gambar -> POST /rest/app-chat/conversations/new (stream) -> unduh video.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';

export class RateLimitError extends Error {
  availableAt: string | null;
  constructor(availableAt: string | null) {
    super(`Rate limit reached${availableAt ? '. Tersedia kembali: ' + availableAt : ''}`);
    this.name = 'RateLimitError';
    this.availableAt = availableAt;
  }
}

export class GrokStalePageError extends Error {
  httpStatus: number;
  constructor(message = 'Grok meminta halaman dimuat ulang karena sesi halaman sudah kedaluwarsa.', httpStatus = 403) {
    super(message);
    this.name = 'GrokStalePageError';
    this.httpStatus = httpStatus;
  }
}

export interface GrokVideoV2Options {
  stateName?: string;
  promptText: string;
  imagePath?: string;
  resolution?: string;
  duration?: string;
  aspectRatio?: string;
  mode?: string;
  headless?: boolean;
}

export interface GrokV2Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  stateName: string;
  statsigId: string;
  requestMetadata: Record<string, string>;
}

export type GrokQuotaStatus = 'available' | 'exhausted' | 'expired' | 'unknown' | 'error';

export interface GrokQuotaInfo {
  stateFile: string;
  stateName: string;
  account: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  available: boolean;
  status: GrokQuotaStatus;
  checkedAt: string;
  error?: string;
}

function normalizeGrokStateName(value: string): string {
  return String(value || 'indra')
    .replace(/^grok-state-/i, '')
    .replace(/\.json$/i, '');
}

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function readQuotaVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length && shift <= 53) {
    const current = bytes[cursor++];
    value += (current & 0x7f) * 2 ** shift;
    if ((current & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  return null;
}

function readGrpcWebDataFrames(buffer: number[]): Uint8Array[] {
  const bytes = new Uint8Array(buffer);
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flags = bytes[offset];
    const length = bytes[offset + 1] * 0x1000000
      + bytes[offset + 2] * 0x10000
      + bytes[offset + 3] * 0x100
      + bytes[offset + 4];
    offset += 5;
    if (length < 0 || offset + length > bytes.length) break;
    if ((flags & 0x80) === 0) frames.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return frames;
}

function readQuotaTimestamp(bytes: Uint8Array): string | null {
  let seconds: number | null = null;
  let nanos = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readQuotaVarint(bytes, offset);
    if (!tag) break;
    offset = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 0) {
      const value = readQuotaVarint(bytes, offset);
      if (!value) break;
      offset = value.next;
      if (field === 1) seconds = value.value;
      if (field === 2) nanos = value.value;
    } else if (wire === 2) {
      const length = readQuotaVarint(bytes, offset);
      if (!length) break;
      offset = Math.min(bytes.length, length.next + length.value);
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      break;
    }
  }

  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const timestamp = seconds * 1000 + nanos / 1_000_000;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseGrokCreditsMessage(payload: Uint8Array, depth = 0): { usedPercent: number | null; resetAt: string | null } {
  let usedPercent: number | null = null;
  let resetAt: string | null = null;
  let offset = 0;
  while (offset < payload.length) {
    const tag = readQuotaVarint(payload, offset);
    if (!tag) break;
    offset = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 5) {
      if (offset + 4 > payload.length) break;
      if (field === 1) usedPercent = new DataView(payload.buffer, payload.byteOffset + offset, 4).getFloat32(0, true);
      offset += 4;
    } else if (wire === 2) {
      const length = readQuotaVarint(payload, offset);
      if (!length) break;
      offset = length.next;
      const end = Math.min(payload.length, offset + length.value);
      if (field === 5) resetAt = readQuotaTimestamp(payload.slice(offset, end)) || resetAt;
      if (field === 1 && depth < 3) {
        const nested = parseGrokCreditsMessage(payload.slice(offset, end), depth + 1);
        usedPercent = nested.usedPercent ?? usedPercent;
        resetAt = nested.resetAt || resetAt;
      }
      offset = end;
    } else if (wire === 0) {
      const value = readQuotaVarint(payload, offset);
      if (!value) break;
      offset = value.next;
    } else if (wire === 1) {
      offset += 8;
    } else {
      break;
    }
  }

  return { usedPercent: clampPercent(usedPercent), resetAt };
}

export function parseGrokCreditsConfig(buffer: number[]): { usedPercent: number | null; resetAt: string | null } {
  const frames = readGrpcWebDataFrames(buffer);
  const payload = frames[0];
  if (!payload) return { usedPercent: null, resetAt: null };
  return parseGrokCreditsMessage(payload);
}

function buildGrokAccountLabel(sessionBody: any, stateName: string): string {
  const session = sessionBody?.session;
  if (!session) return stateName;
  const name = [session.givenName, session.familyName].filter(Boolean).join(' ').trim();
  const email = typeof session.email === 'string' ? session.email : '';
  if (name && email) return `${name} (${email})`;
  return name || email || stateName;
}

async function probeGrokQuotaPage(page: Page, stateFile: string, stateName: string): Promise<GrokQuotaInfo> {
  const checkedAt = new Date().toISOString();
  const probe = await page.evaluate(async () => {
    const result: any = {
      configStatus: 0,
      configBytes: [],
      quotaStatus: 0,
      quotaBody: null,
      quotaText: '',
      sessionBody: null,
      errors: []
    };

    try {
      const configResponse = await fetch('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' },
        credentials: 'include',
        body: new Uint8Array([0, 0, 0, 0, 0])
      });
      result.configStatus = configResponse.status;
      result.configBytes = Array.from(new Uint8Array(await configResponse.arrayBuffer()));
    } catch (error: any) {
      result.errors.push(`credits config: ${error?.message || String(error)}`);
    }

    try {
      const quotaResponse = await fetch('https://grok.com/rest/media/imagine/quota_info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}'
      });
      result.quotaStatus = quotaResponse.status;
      result.quotaText = await quotaResponse.text();
      try { result.quotaBody = JSON.parse(result.quotaText); } catch {}
    } catch (error: any) {
      result.errors.push(`quota info: ${error?.message || String(error)}`);
    }

    try {
      const sessionResponse = await fetch('https://grok.com/api/auth/session', { credentials: 'include' });
      result.sessionBody = await sessionResponse.json();
    } catch (error: any) {
      result.errors.push(`auth session: ${error?.message || String(error)}`);
    }

    return result;
  });

  const config = parseGrokCreditsConfig(probe.configBytes || []);
  const quotaBody = probe.quotaBody || {};
  const videoQuota = quotaBody.video && typeof quotaBody.video === 'object' ? quotaBody.video : null;
  const remainingQuota = quotaBody.remainingQuota ?? quotaBody.remaining_quota;
  const quotaSaysUnavailable = videoQuota?.available === false
    || quotaBody.rateLimited === true
    || (remainingQuota !== undefined && Number.isFinite(Number(remainingQuota)) && Number(remainingQuota) <= 0)
    || /rate.?limit|too many requests|weekly limit|batas mingguan/i.test(String(probe.quotaText || ''));
  const configSaysExhausted = config.usedPercent !== null && config.usedPercent >= 100;
  const hasSuccessfulProbe = Number(probe.configStatus) >= 200 && Number(probe.configStatus) < 300
    || Number(probe.quotaStatus) >= 200 && Number(probe.quotaStatus) < 300;
  const status: GrokQuotaStatus = configSaysExhausted || quotaSaysUnavailable
    ? 'exhausted'
    : hasSuccessfulProbe && config.usedPercent !== null
      ? 'available'
      : probe.errors?.length
        ? 'error'
        : 'unknown';

  const error = probe.errors?.length ? probe.errors.join('; ') : undefined;
  return {
    stateFile,
    stateName,
    account: buildGrokAccountLabel(probe.sessionBody, stateName),
    usedPercent: config.usedPercent,
    remainingPercent: config.usedPercent === null ? null : clampPercent(100 - config.usedPercent),
    resetAt: config.resetAt,
    available: status === 'available',
    status,
    checkedAt,
    ...(error ? { error } : {})
  };
}

async function waitForGrokImagineReady(page: Page, context: BrowserContext, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try { await page.waitForLoadState('load', { timeout: 30000 }); } catch {}
  try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}

  while (Date.now() < deadline) {
    const cookies = await context.cookies('https://grok.com');
    const hasClearance = cookies.some(cookie => cookie.name === 'cf_clearance');
    const state = await page.evaluate(async () => {
      const hasApi = typeof (window as any).__GROK_API_V2_GENERATE === 'function';
      let authenticated = false;
      let stale = false;
      try {
        const res = await fetch('https://grok.com/api/auth/session', { credentials: 'include' });
        const text = await res.text();
        authenticated = res.ok && /"session"\s*:/.test(text) && !/"session"\s*:\s*null/.test(text);
        stale = res.status === 403 && /out of date|reload to continue/i.test(text);
      } catch {}
      return { hasApi, authenticated, stale, readyState: document.readyState };
    });

    if (state.stale) {
      // Do not reload this document repeatedly. Code 7 invalidates the page
      // session; the orchestrator must recreate the whole browser context.
      throw new GrokStalePageError('Halaman Grok out of date; sesi browser harus dibuat ulang.');
    } else if (state.hasApi && state.authenticated && (hasClearance || Date.now() + 15000 > deadline)) {
      await page.waitForTimeout(8000);
      return;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error('Grok Imagine belum siap setelah menunggu halaman selesai loading.');
}

export async function checkGrokQuota(stateNameOrFile = 'indra'): Promise<GrokQuotaInfo> {
  const stateName = normalizeGrokStateName(stateNameOrFile);
  const stateFile = `grok-state-${stateName}.json`;
  const statePath = path.join(process.cwd(), 'grok-states', stateFile);
  if (!fs.existsSync(statePath)) throw new Error(`File state ${stateFile} tidak ditemukan`);

  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'], ignoreDefaultArgs: ['--enable-automation'] });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Jakarta',
    storageState: statePath,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  const page = await context.newPage();
  try {
    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });
    return await probeGrokQuotaPage(page, stateFile, stateName);
  } catch (error: any) {
    return {
      stateFile,
      stateName,
      account: stateName,
      usedPercent: null,
      remainingPercent: null,
      resetAt: null,
      available: false,
      status: 'error',
      checkedAt: new Date().toISOString(),
      error: error?.message || String(error)
    };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

export interface GrokV2SessionOptions {
  initExtraScript?: string;
  afterPageCreated?: (page: Page, context: BrowserContext) => Promise<void> | void;
}

export async function createGrokV2Session(stateName = 'indra', headless = true, options: GrokV2SessionOptions = {}): Promise<GrokV2Session> {
  const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
  if (!fs.existsSync(statePath)) throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);

  const browser = await chromium.launch({ headless, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'], ignoreDefaultArgs: ['--enable-automation'] });
  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Asia/Makassar',
      storageState: statePath,
      acceptDownloads: true,
      // Prevent an old cached Imagine shell from being reused after Grok
      // deploys a new page version. Code 7 is commonly emitted by that shell.
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
    const page = await context.newPage();
    const session: GrokV2Session = { browser, context, page, stateName, statsigId: '', requestMetadata: {} };
    const metadataHeaders = ['baggage', 'sentry-trace', 'traceparent'];
    page.on('request', request => {
      if (!request.url().startsWith('https://grok.com/')) return;
      const headers = request.headers();
      if (!session.statsigId && headers['x-statsig-id']) session.statsigId = headers['x-statsig-id'];
      for (const name of metadataHeaders) {
        if (!session.requestMetadata[name] && headers[name]) session.requestMetadata[name] = headers[name];
      }
    });

    // Opsi debug (grokv2-debug.js):
    //   options.initExtraScript  = string init-script tambahan (fetch logger, dll)
    //   options.afterPageCreated = dipanggil sebelum navigasi (pasang listener debug)
    if (options && typeof options.afterPageCreated === 'function') {
      await options.afterPageCreated(page, context);
    }

    const browserScriptPath = path.join(process.cwd(), 'grok_api_browser.js');
    if (!fs.existsSync(browserScriptPath)) throw new Error(`File browser script tidak ditemukan: ${browserScriptPath}`);
    const browserScript = fs.readFileSync(browserScriptPath, 'utf-8');
    const extraInit = (options && typeof options.initExtraScript === 'string') ? options.initExtraScript : '';
    const webdriverSpoofInit = /Object\.defineProperty\(navigator,\s*['"]webdriver['"]|Navigator\.prototype,\s*['"]webdriver['"]/.test(extraInit) ? '' : `
      (function () {
        try {
          if (window.__GROK_WEBDRIVER_SPOOFED) return;
          window.__GROK_WEBDRIVER_SPOOFED = true;
          const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
          if (descriptor && descriptor.configurable === false) return;
          Object.defineProperty(Navigator.prototype, 'webdriver', {
            configurable: true,
            get: function () { return undefined; }
          });
        } catch (_) {}
      })();
    `;
    // buildDebugInitScript() sudah berisi browser API + wrapper. Jangan
    // menyuntikkan browser API dasar untuk kedua kalinya karena itu dapat
    // menimpa wrapper/debug hook yang dipakai runner Grok V2 Test.
    const hasCompleteDebugInit = extraInit.includes('window.__GROK_API_V2_GENERATE')
      && extraInit.includes('window.__GROK_FETCH_LOG');
    const initContent = hasCompleteDebugInit
      ? extraInit
      : browserScript + webdriverSpoofInit + (extraInit ? '\n' + extraInit : '');
    await page.addInitScript({ content: initContent });
    // Keep the canonical Imagine URL. Grok validates the page/referrer
    // context for conversations/new and can return code 7 for a query-string
    // variant such as /imagine?fresh=... . Cache bypass is handled by the
    // context headers above.
    await page.goto('https://grok.com/imagine', { waitUntil: 'load', timeout: 60000 });
    await waitForGrokImagineReady(page, context);
    // Persist refreshed Cloudflare/session cookies (for example cf_clearance
    // and __cf_bm) back to the selected state. Otherwise a newly obtained
    // clearance disappears when this browser context is closed.
    try { await context.storageState({ path: statePath }); } catch {}
    return session;
  } catch (error) {
    try { await browser.close(); } catch {}
    throw error;
  }
}

export class TooManyRequestsError extends Error {
  retryAfterMs: number;
  fetchTrace?: any[];
  constructor(retryAfterMs = 0) {
    super('Grok mengirim HTTP 429 Too Many Requests');
    this.name = 'TooManyRequestsError';
    this.retryAfterMs = retryAfterMs;
  }
}

async function grabFetchTrace(page: Page | undefined, limit = 60): Promise<any[]> {
  if (!page) return [];
  try {
    return await page.evaluate((n: number) => Array.isArray((window as any).__GROK_FETCH_LOG) ? (window as any).__GROK_FETCH_LOG.slice(-n) : [], limit);
  } catch (_) {
    return [];
  }
}

function fetchTraceLegend(trace: any[], max = 25): string[] {
  const rows: string[] = [];
  for (const e of trace || []) {
    const important = (e.status >= 400 && e.status !== 404) || e.status === 0
      || String(e.url).includes('conversations') || String(e.url).includes('quota_info')
      || String(e.url).includes('upload-file-v2');
    if (important) {
      rows.push(`${e.method || '?'} ${e.status || 'ERR'} ${e.ms}ms ${String(e.url).slice(0, 100)}${e.note ? ' | ' + e.note.slice(0, 160) : ''}`);
    }
    if (rows.length >= max) break;
  }
  return rows;
}

export async function closeGrokV2Session(session: GrokV2Session | null | undefined): Promise<void> {
  if (!session) return;
  try { await session.browser.close(); } catch {}
}

export async function generateGrokVideoV2(options: GrokVideoV2Options, onProgress?: (msg: string, progress: number) => void, sharedSession?: GrokV2Session) {
  const stateName = options.stateName || 'indra';
  const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
  if (!fs.existsSync(statePath)) throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);
  const log = (msg: string, pct = 0) => { console.log(`[GROK_V2_NEW] ${msg}`); if (onProgress) onProgress(msg, pct); };

  let imageData: string | null = null;
  let imageMime = 'image/png';
  let imageName = 'image.png';
  if (options.imagePath) {
    const imgPath = path.isAbsolute(options.imagePath) ? options.imagePath : path.join(process.cwd(), options.imagePath);
    if (!fs.existsSync(imgPath)) throw new Error(`File gambar tidak ditemukan: ${imgPath}`);
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
    if (ownsSession) log('Grok Imagine siap dipakai untuk batch ini.', 12);
    if (session.statsigId || Object.keys(session.requestMetadata).length > 0) log('Metadata request Grok terdeteksi', 13);
    const runGeneration = () => page.evaluate((o: any) => {
      const generate = (window as any).__GROK_API_V2_GENERATE;
      if (typeof generate !== 'function') throw new Error('Grok browser API script tidak terpasang');
      return generate(o);
    }, { prompt, imageData, imageMime, imageName, duration: durationNum, resolution, aspectRatio, statsigId: session.statsigId, requestMetadata: session.requestMetadata });
    // Polling progress
    let rateLimitDetectedAt: { availableAt: string | null; transient: boolean; retryAfterMs: number } | null = null;
    const poll = setInterval(async () => {
      try {
        const st: any = await page.evaluate(() => (window as any).__GROK_NEW_STATE);
        if (st) {
          if (typeof st.progress === 'number') log(`Proses generate: ${st.progress}% - ${st.message || ''}`, Math.round(st.progress));
          if (st.rateLimited) {
            rateLimitDetectedAt = {
              availableAt: st.availableAt || null,
              transient: !!st.transientRateLimit || st.httpStatus === 429,
              retryAfterMs: Number(st.retryAfterMs) || 0
            };
            log(st.transientRateLimit ? 'Too many requests terdeteksi' : 'Rate limit terdeteksi');
          }
        }
      } catch {}
    }, 2500);

    let result: any;
    try {
      // A code-7 response is a stale browser context. Re-running on the same
      // page only repeats the 403, so let the caller recreate the session.
      result = await runGeneration();
      if (result?.stalePage) log('Grok mengembalikan code:7; sesi browser akan dibuat ulang oleh Infinite Generate.', 14);
    } finally { clearInterval(poll); }

    const detectedRateLimit = rateLimitDetectedAt as { availableAt: string | null; transient: boolean; retryAfterMs: number } | null;
    if (result?.rateLimited || detectedRateLimit) {
      const availableAt = result?.availableAt || detectedRateLimit?.availableAt || null;
      if (result?.failureKind === 'account_rate_limit') {
        log('Grok code:7 pada conversations/new diklasifikasikan sebagai rate limit akun; retry dihentikan.', 14);
      }
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
        if (ownsSession) await closeGrokV2Session(session);
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
      if (ownsSession) await closeGrokV2Session(session);
      throw new RateLimitError(availableAt);
    }
    if (!result || result.status !== 'done' || !result.videoUrl) {
      if (result?.stalePage) {
        const staleError = new GrokStalePageError(
          `${result.error || 'Grok mengirim 403 code:7: This page is out of date.'}`
            + (result.failureEndpoint ? ` [endpoint: ${result.failureEndpoint}]` : ''),
          Number(result.httpStatus) || 403
        );
        // A stale response invalidates the whole browser context, not only the
        // current document. The caller will create a completely fresh session.
        await closeGrokV2Session(session);
        throw staleError;
      }
      throw new Error(result?.error || 'Generasi video gagal di Grok (API baru).');
    }

    log(`Video berhasil di-generate! Mengunduh file hasil...`, 92);
    const downloadDir = path.join(process.cwd(), 'grok-downloads', stateName);
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
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
      } catch (e: any) {
        log(`Peringatan mengunduh dari ${downloadUrl.substring(0, 70)}: ${e.message}`);
      }
    }

    if (ownsSession) await closeGrokV2Session(session);
    if (!saved) throw new Error(`Gagal menyimpan file video ke ${savePath}`);

    log(`Video berhasil disimpan di ${savePath}`, 100);
    return { success: true, filename: fname, savePath, downloadUrl: `/api/grok/video-file/${stateName}/${fname}`, rawUrl: result.videoUrl || '' };
  } catch (error: any) {
    if (ownsSession) await closeGrokV2Session(session);
    log('Error: ' + error.message);
    throw error;
  }
}

if (process.argv[1]?.includes('grok_api_client')) {
  checkGrokQuota('indra').then(res => console.log('Quota:', JSON.stringify(res, null, 2))).catch(console.error);
}
