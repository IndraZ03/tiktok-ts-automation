import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function main() {
  const statePath = path.resolve(process.cwd(), 'grok-states', 'grok-state-inovasi2.json');
  console.log('Using state path:', statePath);

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
  });

  const page = await context.newPage();
  console.log('Navigating to https://grok.com/imagine...');
  await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForSelector('button[aria-label="Video"], button:has-text("Image")', { timeout: 30000 });
  await page.waitForTimeout(2000);

  // Accept cookies if present
  const acceptCookies = page.getByRole('button', { name: /terima semua cookie|accept all/i }).first();
  if (await acceptCookies.isVisible().catch(() => false)) {
    await acceptCookies.click().catch(() => {});
    console.log('Accepted cookie banner');
    await page.waitForTimeout(1000);
  }

  // Click Video button
  console.log('\n--- Clicking Video Button ---');
  const videoBtn = page.locator('button[aria-label="Video"]')
    .or(page.getByRole('button', { name: /video/i }))
    .first();

  await videoBtn.click();
  console.log('Clicked Video button!');
  await page.waitForTimeout(2000);

  // Check buttons visible after Video is selected
  console.log('\n--- Toolbar Buttons after Video mode selected ---');
  const buttons = await page.locator('button').all();
  for (const btn of buttons) {
    if (await btn.isVisible().catch(() => false)) {
      const text = (await btn.innerText().catch(() => '')).trim().replace(/\n/g, ' ');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      if (text || ariaLabel) {
        console.log(`[VIDEO-MODE-BUTTON] text: "${text}" | aria-label: "${ariaLabel}"`);
      }
    }
  }

  // Test Resolution dropdown click
  console.log('\n--- Testing Resolution Button ---');
  const resBtn = page.locator('button[aria-label*="Resolution"], button[aria-label*="Resolusi"]')
    .or(page.locator('button:has-text("720p")'))
    .or(page.locator('button:has-text("1080p")'))
    .or(page.locator('button:has-text("480p")'))
    .first();

  if (await resBtn.isVisible().catch(() => false)) {
    console.log('Found Resolution button:', await resBtn.innerText());
    await resBtn.click();
    await page.waitForTimeout(1500);

    // List menu items
    const menuItems = await page.locator('[role="menuitemradio"], [role="menuitem"], [role="option"]').all();
    console.log(`Found ${menuItems.length} menu items in resolution dropdown:`);
    for (const item of menuItems) {
      if (await item.isVisible().catch(() => false)) {
        console.log(`  Menu item: "${(await item.innerText()).trim()}"`);
      }
    }
    await page.keyboard.press('Escape');
  }

  // Test Duration dropdown click
  console.log('\n--- Testing Duration Button ---');
  const durBtn = page.locator('button[aria-label*="Duration"], button[aria-label*="Durasi"]')
    .or(page.locator('button:has-text("6s")'))
    .or(page.locator('button:has-text("10s")'))
    .first();

  if (await durBtn.isVisible().catch(() => false)) {
    console.log('Found Duration button:', await durBtn.innerText());
    await durBtn.click();
    await page.waitForTimeout(1500);

    const durItems = await page.locator('[role="menuitemradio"], [role="menuitem"], [role="option"]').all();
    console.log(`Found ${durItems.length} menu items in duration dropdown:`);
    for (const item of durItems) {
      if (await item.isVisible().catch(() => false)) {
        console.log(`  Duration item: "${(await item.innerText()).trim()}"`);
      }
    }
    await page.keyboard.press('Escape');
  }

  // Test Aspect Ratio dropdown click
  console.log('\n--- Testing Aspect Ratio Button ---');
  const arBtn = page.locator('button[aria-label*="Aspect Ratio"], button[aria-label*="Rasio Aspek"]')
    .or(page.locator('button:has-text("9:16")'))
    .or(page.locator('button:has-text("2:3")'))
    .or(page.locator('button:has-text("16:9")'))
    .first();

  if (await arBtn.isVisible().catch(() => false)) {
    console.log('Found Aspect Ratio button:', await arBtn.innerText());
    await arBtn.click();
    await page.waitForTimeout(1500);

    const arItems = await page.locator('[role="menuitemradio"], [role="menuitem"], [role="option"]').all();
    console.log(`Found ${arItems.length} menu items in aspect ratio dropdown:`);
    for (const item of arItems) {
      if (await item.isVisible().catch(() => false)) {
        console.log(`  Aspect ratio item: "${(await item.innerText()).trim()}"`);
      }
    }
    await page.keyboard.press('Escape');
  }

  // Test prompt input
  console.log('\n--- Testing Prompt Input ---');
  const promptInput = page.locator('[contenteditable="true"]').first();
  if (await promptInput.isVisible().catch(() => false)) {
    console.log('Found prompt input element!');
    await promptInput.fill('A stunning cinematic high quality video test');
    console.log('Filled prompt!');
    await page.waitForTimeout(1000);

    // Locate Submit / Generate button
    const submitBtn = page.locator('form button[type="submit"]')
      .or(page.locator('button[aria-label="Kirim"], button[aria-label="Send"], button[aria-label="Submit"]'))
      .or(page.locator('div.query-bar form button:has(svg)'))
      .last();

    console.log('Submit button visible:', await submitBtn.isVisible().catch(() => false));
    if (await submitBtn.isVisible().catch(() => false)) {
      console.log('Submit button HTML snippet:', (await submitBtn.evaluate(el => el.outerHTML)).slice(0, 150));
    }
  }

  const screenshotPath = path.resolve(process.cwd(), 'grok_live_video_flow.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Saved screenshot to:', screenshotPath);

  await browser.close();
}

main().catch(console.error);
