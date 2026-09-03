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

export async function checkGrokQuota(stateName = 'indra') {
  const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
  if (!fs.existsSync(statePath)) throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);
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

export async function createGrokV2Session(stateName = 'indra', headless = true): Promise<GrokV2Session> {
  const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
  if (!fs.existsSync(statePath)) throw new Error(`File state grok-state-${stateName}.json tidak ditemukan`);

  const browser = await chromium.launch({ headless, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'], ignoreDefaultArgs: ['--enable-automation'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', locale: 'en-US', timezoneId: 'Asia/Makassar', storageState: statePath, acceptDownloads: true });
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

    const browserScriptPath = path.join(process.cwd(), 'grok_api_browser.js');
    if (!fs.existsSync(browserScriptPath)) throw new Error(`File browser script tidak ditemukan: ${browserScriptPath}`);
    const browserScript = fs.readFileSync(browserScriptPath, 'utf-8');
    await page.addInitScript({ content: browserScript + `
      Object.defineProperty(navigator, 'webdriver', {
        get: function () { return undefined; }
      });
    ` });
    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The anti-bot clearance cookie is often issued shortly after the first page load.
    for (let attempt = 0; attempt < 10; attempt++) {
      const cookies = await context.cookies('https://grok.com');
      if (cookies.some(cookie => cookie.name === 'cf_clearance')) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);
    return session;
  } catch (error) {
    try { await browser.close(); } catch {}
    throw error;
  }
}

export class TooManyRequestsError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs = 0) {
    super('Grok mengirim HTTP 429 Too Many Requests');
    this.name = 'TooManyRequestsError';
    this.retryAfterMs = retryAfterMs;
  }
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
      result = await runGeneration();
      if (result?.stalePage) {
        log('Grok meminta halaman dimuat ulang, mencoba ulang sekali...', 14);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        for (let attempt = 0; attempt < 10; attempt++) {
          const cookies = await context.cookies('https://grok.com');
          if (cookies.some(cookie => cookie.name === 'cf_clearance')) break;
          await page.waitForTimeout(1000);
        }
        await page.waitForTimeout(2000);
        result = await runGeneration();
      }
    } finally { clearInterval(poll); }

    const detectedRateLimit = rateLimitDetectedAt as { availableAt: string | null; transient: boolean; retryAfterMs: number } | null;
    if (result?.rateLimited || detectedRateLimit) {
      const availableAt = result?.availableAt || detectedRateLimit?.availableAt || null;
      const isTooManyRequests = !!result?.transientRateLimit
        || result?.httpStatus === 429
        || !!detectedRateLimit?.transient;
      if (isTooManyRequests) {
        const retryAfterMs = Number(result?.retryAfterMs) || detectedRateLimit?.retryAfterMs || 0;
        log('Too many requests. Menunggu sebelum mencoba raw yang sama lagi.');
        if (ownsSession) await closeGrokV2Session(session);
        throw new TooManyRequestsError(retryAfterMs);
      }
      log('Rate limit! Tersedia kembali: ' + (availableAt || 'tidak diketahui'));
      if (ownsSession) await closeGrokV2Session(session);
      throw new RateLimitError(availableAt);
    }
    if (!result || result.status !== 'done' || !result.videoUrl) {
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
