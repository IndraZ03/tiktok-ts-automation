// tiktok-uploader.ts
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { exec } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
let activeBrowser = null;
let activeContext = null;
let isRunning = false;
export function getIsRunning() { return isRunning; }
const RANDOM_INTERVAL_OFFSET_MAX_MINUTES = 40;
const RANDOM_INTERVAL_OFFSET_STEP_MINUTES = 5;
function getRandomIntervalOffsetMinutes() {
    const steps = Math.floor(RANDOM_INTERVAL_OFFSET_MAX_MINUTES / RANDOM_INTERVAL_OFFSET_STEP_MINUTES);
    return (Math.floor(Math.random() * (steps * 2 + 1)) - steps) * RANDOM_INTERVAL_OFFSET_STEP_MINUTES;
}
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
async function isVideoValid(videoPath, log) {
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
    }
    catch (err) {
        log(`❌ Verifikasi FFmpeg gagal untuk ${path.basename(videoPath)}: ${err.message}`);
        return false;
    }
}
async function detectUploadError(page, log) {
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
        }
        catch {
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
    }
    catch {
        // ignore
    }
    return null;
}
// ═══════════════════════════════════════════════════════════
//  UPLOAD SINGLE VIDEO
//  Returns true if the video was successfully posted/scheduled
// ═══════════════════════════════════════════════════════════
async function uploadSingleVideo(page, videoPath, config, scheduleDate, scheduleTime, log, videoIndex) {
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
    }
    catch {
        log('⚠ Elemen upload belum muncul, menunggu tambahan 10s...');
        await page.waitForTimeout(10000);
    }
    await waitAndLog(page, log, 2000, 'stabilisasi halaman');
    if (!isRunning) {
        log('⛔ Dibatalkan');
        return false;
    }
    // ── STEP 2: Upload video file ──
    log('📤 STEP 1: Upload video...');
    let uploaded = false;
    let hasCriticalUploadError = false;
    let detectedErrorMsg = '';
    // Helper to verify if upload editor has appeared (meaning upload started successfully)
    const verifyUploadStarted = async () => {
        log('⏳ Memverifikasi transisi ke halaman edit (layar detail)...');
        const startTime = Date.now();
        const timeout = 15000;
        while (Date.now() - startTime < timeout) {
            if (!isRunning)
                return false;
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
        }
        else {
            log('⚠ input[type=file] diisi tapi tidak ada transisi ke halaman edit');
        }
    }
    catch {
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
            }
            else {
                log('⚠ File chooser digunakan tapi tidak ada transisi ke halaman edit');
            }
        }
        catch {
            log('⚠ File chooser juga gagal');
        }
    }
    // Strategy C: JS injection
    if (!uploaded && !hasCriticalUploadError) {
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
                    if (await verifyUploadStarted()) {
                        log('✓ Video diupload via JS injection (Terverifikasi)');
                        uploaded = true;
                    }
                    else {
                        log('⚠ JS injection digunakan tapi tidak ada transisi ke halaman edit');
                    }
                }
            }
        }
        catch (e) {
            log('❌ Semua strategi upload gagal: ' + e.message);
            return false;
        }
    }
    if (!uploaded) {
        if (hasCriticalUploadError) {
            log(`❌ Upload gagal karena error kritis pada file/halaman: "${detectedErrorMsg}"`);
        }
        else {
            log('❌ Gagal menemukan elemen upload atau verifikasi upload gagal');
        }
        return false;
    }
    // Wait for upload to process
    log('⏳ Menunggu video diproses TikTok...');
    await waitAndLog(page, log, 5000, 'video processing');
    if (!isRunning) {
        log('⛔ Dibatalkan');
        return false;
    }
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
        }
        catch {
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
        return false;
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
        return false;
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
    }
    catch (e) {
        log('❌ Gagal mengisi deskripsi: ' + e.message);
    }
    if (!isRunning) {
        log('⛔ Dibatalkan');
        return false;
    }
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
            }
            catch {
                // Fallback: check for any dialog
                try {
                    await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: 5000 });
                    dialogVisible = true;
                }
                catch {
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
                }
                else {
                    log('ℹ Tab Showcase tidak terdeteksi khusus, melanjutkan pencarian produk...');
                }
            }
            catch (err) {
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
                }
                catch { }
            }
            if (!searchInput || await searchInput.count() === 0) {
                log('ℹ Fallback: Mengambil input teks pertama di dialog...');
                searchInput = page.locator('[role="dialog"] input, [class*="modal"] input, input[type="text"]').first();
            }
            if (searchInput && await searchInput.count() > 0) {
                log(`✓ Mengisi nama produk: "${config.productNameRadio}"`);
                // 1. Scroll into view & focus
                await searchInput.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => { });
                await page.waitForTimeout(300);
                // 2. Click container .TUXInputBox / .TUXTextInputCore or input
                try {
                    const box = page.locator('.TUXInputBox, .TUXTextInputCore').first();
                    if (await box.count() > 0) {
                        await box.click({ force: true }).catch(() => { });
                    }
                    else {
                        await searchInput.click({ force: true }).catch(() => { });
                    }
                }
                catch {
                    await searchInput.click({ force: true }).catch(() => { });
                }
                // 3. Clear existing text
                await searchInput.evaluate((el) => {
                    el.focus();
                    el.value = '';
                }).catch(() => { });
                await page.keyboard.press('Control+A').catch(() => { });
                await page.keyboard.press('Backspace').catch(() => { });
                await page.waitForTimeout(200);
                // 4. Fill text via Playwright fill AND via keyboard type
                try {
                    await searchInput.fill(config.productNameRadio);
                }
                catch {
                    await page.keyboard.type(config.productNameRadio, { delay: 50 });
                }
                // 5. Inject React native value setter & dispatch synthetic events
                await searchInput.evaluate((el, val) => {
                    el.focus();
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                    if (nativeSetter) {
                        nativeSetter.call(el, val);
                    }
                    else {
                        el.value = val;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
                }, config.productNameRadio).catch(() => { });
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
                }
                catch { }
                if (!iconClicked) {
                    try {
                        await searchInput.press('Enter');
                        log('✓ Tekan Enter untuk cari');
                    }
                    catch { }
                }
            }
            else {
                log('❌ Gagal menemukan input pencarian produk di halaman!');
            }
            log('⏳ Menunggu hasil pencarian di tbody...');
            await waitAndLog(page, log, 3000, 'memuat hasil tabel produk');
            // Select radio button inside tbody table rows
            try {
                log('🔍 Mencari hasil produk di tbody...');
                // Wait for tbody table rows to appear
                const rows = page.locator('tbody tr.product-tb-row, tbody tr, tr.product-tb-row');
                let rowCount = 0;
                try {
                    await rows.first().waitFor({ state: 'visible', timeout: 10000 });
                    rowCount = await rows.count();
                }
                catch {
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
                        if (targetRow)
                            break;
                    }
                    if (!targetRow) {
                        log('ℹ Menggunakan baris produk pertama dari hasil pencarian');
                        targetRow = rows.first();
                    }
                    // Locate radio input & wrapper inside targetRow
                    const radioInput = targetRow.locator('input[type="radio"], .TUXRadioStandalone-input').first();
                    const radioWrapper = targetRow.locator('.TUXRadioStandalone, .TUXRadio, .product-info-cell').first();
                    const radioLabel = targetRow.locator('label.TUXRadio-label, label').first();
                    await targetRow.evaluate((el) => el.scrollIntoView({ block: 'center' }));
                    await page.waitForTimeout(500);
                    let checked = false;
                    // Method 1: Click .TUXRadioStandalone / .TUXRadio
                    try {
                        if (await radioWrapper.count() > 0) {
                            await radioWrapper.click({ force: true, timeout: 3000 });
                            await page.waitForTimeout(500);
                            checked = await radioInput.isChecked().catch(() => false);
                            if (checked)
                                log('✓ Radio produk tercentang (via .TUXRadioStandalone)');
                        }
                    }
                    catch { }
                    // Method 2: Click label for radio
                    if (!checked) {
                        try {
                            if (await radioLabel.count() > 0) {
                                await radioLabel.click({ force: true, timeout: 3000 });
                                await page.waitForTimeout(500);
                                checked = await radioInput.isChecked().catch(() => false);
                                if (checked)
                                    log('✓ Radio produk tercentang (via label)');
                            }
                        }
                        catch { }
                    }
                    // Method 3: Direct JS click on radio input
                    if (!checked) {
                        try {
                            await radioInput.evaluate((el) => {
                                el.click();
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            });
                            await page.waitForTimeout(500);
                            checked = await radioInput.isChecked().catch(() => false);
                            if (checked)
                                log('✓ Radio produk tercentang (via JS click)');
                        }
                        catch { }
                    }
                    // Method 4: Click target row
                    if (!checked) {
                        try {
                            await targetRow.click({ force: true, timeout: 3000 });
                            await page.waitForTimeout(500);
                            checked = await radioInput.isChecked().catch(() => false);
                            if (checked)
                                log('✓ Radio produk tercentang (via row click)');
                        }
                        catch { }
                    }
                    if (checked) {
                        log('✓ Radio produk BERHASIL dipilih & tercentang!');
                    }
                    else {
                        log('ℹ Radio diklik, melanjutkan ke tombol Next');
                    }
                }
                else {
                    log('❌ Tidak ada baris produk ditemukan di tbody');
                }
            }
            catch (e) {
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
        }
        catch (e) {
            log('❌ Gagal menambahkan produk: ' + e.message);
        }
    }
    if (!isRunning) {
        log('⛔ Dibatalkan');
        return false;
    }
    // ── STEP 7: Switches (AI-generated content & Pemeriksaan konten ringan) ──
    if (!config.skipSwitches) {
        log('🔀 STEP 6: Toggle switches...');
        try {
            // 1. Open Advanced Settings if present
            try {
                const advSettings = page.locator('[data-e2e="advanced_settings_container"]');
                if (await advSettings.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await advSettings.scrollIntoViewIfNeeded().catch(() => { });
                    await advSettings.click({ timeout: 3000 });
                    log('✓ Advanced settings dibuka');
                    await page.waitForTimeout(1500);
                }
            }
            catch { }
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
                            await loc.scrollIntoViewIfNeeded().catch(() => { });
                            await loc.click({ force: true });
                            aigcClicked = true;
                            log('✓ Switch "Konten yang dihasilkan AI" diklik');
                            break;
                        }
                    }
                    catch { }
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
                    }
                    catch { }
                }
                else {
                    log('ℹ Switch AI-generated tidak terdeteksi atau sudah aktif');
                }
            }
            catch (err) {
                log(`⚠ AI-generated switch: ${err.message}`);
            }
        }
        catch (e) {
            log('⚠ Toggle switches: ' + e.message);
        }
    }
    if (!isRunning) {
        log('⛔ Dibatalkan');
        return false;
    }
    // ── STEP 8: Schedule ──
    if (scheduleDate && scheduleTime) {
        log(`📅 STEP 7: Mengatur schedule (${scheduleDate} ${scheduleTime})...`);
        try {
            // 1. Wait for schedule section or input
            try {
                await page.locator('//*[contains(text(),"When to post") or contains(text(),"Waktu posting")] | input[name="postSchedule"]').first().waitFor({ timeout: 15000 });
            }
            catch {
                log('⚠ Header Waktu posting/When to post tidak terdeteksi dalam 15s, mencoba mencari radio Jadwalkan...');
            }
            // 2. Click "Jadwalkan" / "Schedule" radio button
            let scheduleRadioClicked = false;
            // Method 1: JS direct click on input[value='schedule'] and its closest label
            try {
                const jsClicked = await page.evaluate(() => {
                    const radio = document.querySelector("input[name='postSchedule'][value='schedule']");
                    if (radio) {
                        const label = radio.closest('label') || radio.parentElement;
                        if (label)
                            label.click();
                        radio.click();
                        radio.checked = true;
                        radio.setAttribute('aria-checked', 'true');
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                        radio.dispatchEvent(new Event('input', { bubbles: true }));
                        return true;
                    }
                    // Scan for label with text 'Jadwalkan'
                    const labels = Array.from(document.querySelectorAll('label'));
                    for (const l of labels) {
                        if (l.textContent?.trim().includes('Jadwalkan') || l.textContent?.trim().includes('Schedule')) {
                            l.click();
                            return true;
                        }
                    }
                    return false;
                });
                if (jsClicked) {
                    scheduleRadioClicked = true;
                    log('✓ Schedule radio ("Jadwalkan") dipilih via JS');
                }
            }
            catch { }
            // Method 2: Playwright click on label containing 'Jadwalkan' or 'Schedule'
            if (!scheduleRadioClicked) {
                try {
                    const scheduleLabel = page.locator('label').filter({ hasText: /Jadwalkan|Schedule/i }).first();
                    if (await scheduleLabel.isVisible({ timeout: 3000 }).catch(() => false)) {
                        await scheduleLabel.click({ force: true });
                        scheduleRadioClicked = true;
                        log('✓ Schedule radio ("Jadwalkan") dipilih via label locator');
                    }
                }
                catch { }
            }
            // Method 3: Playwright click on input[name='postSchedule'][value='schedule']
            if (!scheduleRadioClicked) {
                try {
                    const radioInput = page.locator("input[name='postSchedule'][value='schedule']").first();
                    if (await radioInput.count() > 0) {
                        await radioInput.click({ force: true });
                        scheduleRadioClicked = true;
                        log('✓ Schedule radio ("Jadwalkan") dipilih via input locator');
                    }
                }
                catch { }
            }
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
                    if (monthTitle?.toLowerCase().includes(targetEnglish.toLowerCase()) ||
                        monthTitle?.toLowerCase().includes(targetIndonesian.toLowerCase())) {
                        break;
                    }
                    // Target the right-arrow (next month). Sibling after title-wrapper is the next month arrow.
                    const nextArrow = page.locator('.calendar-wrapper .title-wrapper ~ .arrow, [class*="calendar"] [class*="title-wrapper"] ~ [class*="arrow"]').first();
                    if (await nextArrow.isVisible().catch(() => false)) {
                        await nextArrow.click();
                        log('✓ Klik arrow bulan berikutnya (CSS sibling)');
                    }
                    else {
                        // Fallback arrow logic
                        const arrows = page.locator('.calendar-wrapper .arrow, [class*="calendar"] [class*="arrow"]');
                        const arrowCount = await arrows.count();
                        if (arrowCount === 1) {
                            await arrows.nth(0).click();
                            log('✓ Klik arrow bulan berikutnya (single arrow)');
                        }
                        else if (arrowCount >= 2) {
                            await arrows.nth(1).click();
                            log('✓ Klik arrow bulan berikutnya (arrow index 1)');
                        }
                    }
                    await page.waitForTimeout(1000);
                    attempts++;
                }
            }
            catch { /* ignore */ }
            // Click target day exactly using Regex filter on valid/active days
            try {
                const daySpan = page.locator('.calendar-wrapper span.day.valid, [class*="calendar"] span[class*="day"][class*="valid"]')
                    .filter({ hasText: new RegExp('^' + targetDay + '$') })
                    .first();
                await daySpan.click();
                log(`✓ Tanggal ${targetDay} dipilih`);
            }
            catch {
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
        }
        catch (e) {
            log('❌ Gagal mengatur schedule: ' + e.message);
        }
    }
    if (!isRunning) {
        log('⛔ Dibatalkan');
        return false;
    }
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
                        const switchContent = hw.querySelector('.headline-switch .Switch__content, .Switch__content, .Switch__root, input[role="switch"]');
                        if (switchContent) {
                            const cls = switchContent.className || '';
                            const aria = switchContent.getAttribute('aria-checked') || '';
                            const dataState = switchContent.getAttribute('data-state') || '';
                            const isOn = cls.includes('checked-true') || aria === 'true' || dataState === 'checked';
                            if (isOn) {
                                switchContent.scrollIntoView({ block: 'center' });
                                switchContent.click();
                                return 'clicked_direct';
                            }
                            else {
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
                        if (!parent)
                            continue;
                        const switchEl = parent.querySelector('.Switch__content, .Switch__root, [role="switch"]');
                        if (switchEl) {
                            const cls = switchEl.className || '';
                            const aria = switchEl.getAttribute('aria-checked') || '';
                            const dataState = switchEl.getAttribute('data-state') || '';
                            const isOn = cls.includes('checked-true') || aria === 'true' || dataState === 'checked';
                            if (isOn) {
                                switchEl.scrollIntoView({ block: 'center' });
                                switchEl.click();
                                return 'clicked_fallback';
                            }
                            else {
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
            }
            else if (result === 'already_off_direct' || result === 'already_off_fallback') {
                contentCheckClicked = true;
                log(`ℹ Content Check Lite sudah OFF (${result})`);
            }
            else {
                log('ℹ Content Check Lite tidak ditemukan via JS evaluation');
            }
        }
        catch (eJS) {
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
                    }
                    else {
                        log('ℹ Content Check Lite sudah OFF (Playwright fallback)');
                    }
                }
            }
            catch { }
        }
    }
    catch (e) {
        log(`⚠ Content Check Lite: ${e.message}`);
    }
    if (!isRunning) {
        log('⛔ Dibatalkan');
        return false;
    }
    // ── STEP 10: Verify video uploaded before posting ──
    log('🔍 STEP 9: Memeriksa apakah video sudah terupload...');
    try {
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
        return false;
    }
    // ── STEP 11: Click Schedule/Post button ──
    log('🎬 STEP 10: Klik tombol Schedule/Post...');
    try {
        let clicked = false;
        // Method 1: Target data-e2e="post_video_button" directly (matches "Posting", "Jadwalkan", "Schedule", etc.)
        const postVideoBtn = page.locator("button[data-e2e='post_video_button']").first();
        if (await postVideoBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await postVideoBtn.scrollIntoViewIfNeeded();
            await postVideoBtn.click({ force: true });
            clicked = true;
            log('✓ Tombol Post/Schedule diklik (data-e2e="post_video_button")');
        }
        // Method 2: Fallback text filter matching Posting, Jadwalkan, Schedule, Post, Tayangkan
        if (!clicked) {
            const fallbackBtn = page.locator('button').filter({ hasText: /Posting|Jadwalkan|Schedule|Tayangkan|^Post$/i }).first();
            if (await fallbackBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await fallbackBtn.click({ force: true });
                clicked = true;
                log('✓ Tombol Post/Schedule diklik (fallback text match)');
            }
        }
        // Method 3: JS Direct Click on button[data-e2e="post_video_button"]
        if (!clicked) {
            clicked = await page.evaluate(() => {
                const btn = document.querySelector('button[data-e2e="post_video_button"]');
                if (btn) {
                    btn.click();
                    return true;
                }
                return false;
            });
            if (clicked)
                log('✓ Tombol Post/Schedule diklik (JS fallback)');
        }
        await page.waitForTimeout(5000);
        log('🎉 Upload selesai!');
        return true;
    }
    catch (e) {
        log('❌ Gagal klik tombol publish: ' + e.message);
        return false;
    }
}
// ═══════════════════════════════════════════════════════════
//  MAIN UPLOAD FUNCTION - MULTI-VIDEO SEQUENTIAL
// ═══════════════════════════════════════════════════════════
export async function runUpload(config, log, onVideoUploaded, onSchedulePlanned) {
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
    let allVideos;
    try {
        allVideos = fs.readdirSync(config.videoFolder)
            .filter(f => exts.includes(path.extname(f).toLowerCase()))
            .sort();
    }
    catch (e) {
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
    let uploadedMarks = {};
    try {
        uploadedMarks = JSON.parse(fs.readFileSync(marksFile, 'utf-8'));
    }
    catch { }
    // ── Filter out already uploaded ──
    const videosToUpload = videosFromStart.filter(v => !uploadedMarks[v]);
    if (videosToUpload.length === 0) {
        log('ℹ Semua video mulai dari yang dipilih sudah terupload!');
        isRunning = false;
        return;
    }
    // ── Calculate base schedule time ──
    const intervalMinutes = config.threeUploadsPerHour ? (config.intervalMinutes || 300) : (config.intervalMinutes || 60);
    const intervalMs = intervalMinutes * 60 * 1000;
    let baseSchedule;
    try {
        baseSchedule = new Date(`${config.scheduleDate}T${config.scheduleTime}:00`);
        if (isNaN(baseSchedule.getTime()))
            throw new Error('Invalid date');
    }
    catch {
        log('⚠ Schedule date/time tidak valid, menggunakan waktu sekarang + 1 jam');
        baseSchedule = new Date(Date.now() + 3600000);
    }
    if (config.threeUploadsPerHour) {
        baseSchedule.setMinutes(0);
        baseSchedule.setSeconds(0);
        baseSchedule.setMilliseconds(0);
    }
    const formatSchedulePlanItem = (videoSchedule, index, filename, offsetMinutes) => ({
        index: index + 1,
        filename,
        scheduleDate: `${videoSchedule.getFullYear()}-${String(videoSchedule.getMonth() + 1).padStart(2, '0')}-${String(videoSchedule.getDate()).padStart(2, '0')}`,
        scheduleTime: `${String(videoSchedule.getHours()).padStart(2, '0')}:${String(videoSchedule.getMinutes()).padStart(2, '0')}`,
        offsetMinutes
    });
    const schedulePlan = [];
    if (config.enableCustomScheduler) {
        const validMins = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
        const temp = [...validMins];
        const chosenMins = [];
        for (let i = 0; i < videosToUpload.length; i++) {
            if (temp.length === 0) {
                chosenMins.push(validMins[Math.floor(Math.random() * validMins.length)]);
            }
            else {
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
    }
    else if (config.threeUploadsPerHour) {
        let currentBatchMinutes = [];
        let lastBatchIndex = -1;
        for (let i = 0; i < videosToUpload.length; i++) {
            const batchIndex = Math.floor(i / 3);
            const subIndex = i % 3;
            if (batchIndex !== lastBatchIndex) {
                const possible = [];
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
    }
    else {
        let previousIntervalSchedule = new Date(baseSchedule.getTime());
        for (let i = 0; i < videosToUpload.length; i++) {
            let videoSchedule;
            let offsetMinutes;
            if (config.randomizeIntervalSchedule && i > 0) {
                offsetMinutes = getRandomIntervalOffsetMinutes();
                videoSchedule = new Date(previousIntervalSchedule.getTime() + intervalMs + offsetMinutes * 60000);
            }
            else {
                videoSchedule = i === 0
                    ? new Date(baseSchedule.getTime())
                    : new Date(baseSchedule.getTime() + i * intervalMs);
            }
            previousIntervalSchedule = new Date(videoSchedule.getTime());
            schedulePlan.push(formatSchedulePlanItem(videoSchedule, i, videosToUpload[i], offsetMinutes));
        }
    }
    if (onSchedulePlanned) {
        onSchedulePlanned(schedulePlan);
    }
    log('🚀 ═══════════════════════════════════════════');
    log(`🚀 Memulai upload ${videosToUpload.length} video TikTok`);
    log(`📁 Folder: ${config.videoFolder}`);
    log(`🔑 State: ${config.stateFile}`);
    log(`⏰ Schedule pertama: ${config.scheduleDate} ${config.scheduleTime}`);
    if (config.threeUploadsPerHour) {
        log(`⏰ Mode Interval Tetap: 3 upload per jam, jeda antar-jam ${intervalMinutes} menit`);
    }
    else {
        log(`⏱ Interval: ${intervalMinutes} menit (${Math.floor(intervalMinutes / 60)}j ${intervalMinutes % 60}m)`);
        if (config.randomizeIntervalSchedule) {
            log(`Random interval aktif: jadwal setelah video pertama digeser -${RANDOM_INTERVAL_OFFSET_MAX_MINUTES} sampai +${RANDOM_INTERVAL_OFFSET_MAX_MINUTES} menit, kelipatan ${RANDOM_INTERVAL_OFFSET_STEP_MINUTES} menit`);
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
        const headlessFlag = isHeadless ? '--headless=new ' : '';
        log(`🌐 Membuka Chrome Native via CMD (Port CDP: ${cdpPort}, Headless: ${isHeadless})...`);
        let connected = false;
        // 1. Coba hubungkan ke Chrome Native yang SUDAH berjalan terlebih dahulu
        try {
            activeBrowser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`, { timeout: 2000 });
            connected = true;
            log('✓ Terhubung ke Chrome Native yang sudah berjalan via CDP!');
        }
        catch {
            // 2. Jika belum ada Chrome berjalan di port CDP, bersihkan lock file profil & launch Chrome baru
            const lockFile = path.join(profileDir, 'SingletonLock');
            if (fs.existsSync(lockFile)) {
                try {
                    fs.unlinkSync(lockFile);
                }
                catch { }
            }
            // Launch Chrome via CMD
            const chromePaths = [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
                path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            ];
            let chromeExe = chromePaths.find(p => fs.existsSync(p));
            if (chromeExe) {
                const cmd = `"${chromeExe}" ${headlessFlag}--remote-debugging-port=${cdpPort} --user-data-dir="${profileDir}" "${targetUrl}"`;
                exec(cmd, { shell: 'cmd.exe' });
            }
            else {
                const cmd = `start chrome ${headlessFlag}--remote-debugging-port=${cdpPort} --user-data-dir="${profileDir}" "${targetUrl}"`;
                exec(cmd, { shell: 'cmd.exe' });
            }
            // Connect Playwright over CDP to Native Chrome (retry max 30x / 15s)
            log('⏳ Menghubungkan Playwright ke Chrome Native via CDP...');
            for (let attempt = 1; attempt <= 30; attempt++) {
                try {
                    activeBrowser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`, { timeout: 2000 });
                    connected = true;
                    log('✓ Playwright terhubung ke Chrome Native via CDP!');
                    break;
                }
                catch {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }
        if (!connected || !activeBrowser) {
            throw new Error('Gagal menghubungkan Playwright ke Chrome Native via CDP port 9222');
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
            }
            catch (e) {
                log(`⚠ Info cookie: ${e.message}`);
            }
        }
        await activeContext.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        const page = activeContext.pages().length > 0 ? activeContext.pages()[0] : await activeContext.newPage();
        let uploadIndex = 0;
        let successCount = 0;
        let failCount = 0;
        for (const videoFile of videosToUpload) {
            if (!isRunning) {
                log('⛔ Upload dihentikan oleh user');
                break;
            }
            // ── Calculate schedule for this video ──
            const plannedSchedule = schedulePlan[uploadIndex];
            if (plannedSchedule.offsetMinutes !== undefined) {
                log(`Random interval video ${uploadIndex + 1}: ${plannedSchedule.offsetMinutes >= 0 ? '+' : ''}${plannedSchedule.offsetMinutes} menit`);
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
                    let m = {};
                    try {
                        m = JSON.parse(fs.readFileSync(marksFile, 'utf-8'));
                    }
                    catch { }
                    m[videoFile] = true;
                    fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
                    log(`✓ Menandai file tidak ditemukan sebagai terproses: ${videoFile}`);
                }
                catch (e) {
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
                }
                catch (e) {
                    log(`⚠ Gagal menghapus file corrupt ${videoFile}: ${e.message}`);
                }
                try {
                    let m = {};
                    try {
                        m = JSON.parse(fs.readFileSync(marksFile, 'utf-8'));
                    }
                    catch { }
                    m[videoFile] = true;
                    fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
                    log(`✓ Menandai file corrupt sebagai terproses: ${videoFile}`);
                }
                catch (e) {
                    log(`⚠ Gagal menandai video corrupt: ${e.message}`);
                }
                failCount++;
                uploadIndex++;
                continue;
            }
            try {
                const success = await uploadSingleVideo(page, videoPath, config, schedDate, schedTime, log, uploadIndex + 1);
                if (success) {
                    successCount++;
                    if (onVideoUploaded) {
                        onVideoUploaded(videoFile);
                    }
                    log(`✅ Video ${videoFile} berhasil diupload! (${successCount}/${videosToUpload.length})`);
                }
                else {
                    failCount++;
                    log(`❌ Video ${videoFile} gagal diupload`);
                }
            }
            catch (e) {
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
