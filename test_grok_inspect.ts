import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function main() {
  const statePath = path.resolve(process.cwd(), 'grok-states', 'grok-state-inovasi2.json');
  console.log('Using state path:', statePath);
  if (!fs.existsSync(statePath)) {
    console.error('State file not found at:', statePath);
    process.exit(1);
  }

  console.log('Launching Chrome browser (headed)...');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation']
  });

  const context = await browser.newContext({
    storageState: statePath,
    viewport: { width: 1366, height: 900 },
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    acceptDownloads: true,
    extraHTTPHeaders: { 'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' }
  });

  const page = await context.newPage();
  console.log('Navigating to https://grok.com/imagine...');
  await page.goto('https://grok.com/imagine', { waitUntil: 'networkidle', timeout: 60000 }).catch(e => {
    console.log('Goto notice:', e.message);
  });

  console.log('Waiting for Grok UI editor or form...');
  try {
    await page.waitForSelector('form, [data-testid="chat-input"], button', { timeout: 30000 });
    console.log('UI element detected!');
  } catch (e) {
    console.log('Wait timeout:', (e as Error).message);
  }

  await page.waitForTimeout(5000);

  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);
  console.log('Page Title:', await page.title());

  // Check body text snippet
  const bodyText = await page.locator('body').innerText().catch(() => '');
  console.log('Body snippet (first 300 chars):', bodyText.substring(0, 300).replace(/\n/g, ' '));

  // Find all buttons
  const buttons = await page.locator('button').all();
  console.log(`Found ${buttons.length} buttons on page.`);
  const buttonData = [];
  for (const btn of buttons) {
    if (await btn.isVisible().catch(() => false)) {
      const text = (await btn.innerText().catch(() => '')).trim().replace(/\n/g, ' ');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      const id = await btn.getAttribute('id').catch(() => '');
      const type = await btn.getAttribute('type').catch(() => '');
      console.log(`[BUTTON] text: "${text}" | aria-label: "${ariaLabel}" | id: "${id}" | type: "${type}"`);
      buttonData.push({ text, ariaLabel, id, type });
    }
  }

  // Find editable inputs
  const editors = await page.locator('[contenteditable="true"], textarea, p.is-empty').all();
  console.log(`Found ${editors.length} editable/input elements.`);
  for (const ed of editors) {
    if (await ed.isVisible().catch(() => false)) {
      const placeholder = await ed.getAttribute('data-placeholder').catch(() => '') || await ed.getAttribute('placeholder').catch(() => '');
      const dataTestId = await ed.getAttribute('data-testid').catch(() => '');
      const tag = await ed.evaluate(e => e.tagName).catch(() => '');
      console.log(`[INPUT] tag: ${tag} | data-testid: "${dataTestId}" | placeholder: "${placeholder}"`);
    }
  }

  const screenshotPath = path.resolve(process.cwd(), 'grok_live_inspect.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Screenshot updated at:', screenshotPath);

  await browser.close();
}

main().catch(console.error);
