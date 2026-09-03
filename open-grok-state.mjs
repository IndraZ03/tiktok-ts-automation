import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const statesDir = path.join(process.cwd(), 'grok-states');

function getGrokStates() {
  if (!fs.existsSync(statesDir)) return [];
  return fs.readdirSync(statesDir)
    .filter(file => file.startsWith('grok-state-') && file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
}

function stateLabel(filename) {
  return filename.replace(/^grok-state-/, '').replace(/\.json$/i, '');
}

async function pickState(states) {
  if (states.length === 1) return states[0];

  console.log('Pilih Grok state:');
  states.forEach((file, index) => {
    console.log(`${index + 1}. ${stateLabel(file)} (${file})`);
  });

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question('Nomor state: ')).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && states[index]) return states[index];
      console.log('Pilihan tidak valid.');
    }
  } finally {
    rl.close();
  }
}

const states = getGrokStates();
if (states.length === 0) {
  console.error(`Tidak ada file grok-state-*.json di ${statesDir}`);
  process.exit(1);
}

const selectedState = await pickState(states);
const storageState = path.join(statesDir, selectedState);

console.log(`Membuka Grok Imagine dengan state: ${stateLabel(selectedState)}`);

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  ignoreDefaultArgs: ['--enable-automation']
});

const context = await browser.newContext({
  storageState,
  viewport: { width: 1366, height: 768 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'Asia/Makassar',
  acceptDownloads: true
});

const page = await context.newPage();
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

try {
  await page.goto('https://grok.com/imagine', { waitUntil: 'load', timeout: 60000 });
} catch (error) {
  console.warn(`Peringatan saat membuka Grok: ${error.message}`);
}

console.log('Grok terbuka. Browser akan tetap hidup selama terminal ini belum ditutup.');

const keepAlive = readline.createInterface({ input, output });
try {
  await keepAlive.question('Tekan Enter di terminal ini untuk menutup browser...');
} finally {
  keepAlive.close();
}
await browser.close().catch(() => {});
