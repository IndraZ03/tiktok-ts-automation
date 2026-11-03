import type { Locator, Page } from 'playwright';

type Log = (message: string) => void;
export interface ScheduleTarget { date: string; time: string }
const TIMEOUT = 4000;
const MONTHS = [
  ['january', 'januari'], ['february', 'februari'], ['march', 'maret'], ['april'],
  ['may', 'mei'], ['june', 'juni'], ['july', 'juli'], ['august', 'agustus'],
  ['september'], ['october', 'oktober'], ['november'], ['december', 'desember']
];

export function normalizeSchedule(date: string, time: string): ScheduleTarget {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('Invalid schedule date/time');
  }
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('Invalid schedule date');
  }
  return { date, time: `${time.slice(0, 3)}${String(Math.floor(Number(time.slice(3)) / 5) * 5).padStart(2, '0')}` };
}

async function uniqueVisible(locator: Locator, label: string): Promise<Locator> {
  const visible = locator.filter({ visible: true });
  if (await visible.count() !== 1) throw new Error(`Missing or ambiguous ${label}`);
  return visible;
}

async function waitUnique(locator: Locator, label: string): Promise<Locator> {
  await locator.filter({ visible: true }).first().waitFor({ state: 'visible', timeout: TIMEOUT });
  return uniqueVisible(locator, label);
}

async function actionableClick(locator: Locator): Promise<void> {
  if (!await locator.isEnabled() || await locator.getAttribute('aria-disabled') === 'true') throw new Error('Disabled schedule control');
  await locator.scrollIntoViewIfNeeded({ timeout: TIMEOUT });
  await locator.click({ timeout: TIMEOUT });
}

async function mode(page: Page): Promise<Locator> {
  const native = page.locator('input[name="postSchedule"][value="schedule"]');
  if (await native.count() === 1) return native;
  if (await native.count() > 1) throw new Error('Ambiguous schedule mode');
  return uniqueVisible(page.getByRole('radio', { name: /^(Schedule|Jadwalkan)$/i }), 'schedule mode');
}

async function modeLabel(page: Page, radio: Locator): Promise<Locator> {
  const wrapping = page.locator('label').filter({ has: radio }).filter({ visible: true });
  if (await wrapping.count() === 1) return wrapping;
  const id = await radio.getAttribute('id');
  if (id) {
    const external = page.locator(`label[for="${id}"]`).filter({ visible: true });
    if (await external.count() === 1) return external;
  }
  return uniqueVisible(page.locator('label').filter({ hasText: /^(Schedule|Jadwalkan)$/i }), 'schedule label');
}

async function isModeChecked(radio: Locator): Promise<boolean> {
  return radio.evaluate(el => el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true');
}

async function assertMode(page: Page): Promise<void> {
  const radio = await mode(page);
  if (!await isModeChecked(radio)) throw new Error('Schedule mode not selected');
}

function classifyCandidates(all: Locator[], count: number, values: string[]): { dates: Locator[]; times: Locator[] } {
  const dates: Locator[] = [], times: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const val = values[i];
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) dates.push(all[i]);
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) times.push(all[i]);
  }
  return { dates, times };
}

async function inputs(page: Page): Promise<{ date: Locator; time: Locator }> {
  const primaryLoc = page.locator('.TUXTextInputCore input[readonly], input[data-e2e="schedule-date"], input[data-e2e="schedule-time"]').filter({ visible: true });
  const pCount = await primaryLoc.count();
  if (pCount > 0 && pCount <= 40) {
    const pLocators = Array.from({ length: pCount }, (_, i) => primaryLoc.nth(i));
    const pValues = (await Promise.all(pLocators.map(loc => loc.inputValue()))).map(s => s.trim());
    const primaryClassified = classifyCandidates(pLocators, pCount, pValues);
    if (primaryClassified.dates.length > 1 || primaryClassified.times.length > 1) {
      throw new Error('Ambiguous schedule inputs');
    }
  }

  const allLoc = page.locator('input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"])').filter({ visible: true });
  const count = await allLoc.count();
  if (count > 40) throw new Error('Too many schedule input candidates');
  const locators = Array.from({ length: count }, (_, i) => allLoc.nth(i));
  const values = (await Promise.all(locators.map(loc => loc.inputValue()))).map(s => s.trim());
  const classified = classifyCandidates(locators, count, values);
  if (classified.dates.length !== 1 || classified.times.length !== 1) {
    throw new Error('Missing or ambiguous schedule inputs');
  }
  return { date: classified.dates[0], time: classified.times[0] };
}

async function waitReadyInputs(page: Page): Promise<{ date: Locator; time: Locator }> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    try {
      return await inputs(page);
    } catch {
      await page.waitForTimeout(100);
    }
  }
  return inputs(page);
}

async function assertSchedule(page: Page, target: ScheduleTarget): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      await assertMode(page);
      const fields = await inputs(page);
      if (await fields.date.inputValue() === target.date && await fields.time.inputValue() === target.time) {
        await assertMode(page);
        return;
      }
      lastError = new Error(`Schedule readback mismatch; expected ${target.date} ${target.time}`);
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    await page.waitForTimeout(100);
  }
  throw lastError || new Error(`Schedule readback mismatch; expected ${target.date} ${target.time}`);
}

export async function verifyTikTokSchedule(page: Page, date: string, time: string, log: Log = () => {}): Promise<boolean> {
  try {
    await assertSchedule(page, normalizeSchedule(date, time));
    return true;
  } catch (error) {
    log(`Schedule verification failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function calendarMonth(calendar: Locator): Promise<number> {
  const titles = calendar.locator('.month-title, [class*="month-title"], .year-title, [class*="year-title"]');
  let text = (await titles.filter({ visible: true }).allTextContents()).join(' ');
  if (!/\b\d{4}\b/.test(text)) {
    text = await uniqueVisible(calendar.locator('.title-wrapper, [class*="title-wrapper"]'), 'calendar heading').then(el => el.innerText());
  }
  const years = [...new Set(text.match(/\b\d{4}\b/g) || [])];
  const words = text.toLowerCase().split(/[^a-z]+/);
  const matches = MONTHS.map((names, index) => names.some(name => words.includes(name)) ? index : -1).filter(index => index >= 0);
  if (years.length !== 1 || matches.length !== 1) throw new Error('Calendar year/month missing or ambiguous');
  return Number(years[0]) * 12 + matches[0];
}

async function setDate(page: Page, target: ScheduleTarget): Promise<void> {
  await actionableClick((await inputs(page)).date);
  const calendar = await waitUnique(page.locator('.calendar-wrapper, [class*="calendar-wrapper"]'), 'calendar');
  const [year, month, day] = target.date.split('-').map(Number);
  const desired = year * 12 + month - 1;
  for (let step = 0; ; step++) {
    const current = await calendarMonth(calendar);
    if (current === desired) break;
    if (step >= 24) throw new Error('Calendar navigation limit reached');
    const forward = current < desired;
    let arrow = calendar.getByRole('button', { name: forward ? /^(Next month|Bulan berikutnya)$/i : /^(Previous month|Bulan sebelumnya)$/i }).filter({ visible: true });
    if (await arrow.count() === 0) {
      arrow = calendar.locator(forward ? '.title-wrapper ~ .arrow, [class*="title-wrapper"] ~ [class*="arrow"]' : '.arrow:has(~ .title-wrapper)').filter({ visible: true });
    }
    await actionableClick(await uniqueVisible(arrow, 'calendar navigation'));
    const deadline = Date.now() + TIMEOUT;
    while (await calendarMonth(calendar) === current) {
      if (Date.now() >= deadline) throw new Error('Calendar did not advance');
      await page.waitForTimeout(50);
    }
  }
  const days = calendar.locator('span.day, button.day, [role="gridcell"], span[class*="day"]').filter({ visible: true }).filter({ hasText: new RegExp(`^\\s*${day}\\s*$`) });
  const eligible: Locator[] = [];
  for (let i = 0; i < await days.count(); i++) {
    const candidate = days.nth(i);
    const allowed = await candidate.evaluate((el, date) => {
      const blocked = el.closest('[disabled], [aria-disabled="true"], [data-disabled="true"]');
      const classes = `${el.className} ${el.parentElement?.className || ''}`;
      if (blocked || /invalid|disabled|adjacent|outside|other[-_ ]?month|prev[-_ ]?month|next[-_ ]?month/i.test(classes)) return false;
      const explicit = el.getAttribute('data-date');
      if (explicit) return explicit === date;
      return /(?:^|\s)valid(?:\s|$)/.test(String(el.className)) || el.getAttribute('data-current-month') === 'true';
    }, target.date);
    if (allowed && await candidate.isEnabled()) eligible.push(candidate);
  }
  if (eligible.length !== 1) throw new Error('Missing or ambiguous enabled calendar day');
  await actionableClick(eligible[0]);
  await page.keyboard.press('Escape');
}

export async function setTikTokSchedule(page: Page, date: string, time: string, log: Log = () => {}): Promise<boolean> {
  try {
    const target = normalizeSchedule(date, time);
    const radio = await mode(page);
    const checked = await isModeChecked(radio);
    if (!checked) {
      if (await radio.isVisible()) {
        await actionableClick(radio);
      } else {
        await actionableClick(await modeLabel(page, radio));
      }
    }
    const modeDeadline = Date.now() + TIMEOUT;
    while (!await isModeChecked(radio)) {
      if (Date.now() >= modeDeadline) throw new Error('Schedule mode selection not acknowledged');
      await page.waitForTimeout(100);
    }
    await assertMode(page);
    // Wait for schedule date & time inputs to be ready
    await waitReadyInputs(page);

    // Date selection may reset time. Always set date first, then time.
    await setDate(page, target);
    await actionableClick((await inputs(page)).time);
    const hour = await waitUnique(page.locator('.tiktok-timepicker-left').filter({ hasText: new RegExp(`^\\s*${target.time.slice(0, 2)}\\s*$`) }), 'hour option');
    await actionableClick(hour);
    const minute = await waitUnique(page.locator('.tiktok-timepicker-right').filter({ hasText: new RegExp(`^\\s*${target.time.slice(3)}\\s*$`) }), 'minute option');
    await actionableClick(minute);
    await page.keyboard.press('Escape');
    await assertSchedule(page, target);
    log(`Schedule verified: ${target.date} ${target.time}`);
    return true;
  } catch (error) {
    log(`Schedule setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
