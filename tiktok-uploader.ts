// tiktok-uploader.ts
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { spawn } from 'child_process';
import net from 'net';
import ffmpegPath from 'ffmpeg-static';
import { setTikTokSchedule, verifyTikTokSchedule } from './tiktok-schedule.js';

export interface UploadConfig {
  videoFolder: string;
  startFromVideo: string;
  description: string;
  hashtags: string;       // comma separated: fyp,viral,trending
  addProduct: boolean;
  productNameRadio: string;
  productTitle: string;
  productDescription: string;
  skipSwitches: boolean;
  headless: boolean;
  scheduleDate: string;   // YYYY-MM-DD
  scheduleTime: string;   // HH:mm
  intervalMinutes?: number; // interval in minutes between video schedules
  stateFile: string;      // filename in tiktok-states/
  statesDir: string;
  threeUploadsPerHour?: boolean;
  brutalContent?: boolean;
  maxVideos?: number;
  enableCustomScheduler?: boolean;
  customIntervalHours?: number;
  customUploadCount?: number;
  randomizeIntervalSchedule?: boolean;
}

type LogFn = (msg: string) => void;

export interface SchedulePlanItem {
  index: number;
  filename: string;
  scheduleDate: string;
  scheduleTime: string;
  offsetMinutes?: number;
}

let activeBrowser: Browser | null = null;
let activeContext: BrowserContext | null = null;
let isRunning = false;
let uploadLock: Promise<void> = Promise.resolve();

export function getIsRunning() { return isRunning; }

const RANDOM_INTERVAL_OFFSET_MAX_MINUTES = 40;
const RANDOM_INTERVAL_OFFSET_STEP_MINUTES = 5;

function getRandomIntervalOffsetMinutes(): number {
  const steps = Math.floor(RANDOM_INTERVAL_OFFSET_MAX_MINUTES / RANDOM_INTERVAL_OFFSET_STEP_MINUTES);
  return (Math.floor(Math.random() * (steps * 2 + 1)) - steps) * RANDOM_INTERVAL_OFFSET_STEP_MINUTES;
}

const BRUTAL_ACTIVE_HOURS = 18;

function randomIntegerInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickNaturalMinutes(count: number): number[] {
  const validMinutes = Array.from({ length: 12 }, (_, index) => index * 5);

  // TikTok hanya menyediakan menit kelipatan 5. Pilih ulang seluruh kombinasi
  // jika pilihan acak buntu agar 2â€“3 video dalam satu jam tetap berjeda.
  for (let attempt = 0; attempt < 100; attempt++) {
    const selected: number[] = [];
    while (selected.length < count) {
      const candidates = validMinutes.filter(minute =>
        !selected.includes(minute)
        && selected.every(existing => Math.abs(existing - minute) >= 10)
      );
      if (candidates.length === 0) break;
      selected.push(candidates[randomIntegerInclusive(0, candidates.length - 1)]);
    }
    if (selected.length === count) return selected.sort((a, b) => a - b);
  }

  // Fallback aman; seluruh menit tetap valid di time picker TikTok.
  return count === 3 ? [5, 25, 45] : count === 2 ? [15, 45] : [validMinutes[randomIntegerInclusive(0, validMinutes.length - 1)]];
}

/**
 * Membuat jadwal brutal yang tetap terlihat natural: 18 jam aktif (06–23),
 * 1–3 posting unik per jam, tanpa timestamp yang sama dan tidak lebih awal
 * dari baseline. Jumlah normal mode ini adalah 40–53 video.
 */
export function buildBrutalContentSchedule(baseSchedule: Date, requestedCount: number): Date[] {
  const count = Math.max(0, Math.min(BRUTAL_ACTIVE_HOURS * 3, Math.floor(requestedCount)));
  if (count === 0) return [];

  const firstHour = new Date(baseSchedule.getTime());
  firstHour.setSeconds(0, 0);
  if (firstHour.getMinutes() > 0) firstHour.setHours(firstHour.getHours() + 1, 0, 0, 0);
  else firstHour.setMinutes(0, 0, 0);

  const hourlySlots: Date[] = [];
  const cursor = new Date(firstHour.getTime());
  while (hourlySlots.length < BRUTAL_ACTIVE_HOURS) {
    const hour = cursor.getHours();
    if (hour >= 6 && hour <= 23) hourlySlots.push(new Date(cursor.getTime()));
    cursor.setHours(cursor.getHours() + 1);
  }

  const perHour = new Array(BRUTAL_ACTIVE_HOURS).fill(0);
  if (count >= BRUTAL_ACTIVE_HOURS) {
    perHour.fill(1);
  } else {
    // Kasus stok kurang dari target brutal: sebarkan pada jam aktif terdekat.
    for (let i = 0; i < count; i++) perHour[i] = 1;
  }

  let remaining = count - perHour.reduce((sum, value) => sum + value, 0);
  while (remaining > 0) {
    const candidates = perHour
      .map((value, index) => ({ value, index, hour: hourlySlots[index].getHours() }))
      .filter(item => item.value < 3);
    if (candidates.length === 0) break;

    // Sedikit lebih sering pada jam aktivitas manusia: pagi, siang, dan malam.
    const weighted = candidates.flatMap(item => {
      const peak = (item.hour >= 8 && item.hour <= 12) || (item.hour >= 18 && item.hour <= 22);
      return new Array(peak ? 3 : 2).fill(item.index);
    });
    const chosenIndex = weighted[randomIntegerInclusive(0, weighted.length - 1)];
    perHour[chosenIndex]++;
    remaining--;
  }

  const result: Date[] = [];
  for (let hourIndex = 0; hourIndex < hourlySlots.length; hourIndex++) {
    for (const minute of pickNaturalMinutes(perHour[hourIndex])) {
      const scheduled = new Date(hourlySlots[hourIndex].getTime());
      scheduled.setMinutes(minute, 0, 0);
      result.push(scheduled);
    }
  }
  return result.sort((a, b) => a.getTime() - b.getTime());
}

async function detectConnectedBrowserHeadless(browser: Browser): Promise<boolean | null> {
  const context = browser.contexts()[0];
  if (!context) return null;

  let page = context.pages()[0];
  let createdProbePage = false;
  if (!page) {
    page = await context.newPage();
    createdProbePage = true;
  }

  try {
    const userAgent = await page.evaluate(() => navigator.userAgent);
    return /\bHeadlessChrome\//i.test(userAgent);
  } catch {
    return null;
  } finally {
    if (createdProbePage) await page.close().catch(() => {});
  }
}

function isTcpPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForTcpPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isTcpPortOpen(port))) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return !(await isTcpPortOpen(port));
}

async function findWindowsListeningPid(port: number): Promise<number | null> {
  const { stdout } = await execa('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true });
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue;
    if (!columns[1].endsWith(`:${port}`) || columns[3].toUpperCase() !== 'LISTENING') continue;
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

async function terminateChromeListeningOnPort(port: number, log: LogFn): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(`Chrome lama masih memakai port ${port} dan tidak dapat dihentikan otomatis pada platform ini`);
  }

  const pid = await findWindowsListeningPid(port);
  if (!pid) {
    throw new Error(`Port ${port} masih aktif, tetapi PID pemiliknya tidak ditemukan`);
  }

  const { stdout } = await execa('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
  const imageName = stdout.match(/^"([^"]+)"/)?.[1] || '';
  if (imageName.toLowerCase() !== 'chrome.exe') {
    throw new Error(`Port ${port} dipakai ${imageName || 'proses yang tidak dikenal'} (PID ${pid}), bukan Chrome; proses tidak dihentikan`);
  }

  log(`⚠ Chrome lama belum berhenti. Menghentikan proses Chrome PID ${pid}...`);
  await execa('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
}

async function closeMismatchedChrome(browser: Browser, port: number, log: LogFn): Promise<void> {
  const context = browser.contexts()[0];
  const page = context?.pages()[0];

  if (context && page) {
    let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null;
    try {
      session = await context.newCDPSession(page);
      await session.send('Browser.close');
    } catch {
      // Browser.close biasanya memutus sesi ketika berhasil, sehingga error
      // Target closed di sini tidak berarti proses penutupan gagal.
    } finally {
      if (session) await session.detach().catch(() => {});
    }
  }

  await browser.close().catch(() => {});
  if (await waitForTcpPortClosed(port, 5000)) {
    log(`✓ Chrome lama sudah berhenti dan port ${port} sudah kosong`);
    return;
  }

  await terminateChromeListeningOnPort(port, log);
  if (!(await waitForTcpPortClosed(port, 10000))) {
    throw new Error(`Chrome lama tidak berhenti; port ${port} masih aktif setelah dihentikan`);
  }
  log(`✓ Chrome lama dihentikan dan port ${port} sudah kosong`);
}

export async function stopUploader() {
  isRunning = false;
  if (activeContext) { try { await activeContext.close(); } catch {} activeContext = null; }
  if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; }
}

async function safeClick(page: Page, locator: any, log: LogFn, label: string, timeout = 5000) {
  try {
    await locator.click({ timeout });
    log(`✓ ${label}`);
    return true;
  } catch {
    log(`⚠ ${label} - tidak ditemukan/gagal`);
    return false;
  }
}

async function waitAndLog(page: Page, log: LogFn, ms: number, reason: string) {
  log(`⏳ Menunggu ${ms / 1000}s (${reason})...`);
  await page.waitForTimeout(ms);
}

async function bringChromeWindowToFront(page: Page, log: LogFn): Promise<void> {
  let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null;
  try {
    await page.bringToFront();
    session = await page.context().newCDPSession(page);
    const windowInfo = await session.send('Browser.getWindowForTarget');
    if (windowInfo?.windowId !== undefined) {
      // Browser lama dapat masih hidup dalam kondisi minimized. Pulihkan dan
      // maksimalkan supaya konfigurasi non-headless benar-benar terlihat.
      await session.send('Browser.setWindowBounds', {
        windowId: windowInfo.windowId,
        bounds: { windowState: 'normal' }
      }).catch(() => {});
      await session.send('Browser.setWindowBounds', {
        windowId: windowInfo.windowId,
        bounds: { windowState: 'maximized' }
      }).catch(() => {});
    }
    await page.bringToFront();
    log('✓ Jendela Chrome non-headless dipulihkan dan ditampilkan di depan');
  } catch (error: any) {
    log(`⚠ Chrome berjalan non-headless, tetapi jendelanya gagal dibawa ke depan: ${error.message}`);
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

async function dismissProductDialog(page: Page, log: LogFn): Promise<void> {
  const visibleDialog = page.locator('[role="dialog"]:visible, .TUXModal:visible, [class*="modal"]:visible').last();
  if (await visibleDialog.count() === 0) return;

  const closeButton = visibleDialog.locator([
    'button[aria-label*="Close" i]',
    'button[aria-label*="Tutup" i]',
    'button:has-text("Cancel")',
    'button:has-text("Batal")'
  ].join(', ')).first();

  if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeButton.click({ force: true, timeout: 3000 }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(500);

  if (await visibleDialog.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
  log('ℹ Dialog produk ditutup agar halaman penjadwalan tidak terkunci');
}

async function isVideoValid(videoPath: string, log: LogFn): Promise<boolean> {
  try {
    if (!fs.existsSync(videoPath)) {
      return false;
    }
    const stat = fs.statSync(videoPath);
    if (stat.size === 0) {
      log(`❌ File video berukuran 0 bytes: ${path.basename(videoPath)}`);
      return false;
    }

    if (!ffmpegPath) {
      log(`⚠ ffmpeg-static tidak tersedia, melewati verifikasi FFmpeg untuk ${path.basename(videoPath)}`);
      return true;
    }

    // Run a thorough FFmpeg check to decode the entire video file and catch any errors/corruption
    const { stderr } = await execa(ffmpegPath, [
      '-v', 'error',
      '-i', videoPath,
      '-f', 'null',
      '-'
    ], { windowsHide: true });

    if (stderr && stderr.trim().length > 0) {
      log(`❌ Verifikasi FFmpeg mendeteksi error untuk ${path.basename(videoPath)}: ${stderr.trim()}`);
      return false;
    }

    return true;
  } catch (err: any) {
    log(`❌ Verifikasi FFmpeg gagal untuk ${path.basename(videoPath)}: ${err.message}`);
    return false;
  }
}

async function detectUploadError(page: Page, log: LogFn): Promise<string | null> {
  const errorKeywords = [
    'tidak didukung',
    'gagal',
    'corrupt',
    'rusak',
    'invalid',
    'unsupported',
    'error',
    'failed'
  ];

  const errorSelectors = [
    'div[class*="toast"]',
    'div[class*="modal"]',
    'div[class*="dialog"]',
    'div[class*="notification"]',
    'div[class*="error"]',
    'div[class*="Error"]',
    'div[class*="Warning"]',
    'div[class*="warning"]',
    'span[class*="error"]',
    'p[class*="error"]',
    'div[role="alert"]',
    '[data-e2e="upload-error"]'
  ];

  for (const selector of errorSelectors) {
    try {
      const elements = page.locator(selector);
      const count = await elements.count();
      for (let i = 0; i < count; i++) {
        const el = elements.nth(i);
        if (await el.isVisible().catch(() => false)) {
          const text = (await el.textContent().catch(() => ''))?.toLowerCase().trim();
          if (text) {
            for (const keyword of errorKeywords) {
              if (text.includes(keyword)) {
                return text;
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Check page body text as fallback
  try {
    const pageText = (await page.locator('body').textContent().catch(() => ''))?.toLowerCase() || '';
    const criticalErrors = [
      'file format not supported',
      'format file tidak didukung',
      'file is corrupted',
      'file rusak',
      'failed to upload',
      'gagal mengunggah',
      'corrupted video',
      'video rusak'
    ];
    for (const errStr of criticalErrors) {
      if (pageText.includes(errStr)) {
        return errStr;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

async function dismissUnsavedDraftDialog(page: Page, log: LogFn): Promise<boolean> {
  const draftPrompts = page.getByText(
    /A video you were editing wasn['’]t saved|Continue editing\?|video.*(?:tidak|belum).*tersimpan|Lanjutkan mengedit/i
  );
  let draftPrompt = draftPrompts.first();
  let visible = false;
  const promptCount = Math.min(await draftPrompts.count().catch(() => 0), 20);
  for (let index = 0; index < promptCount; index++) {
    const candidate = draftPrompts.nth(index);
    if (await candidate.isVisible({ timeout: index === 0 ? 2500 : 250 }).catch(() => false)) {
      draftPrompt = candidate;
      visible = true;
      break;
    }
  }
  if (!visible) return false;

  log('⚠ Dialog draft TikTok terdeteksi. Membuang draft lama sebelum upload berikutnya...');
  const discardButtons = page.getByRole('button', {
    name: /^(Discard|Buang|Hapus|Abaikan|Buang draf|Hapus draf)$/i
  });
  let discardButton = discardButtons.first();
  let discardVisible = false;
  const discardCount = Math.min(await discardButtons.count().catch(() => 0), 10);
  for (let index = 0; index < discardCount; index++) {
    const candidate = discardButtons.nth(index);
    if (await candidate.isVisible({ timeout: index === 0 ? 3000 : 250 }).catch(() => false)) {
      discardButton = candidate;
      discardVisible = true;
      break;
    }
  }
  if (!discardVisible) {
    throw new Error('Dialog draft TikTok menghalangi upload dan tombol Discard tidak ditemukan');
  }

  await discardButton.click({ timeout: 5000 });
  await draftPrompt.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  log('✓ Draft lama dibuang; halaman siap untuk video baru.');
  return true;
}

type TikTokSubmitResult = { success: true; evidence: string } | { success: false; error: string };

async function waitForTikTokSubmitResult(page: Page, log: LogFn, verifyBeforeSubmit: () => Promise<boolean>, timeoutMs = 60000): Promise<TikTokSubmitResult> {
  const startedAt = Date.now();
  const uploadPathPattern = /\/tiktokstudio\/upload\/?(?:[?#].*)?$/i;
  const confirmedDestinationPattern = /\/tiktokstudio\/(?:content|posts?|manage|home|analytics)(?:[/?#]|$)/i;
  const successPattern = /successfully\s+(?:scheduled|posted|uploaded)|(?:has been|was)\s+(?:scheduled|posted|uploaded)|(?:scheduled|posted|uploaded)\s+successfully|berhasil\s+(?:dijadwalkan|diposting|diunggah)|upload\s+(?:is\s+)?complete|your video is being uploaded/i;
  const errorPattern = /failed|gagal|error|try again|coba lagi|invalid|tidak valid|must be|harus|at least|setidaknya|future|masa depan|past time|waktu.*lewat|couldn['’]t|unable|tidak dapat/i;
  const draftPattern = /A video you were editing wasn['’]t saved|Continue editing\?|video.*(?:tidak|belum).*tersimpan|Lanjutkan mengedit/i;
  const pendingCheckDialogPattern = /Continue to post\?|still checking your video|Lanjutkan.*(?:posting|memposting)|masih memeriksa video/i;
  const pendingCheckConfirmPattern = /^(Post now|Continue|Continue posting|Posting sekarang(?: juga)?|Tetap posting|Lanjutkan)$/i;
  let pendingCheckConfirmAttempts = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (page.isClosed()) return { success: false, error: 'Halaman TikTok tertutup sebelum ada konfirmasi' };

    // TikTok kadang menampilkan konfirmasi kedua ketika pemeriksaan konten
    // masih berlangsung. Klik tombol utama saja belum mengirim jadwal sampai
    // tombol "Post now" di dialog ini dikonfirmasi.
    const pendingCheckDialog = page.locator('[role="dialog"]')
      .filter({ hasText: pendingCheckDialogPattern })
      .last();
    if (await pendingCheckDialog.isVisible({ timeout: 250 }).catch(() => false)) {
      if (pendingCheckConfirmAttempts >= 3) {
        return { success: false, error: 'Dialog pemeriksaan TikTok tetap terbuka setelah 3 kali konfirmasi' };
      }

      const confirmButton = pendingCheckDialog.getByRole('button', { name: pendingCheckConfirmPattern }).last();
      if (!(await confirmButton.isVisible({ timeout: 1000 }).catch(() => false))) {
        const dialogText = (await pendingCheckDialog.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim().slice(0, 300);
        return { success: false, error: `Dialog pemeriksaan TikTok ditemukan, tetapi tombol konfirmasi tidak tersedia${dialogText ? `: ${dialogText}` : ''}` };
      }

      pendingCheckConfirmAttempts++;
      if (!await verifyBeforeSubmit()) return { success: false, error: 'Schedule verification failed before confirmation' };
      await confirmButton.click({ timeout: 5000 });
      log('✓ Dialog “Continue to post?” dikonfirmasi melalui tombol “Post now”');
      await page.waitForTimeout(750).catch(() => {});
      continue;
    }

    const snapshot = await page.evaluate(() => {
      const noticeSelectors = [
        '[role="alert"]', '[role="status"]', '[role="dialog"]',
        '[class*="toast" i]', '[class*="notification" i]', '[class*="message" i]'
      ].join(',');
      const notices = Array.from(document.querySelectorAll(noticeSelectors))
        .filter(element => {
          const style = window.getComputedStyle(element as HTMLElement);
          const rect = (element as HTMLElement).getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        })
        .map(element => (element.textContent || '').trim())
        .filter(Boolean)
        .join('\n');
      const visibleButtons = Array.from(document.querySelectorAll('button')).filter(element => {
        const style = window.getComputedStyle(element as HTMLElement);
        const rect = (element as HTMLElement).getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      });
      const postButtonVisible = visibleButtons.some(button => {
        const text = (button.textContent || '').trim();
        return /^(Posting|Jadwalkan|Schedule|Post|Tayangkan)$/i.test(text)
          || button.getAttribute('data-e2e') === 'post_video_button';
      });
      const selectVideoVisible = visibleButtons.some(button => /Select video|Select file|Pilih video/i.test(button.textContent || ''));
      const editorVisible = Array.from(document.querySelectorAll('.public-DraftEditor-content, div[role="textbox"][contenteditable="true"]')).some(element => {
        const style = window.getComputedStyle(element as HTMLElement);
        const rect = (element as HTMLElement).getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      });
      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
      const fileCount = fileInputs.reduce((total, input) => total + (input.files?.length || 0), 0);
      const shortVisibleTexts = Array.from(document.querySelectorAll('[role="dialog"], [role="alert"], button'))
        .filter(element => {
          const style = window.getComputedStyle(element as HTMLElement);
          const rect = (element as HTMLElement).getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        })
        .map(element => (element.textContent || '').trim())
        .filter(text => text.length > 0 && text.length < 500)
        .join('\n');
      return {
        url: location.href,
        notices,
        shortVisibleTexts,
        postButtonVisible,
        selectVideoVisible,
        editorVisible,
        fileCount
      };
    }).catch((error: any) => ({ evaluationError: error?.message || String(error) }));

    if ('evaluationError' in snapshot) {
      return { success: false, error: `Gagal membaca hasil TikTok: ${snapshot.evaluationError}` };
    }

    const feedbackText = `${snapshot.notices}\n${snapshot.shortVisibleTexts}`;
    if (draftPattern.test(feedbackText)) {
      return { success: false, error: 'TikTok menampilkan dialog draft belum tersimpan' };
    }
    if (errorPattern.test(snapshot.notices)) {
      const conciseError = snapshot.notices.replace(/\s+/g, ' ').slice(0, 300);
      return { success: false, error: `TikTok menampilkan error: ${conciseError}` };
    }
    if (successPattern.test(snapshot.notices)) {
      const evidence = snapshot.notices.replace(/\s+/g, ' ').slice(0, 300);
      return { success: true, evidence: evidence || 'notifikasi sukses TikTok' };
    }
    if (confirmedDestinationPattern.test(snapshot.url)) {
      return { success: true, evidence: `TikTok berpindah ke ${snapshot.url}` };
    }
    if (!uploadPathPattern.test(snapshot.url)) {
      return { success: false, error: `TikTok berpindah ke halaman tak terduga: ${snapshot.url}` };
    }

    // Setelah submit berhasil TikTok dapat tetap berada di /upload tetapi
    // mengosongkan editor dan kembali ke form pemilihan video.
    if (
      Date.now() - startedAt >= 3000
      && snapshot.selectVideoVisible
      && snapshot.fileCount === 0
      && !snapshot.editorVisible
      && !snapshot.postButtonVisible
    ) {
      return { success: true, evidence: 'form upload TikTok kembali kosong setelah submit' };
    }

    await page.waitForTimeout(500).catch(() => {});
  }

  return { success: false, error: `Tidak ada konfirmasi sukses dari TikTok dalam ${Math.round(timeoutMs / 1000)} detik` };
}

// ═══════════════════════════════════════════════════════════
//  UPLOAD SINGLE VIDEO
//  Returns true if the video was successfully posted/scheduled
// ═══════════════════════════════════════════════════════════
async function uploadSingleVideo(
  page: Page,
  videoPath: string,
  config: UploadConfig,
  scheduleDate: string,
  scheduleTime: string,
  log: LogFn,
  videoIndex?: number
): Promise<boolean> {
  // ── STEP 1: Navigate to upload page ──
  log('📄 Navigasi ke TikTok Studio Upload...');
  await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('✓ DOM loaded, menunggu halaman upload siap...');

  await dismissUnsavedDraftDialog(page, log);

  // Wait for the actual upload UI to appear
  try {
    await page.locator('input[type="file"], button[data-e2e="select_video_button"], button[aria-label="Select video"]')
      .first()
      .waitFor({ state: 'attached', timeout: 30000 });
    log('✓ Halaman upload siap!');
  } catch {
    log('⚠ Elemen upload belum muncul, menunggu tambahan 10s...');
    await page.waitForTimeout(10000);
  }
  await waitAndLog(page, log, 2000, 'stabilisasi halaman');

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 2: Upload video file ──
  log('📤 STEP 1: Upload video...');
  let uploaded = false;
  let hasCriticalUploadError = false;
  let detectedErrorMsg = '';

  // Helper to verify if upload editor has appeared (meaning upload started successfully)
  const verifyUploadStarted = async (): Promise<boolean> => {
    log('⏳ Memverifikasi transisi ke halaman edit (layar detail)...');
    const startTime = Date.now();
    const timeout = 15000;

    while (Date.now() - startTime < timeout) {
      if (!isRunning) return false;

      // Check if editor is visible
      const editorVisible = await page.locator('.public-DraftEditor-content, div[role="textbox"][contenteditable="true"]')
        .first()
        .isVisible()
        .catch(() => false);

      if (editorVisible) {
        return true;
      }

      // Check for upload error
      const uploadError = await detectUploadError(page, log);
      if (uploadError) {
        hasCriticalUploadError = true;
        detectedErrorMsg = uploadError;
        log(`❌ Terdeteksi error upload di halaman: "${uploadError}"`);
        return false;
      }

      await page.waitForTimeout(500);
    }
    return false;
  };

  // Strategy A: Direct file input
  try {
    let fileInput = page.locator('input[type="file"][accept*="video"]').first();
    if (await fileInput.count() === 0) {
      fileInput = page.locator('input[type="file"]').first();
    }
    await fileInput.waitFor({ state: 'attached', timeout: 10000 });
    await fileInput.setInputFiles(videoPath);
    
    if (await verifyUploadStarted()) {
      log('✓ Video diupload via input[type=file] (Terverifikasi)');
      uploaded = true;
    } else {
      log('⚠ input[type=file] diisi tapi tidak ada transisi ke halaman edit');
    }
  } catch {
    log('⚠ input[type=file] langsung gagal, coba strategi lain...');
  }

  // Strategy B: Click select button + file chooser
  if (!uploaded && !hasCriticalUploadError) {
    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        page.locator('button').filter({ hasText: /Select video|Select file|Pilih video/i }).first().click(),
      ]);
      await fileChooser.setFiles(videoPath);
      
      if (await verifyUploadStarted()) {
        log('✓ Video diupload via file chooser (Terverifikasi)');
        uploaded = true;
      } else {
        log('⚠ File chooser digunakan tapi tidak ada transisi ke halaman edit');
      }
    } catch {
      log('⚠ File chooser juga gagal');
    }
  }

  // Strategy C: JS injection
  if (!uploaded && !hasCriticalUploadError) {
    try {
      const inputHandle = await page.evaluateHandle(() => {
        const inputs = document.querySelectorAll('input[type="file"]');
        for (const inp of inputs) {
          if ((inp as HTMLInputElement).accept?.includes('video')) return inp;
        }
        return inputs.length ? inputs[inputs.length - 1] : null;
      });
      if (inputHandle) {
        const el = inputHandle.asElement();
        if (el) {
          await el.setInputFiles(videoPath);
          
          if (await verifyUploadStarted()) {
            log('✓ Video diupload via JS injection (Terverifikasi)');
            uploaded = true;
          } else {
            log('⚠ JS injection digunakan tapi tidak ada transisi ke halaman edit');
          }
        }
      }
    } catch (e: any) {
      log('❌ Semua strategi upload gagal: ' + e.message);
      return false;
    }
  }

  if (!uploaded) {
    if (hasCriticalUploadError) {
      log(`❌ Upload gagal karena error kritis pada file/halaman: "${detectedErrorMsg}"`);
    } else {
      log('❌ Gagal menemukan elemen upload atau verifikasi upload gagal');
    }
    return false;
  }

  // Wait for upload to process
  log('⏳ Menunggu video diproses TikTok...');
  await waitAndLog(page, log, 5000, 'video processing');

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 3: Handle copyright / content check popup ──
  log('🔍 STEP 2: Periksa popup content check...');
  await waitAndLog(page, log, 2000, 'menunggu popup muncul');
  try {
    const liteCheckbox = page.locator('label').filter({ hasText: /Pemeriksaan konten ringan|Content check lite/i }).locator('[data-checked]');
    const liteLabel = page.locator('label').filter({ hasText: /Pemeriksaan konten ringan|Content check lite/i });

    let checkboxFound = false;
    try {
      await liteLabel.waitFor({ state: 'visible', timeout: 5000 });
      checkboxFound = true;
      log('✓ Checkbox "Content check lite" terdeteksi');
    } catch {
      log('ℹ Checkbox content check lite tidak muncul (mungkin tidak ada popup)');
    }

    if (checkboxFound) {
      const checkedState = await liteCheckbox.getAttribute('data-checked').catch(() => null);
      log(`📋 Status checkbox: data-checked="${checkedState}"`);

      if (checkedState === 'true') {
        await liteLabel.click();
        await page.waitForTimeout(500);
        const newState = await liteCheckbox.getAttribute('data-checked').catch(() => null);
        log(`✓ Checkbox di-uncheck → data-checked="${newState}"`);

        if (newState === 'true') {
          log('⚠ Masih checked, coba klik icon wrapper...');
          const iconWrapper = liteLabel.locator('.Checkbox__iconWrapper');
          await iconWrapper.click({ force: true });
          await page.waitForTimeout(500);
          const finalState = await liteCheckbox.getAttribute('data-checked').catch(() => null);
          log(`✓ Retry → data-checked="${finalState}"`);
        }
      } else {
        log('ℹ Checkbox sudah unchecked, lanjut');
      }

      await page.waitForTimeout(1000);

      // Click "Turn On" / "Aktifkan" button
      log('🔍 Mencari tombol Turn On / Aktifkan...');
      const turnOnBtn = page.locator('button, div[role="button"]').filter({ hasText: /^Turn On$|^Aktifkan$/i });
      try {
        await turnOnBtn.first().waitFor({ state: 'visible', timeout: 5000 });
        await turnOnBtn.first().click();
        log('✓ Tombol Turn On / Aktifkan diklik');
        await page.waitForTimeout(2000);
      } catch {
        log('⚠ Tombol Turn On / Aktifkan tidak ditemukan');
      }
    }
  } catch (e: any) {
    log('⚠ Error di content check popup: ' + e.message);
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 4: Handle "Got it" / "Mengerti" popup ──
  log('🔍 STEP 3: Periksa popup "Mengerti" / "Got it"...');
  try {
    const gotItBtn = page.locator('button, div[role="button"]').filter({ hasText: /^Got it$|^Mengerti$/i });
    await gotItBtn.first().waitFor({ state: 'visible', timeout: 5000 });
    await gotItBtn.first().click();
    log('✓ Popup "Got it / Mengerti" ditutup');
    await page.waitForTimeout(1000);
  } catch {
    log('ℹ Tidak ada popup Got it / Mengerti');
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 5: Fill description ──
  log('📝 STEP 4: Mengisi deskripsi...');
  try {
    const editor = page.locator('.public-DraftEditor-content, div[role="textbox"][contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 30000 });
    await editor.click();
    log('✓ Editor deskripsi ditemukan');

    // Clear existing text
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    // Type description
    const prefix = videoIndex ? `[${videoIndex}] ` : '';
    const finalDesc = `${prefix}${config.description || ''}`;
    if (finalDesc) {
      await page.keyboard.type(finalDesc, { delay: 30 });
      log(`✓ Deskripsi diketik: "${finalDesc.substring(0, 50)}..."`);
    }

    // Type hashtags
    if (config.hashtags) {
      const tags = config.hashtags.split(',').map(t => t.trim()).filter(Boolean);
      await page.keyboard.type(' ', { delay: 50 });
      for (const tag of tags) {
        await page.keyboard.type(`#${tag}`, { delay: 30 });
        await page.waitForTimeout(1500);
        await page.keyboard.press('Tab');
        await page.waitForTimeout(500);
        await page.keyboard.type(' ', { delay: 50 });
        log(`✓ Hashtag #${tag} ditambahkan`);
      }
    }
  } catch (e: any) {
    log('❌ Gagal mengisi deskripsi: ' + e.message);
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 6: Add Product ──
  if (config.addProduct && config.productNameRadio) {
    log('🛒 STEP 5: Menambahkan produk...');
    try {
      const addBtn = page.locator('button').filter({ hasText: /^Add$|^Tambah$|^Add link$|^Tambah tautan$|^Product$|^Produk$/i });
      await addBtn.click({ timeout: 10000 });
      log('✓ Tombol Add diklik');
      await waitAndLog(page, log, 2000, 'dialog produk');

      // Wait for the dialog/modal to be visible
      // TikTok may render dialog content in a portal outside role="dialog", so we use page-level locators
      // but confirm the overlay/dialog is open first
      let dialogVisible = false;
      try {
        const dialog = page.getByRole('dialog', { name: /Add link|Tambah tautan/i });
        await dialog.waitFor({ state: 'visible', timeout: 5000 });
        dialogVisible = true;
      } catch {
        // Fallback: check for any dialog
        try {
          await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: 5000 });
          dialogVisible = true;
        } catch {
          // Check for modal overlay
          const overlay = page.locator('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="popup"]').first();
          dialogVisible = await overlay.isVisible({ timeout: 3000 }).catch(() => false);
        }
      }
      log(dialogVisible ? '✓ Dialog produk terbuka' : '⚠ Dialog mungkin tidak terdeteksi, melanjutkan...');

      // Use page-level locators with force:true to prevent scrolling behind popup
      const nextBtnStep1 = page.getByRole('button', { name: /Next|Berikutnya/i });
      await nextBtnStep1.click({ force: true, timeout: 10000 });
      log('✓ Klik Next');
      await waitAndLog(page, log, 2000, 'tab produk');

      try {
        log('🔍 Mencari tab Showcase / Etalase...');
        const showcaseTab = page.locator('button, div[role="tab"]').filter({ 
          hasText: /Showcase products|Produk showcase|Etalase|Showcase|Afiliasi|Affiliate/i 
        }).first();
        
        if (await showcaseTab.isVisible({ timeout: 4000 }).catch(() => false)) {
          await showcaseTab.click({ force: true });
          log('✓ Tab "Showcase / Etalase" diklik');
          await page.waitForTimeout(2000);
        } else {
          log('ℹ Tab Showcase tidak terdeteksi khusus, melanjutkan pencarian produk...');
        }
      } catch (err: any) {
        log(`ℹ Skip tab showcase: ${err.message}`);
      }

      // Search product using exact TikTok Studio DOM selectors & robust multi-locator wait
      log('🔍 Mencari input pencarian produk (TUXInputBox / TUXTextInputCore)...');
      
      const searchInputLocators = [
        'input.TUXTextInputCore-input',
        '.TUXInputBox input',
        '.TUXTextInputCore input',
        'input[placeholder="Cari produk"]',
        'input[placeholder*="Cari" i]',
        'input[placeholder*="Search" i]',
        'input[placeholder*="produk" i]',
        '[role="dialog"] input[type="text"]',
        '[class*="modal"] input[type="text"]'
      ];

      let searchInput = null;
      for (const sel of searchInputLocators) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.count() > 0) {
            await loc.waitFor({ state: 'attached', timeout: 5000 });
            searchInput = loc;
            log(`✓ Input ditemukan dengan selector: "${sel}"`);
            break;
          }
        } catch {}
      }

      if (!searchInput || await searchInput.count() === 0) {
        log('ℹ Fallback: Mengambil input teks pertama di dialog...');
        searchInput = page.locator('[role="dialog"] input, [class*="modal"] input, input[type="text"]').first();
      }

      if (searchInput && await searchInput.count() > 0) {
        log(`✓ Mengisi nama produk: "${config.productNameRadio}"`);
        
        // 1. Scroll into view & focus
        await searchInput.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' })).catch(() => {});
        await page.waitForTimeout(300);

        // 2. Click container .TUXInputBox / .TUXTextInputCore or input
        try {
          const box = page.locator('.TUXInputBox, .TUXTextInputCore').first();
          if (await box.count() > 0) {
            await box.click({ force: true }).catch(() => {});
          } else {
            await searchInput.click({ force: true }).catch(() => {});
          }
        } catch {
          await searchInput.click({ force: true }).catch(() => {});
        }

        // 3. Clear existing text
        await searchInput.evaluate((el: HTMLInputElement) => {
          el.focus();
          el.value = '';
        }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.waitForTimeout(200);

        // 4. Fill text via Playwright fill AND via keyboard type
        try {
          await searchInput.fill(config.productNameRadio);
        } catch {
          await page.keyboard.type(config.productNameRadio, { delay: 50 });
        }

        // 5. Inject React native value setter & dispatch synthetic events
        await searchInput.evaluate((el: HTMLInputElement, val: string) => {
          el.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(el, val);
          } else {
            el.value = val;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        }, config.productNameRadio).catch(() => {});

        await page.waitForTimeout(500);

        // 6. Trigger Search by clicking search icon & pressing Enter
        log('🔍 Mengklik icon pencarian (product-search-icon)...');
        let iconClicked = false;
        try {
          const searchIcon = page.locator('.product-search-icon, .TUXTextInputCore-trailingIconWrapper, [class*="product-search-icon"]').first();
          if (await searchIcon.count() > 0) {
            await searchIcon.click({ force: true, timeout: 3000 });
            iconClicked = true;
            log('✓ Icon .product-search-icon / trailingIconWrapper diklik');
          }
        } catch {}

        if (!iconClicked) {
          try {
            await searchInput.press('Enter');
            log('✓ Tekan Enter untuk cari');
          } catch {}
        }
      } else {
        log('❌ Gagal menemukan input pencarian produk di halaman!');
      }

      log('⏳ Menunggu hasil pencarian di tbody...');
      await waitAndLog(page, log, 3000, 'memuat hasil tabel produk');

      // Select radio button inside tbody table rows. Jangan lanjut ke step
      // berikutnya sebelum TikTok benar-benar menerima pilihan produk.
      let productSelected = false;
      try {
        log('🔍 Mencari hasil produk di tbody...');
        
        // Wait for tbody table rows to appear
        const rows = page.locator('tbody tr.product-tb-row, tbody tr, tr.product-tb-row');
        let rowCount = 0;
        try {
          await rows.first().waitFor({ state: 'visible', timeout: 10000 });
          rowCount = await rows.count();
        } catch {
          log('⚠ Tidak ada baris tabel produk muncul di tbody dalam 10s');
        }

        log(`📋 Ditemukan ${rowCount} baris produk di tabel`);

        let targetRow = null;
        if (rowCount > 0) {
          const searchTerm = config.productNameRadio.toLowerCase().trim();
          const searchKeywords = searchTerm.split(' ').filter(k => k.length > 2);

          // Find row matching full search term or any keyword
          for (let i = 0; i < rowCount; i++) {
            const row = rows.nth(i);
            const text = (await row.textContent().catch(() => '')) || '';
            const textLower = text.toLowerCase();

            if (textLower.includes(searchTerm)) {
              targetRow = row;
              log(`✓ Baris cocok sempurna di index ${i + 1}`);
              break;
            }
            for (const kw of searchKeywords) {
              if (textLower.includes(kw)) {
                targetRow = row;
                log(`✓ Baris cocok dengan kata kunci "${kw}" di index ${i + 1}`);
                break;
              }
            }
            if (targetRow) break;
          }

          if (!targetRow) {
            log('ℹ Menggunakan baris produk pertama dari hasil pencarian');
            targetRow = rows.first();
          }

          // Locate radio input & wrapper inside targetRow
          const radioInput = targetRow.locator('input[type="radio"], .TUXRadioStandalone-input').first();
          const radioWrapper = targetRow.locator('.TUXRadioStandalone, .TUXRadio, .product-info-cell').first();
          const radioLabel = targetRow.locator('label.TUXRadio-label, label').first();

          await targetRow.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
          await page.waitForTimeout(500);

          let checked = false;

          // Method 1: Click .TUXRadioStandalone / .TUXRadio
          try {
            if (await radioWrapper.count() > 0) {
              await radioWrapper.click({ force: true, timeout: 3000 });
              await page.waitForTimeout(500);
              checked = await radioInput.isChecked().catch(() => false);
              if (checked) log('✓ Radio produk tercentang (via .TUXRadioStandalone)');
            }
          } catch {}

          // Method 2: Click label for radio
          if (!checked) {
            try {
              if (await radioLabel.count() > 0) {
                await radioLabel.click({ force: true, timeout: 3000 });
                await page.waitForTimeout(500);
                checked = await radioInput.isChecked().catch(() => false);
                if (checked) log('✓ Radio produk tercentang (via label)');
              }
            } catch {}
          }

          // Method 3: Direct JS click on radio input
          if (!checked) {
            try {
              await radioInput.evaluate((el: HTMLInputElement) => {
                el.click();
                el.dispatchEvent(new Event('change', { bubbles: true }));
              });
              await page.waitForTimeout(500);
              checked = await radioInput.isChecked().catch(() => false);
              if (checked) log('✓ Radio produk tercentang (via JS click)');
            } catch {}
          }

          // Method 4: Click target row
          if (!checked) {
            try {
              await targetRow.click({ force: true, timeout: 3000 });
              await page.waitForTimeout(500);
              checked = await radioInput.isChecked().catch(() => false);
              if (checked) log('✓ Radio produk tercentang (via row click)');
            } catch {}
          }

          if (checked) {
            productSelected = true;
            log('✓ Radio produk BERHASIL dipilih & tercentang!');
          } else {
            log('⚠ Radio produk belum terverifikasi tercentang');
          }
        } else {
          log('⚠ Tidak ada baris produk ditemukan di tbody, mencoba radio langsung');
        }
      } catch (e: any) {
        log('⚠ Gagal memilih radio produk: ' + e.message);
      }

      // Layout baru kadang tidak memakai <tbody>. Cari radio berdasarkan nama
      // atau teks produk pada semua elemen radio yang ada di modal.
      if (!productSelected) {
        const radios = page.locator('input[type="radio"], [role="radio"]');
        const radioCount = await radios.count();
        const searchTerm = config.productNameRadio.toLowerCase().trim();
        const searchKeywords = searchTerm.split(/\s+/).filter(k => k.length > 2);
        let fallbackRadio = null;

        for (let i = 0; i < radioCount; i++) {
          const radio = radios.nth(i);
          const radioName = `${await radio.getAttribute('name').catch(() => '') || ''} ${await radio.getAttribute('aria-label').catch(() => '') || ''}`.toLowerCase();
          const containerText = ((await radio.locator('xpath=ancestor::*[self::tr or @role="row" or contains(@class,"product")][1]').textContent().catch(() => '')) || '').toLowerCase();
          const haystack = `${radioName} ${containerText}`;
          if (haystack.includes(searchTerm) || searchKeywords.some(keyword => haystack.includes(keyword))) {
            fallbackRadio = radio;
            break;
          }
        }

        if (!fallbackRadio && radioCount > 0) fallbackRadio = radios.first();
        if (fallbackRadio) {
          await fallbackRadio.evaluate((element: HTMLElement) => {
            element.click();
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }).catch(() => {});
          await page.waitForTimeout(500);
          productSelected = await fallbackRadio.isChecked().catch(async () =>
            (await fallbackRadio!.getAttribute('aria-checked').catch(() => null)) === 'true'
          );
          if (productSelected) log('✓ Radio produk dipilih melalui fallback semua layout');
        }
      }

      const productDialogStep2 = page.locator('[role="dialog"]:visible, .TUXModal:visible, [class*="modal"]:visible').last();
      let nextBtnStep2 = productDialogStep2.locator('button:visible').filter({ hasText: /^(Next|Berikutnya)$/i }).last();
      if (await nextBtnStep2.count() === 0) {
        nextBtnStep2 = page.locator('button:visible').filter({ hasText: /^(Next|Berikutnya)$/i }).last();
      }
      await nextBtnStep2.waitFor({ state: 'visible', timeout: 8000 });

      const nextAriaDisabled = await nextBtnStep2.getAttribute('aria-disabled');
      const nextDisabled = await nextBtnStep2.isDisabled().catch(() => false);
      if (!productSelected && nextAriaDisabled !== 'true' && !nextDisabled) {
        // Beberapa versi TikTok memakai custom radio yang tidak mengekspos
        // checked, tetapi mengaktifkan Next setelah pilihan berhasil.
        productSelected = true;
        log('✓ Pilihan produk terverifikasi dari tombol Next yang sudah aktif');
      }
      if (!productSelected || nextAriaDisabled === 'true' || nextDisabled) {
        throw new Error('Produk belum terpilih; tombol Next masih nonaktif');
      }

      await nextBtnStep2.click({ timeout: 10000 });
      log('✓ Klik Next (step 2)');
      await waitAndLog(page, log, 1200, 'form produk');

      if (config.productTitle) {
        const productDialogStep3 = page.locator('[role="dialog"]:visible, .TUXModal:visible, [class*="modal"]:visible').last();
        const titleInputCandidates = [
          productDialogStep3.getByRole('textbox', { name: /Product name|Nama produk|Product title|Judul produk/i }).first(),
          productDialogStep3.locator('input.TUXTextInputCore-input:visible').first(),
          productDialogStep3.locator('input[placeholder*="product" i]:visible, input[placeholder*="produk" i]:visible').first(),
          page.getByRole('textbox', { name: /Product name|Nama produk|Product title|Judul produk/i }).last(),
          page.locator('input.TUXTextInputCore-input:visible').last()
        ];

        let titleInput = titleInputCandidates[0];
        let titleInputFound = false;
        for (const candidate of titleInputCandidates) {
          if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)
            && await candidate.isEditable().catch(() => false)) {
            titleInput = candidate;
            titleInputFound = true;
            break;
          }
        }
        if (!titleInputFound) {
          throw new Error('Input judul produk tidak ditemukan setelah memilih produk');
        }

        try {
          await titleInput.fill(config.productTitle, { timeout: 8000 });
        } catch {
          await titleInput.evaluate((element: HTMLInputElement, value: string) => {
            element.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(element, value);
            else element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }, config.productTitle);
        }

        const actualTitle = await titleInput.inputValue().catch(() => '');
        if (!actualTitle.trim()) throw new Error('Judul produk gagal terisi');
        log(`✓ Judul produk: ${config.productTitle}`);
      }

      const productDialogFinal = page.locator('[role="dialog"]:visible, .TUXModal:visible, [class*="modal"]:visible').last();
      let finalAddButton = productDialogFinal.locator('button:visible').filter({ hasText: /^(Add|Tambah)$/i }).last();
      if (await finalAddButton.count() === 0) {
        finalAddButton = page.getByRole('button', { name: /^(Add|Tambah)$/i }).last();
      }
      await finalAddButton.click({ timeout: 10000 });
      log('✓ Produk ditambahkan');
      await waitAndLog(page, log, 2000, 'produk disimpan');
    } catch (e: any) {
      log('❌ Gagal menambahkan produk: ' + e.message);
      await dismissProductDialog(page, log);
      log('⛔ Video tidak dijadwalkan tanpa produk. File dipertahankan agar bisa dicoba lagi.');
      return false;
    }
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 7: Switches (AI-generated content & Pemeriksaan konten ringan) ──
  if (!config.skipSwitches) {
    log('🔀 STEP 6: Toggle switches...');
    try {
      // 1. Open Advanced Settings if present
      try {
        const advSettings = page.locator('[data-e2e="advanced_settings_container"]');
        if (await advSettings.isVisible({ timeout: 3000 }).catch(() => false)) {
          await advSettings.scrollIntoViewIfNeeded().catch(() => {});
          await advSettings.click({ timeout: 3000 });
          log('✓ Advanced settings dibuka');
          await page.waitForTimeout(1500);
        }
      } catch {}

      // 2. AI-generated Content Switch ("Konten yang dihasilkan AI")
      try {
        log('🔍 Mencari switch "Konten yang dihasilkan AI"...');
        const aigcLocators = [
          page.locator('[data-e2e="aigc_container"] .Switch__content'),
          page.locator('[data-e2e="aigc_container"] input[role="switch"]'),
          page.locator('div, label').filter({ hasText: /Konten yang dihasilkan AI|AI-generated content|AIGC/i }).locator('.Switch__content, .Switch__root, input[role="switch"]').first()
        ];

        let aigcClicked = false;
        for (const loc of aigcLocators) {
          try {
            if (await loc.count() > 0) {
              await loc.scrollIntoViewIfNeeded().catch(() => {});
              await loc.click({ force: true });
              aigcClicked = true;
              log('✓ Switch "Konten yang dihasilkan AI" diklik');
              break;
            }
          } catch {}
        }

        if (aigcClicked) {
          // Check for pop-up modal "Labeling AI-generated content" / "Turn on" / "Aktifkan"
          try {
            const turnOnBtn = page.locator('.TUXModal, [class*="modal"], [role="dialog"]')
              .filter({ hasText: /Labeling AI-generated content|AI-generated|Konten yang dihasilkan AI/i })
              .locator('button')
              .filter({ hasText: /^Turn on$|^Aktifkan$/i });
            
            if (await turnOnBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await turnOnBtn.click({ force: true });
              log('✓ Pop-up "Labeling AI-generated content" diklik Turn on / Aktifkan');
              await page.waitForTimeout(1000);
            }
          } catch {}
        } else {
          log('ℹ Switch AI-generated tidak terdeteksi atau sudah aktif');
        }
      } catch (err: any) {
        log(`⚠ AI-generated switch: ${err.message}`);
      }
    } catch (e: any) {
      log('⚠ Toggle switches: ' + e.message);
    }
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 8: Schedule ──
  if (!await setTikTokSchedule(page, scheduleDate, scheduleTime, log)) return false;

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 9: Content Check Lite Switch — ensure ALWAYS turned OFF ──
  log('🔍 STEP 8: Memeriksa Content Check Lite switch...');
  try {
    let contentCheckClicked = false;

    // Direct JS matching exact DOM structure: .headline-wrapper -> .headline-switch -> .Switch__content
    try {
      const result = await page.evaluate(() => {
        // 1. Target exact DOM structure from user: div.headline-wrapper containing "Pemeriksaan konten"
        const headlineWrappers = document.querySelectorAll('.headline-wrapper, [class*="headline-wrapper"]');
        for (const hw of headlineWrappers) {
          const txt = (hw.textContent || '').toLowerCase();
          if (txt.includes('pemeriksaan konten') || txt.includes('content check')) {
            const switchContent = hw.querySelector('.headline-switch .Switch__content, .Switch__content, .Switch__root, input[role="switch"]') as HTMLElement | null;
            if (switchContent) {
              const cls = switchContent.className || '';
              const aria = switchContent.getAttribute('aria-checked') || '';
              const dataState = switchContent.getAttribute('data-state') || '';
              const isOn = cls.includes('checked-true') || aria === 'true' || dataState === 'checked';
              if (isOn) {
                switchContent.scrollIntoView({ block: 'center' });
                switchContent.click();
                return 'clicked_direct';
              } else {
                return 'already_off_direct';
              }
            }
          }
        }

        // 2. Generic fallback scan for any element with text 'Pemeriksaan konten' or 'Content check'
        const allEls = document.querySelectorAll('span, div, label, p');
        for (const el of allEls) {
          const txt = (el.textContent || '').toLowerCase().trim();
          if (txt.includes('pemeriksaan konten') || txt.includes('content check')) {
            const parent = el.closest('.headline-wrapper, [class*="headline-wrapper"], [class*="jsx-"], div[class*="container"], div[class*="row"]') || el.parentElement;
            if (!parent) continue;
            const switchEl = parent.querySelector('.Switch__content, .Switch__root, [role="switch"]') as HTMLElement | null;
            if (switchEl) {
              const cls = switchEl.className || '';
              const aria = switchEl.getAttribute('aria-checked') || '';
              const dataState = switchEl.getAttribute('data-state') || '';
              const isOn = cls.includes('checked-true') || aria === 'true' || dataState === 'checked';
              if (isOn) {
                switchEl.scrollIntoView({ block: 'center' });
                switchEl.click();
                return 'clicked_fallback';
              } else {
                return 'already_off_fallback';
              }
            }
          }
        }
        return 'not_found';
      });

      if (result === 'clicked_direct' || result === 'clicked_fallback') {
        await page.waitForTimeout(1000);
        contentCheckClicked = true;
        log(`✓ Content Check Lite dimatikan (${result})`);
      } else if (result === 'already_off_direct' || result === 'already_off_fallback') {
        contentCheckClicked = true;
        log(`ℹ Content Check Lite sudah OFF (${result})`);
      } else {
        log('ℹ Content Check Lite tidak ditemukan via JS evaluation');
      }
    } catch (eJS: any) {
      log(`  JS evaluation error: ${eJS.message}`);
    }

    // Playwright locator fallback if JS didn't execute
    if (!contentCheckClicked) {
      try {
        const switchEl = page.locator('.headline-wrapper').filter({ hasText: /Pemeriksaan konten|Content check/i }).locator('.Switch__content, .Switch__root').first();
        if (await switchEl.isVisible({ timeout: 3000 }).catch(() => false)) {
          const cls = await switchEl.getAttribute('class') || '';
          const aria = await switchEl.getAttribute('aria-checked') || '';
          if (cls.includes('checked-true') || aria === 'true') {
            await switchEl.click({ force: true });
            await page.waitForTimeout(1000);
            log('✓ Content Check Lite dimatikan (Playwright fallback)');
          } else {
            log('ℹ Content Check Lite sudah OFF (Playwright fallback)');
          }
        }
      } catch {}
    }
  } catch (e: any) {
    log(`⚠ Content Check Lite: ${e.message}`);
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 10: Verify video uploaded before posting ──
  log('🔍 STEP 9: Memeriksa apakah video sudah terupload...');
  try {
    const uploadedIndicator = page.locator('span').filter({ hasText: /Uploaded|Diunggah/i }).first();
    await uploadedIndicator.waitFor({ state: 'visible', timeout: 120000 });
    const uploadText = await uploadedIndicator.textContent();
    log(`✓ Video sudah terupload: ${uploadText?.trim()}`);
  } catch {
    log('⚠ Indikator upload tidak terdeteksi, melanjutkan...');
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 11: Click Schedule/Post button ──
  log('🎬 STEP 10: Klik tombol Schedule/Post...');
  try {
    if (!await verifyTikTokSchedule(page, scheduleDate, scheduleTime, log)) return false;
    let clicked = false;

    // Method 1: Target data-e2e="post_video_button" directly (matches "Posting", "Jadwalkan", "Schedule", etc.)
    const postVideoBtn = page.locator("button[data-e2e='post_video_button']").first();
    if (await postVideoBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await postVideoBtn.scrollIntoViewIfNeeded();
      if (!await verifyTikTokSchedule(page, scheduleDate, scheduleTime, log)) return false;
      await postVideoBtn.click({ force: true });
      clicked = true;
      log('✓ Tombol Post/Schedule diklik (data-e2e="post_video_button")');
    }

    // Method 2: Fallback text filter matching Posting, Jadwalkan, Schedule, Post, Tayangkan
    if (!clicked) {
      const fallbackBtn = page.locator('button').filter({ hasText: /Posting|Jadwalkan|Schedule|Tayangkan|^Post$/i }).first();
      if (await fallbackBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        if (!await verifyTikTokSchedule(page, scheduleDate, scheduleTime, log)) return false;
        await fallbackBtn.click({ force: true });
        clicked = true;
        log('✓ Tombol Post/Schedule diklik (fallback text match)');
      }
    }

    // Method 3: JS Direct Click on button[data-e2e="post_video_button"]
    if (!clicked) {
      if (!await verifyTikTokSchedule(page, scheduleDate, scheduleTime, log)) return false;
      clicked = await page.evaluate(() => {
        const btn = document.querySelector('button[data-e2e="post_video_button"]') as HTMLButtonElement;
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) log('✓ Tombol Post/Schedule diklik (JS fallback)');
    }

    if (!clicked) {
      log('❌ Tombol Post/Schedule tidak ditemukan; video tidak ditandai berhasil.');
      return false;
    }

    const submitResult = await waitForTikTokSubmitResult(page, log, () => verifyTikTokSchedule(page, scheduleDate, scheduleTime, log));
    if (!submitResult.success) {
      log(`❌ TikTok belum mengonfirmasi upload/schedule: ${submitResult.error}`);
      return false;
    }

    log(`✅ TikTok mengonfirmasi upload/schedule berhasil: ${submitResult.evidence}`);
    return true;
  } catch (e: any) {
    log('❌ Gagal klik tombol publish: ' + e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
//  MAIN UPLOAD FUNCTION - MULTI-VIDEO SEQUENTIAL
// ═══════════════════════════════════════════════════════════
async function runUploadUnlocked(
  config: UploadConfig,
  log: LogFn,
  onVideoUploaded?: (filename: string) => void,
  onSchedulePlanned?: (items: SchedulePlanItem[]) => void | Promise<void>
): Promise<void> {
  isRunning = true;

  // ── Validate state file ──
  const stateFilePath = path.join(config.statesDir, config.stateFile);
  if (!fs.existsSync(stateFilePath)) {
    log('❌ State file tidak ditemukan: ' + stateFilePath);
    isRunning = false;
    return;
  }

  // ── Get all videos in the folder ──
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let allVideos: string[];
  try {
    allVideos = fs.readdirSync(config.videoFolder)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
  } catch (e: any) {
    log('❌ Gagal membaca folder video: ' + e.message);
    isRunning = false;
    return;
  }

  // ── Find start index ──
  const startIdx = allVideos.indexOf(config.startFromVideo);
  if (startIdx === -1) {
    log('❌ Video tidak ditemukan dalam folder: ' + config.startFromVideo);
    isRunning = false;
    return;
  }

  // ── Get videos from start to end ──
  const videosFromStart = allVideos.slice(startIdx);

  // ── Read uploaded marks ──
  const marksFile = path.join(config.videoFolder, '.uploaded.json');
  let uploadedMarks: Record<string, boolean> = {};
  try { uploadedMarks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  // ── Filter out already uploaded ──
  const pendingVideos = videosFromStart.filter(v => !uploadedMarks[v]);
  const maxVideos = Number.isFinite(config.maxVideos)
    ? Math.max(1, Math.floor(Number(config.maxVideos)))
    : pendingVideos.length;
  const videosToUpload = pendingVideos.slice(0, maxVideos);

  if (videosToUpload.length === 0) {
    log('ℹ Semua video mulai dari yang dipilih sudah terupload!');
    isRunning = false;
    return;
  }

  // ── Calculate base schedule time ──
  const intervalMinutes = config.threeUploadsPerHour ? (config.intervalMinutes || 300) : (config.intervalMinutes || 60);
  const intervalMs = intervalMinutes * 60 * 1000;
  let baseSchedule: Date;
  try {
    baseSchedule = new Date(`${config.scheduleDate}T${config.scheduleTime}:00`);
    if (isNaN(baseSchedule.getTime())) throw new Error('Invalid date');
  } catch {
    log('⚠ Schedule date/time tidak valid, menggunakan waktu sekarang + 1 jam');
    baseSchedule = new Date(Date.now() + 3600000);
  }

  const minimumScheduleTime = new Date(Date.now() + 30 * 60 * 1000);
  if (baseSchedule.getTime() < minimumScheduleTime.getTime()) {
    minimumScheduleTime.setSeconds(0, 0);
    minimumScheduleTime.setMinutes(Math.ceil(minimumScheduleTime.getMinutes() / 5) * 5);
    baseSchedule = minimumScheduleTime;
    log(`⚠ Jadwal awal sudah lewat/terlalu dekat. Diganti otomatis ke ${baseSchedule.toLocaleString('id-ID')} agar diterima TikTok.`);
  }

  if (config.threeUploadsPerHour && !config.brutalContent) {
    baseSchedule.setMinutes(0);
    baseSchedule.setSeconds(0);
    baseSchedule.setMilliseconds(0);
  }

  const formatSchedulePlanItem = (videoSchedule: Date, index: number, filename: string, offsetMinutes?: number): SchedulePlanItem => ({
    index: index + 1,
    filename,
    scheduleDate: `${videoSchedule.getFullYear()}-${String(videoSchedule.getMonth() + 1).padStart(2, '0')}-${String(videoSchedule.getDate()).padStart(2, '0')}`,
    scheduleTime: `${String(videoSchedule.getHours()).padStart(2, '0')}:${String(videoSchedule.getMinutes()).padStart(2, '0')}`,
    offsetMinutes
  });

  const schedulePlan: SchedulePlanItem[] = [];
  if (config.brutalContent) {
    const brutalSchedule = buildBrutalContentSchedule(baseSchedule, videosToUpload.length);
    for (let i = 0; i < brutalSchedule.length; i++) {
      schedulePlan.push(formatSchedulePlanItem(brutalSchedule[i], i, videosToUpload[i]));
    }
  } else if (config.enableCustomScheduler) {
    const validMins = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
    const temp = [...validMins];
    const chosenMins: number[] = [];
    for (let i = 0; i < videosToUpload.length; i++) {
      if (temp.length === 0) {
        chosenMins.push(validMins[Math.floor(Math.random() * validMins.length)]);
      } else {
        const idx = Math.floor(Math.random() * temp.length);
        chosenMins.push(temp.splice(idx, 1)[0]);
      }
    }
    chosenMins.sort((a, b) => a - b);

    for (let i = 0; i < videosToUpload.length; i++) {
      const videoSchedule = new Date(baseSchedule.getTime());
      videoSchedule.setMinutes(chosenMins[i] || 0);
      videoSchedule.setSeconds(0);
      videoSchedule.setMilliseconds(0);
      schedulePlan.push(formatSchedulePlanItem(videoSchedule, i, videosToUpload[i]));
    }
  } else if (config.threeUploadsPerHour) {
    let currentBatchMinutes: number[] = [];
    let lastBatchIndex = -1;

    for (let i = 0; i < videosToUpload.length; i++) {
      const batchIndex = Math.floor(i / 3);
      const subIndex = i % 3;

      if (batchIndex !== lastBatchIndex) {
        const possible: number[] = [];
        for (let m = 0; m < 60; m += 5) {
          possible.push(m);
        }
        currentBatchMinutes = [];
        while (currentBatchMinutes.length < 3 && possible.length > 0) {
          const randIdx = Math.floor(Math.random() * possible.length);
          currentBatchMinutes.push(possible.splice(randIdx, 1)[0]);
        }
        currentBatchMinutes.sort((a, b) => a - b);
        lastBatchIndex = batchIndex;
      }

      const cycleMs = intervalMinutes * 60000;
      const videoSchedule = new Date(baseSchedule.getTime() + batchIndex * cycleMs);
      videoSchedule.setMinutes(currentBatchMinutes[subIndex]);
      schedulePlan.push(formatSchedulePlanItem(videoSchedule, i, videosToUpload[i]));
    }
  } else {
    let previousIntervalSchedule = new Date(baseSchedule.getTime());
    for (let i = 0; i < videosToUpload.length; i++) {
      let videoSchedule: Date;
      let offsetMinutes: number | undefined;
      if (config.randomizeIntervalSchedule && i > 0) {
        offsetMinutes = getRandomIntervalOffsetMinutes();
        videoSchedule = new Date(previousIntervalSchedule.getTime() + intervalMs + offsetMinutes * 60000);
      } else {
        videoSchedule = i === 0
          ? new Date(baseSchedule.getTime())
          : new Date(baseSchedule.getTime() + i * intervalMs);
      }
      previousIntervalSchedule = new Date(videoSchedule.getTime());
      schedulePlan.push(formatSchedulePlanItem(videoSchedule, i, videosToUpload[i], offsetMinutes));
    }
  }

  if (onSchedulePlanned) {
    log('📲 Mengirim daftar schedule ke WhatsApp sebelum browser upload dibuka...');
    await onSchedulePlanned(schedulePlan);
  }

  log('🚀 ═══════════════════════════════════════════');
  log(`🚀 Memulai upload ${videosToUpload.length} video TikTok`);
  log(`📁 Folder: ${config.videoFolder}`);
  log(`🔑 State: ${config.stateFile}`);
  const firstPlannedSchedule = schedulePlan[0];
  log(`⏰ Schedule pertama: ${firstPlannedSchedule.scheduleDate} ${firstPlannedSchedule.scheduleTime}`);
  if (config.brutalContent) {
    log(`🔥 Mode Brutal Konten: ${videosToUpload.length} video, tersebar natural 1–3 video/jam tanpa waktu bersamaan`);
  } else if (config.threeUploadsPerHour) {
    log(`⏰ Mode Interval Tetap: 3 upload per jam, jeda antar-jam ${intervalMinutes} menit`);
  } else {
    log(`⏱ Interval: ${intervalMinutes} menit (${Math.floor(intervalMinutes / 60)}j ${intervalMinutes % 60}m)`);
    if (config.randomizeIntervalSchedule) {
      log(`🎲 Random interval aktif: jadwal setelah video pertama digeser -${RANDOM_INTERVAL_OFFSET_MAX_MINUTES} sampai +${RANDOM_INTERVAL_OFFSET_MAX_MINUTES} menit, kelipatan ${RANDOM_INTERVAL_OFFSET_STEP_MINUTES} menit`);
    }
  }
  log(`📋 Total video: ${videosFromStart.length} | Sudah upload: ${videosFromStart.length - videosToUpload.length} | Akan upload: ${videosToUpload.length}`);
  log('🚀 ═══════════════════════════════════════════');

  try {
    // ── Launch browser (Native Chrome CMD + CDP Connect) ──
    const cleanStateName = (config.stateFile || 'default')
      .replace(/^(tiktok|grok|facebook)-state-/, '')
      .replace(/\.json$/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const profileDir = path.join(config.statesDir ? path.dirname(config.statesDir) : __dirname, 'chrome-profiles', `tiktok_${cleanStateName}`);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const cdpPort = 9222;
    const targetUrl = 'https://www.tiktok.com/tiktokstudio/upload';
    const isHeadless = config.headless ?? false;

    log(`🌐 Membuka Chrome Native via CMD (Port CDP: ${cdpPort}, Headless: ${isHeadless})...`);

    let connected = false;
    let chromeLaunchError = '';

    // 1. Coba hubungkan ke Chrome Native yang SUDAH berjalan terlebih dahulu.
    // Jangan pakai ulang browser bila mode aktualnya berbeda dari konfigurasi:
    // flag headless hanya ditentukan saat proses Chrome pertama kali diluncurkan.
    let existingBrowserConnected = false;
    try {
      activeBrowser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`, { timeout: 2000 });
      existingBrowserConnected = true;
      const activeHeadless = await detectConnectedBrowserHeadless(activeBrowser);
      if (activeHeadless === null || activeHeadless !== isHeadless) {
        const activeMode = activeHeadless === null ? 'tidak terdeteksi' : activeHeadless ? 'headless' : 'headed';
        log(`⚠ Mode Chrome aktif (${activeMode}) tidak cocok dengan konfigurasi (${isHeadless ? 'headless' : 'headed'}). Meluncurkan ulang browser...`);
        await closeMismatchedChrome(activeBrowser, cdpPort, log);
        activeBrowser = null;
        activeContext = null;
      } else {
        connected = true;
        log(`✓ Terhubung ke Chrome Native yang sudah berjalan via CDP (mode: ${activeHeadless ? 'headless' : 'headed'})!`);
      }
    } catch (error) {
      // Tidak adanya browser di port CDP adalah kondisi normal sebelum launch.
      // Namun kegagalan setelah berhasil terhubung (misalnya proses lama tidak
      // dapat dihentikan) wajib menghentikan upload agar tidak tersambung ulang
      // ke browser dengan mode yang salah.
      if (existingBrowserConnected) throw error;
    }

    if (!connected) {
      // 2. Jika belum ada Chrome dengan mode yang sesuai, bersihkan lock file profil & launch Chrome baru
      const lockFile = path.join(profileDir, 'SingletonLock');
      if (fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch {}
      }

      // Launch Chrome via CMD
      const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];
      const chromeExe = chromePaths.find(p => fs.existsSync(p)) || 'chrome.exe';
      const chromeArgs = [
        ...(isHeadless ? ['--headless=new'] : []),
        ...(!isHeadless ? ['--new-window', '--start-maximized'] : []),
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${profileDir}`,
        targetUrl,
      ];
      const chromeProcess = spawn(chromeExe, chromeArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: isHeadless,
      });
      chromeProcess.once('error', error => {
        chromeLaunchError = error.message;
        log(`❌ Chrome gagal diluncurkan: ${error.message}`);
      });
      chromeProcess.once('exit', (code, signal) => {
        if (!connected && code !== null) {
          chromeLaunchError = `proses Chrome berhenti dengan code ${code}${signal ? `, signal ${signal}` : ''}`;
          log(`⚠ ${chromeLaunchError}`);
        }
      });
      chromeProcess.unref();

      // Connect Playwright over CDP to Native Chrome (retry max 30x / 15s)
      log('⏳ Menghubungkan Playwright ke Chrome Native via CDP...');
      for (let attempt = 1; attempt <= 30; attempt++) {
        try {
          activeBrowser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`, { timeout: 2000 });
          const launchedHeadless = await detectConnectedBrowserHeadless(activeBrowser);
          if (launchedHeadless === null || launchedHeadless !== isHeadless) {
            const launchedMode = launchedHeadless === null ? 'tidak terdeteksi' : launchedHeadless ? 'headless' : 'headed';
            chromeLaunchError = `Chrome pada port ${cdpPort} berjalan dalam mode ${launchedMode}, bukan ${isHeadless ? 'headless' : 'headed'}`;
            await activeBrowser.close().catch(() => {});
            activeBrowser = null;
            log(`❌ ${chromeLaunchError}`);
            break;
          }
          connected = true;
          log(`✓ Playwright terhubung ke Chrome Native via CDP (mode terverifikasi: ${launchedHeadless ? 'headless' : 'headed'})!`);
          break;
        } catch {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }

    if (!connected || !activeBrowser) {
      throw new Error(`Gagal menghubungkan Playwright ke Chrome Native via CDP port 9222${chromeLaunchError ? `: ${chromeLaunchError}` : ''}`);
    }

    activeContext = activeBrowser.contexts()[0];
    await activeContext.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Sync cookies from state file directly into active CDP context
    if (fs.existsSync(stateFilePath)) {
      try {
        const stateContent = fs.readFileSync(stateFilePath, 'utf-8');
        const stateData = JSON.parse(stateContent);
        if (stateData.cookies && Array.isArray(stateData.cookies) && stateData.cookies.length > 0) {
          await activeContext.addCookies(stateData.cookies);
          log(`✓ Cookie (${stateData.cookies.length} item) disinkronkan ke context CDP`);
        }
      } catch (e: any) {
        log(`⚠ Info cookie: ${e.message}`);
      }
    }
    await activeContext.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = activeContext.pages().length > 0 ? activeContext.pages()[0] : await activeContext.newPage();
    if (!isHeadless) await bringChromeWindowToFront(page, log);

    let uploadIndex = 0;
    let successCount = 0;
    let failCount = 0;

    for (const videoFile of videosToUpload) {
      if (!isRunning) {
        log('⛔ Upload dihentikan oleh user');
        break;
      }

      const plannedSchedule = schedulePlan[uploadIndex];
      if (plannedSchedule.offsetMinutes !== undefined) {
        log(`🎲 Random interval video ${uploadIndex + 1}: ${plannedSchedule.offsetMinutes >= 0 ? '+' : ''}${plannedSchedule.offsetMinutes} menit`);
      }

      const schedDate = plannedSchedule.scheduleDate;
      const schedTime = plannedSchedule.scheduleTime;

      log('');
      log(`════════════════════════════════════════`);
      log(`📹 Video ${uploadIndex + 1}/${videosToUpload.length}: ${videoFile}`);
      log(`📅 Schedule: ${schedDate} ${schedTime}`);
      log(`════════════════════════════════════════`);

      // ── Broadcast start event ──
      log(`[VIDEO_STARTED]:${videoFile}`);

      const videoPath = path.join(config.videoFolder, videoFile);
      if (!fs.existsSync(videoPath)) {
        log(`⚠ File video tidak ditemukan: ${videoPath}, skip...`);
        log(`[VIDEO_SKIPPED]:${videoFile}`);
        try {
          let m: Record<string, boolean> = {};
          try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
          m[videoFile] = true;
          fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
          log(`✓ Menandai file tidak ditemukan sebagai terproses: ${videoFile}`);
        } catch (e: any) {
          log(`⚠ Gagal menandai video tidak ditemukan: ${e.message}`);
        }
        failCount++;
        uploadIndex++;
        continue;
      }

      // ── Verify video file integrity ──
      const isValid = await isVideoValid(videoPath, log);
      if (!isValid) {
        log(`❌ File video rusak/corrupt: ${videoFile}, skip...`);
        log(`[VIDEO_SKIPPED]:${videoFile}`);
        try {
          if (fs.existsSync(videoPath)) {
            fs.unlinkSync(videoPath);
            log(`🗑️ Berhasil menghapus file corrupt: ${videoFile}`);
          }
        } catch (e: any) {
          log(`⚠ Gagal menghapus file corrupt ${videoFile}: ${e.message}`);
        }
        try {
          let m: Record<string, boolean> = {};
          try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
          m[videoFile] = true;
          fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
          log(`✓ Menandai file corrupt sebagai terproses: ${videoFile}`);
        } catch (e: any) {
          log(`⚠ Gagal menandai video corrupt: ${e.message}`);
        }
        failCount++;
        uploadIndex++;
        continue;
      }

      try {
        const success = await uploadSingleVideo(
          page,
          videoPath,
          config,
          schedDate,
          schedTime,
          log,
          uploadIndex + 1
        );

        if (success) {
          successCount++;
          if (onVideoUploaded) {
            onVideoUploaded(videoFile);
          }
          log(`✅ Video ${videoFile} berhasil diupload! (${successCount}/${videosToUpload.length})`);
        } else {
          failCount++;
          log(`❌ Video ${videoFile} gagal diupload. Batch dihentikan agar file berikutnya tidak ditandai atau dihapus secara keliru.`);
          break;
        }
      } catch (e: any) {
        failCount++;
        log(`❌ Error upload ${videoFile}: ${e.message}. Batch dihentikan dan file dipertahankan.`);
        break;
      }

      uploadIndex++;

      // ── Wait before next video ──
      if (uploadIndex < videosToUpload.length && isRunning) {
        log('⏳ Menunggu 15 detik sebelum video berikutnya...');
        await page.waitForTimeout(15000);
      }
    }

    log('');
    log('═══════════════════════════════════════════');
    log(`📊 RINGKASAN: ${successCount} berhasil, ${failCount} gagal dari ${videosToUpload.length} video`);
    log('═══════════════════════════════════════════');

    if (failCount > 0) {
      throw new Error(`Batch upload dihentikan: ${successCount} berhasil, ${failCount} gagal, ${videosToUpload.length - successCount - failCount} belum diproses`);
    }
  } catch (e: any) {
    log('❌ Error fatal: ' + e.message);
    throw e;
  } finally {
    isRunning = false;
    // Don't close browser so user can inspect
    log('✅ Proses selesai. Browser tetap terbuka untuk inspeksi.');
  }
}

// Semua pemanggil berbagi satu Chrome/CDP. Serialisasi di sini mencegah dua
// bot menempel ke profile/tab yang sama ketika berjalan bersamaan.
export async function runUpload(
  config: UploadConfig,
  log: LogFn,
  onVideoUploaded?: (filename: string) => void,
  onSchedulePlanned?: (items: SchedulePlanItem[]) => void | Promise<void>
): Promise<void> {
  let release!: () => void;
  const previous = uploadLock;
  uploadLock = new Promise<void>(resolve => { release = resolve; });
  if (getIsRunning()) log('⏳ Menunggu antrean upload TikTok global...');
  await previous;
  try {
    await runUploadUnlocked(config, log, onVideoUploaded, onSchedulePlanned);
  } finally {
    release();
  }
}
