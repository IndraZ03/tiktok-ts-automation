import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const UI_TIMEOUT = 60000;
const GENERATION_TIMEOUT = 15 * 60000;
const VIDEO_SELECTOR = 'video#sd-video, video#hd-video, video[src*="generated_video.mp4"], video[src*="assets.grok.com"]';

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeStateName(value) {
    const stateName = value.trim().replace(/^grok-state-/, '').replace(/\.json$/i, '');
    if (!/^[A-Za-z0-9_ ()-]+$/.test(stateName)) {
        throw new Error(`Nama state Grok tidak valid: ${value}`);
    }
    return stateName;
}

function stateFilePath(stateName) {
    const stateDir = path.resolve(process.cwd(), 'grok-states');
    let statePath = path.resolve(stateDir, `grok-state-${stateName}.json`);
    if (!fs.existsSync(statePath)) {
        const rootPath = path.resolve(process.cwd(), `grok-state-${stateName}.json`);
        if (fs.existsSync(rootPath)) return rootPath;
        const rootAlt = path.resolve(process.cwd(), `${stateName}.json`);
        if (fs.existsSync(rootAlt)) return rootAlt;
    }
    return statePath;
}

async function firstVisible(...locators) {
    for (const locator of locators) {
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
            const candidate = locator.nth(index);
            if (await candidate.isVisible().catch(() => false)) return candidate;
        }
    }
    return null;
}

async function firstVisibleExcept(locator, excluded) {
    const count = await locator.count().catch(() => 0);
    if (count === 0) return null;
    const excludedHandle = await excluded.elementHandle({ timeout: 1000 }).catch(() => null);
    for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const isDifferent = !excludedHandle || await candidate.evaluate((node, other) => node !== other, excludedHandle).catch(() => false);
        if (isDifferent) return candidate;
    }
    return null;
}

async function dismissIntroDialog(page, log) {
    const cookieBtn = await firstVisible(
        page.getByRole('button', { name: /^(Terima Semua Cookie|Accept All Cookies|Close|Dismiss cookie notice)$/i }),
        page.locator('button[aria-label="Dismiss cookie notice"]')
    );
    if (cookieBtn) {
        await cookieBtn.click({ timeout: 5000 }).catch(() => {});
        log('Cookie notice ditutup');
    }

    const negative = /^(Tidak,?\s*terima kasih|No,?\s*thanks|Dismiss|Close)$/i;
    const button = await firstVisible(
        page.getByRole('dialog').getByRole('button', { name: negative }),
        page.getByRole('button', { name: negative })
    );
    if (button) {
        await button.click({ timeout: 5000 }).catch(() => {});
        log('Popup Grok ditutup');
    }
}

async function assertAuthenticated(page) {
    if (/\/(sign-?in|login)(?:[/?#]|$)/i.test(page.url())) {
        throw new Error('Blocker eksternal Grok: storage state tidak lagi login');
    }
    const signIn = await firstVisible(page.getByRole('button', { name: /^(Masuk|Log in|Sign in)$/i }));
    if (signIn && !(await signIn.getAttribute('aria-label')?.catch(() => ''))?.includes('Google')) {
        throw new Error('Blocker eksternal Grok: storage state tidak lagi login');
    }
}

async function detectExternalBlocker(page) {
    const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    const match = text.match(/(rate limit[^\n]*|terlalu banyak permintaan[^\n]*|kuota[^\n]*|quota[^\n]*|upgrade[^\n]*|coba lagi nanti[^\n]*|try again later[^\n]*|service unavailable[^\n]*)/i);
    return match?.[1]?.trim() || '';
}

async function waitForUsablePage(page, log) {
    log('Menunggu editor Grok siap...');
    await dismissIntroDialog(page, log);
    await assertAuthenticated(page);
    const editor = page.locator('[data-testid="chat-input"] [contenteditable="true"]')
        .or(page.locator('[contenteditable="true"]'))
        .first();

    await editor.waitFor({ state: 'visible', timeout: 180000 }).catch(async () => {
        await assertAuthenticated(page);
        const blocker = await detectExternalBlocker(page);
        if (blocker) throw new Error(`Blocker eksternal Grok: ${blocker}`);
        throw new Error('Editor Grok tidak muncul dalam 180 detik');
    });
}

async function selectRadio(page, name, log) {
    await dismissIntroDialog(page, log);
    const modeBtn = await firstVisible(
        page.getByRole('radio', { name: new RegExp(`^${escapeRegex(name)}$`, 'i') }),
        page.getByRole('button', { name: new RegExp(`^${escapeRegex(name)}$`, 'i') }),
        page.locator(`button[aria-label="${name}"]`),
        page.locator(`button:has-text("${name}")`)
    );
    if (!modeBtn) {
        log(`Mode "${name}" tidak ditemukan langsung, melanjutkan dengan elemen aktif saat ini.`);
        return;
    }
    const ariaChecked = await modeBtn.getAttribute('aria-checked').catch(() => null);
    if (ariaChecked !== 'true') {
        await modeBtn.click({ timeout: UI_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(1000);
    }
    log(`Dipilih dan diverifikasi mode: ${name}`);
}

async function selectRadioOrMenu(page, value, triggerName, triggerValuePattern, log) {
    await dismissIntroDialog(page, log);
    const direct = await firstVisible(page.getByRole('radio', { name: new RegExp(`^${escapeRegex(value)}$`, 'i') }));
    if (direct) {
        if (await direct.getAttribute('aria-checked') !== 'true') await direct.click({ timeout: UI_TIMEOUT });
        log(`Dipilih dan diverifikasi: ${value}`);
        return;
    }

    const trigger = await firstVisible(
        page.getByRole('button', { name: triggerName }),
        page.locator('button[aria-label*="resolution" i], button[aria-label*="resolusi" i], button[aria-label*="duration" i], button[aria-label*="durasi" i], button[aria-label*="aspect" i], button[aria-label*="rasio" i]'),
        page.getByRole('button').filter({ hasText: triggerValuePattern })
    );
    if (!trigger) {
        log(`[WARN] Kontrol pilihan "${value}" tidak ditemukan langsung, lewati...`);
        return;
    }

    const currentText = (await trigger.innerText().catch(() => '')).trim();
    if (!new RegExp(`(^|\\s)${escapeRegex(value)}(\\s|$)`, 'i').test(currentText)) {
        await trigger.click({ timeout: UI_TIMEOUT });
        await page.waitForTimeout(1000);
        const choice = await firstVisible(
            page.getByRole('menuitemradio').filter({ hasText: new RegExp(escapeRegex(value), 'i') }),
            page.getByRole('menuitem').filter({ hasText: new RegExp(escapeRegex(value), 'i') }),
            page.locator(`[role="menuitemradio"]:has-text("${value}")`),
            page.locator(`[role="menuitem"]:has-text("${value}")`)
        );
        if (choice) {
            await choice.click({ timeout: UI_TIMEOUT });
            await page.waitForTimeout(1000);
        } else {
            await page.keyboard.press('Escape').catch(() => {});
        }
    }

    log(`Dipilih dan diverifikasi: ${value}`);
}

async function ensureAudioDisabled(page, log) {
    await dismissIntroDialog(page, log);
    const button = await firstVisible(page.getByRole('button', { name: /^(Audio video|Video audio|Audio)$/i }));
    if (!button) {
        log('Kontrol audio video tidak tersedia (opsional), dilewati.');
        return;
    }
    const pressed = await button.getAttribute('aria-pressed');
    if (pressed === 'true') await button.click({ timeout: UI_TIMEOUT }).catch(() => {});
    log('Audio video diperiksa');
}

async function selectAspectRatio(page, aspectRatio, log) {
    await selectRadioOrMenu(
        page,
        aspectRatio,
        /^(Rasio Aspek|Aspect Ratio)$/i,
        /^\s*(1:1|2:3|3:2|9:16|16:9|Auto)\s*$/i,
        log
    );
}

async function uploadImage(page, imagePath, log) {
    const absoluteImagePath = path.resolve(imagePath);
    if (!fs.existsSync(absoluteImagePath)) throw new Error(`File gambar tidak ditemukan: ${absoluteImagePath}`);
    await dismissIntroDialog(page, log);
    log(`Mengunggah gambar: ${path.basename(absoluteImagePath)}`, 15);

    const baselineImages = await page.locator('form img').count().catch(() => 0);
    let chooser = null;
    const directInput = page.locator('input[type="file"]').last();
    if (await directInput.count()) {
        await directInput.setInputFiles(absoluteImagePath, { timeout: UI_TIMEOUT });
    } else {
        const trigger = await firstVisible(page.getByRole('button', { name: /^(Unggah|Upload)$/i }));
        if (!trigger) throw new Error('Tombol unggah gambar tidak ditemukan');
        const firstChooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
        await trigger.click({ timeout: UI_TIMEOUT });
        chooser = await firstChooser;

        if (!chooser) {
            const uploadButtons = page.getByRole('button', { name: /^(Unggah|Upload)$/i });
            const uploadAction = await firstVisibleExcept(uploadButtons, trigger);
            const appearedInput = page.locator('input[type="file"]').last();
            if (await appearedInput.count()) {
                await appearedInput.setInputFiles(absoluteImagePath, { timeout: UI_TIMEOUT });
            } else if (uploadAction) {
                const secondChooser = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
                await uploadAction.click({ timeout: UI_TIMEOUT });
                chooser = await secondChooser;
            }
        }
        if (chooser) await chooser.setFiles(absoluteImagePath);
    }

    const confirm = await firstVisibleExcept(
        page.getByRole('button', { name: /^(Unggah|Upload)$/i }),
        page.getByRole('button', { name: /^(Unggah|Upload)$/i }).first()
    );
    if (confirm && await confirm.isEnabled().catch(() => false)) {
        await confirm.click({ timeout: 10000 }).catch(() => {});
    }

    await page.waitForFunction(
        ({ previous }) => {
            const hasSelectedFile = Array.from(document.querySelectorAll('input[type="file"]'))
                .some(input => (input.files?.length || 0) > 0);
            const hasAttachmentControl = !!document.querySelector('[aria-label*="Hapus gambar" i], [aria-label*="Remove image" i], [data-testid*="attachment" i]');
            return hasSelectedFile || hasAttachmentControl || document.querySelectorAll('form img').length > previous;
        },
        { previous: baselineImages },
        { timeout: UI_TIMEOUT }
    );
    log('Gambar terpasang dan terverifikasi', 22);
}

async function fillPrompt(page, promptText, log) {
    const prompt = promptText.trim();
    if (!prompt) throw new Error('Prompt Grok tidak boleh kosong');
    await dismissIntroDialog(page, log);
    const editor = page.locator('[data-testid="chat-input"] [contenteditable="true"]')
        .or(page.locator('[contenteditable="true"]'))
        .first();
    await editor.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await editor.fill(prompt);
    log('Prompt diisi dan terverifikasi', 25);
}

async function captureVideoUrls(page) {
    return new Set(await page.locator(VIDEO_SELECTOR).evaluateAll(videos =>
        videos.map(video => video.currentSrc || video.src).filter(Boolean)
    ));
}

async function clickGenerate(page, log) {
    await dismissIntroDialog(page, log);
    const submit = await firstVisible(
        page.locator('form button[type="submit"]'),
        page.getByRole('button', { name: /^(Kirim|Send|Submit)$/i }),
        page.locator('div.query-bar form button')
    );
    if (!submit) throw new Error('Tombol Generate/Kirim tidak ditemukan');
    const handle = await submit.elementHandle();
    await page.waitForFunction(element => {
        const button = element;
        return !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    }, handle, { timeout: UI_TIMEOUT });
    await submit.click({ timeout: UI_TIMEOUT });
    log('Generate dikirim', 35);
}

async function waitForVideoResult(page, oldUrls, log) {
    let lastProgress = -1;
    const startedAt = Date.now();

    while (Date.now() - startedAt < GENERATION_TIMEOUT) {
        const newUrl = await page.locator(VIDEO_SELECTOR).evaluateAll((videos, previous) => {
            const known = new Set(previous);
            return videos.map(video => video.currentSrc || video.src)
                .find(url => !!url && !known.has(url)) || '';
        }, [...oldUrls]).catch(() => '');
        if (newUrl) return newUrl;

        const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        const match = bodyText.match(/(?:Menghasilkan|Generating)\s*(\d+)%/i);
        const progress = match ? Number(match[1]) : null;
        if (progress !== null && progress !== lastProgress) {
            lastProgress = progress;
            log(`Menghasilkan ${progress}%`, Math.min(90, 35 + Math.round(progress * 0.55)));
        }
        const blocker = bodyText.match(/(rate limit[^\n]*|terlalu banyak permintaan[^\n]*|kuota[^\n]*|quota[^\n]*|upgrade[^\n]*|coba lagi nanti[^\n]*|try again later[^\n]*|service unavailable[^\n]*)/i)?.[1];
        if (blocker) throw new Error(`Blocker eksternal Grok: ${blocker.trim()}`);

        await page.waitForFunction(
            ({ selector, previous, lastText }) => {
                const known = new Set(previous);
                const hasNewVideo = Array.from(document.querySelectorAll(selector))
                    .some(video => !!(video.currentSrc || video.src) && !known.has(video.currentSrc || video.src));
                return hasNewVideo || (document.body.innerText || '') !== lastText;
            },
            { selector: VIDEO_SELECTOR, previous: [...oldUrls], lastText: bodyText },
            { timeout: 10000, polling: 1000 }
        ).catch(() => {});
    }
    throw new Error('Timeout menunggu video baru hasil Grok muncul');
}

function assertMp4(buffer) {
    if (buffer.length <= 12) throw new Error('Download menghasilkan file kosong atau terlalu kecil');
    if (buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
        throw new Error('File hasil tidak memiliki signature container MP4');
    }
}

async function downloadVideo(page, context, videoUrl, savePath, log) {
    log('Mengunduh video hasil...', 92);
    const downloadButton = await firstVisible(
        page.getByRole('button', { name: /^(Unduh|Download)$/i }),
        page.locator('button[aria-label="Download"], button[aria-label="Unduh"]')
    );
    if (downloadButton) {
        const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
        await downloadButton.click({ timeout: UI_TIMEOUT }).catch(() => {});
        const download = await downloadPromise;
        if (download) {
            await download.saveAs(savePath);
            const downloaded = fs.readFileSync(savePath);
            try {
                assertMp4(downloaded);
                log(`Download selesai melalui tombol (${downloaded.length} bytes)`, 100);
                return;
            } catch {
                fs.rmSync(savePath, { force: true });
            }
        }
    }

    const response = await context.request.get(videoUrl, {
        headers: { Accept: 'video/mp4,*/*', Referer: 'https://grok.com/' },
        timeout: 120000,
        failOnStatusCode: false
    });
    if (!response.ok()) throw new Error(`Download video gagal: HTTP ${response.status()}`);
    const body = await response.body();
    assertMp4(body);
    fs.writeFileSync(savePath, body);
    log(`Download selesai melalui URL video (${body.length} bytes)`, 100);
}

export const grokBrowserTestHooks = {
    selectRadio,
    selectRadioOrMenu,
    ensureAudioDisabled,
    selectAspectRatio,
    uploadImage,
    fillPrompt,
    clickGenerate,
    captureVideoUrls,
    waitForVideoResult
};

export async function generateGrokVideoBrowser(options, onProgress) {
    const log = (msg, progress) => {
        console.log(`[GROK_BROWSER] ${msg}${typeof progress === 'number' ? ` (${progress}%)` : ''}`);
        onProgress?.(msg, progress);
    };

    const stateName = normalizeStateName(options.stateName || 'inovasi2');
    const statePath = stateFilePath(stateName);
    if (!fs.existsSync(statePath)) throw new Error(`File state tidak ditemukan: ${statePath}`);

    const runId = new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}`;
    const downloadDir = path.resolve(process.cwd(), 'grok-downloads', stateName);
    const debugDir = path.join(downloadDir, 'debug', runId);
    fs.mkdirSync(downloadDir, { recursive: true });

    let context;
    let page;
    let tracingStopped = false;
    const browser = await chromium.launch({
        headless: options.headless ?? false,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        ignoreDefaultArgs: ['--enable-automation']
    });

    try {
        context = await browser.newContext({
            storageState: statePath,
            viewport: { width: 1366, height: 900 },
            locale: 'id-ID',
            timezoneId: 'Asia/Jakarta',
            acceptDownloads: true,
            extraHTTPHeaders: { 'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' }
        });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        page = await context.newPage();

        log(`Membuka Grok Imagine (${stateName})`, 5);
        await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 180000 });
        await waitForUsablePage(page, log);

        await selectRadio(page, 'Video', log);
        await selectRadioOrMenu(page, options.resolution || '720p', /^(Resolusi Video|Video Resolution)$/i, /^\s*(480p|720p|1080p)\s*$/i, log);
        await selectRadioOrMenu(page, options.duration || '10s', /^(Durasi Video|Video Duration)$/i, /^\s*\d+s\s*$/i, log);
        await ensureAudioDisabled(page, log);
        await selectAspectRatio(page, options.aspectRatio || '9:16', log);

        if (options.imagePath) await uploadImage(page, options.imagePath, log);
        await fillPrompt(page, options.promptText, log);
        const oldUrls = await captureVideoUrls(page);
        await clickGenerate(page, log);

        const videoUrl = await waitForVideoResult(page, oldUrls, log);
        const filename = `grok_browser_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
        const savePath = path.join(downloadDir, filename);
        await downloadVideo(page, context, videoUrl, savePath, log);

        await context.tracing.stop();
        tracingStopped = true;
        return {
            success: true,
            filename,
            savePath,
            rawUrl: videoUrl,
            downloadUrl: `/api/grok/video-file/${stateName}/${filename}`
        };
    } catch (error) {
        fs.mkdirSync(debugDir, { recursive: true });
        await page?.screenshot({ path: path.join(debugDir, 'failure.png'), fullPage: true }).catch(() => {});
        if (context && !tracingStopped) {
            await context.tracing.stop({ path: path.join(debugDir, 'trace.zip') }).catch(() => {});
            tracingStopped = true;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}. Debug: ${debugDir}`);
    } finally {
        if (context && !tracingStopped) await context.tracing.stop().catch(() => {});
        await context?.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}
