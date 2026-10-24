import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { grokBrowserTestHooks as hooks } from '../grok_browser_client.js';

const silent = () => {};
let browser: Browser;

test.before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

test.after(async () => {
  await browser.close();
});

async function fixture(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

test('memilih kontrol radio langsung dan memverifikasi aria-checked', async () => {
  const page = await fixture(`
    <button role="radio" aria-label="Video" aria-checked="false">Video</button>
    <button role="radio" aria-label="720p" aria-checked="false">720p</button>
    <button role="radio" aria-label="10s" aria-checked="false">10s</button>
    <button role="radio" aria-label="9:16" aria-checked="false">9:16</button>
    <script>
      for (const radio of document.querySelectorAll('[role=radio]')) {
        radio.addEventListener('click', () => radio.setAttribute('aria-checked', 'true'));
      }
    </script>
  `);

  await hooks.selectRadio(page, 'Video', silent);
  await hooks.selectRadioOrMenu(page, '720p', /Resolution/i, /p$/, silent);
  await hooks.selectRadioOrMenu(page, '10s', /Duration/i, /s$/, silent);
  await hooks.selectAspectRatio(page, '9:16', silent);
  assert.equal(await page.getByRole('radio', { name: 'Video' }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('radio', { name: '720p' }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('radio', { name: '10s' }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('radio', { name: '9:16' }).getAttribute('aria-checked'), 'true');
  await page.close();
});

test('mendukung dropdown Indonesia/Inggris, audio, upload, prompt, dan submit', async () => {
  const page = await fixture(`
    <form>
      <button type="button" id="resolution" aria-label="Resolusi Video">480p</button>
      <button type="button" id="duration" aria-label="Video Duration">6s</button>
      <button type="button" id="aspect" aria-label="Rasio Aspek">2:3</button>
      <button type="button" id="audio" aria-label="Audio video" aria-pressed="true"></button>
      <input type="file" />
      <div data-testid="chat-input"><div contenteditable="true" role="textbox"></div></div>
      <button type="submit" aria-label="Kirim">Kirim</button>
    </form>
    <div role="menuitemradio" id="r720">720p</div>
    <div role="menuitemradio" id="d10">10s</div>
    <div role="menuitemradio" id="a916">9:16 Vertikal</div>
    <script>
      document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); document.body.dataset.submitted = 'yes'; });
      document.querySelector('#r720').addEventListener('click', () => document.querySelector('#resolution').textContent = '720p');
      document.querySelector('#d10').addEventListener('click', () => document.querySelector('#duration').textContent = '10s');
      document.querySelector('#a916').addEventListener('click', () => document.querySelector('#aspect').textContent = '9:16');
      document.querySelector('#audio').addEventListener('click', event => event.currentTarget.setAttribute('aria-pressed', 'false'));
    </script>
  `);

  await hooks.selectRadioOrMenu(page, '720p', /^(Resolusi Video|Video Resolution)$/i, /p$/, silent);
  await hooks.selectRadioOrMenu(page, '10s', /^(Durasi Video|Video Duration)$/i, /s$/, silent);
  await hooks.selectAspectRatio(page, '9:16', silent);
  await hooks.ensureAudioDisabled(page, silent);
  await hooks.uploadImage(page, path.resolve('bahan/xprime-lily-s24/grok-image-2130f053-0c51-4955-9b63-42da96641604.png'), silent);
  await hooks.fillPrompt(page, 'fixture prompt', silent);
  await hooks.clickGenerate(page, silent);

  assert.equal(await page.locator('#resolution').innerText(), '720p');
  assert.equal(await page.locator('#duration').innerText(), '10s');
  assert.equal(await page.locator('#aspect').innerText(), '9:16');
  assert.equal(await page.locator('#audio').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('[data-testid=chat-input]').innerText(), 'fixture prompt');
  assert.equal(await page.locator('body').getAttribute('data-submitted'), 'yes');
  await page.close();
});

test('mengabaikan generated_video.mp4 lama dan menunggu URL baru', async () => {
  const oldUrl = 'https://assets.grok.com/generated/old/generated_video.mp4';
  const newUrl = 'https://assets.grok.com/generated/new/generated_video.mp4';
  const page = await fixture(`<video src="${oldUrl}"></video><div id="progress">Generating 20%</div>`);
  const existing = await hooks.captureVideoUrls(page);
  assert(existing.has(oldUrl));

  await page.evaluate(url => {
    window.setTimeout(() => {
      document.querySelector('#progress')!.textContent = 'Menghasilkan 70%';
      const video = document.createElement('video');
      video.src = url;
      document.body.appendChild(video);
    }, 100);
  }, newUrl);

  assert.equal(await hooks.waitForVideoResult(page, existing, silent), newUrl);
  await page.close();
});
