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

  console.log('Waiting for chat-input editor to be visible...');
  const editor = page.locator('[data-testid="chat-input"] [contenteditable="true"]')
    .or(page.locator('[contenteditable="true"]'))
    .first();

  await editor.waitFor({ state: 'visible', timeout: 60000 });
  console.log('Editor is now visible!');
  await page.waitForTimeout(2000);

  // Accept cookies if present
  const acceptCookies = page.getByRole('button', { name: /terima semua cookie|accept all/i }).first();
  if (await acceptCookies.isVisible().catch(() => false)) {
    await acceptCookies.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // 1. Check Video toggle
  console.log('\n--- 1. Checking Video Toggle Button ---');
  const videoToggle = page.getByRole('radio', { name: /video/i })
    .or(page.locator('button[aria-label="Video"]'))
    .or(page.locator('button:has-text("Video")'))
    .first();

  if (await videoToggle.isVisible().catch(() => false)) {
    console.log('Found Video toggle! Clickable state:', await videoToggle.isEnabled());
    await videoToggle.click();
    console.log('Clicked Video toggle!');
    await page.waitForTimeout(2000);
  } else {
    console.log('Video toggle button not found directly. Listing all buttons in form/query-bar...');
  }

  // List all buttons in the query-bar form
  console.log('\n--- 2. Buttons in Query Bar / Form ---');
  const formButtons = await page.locator('form button, div.query-bar button').all();
  console.log(`Found ${formButtons.length} buttons in query bar:`);
  for (let i = 0; i < formButtons.length; i++) {
    const btn = formButtons[i];
    if (await btn.isVisible().catch(() => false)) {
      const text = (await btn.innerText().catch(() => '')).trim().replace(/\n/g, ' ');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      const id = await btn.getAttribute('id').catch(() => '');
      const type = await btn.getAttribute('type').catch(() => '');
      console.log(` [#${i}] text: "${text}" | aria-label: "${ariaLabel}" | id: "${id}" | type: "${type}"`);
    }
  }

  // 3. Test clicking resolution button if present
  console.log('\n--- 3. Testing Resolution Button ---');
  const resBtn = page.locator('button').filter({ hasText: /^(480p|720p|1080p)$/i })
    .or(page.locator('button[aria-label*="Resolusi"], button[aria-label*="Resolution"]'))
    .first();

  if (await resBtn.isVisible().catch(() => false)) {
    console.log('Found Resolution button:', await resBtn.innerText());
    await resBtn.click();
    await page.waitForTimeout(1500);

    const options = await page.locator('[role="menuitemradio"], [role="menuitem"], div.cursor-pointer').all();
    console.log(`Resolution options (${options.length}):`);
    for (const opt of options) {
      if (await opt.isVisible().catch(() => false)) {
        console.log(`  Option: "${(await opt.innerText()).trim()}"`);
      }
    }
    // Select 720p option
    const item720 = page.locator('[role="menuitemradio"]:has-text("720p")').first();
    if (await item720.isVisible().catch(() => false)) {
      await item720.click();
      console.log('Clicked 720p!');
      await page.waitForTimeout(1000);
    } else {
      await page.keyboard.press('Escape');
    }
  } else {
    console.log('Resolution button not found in form buttons.');
  }

  // 4. Test Duration button
  console.log('\n--- 4. Testing Duration Button ---');
  const durBtn = page.locator('button[aria-label="Durasi Video"], button[aria-label="Video Duration"]')
    .or(page.locator('button').filter({ hasText: /^\d+s$/i }))
    .first();

  if (await durBtn.isVisible().catch(() => false)) {
    console.log('Found Duration button:', await durBtn.innerText());
    await durBtn.click();
    await page.waitForTimeout(1500);

    const options = await page.locator('[role="menuitemradio"], [role="menuitem"]').all();
    console.log(`Duration options (${options.length}):`);
    for (const opt of options) {
      if (await opt.isVisible().catch(() => false)) {
        console.log(`  Option: "${(await opt.innerText()).trim()}"`);
      }
    }
    // Select 10s option
    const item10s = page.locator('[role="menuitemradio"]:has-text("10s")').first();
    if (await item10s.isVisible().catch(() => false)) {
      await item10s.click();
      console.log('Clicked 10s!');
      await page.waitForTimeout(1000);
    } else {
      await page.keyboard.press('Escape');
    }
  } else {
    console.log('Duration button not found.');
  }

  // 5. Test Aspect Ratio button
  console.log('\n--- 5. Testing Aspect Ratio Button ---');
  const arBtn = page.locator('button[aria-label="Rasio Aspek"], button[aria-label="Aspect Ratio"]')
    .or(page.locator('button').filter({ hasText: /^(1:1|2:3|3:2|9:16|16:9)$/i }))
    .first();

  if (await arBtn.isVisible().catch(() => false)) {
    console.log('Found Aspect Ratio button:', await arBtn.innerText());
    await arBtn.click();
    await page.waitForTimeout(1500);

    const options = await page.locator('[role="menuitemradio"], [role="menuitem"]').all();
    console.log(`Aspect Ratio options (${options.length}):`);
    for (const opt of options) {
      if (await opt.isVisible().catch(() => false)) {
        console.log(`  Option: "${(await opt.innerText()).trim()}"`);
      }
    }
    // Select 9:16 option
    const item916 = page.locator('[role="menuitemradio"]:has-text("9:16")').first();
    if (await item916.isVisible().catch(() => false)) {
      await item916.click();
      console.log('Clicked 9:16!');
      await page.waitForTimeout(1000);
    } else {
      await page.keyboard.press('Escape');
    }
  } else {
    console.log('Aspect Ratio button not found.');
  }

  // 6. Test Fill Prompt & Check Submit Button
  console.log('\n--- 6. Testing Prompt Editor & Submit Button ---');
  await editor.fill('Cinematic 4K video of a futuristic drone flying over futuristic skyline');
  console.log('Filled prompt successfully!');
  await page.waitForTimeout(1000);

  const submitBtn = page.locator('form button[type="submit"]')
    .or(page.locator('button[aria-label="Kirim"], button[aria-label="Send"], button[aria-label="Submit"]'))
    .last();

  console.log('Submit button visible:', await submitBtn.isVisible().catch(() => false));
  if (await submitBtn.isVisible().catch(() => false)) {
    console.log('Submit button enabled:', await submitBtn.isEnabled().catch(() => false));
  }

  const screenshotPath = path.resolve(process.cwd(), 'grok_composer_tested.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Saved updated screenshot to:', screenshotPath);

  await browser.close();
}

main().catch(console.error);
