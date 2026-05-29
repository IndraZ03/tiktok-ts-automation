// tiktok-uploader.ts
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
let activeBrowser = null;
let activeContext = null;
let isRunning = false;
export function getIsRunning() { return isRunning; }
export async function stopUploader() {
    isRunning = false;
    if (activeContext) {
        try {
            await activeContext.close();
        }
        catch { }
        activeContext = null;
    }
    if (activeBrowser) {
        try {
            await activeBrowser.close();
        }
        catch { }
        activeBrowser = null;
    }
}
async function safeClick(page, locator, log, label, timeout = 5000) {
    try {
        await locator.click({ timeout });
        log(`✓ ${label}`);
        return true;
    }
    catch {
        log(`⚠ ${label} - tidak ditemukan/gagal`);
        return false;
    }
}
async function waitAndLog(page, log, ms, reason) {
    log(`⏳ Menunggu ${ms / 1000}s (${reason})...`);
    await page.waitForTimeout(ms);
}
export async function runUpload(config, log) {
    isRunning = true;
    const stateFilePath = path.join(config.statesDir, config.stateFile);
    if (!fs.existsSync(stateFilePath)) {
        log('❌ State file tidak ditemukan: ' + stateFilePath);
        isRunning = false;
        return;
    }
    const videoPath = path.join(config.videoFolder, config.startFromVideo);
    if (!fs.existsSync(videoPath)) {
        log('❌ Video tidak ditemukan: ' + videoPath);
        isRunning = false;
        return;
    }
    log('🚀 Memulai upload TikTok...');
    log(`📁 Video: ${config.startFromVideo}`);
    log(`🔑 State: ${config.stateFile}`);
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
        // ── STEP 1: Navigate to upload page ──
        log('📄 Navigasi ke TikTok Studio Upload...');
        await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 60000 });
        log('✓ DOM loaded, menunggu halaman upload siap...');
        // Wait for the actual upload UI to appear (file input or upload button)
        try {
            await page.locator('input[type="file"], button[data-e2e="select_video_button"], button[aria-label="Select video"]')
                .first()
                .waitFor({ state: 'attached', timeout: 30000 });
            log('✓ Halaman upload siap!');
        }
        catch {
            log('⚠ Elemen upload belum muncul, menunggu tambahan 10s...');
            await page.waitForTimeout(10000);
        }
        await waitAndLog(page, log, 2000, 'stabilisasi halaman');
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 2: Upload video file ──
        log('📤 STEP 1: Upload video...');
        // Try multiple strategies to find file input
        let uploaded = false;
        // Strategy A: Direct file input
        try {
            const fileInput = page.locator('input[type="file"]').first();
            await fileInput.waitFor({ state: 'attached', timeout: 10000 });
            await fileInput.setInputFiles(videoPath);
            log('✓ Video diupload via input[type=file]');
            uploaded = true;
        }
        catch {
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
            }
            catch {
                log('⚠ File chooser juga gagal');
            }
        }
        // Strategy C: JS injection
        if (!uploaded) {
            try {
                const inputHandle = await page.evaluateHandle(() => {
                    const inputs = document.querySelectorAll('input[type="file"]');
                    for (const inp of inputs) {
                        if (inp.accept?.includes('video'))
                            return inp;
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
            }
            catch (e) {
                log('❌ Semua strategi upload gagal: ' + e.message);
                isRunning = false;
                return;
            }
        }
        if (!uploaded) {
            log('❌ Gagal menemukan elemen upload');
            isRunning = false;
            return;
        }
        // Wait for upload to process
        log('⏳ Menunggu video diproses TikTok...');
        await waitAndLog(page, log, 5000, 'video processing');
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 3: Handle copyright / content check popup ──
        log('🔍 STEP 2: Periksa popup content check...');
        await waitAndLog(page, log, 2000, 'menunggu popup muncul');
        try {
            // Detect the "Pemeriksaan konten ringan" / "Content check lite" checkbox
            // It appears as a label with a checkbox inside, data-checked="true" by default
            const liteCheckbox = page.locator('label').filter({ hasText: /Pemeriksaan konten ringan|Content check lite/i }).locator('[data-checked]');
            const liteLabel = page.locator('label').filter({ hasText: /Pemeriksaan konten ringan|Content check lite/i });
            // Wait up to 5s for the checkbox to appear
            let checkboxFound = false;
            try {
                await liteLabel.waitFor({ state: 'visible', timeout: 5000 });
                checkboxFound = true;
                log('✓ Checkbox "Content check lite" terdeteksi');
            }
            catch {
                log('ℹ Checkbox content check lite tidak muncul (mungkin tidak ada popup)');
            }
            if (checkboxFound) {
                // Check if data-checked="true", if so click to uncheck
                const checkedState = await liteCheckbox.getAttribute('data-checked').catch(() => null);
                log(`📋 Status checkbox: data-checked="${checkedState}"`);
                if (checkedState === 'true') {
                    // Click the checkbox/label to uncheck it
                    await liteLabel.click();
                    await page.waitForTimeout(500);
                    // Verify it's now unchecked
                    const newState = await liteCheckbox.getAttribute('data-checked').catch(() => null);
                    log(`✓ Checkbox di-uncheck → data-checked="${newState}"`);
                    // If still checked, try clicking the icon wrapper directly
                    if (newState === 'true') {
                        log('⚠ Masih checked, coba klik icon wrapper...');
                        const iconWrapper = liteLabel.locator('.Checkbox__iconWrapper');
                        await iconWrapper.click({ force: true });
                        await page.waitForTimeout(500);
                        const finalState = await liteCheckbox.getAttribute('data-checked').catch(() => null);
                        log(`✓ Retry → data-checked="${finalState}"`);
                    }
                }
                else {
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
                }
                catch {
                    log('⚠ Tombol Turn On / Aktifkan tidak ditemukan');
                }
            }
        }
        catch (e) {
            log('⚠ Error di content check popup: ' + e.message);
        }
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 4: Handle "Got it" / "Mengerti" popup ──
        log('🔍 STEP 3: Periksa popup "Mengerti" / "Got it"...');
        try {
            const gotItBtn = page.locator('button, div[role="button"]').filter({ hasText: /^Got it$|^Mengerti$/i });
            await gotItBtn.first().waitFor({ state: 'visible', timeout: 5000 });
            await gotItBtn.first().click();
            log('✓ Popup "Got it / Mengerti" ditutup');
            await page.waitForTimeout(1000);
        }
        catch {
            log('ℹ Tidak ada popup Got it / Mengerti');
        }
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
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
        }
        catch (e) {
            log('❌ Gagal mengisi deskripsi: ' + e.message);
        }
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 6: Add Product ──
        if (config.addProduct && config.productNameRadio) {
            log('🛒 STEP 5: Menambahkan produk...');
            try {
                // Click Add button
                const addBtn = page.locator('button').filter({ hasText: /^Add$/i });
                await addBtn.click({ timeout: 10000 });
                log('✓ Tombol Add diklik');
                await waitAndLog(page, log, 2000, 'dialog produk');
                // Wait for dialog
                const dialog = page.getByRole('dialog', { name: /Add link|Tambah tautan/i });
                await dialog.waitFor({ state: 'visible', timeout: 10000 });
                log('✓ Dialog produk terbuka');
                // Click Next
                await page.getByRole('button', { name: /Next|Berikutnya/i }).click();
                log('✓ Klik Next');
                await waitAndLog(page, log, 2000, 'tab produk');
                // Check for "My shop" tab → click "Showcase products"
                try {
                    const myShopTab = page.locator('button').filter({ hasText: 'My shop' });
                    if (await myShopTab.isVisible({ timeout: 3000 }).catch(() => false)) {
                        const showcaseTab = page.locator('button').filter({ hasText: 'Showcase products' });
                        await showcaseTab.click();
                        log('✓ Tab "Showcase products" diklik');
                        await page.waitForTimeout(2000);
                    }
                }
                catch {
                    log('ℹ Tab My shop tidak terdeteksi');
                }
                // Search product
                const searchInput = page.getByPlaceholder(/Search products|Cari produk/i);
                await searchInput.fill(config.productNameRadio);
                log(`✓ Mencari produk: ${config.productNameRadio}`);
                // Click search icon
                try {
                    await page.locator('.product-search-icon, [class*="product-search-icon"]').click({ timeout: 5000 });
                }
                catch {
                    await page.keyboard.press('Enter');
                }
                await waitAndLog(page, log, 3000, 'hasil pencarian');
                // Select radio button matching product
                try {
                    const radio = page.locator(`input[type="radio"][name="${config.productNameRadio}"]`);
                    if (await radio.isVisible({ timeout: 5000 }).catch(() => false)) {
                        await radio.locator('..').click();
                    }
                    else {
                        // Fallback: click first radio
                        await page.locator('input[type="radio"]').first().locator('..').click();
                    }
                    log('✓ Produk dipilih');
                }
                catch {
                    log('⚠ Gagal memilih radio produk');
                }
                // Click Next again
                await page.getByRole('button', { name: /Next|Berikutnya/i }).click();
                log('✓ Klik Next (step 2)');
                await waitAndLog(page, log, 2000, 'form produk');
                // Fill product title
                if (config.productTitle) {
                    const titleInput = page.getByRole('textbox', { name: /Product name|Nama produk/i });
                    await titleInput.fill(config.productTitle);
                    log(`✓ Judul produk: ${config.productTitle}`);
                }
                // Click Add/Tambah
                await page.getByRole('button', { name: /^Add$|^Tambah$/i }).click();
                log('✓ Produk ditambahkan');
                await waitAndLog(page, log, 2000, 'produk disimpan');
            }
            catch (e) {
                log('❌ Gagal menambahkan produk: ' + e.message);
            }
        }
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 7: Switches (skip branded content etc) ──
        if (!config.skipSwitches) {
            log('🔀 STEP 6: Toggle switches...');
            try {
                // Show more / Advanced settings
                const advSettings = page.locator('[data-e2e="advanced_settings_container"]');
                await advSettings.scrollIntoViewIfNeeded();
                await advSettings.click({ timeout: 5000 });
                log('✓ Advanced settings dibuka');
                await page.waitForTimeout(2000);
                // Disclose content switch
                try {
                    const discloseSwitch = page.locator('[data-e2e="disclose_content_container"] .Switch__content');
                    await discloseSwitch.click({ force: true });
                    log('✓ Disclose switch diklik');
                }
                catch {
                    log('⚠ Disclose switch gagal');
                }
                // Branded content
                try {
                    const brandedLabel = page.locator("span:has-text('Branded content')").locator('xpath=preceding-sibling::label');
                    await brandedLabel.click({ force: true });
                    log('✓ Branded content diklik');
                }
                catch {
                    log('⚠ Branded content gagal');
                }
                // AI-generated
                try {
                    const aigcSwitch = page.locator('[data-e2e="aigc_container"] .Switch__content');
                    await aigcSwitch.click({ force: true });
                    log('✓ AI-generated diklik');
                }
                catch {
                    log('⚠ AI-generated gagal');
                }
            }
            catch (e) {
                log('⚠ Switches: ' + e.message);
            }
        }
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 8: Schedule ──
        if (config.scheduleDate && config.scheduleTime) {
            log('📅 STEP 7: Mengatur schedule...');
            try {
                // Wait for "When to post"
                await page.locator('//*[contains(text(),"When to post")]').waitFor({ timeout: 15000 });
                // Click Schedule radio
                const scheduleRadio = page.locator("input[name='postSchedule'][value='schedule']").locator('xpath=ancestor::label');
                await scheduleRadio.scrollIntoViewIfNeeded();
                await scheduleRadio.click({ force: true });
                log('✓ Schedule radio dipilih');
                await page.waitForTimeout(2000);
                // Parse time
                const [targetHour, targetMin] = config.scheduleTime.split(':');
                const roundedMin = String(Math.floor(parseInt(targetMin) / 5) * 5).padStart(2, '0');
                log(`⏰ Setting time: ${targetHour}:${roundedMin}`);
                // Click time input
                const timeInput = page.locator('.TUXTextInputCore input[readonly]').filter({ hasText: /:/ });
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
                }
                catch {
                    log(`⚠ Gagal memilih jam ${targetHour}`);
                }
                await page.waitForTimeout(1000);
                // Select minute
                try {
                    const minSpan = page.locator(`.tiktok-timepicker-right:text("${roundedMin}")`);
                    await minSpan.click();
                    log(`✓ Menit ${roundedMin} dipilih`);
                }
                catch {
                    log(`⚠ Gagal memilih menit ${roundedMin}`);
                }
                await page.waitForTimeout(1000);
                // Close timepicker
                await page.evaluate(() => document.body.click());
                await page.waitForTimeout(1000);
                // Date picker
                const targetDay = String(parseInt(config.scheduleDate.split('-')[2]));
                log(`📅 Setting date: ${config.scheduleDate} (day ${targetDay})`);
                // Find and click date input
                for (let i = 0; i < count; i++) {
                    const val = await timeInputs.nth(i).getAttribute('value') || '';
                    if (val.includes('-') && val.length === 10) {
                        await timeInputs.nth(i).click({ force: true });
                        log('✓ Date picker dibuka');
                        break;
                    }
                }
                await page.waitForTimeout(2000);
                // Navigate to correct month if needed
                const targetMonth = new Date(config.scheduleDate).toLocaleString('en-US', { month: 'long' });
                try {
                    let attempts = 0;
                    while (attempts < 6) {
                        const monthTitle = await page.locator('.calendar-wrapper .month-title, [class*="calendar"] [class*="month-title"]').textContent().catch(() => '');
                        if (monthTitle?.includes(targetMonth))
                            break;
                        const arrows = page.locator('.calendar-wrapper .arrow, [class*="calendar"] [class*="arrow"]');
                        const arrowCount = await arrows.count();
                        if (arrowCount >= 2)
                            await arrows.nth(1).click();
                        await page.waitForTimeout(1000);
                        attempts++;
                    }
                }
                catch { /* ignore */ }
                // Click target day
                try {
                    const daySpan = page.locator(`.calendar-wrapper span.day.valid:text("${targetDay}"), [class*="calendar"] span[class*="day"][class*="valid"]:text("${targetDay}")`).first();
                    await daySpan.click();
                    log(`✓ Tanggal ${targetDay} dipilih`);
                }
                catch {
                    // Fallback
                    const days = page.locator('.calendar-wrapper span[class*="day"], [class*="calendar"] span[class*="day"]');
                    const dayCount = await days.count();
                    for (let i = 0; i < dayCount; i++) {
                        const text = await days.nth(i).textContent();
                        if (text?.trim() === targetDay) {
                            await days.nth(i).click();
                            log(`✓ Tanggal ${targetDay} dipilih (fallback)`);
                            break;
                        }
                    }
                }
                await page.waitForTimeout(2000);
                log('✓ Schedule diatur!');
            }
            catch (e) {
                log('❌ Gagal mengatur schedule: ' + e.message);
            }
        }
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 9: Content Check Lite Switch — turn OFF if ON ──
        log('🔍 STEP 8: Memeriksa Content Check Lite switch...');
        try {
            let contentCheckClicked = false;
            // Strategy 1: Find Switch near "Content check" text
            try {
                const switchEl = page.locator("//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'content check')]/ancestor::div[1]//div[contains(@class,'Switch__content')]").first();
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
                    }
                    else {
                        contentCheckClicked = true;
                        log('ℹ Content Check Lite sudah OFF');
                    }
                }
            }
            catch (e1) {
                log(`  Strategy 1 gagal: ${e1.message}`);
            }
            // Strategy 2: Find all ON switches, match with "content check" text
            if (!contentCheckClicked) {
                try {
                    const onSwitches = page.locator("div[class*='Switch__content'][class*='checked-true'], div[aria-checked='true'][class*='Switch']");
                    const count = await onSwitches.count();
                    for (let i = 0; i < count; i++) {
                        const sw = onSwitches.nth(i);
                        // Check if ancestor contains "content check" text
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
                        if (contentCheckClicked)
                            break;
                    }
                }
                catch (e2) {
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
                                const parent = span.closest('div[class*="jsx-"], div[class*="container"], div[class*="row"], div[class*="setting"]') || span.parentElement;
                                if (!parent)
                                    continue;
                                let switchEl = parent.querySelector('div[class*="Switch__content"], div[role="switch"], input[role="switch"]');
                                if (!switchEl) {
                                    const siblings = parent.querySelectorAll('div[class*="Switch"]');
                                    if (siblings.length > 0)
                                        switchEl = siblings[0];
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
                                    }
                                    else {
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
                    }
                    else if (result === 'already_off') {
                        contentCheckClicked = true;
                        log('ℹ Content Check Lite sudah OFF (Strategy 3 - JS)');
                    }
                    else {
                        log('ℹ Content Check Lite tidak ditemukan (Strategy 3 - JS)');
                    }
                }
                catch (e3) {
                    log(`  Strategy 3 gagal: ${e3.message}`);
                }
            }
            if (!contentCheckClicked) {
                log('ℹ Content Check Lite sudah OFF atau tidak ditemukan');
            }
        }
        catch (e) {
            log(`⚠ Content Check Lite: ${e.message}`);
        }
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 10: Verify video uploaded before posting ──
        log('🔍 STEP 9: Memeriksa apakah video sudah terupload...');
        try {
            // Look for "Uploaded" or "Diunggah" text in the page
            const uploadedIndicator = page.locator('span').filter({ hasText: /Uploaded|Diunggah/i }).first();
            await uploadedIndicator.waitFor({ state: 'visible', timeout: 120000 });
            const uploadText = await uploadedIndicator.textContent();
            log(`✓ Video sudah terupload: ${uploadText?.trim()}`);
        }
        catch {
            log('⚠ Indikator upload tidak terdeteksi, melanjutkan...');
        }
        if (!isRunning) {
            log('⛔ Dibatalkan');
            return;
        }
        // ── STEP 11: Click Schedule/Post button ──
        log('🎬 STEP 10: Klik tombol Schedule/Post...');
        try {
            // Try Schedule button first
            let clicked = false;
            const schedBtn = page.locator("button[data-e2e='post_video_button']").filter({ hasText: /Schedule/i });
            if (await schedBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await schedBtn.scrollIntoViewIfNeeded();
                await schedBtn.click({ force: true });
                clicked = true;
                log('✓ Tombol Schedule diklik');
            }
            if (!clicked) {
                // Fallback: any button with Schedule text
                const fallbackBtn = page.locator('button').filter({ hasText: /Schedule/i }).first();
                if (await fallbackBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await fallbackBtn.click({ force: true });
                    clicked = true;
                    log('✓ Tombol Schedule diklik (fallback)');
                }
            }
            if (!clicked) {
                // Last resort: Post button
                const postBtn = page.locator('button').filter({ hasText: /^Post$|^Tayangkan$/i });
                await postBtn.click({ force: true });
                log('✓ Tombol Post diklik');
            }
            await page.waitForTimeout(5000);
            log('🎉 Upload selesai!');
        }
        catch (e) {
            log('❌ Gagal klik tombol publish: ' + e.message);
        }
    }
    catch (e) {
        log('❌ Error fatal: ' + e.message);
    }
    finally {
        isRunning = false;
        // Don't close browser so user can inspect
        log('✅ Proses selesai. Browser tetap terbuka untuk inspeksi.');
    }
}
