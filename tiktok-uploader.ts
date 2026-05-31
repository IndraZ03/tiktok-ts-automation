// tiktok-uploader.ts
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';

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
}

type LogFn = (msg: string) => void;

let activeBrowser: Browser | null = null;
let activeContext: BrowserContext | null = null;
let isRunning = false;

export function getIsRunning() { return isRunning; }

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
  log: LogFn
): Promise<boolean> {
  // ── STEP 1: Navigate to upload page ──
  log('📄 Navigasi ke TikTok Studio Upload...');
  await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('✓ DOM loaded, menunggu halaman upload siap...');

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

  // Strategy A: Direct file input
  try {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 10000 });
    await fileInput.setInputFiles(videoPath);
    log('✓ Video diupload via input[type=file]');
    uploaded = true;
  } catch {
    log('⚠ input[type=file] langsung gagal, coba strategi lain...');
  }

  // Strategy B: Click select button + file chooser
  if (!uploaded) {
    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        page.locator('button').filter({ hasText: /Select video|Select file|Pilih video/i }).first().click(),
      ]);
      await fileChooser.setFiles(videoPath);
      log('✓ Video diupload via file chooser');
      uploaded = true;
    } catch {
      log('⚠ File chooser juga gagal');
    }
  }

  // Strategy C: JS injection
  if (!uploaded) {
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
          log('✓ Video diupload via JS injection');
          uploaded = true;
        }
      }
    } catch (e: any) {
      log('❌ Semua strategi upload gagal: ' + e.message);
      return false;
    }
  }

  if (!uploaded) {
    log('❌ Gagal menemukan elemen upload');
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
    if (config.description) {
      await page.keyboard.type(config.description, { delay: 30 });
      log(`✓ Deskripsi diketik: "${config.description.substring(0, 50)}..."`);
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
      const addBtn = page.locator('button').filter({ hasText: /^Add$/i });
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
        const myShopTab = page.locator('button').filter({ hasText: 'My shop' });
        if (await myShopTab.isVisible({ timeout: 3000 }).catch(() => false)) {
          const showcaseTab = page.locator('button').filter({ hasText: 'Showcase products' });
          await showcaseTab.click({ force: true });
          log('✓ Tab "Showcase products" diklik');
          await page.waitForTimeout(2000);
        }
      } catch {
        log('ℹ Tab My shop tidak terdeteksi');
      }

      // Search product using page-level locator
      const searchInput = page.getByPlaceholder(/Search products|Cari produk/i);
      await searchInput.fill(config.productNameRadio);
      log(`✓ Mencari produk: ${config.productNameRadio}`);

      try {
        await page.locator('.product-search-icon, [class*="product-search-icon"]').click({ force: true, timeout: 5000 });
      } catch {
        await searchInput.press('Enter');
      }
      await waitAndLog(page, log, 3000, 'hasil pencarian');

      // Select radio button — use the proven Python approach:
      // Find radio by name attribute (= product name), then click its parent wrapper
      try {
        log('🔍 Mencari radio produk berdasarkan nama...');
        
        let checked = false;

        // Method 1 (Primary): Find radio by name attribute matching product name, click parent wrapper
        // This is exactly how the Python script does it and it works
        try {
          const radioByName = page.locator(`input[type="radio"][name="${config.productNameRadio}"]`);
          const count = await radioByName.count();
          log(`  Radio dengan name match: ${count} ditemukan`);
          
          if (count > 0) {
            // Click the parent div (TUXRadioStandalone) — same as Python: radio.find_element(By.XPATH, "./..")
            const wrapper = radioByName.first().locator('..');
            
            // Scroll wrapper into view within the dialog (not the page)
            await wrapper.evaluate((el: HTMLElement) => {
              el.scrollIntoView({ block: 'center' });
            });
            await page.waitForTimeout(1000);
            
            // Try clicking the wrapper (standard click)
            try {
              await wrapper.click({ timeout: 3000 });
              log('  Klik wrapper produk (standar)');
            } catch {
              // Fallback: JS click on wrapper
              await wrapper.evaluate((el: HTMLElement) => el.click());
              log('  Klik wrapper produk (JS)');
            }
            await page.waitForTimeout(1000);
            
            checked = await radioByName.first().isChecked().catch(() => false);
            if (checked) {
              log('✓ Radio produk dipilih (Metode 1: name attribute + parent click)');
            } else {
              log('ℹ Metode 1: wrapper diklik tapi radio belum tercentang, mencoba metode lain...');
            }
          }
        } catch (err: any) {
          log(`ℹ Metode 1 gagal: ${err.message}`);
        }

        // Method 2: Click the TUXRadioStandalone div directly
        if (!checked) {
          try {
            const tuxRadio = page.locator('.TUXRadioStandalone').first();
            if (await tuxRadio.count() > 0) {
              await tuxRadio.evaluate((el: HTMLElement) => {
                el.scrollIntoView({ block: 'center' });
              });
              await page.waitForTimeout(500);
              await tuxRadio.click({ force: true, timeout: 3000 });
              await page.waitForTimeout(500);
              
              const firstRadio = page.locator('input[type="radio"]').first();
              checked = await firstRadio.isChecked().catch(() => false);
              if (checked) log('✓ Radio produk dipilih (Metode 2: TUXRadioStandalone click)');
            }
          } catch (err: any) {
            log(`ℹ Metode 2 gagal: ${err.message}`);
          }
        }

        // Method 3: Click the product-tb-row (table row containing the radio)
        if (!checked) {
          try {
            const productRow = page.locator('tr.product-tb-row').first();
            if (await productRow.count() > 0) {
              await productRow.evaluate((el: HTMLElement) => {
                el.scrollIntoView({ block: 'center' });
              });
              await page.waitForTimeout(500);
              await productRow.click({ force: true, timeout: 3000 });
              await page.waitForTimeout(500);
              
              const firstRadio = page.locator('input[type="radio"]').first();
              checked = await firstRadio.isChecked().catch(() => false);
              if (checked) log('✓ Radio produk dipilih (Metode 3: product-tb-row click)');
            }
          } catch (err: any) {
            log(`ℹ Metode 3 gagal: ${err.message}`);
          }
        }

        // Method 4: Click the label associated with the radio (via for attribute)
        if (!checked) {
          try {
            const firstRadio = page.locator('input[type="radio"]').first();
            const radioId = await firstRadio.getAttribute('id');
            if (radioId) {
              const label = page.locator(`label[for="${radioId}"]`);
              if (await label.count() > 0) {
                await label.click({ force: true, timeout: 3000 });
                await page.waitForTimeout(500);
                checked = await firstRadio.isChecked().catch(() => false);
                if (checked) log('✓ Radio produk dipilih (Metode 4: label for click)');
              }
            }
          } catch (err: any) {
            log(`ℹ Metode 4 gagal: ${err.message}`);
          }
        }

        // Method 5: JS click directly on the radio input + dispatchEvent
        if (!checked) {
          try {
            const firstRadio = page.locator('input[type="radio"]').first();
            await firstRadio.evaluate((el: HTMLInputElement) => {
              el.scrollIntoView({ block: 'center' });
            });
            await page.waitForTimeout(500);
            await firstRadio.dispatchEvent('click');
            await page.waitForTimeout(500);
            checked = await firstRadio.isChecked().catch(() => false);
            if (checked) log('✓ Radio produk dipilih (Metode 5: dispatchEvent click)');
          } catch (err: any) {
            log(`ℹ Metode 5 gagal: ${err.message}`);
          }
        }

        if (!checked) {
          throw new Error('Semua metode pemilihan produk gagal — radio tidak tercentang.');
        }
      } catch (e: any) {
        log('⚠ Gagal memilih radio produk: ' + e.message);
      }

      const nextBtnStep2 = page.getByRole('button', { name: /Next|Berikutnya/i });
      await nextBtnStep2.click({ force: true, timeout: 10000 });
      log('✓ Klik Next (step 2)');
      await waitAndLog(page, log, 2000, 'form produk');

      if (config.productTitle) {
        const titleInput = page.getByRole('textbox', { name: /Product name|Nama produk/i });
        await titleInput.fill(config.productTitle);
        log(`✓ Judul produk: ${config.productTitle}`);
      }

      await page.getByRole('button', { name: /^Add$|^Tambah$/i }).click({ force: true });
      log('✓ Produk ditambahkan');
      await waitAndLog(page, log, 2000, 'produk disimpan');
    } catch (e: any) {
      log('❌ Gagal menambahkan produk: ' + e.message);
    }
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 7: Switches (skip branded content etc) ──
  if (!config.skipSwitches) {
    log('🔀 STEP 6: Toggle switches...');
    try {
      const advSettings = page.locator('[data-e2e="advanced_settings_container"]');
      await advSettings.scrollIntoViewIfNeeded();
      await advSettings.click({ timeout: 5000 });
      log('✓ Advanced settings dibuka');
      await page.waitForTimeout(2000);

      try {
        const discloseSwitch = page.locator('[data-e2e="disclose_content_container"] .Switch__content');
        await discloseSwitch.click({ force: true });
        log('✓ Disclose switch diklik');
      } catch { log('⚠ Disclose switch gagal'); }

      try {
        const brandedLabel = page.locator("span:has-text('Branded content')").locator('xpath=preceding-sibling::label');
        await brandedLabel.click({ force: true });
        log('✓ Branded content diklik');
      } catch { log('⚠ Branded content gagal'); }

      try {
        const aigcSwitch = page.locator('[data-e2e="aigc_container"] .Switch__content');
        await aigcSwitch.click({ force: true });
        log('✓ AI-generated diklik');

        // Tunggu apakah modal "Labeling AI-generated content" muncul
        try {
          const turnOnBtn = page.locator('.TUXModal, [class*="modal"], [role="dialog"]')
            .filter({ hasText: /Labeling AI-generated content|AI-generated/i })
            .locator('button')
            .filter({ hasText: /^Turn on$/i });
          
          if (await turnOnBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await turnOnBtn.click();
            log('✓ Pop-up "Labeling AI-generated content" diklik Turn on');
            await page.waitForTimeout(1000);
          }
        } catch (eModal) {
          log('ℹ Tidak ada pop-up labeling AI-generated content atau gagal handle');
        }
      } catch { log('⚠ AI-generated gagal'); }
    } catch (e: any) {
      log('⚠ Switches: ' + e.message);
    }
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 8: Schedule ──
  if (scheduleDate && scheduleTime) {
    log(`📅 STEP 7: Mengatur schedule (${scheduleDate} ${scheduleTime})...`);
    try {
      await page.locator('//*[contains(text(),"When to post")]').waitFor({ timeout: 15000 });

      const scheduleRadio = page.locator("input[name='postSchedule'][value='schedule']").locator('xpath=ancestor::label');
      await scheduleRadio.scrollIntoViewIfNeeded();
      await scheduleRadio.click({ force: true });
      log('✓ Schedule radio dipilih');
      await page.waitForTimeout(2000);

      // Parse time
      const [targetHour, targetMin] = scheduleTime.split(':');
      const roundedMin = String(Math.floor(parseInt(targetMin) / 5) * 5).padStart(2, '0');
      log(`⏰ Setting time: ${targetHour}:${roundedMin}`);

      // Click time input
      const timeInputs = page.locator('.TUXTextInputCore input[readonly]');
      const count = await timeInputs.count();
      for (let i = 0; i < count; i++) {
        const val = await timeInputs.nth(i).getAttribute('value') || '';
        if (val.includes(':')) {
          await timeInputs.nth(i).click({ force: true });
          log('✓ Time picker dibuka');
          break;
        }
      }
      await page.waitForTimeout(2000);

      // Select hour
      try {
        const hourSpan = page.locator(`.tiktok-timepicker-left:text("${targetHour}")`);
        await hourSpan.click();
        log(`✓ Jam ${targetHour} dipilih`);
      } catch {
        log(`⚠ Gagal memilih jam ${targetHour}`);
      }
      await page.waitForTimeout(1000);

      // Select minute
      try {
        const minSpan = page.locator(`.tiktok-timepicker-right:text("${roundedMin}")`);
        await minSpan.click();
        log(`✓ Menit ${roundedMin} dipilih`);
      } catch {
        log(`⚠ Gagal memilih menit ${roundedMin}`);
      }
      await page.waitForTimeout(1000);

      // Close timepicker
      await page.evaluate(() => document.body.click());
      await page.waitForTimeout(1000);

      // Date picker
      const targetDay = String(parseInt(scheduleDate.split('-')[2]));
      log(`📅 Setting date: ${scheduleDate} (day ${targetDay})`);

      for (let i = 0; i < count; i++) {
        const val = await timeInputs.nth(i).getAttribute('value') || '';
        if (val.includes('-') && val.length === 10) {
          await timeInputs.nth(i).click({ force: true });
          log('✓ Date picker dibuka');
          break;
        }
      }
      await page.waitForTimeout(2000);

      // Navigate to correct month if needed (supports English and Indonesian months)
      const monthIdx = new Date(scheduleDate).getMonth(); // 0 to 11
      const englishMonths = [
        'January', 'February', 'March', 'April', 'May', 'June', 
        'July', 'August', 'September', 'October', 'November', 'December'
      ];
      const indonesianMonths = [
        'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 
        'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
      ];
      const targetEnglish = englishMonths[monthIdx];
      const targetIndonesian = indonesianMonths[monthIdx];

      try {
        let attempts = 0;
        while (attempts < 6) {
          const monthTitle = await page.locator('.calendar-wrapper .month-title, [class*="calendar"] [class*="month-title"]').textContent().catch(() => '');
          if (
            monthTitle?.toLowerCase().includes(targetEnglish.toLowerCase()) ||
            monthTitle?.toLowerCase().includes(targetIndonesian.toLowerCase())
          ) {
            break;
          }
          // Target the right-arrow (next month). Sibling after title-wrapper is the next month arrow.
          const nextArrow = page.locator('.calendar-wrapper .title-wrapper ~ .arrow, [class*="calendar"] [class*="title-wrapper"] ~ [class*="arrow"]').first();
          if (await nextArrow.isVisible().catch(() => false)) {
            await nextArrow.click();
            log('✓ Klik arrow bulan berikutnya (CSS sibling)');
          } else {
            // Fallback arrow logic
            const arrows = page.locator('.calendar-wrapper .arrow, [class*="calendar"] [class*="arrow"]');
            const arrowCount = await arrows.count();
            if (arrowCount === 1) {
              await arrows.nth(0).click();
              log('✓ Klik arrow bulan berikutnya (single arrow)');
            } else if (arrowCount >= 2) {
              await arrows.nth(1).click();
              log('✓ Klik arrow bulan berikutnya (arrow index 1)');
            }
          }
          await page.waitForTimeout(1000);
          attempts++;
        }
      } catch { /* ignore */ }

      // Click target day exactly using Regex filter on valid/active days
      try {
        const daySpan = page.locator('.calendar-wrapper span.day.valid, [class*="calendar"] span[class*="day"][class*="valid"]')
          .filter({ hasText: new RegExp('^' + targetDay + '$') })
          .first();
        await daySpan.click();
        log(`✓ Tanggal ${targetDay} dipilih`);
      } catch {
        // Fallback to iterating elements
        const days = page.locator('.calendar-wrapper span[class*="day"], [class*="calendar"] span[class*="day"]');
        const dayCount = await days.count();
        for (let i = 0; i < dayCount; i++) {
          const text = await days.nth(i).textContent();
          const className = await days.nth(i).getAttribute('class') || '';
          if (text?.trim() === targetDay && className.includes('valid')) {
            await days.nth(i).click();
            log(`✓ Tanggal ${targetDay} dipilih (fallback)`);
            break;
          }
        }
      }

      await page.waitForTimeout(2000);
      log('✓ Schedule diatur!');
    } catch (e: any) {
      log('❌ Gagal mengatur schedule: ' + e.message);
    }
  }

  if (!isRunning) { log('⛔ Dibatalkan'); return false; }

  // ── STEP 9: Content Check Lite Switch — turn OFF if ON ──
  log('🔍 STEP 8: Memeriksa Content Check Lite switch...');
  try {
    let contentCheckClicked = false;

    // Strategy 1: Find Switch near "Content check" text
    try {
      const switchEl = page.locator(
        "//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'content check')]/ancestor::div[1]//div[contains(@class,'Switch__content')]"
      ).first();

      if (await switchEl.isVisible({ timeout: 5000 }).catch(() => false)) {
        const cls = await switchEl.getAttribute('class') || '';
        const aria = await switchEl.getAttribute('aria-checked') || '';
        const isOn = cls.includes('checked-true') || aria === 'true';
        log(`  Switch ditemukan: class=${cls.substring(0, 60)}, aria-checked=${aria}, is_on=${isOn}`);

        if (isOn) {
          await switchEl.scrollIntoViewIfNeeded();
          await switchEl.click({ force: true });
          await page.waitForTimeout(1000);
          contentCheckClicked = true;
          log('✓ Content Check Lite dimatikan (Strategy 1)');
        } else {
          contentCheckClicked = true;
          log('ℹ Content Check Lite sudah OFF');
        }
      }
    } catch (e1: any) {
      log(`  Strategy 1 gagal: ${e1.message}`);
    }

    // Strategy 2: Find all ON switches, match with "content check" text
    if (!contentCheckClicked) {
      try {
        const onSwitches = page.locator(
          "div[class*='Switch__content'][class*='checked-true'], div[aria-checked='true'][class*='Switch']"
        );
        const count = await onSwitches.count();
        for (let i = 0; i < count; i++) {
          const sw = onSwitches.nth(i);
          const ancestor = sw.locator('xpath=ancestor::div[position()<=5]');
          const ancestorCount = await ancestor.count();
          for (let j = 0; j < ancestorCount; j++) {
            const txt = (await ancestor.nth(j).textContent().catch(() => '')) || '';
            if (txt.toLowerCase().includes('content check')) {
              await sw.scrollIntoViewIfNeeded();
              await sw.click({ force: true });
              await page.waitForTimeout(1000);
              contentCheckClicked = true;
              log('✓ Content Check Lite dimatikan (Strategy 2)');
              break;
            }
          }
          if (contentCheckClicked) break;
        }
      } catch (e2: any) {
        log(`  Strategy 2 gagal: ${e2.message}`);
      }
    }

    // Strategy 3: JavaScript injection
    if (!contentCheckClicked) {
      try {
        const result = await page.evaluate(() => {
          const spans = document.querySelectorAll('span, div, label, p');
          for (const span of spans) {
            const txt = (span.textContent || '').toLowerCase().trim();
            if (txt.includes('content check')) {
              const parent = (span as HTMLElement).closest('div[class*="jsx-"], div[class*="container"], div[class*="row"], div[class*="setting"]') || span.parentElement;
              if (!parent) continue;
              let switchEl = parent.querySelector('div[class*="Switch__content"], div[role="switch"], input[role="switch"]') as HTMLElement | null;
              if (!switchEl) {
                const siblings = parent.querySelectorAll('div[class*="Switch"]');
                if (siblings.length > 0) switchEl = siblings[0] as HTMLElement;
              }
              if (switchEl) {
                const cls = switchEl.className || '';
                const aria = switchEl.getAttribute('aria-checked') || '';
                const rootEl = switchEl.closest('div[class*="Switch__root"]');
                const rootCls = rootEl ? rootEl.className : '';
                if (cls.includes('checked-true') || rootCls.includes('checked-true') || aria === 'true') {
                  switchEl.scrollIntoView({ block: 'center' });
                  switchEl.click();
                  return 'clicked';
                } else {
                  return 'already_off';
                }
              }
            }
          }
          return 'not_found';
        });

        if (result === 'clicked') {
          await page.waitForTimeout(1000);
          contentCheckClicked = true;
          log('✓ Content Check Lite dimatikan (Strategy 3 - JS)');
        } else if (result === 'already_off') {
          contentCheckClicked = true;
          log('ℹ Content Check Lite sudah OFF (Strategy 3 - JS)');
        } else {
          log('ℹ Content Check Lite tidak ditemukan (Strategy 3 - JS)');
        }
      } catch (e3: any) {
        log(`  Strategy 3 gagal: ${e3.message}`);
      }
    }

    if (!contentCheckClicked) {
      log('ℹ Content Check Lite sudah OFF atau tidak ditemukan');
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
    let clicked = false;
    const schedBtn = page.locator("button[data-e2e='post_video_button']").filter({ hasText: /Schedule/i });
    if (await schedBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await schedBtn.scrollIntoViewIfNeeded();
      await schedBtn.click({ force: true });
      clicked = true;
      log('✓ Tombol Schedule diklik');
    }

    if (!clicked) {
      const fallbackBtn = page.locator('button').filter({ hasText: /Schedule/i }).first();
      if (await fallbackBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await fallbackBtn.click({ force: true });
        clicked = true;
        log('✓ Tombol Schedule diklik (fallback)');
      }
    }

    if (!clicked) {
      const postBtn = page.locator('button').filter({ hasText: /^Post$|^Tayangkan$/i });
      await postBtn.click({ force: true });
      log('✓ Tombol Post diklik');
    }

    await page.waitForTimeout(5000);
    log('🎉 Upload selesai!');
    return true;
  } catch (e: any) {
    log('❌ Gagal klik tombol publish: ' + e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
//  MAIN UPLOAD FUNCTION - MULTI-VIDEO SEQUENTIAL
// ═══════════════════════════════════════════════════════════
export async function runUpload(
  config: UploadConfig,
  log: LogFn,
  onVideoUploaded?: (filename: string) => void
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
  const videosToUpload = videosFromStart.filter(v => !uploadedMarks[v]);

  if (videosToUpload.length === 0) {
    log('ℹ Semua video mulai dari yang dipilih sudah terupload!');
    isRunning = false;
    return;
  }

  // ── Calculate base schedule time ──
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
  log(`🚀 Memulai upload ${videosToUpload.length} video TikTok`);
  log(`📁 Folder: ${config.videoFolder}`);
  log(`🔑 State: ${config.stateFile}`);
  log(`⏰ Schedule pertama: ${config.scheduleDate} ${config.scheduleTime}`);
  log(`⏱ Interval: ${intervalMinutes} menit (${Math.floor(intervalMinutes / 60)}j ${intervalMinutes % 60}m)`);
  log(`📋 Total video: ${videosFromStart.length} | Sudah upload: ${videosFromStart.length - videosToUpload.length} | Akan upload: ${videosToUpload.length}`);
  log('🚀 ═══════════════════════════════════════════');

  try {
    // ── Launch browser ──
    log('🌐 Membuka browser Chrome...');
    activeBrowser = await chromium.launch({
      headless: config.headless ?? false,
      slowMo: 100,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    activeContext = await activeBrowser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
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

      // ── Calculate schedule for this video ──
      const videoSchedule = new Date(baseSchedule.getTime() + uploadIndex * intervalMs);
      const schedDate = `${videoSchedule.getFullYear()}-${String(videoSchedule.getMonth() + 1).padStart(2, '0')}-${String(videoSchedule.getDate()).padStart(2, '0')}`;
      const schedTime = `${String(videoSchedule.getHours()).padStart(2, '0')}:${String(videoSchedule.getMinutes()).padStart(2, '0')}`;

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
          log
        );

        if (success) {
          successCount++;
          if (onVideoUploaded) {
            onVideoUploaded(videoFile);
          }
          log(`✅ Video ${videoFile} berhasil diupload! (${successCount}/${videosToUpload.length})`);
        } else {
          failCount++;
          log(`❌ Video ${videoFile} gagal diupload`);
        }
      } catch (e: any) {
        failCount++;
        log(`❌ Error upload ${videoFile}: ${e.message}`);
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

  } catch (e: any) {
    log('❌ Error fatal: ' + e.message);
  } finally {
    isRunning = false;
    // Don't close browser so user can inspect
    log('✅ Proses selesai. Browser tetap terbuka untuk inspeksi.');
  }
}
