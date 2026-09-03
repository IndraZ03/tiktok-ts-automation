import { chromium, type BrowserContext, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';

export interface GrokBrowserGenerateOptions {
  stateName: string;
  promptText: string;
  imagePath?: string;
  resolution?: string;
  duration?: string;
  aspectRatio?: string;
  headless?: boolean;
}

type ProgressFn = (msg: string, progress?: number) => void;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeStateName(stateName: string) {
  return stateName.replace(/^grok-state-/, '').replace(/\.json$/i, '');
}

async function waitForUsablePage(page: Page, log: ProgressFn, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastLogAt = 0;

  while (Date.now() < deadline) {
    const ready = await page.locator('[contenteditable="true"][role="textbox"]').first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (ready) return;

    if (Date.now() - lastLogAt > 15000) {
      log('Menunggu halaman Grok selesai loading...');
      lastLogAt = Date.now();
    }

    await dismissIntroDialog(page, log);
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await sleep(2000);
  }

  throw new Error('Halaman Grok belum siap. Cek koneksi internet atau buka state Grok manual.');
}

async function clickIfVisible(page: Page, selector: string, timeout = 2500) {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function clickButtonByText(page: Page, text: string, timeout = 3000) {
  try {
    const button = page.getByRole('button', { name: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first();
    await button.waitFor({ state: 'visible', timeout });
    await button.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function dismissIntroDialog(page: Page, log: ProgressFn) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const dialogState = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')) as HTMLElement[];
      const visibleDialog = dialogs.find(dialog => {
        const rect = dialog.getBoundingClientRect();
        const style = window.getComputedStyle(dialog);
        return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      const text = visibleDialog?.innerText || document.body.innerText || '';
      return {
        visible: !!visibleDialog || /Jadilah yang pertama|fitur baru|Tidak,\s*terima kasih|No,\s*thanks/i.test(text),
        text
      };
    }).catch(() => ({ visible: false, text: '' }));
    if (!dialogState.visible) return;

    const clicked = await clickButtonByText(page, 'Tidak, terima kasih', 2500)
      || await clickButtonByText(page, 'No, thanks', 2500)
      || await page.locator('[role="dialog"] button').filter({ hasText: /Tidak|terima kasih|No|thanks/i }).first()
        .click({ timeout: 2500 }).then(() => true).catch(() => false)
      || await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
        const negative = buttons.find(button => /Tidak,\s*terima kasih|Tidak|No,\s*thanks|No thanks/i.test(button.innerText || button.textContent || ''));
        if (negative) {
          negative.click();
          return true;
        }
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')) as HTMLElement[];
        const dialog = dialogs.find(item => {
          const rect = item.getBoundingClientRect();
          return rect.width > 20 && rect.height > 20;
        });
        const dialogButtons = dialog ? Array.from(dialog.querySelectorAll('button')) as HTMLButtonElement[] : [];
        if (dialogButtons.length > 0) {
          dialogButtons[0].click();
          return true;
        }
        return false;
      }).catch(() => false);

    if (clicked) {
      log('Popup Grok ditutup');
      await page.waitForTimeout(2000);
      continue;
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1000);
  }
}

async function selectRadio(page: Page, name: string, log: ProgressFn) {
  await dismissIntroDialog(page, log);
  try {
    const radio = page.getByRole('radio', { name, exact: true }).first();
    await radio.waitFor({ state: 'visible', timeout: 30000 });
    const checked = await radio.getAttribute('aria-checked');
    if (checked !== 'true') await radio.click();
    log(`Dipilih: ${name}`);
    return;
  } catch {}

  await dismissIntroDialog(page, log);
  const clicked = await page.locator('button[role="radio"]').filter({ hasText: name }).first().click({ timeout: 5000 }).then(() => true).catch(() => false)
    || await page.evaluate((radioName) => {
      const radios = Array.from(document.querySelectorAll('button[role="radio"]')) as HTMLButtonElement[];
      const target = radios.find(button => {
        const ariaLabel = button.getAttribute('aria-label') || '';
        const text = button.innerText || button.textContent || '';
        return ariaLabel.trim().toLowerCase() === radioName.toLowerCase()
          || text.trim().toLowerCase() === radioName.toLowerCase();
      });
      if (!target) return false;
      target.click();
      return true;
    }, name).catch(() => false);
  if (!clicked) throw new Error(`Tidak bisa memilih radio: ${name}`);
  log(`Dipilih: ${name}`);
}

async function ensureAudioButtonState(page: Page, pressed: 'true' | 'false', log: ProgressFn) {
  await dismissIntroDialog(page, log);
  const audioButton = page.locator('button[aria-label="Audio video"]').first();
  try {
    await audioButton.waitFor({ state: 'visible', timeout: 15000 });
    const current = await audioButton.getAttribute('aria-pressed');
    if (current && current !== pressed) await audioButton.click();
    log(`Audio video aria-pressed=${pressed}`);
  } catch {}
}

async function selectAspectRatio(page: Page, aspectRatio: string, log: ProgressFn) {
  await dismissIntroDialog(page, log);
  if (!aspectRatio || aspectRatio === '9:16') {
    log('Rasio aspek 9:16 dipakai');
    return;
  }

  const trigger = page.locator('button[aria-label="Rasio Aspek"]').first();
  try {
    await trigger.waitFor({ state: 'visible', timeout: 5000 });
    await trigger.click();
    await page.getByText(aspectRatio, { exact: true }).first().click({ timeout: 5000 });
    log(`Rasio aspek dipilih: ${aspectRatio}`);
  } catch {
    log(`Rasio aspek ${aspectRatio} tidak ditemukan, lanjut dengan default halaman`);
  }
}

async function uploadImage(page: Page, imagePath: string, log: ProgressFn) {
  if (!fs.existsSync(imagePath)) throw new Error(`File gambar tidak ditemukan: ${imagePath}`);
  await dismissIntroDialog(page, log);
  log(`Mengunggah gambar: ${path.basename(imagePath)}`, 15);

  const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 30000 }).catch(() => null);
  const clicked = await clickIfVisible(page, 'button[aria-label="Unggah"]', 15000)
    || await clickIfVisible(page, 'button[aria-label="Upload"]', 15000)
    || await clickButtonByText(page, 'Unggah', 15000)
    || await clickButtonByText(page, 'Upload', 15000);
  if (!clicked) throw new Error('Tombol unggah gambar tidak ditemukan');

  const chooser = await fileChooserPromise;
  if (chooser) {
    await chooser.setFiles(imagePath);
  } else {
    const input = page.locator('input[type="file"]').last();
    await input.setInputFiles(imagePath, { timeout: 30000 });
  }

  await clickButtonByText(page, 'Unggah', 15000) || await clickButtonByText(page, 'Upload', 15000);
  await page.waitForTimeout(6000);
}

async function fillPrompt(page: Page, promptText: string, log: ProgressFn) {
  await dismissIntroDialog(page, log);
  const editor = page.locator('[contenteditable="true"][role="textbox"]').first();
  await editor.waitFor({ state: 'visible', timeout: 60000 });
  await editor.click();
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.type(promptText, { delay: 1 });
  log('Prompt diisi', 25);
}

async function clickGenerate(page: Page, log: ProgressFn) {
  await dismissIntroDialog(page, log);
  const submit = page.locator('button[type="submit"][aria-label="Kirim"]').first();
  await submit.waitFor({ state: 'visible', timeout: 60000 });
  await submit.click();
  log('Generate dikirim', 35);
}

async function waitForVideoResult(page: Page, log: ProgressFn) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let lastProgress = -1;

  while (Date.now() < deadline) {
    const videoUrl = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
      const found = videos.find(video => video.src && video.src.includes('generated_video.mp4'));
      return found?.src || '';
    }).catch(() => '');
    if (videoUrl) return videoUrl;

    const progress = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const match = text.match(/Menghasilkan\s+(\d+)%/i) || text.match(/Generating\s+(\d+)%/i);
      return match ? Number(match[1]) : null;
    }).catch(() => null);
    if (typeof progress === 'number' && progress !== lastProgress) {
      lastProgress = progress;
      log(`Menghasilkan ${progress}%`, Math.min(90, 35 + Math.round(progress * 0.5)));
    }

    await sleep(3000);
  }

  throw new Error('Timeout menunggu video hasil Grok muncul.');
}

async function downloadVideo(context: BrowserContext, videoUrl: string, savePath: string, log: ProgressFn) {
  log('Mengunduh video hasil...', 92);
  const response = await context.request.get(videoUrl, {
    headers: { Accept: '*/*', Range: 'bytes=0-', Referer: 'https://grok.com/' },
    timeout: 120000,
    failOnStatusCode: false
  });
  if (!response.ok()) throw new Error(`Download gagal HTTP ${response.status()}`);
  const body = await response.body();
  if (body.length === 0) throw new Error('Download menghasilkan file kosong');
  fs.writeFileSync(savePath, body);
  log(`Download selesai (${body.length} bytes)`, 100);
}

export async function generateGrokVideoBrowser(options: GrokBrowserGenerateOptions, onProgress?: ProgressFn) {
  const log: ProgressFn = (msg, progress) => {
    console.log(`[GROK_BROWSER] ${msg}${typeof progress === 'number' ? ` (${progress}%)` : ''}`);
    onProgress?.(msg, progress);
  };

  const stateName = sanitizeStateName(options.stateName || 'indra');
  const statePath = path.join(process.cwd(), 'grok-states', `grok-state-${stateName}.json`);
  if (!fs.existsSync(statePath)) throw new Error(`File state tidak ditemukan: ${statePath}`);

  const browser = await chromium.launch({
    headless: options.headless ?? false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation']
  });

  try {
    const context = await browser.newContext({
      storageState: statePath,
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      acceptDownloads: true,
      extraHTTPHeaders: { 'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' }
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    log(`Membuka Grok Imagine (${stateName})`, 5);
    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForLoadState('load', { timeout: 90000 }).catch(() => {
      log('Load event lambat, lanjut menunggu elemen utama...');
    });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {
      log('Network masih aktif, lanjut jika editor sudah siap...');
    });
    await page.waitForTimeout(5000);
    await dismissIntroDialog(page, log);
    await waitForUsablePage(page, log);

    await selectRadio(page, 'Video', log);
    await selectRadio(page, options.resolution || '720p', log);
    await selectRadio(page, options.duration || '10s', log);
    await ensureAudioButtonState(page, 'false', log);
    await selectAspectRatio(page, options.aspectRatio || '9:16', log);

    if (options.imagePath) await uploadImage(page, options.imagePath, log);
    await fillPrompt(page, options.promptText, log);
    await clickGenerate(page, log);

    const videoUrl = await waitForVideoResult(page, log);
    const downloadDir = path.join(process.cwd(), 'grok-downloads', stateName);
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
    const filename = `grok_browser_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
    const savePath = path.join(downloadDir, filename);
    await downloadVideo(context, videoUrl, savePath, log);

    return {
      success: true,
      filename,
      savePath,
      rawUrl: videoUrl,
      downloadUrl: `/api/grok/video-file/${stateName}/${filename}`
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
