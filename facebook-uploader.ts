// facebook-uploader.ts
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import ffmpegPath from 'ffmpeg-static';

export interface FacebookUploadConfig {
  videoFolder: string;
  startFromVideo: string;
  description: string;
  headless: boolean;
  scheduleDate: string;   // YYYY-MM-DD
  scheduleTime: string;   // HH:mm
  intervalMinutes?: number; // interval in minutes between video schedules
  stateFile: string;      // filename in facebook-states/
  statesDir: string;
}

type LogFn = (msg: string) => void;

let activeBrowser: Browser | null = null;
let activeContext: BrowserContext | null = null;
let isRunning = false;

export function getFacebookIsRunning() { return isRunning; }

export async function stopFacebookUploader() {
  isRunning = false;
  if (activeContext) { try { await activeContext.close(); } catch {} activeContext = null; }
  if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; }
}

async function waitAndLog(page: Page, log: LogFn, ms: number, reason: string) {
  log(`⏳ Menunggu ${ms / 1000}s (${reason})...`);
  await page.waitForTimeout(ms);
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

// Function to format the date into Indonesian/English month based on default value format
function formatFacebookDate(targetDateStr: string, defaultDateVal: string): string {
  // targetDateStr is "YYYY-MM-DD" e.g. "2026-06-03"
  const date = new Date(targetDateStr);
  const day = date.getDate();
  const year = date.getFullYear();
  const monthIdx = date.getMonth(); // 0-based
  
  const idMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  const hasComma = defaultDateVal.includes(',');
  const hasSlash = defaultDateVal.includes('/');
  
  if (hasSlash) {
    const padDay = String(day).padStart(2, '0');
    const padMonth = String(monthIdx + 1).padStart(2, '0');
    return `${padDay}/${padMonth}/${year}`;
  }

  // Detect language of defaultDateVal
  let isIndo = true;
  for (const m of idMonths) {
    if (defaultDateVal.toLowerCase().includes(m.toLowerCase())) {
      isIndo = true;
      break;
    }
  }
  for (const m of enMonths) {
    if (defaultDateVal.toLowerCase().includes(m.toLowerCase())) {
      if (m === 'May' || m === 'Aug' || m === 'Oct' || m === 'Dec') {
        isIndo = false;
      }
      break;
    }
  }

  const months = isIndo ? idMonths : enMonths;
  const monthName = months[monthIdx];

  if (hasComma) {
    return `${monthName} ${day}, ${year}`;
  } else {
    return `${day} ${monthName} ${year}`;
  }
}

async function uploadSingleFacebookVideo(
  page: Page,
  videoPath: string,
  config: FacebookUploadConfig,
  scheduleDate: string,
  scheduleTime: string,
  log: LogFn,
  videoIndex?: number
): Promise<boolean> {
  const contentLibraryUrl = 'https://www.facebook.com/professional_dashboard/content/content_library/?filter=SCHEDULED';
  log(`📄 Menuju ke Facebook Content Library: ${contentLibraryUrl}`);
  await page.goto(contentLibraryUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);

  // Check if redirected to login page or not
  const currentUrl = page.url();
  if (currentUrl.includes('login.php') || currentUrl.includes('facebook.com/login')) {
    log('❌ Browser mendeteksi belum login. Silakan login ke Facebook terlebih dahulu.');
    return false;
  }

  log('✓ Berhasil masuk ke halaman Facebook Content Library');

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 1. Klik dropdown "Buat"
  log('🖱️ Mengklik tombol dropdown "Buat"...');
  const createButton = page.locator('#prodash-create-button, div[role="button"][aria-label="Buat"]').first();
  await createButton.waitFor({ state: 'visible', timeout: 30000 });
  await createButton.click();
  await page.waitForTimeout(2000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 2. Klik yang "Reel"
  log('🖱️ Mengklik opsi menu "Reel"...');
  let reelOption = page.locator('div[role="menuitem"]:visible').filter({ hasText: 'Reel' }).first();
  if (await reelOption.count() === 0) {
    reelOption = page.locator('span:visible').filter({ hasText: 'Reel' }).first();
  }
  await reelOption.waitFor({ state: 'visible', timeout: 20000 });
  try {
    await reelOption.click({ timeout: 5000 });
  } catch (err: any) {
    log(`⚠ Gagal klik Reel normal, mencoba force: ${err.message}`);
    await reelOption.click({ force: true });
  }
  await page.waitForTimeout(5000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 3. Konfirmasi muncul Pop up / dialog
  log('📋 Menunggu pop-up upload/buat Reel muncul...');
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  log('✓ Pop-up upload Reel terdeteksi');

  // 4. Klik Tambahkan Video / set video file
  log(`📤 Memasukkan video ke input file: ${path.basename(videoPath)}`);
  await fileInput.setInputFiles(videoPath);
  await page.waitForTimeout(5000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 5. Konfirmasi kalau video telah terupload dengan ditandai tulisan pratinjau hilang
  // "Unggah video untuk melihat cuplikan di sini."
  log('⏳ Menunggu proses upload video selesai (menunggu pratinjau siap)...');
  try {
    const uploadText = page.locator('text="Unggah video untuk melihat cuplikan di sini."').first();
    await uploadText.waitFor({ state: 'hidden', timeout: 300000 }); // timeout 5 menit
    log('✓ Video selesai diupload (teks pratinjau hilang)');
  } catch (err: any) {
    log('⚠ Menunggu teks pratinjau hilang timeout, mencoba melanjutkan...');
  }
  await page.waitForTimeout(3000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 6. Klik Berikutnya
  log('🖱️ Mengklik tombol "Berikutnya"...');
  let nextButton = page.locator('div[role="button"][aria-label="Berikutnya"]:visible').first();
  if (await nextButton.count() === 0) {
    nextButton = page.locator('div[role="button"]:visible').filter({ hasText: 'Berikutnya' }).first();
  }
  if (await nextButton.count() === 0) {
    nextButton = page.locator('span:visible').filter({ hasText: 'Berikutnya' }).first();
  }
  await nextButton.waitFor({ state: 'visible', timeout: 30000 });
  try {
    await nextButton.click({ timeout: 5000 });
  } catch (err: any) {
    log(`⚠ Gagal klik Berikutnya normal, mencoba force: ${err.message}`);
    await nextButton.click({ force: true });
  }
  await page.waitForTimeout(3000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 7. Isi deskripsi reel sesuai yang diisi
  log('📝 Mengisi deskripsi Reel...');
  try {
    const descBox = page.locator('div[role="textbox"][aria-placeholder*="Deskripsikan"], div[contenteditable="true"]').first();
    await descBox.waitFor({ state: 'visible', timeout: 20000 });
    await descBox.focus();
    const prefix = videoIndex ? `[${videoIndex}] ` : '';
    const finalDesc = `${prefix}${config.description || ''}`;
    await descBox.fill(finalDesc);
    log(`✓ Deskripsi terisi: "${finalDesc}"`);
  } catch (err: any) {
    log(`⚠ Gagal mengisi deskripsi otomatis: ${err.message}`);
  }
  await page.waitForTimeout(2000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 8. Klik Berikutnya lagi
  log('🖱️ Mengklik tombol "Berikutnya" (tahap 2)...');
  let nextButton2 = page.locator('div[role="button"][aria-label="Berikutnya"]:visible').first();
  if (await nextButton2.count() === 0) {
    nextButton2 = page.locator('div[role="button"]:visible').filter({ hasText: 'Berikutnya' }).first();
  }
  if (await nextButton2.count() === 0) {
    nextButton2 = page.locator('span:visible').filter({ hasText: 'Berikutnya' }).first();
  }
  await nextButton2.waitFor({ state: 'visible', timeout: 30000 });
  try {
    await nextButton2.click({ timeout: 5000 });
  } catch (err: any) {
    log(`⚠ Gagal klik Berikutnya 2 normal, mencoba force: ${err.message}`);
    await nextButton2.click({ force: true });
  }
  await page.waitForTimeout(3000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 9. Klik opsi penjadwalan
  log('🖱️ Membuka opsi penjadwalan...');
  let schedulingOpt = page.locator('span:visible').filter({ hasText: 'Opsi penjadwalan' }).first();
  if (await schedulingOpt.count() === 0) {
    schedulingOpt = page.locator('text=Opsi penjadwalan:visible').first();
  }
  await schedulingOpt.waitFor({ state: 'visible', timeout: 30000 });
  try {
    await schedulingOpt.click({ timeout: 5000 });
  } catch (err: any) {
    log(`⚠ Gagal klik Opsi Penjadwalan normal, mencoba force: ${err.message}`);
    await schedulingOpt.click({ force: true });
  }
  await page.waitForTimeout(3000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 10. Ubah value Tanggal
  log('📅 Mengatur tanggal schedule...');
  try {
    const dateInput = page.locator('label:has-text("Tanggal") input, div:has-text("Tanggal") > input, label:has-text("Tanggal") >> input').first();
    await dateInput.waitFor({ state: 'visible', timeout: 20000 });
    
    // Dapatkan default value untuk mendeteksi bahasa
    const defaultDateVal = await dateInput.inputValue();
    log(`ℹ Format default tanggal terdeteksi: "${defaultDateVal}"`);
    
    const formattedDate = formatFacebookDate(scheduleDate, defaultDateVal);
    log(`📅 Mengisi tanggal: "${formattedDate}"`);
    
    await dateInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await dateInput.fill(formattedDate);
    await page.keyboard.press('Enter');
  } catch (err: any) {
    log(`❌ Gagal mengatur tanggal: ${err.message}`);
    return false;
  }
  await page.waitForTimeout(2000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 11. Ubah value Waktu
  log('⏰ Mengatur waktu schedule...');
  try {
    const timeInput = page.locator('label:has-text("Waktu") input, div:has-text("Waktu") > input, label:has-text("Waktu") >> input').first();
    await timeInput.waitFor({ state: 'visible', timeout: 20000 });
    
    log(`⏰ Mengisi waktu: "${scheduleTime}"`);
    await timeInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await timeInput.fill(scheduleTime);
    await page.keyboard.press('Enter');
  } catch (err: any) {
    log(`❌ Gagal mengatur waktu: ${err.message}`);
    return false;
  }
  await page.waitForTimeout(2000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 12. Klik Jadwalkan untuk Nanti
  log('🖱️ Memilih tombol "Jadwalkan untuk nanti"...');
  let scheduleLaterBtn = page.locator('div[role="button"][aria-label="Jadwalkan untuk nanti"]:visible').first();
  if (await scheduleLaterBtn.count() === 0) {
    scheduleLaterBtn = page.locator('div[role="button"]:visible').filter({ hasText: 'Jadwalkan untuk nanti' }).first();
  }
  await scheduleLaterBtn.waitFor({ state: 'visible', timeout: 20000 });
  try {
    await scheduleLaterBtn.click({ timeout: 5000 });
  } catch (err: any) {
    log(`⚠ Gagal klik Jadwalkan untuk nanti normal, mencoba force: ${err.message}`);
    await scheduleLaterBtn.click({ force: true });
  }
  await page.waitForTimeout(3000);

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // 13. Klik Jadwalkan di pop up utama
  log('🎬 Mengklik tombol utama "Jadwalkan"...');
  let scheduleBtn = page.locator('div[role="button"][aria-label="Jadwalkan"]:visible').first();
  if (await scheduleBtn.count() === 0) {
    scheduleBtn = page.locator('div[role="button"]:visible').filter({ hasText: 'Jadwalkan' }).first();
  }
  if (await scheduleBtn.count() === 0) {
    scheduleBtn = page.locator('span:visible').filter({ hasText: 'Jadwalkan' }).first();
  }
  await scheduleBtn.waitFor({ state: 'visible', timeout: 30000 });
  
  try {
    await scheduleBtn.click({ timeout: 5000 });
    log('✓ Tombol utama "Jadwalkan" diklik (normal)');
  } catch (err: any) {
    log(`⚠ Gagal klik Jadwalkan normal, mencoba force: ${err.message}`);
    try {
      await scheduleBtn.click({ force: true, timeout: 5000 });
      log('✓ Tombol utama "Jadwalkan" diklik (force)');
    } catch (err2: any) {
      log(`⚠ Gagal force click Jadwalkan, mencoba JS click: ${err2.message}`);
      await scheduleBtn.evaluate((el: HTMLElement) => el.click());
      log('✓ Tombol utama "Jadwalkan" diklik (JS)');
    }
  }
  
  // 14. Tunggu modal tertutup
  log('⏳ Menunggu proses penjadwalan Facebook selesai...');
  await page.waitForSelector('div[role="button"][aria-label="Jadwalkan"]:visible', { state: 'hidden', timeout: 150000 });
  log('🎉 Berhasil menjadwalkan Reel!');
  
  await page.waitForTimeout(5000);
  return true;
}

export async function runFacebookUpload(
  config: FacebookUploadConfig,
  log: LogFn,
  onVideoUploaded?: (filename: string) => void
): Promise<void> {
  isRunning = true;

  // Validate state file
  const stateFilePath = path.join(config.statesDir, config.stateFile);
  if (!fs.existsSync(stateFilePath)) {
    log('❌ State file tidak ditemukan: ' + stateFilePath);
    isRunning = false;
    return;
  }

  // Get all videos in the folder
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

  // Find start index
  const startIdx = allVideos.indexOf(config.startFromVideo);
  if (startIdx === -1) {
    log('❌ Video tidak ditemukan dalam folder: ' + config.startFromVideo);
    isRunning = false;
    return;
  }

  const videosFromStart = allVideos.slice(startIdx);

  // Read uploaded marks
  const marksFile = path.join(config.videoFolder, '.uploaded.json');
  let uploadedMarks: Record<string, boolean> = {};
  try { uploadedMarks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const videosToUpload = videosFromStart.filter(v => !uploadedMarks[v]);

  if (videosToUpload.length === 0) {
    log('ℹ Semua video mulai dari yang dipilih sudah terupload/terjadwal!');
    isRunning = false;
    return;
  }

  const intervalMinutes = config.intervalMinutes || 60;
  const intervalMs = intervalMinutes * 60 * 1000;
  let baseSchedule: Date;
  try {
    baseSchedule = new Date(`${config.scheduleDate}T${config.scheduleTime}:00`);
    if (isNaN(baseSchedule.getTime())) throw new Error('Invalid date');
  } catch {
    log('⚠ Schedule date/time tidak valid, menggunakan waktu sekarang + 1 jam');
    baseSchedule = new Date(Date.now() + 3600000);
  }

  log('🚀 ═══════════════════════════════════════════');
  log(`🚀 Memulai upload ${videosToUpload.length} video Facebook Reels`);
  log(`📁 Folder: ${config.videoFolder}`);
  log(`🔑 State: ${config.stateFile}`);
  log(`⏰ Schedule pertama: ${config.scheduleDate} ${config.scheduleTime}`);
  log(`⏱ Interval: ${intervalMinutes} menit`);
  log('🚀 ═══════════════════════════════════════════');

  try {
    log('🌐 Membuka browser Chrome...');
    activeBrowser = await chromium.launch({
      headless: config.headless !== false,
      slowMo: 100,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    activeContext = await activeBrowser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: { 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
      storageState: stateFilePath,
    });

    const page = await activeContext.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let uploadIndex = 0;
    let successCount = 0;
    let failCount = 0;

    for (const videoFile of videosToUpload) {
      if (!isRunning) {
        log('⛔ Upload dihentikan oleh user');
        break;
      }

      const videoSchedule = new Date(baseSchedule.getTime() + uploadIndex * intervalMs);
      const schedDate = `${videoSchedule.getFullYear()}-${String(videoSchedule.getMonth() + 1).padStart(2, '0')}-${String(videoSchedule.getDate()).padStart(2, '0')}`;
      const schedTime = `${String(videoSchedule.getHours()).padStart(2, '0')}:${String(videoSchedule.getMinutes()).padStart(2, '0')}`;

      log('');
      log(`════════════════════════════════════════`);
      log(`📹 Video ${uploadIndex + 1}/${videosToUpload.length}: ${videoFile}`);
      log(`📅 Schedule: ${schedDate} ${schedTime}`);
      log(`════════════════════════════════════════`);

      const videoPath = path.join(config.videoFolder, videoFile);
      if (!fs.existsSync(videoPath)) {
        log(`⚠ File video tidak ditemukan: ${videoPath}, skip...`);
        failCount++;
        uploadIndex++;
        continue;
      }

      const isValid = await isVideoValid(videoPath, log);
      if (!isValid) {
        log(`❌ File video rusak/corrupt: ${videoFile}, skip...`);
        failCount++;
        uploadIndex++;
        continue;
      }

      try {
        const success = await uploadSingleFacebookVideo(
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
          log(`✅ Video ${videoFile} berhasil terjadwal di Facebook! (${successCount}/${videosToUpload.length})`);
        } else {
          failCount++;
          log(`❌ Video ${videoFile} gagal diupload`);
        }
      } catch (e: any) {
        failCount++;
        log(`❌ Error upload ${videoFile}: ${e.message}`);
      }

      uploadIndex++;

      if (uploadIndex < videosToUpload.length && isRunning) {
        log('⏳ Menunggu 15 detik sebelum video berikutnya...');
        await page.waitForTimeout(15000);
      }
    }

    log('');
    log('═══════════════════════════════════════════');
    log(`📊 RINGKASAN: ${successCount} berhasil, ${failCount} gagal dari ${videosToUpload.length} video`);
    log('═══════════════════════════════════════════');

  } catch (e: any) {
    log('❌ Error fatal: ' + e.message);
  } finally {
    isRunning = false;
    log('✅ Proses selesai. Browser tetap ditutup.');
    if (activeBrowser) {
      await activeBrowser.close();
      activeBrowser = null;
      activeContext = null;
    }
  }
}
