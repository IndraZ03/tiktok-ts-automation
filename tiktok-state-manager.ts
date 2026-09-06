// tiktok-state-manager.ts
// Jalankan dengan: npx ts-node tiktok-state-manager.ts
// Atau compile dulu: npx tsc && node dist/tiktok-state-manager.js

import express, { Request, Response } from 'express';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { execa } from 'execa';
import { runUpload, stopUploader, getIsRunning, type SchedulePlanItem } from './tiktok-uploader.js';
import { runFacebookUpload, stopFacebookUploader, getFacebookIsRunning } from './facebook-uploader.js';
import { runGrokGenerator, stopGrokGenerator, getGrokIsRunning, getGrokStats, getBrowserProgress, BrowserProgress, getGrokRateLimits, clearGrokRateLimit, setGrokRateLimit } from './grok-uploader.js';
import { generateGrokVideoV2, createGrokV2Session, closeGrokV2Session, checkGrokQuota, RateLimitError, TooManyRequestsError, GrokStalePageError, type GrokV2Session, type GrokQuotaInfo } from './grok_api_client.js';
import { buildDebugInitScript, attachPageDebugListeners, collectFetchLog, filterFetchLogLegends, dumpFetchLogToFile } from './grokv2-debug.js';
import { generateGrokVideoBrowser } from './grok_browser_client.js';
import { generateVidabotVideo } from './vidabot_api_client.js';
import {
  runVidabotGenerator,
  stopVidabotGenerator,
  getVidabotGenIsRunning,
  getVidabotStats,
  getVidabotBrowserProgress,
  getVidabotRateLimits,
  clearVidabotRateLimit,
  VidabotWorkerProgress
} from './vidabot_generator.js';
import { postTikTokAffiliateVideoApi } from './tiktok_api_post.js';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import { mergeVideosCopyWithOptionalAudio } from './video-merger.js';
import { splitAndProcessVideo, SplitProgressEvent } from './video-splitter.js';
import {
  startWAPolling,
  notifyScheduleStarted as originalNotifyScheduleStarted,
  sendWAMessage as originalSendWAMessage,
  notifyScheduleFinished as originalNotifyScheduleFinished
} from './whatsapp-service.js';

function buildScheduleListMessage(stateName: string, items: SchedulePlanItem[]): string {
  const lines = [`[Schedule ${stateName}]`];
  items.forEach(item => {
    const offset = item.offsetMinutes !== undefined
      ? ` (${item.offsetMinutes >= 0 ? '+' : ''}${item.offsetMinutes} menit)`
      : '';
    lines.push(`${item.index}. ${item.scheduleDate} ${item.scheduleTime}${offset}`);
  });
  return lines.join('\n');
}
import {
  loadLeonardoData,
  saveLeonardoData,
  getFreshJWT,
  fetchCreditBalance,
  uploadInitImage,
  triggerKlingGenerate,
  checkGenerationStatus,
  fetchGenerationVideoUrl,
  downloadVideoToLocal,
  LeonardoAccount,
  LeonardoPrompt
} from './leonardo-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/bahan', express.static(path.join(__dirname, 'bahan')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));


// Multer for bahan image uploads
const bahanUpload = multer({ dest: path.join(__dirname, '_tmp_uploads') });
const mergeUpload = multer({ dest: path.join(__dirname, '_tmp_uploads', 'merge') });

const STATES_DIR = path.join(__dirname, 'tiktok-states');
if (!fs.existsSync(STATES_DIR)) {
  fs.mkdirSync(STATES_DIR, { recursive: true });
}

const GROK_STATES_DIR = path.join(__dirname, 'grok-states');
if (!fs.existsSync(GROK_STATES_DIR)) {
  fs.mkdirSync(GROK_STATES_DIR, { recursive: true });
}

const FB_STATES_DIR = path.join(__dirname, 'facebook-states');
if (!fs.existsSync(FB_STATES_DIR)) {
  fs.mkdirSync(FB_STATES_DIR, { recursive: true });
}

const MERGED_VIDEO_DIR = path.join(__dirname, 'merged-videos');
if (!fs.existsSync(MERGED_VIDEO_DIR)) {
  fs.mkdirSync(MERGED_VIDEO_DIR, { recursive: true });
}

const SPLIT_VIDEO_DIR = path.join(__dirname, 'split-videos');
if (!fs.existsSync(SPLIT_VIDEO_DIR)) {
  fs.mkdirSync(SPLIT_VIDEO_DIR, { recursive: true });
}

// ═══════════════════════════════════════════════════════════
//  YTBOT CONSTANTS
// ═══════════════════════════════════════════════════════════
const YTBOT_DATA_FILE = path.join(__dirname, 'ytbot-data.json');
const YTBOT_VIDEO_DIR = path.join(__dirname, 'ytbot-videos');
if (!fs.existsSync(YTBOT_VIDEO_DIR)) {
  fs.mkdirSync(YTBOT_VIDEO_DIR, { recursive: true });
}

interface YtbotStateConfig {
  ytLinks: string[];
  description: string;
  hashtags: string;
  scheduleDate: string;
  scheduleTime: string;
  intervalMinutes: number;
  lastUploadDate?: string;
  lastUploadTime?: string;
}

interface YtbotData {
  states: Record<string, YtbotStateConfig>;
}

function loadYtbotData(): YtbotData {
  try {
    return JSON.parse(fs.readFileSync(YTBOT_DATA_FILE, 'utf-8'));
  } catch {
    return { states: {} };
  }
}

function saveYtbotData(data: YtbotData) {
  fs.writeFileSync(YTBOT_DATA_FILE, JSON.stringify(data, null, 2));
}

function getYtbotStateVideoDir(stateFile: string): string {
  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const dir = path.join(YTBOT_VIDEO_DIR, stateName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// YTBOT SSE + running state
const ytbotSseClients: Response[] = [];
let ytbotRunning = false;
let ytbotFullAutoRunning = false;
let ytbotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let ytbotProgress = {
  download: 0,
  split: 0,
  upload: 0,
  currentState: '',
  uploadedCount: 0,
  uploadTotal: 0
};

function ytbotLog(msg: string) {
  console.log(`[YTBOT] ${msg}`);
  ytbotSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

function ytbotBroadcastQueue() {
  ytbotSseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(ytbotQueue)}\n\n`));
}

function ytbotBroadcastProgress() {
  ytbotSseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(ytbotProgress)}\n\n`));
}


// Variabel global untuk session yang sedang dibuat (hanya 1 pada satu waktu)
let currentPlatform: 'tiktok' | 'grok' | 'facebook' = 'tiktok';
let currentContext: BrowserContext | null = null;
let currentStateName: string = '';
let currentEditingFilename: string | null = null;
// Ganti fungsi getSavedStates() yang lama dengan ini
function getSavedStates(platform: 'tiktok' | 'grok' | 'facebook' = 'tiktok') {
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');

  const files = fs.readdirSync(dir)
    .filter(file => file.startsWith(prefix) && file.endsWith('.json'));

  return files.map(file => {
    const name = file.replace(prefix, '').replace('.json', '');
    const filepath = path.join(dir, file);

    let expiryInfo = {
      expiresAt: null as string | null,
      daysLeft: null as number | null,
      status: 'unknown' as 'safe' | 'warning' | 'expired' | 'unknown'
    };

    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      const cookies = data.cookies || [];

      // Cari cookie penting TikTok/Facebook
      const importantCookies = ['sessionid', 'sessionid_ss', 'sid_tt', 'ttwid', 'c_user', 'xs', 'datr'];
      let earliestExpiry = Infinity;

      cookies.forEach((cookie: any) => {
        if (importantCookies.includes(cookie.name) && cookie.expires && cookie.expires > 0) {
          if (cookie.expires < earliestExpiry) {
            earliestExpiry = cookie.expires;
          }
        }
      });

      if (earliestExpiry !== Infinity) {
        const expiryDate = new Date(earliestExpiry * 1000); // expires dalam detik -> ms
        const now = Date.now();
        const diffMs = expiryDate.getTime() - now;
        const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        expiryInfo = {
          expiresAt: expiryDate.toLocaleString('id-ID', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          }),
          daysLeft: daysLeft > 0 ? daysLeft : 0,
          status: daysLeft > 7 ? 'safe' : (daysLeft > 0 ? 'warning' : 'expired')
        };
      }
    } catch (e) {
      // kalau file rusak, tetap tampil tanpa expiry
    }

    return { name, filename: file, expiry: expiryInfo };
  });
}

// === GROK INSPECTION ===
// Sesi ini sengaja dipisahkan dari currentContext agar inspector tidak
// mengganggu proses login atau automation lain yang sedang berjalan.
interface GrokInspectionSelection {
  id: number;
  capturedAt: string;
  pageUrl: string;
  tagName: string;
  idAttribute: string;
  className: string;
  text: string;
  ariaLabel: string;
  role: string;
  name: string;
  type: string;
  value: string;
  placeholder: string;
  href: string;
  selector: string;
  xpath: string;
  outerHTML: string;
  attributes: Array<{ name: string; value: string }>;
  rect: { x: number; y: number; width: number; height: number };
  candidates: string[];
  automationCode: string;
}

const grokInspectionClients: Response[] = [];
let grokInspectionBrowser: Browser | null = null;
let grokInspectionContext: BrowserContext | null = null;
let grokInspectionPage: Page | null = null;
let grokInspectionActive = false;
let grokInspectionState = '';
let grokInspectionMode: 'inspect' | 'operate' = 'operate';
let grokInspectionModeRevision = 0;
let grokInspectionSelection: GrokInspectionSelection | null = null;
let grokInspectionSelectionId = 0;

function broadcastGrokInspection(event: string, data: Record<string, unknown> = {}) {
  const payload = JSON.stringify({ event, ...data });
  grokInspectionClients.forEach(client => {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      // Client yang sudah menutup koneksi akan dibersihkan oleh event close.
    }
  });
}

function safeInspectionText(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function isInspectionRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildInspectionAutomationCode(selection: Omit<GrokInspectionSelection, 'id' | 'capturedAt' | 'automationCode'>): string {
  const selector = JSON.stringify(selection.selector || selection.candidates[0] || '*');
  const target = `page.locator(${selector})`;

  if (selection.tagName === 'INPUT' || selection.tagName === 'TEXTAREA') {
    if (selection.type === 'checkbox' || selection.type === 'radio') {
      return `await ${target}.check();`;
    }
    if (selection.type !== 'file') {
      return `await ${target}.fill(${JSON.stringify(selection.value || '')});`;
    }
  }

  if (selection.tagName === 'SELECT') {
    return `await ${target}.selectOption(${JSON.stringify(selection.value || '')});`;
  }

  return `await ${target}.click();`;
}

function normalizeGrokInspectionSelection(payload: unknown): GrokInspectionSelection {
  const item = isInspectionRecord(payload) ? payload : {};
  const rawRect = isInspectionRecord(item.rect) ? item.rect : {};
  const rawAttributes = Array.isArray(item.attributes) ? item.attributes : [];
  const attributes = rawAttributes
    .filter(isInspectionRecord)
    .slice(0, 80)
    .map(attribute => ({
      name: safeInspectionText(attribute.name, 120),
      value: safeInspectionText(attribute.value, 500)
    }))
    .filter(attribute => attribute.name);

  const selection = {
    pageUrl: safeInspectionText(item.pageUrl, 2000),
    tagName: safeInspectionText(item.tagName, 40).toUpperCase(),
    idAttribute: safeInspectionText(item.idAttribute, 300),
    className: safeInspectionText(item.className, 1000),
    text: safeInspectionText(item.text, 1000),
    ariaLabel: safeInspectionText(item.ariaLabel, 500),
    role: safeInspectionText(item.role, 200),
    name: safeInspectionText(item.name, 300),
    type: safeInspectionText(item.type, 100),
    value: safeInspectionText(item.value, 1000),
    placeholder: safeInspectionText(item.placeholder, 500),
    href: safeInspectionText(item.href, 2000),
    selector: safeInspectionText(item.selector, 2000),
    xpath: safeInspectionText(item.xpath, 2000),
    outerHTML: safeInspectionText(item.outerHTML, 6000),
    attributes,
    rect: {
      x: Number(rawRect.x) || 0,
      y: Number(rawRect.y) || 0,
      width: Number(rawRect.width) || 0,
      height: Number(rawRect.height) || 0
    },
    candidates: Array.isArray(item.candidates)
      ? item.candidates.filter(value => typeof value === 'string').slice(0, 12).map(value => value.slice(0, 2000))
      : []
  };

  return {
    ...selection,
    id: ++grokInspectionSelectionId,
    capturedAt: new Date().toISOString(),
    automationCode: buildInspectionAutomationCode(selection)
  };
}

async function closeGrokInspectionBrowser(announce = true) {
  const context = grokInspectionContext;
  const browser = grokInspectionBrowser;
  grokInspectionBrowser = null;
  grokInspectionContext = null;
  grokInspectionPage = null;
  grokInspectionActive = false;
  grokInspectionState = '';
  grokInspectionMode = 'operate';
  grokInspectionModeRevision = 0;

  try {
    if (context) await context.close();
  } catch (error) {
    console.error('[GROK INSPECTION] Gagal menutup context:', error);
  }
  try {
    if (browser) await browser.close();
  } catch (error) {
    console.error('[GROK INSPECTION] Gagal menutup browser:', error);
  }

  if (announce) broadcastGrokInspection('stopped');
}

const GROK_INSPECTION_INIT_SCRIPT = `
(() => {
  if (window.__grokInspectionInstalled) return;
  window.__grokInspectionInstalled = true;

  let mode = 'operate';
  let modeRevision = 0;
  let highlightedElement = null;
  let highlightBox = null;
  let modeBadge = null;
  const inspectionMarker = 'data-grok-inspector-marker';

  const escapeCss = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/([\\\\.#:[\\],>+~*^$|=() ])/g, '\\\\$1');
  };

  const quoteAttribute = (value) => JSON.stringify(String(value));

  const visibleText = (element) => String(element.innerText || element.textContent || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 500);

  const getCssPath = (element) => {
    if (element.id) return '#' + escapeCss(element.id);
    const segments = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body && segments.length < 8) {
      let segment = current.tagName.toLowerCase();
      const testId = current.getAttribute('data-testid') || current.getAttribute('data-test-id');
      if (testId) {
        segment += '[data-testid=' + quoteAttribute(testId) + ']';
      } else {
        const stableClasses = Array.from(current.classList || [])
          .filter((name) => name.length < 80 && !/^\\d/.test(name) && !/^(active|selected|hover|focus|open|closed|disabled)$/.test(name))
          .slice(0, 3);
        if (stableClasses.length) segment += stableClasses.map((name) => '.' + escapeCss(name)).join('');
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (siblings.length > 1) segment += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      segments.unshift(segment);
      current = current.parentElement;
    }
    return segments.join(' > ') || element.tagName.toLowerCase();
  };

  const getXPath = (element) => {
    if (element.id) return '//*[@id=' + quoteAttribute(element.id) + ']';
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 8) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(current.tagName.toLowerCase() + '[' + index + ']');
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  };

  const getCandidates = (element, selector) => {
    const candidates = [];
    if (element.id) candidates.push('#' + escapeCss(element.id));
    const testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');
    if (testId) candidates.push('[data-testid=' + quoteAttribute(testId) + ']');
    const aria = element.getAttribute('aria-label');
    if (aria) candidates.push('[aria-label=' + quoteAttribute(aria) + ']');
    const name = element.getAttribute('name');
    if (name) candidates.push(element.tagName.toLowerCase() + '[name=' + quoteAttribute(name) + ']');
    if (selector) candidates.push(selector);
    return Array.from(new Set(candidates));
  };

  const getTarget = (target) => {
    if (!(target instanceof Element)) return null;
    if (target.closest('[' + inspectionMarker + ']')) return null;
    return target;
  };

  const ensureHighlightBox = () => {
    if (highlightBox || !document.body) return highlightBox;
    highlightBox = document.createElement('div');
    highlightBox.setAttribute(inspectionMarker, 'true');
    highlightBox.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #8b5cf6;background:rgba(139,92,246,.12);box-shadow:0 0 0 1px rgba(255,255,255,.35),0 0 18px rgba(139,92,246,.55);border-radius:4px;transition:all 60ms ease;display:none;';
    document.body.appendChild(highlightBox);
    return highlightBox;
  };

  const reportMode = () => {
    if (typeof window.__reportGrokInspectionMode === 'function') {
      Promise.resolve(window.__reportGrokInspectionMode({ mode, revision: modeRevision })).catch(() => {});
    }
  };

  const ensureModeBadge = () => {
    if (modeBadge || !document.body) return modeBadge;
    modeBadge = document.createElement('div');
    modeBadge.setAttribute(inspectionMarker, 'true');
    modeBadge.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;pointer-events:none;padding:7px 10px;border:1px solid rgba(196,181,253,.45);border-radius:999px;color:#ede9fe;background:rgba(25,18,52,.92);box-shadow:0 8px 25px rgba(0,0,0,.28);font:600 11px/1.2 Arial,sans-serif;letter-spacing:.04em;';
    document.body.appendChild(modeBadge);
    return modeBadge;
  };

  const updateModeBadge = () => {
    const badge = ensureModeBadge();
    if (!badge) return;
    badge.textContent = mode === 'inspect' ? '⌖ INSPECT · Esc untuk operate' : '↗ OPERATE · Esc untuk inspect';
    badge.style.borderColor = mode === 'inspect' ? 'rgba(196,181,253,.45)' : 'rgba(52,211,153,.4)';
    badge.style.color = mode === 'inspect' ? '#ede9fe' : '#a7f3d0';
    badge.style.background = mode === 'inspect' ? 'rgba(25,18,52,.92)' : 'rgba(6,36,30,.92)';
    if (mode === 'operate' && highlightBox) highlightBox.style.display = 'none';
  };

  window.__setGrokInspectionMode = (nextMode) => {
    const next = nextMode === 'operate' ? 'operate' : 'inspect';
    if (next !== mode) modeRevision++;
    mode = next;
    updateModeBadge();
    reportMode();
    return { mode, revision: modeRevision };
  };

  const updateHighlight = (element) => {
    const box = ensureHighlightBox();
    if (!box || !element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { box.style.display = 'none'; return; }
    highlightedElement = element;
    box.style.display = 'block';
    box.style.left = Math.max(0, rect.left - 2) + 'px';
    box.style.top = Math.max(0, rect.top - 2) + 'px';
    box.style.width = Math.max(0, rect.width) + 'px';
    box.style.height = Math.max(0, rect.height) + 'px';
  };

  const report = (element) => {
    const selector = getCssPath(element);
    const attributes = Array.from(element.attributes || []).map((attribute) => ({ name: attribute.name, value: attribute.value }));
    const info = {
      pageUrl: window.location.href,
      tagName: element.tagName,
      idAttribute: element.id || '',
      className: typeof element.className === 'string' ? element.className : '',
      text: visibleText(element),
      ariaLabel: element.getAttribute('aria-label') || '',
      role: element.getAttribute('role') || '',
      name: element.getAttribute('name') || '',
      type: element.getAttribute('type') || '',
      value: 'value' in element ? String(element.value || '') : '',
      placeholder: element.getAttribute('placeholder') || '',
      href: element.href || element.getAttribute('href') || '',
      selector,
      xpath: getXPath(element),
      outerHTML: element.outerHTML || '',
      attributes,
      rect: (() => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
      candidates: getCandidates(element, selector)
    };
    if (typeof window.__reportGrokInspection === 'function') {
      Promise.resolve(window.__reportGrokInspection(info)).catch(() => {});
    }
  };

  document.addEventListener('mousemove', (event) => {
    if (mode === 'inspect' || event.altKey) updateHighlight(getTarget(event.target));
    else if (highlightBox) highlightBox.style.display = 'none';
  }, true);

  document.addEventListener('click', (event) => {
    if (mode !== 'inspect' && !event.altKey) return;
    const element = getTarget(event.target);
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    updateHighlight(element);
    report(element);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      mode = mode === 'inspect' ? 'operate' : 'inspect';
      modeRevision++;
      updateModeBadge();
      reportMode();
    }
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { updateModeBadge(); reportMode(); }, { once: true });
  } else {
    updateModeBadge();
    reportMode();
  }
})();
`;

// ═══════════════════════════════════════════════════════════
//  FBBOT CONSTANTS & PERSISTENCE
// ═══════════════════════════════════════════════════════════
const FBBOT_DATA_FILE = path.join(__dirname, 'fbbot-data.json');
const FBBOT_VIDEO_DIR = path.join(__dirname, 'fbbot-videos');
if (!fs.existsSync(FBBOT_VIDEO_DIR)) {
  fs.mkdirSync(FBBOT_VIDEO_DIR, { recursive: true });
}

interface FbbotStateConfig {
  ytLinks: string[];
  description: string;
  scheduleDate: string;
  scheduleTime: string;
  intervalMinutes: number;
  headless?: boolean;
}

interface FbbotData {
  states: Record<string, FbbotStateConfig>;
}

function loadFbbotData(): FbbotData {
  try {
    return JSON.parse(fs.readFileSync(FBBOT_DATA_FILE, 'utf-8'));
  } catch {
    return { states: {} };
  }
}

function saveFbbotData(data: FbbotData) {
  fs.writeFileSync(FBBOT_DATA_FILE, JSON.stringify(data, null, 2));
}

// FBBOT SSE + running state
const fbbotSseClients: Response[] = [];
let fbbotRunning = false;
let fbbotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let fbbotProgress = {
  download: 0,
  split: 0,
  upload: 0,
  currentState: ''
};

function fbbotLog(msg: string) {
  console.log(`[FBBOT] ${msg}`);
  fbbotSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

function fbbotBroadcastQueue() {
  fbbotSseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(fbbotQueue)}\n\n`));
}

function fbbotBroadcastProgress() {
  fbbotSseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(fbbotProgress)}\n\n`));
}

function getFbbotStateVideoDir(stateFile: string): string {
  const stateName = stateFile.replace('facebook-state-', '').replace('.json', '');
  const dir = path.join(FBBOT_VIDEO_DIR, stateName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// === API ROUTES ===
app.get('/api/states', (req, res) => {
  const platform = req.query.platform === 'grok' ? 'grok' : (req.query.platform === 'facebook' ? 'facebook' : 'tiktok');
  res.json(getSavedStates(platform));
});

// === Grok Element Inspector APIs ===
app.get('/api/grokinspection/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = res;
  grokInspectionClients.push(client);
  client.write(`data: ${JSON.stringify({
    event: 'status',
    active: grokInspectionActive,
    state: grokInspectionState,
    mode: grokInspectionMode,
    selection: grokInspectionSelection
  })}\n\n`);

  req.on('close', () => {
    const index = grokInspectionClients.indexOf(client);
    if (index >= 0) grokInspectionClients.splice(index, 1);
  });
});

app.get('/api/grokinspection/status', (req, res) => {
  res.json({
    active: grokInspectionActive,
    state: grokInspectionState,
    mode: grokInspectionMode,
    url: grokInspectionPage?.url() || '',
    selection: grokInspectionSelection
  });
});

app.post('/api/grokinspection/start', async (req, res) => {
  const filename = typeof req.body?.filename === 'string' ? req.body.filename : '';

  if (!filename || path.basename(filename) !== filename || !filename.startsWith('grok-state-') || !filename.endsWith('.json')) {
    return res.status(400).json({ error: 'Pilih state Grok yang valid.' });
  }

  const filepath = path.join(GROK_STATES_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File state Grok tidak ditemukan.' });
  }

  await closeGrokInspectionBrowser(false);
  grokInspectionSelection = null;
  grokInspectionMode = 'operate';
  grokInspectionModeRevision = 0;
  grokInspectionState = filename.replace(/^grok-state-/, '').replace(/\.json$/, '');

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({
      headless: false,
      slowMo: 100,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ignoreDefaultArgs: ['--enable-automation']
    });

    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: { 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
      storageState: filepath
    });

    await context.addInitScript({ content: GROK_INSPECTION_INIT_SCRIPT });
    const page = await context.newPage();
    await page.exposeFunction('__reportGrokInspection', (payload: unknown) => {
      grokInspectionSelection = normalizeGrokInspectionSelection(payload);
      broadcastGrokInspection('selection', { selection: grokInspectionSelection });
    });
    await page.exposeFunction('__reportGrokInspectionMode', (payload: unknown) => {
      const reportedMode = isInspectionRecord(payload) ? payload.mode : payload;
      const reportedRevision = isInspectionRecord(payload) && typeof payload.revision === 'number' ? payload.revision : 0;
      if (reportedRevision < grokInspectionModeRevision) return;
      grokInspectionModeRevision = reportedRevision;
      grokInspectionMode = reportedMode === 'operate' ? 'operate' : 'inspect';
      broadcastGrokInspection('mode', { mode: grokInspectionMode });
    });

    grokInspectionBrowser = browser;
    grokInspectionContext = context;
    grokInspectionPage = page;
    grokInspectionActive = true;
    broadcastGrokInspection('opening', { state: grokInspectionState });

    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        grokInspectionMode = 'operate';
        grokInspectionModeRevision = 0;
        broadcastGrokInspection('mode', { mode: grokInspectionMode });
        broadcastGrokInspection('navigated', { url: frame.url() });
      }
    });
    page.on('close', () => {
      if (grokInspectionPage === page && grokInspectionActive) {
        grokInspectionActive = false;
        grokInspectionPage = null;
        broadcastGrokInspection('browser-closed');
      }
    });

    await page.goto('https://grok.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    broadcastGrokInspection('started', { state: grokInspectionState, mode: grokInspectionMode, url: page.url() });
    res.json({ success: true, state: grokInspectionState, mode: grokInspectionMode, url: page.url() });
  } catch (error: any) {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    grokInspectionBrowser = null;
    grokInspectionContext = null;
    grokInspectionPage = null;
    grokInspectionActive = false;
    grokInspectionState = '';
    grokInspectionMode = 'operate';
    grokInspectionModeRevision = 0;
    broadcastGrokInspection('error', { message: error?.message || 'Gagal membuka browser inspector.' });
    res.status(500).json({ error: 'Gagal membuka browser inspector: ' + (error?.message || 'unknown error') });
  }
});

app.post('/api/grokinspection/mode', async (req, res) => {
  const requestedMode = req.body?.mode === 'operate' ? 'operate' : 'inspect';
  if (!grokInspectionPage || !grokInspectionActive) {
    return res.status(400).json({ error: 'Browser inspector belum aktif.' });
  }

  try {
    const result = await grokInspectionPage.evaluate((nextMode: string) => {
      const setMode = (window as any).__setGrokInspectionMode;
      return typeof setMode === 'function' ? setMode(nextMode) : nextMode;
    }, requestedMode);
    const modeResult = isInspectionRecord(result) ? result : { mode: result, revision: grokInspectionModeRevision + 1 };
    grokInspectionMode = modeResult.mode === 'operate' ? 'operate' : 'inspect';
    if (typeof modeResult.revision === 'number') grokInspectionModeRevision = Math.max(grokInspectionModeRevision, modeResult.revision);
    broadcastGrokInspection('mode', { mode: grokInspectionMode });
    res.json({ success: true, mode: grokInspectionMode });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Gagal mengganti mode inspector.' });
  }
});

app.post('/api/grokinspection/stop', async (req, res) => {
  await closeGrokInspectionBrowser();
  res.json({ success: true });
});

app.post('/api/grokinspection/clear', (req, res) => {
  grokInspectionSelection = null;
  broadcastGrokInspection('selection-cleared');
  res.json({ success: true });
});

app.post('/api/start-login', async (req, res) => {
  const { name, platform = 'tiktok' } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Nama state harus diisi!' });
  }

  if (currentContext) {
    await currentContext.close();
  }

  currentStateName = name.trim();
  currentPlatform = platform as 'tiktok' | 'grok' | 'facebook';

  try {
    // â”€â”€â”€â”€â”€â”€â”€â”€ LAUNCH BROWSER (ini yang diperbaiki) â”€â”€â”€â”€â”€â”€â”€â”€
    const browser = await chromium.launch({
      headless: false,
      slowMo: 150,
      channel: 'chrome',                    // pakai Google Chrome asli
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
      ignoreDefaultArgs: ['--enable-automation'],   // â† dipindah ke sini
    });

    // â”€â”€â”€â”€â”€â”€â”€â”€ NEW CONTEXT â”€â”€â”€â”€â”€â”€â”€â”€
    currentContext = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
    });

    const page = await currentContext.newPage();

    // Stealth tambahan (hapus jejak automation)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (window as any).chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
    });

    const url = currentPlatform === 'grok' ? 'https://accounts.x.ai/sign-in?redirect=grok-com' : (currentPlatform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log(`âœ… Browser stealth dibuka untuk state: ${currentStateName}`);
    res.json({
      success: true,
      message: 'Browser stealth sudah terbuka!\nSilakan login manual.\nSetelah login selesai, klik tombol "Sudah Login" di web.'
    });
  } catch (err: any) {
    console.error(err);
    currentContext = null;
    res.status(500).json({ error: 'Gagal membuka browser: ' + err.message });
  }
});

app.post('/api/start-login-with-state', async (req, res) => {
  const { filename, platform = 'tiktok' } = req.body;

  if (!filename) return res.status(400).json({ error: 'Filename diperlukan' });

  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File state tidak ditemukan' });
  }

  if (currentContext) await currentContext.close();

  currentEditingFilename = filename;
  currentStateName = ''; // tidak pakai nama baru
  currentPlatform = platform as 'tiktok' | 'grok' | 'facebook';

  try {
    const browser = await chromium.launch({
      headless: false,
      slowMo: 150,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    currentContext = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: { 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
      storageState: filepath,   // â† langsung load session yang sudah ada
    });

    const page = await currentContext.newPage();
    const url = currentPlatform === 'grok' ? 'https://grok.com' : (currentPlatform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    res.json({ success: true, message: `âœ… Browser terbuka dengan session: ${filename}\nLakukan apa saja, lalu klik "Sudah Login"` });
  } catch (err: any) {
    currentContext = null;
    currentEditingFilename = null;
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/open-state', async (req, res) => {
  const { name, platform = 'tiktok' } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Nama state harus diisi!' });
  }

  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const filename = `${prefix}${name}.json`;
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'State tidak ditemukan!' });
  }

  try {
    const browser = await chromium.launch({
      headless: false,
      slowMo: 150,
      channel: 'chrome',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Makassar',
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
      storageState: filepath
    });

    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const url = platform === 'grok' ? 'https://grok.com' : (platform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log(`✅ Browser dibuka dengan state: ${name}`);
    res.json({ success: true, message: 'Browser berhasil dibuka' });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Gagal membuka browser: ' + err.message });
  }
});

// Launch Google Chrome directly via CMD (without Playwright) + inject cookies from state JSON
app.post('/api/start-native-chrome', async (req, res) => {
  const { name, filename, platform = 'tiktok' } = req.body;
  let stateName = name ? name.trim() : '';
  if (!stateName && filename) {
    stateName = filename.replace(/^(tiktok|grok|facebook)-state-/, '').replace(/\.json$/i, '');
  }

  if (!stateName) {
    return res.status(400).json({ error: 'Nama state/session harus diisi!' });
  }

  const cleanStateName = stateName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const profileDir = path.join(__dirname, 'chrome-profiles', `${platform}_${cleanStateName}`);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  // Find state file to inject cookies into Chrome profile if exists
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  let stateFilePath = '';
  if (filename) {
    stateFilePath = path.join(dir, filename);
  } else if (stateName) {
    const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
    stateFilePath = path.join(dir, `${prefix}${stateName}.json`);
  }

  if (stateFilePath && fs.existsSync(stateFilePath)) {
    try {
      console.log(`[NATIVE CHROME CMD] Menginjeksi cookie dari ${path.basename(stateFilePath)} ke profil Chrome...`);
      const stateContent = fs.readFileSync(stateFilePath, 'utf-8');
      const stateData = JSON.parse(stateContent);

      if (stateData.cookies && Array.isArray(stateData.cookies) && stateData.cookies.length > 0) {
        const pContext = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          channel: 'chrome',
          args: ['--no-sandbox']
        });
        await pContext.addCookies(stateData.cookies);
        await pContext.close();
        console.log(`✓ Cookie (${stateData.cookies.length} item) berhasil diinjeksi ke profil Chrome CMD!`);
      }
    } catch (e: any) {
      console.error(`⚠ Gagal menginjeksi cookie dari file JSON: ${e.message}`);
    }
  }

  const targetUrl = platform === 'grok' 
    ? 'https://grok.com' 
    : (platform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com/tiktokstudio/upload');

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  let chromeExe = chromePaths.find(p => fs.existsSync(p));

  try {
    let command = '';
    if (chromeExe) {
      command = `"${chromeExe}" --user-data-dir="${profileDir}" "${targetUrl}"`;
    } else {
      command = `start chrome --user-data-dir="${profileDir}" "${targetUrl}"`;
    }

    console.log(`[NATIVE CHROME CMD] Running: ${command}`);
    exec(command, { shell: 'cmd.exe' }, (err) => {
      if (err) console.error('[NATIVE CHROME CMD ERROR]', err);
    });

    res.json({
      success: true,
      message: `✅ Chrome Native (CMD tanpa Playwright) terbuka!\nProfile: chrome-profiles/${platform}_${cleanStateName}\n\nSession/Cookies telah dimuat dari file state! Silakan gunakan dengan normal.`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal menjalankan Chrome via CMD: ' + err.message });
  }
});

// Sync/Export Chrome CMD profile session back to state JSON file
app.post('/api/sync-native-chrome', async (req, res) => {
  const { filename, name, platform = 'tiktok' } = req.body;
  let stateName = name ? name.trim() : '';
  if (!stateName && filename) {
    stateName = filename.replace(/^(tiktok|grok|facebook)-state-/, '').replace(/\.json$/i, '');
  }

  if (!stateName) return res.status(400).json({ error: 'Nama state/session harus diisi!' });

  const cleanStateName = stateName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const profileDir = path.join(__dirname, 'chrome-profiles', `${platform}_${cleanStateName}`);
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
  const targetFilename = filename || `${prefix}${stateName}.json`;
  const targetFilepath = path.join(dir, targetFilename);

  try {
    const pContext = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      channel: 'chrome',
      args: ['--no-sandbox']
    });
    await pContext.storageState({ path: targetFilepath });
    await pContext.close();

    res.json({
      success: true,
      message: `✅ Sesi dari Chrome CMD berhasil disinkronkan & disimpan ke ${targetFilename}!`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal mengekspor sesi dari Chrome CMD: ' + err.message });
  }
});

app.post('/api/save-login', async (req, res) => {
  if (!currentContext) {
    return res.status(400).json({ error: 'Tidak ada session yang sedang dibuat!' });
  }

  const prefix = currentPlatform === 'grok' ? 'grok-state-' : (currentPlatform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
  const dir = currentPlatform === 'grok' ? GROK_STATES_DIR : (currentPlatform === 'facebook' ? FB_STATES_DIR : STATES_DIR);

  let filename: string;
  if (currentEditingFilename) {
    filename = currentEditingFilename;                    // update session lama
  } else {
    filename = `${prefix}${currentStateName}.json`;   // state baru
  }

  const filepath = path.join(dir, filename);

  try {
    await currentContext.storageState({ path: filepath });
    await currentContext.close();

    currentContext = null;
    currentStateName = '';
    currentEditingFilename = null;

    res.json({
      success: true,
      message: `âœ… Session berhasil disimpan ke ${filename}`,
      filename
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menyimpan session' });
  }
});
// === API untuk generate command codegen dengan session ===
app.get('/api/codegen-command', (req, res) => {
  const { filename, platform = 'tiktok' } = req.query;
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'Filename diperlukan' });
  }

  const dir = platform === 'grok' ? 'grok-states' : (platform === 'facebook' ? 'facebook-states' : 'tiktok-states');
  const url = platform === 'grok' ? 'https://grok.com' : (platform === 'facebook' ? 'https://www.facebook.com' : 'https://www.tiktok.com');

  const command = `npx playwright codegen \\
  --config playwright.config.ts \\
  --target typescript \\
  --load-storage=${dir}/${filename} \\
  ${url}`;

  res.json({ command });
});

// === TikTok Auto Uploader APIs ===
const sseClients: Response[] = [];

function broadcastLog(msg: string) {
  console.log(`[UPLOADER] ${msg}`);
  sseClients.forEach(client => {
    client.write(`data: ${msg}\n\n`);
  });
}

// SSE endpoint for live logs
app.get('/api/tiktok/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// Browse folder dialog (Windows PowerShell)
app.get('/api/browse-folder', (req, res) => {
  const psScript = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Pilih folder video'; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}`;
  exec(`powershell -NoProfile -Command "${psScript}"`, { timeout: 120000 }, (err, stdout) => {
    if (err) {
      return res.json({ success: false, folder: '' });
    }
    const folder = (stdout || '').trim();
    res.json({ success: !!folder, folder });
  });
});

// List videos in a folder
app.get('/api/tiktok/videos', (req, res) => {
  const folder = req.query.folder as string;
  if (!folder || !fs.existsSync(folder)) {
    return res.json({ videos: [] });
  }
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const videos = fs.readdirSync(folder)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort();
  res.json({ videos });
});

// Get uploaded marks for a folder
app.get('/api/tiktok/uploaded', (req, res) => {
  const folder = req.query.folder as string;
  if (!folder) return res.json({ uploaded: {} });
  const marksFile = path.join(folder, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  res.json({ uploaded: marks });
});

// Mark/unmark a video as uploaded
app.post('/api/tiktok/mark-uploaded', (req, res) => {
  const { folder, video, uploaded } = req.body;
  if (!folder || !video) return res.status(400).json({ error: 'Missing params' });
  const marksFile = path.join(folder, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  if (uploaded) {
    marks[video] = true;
  } else {
    delete marks[video];
  }
  fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
  res.json({ success: true });
});

// Delete uploaded video file + remove mark
app.post('/api/tiktok/delete-uploaded-video', (req, res) => {
  const { folder, video } = req.body;
  if (!folder || !video) return res.status(400).json({ error: 'Missing params' });
  const filepath = path.join(folder, video);
  if (fs.existsSync(filepath)) {
    try { fs.unlinkSync(filepath); } catch {}
  }
  // Also remove from uploaded marks
  const marksFile = path.join(folder, '.uploaded.json');
  try {
    const marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8'));
    delete marks[video];
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
  } catch {}
  res.json({ success: true });
});

// Start upload (multi-video sequential)
app.post('/api/tiktok/start', async (req, res) => {
  if (getIsRunning()) {
    return res.status(400).json({ success: false, error: 'Upload sedang berjalan!' });
  }
  const config = {
    ...req.body,
    statesDir: STATES_DIR,
  };

  // Callback: mark video as uploaded + broadcast event
  const onVideoUploaded = (videoFilename: string) => {
    const marksFile = path.join(config.videoFolder, '.uploaded.json');
    let marks: Record<string, boolean> = {};
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
    marks[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
    broadcastLog(`[VIDEO_UPLOADED]:${videoFilename}`);
  };

  res.json({ success: true, message: 'Upload dimulai' });
  // Run in background with onVideoUploaded callback
  runUpload(config, broadcastLog, onVideoUploaded).then(() => {
    broadcastLog('===== UPLOAD PROCESS FINISHED =====');
  }).catch(e => {
    broadcastLog('âŒ Fatal: ' + e.message);
  });
});

// Stop upload
app.post('/api/tiktok/stop', async (req, res) => {
  await stopUploader();
  res.json({ success: true, message: 'Upload dihentikan' });
});

async function extractTokopediaProductName(url: string): Promise<string> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for redirect to happen (if we are on vt.tokopedia.com)
    try {
      await page.waitForURL(u => !u.toString().includes('vt.tokopedia.com'), { timeout: 10000 });
    } catch (err) {}

    // Wait 2 seconds for hydration
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    let productName = '';

    // 1. Try extracting from URL og_info parameter
    try {
      const urlObj = new URL(currentUrl);
      const ogInfoParam = urlObj.searchParams.get('og_info');
      if (ogInfoParam) {
        const ogInfo = JSON.parse(decodeURIComponent(ogInfoParam));
        if (ogInfo && ogInfo.title) {
          productName = ogInfo.title;
        }
      }
    } catch (err) {
      console.error('[NAMAPRODUK] Gagal parse og_info dari URL:', err);
    }

    // 2. Try DOM selectors if not found in URL (e.g. if it redirected to a standard desktop page)
    if (!productName) {
      try {
        await page.waitForSelector('[data-fmp="true"]', { timeout: 5000 });
        productName = await page.locator('[data-fmp="true"]').first().innerText();
      } catch (e) {
        const fallbacks = [
          'h1[data-testid="lblPDPProductName"]',
          '[data-testid="pdpProductName"]',
          'h1'
        ];
        for (const selector of fallbacks) {
          try {
            const loc = page.locator(selector).first();
            if (await loc.isVisible()) {
              productName = await loc.innerText();
              if (productName.trim()) break;
          }
          } catch {}
        }
      }
    }

    return productName.trim();
  } finally {
    await browser.close();
  }
}

app.post('/api/namaproduk', async (req: Request, res: Response) => {
  const url = req.body?.url || req.query?.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'url wajib diisi.' });
  }

  try {
    const name = await extractTokopediaProductName(url);
    if (name) {
      res.json({ success: true, name });
    } else {
      res.status(404).json({ success: false, error: 'Gagal mengambil nama produk. Elemen tidak ditemukan.' });
    }
  } catch (error: any) {
    console.error('[NAMAPRODUK] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Terjadi kesalahan saat memproses link.' });
  }
});

app.get('/api/namaproduk', async (req: Request, res: Response) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'url wajib diisi.' });
  }

  try {
    const name = await extractTokopediaProductName(url);
    if (name) {
      res.json({ success: true, name });
    } else {
      res.status(404).json({ success: false, error: 'Gagal mengambil nama produk. Elemen tidak ditemukan.' });
    }
  } catch (error: any) {
    console.error('[NAMAPRODUK] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Terjadi kesalahan saat memproses link.' });
  }
});

function sanitizeFilename(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function progressBar(percent: number, width = 20): string {
  const safePercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((safePercent / 100) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${safePercent.toFixed(1)}%`;
}

function ensureFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static tidak menemukan binary ffmpeg.');
  }
  return ffmpegPath;
}

app.get('/bahan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bahan.html'));
});

app.post('/api/bahan/download', async (req, res) => {
  const { pairs, outputDir: clientOutputDir } = req.body;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ success: false, error: 'Pairs harus diisi dan berupa array.' });
  }

  const outputDir = clientOutputDir ? path.resolve(clientOutputDir) : 'C:/tiktok-ts-automation/bahan-campaign';
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let activeProcess: any = null;
  let isAborted = false;
  let isCleanFinished = false;

  res.on('close', () => {
    if (isCleanFinished) return;
    isAborted = true;
    console.log('[BAHAN-DOWNLOAD] Client disconnected. Aborting process.');
    if (activeProcess) {
      try {
        activeProcess.kill();
      } catch (err) {}
    }
  });

  const ffmpegDir = path.dirname(ensureFfmpegPath());
  const env = {
    ...process.env,
    PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`
  };

  const runTempDir = path.join(__dirname, '_tmp_uploads', `bahan-${Date.now()}`);
  fs.mkdirSync(runTempDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const total = pairs.length;
    let completed = 0;

    for (let i = 0; i < total; i++) {
      if (isAborted) break;

      const { videoUrl, audioUrl } = pairs[i];
      const videoNum = i + 1;
      
      sendEvent('progress', {
        step: 'info',
        completed,
        total,
        message: `[${videoNum}/${total}] Memulai pengolahan pasangan ke-${videoNum}...`
      });

      if (!videoUrl) {
        sendEvent('progress', {
          step: 'error',
          completed,
          total,
          message: `[${videoNum}/${total}] Link video kosong. Dilewati.`
        });
        continue;
      }

      // Step 1: Ambil title video via yt-dlp dump-json
      let videoTitle = `video_${Date.now()}_${i}`;
      sendEvent('progress', {
        step: 'metadata',
        completed,
        total,
        message: `[${videoNum}/${total}] Mengambil judul video...`
      });

      try {
        const metadataProcess = execa('yt-dlp', ['--dump-json', '--no-playlist', videoUrl], { windowsHide: true });
        activeProcess = metadataProcess;
        const { stdout } = await metadataProcess;
        const metadata = JSON.parse(stdout);
        if (metadata.title) {
          videoTitle = sanitizeFilename(metadata.title);
        }
      } catch (metaErr: any) {
        sendEvent('progress', {
          step: 'warn',
          completed,
          total,
          message: `[${videoNum}/${total}] Gagal mengambil judul video: ${metaErr.message}. Menggunakan nama default.`
        });
      }

      activeProcess = null;
      if (isAborted) break;

      // Step 2: Download video
      const rawVideoPath = path.join(runTempDir, `temp_video_${i}.mp4`);
      sendEvent('progress', {
        step: 'download_video',
        percent: 0,
        completed,
        total,
        message: `[${videoNum}/${total}] Mengunduh video: "${videoTitle}"...`
      });

      try {
        const downloadProcess = execa('yt-dlp', [
          '--newline',
          '--no-playlist',
          '--ffmpeg-location',
          ffmpegDir,
          '-f',
          'bv*[vcodec^=avc]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',
          '--merge-output-format',
          'mp4',
          '-o',
          rawVideoPath,
          videoUrl
        ], {
          all: true,
          buffer: false,
          windowsHide: true,
          env
        });

        activeProcess = downloadProcess;

        if (downloadProcess.all) {
          downloadProcess.all.setEncoding('utf8');
          downloadProcess.all.on('data', chunk => {
            const lines = String(chunk).split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
              const match = line.match(/\[download]\s+(\d+(?:\.\d+)?)%/);
              if (match) {
                const percent = Number(match[1]);
                sendEvent('progress', {
                  step: 'download_video',
                  percent,
                  completed,
                  total,
                  message: `[${videoNum}/${total}] Unduh video ${progressBar(percent)}`
                });
              }
            }
          });
        }

        await downloadProcess;
      } catch (dlErr: any) {
        sendEvent('progress', {
          step: 'error',
          completed,
          total,
          message: `[${videoNum}/${total}] Gagal mengunduh video: ${dlErr.message}. Pasangan dilewati.`
        });
        continue;
      }

      activeProcess = null;
      if (isAborted) break;

      // Step 3: Mute video
      const mutedVideoPath = path.join(runTempDir, `temp_video_muted_${i}.mp4`);
      sendEvent('progress', {
        step: 'mute_video',
        completed,
        total,
        message: `[${videoNum}/${total}] Meringkas audio video asli (mute)...`
      });

      try {
        const muteProcess = execa(ensureFfmpegPath(), [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          rawVideoPath,
          '-an',
          '-c:v',
          'copy',
          '-y',
          mutedVideoPath
        ], { windowsHide: true });
        
        activeProcess = muteProcess;
        await muteProcess;
      } catch (muteErr: any) {
        sendEvent('progress', {
          step: 'error',
          completed,
          total,
          message: `[${videoNum}/${total}] Gagal menonaktifkan suara video: ${muteErr.message}. Pasangan dilewati.`
        });
        continue;
      }

      activeProcess = null;
      if (isAborted) break;

      // Step 4: Download music (MP3) if audioUrl is provided
      let finalAudioPath = '';
      if (audioUrl) {
        finalAudioPath = path.join(runTempDir, `temp_audio_${i}.mp3`);
        sendEvent('progress', {
          step: 'download_audio',
          percent: 0,
          completed,
          total,
          message: `[${videoNum}/${total}] Mengunduh musik pendukung...`
        });

        try {
          const audioProcess = execa('yt-dlp', [
            '--newline',
            '--no-playlist',
            '--ffmpeg-location',
            ffmpegDir,
            '-x',
            '--audio-format',
            'mp3',
            '--audio-quality',
            '0',
            '-o',
            finalAudioPath,
            audioUrl
          ], {
            all: true,
            buffer: false,
            windowsHide: true,
            env
          });

          activeProcess = audioProcess;

          if (audioProcess.all) {
            audioProcess.all.setEncoding('utf8');
            audioProcess.all.on('data', chunk => {
              const lines = String(chunk).split(/\r?\n/).filter(Boolean);
              for (const line of lines) {
                const match = line.match(/\[download]\s+(\d+(?:\.\d+)?)%/);
                if (match) {
                  const percent = Number(match[1]);
                  sendEvent('progress', {
                    step: 'download_audio',
                    percent,
                    completed,
                    total,
                    message: `[${videoNum}/${total}] Unduh musik ${progressBar(percent)}`
                  });
                }
              }
            });
          }

          await audioProcess;
        } catch (audErr: any) {
          sendEvent('progress', {
            step: 'error',
            completed,
            total,
            message: `[${videoNum}/${total}] Gagal mengunduh musik: ${audErr.message}. Menggunakan video tanpa suara baru.`
          });
          finalAudioPath = '';
        }
      }

      activeProcess = null;
      if (isAborted) break;

      // Step 5: Gabungkan muted video dengan audio (atau simpan muted video langsung jika tidak ada musik)
      let finalOutputPath = path.join(outputDir, `${videoTitle}.mp4`);
      let counter = 1;
      while (fs.existsSync(finalOutputPath)) {
        finalOutputPath = path.join(outputDir, `${videoTitle}_${counter}.mp4`);
        counter++;
      }

      if (finalAudioPath && fs.existsSync(finalAudioPath)) {
        sendEvent('progress', {
          step: 'merge',
          completed,
          total,
          message: `[${videoNum}/${total}] Menggabungkan video dengan musik...`
        });

        try {
          const mergeProcess = execa(ensureFfmpegPath(), [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            mutedVideoPath,
            '-i',
            finalAudioPath,
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-shortest',
            '-y',
            finalOutputPath
          ], { windowsHide: true });
          
          activeProcess = mergeProcess;
          await mergeProcess;
        } catch (mergeErr: any) {
          sendEvent('progress', {
            step: 'error',
            completed,
            total,
            message: `[${videoNum}/${total}] Gagal menggabungkan musik ke video: ${mergeErr.message}. Menyimpan video bisu.`
          });
          // Fallback: save the muted video directly
          try {
            fs.copyFileSync(mutedVideoPath, finalOutputPath);
          } catch (copyErr) {
            console.error('Failed to copy muted video fallback:', copyErr);
          }
        }
      } else {
        // No music, just save muted video
        sendEvent('progress', {
          step: 'save',
          completed,
          total,
          message: `[${videoNum}/${total}] Menyimpan video bisu...`
        });
        try {
          fs.copyFileSync(mutedVideoPath, finalOutputPath);
        } catch (copyErr: any) {
          sendEvent('progress', {
            step: 'error',
            completed,
            total,
            message: `[${videoNum}/${total}] Gagal menyimpan video bisu: ${copyErr.message}`
          });
          continue;
        }
      }

      activeProcess = null;
      completed++;
      sendEvent('progress', {
        step: 'success',
        completed,
        total,
        message: `[${videoNum}/${total}] Berhasil memproses video: "${path.basename(finalOutputPath)}"`
      });
    }

    // Cleanup temp dir
    try {
      fs.rmSync(runTempDir, { recursive: true, force: true });
    } catch {}

    sendEvent('done', {
      success: true,
      completed,
      total,
      message: `Selesai! Berhasil memproses ${completed} dari ${total} video.`
    });

    isCleanFinished = true;
  } catch (err: any) {
    console.error('[BAHAN-DOWNLOAD] Fatal:', err);
    sendEvent('error', {
      success: false,
      error: err.message || 'Terjadi kesalahan sistem saat memproses.'
    });
  } finally {
    res.end();
  }
});

app.get('/tiktok', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tiktok.html'));
});
app.get('/grok', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grok.html'));
});

app.get('/grokinspection', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grokinspection.html'));
});

app.get('/merge', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'merge.html'));
});

app.get('/namaproduk', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'namaproduk.html'));
});

app.get('/splitter', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YouTube Splitter</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      color: #101828;
      background: #f5f7fb;
    }
    main {
      width: min(920px, calc(100% - 32px));
      margin: 32px auto;
    }
    h1 {
      margin: 0 0 18px;
      font-size: 28px;
      font-weight: 700;
    }
    form {
      display: grid;
      grid-template-columns: 1fr 180px;
      gap: 12px;
      margin-bottom: 16px;
    }
    input, button {
      min-height: 44px;
      border-radius: 6px;
      font-size: 15px;
    }
    input {
      border: 1px solid #cfd6e4;
      padding: 0 12px;
      background: white;
    }
    button {
      border: 0;
      color: white;
      background: #1677ff;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.65;
    }
    progress {
      width: 100%;
      height: 18px;
      margin: 8px 0 14px;
    }
    pre {
      min-height: 360px;
      margin: 0;
      padding: 16px;
      overflow: auto;
      border: 1px solid #d9e1ef;
      border-radius: 8px;
      background: #0b1220;
      color: #d8e2f2;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    a { color: #9bd2ff; }
    @media (max-width: 680px) {
      main { width: min(100% - 24px, 920px); margin: 20px auto; }
      form { grid-template-columns: 1fr; }
      h1 { font-size: 23px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>YouTube Splitter</h1>
    <form id="splitter-form">
      <input id="youtube-url" name="url" type="url" placeholder="https://www.youtube.com/watch?v=..." required>
      <button id="submit-button" type="submit">Split Video</button>
    </form>
    <progress id="progress" value="0" max="100"></progress>
    <pre id="log"></pre>
  </main>
  <script>
    const form = document.getElementById('splitter-form');
    const input = document.getElementById('youtube-url');
    const button = document.getElementById('submit-button');
    const progress = document.getElementById('progress');
    const log = document.getElementById('log');

    function appendLog(message) {
      log.textContent += message + '\\n';
      log.scrollTop = log.scrollHeight;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      progress.value = 0;
      log.textContent = '';
      appendLog('Mulai proses...');

      try {
        const response = await fetch('/splitter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: input.value }),
        });

        if (!response.ok || !response.body) {
          appendLog('Gagal memulai proses: HTTP ' + response.status);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\\n\\n');
          buffer = chunks.pop() || '';

          for (const chunk of chunks) {
            const eventLine = chunk.split('\\n').find(line => line.startsWith('event: '));
            const dataLine = chunk.split('\\n').find(line => line.startsWith('data: '));
            if (!dataLine) continue;

            const eventName = eventLine ? eventLine.slice(7) : 'message';
            const data = JSON.parse(dataLine.slice(6));

            if (eventName === 'progress') {
              if (typeof data.percent === 'number') progress.value = data.percent;
              appendLog(data.message + (typeof data.percent === 'number' ? ' - ' + data.percent.toFixed(1) + '%' : ''));
            }

            if (eventName === 'done') {
              progress.value = 100;
              appendLog('Selesai.');
              for (const file of data.outputFiles || []) {
                appendLog(file.filename + ' -> ' + file.downloadUrl);
              }
            }

            if (eventName === 'error') {
              appendLog('Error: ' + data.error);
            }
          }
        }
      } catch (error) {
        appendLog('Error: ' + error.message);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`);
});

app.post('/splitter', async (req, res) => {
  const youtubeUrl = req.body?.url || req.body?.youtubeUrl;
  if (!youtubeUrl || typeof youtubeUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'url atau youtubeUrl wajib diisi.' });
  }

  const jobId = `split-${Date.now()}`;
  const jobOutputDir = path.join(SPLIT_VIDEO_DIR, jobId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sendProgress = (event: SplitProgressEvent) => {
    sendEvent('progress', event);
  };

  try {
    const result = await splitAndProcessVideo({
      youtubeUrl,
      outputDir: jobOutputDir,
      tempDir: path.join(__dirname, '_tmp_uploads', 'splitter'),
      segmentDuration: 180,
      watermarkText: req.body?.watermarkText || 'TikTok Automation',
      onProgress: sendProgress,
    });

    sendEvent('done', {
      success: true,
      ...result,
      outputFiles: result.outputFiles.map(filePath => ({
        path: filePath,
        filename: path.basename(filePath),
        downloadUrl: `/api/splitter/download/${jobId}/${encodeURIComponent(path.basename(filePath))}`,
      })),
    });
  } catch (err: any) {
    console.error('[SPLITTER] Fatal:', err);
    sendEvent('error', {
      success: false,
      error: err.message || 'Gagal split video YouTube.',
    });
  } finally {
    res.end();
  }
});

app.get('/api/splitter/download/:jobId/:filename', (req, res) => {
  const jobId = path.basename(req.params.jobId);
  const filename = path.basename(req.params.filename);
  const filepath = path.join(SPLIT_VIDEO_DIR, jobId, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File tidak ditemukan');
  res.download(filepath, filename);
});


app.post('/api/merge', mergeUpload.fields([
  { name: 'videos', maxCount: 2 },
  { name: 'sound', maxCount: 1 },
]), async (req: any, res) => {
  const videoFiles = ((req.files?.videos || []) as Express.Multer.File[]);
  const soundFile = ((req.files?.sound || []) as Express.Multer.File[])[0];
  const uploadedFiles = [...videoFiles, ...(soundFile ? [soundFile] : [])];

  if (videoFiles.length !== 2) {
    for (const file of uploadedFiles) {
      try { fs.unlinkSync(file.path); } catch { }
    }
    return res.status(400).json({ success: false, error: 'Pilih tepat 2 video untuk digabung.' });
  }

  if (soundFile && !['.mp3', '.wav'].includes(path.extname(soundFile.originalname).toLowerCase())) {
    for (const file of uploadedFiles) {
      try { fs.unlinkSync(file.path); } catch { }
    }
    return res.status(400).json({ success: false, error: 'Sound harus berupa file .mp3 atau .wav.' });
  }

  const saveFolder = req.body?.saveFolder as string | undefined;
  const outputDir = (saveFolder && saveFolder.trim()) ? saveFolder.trim() : MERGED_VIDEO_DIR;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputFilename = `merged-${Date.now()}.mp4`;
  const outputPath = path.join(outputDir, outputFilename);

  try {
    const result = await mergeVideosCopyWithOptionalAudio(
      videoFiles.map(file => file.path),
      outputPath,
      soundFile?.path,
      { tempDir: path.join(__dirname, '_tmp_uploads') }
    );

    res.json({
      success: true,
      filename: outputFilename,
      savedTo: outputPath,
      downloadUrl: `/api/merge/download?path=${encodeURIComponent(outputPath)}`,
      inputCount: result.inputCount,
      audioReplaced: result.audioReplaced,
    });
  } catch (err: any) {
    try { fs.unlinkSync(outputPath); } catch { }
    res.status(500).json({ success: false, error: err.message || 'Gagal merge video.' });
  } finally {
    for (const file of uploadedFiles) {
      try { fs.unlinkSync(file.path); } catch { }
    }
  }
});

app.get('/api/merge/download', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).send('Path diperlukan');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return res.status(404).send('File tidak ditemukan');
  res.download(resolved, path.basename(resolved));
});

// ─── Permutation Merge APIs ──────────────────────────────
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

app.get('/api/merge/scan-folder', (req, res) => {
  const folder = req.query.folder as string;
  if (!folder || typeof folder !== 'string') {
    return res.status(400).json({ success: false, error: 'Parameter folder wajib diisi.' });
  }
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return res.status(400).json({ success: false, error: 'Folder tidak ditemukan atau bukan directory.' });
  }

  const videos = fs.readdirSync(folder)
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      if (!VIDEO_EXTS.includes(ext)) return false;
      // Exclude previously merged permutation outputs
      if (f.startsWith('perm_')) return false;
      return fs.statSync(path.join(folder, f)).isFile();
    })
    .sort();

  if (videos.length < 1) {
    return res.json({ success: false, error: 'Tidak ada file video di folder ini.' });
  }

  // Generate P(n,2) + n combinations = n²
  const combinations: { video1: string; video2: string }[] = [];
  // Permutations (ordered pairs where video1 ≠ video2)
  for (let i = 0; i < videos.length; i++) {
    for (let j = 0; j < videos.length; j++) {
      if (i !== j) {
        combinations.push({ video1: videos[i], video2: videos[j] });
      }
    }
  }
  // Self-merges (video + itself)
  for (const v of videos) {
    combinations.push({ video1: v, video2: v });
  }

  res.json({
    success: true,
    folder,
    videos,
    videoCount: videos.length,
    totalCombinations: combinations.length,
    combinations,
  });
});

app.post('/api/merge/permutation', mergeUpload.fields([
  { name: 'sound', maxCount: 1 },
]), async (req: any, res) => {
  const folder = req.body?.folder as string;
  const saveFolder = req.body?.saveFolder as string | undefined;
  const soundFile = ((req.files?.sound || []) as Express.Multer.File[])[0];

  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    if (soundFile) try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Folder tidak valid.' });
  }

  if (soundFile && !['.mp3', '.wav'].includes(path.extname(soundFile.originalname).toLowerCase())) {
    try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Sound harus berupa file .mp3 atau .wav.' });
  }

  const outputDir = (saveFolder && saveFolder.trim()) ? saveFolder.trim() : folder;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const videos = fs.readdirSync(folder)
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      if (!VIDEO_EXTS.includes(ext)) return false;
      if (f.startsWith('perm_')) return false;
      return fs.statSync(path.join(folder, f)).isFile();
    })
    .sort();

  if (videos.length < 1) {
    if (soundFile) try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Tidak ada video di folder.' });
  }

  // Build combinations: P(n,2) + n = n²
  const combinations: { video1: string; video2: string }[] = [];
  for (let i = 0; i < videos.length; i++) {
    for (let j = 0; j < videos.length; j++) {
      if (i !== j) combinations.push({ video1: videos[i], video2: videos[j] });
    }
  }
  for (const v of videos) {
    combinations.push({ video1: v, video2: v });
  }

  // SSE response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  for (let idx = 0; idx < combinations.length; idx++) {
    const combo = combinations[idx];
    const v1Path = path.join(folder, combo.video1);
    const v2Path = path.join(folder, combo.video2);
    const baseName1 = path.basename(combo.video1, path.extname(combo.video1));
    const baseName2 = path.basename(combo.video2, path.extname(combo.video2));
    const outputFilename = `perm_${baseName1}_x_${baseName2}_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    sendEvent('progress', {
      current: idx + 1,
      total: combinations.length,
      message: `Merge: ${combo.video1} + ${combo.video2} → ${outputFilename}`,
      video1: combo.video1,
      video2: combo.video2,
    });

    try {
      await mergeVideosCopyWithOptionalAudio(
        [v1Path, v2Path],
        outputPath,
        soundFile?.path,
        { tempDir: path.join(__dirname, '_tmp_uploads') }
      );
      successCount++;
    } catch (err: any) {
      failCount++;
      const errMsg = `Gagal merge ${combo.video1} + ${combo.video2}: ${err.message}`;
      errors.push(errMsg);
      console.error('[MERGE-PERM]', errMsg);
    }
  }

  sendEvent('done', {
    success: true,
    successCount,
    failCount,
    totalCombinations: combinations.length,
    errors,
  });

  // Cleanup sound file
  if (soundFile) {
    try { fs.unlinkSync(soundFile.path); } catch { }
  }

  res.end();
});

// ═══════════════════════════════════════════════════════════
//  MERGE-UPLOAD ROUTE & APIs
// ═══════════════════════════════════════════════════════════
const MERGE_UPLOAD_CONFIG_FILE = path.join(__dirname, 'merge-upload-config.json');

function loadMergeUploadConfig() {
  if (fs.existsSync(MERGE_UPLOAD_CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(MERGE_UPLOAD_CONFIG_FILE, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveMergeUploadConfig(config: any) {
  fs.writeFileSync(MERGE_UPLOAD_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

app.get('/merge-upload', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'merge-upload.html'));
});

app.get('/api/merge-upload/config', (req, res) => {
  res.json(loadMergeUploadConfig());
});

app.post('/api/merge-upload/config/save', (req, res) => {
  saveMergeUploadConfig(req.body);
  res.json({ success: true });
});

app.get('/api/merge-upload/scan-subfolders', (req, res) => {
  const parent = req.query.parent as string;
  if (!parent) return res.status(400).json({ success: false, error: 'Parameter parent wajib diisi.' });
  const resolved = path.resolve(parent);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.json({ success: false, error: 'Folder tidak ditemukan atau bukan directory.' });
  }
  try {
    const items = fs.readdirSync(resolved);
    const subfolders: string[] = [];
    for (const item of items) {
      const itemPath = path.join(resolved, item);
      if (fs.statSync(itemPath).isDirectory()) {
        subfolders.push(itemPath);
      }
    }
    res.json({ success: true, subfolders });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/merge-upload/list-folders', (req, res) => {
  const dirsToScan = [
    path.join(__dirname, 'bahan'),
    path.join(__dirname, 'split-videos'),
    path.join(__dirname, 'merged-videos')
  ];
  const results: string[] = [];

  for (const rootDir of dirsToScan) {
    if (!fs.existsSync(rootDir)) continue;
    try {
      results.push(rootDir);
      const items = fs.readdirSync(rootDir);
      for (const item of items) {
        const itemPath = path.join(rootDir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          results.push(itemPath);
          try {
            const subItems = fs.readdirSync(itemPath);
            for (const subItem of subItems) {
              const subItemPath = path.join(itemPath, subItem);
              if (fs.statSync(subItemPath).isDirectory()) {
                results.push(subItemPath);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }
  
  // Unique absolute paths
  const uniqueDirs = Array.from(new Set(results.map(p => path.resolve(p))));
  res.json({ success: true, folders: uniqueDirs });
});

app.post('/api/merge-upload/merge', mergeUpload.fields([
  { name: 'sound', maxCount: 1 }
]), async (req: any, res) => {
  const folder = req.body?.folder as string;
  const soundFile = ((req.files?.sound || []) as Express.Multer.File[])[0];

  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    if (soundFile) try { fs.unlinkSync(soundFile.path); } catch { }
    return res.status(400).json({ success: false, error: 'Folder tidak valid atau tidak ditemukan.' });
  }

  // Handle persistent sound file
  const audioDir = path.join(__dirname, 'audio');
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }
  
  let soundPathToUse = '';
  if (soundFile) {
    const ext = path.extname(soundFile.originalname).toLowerCase();
    if (!['.mp3', '.wav'].includes(ext)) {
      try { fs.unlinkSync(soundFile.path); } catch { }
      return res.status(400).json({ success: false, error: 'Format sound harus .mp3 atau .wav.' });
    }
    
    // Copy to a persistent filename
    soundPathToUse = path.join(audioDir, `merge-upload-default${ext}`);
    try {
      if (fs.existsSync(soundPathToUse)) {
        fs.unlinkSync(soundPathToUse);
      }
      fs.renameSync(soundFile.path, soundPathToUse);
      
      // Save configuration info
      const config = loadMergeUploadConfig();
      config.soundFileName = soundFile.originalname;
      config.soundFilePath = soundPathToUse;
      saveMergeUploadConfig(config);
    } catch (e: any) {
      console.error('[MERGE-UPLOAD] Gagal menyimpan sound default:', e);
      // Fallback: use the temp file directly
      soundPathToUse = soundFile.path;
    }
  } else {
    // Check if there is a saved sound
    const config = loadMergeUploadConfig();
    if (config.soundFilePath && fs.existsSync(config.soundFilePath)) {
      soundPathToUse = config.soundFilePath;
    } else {
      // Find any default file in audio/ starting with merge-upload-default
      const files = fs.readdirSync(audioDir);
      const defaultSound = files.find(f => f.startsWith('merge-upload-default.'));
      if (defaultSound) {
        soundPathToUse = path.join(audioDir, defaultSound);
      }
    }
  }

  if (!soundPathToUse) {
    return res.status(400).json({ success: false, error: 'Sound belum dipilih dan tidak ada sound default yang tersimpan.' });
  }

  // Scan folder for videos
  const videos = fs.readdirSync(folder)
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      if (!VIDEO_EXTS.includes(ext)) return false;
      // Exclude subdirectories
      if (fs.statSync(path.join(folder, f)).isDirectory()) return false;
      return true;
    })
    .sort();

  if (videos.length === 0) {
    return res.status(400).json({ success: false, error: 'Tidak ada file video di folder terpilih.' });
  }

  if (videos.length % 4 !== 0) {
    return res.status(400).json({ success: false, error: `Jumlah video harus kelipatan 4. (Saat ini terdapat ${videos.length} video).` });
  }

  // SSE response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const groupCount = videos.length / 4;
  const generatedFolders: string[] = [];
  const originalFilesToDelete: string[] = [];

  let totalMerges = groupCount * 16;
  let mergesCompleted = 0;
  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  try {
    for (let g = 0; g < groupCount; g++) {
      const groupVideos = videos.slice(g * 4, (g + 1) * 4);
      const groupName = String(g + 1);
      const groupDir = path.join(folder, groupName);
      
      fs.mkdirSync(groupDir, { recursive: true });
      generatedFolders.push(groupDir);

      // Track original files for deletion
      for (const v of groupVideos) {
        originalFilesToDelete.push(path.join(folder, v));
      }

      // Generate P(4,2) + 4 = 16 combinations
      const combinations: { video1: string; video2: string }[] = [];
      // Permutations (pairs where i !== j)
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          if (i !== j) {
            combinations.push({ video1: groupVideos[i], video2: groupVideos[j] });
          }
        }
      }
      // Self-merges (i === j)
      for (let i = 0; i < 4; i++) {
        combinations.push({ video1: groupVideos[i], video2: groupVideos[i] });
      }

      // Execute merges
      for (let c = 0; c < combinations.length; c++) {
        const combo = combinations[c];
        const v1Path = path.join(folder, combo.video1);
        const v2Path = path.join(folder, combo.video2);
        const base1 = path.basename(combo.video1, path.extname(combo.video1));
        const base2 = path.basename(combo.video2, path.extname(combo.video2));
        
        const outputFilename = `merged_${base1}_x_${base2}.mp4`;
        const outputPath = path.join(groupDir, outputFilename);

        mergesCompleted++;
        sendEvent('progress', {
          current: mergesCompleted,
          total: totalMerges,
          message: `Grup ${groupName} [${c + 1}/16]: Merge ${combo.video1} + ${combo.video2} → ${outputFilename}`,
          groupName,
          video1: combo.video1,
          video2: combo.video2,
        });

        try {
          await mergeVideosCopyWithOptionalAudio(
            [v1Path, v2Path],
            outputPath,
            soundPathToUse,
            { tempDir: path.join(__dirname, '_tmp_uploads') }
          );
          successCount++;
        } catch (err: any) {
          failCount++;
          const errMsg = `Grup ${groupName} Gagal merge ${combo.video1} + ${combo.video2}: ${err.message}`;
          errors.push(errMsg);
          console.error('[MERGE-UPLOAD-MERGE]', errMsg);
        }
      }
    }

    // Deletion if successful
    if (failCount === 0) {
      sendEvent('progress', {
        current: mergesCompleted,
        total: totalMerges,
        message: `🧹 Membersihkan file video asli...`,
      });
      for (const filepath of originalFilesToDelete) {
        if (fs.existsSync(filepath)) {
          try { fs.unlinkSync(filepath); } catch {}
        }
      }
      sendEvent('progress', {
        current: mergesCompleted,
        total: totalMerges,
        message: `✓ Selesai membersihkan file asli.`,
      });
    } else {
      sendEvent('progress', {
        current: mergesCompleted,
        total: totalMerges,
        message: `⚠ Ada merge yang gagal. File video asli tidak dihapus untuk mencegah kehilangan data.`,
      });
    }

    sendEvent('done', {
      success: failCount === 0,
      successCount,
      failCount,
      totalMerges,
      generatedFolders: generatedFolders.map(p => ({
        path: p,
        name: path.basename(p)
      })),
      errors,
    });

  } catch (err: any) {
    sendEvent('error', {
      success: false,
      error: err.message || 'Terjadi kesalahan sistem saat merge.'
    });
  } finally {
    res.end();
  }
});

app.post('/api/merge-upload/upload/start', async (req, res) => {
  if (getIsRunning()) {
    return res.status(400).json({ success: false, error: 'Upload sedang berjalan!' });
  }

  const config = {
    ...req.body,
    statesDir: STATES_DIR,
  };

  // Callback: mark video as uploaded + delete video file and check for group folder deletion
  const onVideoUploaded = (videoFilename: string) => {
    // 1. Mark in standard uploaded file
    const marksFile = path.join(config.videoFolder, '.uploaded.json');
    let marks: Record<string, boolean> = {};
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
    marks[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
    broadcastLog(`[VIDEO_UPLOADED]:${videoFilename}`);

    // 2. Delete the physical video file immediately
    const videoPath = path.join(config.videoFolder, videoFilename);
    if (fs.existsSync(videoPath)) {
      try {
        fs.unlinkSync(videoPath);
        broadcastLog(`🗑️ File video dihapus dari disk: ${videoFilename}`);
      } catch (e: any) {
        broadcastLog(`⚠ Gagal menghapus file video: ${e.message}`);
      }
    }

    // 3. Check if all video files are uploaded in the subfolder, if so, delete the subfolder and contents
    const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    try {
      const remainingVideos = fs.readdirSync(config.videoFolder)
        .filter(f => exts.includes(path.extname(f).toLowerCase()));

      if (remainingVideos.length === 0) {
        // Purge all files in the folder (including .uploaded.json etc)
        const allFiles = fs.readdirSync(config.videoFolder);
        for (const file of allFiles) {
          try { fs.unlinkSync(path.join(config.videoFolder, file)); } catch {}
        }
        // Remove empty directory
        fs.rmdirSync(config.videoFolder);
        broadcastLog(`🗑️ Folder grup ${path.basename(config.videoFolder)} selesai diupload & dihapus secara otomatis!`);
      }
    } catch (e: any) {
      broadcastLog(`⚠ Gagal membersihkan folder grup: ${e.message}`);
    }
  };

  res.json({ success: true, message: 'Upload dimulai' });
  runUpload(config, broadcastLog, onVideoUploaded).then(() => {
    broadcastLog('===== UPLOAD PROCESS FINISHED =====');
  }).catch(e => {
    broadcastLog('❌ Fatal: ' + e.message);
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ═══════════════════════════════════════════════════════════
//  GROK IMAGINE GENERATOR APIs
// ═══════════════════════════════════════════════════════════
const BAHAN_DIR = path.join(__dirname, 'bahan');
const PROMPT_DIR = path.join(__dirname, 'prompt');
const GROK_DOWNLOAD_DIR = path.join(__dirname, 'grok-downloads');
const AUDIO_DIR = path.join(__dirname, 'audio');
if (!fs.existsSync(BAHAN_DIR)) fs.mkdirSync(BAHAN_DIR, { recursive: true });
if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
if (!fs.existsSync(GROK_DOWNLOAD_DIR)) fs.mkdirSync(GROK_DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// List bahan folders
app.get('/api/grok/bahan', (req, res) => {
  const folders = fs.readdirSync(BAHAN_DIR)
    .filter(f => fs.statSync(path.join(BAHAN_DIR, f)).isDirectory());
  res.json({ folders });
});

// List audio category subfolders
app.get('/api/grok/audio-folders', (req, res) => {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const folders = fs.readdirSync(AUDIO_DIR)
    .filter(f => fs.statSync(path.join(AUDIO_DIR, f)).isDirectory());
  res.json({ folders });
});

// Create a new audio folder
app.post('/api/grok/audio/create-folder', (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: 'Nama folder diperlukan' });
  const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(AUDIO_DIR, cleanFolderName);
  if (fs.existsSync(targetDir)) {
    return res.status(400).json({ error: 'Folder sudah ada' });
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, message: `Berhasil membuat folder ${cleanFolderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List files inside an audio folder
app.get('/api/grok/audio/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  try {
    const files = fs.readdirSync(targetDir).filter(f => {
      const p = path.join(targetDir, f);
      return fs.statSync(p).isFile();
    });
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific file inside an audio folder
app.delete('/api/grok/audio/:folderName/:fileName', (req, res) => {
  const { folderName, fileName } = req.params;
  const filePath = path.join(AUDIO_DIR, folderName, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus ${fileName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a whole audio folder (recursive)
app.delete('/api/grok/audio/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Berhasil menghapus folder ${folderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload audio files
app.post('/api/grok/audio/upload', bahanUpload.array('audio', 100), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) return res.status(400).json({ error: 'folderName diperlukan' });
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });
  for (const f of files) {
    const dest = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dest);
  }
  res.json({ success: true, count: files.length });
});

// Save prompt
app.post('/api/grok/prompts/save', (req: Request, res: Response) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name dan prompt diperlukan' });
  const filename = name.endsWith('.json') ? name : (name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  fs.writeFileSync(path.join(PROMPT_DIR, filename), JSON.stringify({ prompt }, null, 2));
  res.json({ success: true, filename });
});

// List files inside a bahan folder
app.get('/api/grok/bahan/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  try {
    const files = fs.readdirSync(targetDir).filter(f => {
      const p = path.join(targetDir, f);
      return fs.statSync(p).isFile();
    });
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific file inside a bahan folder
app.delete('/api/grok/bahan/:folderName/:fileName', (req, res) => {
  const { folderName, fileName } = req.params;
  const filePath = path.join(BAHAN_DIR, folderName, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus ${fileName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a whole bahan folder (recursive)
app.delete('/api/grok/bahan/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Berhasil menghapus folder ${folderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new bahan folder
app.post('/api/grok/bahan/create-folder', (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: 'Nama folder diperlukan' });
  const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(BAHAN_DIR, cleanFolderName);
  if (fs.existsSync(targetDir)) {
    return res.status(400).json({ error: 'Folder sudah ada' });
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, message: `Berhasil membuat folder ${cleanFolderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Read a specific prompt file content
app.get('/api/grok/prompts/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Prompt tidak ditemukan' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json({ success: true, prompt: data.prompt });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific prompt file
app.delete('/api/grok/prompts/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Prompt tidak ditemukan' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus prompt ${filename}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload bahan images
app.post('/api/grok/bahan/upload', bahanUpload.array('images', 100), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) return res.status(400).json({ error: 'folderName diperlukan' });
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });
  for (const f of files) {
    const dest = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dest);
  }
  res.json({ success: true, count: files.length });
});

// List prompt files
app.get('/api/grok/prompts', (req: Request, res: Response) => {
  const files = fs.readdirSync(PROMPT_DIR)
    .filter(f => f.endsWith('.json'));
  res.json({ files });
});

// Save prompt
app.post('/api/grok/prompts/save', (req: Request, res: Response) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name dan prompt diperlukan' });
  const filename = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  fs.writeFileSync(path.join(PROMPT_DIR, filename), JSON.stringify({ prompt }, null, 2));
  res.json({ success: true, filename });
});

// Grok SSE logs
const grokSseClients: Response[] = [];
function grokBroadcastLog(msg: string) {
  console.log(`[GROK] ${msg}`);
  grokSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

app.get('/api/grok/logs', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  grokSseClients.push(res);
  req.on('close', () => {
    const idx = grokSseClients.indexOf(res);
    if (idx >= 0) grokSseClients.splice(idx, 1);
  });
});

// Stats
app.get('/api/grok/stats', (req: Request, res: Response) => {
  res.json({ ...getGrokStats(), running: getGrokIsRunning(), browsers: getBrowserProgress(), rateLimits: getGrokRateLimits() });
});

app.get('/api/grok/rate-limits', (req: Request, res: Response) => {
  res.json(getGrokRateLimits());
});

app.post('/api/grok/clear-rate-limit', (req: Request, res: Response) => {
  const { stateFile } = req.body;
  if (stateFile) {
    clearGrokRateLimit(stateFile);
  }
  res.json({ success: true });
});

// Start generate
app.post('/api/grok/start', async (req: Request, res: Response) => {
  if (getGrokIsRunning()) {
    return res.status(400).json({ success: false, error: 'Generate sedang berjalan!' });
  }

  const merge = req.body.merge === 'ya' || req.body.merge === true;
  const totalVideos = Math.max(1, parseInt(req.body.totalVideos) || 1);
  if (merge && totalVideos % 2 !== 0) {
    return res.status(400).json({ success: false, error: 'Jumlah video harus genap jika memilih merge ya!' });
  }

  const data = loadGrokbotData();
  const config = {
    stateFile: req.body.stateFile,
    statesDir: GROK_STATES_DIR,
    bahanFolder: req.body.bahanFolder || '',
    bahanDir: BAHAN_DIR,
    promptFile: req.body.promptFile,
    promptDir: PROMPT_DIR,
    mode: req.body.mode || 'Video',
    resolution: req.body.resolution || '720p',
    duration: req.body.duration || '10s',
    aspectRatio: req.body.aspectRatio || '9:16',
    headless: req.body.headless !== undefined ? !!req.body.headless : true,
    downloadDir: GROK_DOWNLOAD_DIR,
    totalVideos: totalVideos,
    merge: merge,
    audioFolder: req.body.audioFolder || '',
    parallelBrowsers: req.body.parallelBrowsers || data.globalConfig?.parallelBrowsers || 1,
  };

  res.json({ success: true, message: 'Generate dimulai' });
  runGrokGenerator(config, grokBroadcastLog, __dirname).then(() => {
    grokBroadcastLog('===== GENERATE PROCESS FINISHED =====');
  }).catch(e => {
    grokBroadcastLog('❌ Fatal: ' + e.message);
  });
});

// Stop generate
app.post('/api/grok/stop', async (req: Request, res: Response) => {
  await stopGrokGenerator();
  res.json({ success: true, message: 'Generate dihentikan' });
});

app.get('/api/grok/videos', (req: Request, res: Response) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ videos: [] });
  const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
  if (!fs.existsSync(stateDir)) return res.json({ videos: [] });

  // Load downloaded marks
  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { }

  const exts = ['.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.webp'];
  
  // List top-level files
  let files: any[] = [];
  try {
    files = fs.readdirSync(stateDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stat = fs.statSync(path.join(stateDir, f));
        return {
          filename: f,
          size: stat.size,
          created: stat.birthtime.toISOString(),
          downloaded: !!marks[f],
          isRaw: !f.startsWith('grok_merged_'),
          isMerged: f.startsWith('grok_merged_')
        };
      });
  } catch (e) { }

  // Check if raw folder exists
  const rawDir = path.join(stateDir, 'raw');
  if (fs.existsSync(rawDir)) {
    try {
      const rawFiles = fs.readdirSync(rawDir)
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .map(f => {
          const stat = fs.statSync(path.join(rawDir, f));
          const relativeFilename = `raw/${f}`;
          return {
            filename: relativeFilename,
            size: stat.size,
            created: stat.birthtime.toISOString(),
            downloaded: !!marks[relativeFilename],
            isRaw: true,
            isMerged: false
          };
        });
      files = files.concat(rawFiles);
    } catch (e) { }
  }

  // Sort newest first
  files.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

  res.json({ videos: files, stateName });
});

// Serve video file
app.get('/api/grok/video-file/:state/:filename', (req, res) => {
  const { state, filename } = req.params;
  if (filename.includes('..') || state.includes('..')) {
    return res.status(400).send('Invalid path');
  }
  const filepath = path.join(GROK_DOWNLOAD_DIR, state, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// Serve raw video file
app.get('/api/grok/video-file/:state/raw/:filename', (req, res) => {
  const { state, filename } = req.params;
  if (filename.includes('..') || state.includes('..')) {
    return res.status(400).send('Invalid path');
  }
  const filepath = path.join(GROK_DOWNLOAD_DIR, state, 'raw', filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// Mark video as downloaded by user
app.post('/api/grok/mark-downloaded', (req, res) => {
  const { stateFile, filename, filenames } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'Missing stateFile' });

  const list = Array.isArray(filenames) ? filenames : (filename ? [filename] : []);
  if (list.length === 0) return res.status(400).json({ error: 'Missing filename or filenames' });

  for (const f of list) {
    if (typeof f !== 'string' || f.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
  }

  const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { }
  
  list.forEach((f) => {
    marks[f] = true;
  });
  
  fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
  res.json({ success: true });
});

// Delete a video file
app.post('/api/grok/delete-video', (req, res) => {
  const { stateFile, filename, filenames } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'Missing stateFile' });

  const list = Array.isArray(filenames) ? filenames : (filename ? [filename] : []);
  if (list.length === 0) return res.status(400).json({ error: 'Missing filename or filenames' });

  for (const f of list) {
    if (typeof f !== 'string' || f.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
  }

  const stateName = stateFile.replace('grok-state-', '').replace('.json', '');
  const marksFile = path.join(GROK_DOWNLOAD_DIR, stateName, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { }

  let deletedCount = 0;
  let errors: string[] = [];

  list.forEach((f) => {
    const filepath = path.join(GROK_DOWNLOAD_DIR, stateName, f);
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
        delete marks[f];
        deletedCount++;
      } catch (err: any) {
        errors.push(`Gagal menghapus ${f}: ${err.message}`);
      }
    } else {
      errors.push(`File tidak ditemukan: ${f}`);
    }
  });

  try {
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
  } catch { }

  if (errors.length > 0 && deletedCount === 0) {
    return res.status(500).json({ success: false, error: errors.join(', ') });
  }

  res.json({ success: true, deletedCount, errors: errors.length > 0 ? errors : undefined });
});

// ═══════════════════════════════════════════════════════════
//  GROK V2 TEST APIs (/grokv2test)
// ═══════════════════════════════════════════════════════════
app.get('/grokv2test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grokv2test.html'));
});

app.get('/api/grokv2test/prompts', (req, res) => {
  if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const files = fs.readdirSync(PROMPT_DIR).filter(f => f.endsWith('.json'));
  res.json({ files });
});

app.get('/api/grokv2test/prompt-content/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File prompt tidak ditemukan' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let content = data.prompt || '';
    if (!content && Array.isArray(data.prompts) && data.prompts.length > 0) {
      content = data.prompts[0];
    }
    res.json({ success: true, prompt: content, fullData: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grokv2test/bahan', (req, res) => {
  if (!fs.existsSync(BAHAN_DIR)) fs.mkdirSync(BAHAN_DIR, { recursive: true });
  const folders = fs.readdirSync(BAHAN_DIR).filter(f => {
    try {
      return fs.statSync(path.join(BAHAN_DIR, f)).isDirectory();
    } catch {
      return false;
    }
  });
  const bahanMap: Record<string, string[]> = {};
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

  for (const folder of folders) {
    const folderPath = path.join(BAHAN_DIR, folder);
    const files = fs.readdirSync(folderPath).filter(f => imageExts.includes(path.extname(f).toLowerCase()));
    bahanMap[folder] = files;
  }
  res.json({ folders, bahanMap });
});

type GrokV2TestJob = {
  id: string;
  stateName: string;
  status: 'starting' | 'running' | 'done' | 'error';
  phase: string;
  progress: number;
  logs: string[];
  result?: any;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};

let grokV2TestJob: GrokV2TestJob | null = null;
const grokV2TestSseClients = new Map<string, Response[]>();

function getGrokV2TestPublicJob(job: GrokV2TestJob) {
  return {
    id: job.id,
    stateName: job.stateName,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    logs: job.logs,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

function broadcastGrokV2TestJob(job: GrokV2TestJob, event = 'update') {
  const payload = JSON.stringify(getGrokV2TestPublicJob(job));
  const clients = grokV2TestSseClients.get(job.id) || [];
  clients.forEach(client => {
    try { client.write(`event: ${event}\ndata: ${payload}\n\n`); } catch {}
  });
  if (event === 'done' || event === 'job-error') {
    clients.forEach(client => { try { client.end(); } catch {} });
    grokV2TestSseClients.delete(job.id);
  }
}

function addGrokV2TestLog(job: GrokV2TestJob, message: string, progress?: number) {
  const phase = String(message || '').trim();
  if (!phase) return;
  if (Number.isFinite(progress)) job.progress = Math.max(0, Math.min(100, Number(progress)));
  job.phase = phase;
  const line = `[${new Date().toLocaleTimeString('id-ID')}] ${phase}${Number.isFinite(progress) ? ` (${Math.round(Number(progress))}%)` : ''}`;
  job.logs.push(line);
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  console.log(`[GROK_V2_TEST] ${phase}${Number.isFinite(progress) ? ` (${Math.round(Number(progress))}%)` : ''}`);
  broadcastGrokV2TestJob(job, 'update');
}

app.get('/api/grokv2test/status', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!grokV2TestJob || (jobId && grokV2TestJob.id !== jobId)) {
    return res.json({ success: true, job: null });
  }
  res.json({ success: true, job: getGrokV2TestPublicJob(grokV2TestJob) });
});

app.get('/api/grokv2test/events', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId || !grokV2TestJob || grokV2TestJob.id !== jobId) {
    return res.status(404).json({ success: false, error: 'Job Grok V2 Test tidak ditemukan.' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const clients = grokV2TestSseClients.get(jobId) || [];
  clients.push(res);
  grokV2TestSseClients.set(jobId, clients);
  try {
    res.write(`event: snapshot\ndata: ${JSON.stringify(getGrokV2TestPublicJob(grokV2TestJob))}\n\n`);
  } catch {}
  const heartbeat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 15000);
  if (grokV2TestJob.status === 'done' || grokV2TestJob.status === 'error') {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
    grokV2TestSseClients.delete(jobId);
    return;
  }
  req.on('close', () => {
    clearInterval(heartbeat);
    const current = grokV2TestSseClients.get(jobId) || [];
    const index = current.indexOf(res);
    if (index >= 0) current.splice(index, 1);
    if (current.length > 0) grokV2TestSseClients.set(jobId, current);
    else grokV2TestSseClients.delete(jobId);
  });
});

app.post('/api/grokv2test/generate', async (req, res) => {
  const { stateName, promptText, bahanFolder, bahanFile, resolution, duration, aspectRatio, mode } = req.body;

  if (!promptText || promptText.trim() === '') {
    return res.status(400).json({ error: 'Prompt teks harus diisi' });
  }

  if (grokV2TestJob && (grokV2TestJob.status === 'starting' || grokV2TestJob.status === 'running')) {
    return res.status(409).json({ success: false, error: 'Grok V2 Test masih berjalan.', jobId: grokV2TestJob.id });
  }

  let imagePath: string | undefined = undefined;
  if (bahanFolder && bahanFile) {
    imagePath = path.join(BAHAN_DIR, bahanFolder, bahanFile);
    if (!fs.existsSync(imagePath)) {
      return res.status(400).json({ error: `File gambar bahan tidak ditemukan di: ${imagePath}` });
    }
  }

  const job: GrokV2TestJob = {
    id: `grokv2test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    stateName: stateName || 'indra',
    status: 'starting',
    phase: 'Menyiapkan sesi browser Grok...',
    progress: 0,
    logs: [],
    startedAt: new Date().toISOString()
  };
  grokV2TestJob = job;
  addGrokV2TestLog(job, `Memulai generate video (State: ${job.stateName}, Res: ${resolution || '720p'}, Dur: ${duration || '5s'}, Aspect: ${aspectRatio || '9:16'})...`, 1);
  res.status(202).json({ success: true, jobId: job.id, message: 'Generasi dimulai. Pantau SSE untuk status realtime.' });

  void (async () => {
    try {
      job.status = 'running';
      addGrokV2TestLog(job, 'Membuka browser dan memuat Grok Imagine...', 3);
      const generationOptions = {
        stateName: stateName || 'indra',
        promptText,
        imagePath,
        resolution: resolution || '720p',
        duration: duration || '5s',
        aspectRatio: aspectRatio || '9:16',
        mode: mode || 'Video'
      };
      let result: any;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          result = await generateGrokVideoV2(generationOptions, (msg, progress) => {
            addGrokV2TestLog(job, msg, progress);
          });
          break;
        } catch (err: any) {
          const message = err?.message || String(err);
          const isStalePage = err instanceof GrokStalePageError
            || err?.name === 'GrokStalePageError'
            || /page is out of date|out of date|reload to continue|code["']?\s*:\s*7/i.test(message);
          if (!isStalePage || attempt === 2) throw err;
          addGrokV2TestLog(job, 'Grok mengembalikan code 7. Membuat browser/context baru dan mencoba ulang...', 15);
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
      if (!result) throw new Error('Grok tidak mengembalikan hasil generate.');
      job.status = 'done';
      job.progress = 100;
      job.result = result;
      job.finishedAt = new Date().toISOString();
      addGrokV2TestLog(job, `Selesai. Video tersimpan: ${result?.savePath || result?.filename || '(path tidak tersedia)'}`, 100);
      broadcastGrokV2TestJob(job, 'done');
    } catch (err: any) {
      job.status = 'error';
      job.error = err?.message || String(err);
      job.finishedAt = new Date().toISOString();
      addGrokV2TestLog(job, `Gagal: ${job.error}`);
      broadcastGrokV2TestJob(job, 'job-error');
    }
  })();
});

// ═══════════════════════════════════════════════════════════
//  VIDABOT TEST APIs (/vidabotest & /vidabot)
// ═══════════════════════════════════════════════════════════
const VIDABOT_DOWNLOAD_DIR = path.join(process.cwd(), 'vidabot-downloads');

// Browser automation variant based on methodgrokbrowser.md
app.get('/grokv3test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grokv3test.html'));
});

app.get('/api/grokv3test/prompts', (req, res) => {
  if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const files = fs.readdirSync(PROMPT_DIR).filter(f => f.endsWith('.json'));
  res.json({ files });
});

app.get('/api/grokv3test/prompt-content/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File prompt tidak ditemukan' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let content = data.prompt || '';
    if (!content && Array.isArray(data.prompts) && data.prompts.length > 0) {
      content = data.prompts[0];
    }
    res.json({ success: true, prompt: content, fullData: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grokv3test/bahan', (req, res) => {
  if (!fs.existsSync(BAHAN_DIR)) fs.mkdirSync(BAHAN_DIR, { recursive: true });
  const folders = fs.readdirSync(BAHAN_DIR).filter(f => {
    try {
      return fs.statSync(path.join(BAHAN_DIR, f)).isDirectory();
    } catch {
      return false;
    }
  });
  const bahanMap: Record<string, string[]> = {};
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

  for (const folder of folders) {
    const folderPath = path.join(BAHAN_DIR, folder);
    const files = fs.readdirSync(folderPath).filter(f => imageExts.includes(path.extname(f).toLowerCase()));
    bahanMap[folder] = files;
  }
  res.json({ folders, bahanMap });
});

app.post('/api/grokv3test/generate', async (req, res) => {
  const { stateName, promptText, bahanFolder, bahanFile, resolution, duration, aspectRatio, headless } = req.body;

  if (!promptText || promptText.trim() === '') {
    return res.status(400).json({ error: 'Prompt teks harus diisi' });
  }

  let imagePath: string | undefined = undefined;
  if (bahanFolder && bahanFile) {
    imagePath = path.join(BAHAN_DIR, bahanFolder, bahanFile);
    if (!fs.existsSync(imagePath)) {
      return res.status(400).json({ error: `File gambar bahan tidak ditemukan di: ${imagePath}` });
    }
  }

  try {
    console.log(`[GROK_V3_TEST] Memulai browser generate (State: ${stateName || 'indra'}, Res: ${resolution}, Dur: ${duration}, Aspect: ${aspectRatio})...`);
    const result = await generateGrokVideoBrowser({
      stateName: stateName || 'indra',
      promptText,
      imagePath,
      resolution: resolution || '720p',
      duration: duration || '10s',
      aspectRatio: aspectRatio || '9:16',
      headless: headless === true
    }, (msg, progress) => {
      console.log(`[GROK_V3_TEST] ${msg}${typeof progress === 'number' ? ` (${progress}%)` : ''}`);
    });

    res.json({ success: true, result });
  } catch (err: any) {
    console.error(`[GROK_V3_TEST ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/vidabotest', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vidabotest.html'));
});

app.get('/vidabot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vidabot.html'));
});

app.post('/api/vidabot/generate', async (req, res) => {
  const { promptText, imageBase64, bahanFolder, bahanFile, aspectRatio, cookie } = req.body;

  if (!promptText || promptText.trim() === '') {
    return res.status(400).json({ error: 'Prompt teks harus diisi' });
  }

  let imagePath: string | undefined = undefined;
  if (bahanFolder && bahanFile) {
    imagePath = path.join(BAHAN_DIR, bahanFolder, bahanFile);
  }

  try {
    console.log(`[VIDABOT_TEST] Memulai generate video (Aspect: ${aspectRatio || 'portrait'})...`);
    
    const result = await generateVidabotVideo({
      promptText,
      imagePath,
      imageBase64,
      aspectRatio: aspectRatio || 'portrait',
      cookie
    }, (msg, progress) => {
      console.log(`[VIDABOT_TEST] ${msg} (${progress}%)`);
    });

    res.json({
      success: true,
      result
    });
  } catch (err: any) {
    console.error(`[VIDABOT_TEST ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vidabot/video-file/:filename', (req, res) => {
  const { filename } = req.params;
  if (filename.includes('..')) {
    return res.status(400).send('Invalid path');
  }
  const filepath = path.join(VIDABOT_DOWNLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File not found');
  res.sendFile(filepath);
});

// ═══════════════════════════════════════════════════════════
//  TIKTOK V2 TEST APIs (/tiktokv2test)
// ═══════════════════════════════════════════════════════════
app.get('/tiktokv2test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tiktokv2test.html'));
});

app.get('/api/tiktokv2test/states', (req, res) => {
  res.json(getSavedStates('tiktok'));
});

app.post('/api/tiktokv2test/post-affiliate', bahanUpload.single('videoFile'), async (req: any, res) => {
  const { stateFile, description, hashtags, productId, productTitle, scheduleDate, scheduleTime, videoId } = req.body;
  const file = req.file as Express.Multer.File;

  if (!stateFile) return res.status(400).json({ error: 'State account harus dipilih' });
  if (!description) return res.status(400).json({ error: 'Deskripsi harus diisi' });

  let fullDescription = description;
  if (hashtags) {
    const formattedTags = hashtags.split(',').map((t: string) => t.trim()).filter(Boolean).map((t: string) => t.startsWith('#') ? t : `#${t}`).join(' ');
    fullDescription = `${description} ${formattedTags}`;
  }

  let scheduleEpoch = 0;
  if (scheduleDate && scheduleTime) {
    try {
      const dt = new Date(`${scheduleDate}T${scheduleTime}:00`);
      if (!isNaN(dt.getTime())) {
        scheduleEpoch = Math.floor(dt.getTime() / 1000);
      }
    } catch {}
  }

  try {
    console.log(`[TIKTOK_V2_TEST] Post Affiliate Request (State: ${stateFile}, Product: ${productTitle} [${productId}])...`);

    const result = await postTikTokAffiliateVideoApi({
      stateFile,
      videoPath: file ? file.path : undefined,
      videoId: videoId || undefined,
      description: fullDescription,
      productTitle: productTitle || 'ini nama produk',
      productId: productId || '1729748856299095594',
      scheduleTime: scheduleEpoch
    });

    if (file && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }

    res.json({
      success: true,
      result
    });
  } catch (err: any) {
    if (file && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }
    console.error(`[TIKTOK_V2_TEST ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  YTBOT API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/ytbot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ytbot.html'));
});

// Load all configs
app.get('/api/ytbot/config', (req, res) => {
  res.json(loadYtbotData());
});

// Save config for one state
app.post('/api/ytbot/config/save', (req, res) => {
  const { stateFile, description, hashtags, scheduleDate, scheduleTime, intervalMinutes, lastUploadDate, lastUploadTime } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadYtbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', hashtags: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60, lastUploadDate: '', lastUploadTime: '' };
  }
  if (description !== undefined) data.states[stateFile].description = description;
  if (hashtags !== undefined) data.states[stateFile].hashtags = hashtags;
  if (scheduleDate !== undefined) data.states[stateFile].scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) data.states[stateFile].scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) data.states[stateFile].intervalMinutes = intervalMinutes;
  if (lastUploadDate !== undefined) data.states[stateFile].lastUploadDate = lastUploadDate;
  if (lastUploadTime !== undefined) data.states[stateFile].lastUploadTime = lastUploadTime;
  saveYtbotData(data);
  res.json({ success: true });
});

// Add YT link
app.post('/api/ytbot/links/add', (req, res) => {
  const { stateFile, link } = req.body;
  if (!stateFile || !link) return res.status(400).json({ error: 'stateFile dan link diperlukan' });
  const data = loadYtbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', hashtags: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60 };
  }
  data.states[stateFile].ytLinks.push(link);
  saveYtbotData(data);
  res.json({ success: true });
});

// Remove YT link
app.post('/api/ytbot/links/remove', (req, res) => {
  const { stateFile, link } = req.body;
  if (!stateFile || !link) return res.status(400).json({ error: 'stateFile dan link diperlukan' });
  const data = loadYtbotData();
  const cfg = data.states[stateFile];
  if (cfg) {
    const idx = cfg.ytLinks.indexOf(link);
    if (idx >= 0) cfg.ytLinks.splice(idx, 1);
    saveYtbotData(data);
  }
  res.json({ success: true });
});

// List videos for a state
app.get('/api/ytbot/videos', (req, res) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ videos: [] });
  const videoDir = getYtbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  const videos = fs.readdirSync(videoDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort()
    .map(f => ({ name: f, uploaded: !!marks[f] }));
  res.json({ videos });
});

// SSE logs
app.get('/api/ytbot/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  ytbotSseClients.push(res);
  req.on('close', () => {
    const idx = ytbotSseClients.indexOf(res);
    if (idx >= 0) ytbotSseClients.splice(idx, 1);
  });
});

// Status
app.get('/api/ytbot/status', (req, res) => {
  res.json({ running: ytbotRunning, queue: ytbotQueue, progress: ytbotProgress });
});

// Stop
app.post('/api/ytbot/stop', async (req, res) => {
  ytbotRunning = false;
  ytbotFullAutoRunning = false;
  ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '', uploadedCount: 0, uploadTotal: 0 };
  ytbotBroadcastProgress();
  await stopUploader();
  ytbotLog('⛔ ===== YTBOT STOPPED =====');
  res.json({ success: true });
});

// ── YTBOT ORCHESTRATION ──
async function ytbotRunState(stateFile: string): Promise<void> {
  if (!ytbotRunning) return;
  const data = loadYtbotData();
  const cfg = data.states[stateFile];
  if (!cfg) {
    ytbotLog(`❌ Config tidak ditemukan untuk ${stateFile}`);
    return;
  }

  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const videoDir = getYtbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');

  ytbotProgress = { download: 0, split: 0, upload: 0, currentState: stateName, uploadedCount: 0, uploadTotal: 0 };
  ytbotBroadcastProgress();

  ytbotLog(`═══════════════════════════════════════`);
  ytbotLog(`🔑 Memproses state: ${stateName}`);
  ytbotLog(`═══════════════════════════════════════`);

  // Current schedule tracking
  let schedDate = cfg.scheduleDate;
  let schedTime = cfg.scheduleTime;
  const intervalMin = cfg.intervalMinutes || 60;

  // Loop while there's work to do
  while (ytbotRunning) {
    // 1. Check existing unuploaded videos
    let marks: Record<string, boolean> = {};
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

    let allVideos = fs.readdirSync(videoDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    let pendingVideos = allVideos.filter(v => !marks[v]);

    // 2. If no pending videos, download & split from YT stock
    if (pendingVideos.length === 0) {
      // Reload data to get fresh links
      const freshData = loadYtbotData();
      const freshCfg = freshData.states[stateFile];
      if (!freshCfg || freshCfg.ytLinks.length === 0) {
        ytbotLog(`ℹ Tidak ada video pending dan tidak ada link YT tersisa untuk ${stateName}`);
        break;
      }

      // Take first link from stock
      const ytLink = freshCfg.ytLinks[0];
      ytbotLog(`📥 Download & split: ${ytLink}`);

      // Reset progress bars for new link download
      ytbotProgress.download = 0;
      ytbotProgress.split = 0;
      ytbotProgress.upload = 0;
      ytbotBroadcastProgress();

      try {
        const result = await splitAndProcessVideo({
          youtubeUrl: ytLink,
          outputDir: videoDir,
          tempDir: path.join(__dirname, '_tmp_uploads', 'ytbot'),
          segmentDuration: 180,
          watermarkText: 'TikTok Automation',
          onProgress: (evt) => {
            if (evt.stage === 'download' && typeof evt.percent === 'number') {
              ytbotProgress.download = Math.round(evt.percent);
              ytbotBroadcastProgress();
            } else if (evt.stage === 'split' && typeof evt.percent === 'number') {
              const part = evt.part || 1;
              const total = evt.totalParts || 1;
              const base = ((part - 1) / total) * 100;
              const overallSplit = base + (evt.percent / total);
              ytbotProgress.split = Math.round(overallSplit);
              ytbotBroadcastProgress();
            }
            ytbotLog(evt.message);
          },
        });

        ytbotLog(`✓ Split selesai: ${result.totalParts} file dari "${result.title}"`);

        // Remove used link from stock
        freshCfg.ytLinks.splice(0, 1);
        saveYtbotData(freshData);

        // Refresh video list
        allVideos = fs.readdirSync(videoDir)
          .filter(f => exts.includes(path.extname(f).toLowerCase()))
          .sort();
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
        pendingVideos = allVideos.filter(v => !marks[v]);
      } catch (err: any) {
        ytbotLog(`❌ Gagal download/split: ${err.message}`);
        // Remove failed link so we don't retry forever
        freshCfg.ytLinks.splice(0, 1);
        saveYtbotData(freshData);
        continue;
      }
    }

    if (!ytbotRunning) break;
    if (pendingVideos.length === 0) {
      ytbotLog(`ℹ Tidak ada video untuk diupload di ${stateName}`);
      break;
    }

    // === ADAPTIVE SCHEDULE SHIFT ===
    const now = new Date();
    const currentSchedMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
    if (!isNaN(currentSchedMs) && now.getTime() > currentSchedMs) {
      const adjustedTime = new Date(now.getTime() + 45 * 60 * 1000);
      const yyyy = adjustedTime.getFullYear();
      const mm = String(adjustedTime.getMonth() + 1).padStart(2, '0');
      const dd = String(adjustedTime.getDate()).padStart(2, '0');
      const hh = String(adjustedTime.getHours()).padStart(2, '0');
      const min = String(adjustedTime.getMinutes()).padStart(2, '0');
      
      schedDate = `${yyyy}-${mm}-${dd}`;
      schedTime = `${hh}:${min}`;
      
      ytbotLog(`⚠️ [Jadwal Adaptif] Waktu sekarang melebihi schedule yang diset.`);
      ytbotLog(`⚠️ [Jadwal Adaptif] Menyesuaikan schedule video pertama ke +45 menit: ${schedDate} ${schedTime}`);
      
      // Update config file to keep it persistent
      const updData = loadYtbotData();
      if (updData.states[stateFile]) {
        updData.states[stateFile].scheduleDate = schedDate;
        updData.states[stateFile].scheduleTime = schedTime;
        saveYtbotData(updData);
      }
    }
    // ===============================

    // 3. Take max 30 videos for this batch
    const batch = pendingVideos.slice(0, 30);
    const startFrom = batch[0];

    // Calculate schedule end for queue display
    const batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
    const batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
    const endDate = new Date(batchEndMs);
    const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

    // Update queue
    const qIdx = ytbotQueue.findIndex(q => q.stateFile === stateFile);
    const qEntry = { stateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true };
    if (qIdx >= 0) ytbotQueue[qIdx] = qEntry; else ytbotQueue.push(qEntry);
    ytbotBroadcastQueue();

    ytbotProgress.download = 100;
    ytbotProgress.split = 100;
    ytbotProgress.upload = 0;
    ytbotProgress.uploadedCount = 0;
    ytbotProgress.uploadTotal = batch.length;
    ytbotBroadcastProgress();

    ytbotLog(`📤 Upload batch: ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);

    // 4. Run upload using existing tiktok-uploader
    const uploadConfig = {
      videoFolder: videoDir,
      startFromVideo: startFrom,
      description: cfg.description || '',
      hashtags: cfg.hashtags || '',
      addProduct: false,
      productNameRadio: '',
      productTitle: '',
      productDescription: '',
      skipSwitches: true,
      headless: true,
      scheduleDate: schedDate,
      scheduleTime: schedTime,
      intervalMinutes: intervalMin,
      stateFile: stateFile,
      statesDir: STATES_DIR,
    };

    let uploadedCount = 0;
    const onVideoUploaded = (videoFilename: string) => {
      let m: Record<string, boolean> = {};
      try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      m[videoFilename] = true;
      fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
      ytbotLog(`✅ [${stateName}] ${videoFilename} terupload`);

      // Hapus video setelah sukses terupload
      const videoPath = path.join(videoDir, videoFilename);
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          ytbotLog(`🗑️ [${stateName}] Berhasil menghapus file yang selesai diupload: ${videoFilename}`);
        } catch (e: any) {
          ytbotLog(`⚠ Gagal menghapus file ${videoFilename}: ${e.message}`);
        }
      }

      uploadedCount++;
      ytbotProgress.uploadedCount = uploadedCount;
      ytbotProgress.uploadTotal = batch.length;
      ytbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
      ytbotBroadcastProgress();
    };

    try {
      await runUpload(uploadConfig, ytbotLog, onVideoUploaded);
    } catch (err: any) {
      ytbotLog(`❌ Upload error: ${err.message}`);
    }

    if (!ytbotRunning) break;

    // 5. Calculate next batch schedule start = last video schedule + interval
    const nextStartMs = batchEndMs + intervalMin * 60000;
    const nextStart = new Date(nextStartMs);
    schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
    schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;

    const lastUpload = new Date(batchEndMs);
    const lastUploadDate = `${lastUpload.getFullYear()}-${String(lastUpload.getMonth()+1).padStart(2,'0')}-${String(lastUpload.getDate()).padStart(2,'0')}`;
    const lastUploadTime = `${String(lastUpload.getHours()).padStart(2,'0')}:${String(lastUpload.getMinutes()).padStart(2,'0')}`;

    // Update config with new schedule for next loop
    const updData = loadYtbotData();
    if (updData.states[stateFile]) {
      updData.states[stateFile].scheduleDate = schedDate;
      updData.states[stateFile].scheduleTime = schedTime;
      updData.states[stateFile].lastUploadDate = lastUploadDate;
      updData.states[stateFile].lastUploadTime = lastUploadTime;
      saveYtbotData(updData);
    }

    ytbotLog(`⏭ Batch selanjutnya mulai: ${schedDate} ${schedTime}`);

    // Check if there are more pending videos or links
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
    allVideos = fs.readdirSync(videoDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    pendingVideos = allVideos.filter(v => !marks[v]);
    const freshData2 = loadYtbotData();
    const hasMoreLinks = (freshData2.states[stateFile]?.ytLinks?.length || 0) > 0;

    if (pendingVideos.length === 0 && !hasMoreLinks) {
      ytbotLog(`✅ Semua video dan link untuk ${stateName} sudah diproses`);
      break;
    }
  }

  // Mark state as done in queue
  const qIdx2 = ytbotQueue.findIndex(q => q.stateFile === stateFile);
  if (qIdx2 >= 0) { ytbotQueue[qIdx2].active = false; ytbotBroadcastQueue(); }
}

// Schedule one state
app.post('/api/ytbot/schedule', async (req, res) => {
  if (ytbotRunning) {
    return res.status(400).json({ success: false, error: 'YTBot sedang berjalan!' });
  }
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  ytbotRunning = true;
  ytbotQueue = [];
  res.json({ success: true, message: 'Jadwal dimulai' });

  try {
    await ytbotRunState(stateFile);
  } catch (e: any) {
    ytbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    ytbotRunning = false;
    ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '', uploadedCount: 0, uploadTotal: 0 };
    ytbotBroadcastProgress();
    ytbotLog('===== YTBOT FINISHED =====');
  }
});

function getYtbotStateNextTrigger(sf: string): { stateName: string; triggerTime: Date | null; targetTime: Date | null } {
  const data = loadYtbotData();
  const cfg = data.states[sf];
  const stateName = sf.replace('tiktok-state-', '').replace('.json', '');
  if (!cfg) return { stateName, triggerTime: null, targetTime: null };

  const lastDate = cfg.lastUploadDate;
  const lastTime = cfg.lastUploadTime;
  const intervalMin = cfg.intervalMinutes || 60;

  if (!lastDate || !lastTime) {
    const schedDate = cfg.scheduleDate;
    const schedTime = cfg.scheduleTime;
    if (!schedDate || !schedTime) return { stateName, triggerTime: null, targetTime: null };
    const nextUploadTime = new Date(`${schedDate}T${schedTime}:00`);
    if (isNaN(nextUploadTime.getTime())) return { stateName, triggerTime: null, targetTime: null };
    const lastUploadTime = new Date(nextUploadTime.getTime() - intervalMin * 60000);
    const triggerTime = new Date(lastUploadTime.getTime() - 5 * 3600000);
    return { stateName, triggerTime, targetTime: nextUploadTime };
  }

  const lastUploadTime = new Date(`${lastDate}T${lastTime}:00`);
  if (isNaN(lastUploadTime.getTime())) return { stateName, triggerTime: null, targetTime: null };
  const triggerTime = new Date(lastUploadTime.getTime() - 5 * 3600000);
  const targetTime = new Date(lastUploadTime.getTime() + intervalMin * 60000);
  return { stateName, triggerTime, targetTime };
}

function getYtbotStateLastUploadMs(sf: string): number {
  const data = loadYtbotData();
  const cfg = data.states[sf];
  if (!cfg) return 0;
  
  const lastDate = cfg.lastUploadDate;
  const lastTime = cfg.lastUploadTime;
  if (!lastDate || !lastTime) {
    const schedDate = cfg.scheduleDate;
    const schedTime = cfg.scheduleTime;
    if (!schedDate || !schedTime) return 0;
    const nextUploadTime = new Date(`${schedDate}T${schedTime}:00`);
    if (isNaN(nextUploadTime.getTime())) return 0;
    const intervalMin = cfg.intervalMinutes || 60;
    return nextUploadTime.getTime() - intervalMin * 60000;
  }
  
  const lastUploadTime = new Date(`${lastDate}T${lastTime}:00`);
  if (isNaN(lastUploadTime.getTime())) return 0;
  return lastUploadTime.getTime();
}

async function ytbotRunFullAuto(stateFiles: string[]): Promise<void> {
  ytbotLog(`♾️ Memulai YTBot Full Auto standby loop untuk ${stateFiles.length} state...`);
  
  sendWAMessage(`📢 [YTBot Full Auto] Mulai dengan Standard Scheduler (Interval mengikuti masing-masing state).`);

  ytbotQueue = stateFiles.map(sf => {
    const name = sf.replace('tiktok-state-', '').replace('.json', '');
    return { stateName: name, stateFile: sf, videoCount: 0, scheduleStart: 'Standby', scheduleEnd: 'Standby', active: false };
  });
  ytbotBroadcastQueue();

  while (ytbotFullAutoRunning) {
    if (!ytbotFullAutoRunning) break;

    if (ytbotRunning) {
      let slept = 0;
      while (slept < 10000 && ytbotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        slept += 2000;
      }
      continue;
    }

    const now = new Date();
    let triggeredStateFile: string | null = null;
    let nextStateName = 'Tidak ada';
    let nextScheduleTimeStr = 'Tidak ada';
    let earliestTriggerTime = Infinity;

    // Sort states so the one with the newest last upload is checked first
    const sortedStates = [...stateFiles].sort((a, b) => getYtbotStateLastUploadMs(b) - getYtbotStateLastUploadMs(a));

    for (const sf of sortedStates) {
      const { triggerTime, targetTime, stateName } = getYtbotStateNextTrigger(sf);
      if (!triggerTime) continue;

      const triggerTimeMs = triggerTime.getTime();

      if (now.getTime() >= triggerTimeMs && !triggeredStateFile) {
        triggeredStateFile = sf;
      }

      if (triggerTimeMs > now.getTime() && triggerTimeMs < earliestTriggerTime) {
        earliestTriggerTime = triggerTimeMs;
        nextStateName = stateName;
        nextScheduleTimeStr = `${triggerTime.getFullYear()}-${String(triggerTime.getMonth()+1).padStart(2,'0')}-${String(triggerTime.getDate()).padStart(2,'0')} ${String(triggerTime.getHours()).padStart(2,'0')}:${String(triggerTime.getMinutes()).padStart(2,'0')}`;
      }
    }

    if (triggeredStateFile) {
      const stateName = triggeredStateFile.replace('tiktok-state-', '').replace('.json', '');
      ytbotLog(`🎯 [Full Auto] State terpicu: ${stateName}. Menyiapkan eksekusi...`);

      ytbotQueue = ytbotQueue.map(q => ({ ...q, active: q.stateFile === triggeredStateFile }));
      ytbotBroadcastQueue();

      let futureNextStateName = 'Tidak ada';
      let futureNextScheduleTimeStr = 'Tidak ada';
      let futureEarliestTriggerTime = Infinity;
      for (const sf of sortedStates) {
        if (sf === triggeredStateFile) continue;
        const { triggerTime, stateName } = getYtbotStateNextTrigger(sf);
        if (triggerTime) {
          const triggerTimeMs = triggerTime.getTime();
          if (triggerTimeMs > now.getTime() && triggerTimeMs < futureEarliestTriggerTime) {
            futureEarliestTriggerTime = triggerTimeMs;
            futureNextStateName = stateName;
            futureNextScheduleTimeStr = `${triggerTime.getFullYear()}-${String(triggerTime.getMonth()+1).padStart(2,'0')}-${String(triggerTime.getDate()).padStart(2,'0')} ${String(triggerTime.getHours()).padStart(2,'0')}:${String(triggerTime.getMinutes()).padStart(2,'0')}`;
          }
        }
      }

      const { targetTime } = getYtbotStateNextTrigger(triggeredStateFile);
      const startSchedStr = targetTime ? `${targetTime.getFullYear()}-${String(targetTime.getMonth()+1).padStart(2,'0')}-${String(targetTime.getDate()).padStart(2,'0')} ${String(targetTime.getHours()).padStart(2,'0')}:${String(targetTime.getMinutes()).padStart(2,'0')}` : 'Tidak diketahui';
      
      const lastUploadTime = new Date(targetTime ? targetTime.getTime() - (loadYtbotData().states[triggeredStateFile]?.intervalMinutes || 60) * 60000 : Date.now());
      const lastUploadTimeStr = `${lastUploadTime.getFullYear()}-${String(lastUploadTime.getMonth()+1).padStart(2,'0')}-${String(lastUploadTime.getDate()).padStart(2,'0')} ${String(lastUploadTime.getHours()).padStart(2,'0')}:${String(lastUploadTime.getMinutes()).padStart(2,'0')}`;

      let waMsg = `🚀 [YTBot Full Auto] Mulai Penjadwalan Otomatis!\n`;
      waMsg += `🔑 State: ${stateName}\n`;
      waMsg += `📅 Upload Terakhir: ${lastUploadTimeStr}\n`;
      waMsg += `⏰ Sched Target Start: ${startSchedStr}\n`;
      waMsg += `⏭️ Antrian Selanjutnya: State ${futureNextStateName} pada ${futureNextScheduleTimeStr}`;
      sendWAMessage(waMsg);

      ytbotRunning = true;
      try {
        await ytbotRunState(triggeredStateFile);
      } catch (err: any) {
        ytbotLog(`❌ [Full Auto] Gagal menjalankan penjadwalan: ${err.message}`);
      } finally {
        ytbotRunning = false;
        ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '', uploadedCount: 0, uploadTotal: 0 };
        ytbotBroadcastProgress();
      }

      ytbotQueue = ytbotQueue.map(q => ({ ...q, active: false }));
      ytbotBroadcastQueue();
    } else {
      let slept = 0;
      while (slept < 10000 && ytbotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        slept += 2000;
      }
    }
  }

  ytbotLog('===== FULL AUTO STANDBY LOGIC STOPPED =====');
}

// Full auto all states
app.post('/api/ytbot/full-auto', async (req, res) => {
  if (ytbotRunning || ytbotFullAutoRunning) {
    return res.status(400).json({ success: false, error: 'YTBot sedang berjalan!' });
  }
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  ytbotFullAutoRunning = true;
  ytbotQueue = [];
  res.json({ success: true, message: 'Full Auto Standby Mode dimulai' });

  try {
    await ytbotRunFullAuto(stateFiles);
  } catch (e: any) {
    ytbotLog(`❌ Fatal Full Auto: ${e.message}`);
  } finally {
    ytbotFullAutoRunning = false;
    ytbotRunning = false;
    ytbotProgress = { download: 0, split: 0, upload: 0, currentState: '', uploadedCount: 0, uploadTotal: 0 };
    ytbotBroadcastProgress();
    ytbotLog('===== YTBOT FINISHED =====');
  }
});



// ── FBBOT ORCHESTRATION ──
async function fbbotRunState(stateFile: string): Promise<void> {
  if (!fbbotRunning) return;
  const data = loadFbbotData();
  const cfg = data.states[stateFile];
  if (!cfg) {
    fbbotLog(`❌ Config tidak ditemukan untuk ${stateFile}`);
    return;
  }

  const stateName = stateFile.replace('facebook-state-', '').replace('.json', '');
  const videoDir = getFbbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');

  fbbotProgress = { download: 0, split: 0, upload: 0, currentState: stateName };
  fbbotBroadcastProgress();

  fbbotLog(`═══════════════════════════════════════`);
  fbbotLog(`🔑 Memproses FB state: ${stateName}`);
  fbbotLog(`═══════════════════════════════════════`);

  // Current schedule tracking
  let schedDate = cfg.scheduleDate;
  let schedTime = cfg.scheduleTime;
  const intervalMin = cfg.intervalMinutes || 60;

  // Loop while there's work to do
  while (fbbotRunning) {
    // 1. Check existing unuploaded videos
    let marks: Record<string, boolean> = {};
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

    let allVideos = fs.readdirSync(videoDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    let pendingVideos = allVideos.filter(v => !marks[v]);

    // 2. If no pending videos, download & split from YT stock
    if (pendingVideos.length === 0) {
      // Reload data to get fresh links
      const freshData = loadFbbotData();
      const freshCfg = freshData.states[stateFile];
      if (!freshCfg || freshCfg.ytLinks.length === 0) {
        fbbotLog(`ℹ Tidak ada video pending dan tidak ada link YT tersisa untuk ${stateName}`);
        break;
      }

      // Take first link from stock
      const ytLink = freshCfg.ytLinks[0];
      fbbotLog(`📥 Download & split: ${ytLink}`);

      // Reset progress bars for new link download
      fbbotProgress.download = 0;
      fbbotProgress.split = 0;
      fbbotProgress.upload = 0;
      fbbotBroadcastProgress();

      try {
        const result = await splitAndProcessVideo({
          youtubeUrl: ytLink,
          outputDir: videoDir,
          tempDir: path.join(__dirname, '_tmp_uploads', 'fbbot'),
          segmentDuration: 180,
          watermarkText: 'Facebook Reels',
          onProgress: (evt) => {
            if (evt.stage === 'download' && typeof evt.percent === 'number') {
              fbbotProgress.download = Math.round(evt.percent);
              fbbotBroadcastProgress();
            } else if (evt.stage === 'split' && typeof evt.percent === 'number') {
              const part = evt.part || 1;
              const total = evt.totalParts || 1;
              const base = ((part - 1) / total) * 100;
              const overallSplit = base + (evt.percent / total);
              fbbotProgress.split = Math.round(overallSplit);
              fbbotBroadcastProgress();
            }
            fbbotLog(evt.message);
          },
        });

        fbbotLog(`✓ Split selesai: ${result.totalParts} file dari "${result.title}"`);

        // Remove used link from stock
        freshCfg.ytLinks.splice(0, 1);
        saveFbbotData(freshData);

        // Refresh video list
        allVideos = fs.readdirSync(videoDir)
          .filter(f => exts.includes(path.extname(f).toLowerCase()))
          .sort();
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
        pendingVideos = allVideos.filter(v => !marks[v]);
      } catch (err: any) {
        fbbotLog(`❌ Gagal download/split: ${err.message}`);
        // Remove failed link so we don't retry forever
        freshCfg.ytLinks.splice(0, 1);
        saveFbbotData(freshData);
        continue;
      }
    }

    if (!fbbotRunning) break;
    if (pendingVideos.length === 0) {
      fbbotLog(`ℹ Tidak ada video untuk diupload di ${stateName}`);
      break;
    }

    // 3. Take max 30 videos for this batch
    const batch = pendingVideos.slice(0, 30);
    const startFrom = batch[0];

    // Calculate schedule end for queue display
    const batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
    const batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
    const endDate = new Date(batchEndMs);
    const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

    // Update queue
    const qIdx = fbbotQueue.findIndex(q => q.stateFile === stateFile);
    const qEntry = { stateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true };
    if (qIdx >= 0) fbbotQueue[qIdx] = qEntry; else fbbotQueue.push(qEntry);
    fbbotBroadcastQueue();

    fbbotProgress.download = 100;
    fbbotProgress.split = 100;
    fbbotProgress.upload = 0;
    fbbotBroadcastProgress();

    fbbotLog(`📤 Upload batch: ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);

    // 4. Run upload using facebook-uploader
    const uploadConfig = {
      videoFolder: videoDir,
      startFromVideo: startFrom,
      description: cfg.description || '',
      headless: cfg.headless !== false,
      scheduleDate: schedDate,
      scheduleTime: schedTime,
      intervalMinutes: intervalMin,
      stateFile: stateFile,
      statesDir: FB_STATES_DIR,
    };

    let uploadedCount = 0;
    const onVideoUploaded = (videoFilename: string) => {
      let m: Record<string, boolean> = {};
      try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      m[videoFilename] = true;
      fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
      fbbotLog(`✅ [${stateName}] ${videoFilename} terupload`);

      // Hapus video setelah sukses terupload
      const videoPath = path.join(videoDir, videoFilename);
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          fbbotLog(`🗑️ [${stateName}] Berhasil menghapus file selesai diupload: ${videoFilename}`);
        } catch (e: any) {
          fbbotLog(`⚠ Gagal menghapus file ${videoFilename}: ${e.message}`);
        }
      }

      uploadedCount++;
      fbbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
      fbbotBroadcastProgress();
    };

    try {
      await runFacebookUpload(uploadConfig, fbbotLog, onVideoUploaded);
    } catch (err: any) {
      fbbotLog(`❌ Upload error: ${err.message}`);
    }

    if (!fbbotRunning) break;

    // 5. Calculate next batch schedule start = last video schedule + interval
    const nextStartMs = batchEndMs + intervalMin * 60000;
    const nextStart = new Date(nextStartMs);
    schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
    schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;

    // Update config with new schedule for next loop
    const updData = loadFbbotData();
    if (updData.states[stateFile]) {
      updData.states[stateFile].scheduleDate = schedDate;
      updData.states[stateFile].scheduleTime = schedTime;
      saveFbbotData(updData);
    }

    fbbotLog(`⏭ Batch selanjutnya mulai: ${schedDate} ${schedTime}`);

    // Check if there are more pending videos or links
    try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
    allVideos = fs.readdirSync(videoDir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .sort();
    pendingVideos = allVideos.filter(v => !marks[v]);
    const freshData2 = loadFbbotData();
    const hasMoreLinks = (freshData2.states[stateFile]?.ytLinks?.length || 0) > 0;

    if (pendingVideos.length === 0 && !hasMoreLinks) {
      fbbotLog(`✅ Semua video dan link untuk ${stateName} sudah diproses`);
      break;
    }
  }

  // Mark state as done in queue
  const qIdx2 = fbbotQueue.findIndex(q => q.stateFile === stateFile);
  if (qIdx2 >= 0) { fbbotQueue[qIdx2].active = false; fbbotBroadcastQueue(); }
}

// ═══════════════════════════════════════════════════════════
//  FBBOT API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/fb', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fb.html'));
});

// Load configs for Facebook
app.get('/api/fb/config', (req, res) => {
  res.json(loadFbbotData());
});

// Save config for Facebook state
app.post('/api/fb/config/save', (req, res) => {
  const { stateFile, description, scheduleDate, scheduleTime, intervalMinutes, headless } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadFbbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60, headless: true };
  }
  if (description !== undefined) data.states[stateFile].description = description;
  if (scheduleDate !== undefined) data.states[stateFile].scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) data.states[stateFile].scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) data.states[stateFile].intervalMinutes = intervalMinutes;
  if (headless !== undefined) data.states[stateFile].headless = !!headless;
  saveFbbotData(data);
  res.json({ success: true });
});

// Save manually entered cookies
app.post('/api/facebook/cookies/save', (req, res) => {
  const { name, cookiesText } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nama state harus diisi!' });
  }
  if (!cookiesText || !cookiesText.trim()) {
    return res.status(400).json({ error: 'Cookies harus diisi!' });
  }

  const filename = `facebook-state-${name.trim()}.json`;
  const filepath = path.join(FB_STATES_DIR, filename);

  try {
    const text = cookiesText.trim();
    let cookiesArray: any[] = [];
    
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        cookiesArray = parsed;
      } else if (parsed && Array.isArray(parsed.cookies)) {
        cookiesArray = parsed.cookies;
      } else {
        throw new Error('Format JSON harus berupa Array cookie atau object storageState Playwright');
      }
    } else if (text.includes('=')) {
      const parts = text.split(';');
      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          const cName = part.substring(0, eqIdx).trim();
          const cValue = part.substring(eqIdx + 1).trim();
          if (cName && cValue) {
            cookiesArray.push({
              name: cName,
              value: cValue,
              domain: '.facebook.com',
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax'
            });
          }
        }
      }
    } else {
      throw new Error('Format cookies tidak dikenali (gunakan JSON Array atau document.cookie string)');
    }

    const storageStateData = {
      cookies: cookiesArray.map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.facebook.com',
        path: c.path || '/',
        expires: typeof c.expires === 'number' ? c.expires : -1,
        httpOnly: typeof c.httpOnly === 'boolean' ? c.httpOnly : true,
        secure: typeof c.secure === 'boolean' ? c.secure : true,
        sameSite: c.sameSite || 'Lax'
      })),
      origins: []
    };

    fs.writeFileSync(filepath, JSON.stringify(storageStateData, null, 2));
    res.json({ success: true, message: `Session berhasil disimpan ke ${filename}` });
  } catch (err: any) {
    res.status(400).json({ error: 'Gagal memproses cookies: ' + err.message });
  }
});

// Save manually entered cookies (universal route)
app.post('/api/cookies/save', (req, res) => {
  const { name, cookiesText, platform = 'tiktok' } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nama state harus diisi!' });
  }
  if (!cookiesText || !cookiesText.trim()) {
    return res.status(400).json({ error: 'Cookies harus diisi!' });
  }

  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');
  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const defaultDomain = platform === 'grok' ? '.grok.com' : (platform === 'facebook' ? '.facebook.com' : '.tiktok.com');

  const filename = `${prefix}${name.trim()}.json`;
  const filepath = path.join(dir, filename);

  try {
    const text = cookiesText.trim();
    let cookiesArray: any[] = [];
    
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        cookiesArray = parsed;
      } else if (parsed && Array.isArray(parsed.cookies)) {
        cookiesArray = parsed.cookies;
      } else {
        throw new Error('Format JSON harus berupa Array cookie atau object storageState Playwright');
      }
    } else if (text.includes('=')) {
      const parts = text.split(';');
      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          const cName = part.substring(0, eqIdx).trim();
          const cValue = part.substring(eqIdx + 1).trim();
          if (cName && cValue) {
            cookiesArray.push({
              name: cName,
              value: cValue,
              domain: defaultDomain,
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax'
            });
          }
        }
      }
    } else {
      throw new Error('Format cookies tidak dikenali (gunakan JSON Array atau document.cookie string)');
    }

    const storageStateData = {
      cookies: cookiesArray.map((c: any) => {
        // Expiry parsing
        let expires = -1;
        if (c.expires !== undefined) {
          if (typeof c.expires === 'number') {
            expires = c.expires;
          } else if (typeof c.expires === 'string') {
            const parsed = Date.parse(c.expires);
            if (!isNaN(parsed)) expires = Math.floor(parsed / 1000);
          }
        } else if (c.expirationDate !== undefined && c.expirationDate !== null) {
          if (typeof c.expirationDate === 'number') {
            expires = c.expirationDate;
          } else if (typeof c.expirationDate === 'string') {
            const parsed = Date.parse(c.expirationDate);
            if (!isNaN(parsed)) expires = Math.floor(parsed / 1000);
          }
        }

        // sameSite mapping
        let sameSite: 'Lax' | 'Strict' | 'None' = 'Lax';
        if (c.sameSite) {
          const lower = String(c.sameSite).toLowerCase();
          if (lower === 'lax') sameSite = 'Lax';
          else if (lower === 'strict') sameSite = 'Strict';
          else if (lower === 'none' || lower === 'no_restriction' || lower === 'unspecified') sameSite = 'None';
        }

        return {
          name: c.name,
          value: c.value,
          domain: c.domain || defaultDomain,
          path: c.path || '/',
          expires: expires,
          httpOnly: typeof c.httpOnly === 'boolean' ? c.httpOnly : true,
          secure: typeof c.secure === 'boolean' ? c.secure : true,
          sameSite: sameSite
        };
      }),
      origins: []
    };

    fs.writeFileSync(filepath, JSON.stringify(storageStateData, null, 2));
    res.json({ success: true, message: `Session berhasil disimpan ke ${filename}` });
  } catch (err: any) {
    res.status(400).json({ error: 'Gagal memproses cookies: ' + err.message });
  }
});

// Autopull feature persistence and logic
const AUTOPULL_CONFIG_FILE = path.join(__dirname, 'autopull-config.json');
let autopullInterval: NodeJS.Timeout | null = null;

function loadAutopullConfig(): { enabled: boolean } {
  try {
    if (fs.existsSync(AUTOPULL_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(AUTOPULL_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load autopull config, resetting to default.', e);
  }
  return { enabled: false };
}

function saveAutopullConfig(config: { enabled: boolean }) {
  try {
    fs.writeFileSync(AUTOPULL_CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save autopull config.', e);
  }
}

function runRestartScript() {
  try {
    const restartBatPath = path.join(__dirname, 'restart.bat');
    const scriptContent = `@echo off
ping 127.0.0.1 -n 3 > nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do (
    taskkill /f /pid %%a
)
wscript.exe "%~dp0start.vbs"
`;
    fs.writeFileSync(restartBatPath, scriptContent);

    // Spawn detached restart process
    const child = spawn('cmd.exe', ['/c', 'restart.bat'], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (err: any) {
    console.error('[RESTART] Failed to auto-restart:', err.message);
  }
}

function startAutopullPolling() {
  if (autopullInterval) clearInterval(autopullInterval);
  autopullInterval = setInterval(() => {
    console.log('[AUTOPULL] Checking for updates...');
    exec('git pull', (err, stdout, stderr) => {
      if (err) {
        console.error('[AUTOPULL] Git pull error:', err.message);
        return;
      }
      if (!stdout.includes('Already up to date.')) {
        console.log('[AUTOPULL] New updates found and pulled! Restarting server...');
        runRestartScript();
      }
    });
  }, 5 * 60 * 60 * 1000); // Check every 5 hours
}

function stopAutopullPolling() {
  if (autopullInterval) {
    clearInterval(autopullInterval);
    autopullInterval = null;
  }
}

function initAutopull() {
  const config = loadAutopullConfig();
  if (config.enabled) {
    console.log('🟢 [AUTOPULL] Auto pull is enabled. Starting background checks...');
    startAutopullPolling();
  } else {
    console.log('⚪ [AUTOPULL] Auto pull is disabled.');
  }
}

// Git and Server Restart endpoints
app.get('/git', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'git.html'));
});

app.post('/api/git/status', (req, res) => {
  exec('git status -s && git log -1 --oneline', (err, stdout, stderr) => {
    if (err) {
      return res.json({ success: false, error: err.message });
    }
    const lines = stdout.trim().split('\n');
    const lastCommit = lines.pop() || 'Unknown';
    const status = lines.join('\n').trim() || 'Clean / Up to date';
    res.json({ success: true, lastCommit, status });
  });
});

app.post('/api/git/pull', (req, res) => {
  exec('git pull', (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message + '\n' + stderr });
    }
    res.json({ success: true, output: stdout });
  });
});

app.post('/api/git/restart', (req, res) => {
  try {
    runRestartScript();
    res.json({ success: true, message: 'Server is restarting...' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/git/autopull/status', (req, res) => {
  const config = loadAutopullConfig();
  res.json({ success: true, enabled: config.enabled });
});

app.post('/api/git/autopull/toggle', (req, res) => {
  const config = loadAutopullConfig();
  config.enabled = !config.enabled;
  saveAutopullConfig(config);
  
  if (config.enabled) {
    startAutopullPolling();
  } else {
    stopAutopullPolling();
  }
  
  res.json({ success: true, enabled: config.enabled });
});

// Delete state for platform
app.post('/api/delete-state', (req, res) => {
  const { filename, platform } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename diperlukan' });

  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'State tidak ditemukan' });
  }

  try {
    fs.unlinkSync(filepath);
    res.json({ success: true, message: 'Sesi berhasil dihapus' });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal menghapus sesi: ' + err.message });
  }
});

// Export state for platform
app.get('/api/states/export', (req, res) => {
  const { filename, platform = 'tiktok' } = req.query;
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'Filename diperlukan' });
  }

  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File state tidak ditemukan' });
  }

  res.download(filepath, filename);
});

// ── ZIP helper (STORE method, tanpa library tambahan) ──────────────────────
function createDosDateTime(d = new Date()) {
  const time = (((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff);
  const date = ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff);
  return { time, date };
}

let zipCrcTable: Int32Array | null = null;
function getZipCrcTable(): Int32Array {
  if (zipCrcTable) return zipCrcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  zipCrcTable = table;
  return table;
}

function zipCrc32(data: Buffer): number {
  const table = getZipCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Membuat arsip ZIP dengan metode STORE (tanpa kompresi) berisi file-file state
function buildStatesZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const now = createDosDateTime();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = zipCrc32(entry.data);
    const size = entry.data.length;

    // Local file header (30 bytes)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(0, 8);         // method: store
    local.writeUInt16LE(now.time, 10); // time
    local.writeUInt16LE(now.date, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);     // compressed size
    local.writeUInt32LE(size, 22);     // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);        // extra len

    localParts.push(local, nameBuf, entry.data);

    // Central directory header (46 bytes)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);       // version made by
    central.writeUInt16LE(20, 6);       // version needed
    central.writeUInt16LE(0, 8);        // flags
    central.writeUInt16LE(0, 10);       // method
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);       // extra len
    central.writeUInt16LE(0, 32);       // comment len
    central.writeUInt16LE(0, 34);       // disk start
    central.writeUInt16LE(0, 36);       // internal attrs
    central.writeUInt32LE(0, 38);       // external attrs
    central.writeUInt32LE(offset, 42);  // local header offset

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const centralOffset = offset;

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);             // disk number
  eocd.writeUInt16LE(0, 6);             // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);            // comment len

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

// Export SEMUA sesi untuk satu platform, dibundel dalam satu arsip .zip
app.get('/api/states/export-all', (req, res) => {
  const platform = req.query.platform === 'grok' ? 'grok'
    : (req.query.platform === 'facebook' ? 'facebook' : 'tiktok');
  const dir = platform === 'grok' ? GROK_STATES_DIR
    : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const prefix = platform === 'grok' ? 'grok-state-'
    : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && fs.statSync(path.join(dir, f)).isFile());
  } catch (err: any) {
    return res.status(500).json({ error: 'Gagal membaca folder sesi: ' + err.message });
  }

  if (files.length === 0) {
    return res.status(404).json({ error: 'Tidak ada sesi tersimpan untuk diekspor' });
  }

  const entries: { name: string; data: Buffer }[] = [];
  for (const f of files) {
    try {
      entries.push({ name: f, data: fs.readFileSync(path.join(dir, f)) });
    } catch (err) {
      console.error('[EXPORT-ALL] Gagal membaca sesi, dilewati:', f, (err as any).message);
    }
  }

  if (entries.length === 0) {
    return res.status(500).json({ error: 'Tidak ada file sesi yang berhasil dibaca' });
  }

  try {
    const zipBuffer = buildStatesZip(entries);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${prefix}all-sessions-${stamp}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (err: any) {
    console.error('[EXPORT-ALL] Gagal membuat zip:', err);
    res.status(500).json({ error: 'Gagal membuat arsip sesi: ' + err.message });
  }
});

// Import state for platform
app.post('/api/states/import', (req, res) => {
  const { filename, content, platform = 'tiktok' } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: 'Filename dan content diperlukan' });
  }

  const dir = platform === 'grok' ? GROK_STATES_DIR : (platform === 'facebook' ? FB_STATES_DIR : STATES_DIR);
  const prefix = platform === 'grok' ? 'grok-state-' : (platform === 'facebook' ? 'facebook-state-' : 'tiktok-state-');

  // Sanitize filename: remove prefix if present, extract the raw name, then build the proper filename
  let rawName = filename.replace(/\.json$/i, '');
  if (rawName.startsWith(prefix)) {
    rawName = rawName.substring(prefix.length);
  }

  const cleanName = rawName.replace(/[<>:"/\\|?*\x00-\x1F\s]+/g, '_').trim();
  if (!cleanName) {
    return res.status(400).json({ error: 'Nama sesi tidak valid' });
  }

  const targetFilename = `${prefix}${cleanName}.json`;
  const filepath = path.join(dir, targetFilename);

  try {
    let parsedContent = typeof content === 'string' ? JSON.parse(content) : content;
    if (!parsedContent || (!Array.isArray(parsedContent.cookies) && !Array.isArray(parsedContent))) {
      return res.status(400).json({ error: 'Format JSON tidak valid. Harus berisi cookies array atau storageState Playwright.' });
    }

    if (Array.isArray(parsedContent)) {
      parsedContent = { cookies: parsedContent, origins: [] };
    }

    fs.writeFileSync(filepath, JSON.stringify(parsedContent, null, 2));
    res.json({ success: true, message: `Sesi berhasil diimpor sebagai ${targetFilename}`, filename: targetFilename });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal memproses/menyimpan file sesi: ' + err.message });
  }
});

// Add FB link
app.post('/api/fb/links/add', (req, res) => {
  const { stateFile, link } = req.body;
  if (!stateFile || !link) return res.status(400).json({ error: 'stateFile dan link diperlukan' });
  const data = loadFbbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = { ytLinks: [], description: '', scheduleDate: '', scheduleTime: '', intervalMinutes: 60 };
  }
  data.states[stateFile].ytLinks.push(link);
  saveFbbotData(data);
  res.json({ success: true });
});

// Remove FB link
app.post('/api/fb/links/remove', (req, res) => {
  const { stateFile, link } = req.body;
  if (!stateFile || !link) return res.status(400).json({ error: 'stateFile dan link diperlukan' });
  const data = loadFbbotData();
  const cfg = data.states[stateFile];
  if (cfg) {
    const idx = cfg.ytLinks.indexOf(link);
    if (idx >= 0) cfg.ytLinks.splice(idx, 1);
    saveFbbotData(data);
  }
  res.json({ success: true });
});

// List videos for a state
app.get('/api/fb/videos', (req, res) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ videos: [] });
  const videoDir = getFbbotStateVideoDir(stateFile);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(videoDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  const videos = fs.readdirSync(videoDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort()
    .map(f => ({ name: f, uploaded: !marks[f] ? false : true }));
  res.json({ videos });
});

// SSE logs
app.get('/api/fb/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  fbbotSseClients.push(res);
  req.on('close', () => {
    const idx = fbbotSseClients.indexOf(res);
    if (idx >= 0) fbbotSseClients.splice(idx, 1);
  });
});

// Status
app.get('/api/fb/status', (req, res) => {
  res.json({ running: fbbotRunning, queue: fbbotQueue, progress: fbbotProgress });
});

// Stop
app.post('/api/fb/stop', async (req, res) => {
  fbbotRunning = false;
  fbbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
  fbbotBroadcastProgress();
  await stopFacebookUploader();
  fbbotLog('⛔ ===== FBBOT STOPPED =====');
  res.json({ success: true });
});

// Schedule one state
app.post('/api/fb/schedule', async (req, res) => {
  if (fbbotRunning) {
    return res.status(400).json({ success: false, error: 'FB Reels Bot sedang berjalan!' });
  }
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  fbbotRunning = true;
  fbbotQueue = [];
  res.json({ success: true, message: 'Jadwal Facebook dimulai' });

  try {
    await fbbotRunState(stateFile);
  } catch (e: any) {
    fbbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    fbbotRunning = false;
    fbbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
    fbbotBroadcastProgress();
    fbbotLog('===== FBBOT FINISHED =====');
  }
});

// Full auto all states
app.post('/api/fb/full-auto', async (req, res) => {
  if (fbbotRunning) {
    return res.status(400).json({ success: false, error: 'FB Reels Bot sedang berjalan!' });
  }
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  fbbotRunning = true;
  fbbotQueue = [];
  res.json({ success: true, message: 'Full Auto Facebook dimulai' });

  try {
    for (const sf of stateFiles) {
      if (!fbbotRunning) break;
      await fbbotRunState(sf);
    }
  } catch (e: any) {
    fbbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    fbbotRunning = false;
    fbbotProgress = { download: 0, split: 0, upload: 0, currentState: '' };
    fbbotBroadcastProgress();
    fbbotLog('===== FBBOT FINISHED =====');
  }
});

// ═══════════════════════════════════════════════════════════
//  GROKBOT CONSTANTS & PERSISTENCE
// ═══════════════════════════════════════════════════════════
const GROKBOT_DATA_FILE = path.join(__dirname, 'grokbot-data.json');

interface GrokbotStateConfig {
  grokState: string;
  autoSwitchGrokState?: boolean;
  grokGenerateIntervalMinutes?: number;
  promptFile: string;
  bahanFolder: string;
  mode: string;
  resolution: string;
  duration: string;
  aspectRatio: string;
  merge: boolean;
  audioFolder: string;
  description: string;
  hashtags: string;
  scheduleDate: string;
  scheduleTime: string;
  intervalMinutes: number;
  addProduct?: boolean;
  productNameRadio?: string;
  productTitle?: string;
  productDescription?: string;
  headless?: boolean;
  threeUploadsPerHour?: boolean;
  lastUploadDate?: string;
  lastUploadTime?: string;
}

interface GrokbotData {
  states: Record<string, GrokbotStateConfig>;
  globalConfig?: {
    parallelBrowsers?: number;
    headless?: boolean;
    sendWhatsApp?: boolean;
    fullAuto?: {
      enableCustomScheduler?: boolean;
      customIntervalHours?: number;
      customUploadCount?: number;
      headless?: boolean;
    };
  };
}

function loadGrokbotData(): GrokbotData {
  try {
    return JSON.parse(fs.readFileSync(GROKBOT_DATA_FILE, 'utf-8'));
  } catch {
    return { states: {} };
  }
}

function saveGrokbotData(data: GrokbotData) {
  fs.writeFileSync(GROKBOT_DATA_FILE, JSON.stringify(data, null, 2));
}

function isHeadlessEnabled(stateFile?: string): boolean {
  const data = loadGrokbotData();
  // 1. Jika global config di-uncheck (false) di UI, maka headless HARUS false
  if (data.globalConfig && data.globalConfig.headless === false) {
    return false;
  }
  // 2. Jika per-state config di-uncheck (false), maka headless HARUS false
  if (stateFile && data.states && data.states[stateFile] && data.states[stateFile].headless === false) {
    return false;
  }
  return data.globalConfig?.headless !== false;
}

// Wrapper functions for WhatsApp notifications based on global config
function sendWAMessage(msg: string) {
  const data = loadGrokbotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalSendWAMessage(msg);
  }
}

function notifyScheduleStarted(sched: string, end: string, stateName: string) {
  const data = loadGrokbotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalNotifyScheduleStarted(sched, end, stateName);
  }
}

function notifyScheduleFinished(stateName: string, success: boolean, count: number, err?: string) {
  const data = loadGrokbotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalNotifyScheduleFinished(stateName, success, count, err);
  }
}

// Global state for Grokbot SSE & Orchestration
const grokbotSseClients: Response[] = [];
let grokbotRunning = false;
let infiniteGenRunning = false;
let grokbotFullAutoRunning = false;
let infiniteGenWaitInfo: { rateLimitTime: string; resumeTime: string; targetState: string } | null = null;
let grokbotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let grokbotProgress: {
  generate: number;
  merge: number;
  upload: number;
  currentState: string;
  browsers: BrowserProgress[];
  uploadedCount: number;
  uploadTotal: number;
  mergedCount: number;
  mergeTotal: number;
} = {
  generate: 0,
  merge: 0,
  upload: 0,
  currentState: '',
  browsers: [],
  uploadedCount: 0,
  uploadTotal: 0,
  mergedCount: 0,
  mergeTotal: 0,
};

function grokbotLog(msg: string) {
  console.log(`[GROKBOT] ${msg}`);
  grokbotSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

function grokbotBroadcastQueue() {
  grokbotSseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(grokbotQueue)}\n\n`));
}

function grokbotBroadcastProgress() {
  // Always attach fresh browser progress from grok-uploader
  grokbotProgress.browsers = getBrowserProgress();
  const progressWithRateLimits = {
    ...grokbotProgress,
    rateLimits: getGrokRateLimits()
  };
  grokbotSseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(progressWithRateLimits)}\n\n`));
}

function resetGrokbotProgress(overrides: Partial<typeof grokbotProgress> = {}) {
  grokbotProgress = {
    generate: 0, merge: 0, upload: 0, currentState: '',
    browsers: [], uploadedCount: 0, uploadTotal: 0,
    mergedCount: 0, mergeTotal: 0,
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════
//  GROKBOT API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/grokbot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grokbot.html'));
});

app.get('/api/grokbot/config', (req, res) => {
  res.json(loadGrokbotData());
});

app.post('/api/grokbot/config/save', (req, res) => {
  const { stateFile, grokState, promptFile, bahanFolder, mode, resolution, duration, aspectRatio, merge, audioFolder, description, hashtags, scheduleDate, scheduleTime, intervalMinutes, addProduct, productNameRadio, productTitle, productDescription, headless } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadGrokbotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = {
      grokState: '', promptFile: '', bahanFolder: '', mode: 'Video',
      resolution: '720p', duration: '10s', aspectRatio: '9:16', merge: true,
      audioFolder: '', description: '', hashtags: '', scheduleDate: '',
      scheduleTime: '', intervalMinutes: 60,
      addProduct: false, productNameRadio: '', productTitle: '', productDescription: '',
      headless: true
    };
  }
  const s = data.states[stateFile];
  if (grokState !== undefined) s.grokState = grokState;
  if (promptFile !== undefined) s.promptFile = promptFile;
  if (bahanFolder !== undefined) s.bahanFolder = bahanFolder;
  if (mode !== undefined) s.mode = mode;
  if (resolution !== undefined) s.resolution = resolution;
  if (duration !== undefined) s.duration = duration;
  if (aspectRatio !== undefined) s.aspectRatio = aspectRatio;
  if (merge !== undefined) s.merge = !!merge;
  if (audioFolder !== undefined) s.audioFolder = audioFolder;
  if (description !== undefined) s.description = description;
  if (hashtags !== undefined) s.hashtags = hashtags;
  if (scheduleDate !== undefined) s.scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) s.scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) s.intervalMinutes = intervalMinutes;
  if (addProduct !== undefined) s.addProduct = !!addProduct;
  if (productNameRadio !== undefined) s.productNameRadio = productNameRadio;
  if (productTitle !== undefined) s.productTitle = productTitle;
  if (productDescription !== undefined) s.productDescription = productDescription;
  if (headless !== undefined) s.headless = !!headless;
  saveGrokbotData(data);
  res.json({ success: true });
});

app.post('/api/grokbot/global-config/save', (req, res) => {
  const { parallelBrowsers, headless, sendWhatsApp } = req.body;
  const data = loadGrokbotData();
  if (!data.globalConfig) {
    data.globalConfig = {};
  }
  if (parallelBrowsers !== undefined) {
    data.globalConfig.parallelBrowsers = Math.max(1, parseInt(parallelBrowsers) || 1);
  }
  if (headless !== undefined) {
    data.globalConfig.headless = !!headless;
  }
  if (sendWhatsApp !== undefined) {
    data.globalConfig.sendWhatsApp = !!sendWhatsApp;
  }
  saveGrokbotData(data);
  res.json({ success: true });
});

app.post('/api/grokbot/full-auto-settings/save', (req, res) => {
  const { enableCustomScheduler, customIntervalHours, customUploadCount, headless } = req.body;
  const data = loadGrokbotData();
  if (!data.globalConfig) {
    data.globalConfig = {};
  }
  data.globalConfig.fullAuto = {
    enableCustomScheduler: !!enableCustomScheduler,
    customIntervalHours: Math.max(1, parseInt(customIntervalHours) || 10),
    customUploadCount: Math.max(1, parseInt(customUploadCount) || 5),
    headless: headless !== false
  };
  saveGrokbotData(data);
  res.json({ success: true });
});

app.get('/api/grokbot/stock', (req, res) => {
  const stateFile = req.query.stateFile || req.query.state;
  if (!stateFile || typeof stateFile !== 'string') return res.status(400).json({ error: 'stateFile atau state diperlukan' });
  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  
  const rawDir = path.join(stateDownloadDir, 'raw');
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');
  
  const countFiles = (dir: string) => {
    if (!fs.existsSync(dir)) return 0;
    const exts = ['.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.webp'];
    try {
      return fs.readdirSync(dir).filter(f => {
        const p = path.join(dir, f);
        return fs.statSync(p).isFile() && exts.includes(path.extname(f).toLowerCase());
      }).length;
    } catch { return 0; }
  };
  
  let utamaCount = 0;
  if (fs.existsSync(stateDownloadDir)) {
    const exts = ['.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.webp'];
    try {
      utamaCount = fs.readdirSync(stateDownloadDir).filter(f => {
        const p = path.join(stateDownloadDir, f);
        return fs.statSync(p).isFile() && exts.includes(path.extname(f).toLowerCase());
      }).length;
    } catch {}
  }
  
  res.json({
    raw: countFiles(rawDir),
    utama: utamaCount,
    cadangan: countFiles(cadanganDir)
  });
});

app.post('/api/grokbot/generate-utama', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  
  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config state belum disimpan!' });
  if (!cfg.grokState) return res.status(400).json({ error: 'Grok state belum dipilih!' });
  
  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });
  
  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
  
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let allUtamaVideos = fs.existsSync(stateDownloadDir) ? fs.readdirSync(stateDownloadDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort() : [];
  let pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);
  
  const currentCount = pendingUtamaVideos.length;
  if (currentCount >= 30) {
    return res.status(400).json({ error: 'Stok Utama sudah penuh (ada 30 atau lebih video pending)!' });
  }
  
  const needed = 30 - currentCount;
  const mergeEnabled = cfg.merge !== false;
  const totalRawToGenerate = mergeEnabled ? (2 * needed) : needed;
  
  grokbotRunning = true;
  grokbotQueue = [{ stateName: tiktokStateName, stateFile, videoCount: needed, scheduleStart: 'Utama Gen', scheduleEnd: 'Utama Gen', active: true }];
  grokbotBroadcastQueue();
  
  resetGrokbotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? needed : 0 });
  grokbotBroadcastProgress();
  
  res.json({ success: true, message: `Mulai generate ${needed} video utama` });
  
  grokbotLog(`🚀 Memulai Generate Stok Utama untuk ${tiktokStateName}. Dibutuhkan: ${needed} video (raw: ${totalRawToGenerate})`);
  sendWAMessage(`🚀 [${tiktokStateName}] Memulai Generate Stok Utama (dibutuhkan: ${needed} video, raw: ${totalRawToGenerate}).`);
  
  const grokConfig = {
    stateFile: cfg.grokState,
    statesDir: GROK_STATES_DIR,
    bahanFolder: cfg.bahanFolder || '',
    bahanDir: BAHAN_DIR,
    promptFile: cfg.promptFile,
    promptDir: PROMPT_DIR,
    mode: cfg.mode || 'Video',
    resolution: cfg.resolution || '720p',
    duration: cfg.duration || '10s',
    aspectRatio: cfg.aspectRatio || '9:16',
    headless: isHeadlessEnabled(stateFile),
    downloadDir: GROK_DOWNLOAD_DIR,
    customDownloadDir: stateDownloadDir,
    totalVideos: totalRawToGenerate,
    merge: mergeEnabled,
    audioFolder: cfg.audioFolder || '',
    parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
  };
  
  const poll = setInterval(() => {
    if (!grokbotRunning) { clearInterval(poll); return; }
    const stats = getGrokStats();
    const progressList = getBrowserProgress();
    const doneCount = stats.success + stats.failed;
    let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
    let activeCount = 0;
    let activeProgSum = 0;
    progressList.forEach(bp => {
      if (bp.status === 'running') {
        activeCount++;
        activeProgSum += bp.progress;
      }
    });
    if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
    grokbotProgress.generate = Math.min(99, overallGen);
    if (mergeEnabled) {
      grokbotProgress.mergedCount = stats.saved;
      grokbotProgress.mergeTotal = needed;
      grokbotProgress.merge = Math.min(99, Math.round((stats.saved / needed) * 100));
    } else {
      grokbotProgress.merge = 100;
    }
    grokbotBroadcastProgress();
  }, 2000);
  
  runGrokGenerator(grokConfig as any, grokbotLog, __dirname).then(() => {
    clearInterval(poll);
    grokbotProgress.generate = 100;
    grokbotProgress.merge = 100;
    grokbotBroadcastProgress();
    grokbotLog('===== GENERATE UTAMA FINISHED =====');
    const stats = getGrokStats();
    sendWAMessage(`✅ [${tiktokStateName}] Generate Stok Utama Selesai! Berhasil: ${stats.success}, Gagal: ${stats.failed}, Merged: ${stats.saved}/${needed}`);
  }).catch(e => {
    clearInterval(poll);
    grokbotLog('❌ Fatal Utama Gen: ' + e.message);
    sendWAMessage(`❌ [${tiktokStateName}] Gagal Generate Stok Utama: ${e.message}`);
  }).finally(() => {
    grokbotRunning = false;
    grokbotQueue = [];
    grokbotBroadcastQueue();
  });
});

app.post('/api/grokbot/generate-cadangan', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  
  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config state belum disimpan!' });
  if (!cfg.grokState) return res.status(400).json({ error: 'Grok state belum dipilih!' });
  
  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');
  if (!fs.existsSync(cadanganDir)) fs.mkdirSync(cadanganDir, { recursive: true });
  
  grokbotRunning = true;
  grokbotQueue = [{ stateName: tiktokStateName, stateFile, videoCount: 30, scheduleStart: 'Cadangan Gen', scheduleEnd: 'Cadangan Gen', active: true }];
  grokbotBroadcastQueue();
  
  resetGrokbotProgress({ currentState: tiktokStateName, mergeTotal: 30 });
  grokbotBroadcastProgress();
  
  res.json({ success: true, message: `Mulai generate 30 video cadangan (merged)` });
  
  grokbotLog(`🚀 Memulai Generate Stok Cadangan (30 video merged, 60 raw) untuk ${tiktokStateName}`);
  sendWAMessage(`🚀 [${tiktokStateName}] Memulai Generate Stok Cadangan (30 video merged, 60 raw).`);
  
  const grokConfig = {
    stateFile: cfg.grokState,
    statesDir: GROK_STATES_DIR,
    bahanFolder: cfg.bahanFolder || '',
    bahanDir: BAHAN_DIR,
    promptFile: cfg.promptFile,
    promptDir: PROMPT_DIR,
    mode: cfg.mode || 'Video',
    resolution: cfg.resolution || '720p',
    duration: cfg.duration || '10s',
    aspectRatio: cfg.aspectRatio || '9:16',
    headless: isHeadlessEnabled(stateFile),
    downloadDir: GROK_DOWNLOAD_DIR,
    customDownloadDir: cadanganDir,
    totalVideos: 60, // 30 merged videos require 60 raw
    merge: true,
    audioFolder: cfg.audioFolder || '',
    parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
  };
  
  const poll = setInterval(() => {
    if (!grokbotRunning) { clearInterval(poll); return; }
    const stats = getGrokStats();
    const progressList = getBrowserProgress();
    const doneCount = stats.success + stats.failed;
    let overallGen = Math.round((doneCount / 60) * 100);
    let activeCount = 0;
    let activeProgSum = 0;
    progressList.forEach(bp => {
      if (bp.status === 'running') {
        activeCount++;
        activeProgSum += bp.progress;
      }
    });
    if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / 60);
    grokbotProgress.generate = Math.min(99, overallGen);
    grokbotProgress.mergedCount = stats.saved;
    grokbotProgress.mergeTotal = 30;
    grokbotProgress.merge = Math.min(99, Math.round((stats.saved / 30) * 100));
    grokbotBroadcastProgress();
  }, 2000);
  
  runGrokGenerator(grokConfig as any, grokbotLog, __dirname).then(() => {
    clearInterval(poll);
    grokbotProgress.generate = 100;
    grokbotProgress.merge = 100;
    grokbotBroadcastProgress();
    grokbotLog('===== GENERATE CADANGAN FINISHED =====');
    const stats = getGrokStats();
    sendWAMessage(`✅ [${tiktokStateName}] Generate Stok Cadangan Selesai! Berhasil: ${stats.success}, Gagal: ${stats.failed}, Merged: ${stats.saved}/30`);
  }).catch(e => {
    clearInterval(poll);
    grokbotLog('❌ Fatal Cadangan Gen: ' + e.message);
    sendWAMessage(`❌ [${tiktokStateName}] Gagal Generate Stok Cadangan: ${e.message}`);
  }).finally(() => {
    grokbotRunning = false;
    grokbotQueue = [];
    grokbotBroadcastQueue();
  });
});

// ── IMPORT CADANGAN: Move backup videos to main stock ──
app.post('/api/grokbot/import-cadangan', async (req, res) => {
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');

  if (!fs.existsSync(cadanganDir)) {
    return res.status(400).json({ error: `Folder cadangan tidak ditemukan: ${cadanganDir}` });
  }

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.png', '.jpg', '.jpeg', '.webp'];
  const cadanganMarksFile = path.join(cadanganDir, '.uploaded.json');
  let cadanganMarks: Record<string, boolean> = {};
  try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

  const allCadanganVideos = fs.readdirSync(cadanganDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort();
  const pendingCadanganVideos = allCadanganVideos.filter(v => !cadanganMarks[v]);

  if (pendingCadanganVideos.length === 0) {
    return res.status(400).json({ error: 'Tidak ada video cadangan yang tersedia untuk diimpor!' });
  }

  if (!fs.existsSync(stateDownloadDir)) {
    fs.mkdirSync(stateDownloadDir, { recursive: true });
  }

  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  let movedCount = 0;
  let marksChanged = false;

  for (const file of pendingCadanganVideos) {
    const src = path.join(cadanganDir, file);
    const dest = path.join(stateDownloadDir, file);
    try {
      fs.renameSync(src, dest);
      cadanganMarks[file] = true;
      if (marks[file]) {
        delete marks[file];
        marksChanged = true;
      }
      movedCount++;
    } catch (e: any) {
      grokbotLog(`⚠ Gagal memindahkan ${file}: ${e.message}`);
    }
  }

  try {
    fs.writeFileSync(cadanganMarksFile, JSON.stringify(cadanganMarks, null, 2));
    if (marksChanged) {
      fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
    }
  } catch (e: any) {
    grokbotLog(`⚠ Gagal memperbarui tanda upload: ${e.message}`);
  }

  grokbotLog(`🚚 [Manual Import] Berhasil memindahkan ${movedCount} video dari stok cadangan ke stok utama untuk ${tiktokStateName}`);

  res.json({ success: true, message: `Berhasil mengimpor ${movedCount} video dari stok cadangan ke stok utama.` });
});

// ── JADWALKAN SAJA: Skip generation, use existing utama stock ──
app.post('/api/grokbot/schedule-only', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config state belum disimpan!' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  if (!fs.existsSync(stateDownloadDir)) return res.status(400).json({ error: 'Folder download belum ada untuk state ini.' });

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const allUtamaVideos = fs.readdirSync(stateDownloadDir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort();
  const pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);

  if (pendingUtamaVideos.length === 0) {
    return res.status(400).json({ error: 'Tidak ada video utama yang bisa dijadwalkan. Stok utama kosong.' });
  }

  grokbotRunning = true;
  grokbotQueue = [];

  const schedDate = cfg.scheduleDate || new Date().toISOString().split('T')[0];
  const schedTime = cfg.scheduleTime || new Date().toTimeString().slice(0, 5);
  const intervalMin = cfg.threeUploadsPerHour ? (cfg.intervalMinutes || 300) : (cfg.intervalMinutes || 60);
  const batch = pendingUtamaVideos.slice(0, 30);
  const startFrom = batch[0];

  let batchStartMs: number;
  let batchEndMs: number;
  if (cfg.threeUploadsPerHour) {
    const baseSchedule = new Date(`${schedDate}T${schedTime}:00`);
    baseSchedule.setMinutes(0);
    baseSchedule.setSeconds(0);
    baseSchedule.setMilliseconds(0);
    batchStartMs = baseSchedule.getTime();

    const cycleMs = (60 + intervalMin) * 60000;
    const lastBatchIndex = Math.floor((batch.length - 1) / 3);
    batchEndMs = batchStartMs + lastBatchIndex * cycleMs + 60 * 60000;
  } else {
    batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
    batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
  }
  const endDate = new Date(batchEndMs);
  const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

  grokbotQueue.push({ stateName: tiktokStateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true });
  grokbotBroadcastQueue();

  resetGrokbotProgress({ generate: 100, merge: 100, currentState: tiktokStateName, uploadTotal: batch.length });
  grokbotBroadcastProgress();

  res.json({ success: true, message: `Jadwalkan ${batch.length} video utama tanpa generate` });

  grokbotLog(`📤 [Jadwalkan Saja] Mulai Upload ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);
  notifyScheduleStarted(`${schedDate} ${schedTime}`, endStr, tiktokStateName);

    const uploadConfig = {
      videoFolder: stateDownloadDir,
      startFromVideo: startFrom,
      description: cfg.description || '',
      hashtags: cfg.hashtags || '',
      addProduct: !!cfg.addProduct,
      productNameRadio: cfg.productNameRadio || '',
      productTitle: cfg.productTitle || '',
      productDescription: cfg.productDescription || '',
      skipSwitches: false,
      headless: isHeadlessEnabled(stateFile),
      scheduleDate: schedDate,
      scheduleTime: schedTime,
      intervalMinutes: intervalMin,
      stateFile: stateFile,
      statesDir: STATES_DIR,
      threeUploadsPerHour: !!cfg.threeUploadsPerHour,
    };

  let uploadedCount = 0;
  const onVideoUploaded = (videoFilename: string) => {
    let m: Record<string, boolean> = {};
    try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
    m[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
    grokbotLog(`✅ [${tiktokStateName}] ${videoFilename} terupload`);

    // Hapus video setelah sukses terupload
    const videoPath = path.join(stateDownloadDir, videoFilename);
    if (fs.existsSync(videoPath)) {
      try {
        fs.unlinkSync(videoPath);
        grokbotLog(`🗑️ [${tiktokStateName}] Berhasil menghapus file yang selesai diupload: ${videoFilename}`);
      } catch (e: any) {
        grokbotLog(`⚠ Gagal menghapus file ${videoFilename}: ${e.message}`);
      }
    }

    uploadedCount++;
    grokbotProgress.uploadedCount = uploadedCount;
    grokbotProgress.uploadTotal = batch.length;
    grokbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
    grokbotBroadcastProgress();
  };

  let success = true;
  let errMsg = '';
  try {
    await runUpload(uploadConfig, grokbotLog, onVideoUploaded);
  } catch (err: any) {
    success = false;
    errMsg = err.message;
    grokbotLog(`❌ Upload error: ${err.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotQueue = [];
    grokbotBroadcastQueue();
    grokbotLog('===== JADWALKAN SAJA FINISHED =====');
    notifyScheduleFinished(tiktokStateName, success, uploadedCount, errMsg);
  }
});

// ── MERGE SAJA: Merge raw videos without generating new ones ──
app.post('/api/grokbot/merge-only', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config state belum disimpan!' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(stateDownloadDir, 'raw');

  if (!fs.existsSync(rawDir)) {
    return res.status(400).json({ error: `Folder raw tidak ada: grok-downloads/${tiktokStateName}/raw/` });
  }

  const rawFiles = fs.readdirSync(rawDir)
    .filter(f => f.endsWith('.mp4'))
    .sort();

  if (rawFiles.length < 2) {
    return res.status(400).json({ error: `Minimal 2 raw video dibutuhkan untuk merge. Saat ini: ${rawFiles.length}` });
  }

  const pairsCount = Math.floor(rawFiles.length / 2);

  grokbotRunning = true;
  grokbotQueue = [{ stateName: tiktokStateName, stateFile, videoCount: pairsCount, scheduleStart: 'Merge Only', scheduleEnd: 'Merge Only', active: true }];
  grokbotBroadcastQueue();
  resetGrokbotProgress({ generate: 100, currentState: tiktokStateName, mergeTotal: pairsCount });
  grokbotBroadcastProgress();

  res.json({ success: true, message: `Memulai merge ${pairsCount} pasang raw video dari grok-downloads/${tiktokStateName}/raw/` });

  grokbotLog(`✂ [Merge Saja] Memulai merge ${pairsCount} pasang raw video untuk ${tiktokStateName}`);
  grokbotLog(`📂 Raw dir: grok-downloads/${tiktokStateName}/raw/ (${rawFiles.length} file)`);
  sendWAMessage(`✂ [${tiktokStateName}] Memulai Merge Saja (${pairsCount} pasang raw video).`);

  try {
    if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });

    // Read and sort raw files by modification time
    let files = fs.readdirSync(rawDir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const p = path.join(rawDir, f);
        return { name: f, path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);

    let mergedCount = 0;
    while (files.length >= 2 && grokbotRunning) {
      const pair = files.splice(0, 2);
      const [v1, v2] = pair;

      grokbotLog(`[MERGER] Menggabungkan: ${v1.name} + ${v2.name}`);

      // Pick random audio
      let pickedAudioPath: string | undefined = undefined;
      const audioFolder = cfg.audioFolder || '';
      if (audioFolder) {
        const audioDir = path.join(__dirname, 'audio', audioFolder);
        if (fs.existsSync(audioDir)) {
          const audioExts = ['.mp3', '.wav'];
          const audioFiles = fs.readdirSync(audioDir)
            .filter(f => audioExts.includes(path.extname(f).toLowerCase()));
          if (audioFiles.length > 0) {
            const pick = audioFiles[Math.floor(Math.random() * audioFiles.length)];
            pickedAudioPath = path.join(audioDir, pick);
            grokbotLog(`[MERGER] Audio terpilih: ${pick}`);
          }
        }
      }

      const mergedFname = `grok_merged_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
      const finalOutputPath = path.join(stateDownloadDir, mergedFname);

      try {
        await mergeVideosCopyWithOptionalAudio(
          [v1.path, v2.path],
          finalOutputPath,
          pickedAudioPath,
          { tempDir: path.join(__dirname, '_tmp_uploads') }
        );
        mergedCount++;
        grokbotLog(`[MERGER] ✅ Berhasil: ${mergedFname}`);

        // Delete raw source files
        try { fs.unlinkSync(v1.path); } catch {}
        try { fs.unlinkSync(v2.path); } catch {}

        grokbotProgress.mergedCount = mergedCount;
        grokbotProgress.mergeTotal = pairsCount;
        grokbotProgress.merge = Math.round((mergedCount / pairsCount) * 100);
        grokbotBroadcastProgress();
      } catch (err: any) {
        grokbotLog(`[MERGER] ❌ Gagal merge: ${err.message}`);
      }
    }

    grokbotLog(`✅ [Merge Saja] Selesai. ${mergedCount} video merged ke grok-downloads/${tiktokStateName}/`);
    sendWAMessage(`✅ [${tiktokStateName}] Merge Saja Selesai! Berhasil menggabungkan ${mergedCount} video.`);
  } catch (e: any) {
    grokbotLog(`❌ Fatal Merge Only: ${e.message}`);
    sendWAMessage(`❌ [${tiktokStateName}] Gagal Merge Saja: ${e.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotQueue = [];
    grokbotBroadcastQueue();
    grokbotLog('===== MERGE SAJA FINISHED =====');
  }
});

// ── GROKBOT ORCHESTRATION LOOP ──
async function grokbotRunState(stateFile: string, isFullAuto = false): Promise<void> {
  if (!grokbotRunning) return;
  const data = loadGrokbotData();
  const cfg = data.states[stateFile];
  if (!cfg) {
    grokbotLog(`❌ Config tidak ditemukan untuk ${stateFile}`);
    return;
  }

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(stateDownloadDir, 'raw');
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');

  if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });
  if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
  if (!fs.existsSync(cadanganDir)) fs.mkdirSync(cadanganDir, { recursive: true });

  resetGrokbotProgress({ currentState: tiktokStateName });
  grokbotBroadcastProgress();

  grokbotLog(`═══════════════════════════════════════`);
  grokbotLog(`🔑 Memproses state TikTok: ${tiktokStateName}`);
  grokbotLog(`═══════════════════════════════════════`);

  let schedDate = cfg.scheduleDate;
  let schedTime = cfg.scheduleTime;
  const intervalMin = cfg.threeUploadsPerHour ? (cfg.intervalMinutes || 300) : (cfg.intervalMinutes || 60);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  let totalUploadedThisSession = 0;
  let success = true;
  let lastError: string | undefined = undefined;

  try {
    while (grokbotRunning) {
      // 1. Check existing unuploaded videos in Utama
      const marksFile = path.join(stateDownloadDir, '.uploaded.json');
      let marks: Record<string, boolean> = {};
      try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

      let allUtamaVideos = fs.readdirSync(stateDownloadDir)
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .sort();
      let pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);

      let needed = 30 - pendingUtamaVideos.length;

      // 2. Replenish from backup (cadangan) if needed
      if (needed > 0) {
        grokbotLog(`ℹ Stok utama memiliki ${pendingUtamaVideos.length} video pending. Mencari stok cadangan untuk memenuhi target 30 video...`);
        const cadanganMarksFile = path.join(cadanganDir, '.uploaded.json');
        let cadanganMarks: Record<string, boolean> = {};
        try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

        let allCadanganVideos = fs.existsSync(cadanganDir) ? fs.readdirSync(cadanganDir)
          .filter(f => exts.includes(path.extname(f).toLowerCase()))
          .sort() : [];
        let pendingCadanganVideos = allCadanganVideos.filter(v => !cadanganMarks[v]);

        if (pendingCadanganVideos.length > 0) {
          const toMove = pendingCadanganVideos.slice(0, needed);
          grokbotLog(`🚚 Memindahkan ${toMove.length} video dari stok cadangan ke stok utama...`);
          for (const file of toMove) {
            const src = path.join(cadanganDir, file);
            const dest = path.join(stateDownloadDir, file);
            try {
              fs.renameSync(src, dest);
              // Mark as uploaded in cadangan
              cadanganMarks[file] = true;
            } catch (e: any) {
              grokbotLog(`⚠ Gagal memindahkan ${file}: ${e.message}`);
            }
          }
          fs.writeFileSync(cadanganMarksFile, JSON.stringify(cadanganMarks, null, 2));

          // Refresh utama
          allUtamaVideos = fs.readdirSync(stateDownloadDir)
            .filter(f => exts.includes(path.extname(f).toLowerCase()))
            .sort();
          pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);
          needed = 30 - pendingUtamaVideos.length;
        }
      }

      // 3. If still under 30 videos, generate via Grok
      if (isFullAuto) {
        if (pendingUtamaVideos.length === 0) {
          grokbotLog(`❌ [Full Auto] Stok Utama dan Cadangan habis untuk ${tiktokStateName}.`);
          success = false;
          lastError = "Stok Utama dan Cadangan habis";
          break; // Exit loop
        }
        grokbotLog(`ℹ [Full Auto] Menggunakan stok yang tersedia: ${pendingUtamaVideos.length} video.`);
      } else if (needed > 0) {
        grokbotLog(`ℹ Stok utama kurang ${needed} video. Memulai auto-generate via Grok...`);
        sendWAMessage(`🤖 [${tiktokStateName}] Stok utama kurang ${needed} video. Memulai auto-generate via Grok...`);
        if (!cfg.grokState) {
          grokbotLog(`❌ Gagal: Grok State belum diatur untuk TikTok state ${tiktokStateName}`);
          success = false;
          lastError = `Grok State belum diatur untuk TikTok state ${tiktokStateName}`;
          break;
        }

        const mergeEnabled = cfg.merge !== false;
        const totalRawToGenerate = mergeEnabled ? (2 * needed) : needed;

        grokbotProgress.generate = 0;
        grokbotProgress.merge = 0;
        grokbotProgress.upload = 0;
        grokbotProgress.mergeTotal = mergeEnabled ? needed : 0;
        grokbotProgress.mergedCount = 0;
        grokbotProgress.uploadedCount = 0;
        grokbotProgress.uploadTotal = 0;
        grokbotBroadcastProgress();

        const grokConfig = {
          stateFile: cfg.grokState,
          statesDir: GROK_STATES_DIR,
          bahanFolder: cfg.bahanFolder || '',
          bahanDir: BAHAN_DIR,
          promptFile: cfg.promptFile,
          promptDir: PROMPT_DIR,
          mode: cfg.mode || 'Video',
          resolution: cfg.resolution || '720p',
          duration: cfg.duration || '10s',
          aspectRatio: cfg.aspectRatio || '9:16',
          headless: isHeadlessEnabled(stateFile), // Headless mode sesuai state/global config
          downloadDir: GROK_DOWNLOAD_DIR,
          customDownloadDir: stateDownloadDir,
          totalVideos: totalRawToGenerate,
          merge: mergeEnabled,
          audioFolder: cfg.audioFolder || '',
          parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
        };

        const poll = setInterval(() => {
          if (!grokbotRunning) { clearInterval(poll); return; }
          const stats = getGrokStats();
          const progressList = getBrowserProgress();
          const doneCount = stats.success + stats.failed;
          let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
          let activeCount = 0;
          let activeProgSum = 0;
          progressList.forEach(bp => {
            if (bp.status === 'running') {
              activeCount++;
              activeProgSum += bp.progress;
            }
          });
          if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
          grokbotProgress.generate = Math.min(99, overallGen);
          if (mergeEnabled) {
            grokbotProgress.mergedCount = stats.saved;
            grokbotProgress.mergeTotal = needed;
            grokbotProgress.merge = Math.min(99, Math.round((stats.saved / needed) * 100));
          } else {
            grokbotProgress.merge = 100;
          }
          grokbotBroadcastProgress();
        }, 2000);

        try {
          await runGrokGenerator(grokConfig as any, grokbotLog, __dirname);
          clearInterval(poll);
          grokbotLog(`✓ Auto-generate selesai!`);
          sendWAMessage(`✅ [${tiktokStateName}] Auto-generate selesai!`);
          
          grokbotProgress.generate = 100;
          grokbotProgress.merge = 100;
          grokbotBroadcastProgress();

          // Refresh utama
          allUtamaVideos = fs.readdirSync(stateDownloadDir)
            .filter(f => exts.includes(path.extname(f).toLowerCase()))
            .sort();
          try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
          pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);
        } catch (err: any) {
          clearInterval(poll);
          grokbotLog(`❌ Gagal auto-generate via Grok: ${err.message}`);
          sendWAMessage(`❌ [${tiktokStateName}] Gagal auto-generate via Grok: ${err.message}`);
          success = false;
          lastError = err.message;
          break;
        }
      }

      if (!grokbotRunning) break;
      if (pendingUtamaVideos.length === 0) {
        grokbotLog(`ℹ Tidak ada video untuk diupload di ${tiktokStateName}`);
        break;
      }

      const globalConfig = loadGrokbotData().globalConfig;
      const isCustom = isFullAuto && globalConfig?.fullAuto?.enableCustomScheduler;
      const customUploadCount = globalConfig?.fullAuto?.customUploadCount || 5;
      const customIntervalHours = globalConfig?.fullAuto?.customIntervalHours || 10;

      // 4. Batch videos
      const batchSize = isCustom ? customUploadCount : 30;
      const batch = pendingUtamaVideos.slice(0, batchSize);
      const startFrom = batch[0];

      let batchStartMs: number;
      let batchEndMs: number;
      if (isCustom) {
        batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
        // Custom scheduling happens within a 1-hour window
        batchEndMs = batchStartMs + 60 * 60000;
      } else if (cfg.threeUploadsPerHour) {
        const baseSchedule = new Date(`${schedDate}T${schedTime}:00`);
        baseSchedule.setMinutes(0);
        baseSchedule.setSeconds(0);
        baseSchedule.setMilliseconds(0);
        batchStartMs = baseSchedule.getTime();

        const cycleMs = (60 + intervalMin) * 60000;
        const lastBatchIndex = Math.floor((batch.length - 1) / 3);
        batchEndMs = batchStartMs + lastBatchIndex * cycleMs + 60 * 60000;
      } else {
        batchStartMs = new Date(`${schedDate}T${schedTime}:00`).getTime();
        batchEndMs = batchStartMs + (batch.length - 1) * intervalMin * 60000;
      }
      const endDate = new Date(batchEndMs);
      const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

      // Update Queue
      const qIdx = grokbotQueue.findIndex(q => q.stateFile === stateFile);
      const qEntry = { stateName: tiktokStateName, stateFile, videoCount: batch.length, scheduleStart: `${schedDate} ${schedTime}`, scheduleEnd: endStr, active: true };
      if (qIdx >= 0) grokbotQueue[qIdx] = qEntry; else grokbotQueue.push(qEntry);
      grokbotBroadcastQueue();

      grokbotProgress.generate = 100;
      grokbotProgress.merge = 100;
      grokbotProgress.upload = 0;
      grokbotProgress.uploadedCount = 0;
      grokbotProgress.uploadTotal = batch.length;
      grokbotBroadcastProgress();

      grokbotLog(`📤 Mulai Upload batch: ${batch.length} video, schedule ${schedDate} ${schedTime} → ${endStr}`);
      notifyScheduleStarted(`${schedDate} ${schedTime}`, endStr, tiktokStateName);

      const uploadConfig = {
        videoFolder: stateDownloadDir,
        startFromVideo: startFrom,
        description: cfg.description || '',
        hashtags: cfg.hashtags || '',
        addProduct: !!cfg.addProduct,
        productNameRadio: cfg.productNameRadio || '',
        productTitle: cfg.productTitle || '',
        productDescription: cfg.productDescription || '',
        skipSwitches: false, // jangan centang skip switches
        headless: isHeadlessEnabled(stateFile), // headless mode sesuai state/global config
        scheduleDate: schedDate,
        scheduleTime: schedTime,
        intervalMinutes: intervalMin,
        stateFile: stateFile,
        statesDir: STATES_DIR,
        threeUploadsPerHour: !!cfg.threeUploadsPerHour,
        enableCustomScheduler: isCustom,
        customIntervalHours: customIntervalHours,
        customUploadCount: customUploadCount
      };

      let uploadedCount = 0;
      const onVideoUploaded = (videoFilename: string) => {
        let m: Record<string, boolean> = {};
        try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
        m[videoFilename] = true;
        fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
        grokbotLog(`✅ [${tiktokStateName}] ${videoFilename} terupload`);

        // Hapus video setelah sukses terupload
        const videoPath = path.join(stateDownloadDir, videoFilename);
        if (fs.existsSync(videoPath)) {
          try {
            fs.unlinkSync(videoPath);
            grokbotLog(`🗑️ [${tiktokStateName}] Berhasil menghapus file yang selesai diupload: ${videoFilename}`);
          } catch (e: any) {
            grokbotLog(`⚠ Gagal menghapus file ${videoFilename}: ${e.message}`);
          }
        }

        uploadedCount++;
        totalUploadedThisSession++;
        grokbotProgress.uploadedCount = uploadedCount;
        grokbotProgress.uploadTotal = batch.length;
        grokbotProgress.upload = Math.round((uploadedCount / batch.length) * 100);
        grokbotBroadcastProgress();
      };

      try {
        await runUpload(uploadConfig, grokbotLog, onVideoUploaded);
      } catch (err: any) {
        success = false;
        lastError = err.message;
        grokbotLog(`❌ Upload error: ${err.message}`);
      }

      if (!grokbotRunning) break;

      // 5. Calculate rolling schedule for subsequent loops
      let lastUploadDate: string;
      let lastUploadTime: string;

      if (isCustom) {
        // Roll forward by custom interval hours from the batch start baseline
        const nextStartMs = batchStartMs + customIntervalHours * 3600000;
        const nextStart = new Date(nextStartMs);
        schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
        schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;
        
        lastUploadDate = schedDate;
        lastUploadTime = schedTime;
      } else {
        const nextStartMs = batchEndMs + intervalMin * 60000;
        const nextStart = new Date(nextStartMs);
        schedDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth()+1).padStart(2,'0')}-${String(nextStart.getDate()).padStart(2,'0')}`;
        schedTime = `${String(nextStart.getHours()).padStart(2,'0')}:${String(nextStart.getMinutes()).padStart(2,'0')}`;

        const lastUpload = new Date(batchEndMs);
        lastUploadDate = `${lastUpload.getFullYear()}-${String(lastUpload.getMonth()+1).padStart(2,'0')}-${String(lastUpload.getDate()).padStart(2,'0')}`;
        lastUploadTime = `${String(lastUpload.getHours()).padStart(2,'0')}:${String(lastUpload.getMinutes()).padStart(2,'0')}`;
      }

      const updData = loadGrokbotData();
      if (updData.states[stateFile]) {
        updData.states[stateFile].scheduleDate = schedDate;
        updData.states[stateFile].scheduleTime = schedTime;
        updData.states[stateFile].lastUploadDate = lastUploadDate;
        updData.states[stateFile].lastUploadTime = lastUploadTime;
        saveGrokbotData(updData);
      }

      grokbotLog(`⏭ Batch selanjutnya akan dijadwalkan mulai: ${schedDate} ${schedTime}`);

      // Refresh utama
      try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch { marks = {}; }
      allUtamaVideos = fs.readdirSync(stateDownloadDir)
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .sort();
      pendingUtamaVideos = allUtamaVideos.filter(v => !marks[v]);

      if (pendingUtamaVideos.length === 0) {
        grokbotLog(`✅ Semua video dan link untuk ${tiktokStateName} sudah diproses`);
        break;
      }
    }
  } catch (err: any) {
    success = false;
    lastError = err.message;
    grokbotLog(`❌ Loop error: ${err.message}`);
  } finally {
    // Mark done
    const qIdx2 = grokbotQueue.findIndex(q => q.stateFile === stateFile);
    if (qIdx2 >= 0) { grokbotQueue[qIdx2].active = false; grokbotBroadcastQueue(); }
    notifyScheduleFinished(tiktokStateName, success, totalUploadedThisSession, lastError);
  }
}

app.post('/api/grokbot/schedule', async (req, res) => {
  if (grokbotRunning || infiniteGenRunning || grokbotFullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  grokbotRunning = true;
  grokbotQueue = [];
  res.json({ success: true, message: 'Jadwal dimulai' });
  sendWAMessage(`🚀 [${tiktokStateName}] Jadwalkan & Upload dimulai! (Memeriksa stok...)`);

  try {
    await grokbotRunState(stateFile);
  } catch (e: any) {
    grokbotLog(`❌ Fatal: ${e.message}`);
    sendWAMessage(`❌ [${tiktokStateName}] Fatal error saat Jadwalkan & Upload: ${e.message}`);
  } finally {
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotLog('===== GROKBOT FINISHED =====');
  }
});

function getStateNextTrigger(sf: string): { stateName: string; triggerTime: Date | null; targetTime: Date | null } {
  const data = loadGrokbotData();
  const cfg = data.states[sf];
  const stateName = sf.replace('tiktok-state-', '').replace('.json', '');
  if (!cfg) return { stateName, triggerTime: null, targetTime: null };

  const lastDate = cfg.lastUploadDate;
  const lastTime = cfg.lastUploadTime;
  const intervalMin = cfg.threeUploadsPerHour ? (cfg.intervalMinutes || 300) : (cfg.intervalMinutes || 60);

  if (!lastDate || !lastTime) {
    // If lastUpload is not set, use scheduleDate/scheduleTime directly as next upload time, so lastUpload is next - interval
    const schedDate = cfg.scheduleDate;
    const schedTime = cfg.scheduleTime;
    if (!schedDate || !schedTime) return { stateName, triggerTime: null, targetTime: null };
    const nextUploadTime = new Date(`${schedDate}T${schedTime}:00`);
    if (isNaN(nextUploadTime.getTime())) return { stateName, triggerTime: null, targetTime: null };
    const lastUploadTime = new Date(nextUploadTime.getTime() - intervalMin * 60000);
    const triggerTime = new Date(lastUploadTime.getTime() - 5 * 3600000);
    return { stateName, triggerTime, targetTime: nextUploadTime };
  }

  const lastUploadTime = new Date(`${lastDate}T${lastTime}:00`);
  if (isNaN(lastUploadTime.getTime())) return { stateName, triggerTime: null, targetTime: null };
  const triggerTime = new Date(lastUploadTime.getTime() - 5 * 3600000);
  const targetTime = new Date(lastUploadTime.getTime() + intervalMin * 60000);
  return { stateName, triggerTime, targetTime };
}

async function grokbotRunFullAuto(stateFiles: string[]): Promise<void> {
  grokbotLog(`♾️ Memulai Full Auto standby loop untuk ${stateFiles.length} state...`);
  
  const autoData = loadGrokbotData();
  const autoGlobalConfig = autoData.globalConfig;
  const autoIsCustom = autoGlobalConfig?.fullAuto?.enableCustomScheduler;
  const autoCustomIntervalHours = autoGlobalConfig?.fullAuto?.customIntervalHours || 10;
  const autoCustomUploadCount = autoGlobalConfig?.fullAuto?.customUploadCount || 5;

  let startWAMsg = "";
  if (autoIsCustom) {
    startWAMsg = `📢 [Full Auto] Mulai dengan Custom Scheduler (Interval: ${autoCustomIntervalHours} jam, Jumlah Video: ${autoCustomUploadCount} video/batch).`;
  } else {
    startWAMsg = `📢 [Full Auto] Mulai dengan Standard Scheduler (Interval mengikuti masing-masing state).`;
  }
  sendWAMessage(startWAMsg);

  grokbotQueue = stateFiles.map(sf => {
    const name = sf.replace('tiktok-state-', '').replace('.json', '');
    return { stateName: name, stateFile: sf, videoCount: 0, scheduleStart: 'Standby', scheduleEnd: 'Standby', active: false };
  });
  grokbotBroadcastQueue();

  while (grokbotFullAutoRunning) {
    if (!grokbotFullAutoRunning) break;

    if (grokbotRunning) {
      let slept = 0;
      while (slept < 10000 && grokbotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        slept += 2000;
      }
      continue;
    }

    const now = new Date();
    let triggeredStateFile: string | null = null;
    let nextStateName = 'Tidak ada';
    let nextScheduleTimeStr = 'Tidak ada';
    let earliestTriggerTime = Infinity;

    for (const sf of stateFiles) {
      const { triggerTime, targetTime, stateName } = getStateNextTrigger(sf);
      if (!triggerTime) continue;

      const triggerTimeMs = triggerTime.getTime();

      if (now.getTime() >= triggerTimeMs && !triggeredStateFile) {
        triggeredStateFile = sf;
      }

      if (triggerTimeMs > now.getTime() && triggerTimeMs < earliestTriggerTime) {
        earliestTriggerTime = triggerTimeMs;
        nextStateName = stateName;
        nextScheduleTimeStr = `${triggerTime.getFullYear()}-${String(triggerTime.getMonth()+1).padStart(2,'0')}-${String(triggerTime.getDate()).padStart(2,'0')} ${String(triggerTime.getHours()).padStart(2,'0')}:${String(triggerTime.getMinutes()).padStart(2,'0')}`;
      }
    }

    if (triggeredStateFile) {
      const stateName = triggeredStateFile.replace('tiktok-state-', '').replace('.json', '');
      grokbotLog(`🎯 [Full Auto] State terpicu: ${stateName}. Menyiapkan eksekusi...`);

      grokbotQueue = grokbotQueue.map(q => ({ ...q, active: q.stateFile === triggeredStateFile }));
      grokbotBroadcastQueue();

      let futureNextStateName = 'Tidak ada';
      let futureNextScheduleTimeStr = 'Tidak ada';
      let futureEarliestTriggerTime = Infinity;
      for (const sf of stateFiles) {
        if (sf === triggeredStateFile) continue;
        const { triggerTime, stateName } = getStateNextTrigger(sf);
        if (triggerTime) {
          const triggerTimeMs = triggerTime.getTime();
          if (triggerTimeMs > now.getTime() && triggerTimeMs < futureEarliestTriggerTime) {
            futureEarliestTriggerTime = triggerTimeMs;
            futureNextStateName = stateName;
            futureNextScheduleTimeStr = `${triggerTime.getFullYear()}-${String(triggerTime.getMonth()+1).padStart(2,'0')}-${String(triggerTime.getDate()).padStart(2,'0')} ${String(triggerTime.getHours()).padStart(2,'0')}:${String(triggerTime.getMinutes()).padStart(2,'0')}`;
          }
        }
      }

      const { targetTime } = getStateNextTrigger(triggeredStateFile);
      const startSchedStr = targetTime ? `${targetTime.getFullYear()}-${String(targetTime.getMonth()+1).padStart(2,'0')}-${String(targetTime.getDate()).padStart(2,'0')} ${String(targetTime.getHours()).padStart(2,'0')}:${String(targetTime.getMinutes()).padStart(2,'0')}` : 'Tidak diketahui';
      
      const lastUploadTime = new Date(targetTime ? targetTime.getTime() - (loadGrokbotData().states[triggeredStateFile]?.intervalMinutes || 60) * 60000 : Date.now());
      const lastUploadTimeStr = `${lastUploadTime.getFullYear()}-${String(lastUploadTime.getMonth()+1).padStart(2,'0')}-${String(lastUploadTime.getDate()).padStart(2,'0')} ${String(lastUploadTime.getHours()).padStart(2,'0')}:${String(lastUploadTime.getMinutes()).padStart(2,'0')}`;

      let waMsg = `🚀 [Full Auto] Mulai Penjadwalan Otomatis!\n`;
      waMsg += `🔑 State: ${stateName}\n`;
      waMsg += `📅 Upload Terakhir: ${lastUploadTimeStr}\n`;
      waMsg += `⏰ Sched Target Start: ${startSchedStr}\n`;
      waMsg += `⏭️ Antrian Selanjutnya: State ${futureNextStateName} pada ${futureNextScheduleTimeStr}`;
      sendWAMessage(waMsg);

      grokbotRunning = true;
      try {
        await grokbotRunState(triggeredStateFile, true);
      } catch (err: any) {
        grokbotLog(`❌ [Full Auto] Gagal menjalankan penjadwalan: ${err.message}`);
      } finally {
        grokbotRunning = false;
        resetGrokbotProgress();
        grokbotBroadcastProgress();
      }

      grokbotQueue = grokbotQueue.map(q => ({ ...q, active: false }));
      grokbotBroadcastQueue();
    } else {
      let slept = 0;
      while (slept < 10000 && grokbotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        slept += 2000;
      }
    }
  }

  grokbotLog('===== FULL AUTO STANDBY LOGIC STOPPED =====');
}

app.post('/api/grokbot/full-auto', async (req, res) => {
  if (grokbotRunning || grokbotFullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  grokbotFullAutoRunning = true;
  grokbotQueue = [];
  res.json({ success: true, message: 'Full Auto Standby Mode dimulai' });

  try {
    await grokbotRunFullAuto(stateFiles);
  } catch (e: any) {
    grokbotLog(`❌ Fatal Full Auto: ${e.message}`);
  } finally {
    grokbotFullAutoRunning = false;
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotLog('===== FULL AUTO FINISHED =====');
  }
});

function getRateLimitExpiryDate(availableAt: string, detectedAt: number): Date | null {
  if (!availableAt) return null;
  const clean = availableAt.replace(/wib|wita|wit/gi, '').replace(/\./g, ':').trim();
  const match = clean.match(/^([0-9]{1,2}):([0-9]{2})(?:\s*(AM|PM|am|pm))?$/i);
  if (!match) return null;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const ampm = match[3];

  if (ampm) {
    const isPm = ampm.toLowerCase() === 'pm';
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
  }

  const expiry = new Date(detectedAt);
  expiry.setHours(hours, minutes, 0, 0);

  // If target time is before detection time, it rolled over past midnight
  if (expiry.getTime() < detectedAt) {
    expiry.setDate(expiry.getDate() + 1);
  }
  return expiry;
}

function parseAvailableAt(availableAt: string): number {
  if (!availableAt) return 15 * 60 * 1000; // default 15 mins fallback

  // Clean characters, remove WIB/WITA/WIT, replace dots with colons
  const clean = availableAt.replace(/wib|wita|wit/gi, '').replace(/\./g, ':').trim();
  
  // Match standard time format e.g. "10:29", "2:15 PM", "10:29 AM", "14:15"
  const match = clean.match(/^([0-9]{1,2}):([0-9]{2})(?:\s*(AM|PM|am|pm))?$/i);
  if (!match) {
    return 15 * 60 * 1000; // 15 mins fallback
  }

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const ampm = match[3];

  if (ampm) {
    const isPm = ampm.toLowerCase() === 'pm';
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
  }

  const now = new Date();
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);

  // If target time is in the past, it means the next day (tomorrow)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  const delayMs = target.getTime() - now.getTime();
  return delayMs > 0 ? delayMs : 15 * 60 * 1000;
}

async function grokbotRunInfinite(stateFiles: string[]): Promise<void> {
  grokbotLog(`♾️ Memulai infinite generator loop untuk ${stateFiles.length} state...`);
  
  // Set initial queue showing inactive state
  grokbotQueue = stateFiles.map(sf => {
    const name = sf.replace('tiktok-state-', '').replace('.json', '');
    return { stateName: name, stateFile: sf, videoCount: 0, scheduleStart: 'Infinite Gen', scheduleEnd: 'Infinite Gen', active: false };
  });
  grokbotBroadcastQueue();

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  interface StateStockInfo {
    stateFile: string;
    stateName: string;
    grokState: string;
    cfg: any;
    pendingUtama: string[];
    pendingCadangan: string[];
    neededUtama: number;
    neededCadangan: number;
    totalStock: number;
    needsStock: boolean;
    isRateLimited: boolean;
    rateLimitDelayMs: number;
    rateLimitAvailableAt: string;
  }

  // Helper: gather stock info for all states
  const gatherStatesInfo = (): StateStockInfo[] => {
    const statesInfo: StateStockInfo[] = [];
    for (const sf of stateFiles) {
      const data = loadGrokbotData();
      const cfg = data.states[sf];
      if (!cfg) { grokbotLog(`❌ Config tidak ditemukan untuk state: ${sf}`); continue; }
      const grokState = cfg.grokState;
      if (!grokState) { grokbotLog(`❌ Grok State belum diatur untuk TikTok state ${sf}`); continue; }

      const tiktokStateName = sf.replace('tiktok-state-', '').replace('.json', '');
      const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
      const rawDir = path.join(stateDownloadDir, 'raw');
      const cadanganDir = path.join(stateDownloadDir, 'cadangan');
      if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });
      if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
      if (!fs.existsSync(cadanganDir)) fs.mkdirSync(cadanganDir, { recursive: true });

      const marksFile = path.join(stateDownloadDir, '.uploaded.json');
      let marks: Record<string, boolean> = {};
      try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      const cadanganMarksFile = path.join(cadanganDir, '.uploaded.json');
      let cadanganMarks: Record<string, boolean> = {};
      try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

      const allUtama = fs.readdirSync(stateDownloadDir).filter(f => exts.includes(path.extname(f).toLowerCase()));
      const pendingUtama = allUtama.filter(v => !marks[v]);
      const allCadangan = fs.readdirSync(cadanganDir).filter(f => exts.includes(path.extname(f).toLowerCase()));
      const pendingCadangan = allCadangan.filter(v => !cadanganMarks[v]);

      const neededUtama = Math.max(0, 30 - pendingUtama.length);
      const neededCadangan = Math.max(0, 30 - pendingCadangan.length);
      const totalStock = pendingUtama.length + pendingCadangan.length;
      const needsStock = neededUtama > 0 || neededCadangan > 0;

      let isRateLimited = false;
      let rateLimitDelayMs = 0;
      let rateLimitAvailableAt = '';
      const rateLimits = getGrokRateLimits();
      if (rateLimits[grokState]) {
        const resetStr = rateLimits[grokState].availableAt;
        const detectedAt = rateLimits[grokState].detectedAt || Date.now();
        const expiry = resetStr ? getRateLimitExpiryDate(resetStr, detectedAt) : null;
        
        if (expiry && Date.now() >= expiry.getTime()) {
          // Expiration passed, clear it
          clearGrokRateLimit(grokState);
          grokbotLog(`⚡ [${tiktokStateName}] Rate limit sudah berakhir (tersedia sejak pukul ${resetStr}). Membersihkan status rate limit.`);
        } else {
          isRateLimited = true;
          rateLimitAvailableAt = resetStr || 'tidak diketahui';
          rateLimitDelayMs = expiry ? Math.max(0, expiry.getTime() - Date.now()) : (15 * 60 * 1000);
        }
      }

      statesInfo.push({ stateFile: sf, stateName: tiktokStateName, grokState, cfg, pendingUtama, pendingCadangan, neededUtama, neededCadangan, totalStock, needsStock, isRateLimited, rateLimitDelayMs, rateLimitAvailableAt });
    }
    return statesInfo;
  };

  // Helper: select best candidate (lowest total stock; random if tied at 0)
  const selectBestCandidate = (candidates: StateStockInfo[]): StateStockInfo => {
    candidates.sort((a, b) => a.totalStock - b.totalStock);
    const lowestStock = candidates[0].totalStock;
    const tied = candidates.filter(c => c.totalStock === lowestStock);
    if (tied.length > 1 && lowestStock === 0) {
      return tied[Math.floor(Math.random() * tied.length)];
    }
    return tied[0];
  };

  // Nested helpers for generating Utama/Cadangan for a chosen targetState
  const runUtamaGen = async (targetState: StateStockInfo) => {
    const { cfg, grokState, neededUtama, pendingUtama, stateName } = targetState;
    const tiktokStateName = stateName;
    const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
    const mergeEnabled = cfg.merge !== false;

    const totalRawToGenerate = mergeEnabled ? (2 * neededUtama) : neededUtama;
    grokbotLog(`🚀 [${tiktokStateName}] Generate Stok Utama: dibutuhkan ${neededUtama} video (raw: ${totalRawToGenerate}) (Stok saat ini: ${pendingUtama.length})`);
    sendWAMessage(`🤖 [${tiktokStateName}] Mulai generate stok utama (dibutuhkan: ${neededUtama} video)...`);
    
    resetGrokbotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? neededUtama : 0, generate: 0, merge: 0 });
    grokbotBroadcastProgress();

    const grokConfig = {
      stateFile: grokState, statesDir: GROK_STATES_DIR,
      bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
      promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
      mode: cfg.mode || 'Video', resolution: cfg.resolution || '720p',
      duration: cfg.duration || '10s', aspectRatio: cfg.aspectRatio || '9:16',
      headless: isHeadlessEnabled(`tiktok-state-${tiktokStateName}.json`), downloadDir: GROK_DOWNLOAD_DIR,
      customDownloadDir: stateDownloadDir, totalVideos: totalRawToGenerate,
      merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
      parallelBrowsers: loadGrokbotData().globalConfig?.parallelBrowsers || 1,
    };

    const poll = setInterval(() => {
      if (!grokbotRunning) { clearInterval(poll); return; }
      const stats = getGrokStats();
      const progressList = getBrowserProgress();
      const doneCount = stats.success + stats.failed;
      let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
      let activeCount = 0; let activeProgSum = 0;
      progressList.forEach(bp => { if (bp.status === 'running') { activeCount++; activeProgSum += bp.progress; } });
      if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
      grokbotProgress.generate = Math.min(99, overallGen);
      if (mergeEnabled) {
        grokbotProgress.mergedCount = stats.saved;
        grokbotProgress.mergeTotal = neededUtama;
        grokbotProgress.merge = Math.min(99, Math.round((stats.saved / neededUtama) * 100));
      } else { grokbotProgress.merge = 100; }
      grokbotBroadcastProgress();
    }, 2000);

    try {
      await runGrokGenerator(grokConfig as any, grokbotLog, __dirname);
      clearInterval(poll);
      grokbotProgress.generate = 100; grokbotProgress.merge = 100; grokbotBroadcastProgress();
      grokbotLog(`✓ Stok Utama untuk ${tiktokStateName} berhasil ditambahkan!`);
      sendWAMessage(`🤖 [${tiktokStateName}] Selesai generate stok utama!`);
    } catch (err: any) {
      clearInterval(poll);
      grokbotLog(`❌ Gagal generate Utama untuk ${tiktokStateName}: ${err.message}`);
      sendWAMessage(`❌ [${tiktokStateName}] Gagal generate Utama: ${err.message}`);
    }
  };

  const runCadanganGen = async (targetState: StateStockInfo) => {
    const { cfg, grokState, neededCadangan, pendingCadangan, stateName } = targetState;
    const tiktokStateName = stateName;
    const stateDownloadDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
    const cadanganDir = path.join(stateDownloadDir, 'cadangan');
    const mergeEnabled = cfg.merge !== false;

    const totalRawToGenerate = mergeEnabled ? (2 * neededCadangan) : neededCadangan;
    grokbotLog(`🚀 [${tiktokStateName}] Generate Stok Cadangan: dibutuhkan ${neededCadangan} video (raw: ${totalRawToGenerate}) (Stok saat ini: ${pendingCadangan.length})`);
    sendWAMessage(`🤖 [${tiktokStateName}] Mulai generate stok cadangan (dibutuhkan: ${neededCadangan} video)...`);
    
    resetGrokbotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? neededCadangan : 0, generate: 0, merge: 0 });
    grokbotBroadcastProgress();

    const grokConfig = {
      stateFile: grokState, statesDir: GROK_STATES_DIR,
      bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
      promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
      mode: cfg.mode || 'Video', resolution: cfg.resolution || '720p',
      duration: cfg.duration || '10s', aspectRatio: cfg.aspectRatio || '9:16',
      headless: isHeadlessEnabled(`tiktok-state-${tiktokStateName}.json`), downloadDir: GROK_DOWNLOAD_DIR,
      customDownloadDir: cadanganDir, totalVideos: totalRawToGenerate,
      merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
      parallelBrowsers: loadGrokbotData().globalConfig?.parallelBrowsers || 1,
    };

    const poll = setInterval(() => {
      if (!grokbotRunning) { clearInterval(poll); return; }
      const stats = getGrokStats();
      const progressList = getBrowserProgress();
      const doneCount = stats.success + stats.failed;
      let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
      let activeCount = 0; let activeProgSum = 0;
      progressList.forEach(bp => { if (bp.status === 'running') { activeCount++; activeProgSum += bp.progress; } });
      if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
      grokbotProgress.generate = Math.min(99, overallGen);
      if (mergeEnabled) {
        grokbotProgress.mergedCount = stats.saved;
        grokbotProgress.mergeTotal = neededCadangan;
        grokbotProgress.merge = Math.min(99, Math.round((stats.saved / neededCadangan) * 100));
      } else { grokbotProgress.merge = 100; }
      grokbotBroadcastProgress();
    }, 2000);

    try {
      await runGrokGenerator(grokConfig as any, grokbotLog, __dirname);
      clearInterval(poll);
      grokbotProgress.generate = 100; grokbotProgress.merge = 100; grokbotBroadcastProgress();
      grokbotLog(`✓ Stok Cadangan untuk ${tiktokStateName} berhasil ditambahkan!`);
      sendWAMessage(`🤖 [${tiktokStateName}] Selesai generate stok cadangan!`);
    } catch (err: any) {
      clearInterval(poll);
      grokbotLog(`❌ Gagal generate Cadangan untuk ${tiktokStateName}: ${err.message}`);
      sendWAMessage(`❌ [${tiktokStateName}] Gagal generate Cadangan: ${err.message}`);
    }
  };

  // Helper: run generation for a target state
  const runGenerationForState = async (targetState: StateStockInfo) => {
    // Set grokbotRunning ONLY during active generation
    grokbotRunning = true;

    // Highlight active state in queue UI
    grokbotQueue = grokbotQueue.map(q => ({ ...q, active: q.stateFile === targetState.stateFile }));
    grokbotBroadcastQueue();

    clearGrokRateLimit(targetState.grokState);

    if (targetState.pendingUtama.length <= targetState.pendingCadangan.length) {
      if (targetState.neededUtama > 0) await runUtamaGen(targetState);
      if (infiniteGenRunning && !getGrokRateLimits()[targetState.grokState]) {
        if (targetState.neededCadangan > 0) await runCadanganGen(targetState);
      }
    } else {
      if (targetState.neededCadangan > 0) await runCadanganGen(targetState);
      if (infiniteGenRunning && !getGrokRateLimits()[targetState.grokState]) {
        if (targetState.neededUtama > 0) await runUtamaGen(targetState);
      }
    }

    // Release grokbotRunning after generation phase
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
  };

  // ══════════════════════════════════════════════
  // MAIN INFINITE LOOP
  // ══════════════════════════════════════════════
  while (infiniteGenRunning) {
    // 1. Gather fresh state info
    const statesInfo = gatherStatesInfo();
    if (!infiniteGenRunning) break;

    // 2. Update queue UI
    grokbotQueue = stateFiles.map(sf => {
      const name = sf.replace('tiktok-state-', '').replace('.json', '');
      const info = statesInfo.find(s => s.stateFile === sf);
      return { stateName: name, stateFile: sf, videoCount: info ? info.totalStock : 0, scheduleStart: 'Infinite Gen', scheduleEnd: 'Infinite Gen', active: false };
    });
    grokbotBroadcastQueue();

    // 3. Filter candidates that need stock
    const candidates = statesInfo.filter(s => s.needsStock);

    // 4. If all stocked up, sleep 30s
    if (candidates.length === 0) {
      grokbotLog(`✨ Semua state sudah memiliki stok penuh. Tidur 30 detik...`);
      let slept = 0;
      while (slept < 30000 && infiniteGenRunning) { await new Promise(r => setTimeout(r, 2000)); slept += 2000; }
      continue;
    }

    // 5. Separate non-rate-limited vs rate-limited
    const nonRateLimited = candidates.filter(c => !c.isRateLimited);
    const rateLimitedCandidates = candidates.filter(c => c.isRateLimited);

    if (nonRateLimited.length > 0) {
      // 6A. Pick the best non-rate-limited candidate
      const targetState = selectBestCandidate(nonRateLimited);
      grokbotLog(`🎯 State terpilih: ${targetState.stateName} (utama: ${targetState.pendingUtama.length}, cadangan: ${targetState.pendingCadangan.length})`);
      sendWAMessage(`🤖 State ${targetState.stateName} stok paling sedikit (utama: ${targetState.pendingUtama.length}, cadangan: ${targetState.pendingCadangan.length}). Memulai generate...`);

      await runGenerationForState(targetState);
    } else {
      // 6B. ALL candidates are rate-limited — smart wait
      const sortedByDelay = [...rateLimitedCandidates].sort((a, b) => a.rateLimitDelayMs - b.rateLimitDelayMs);
      const nextAvailable = sortedByDelay[0];
      const delayMs = nextAvailable.rateLimitDelayMs;
      const resumeDelayMs = delayMs + 60000; // +1 minute buffer

      // Select which state to generate for when rate limit expires
      const targetStateForGen = selectBestCandidate(rateLimitedCandidates);

      const rateLimitTime = nextAvailable.rateLimitAvailableAt;
      const resumeDate = new Date(Date.now() + resumeDelayMs);
      const resumeTimeStr = `${String(resumeDate.getHours()).padStart(2, '0')}:${String(resumeDate.getMinutes()).padStart(2, '0')}`;

      grokbotLog(`🚫 Semua akun Grok rate limited!`);
      for (const r of rateLimitedCandidates) {
        grokbotLog(` - [${r.stateName}] Rate Limit aktif! Tersedia kembali pukul: ${r.rateLimitAvailableAt}`);
      }
      grokbotLog(`⏳ Rate limit paling cepat selesai: ${rateLimitTime}`);
      grokbotLog(`🔄 Akan mulai generate lagi pukul: ${resumeTimeStr}`);
      grokbotLog(`🎯 Akun yang akan diisi stoknya: ${targetStateForGen.stateName} (utama: ${targetStateForGen.pendingUtama.length}, cadangan: ${targetStateForGen.pendingCadangan.length})`);

      // Send detailed WhatsApp notification
      let waMsg = `🚫 Semua akun Grok rate limited!\n`;
      waMsg += `⏰ Rate limit paling cepat selesai: ${rateLimitTime}\n`;
      waMsg += `🔄 Akan mulai generate lagi: ${resumeTimeStr}\n`;
      waMsg += `🎯 Akun yang akan diisi stoknya: ${targetStateForGen.stateName} (utama: ${targetStateForGen.pendingUtama.length}, cadangan: ${targetStateForGen.pendingCadangan.length})`;
      sendWAMessage(waMsg);

      // Broadcast waiting status via SSE
      infiniteGenWaitInfo = { rateLimitTime, resumeTime: resumeTimeStr, targetState: targetStateForGen.stateName };
      grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:${JSON.stringify(infiniteGenWaitInfo)}\n\n`));

      // Interruptible sleep until resume time
      const sleepInterval = 2000;
      let elapsed = 0;
      while (elapsed < resumeDelayMs && infiniteGenRunning) {
        await new Promise(r => setTimeout(r, Math.min(sleepInterval, resumeDelayMs - elapsed)));
        elapsed += sleepInterval;

        // Check if any rate limit was cleared manually
        const rateLimitsAfter = getGrokRateLimits();
        let cleared = false;
        for (const r of rateLimitedCandidates) {
          if (!rateLimitsAfter[r.grokState]) {
            grokbotLog(`⚡ [${r.stateName}] Rate limit di-reset! Melanjutkan proses...`);
            cleared = true;
            break;
          }
        }
        if (cleared) break;
      }

      infiniteGenWaitInfo = null;
      grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:null\n\n`));

      if (!infiniteGenRunning) break;

      // Re-gather fresh info after sleep (stocks/rate limits may have changed)
      const freshInfo = gatherStatesInfo();
      const freshCandidates = freshInfo.filter(s => s.needsStock && !s.isRateLimited);

      if (freshCandidates.length > 0) {
        const freshTarget = selectBestCandidate(freshCandidates);
        grokbotLog(`▶️ Waktu tunggu selesai. Memulai generate untuk state: ${freshTarget.stateName}`);
        sendWAMessage(`▶️ State ${freshTarget.stateName} memulai generate Grok.`);
        await runGenerationForState(freshTarget);
      } else {
        grokbotLog(`⏳ Semua akun masih rate limited setelah waktu tunggu. Loop kembali...`);
      }
    }
  }
}

app.post('/api/grokbot/infinite-generate', async (req, res) => {
  if (infiniteGenRunning) return res.status(400).json({ success: false, error: 'Infinite Generate sudah berjalan!' });
  if (grokbotRunning) return res.status(400).json({ success: false, error: 'Grokbot sedang berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  infiniteGenRunning = true;
  // grokbotRunning is NOT set here — it will be set only during active generation phases
  grokbotQueue = [];

  // Pre-check: gather rate limit info and send initial WA notification
  const rateLimits = getGrokRateLimits();
  const rateLimitEntries = Object.entries(rateLimits);
  let initMsg = `♾️ Infinite Generate dimulai! (${stateFiles.length} state)\n`;
  if (rateLimitEntries.length > 0) {
    initMsg += `\n🚫 Rate Limit terdeteksi:\n`;
    for (const [key, val] of rateLimitEntries) {
      const name = key.replace('grok-state-', '').replace('.json', '');
      initMsg += `- ${name}: tersedia pukul ${(val as any).availableAt || 'tidak diketahui'}\n`;
    }
  } else {
    initMsg += `✅ Tidak ada rate limit aktif. Generate segera dimulai.`;
  }
  sendWAMessage(initMsg);

  res.json({ success: true, message: 'Infinite Generate dimulai' });

  try {
    await grokbotRunInfinite(stateFiles);
  } catch (e: any) {
    grokbotLog(`❌ Fatal: ${e.message}`);
  } finally {
    infiniteGenRunning = false;
    infiniteGenWaitInfo = null;
    grokbotRunning = false;
    resetGrokbotProgress();
    grokbotBroadcastProgress();
    grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:null\n\n`));
    grokbotLog('===== INFINITE GENERATE FINISHED =====');
    sendWAMessage("♾️ Infinite Generate selesai!");
  }
});

app.get('/api/grokbot/status', (req, res) => {
  res.json({ running: grokbotRunning, infiniteGenRunning, infiniteGenWaitInfo, grokbotFullAutoRunning, queue: grokbotQueue, progress: grokbotProgress, rateLimits: getGrokRateLimits() });
});

app.post('/api/grokbot/stop', async (req, res) => {
  infiniteGenRunning = false;
  infiniteGenWaitInfo = null;
  grokbotFullAutoRunning = false;
  grokbotRunning = false;
  resetGrokbotProgress();
  grokbotBroadcastProgress();
  grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:null\n\n`));
  await stopGrokGenerator();
  await stopUploader();
  grokbotLog('⛔ ===== GROKBOT STOPPED =====');
  res.json({ success: true });
});

app.post('/api/grokbot/stop-full-auto', (req, res) => {
  grokbotFullAutoRunning = false;
  grokbotLog('⛔ ===== FULL AUTO STANDBY STOPPED =====');
  res.json({ success: true });
});

app.post('/api/grokbot/stop-infinite-generate', async (req, res) => {
  infiniteGenRunning = false;
  infiniteGenWaitInfo = null;
  grokbotSseClients.forEach(c => c.write(`data: [INFINITE_WAIT]:null\n\n`));
  await stopGrokGenerator();
  grokbotLog('⛔ ===== INFINITE GENERATE STOPPED =====');
  res.json({ success: true });
});

app.get('/api/grokbot/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  grokbotSseClients.push(res);
  req.on('close', () => {
    const idx = grokbotSseClients.indexOf(res);
    if (idx >= 0) grokbotSseClients.splice(idx, 1);
  });
});


// ═══════════════════════════════════════════════════════════
//  GROKBOT V2 CONSTANTS & PERSISTENCE
// ═══════════════════════════════════════════════════════════
const GROKBOTV2_DATA_FILE = path.join(__dirname, 'grokbotv2-data.json');

interface InfiniteScheduleStateConfig {
  stateFile: string;
  order: number;
  scheduleDate: string;
  scheduleTime: string;
}

interface InfiniteScheduleConfig {
  active: boolean;
  initialRunAt: string;
  currentIndex: number;
  started: boolean;
  states: InfiniteScheduleStateConfig[];
  updatedAt: string;
}

interface GrokbotV2Data {
  states: Record<string, GrokbotStateConfig>;
  infiniteSchedule?: InfiniteScheduleConfig;
  globalConfig?: {
    parallelBrowsers?: number;
    headless?: boolean;
    sendWhatsApp?: boolean;
    fullAuto?: {
      enableCustomScheduler?: boolean;
      customIntervalHours?: number;
      customUploadCount?: number;
      headless?: boolean;
    };
  };
}

function loadGrokbotV2Data(): GrokbotV2Data {
  try {
    return JSON.parse(fs.readFileSync(GROKBOTV2_DATA_FILE, 'utf-8'));
  } catch {
    return { states: {} };
  }
}

function saveGrokbotV2Data(data: GrokbotV2Data) {
  fs.writeFileSync(GROKBOTV2_DATA_FILE, JSON.stringify(data, null, 2));
}

function isHeadlessEnabledV2(stateFile?: string): boolean {
  const data = loadGrokbotV2Data();
  if (data.globalConfig && data.globalConfig.headless === false) {
    return false;
  }
  if (stateFile && data.states && data.states[stateFile] && data.states[stateFile].headless === false) {
    return false;
  }
  return data.globalConfig?.headless !== false;
}

// Global state for Grokbot V2 SSE & Orchestration
const grokbotv2SseClients: Response[] = [];
let grokbotv2Running = false;
let infiniteGenV2Running = false;
let grokbotv2FullAutoRunning = false;
let grokbotv2InfiniteScheduleRunning = false;
let infiniteGenV2WaitInfo: { rateLimitTime: string; resumeTime: string; targetState: string; reason?: 'quota' | 'rate_limit' } | null = null;
const GROK_V2_INFINITE_GENERATION_INTERVAL_MS = 15 * 60 * 1000;
let grokV2NextGenerationAtMs = 0;
let grokbotv2Queue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let grokbotv2Progress: {
  generate: number;
  merge: number;
  upload: number;
  currentState: string;
  browsers: BrowserProgress[];
  uploadedCount: number;
  uploadTotal: number;
  mergedCount: number;
  mergeTotal: number;
  activeGrokState: string;
  autoSwitchGrokState: boolean;
  availableGrokAccounts: number;
  limitedGrokAccounts: string[];
  currentVideo: number;
  currentVideoTotal: number;
  currentVideoProgress: number;
  currentPhase: string;
} = {
  generate: 0,
  merge: 0,
  upload: 0,
  currentState: '',
  browsers: [],
  uploadedCount: 0,
  uploadTotal: 0,
  mergedCount: 0,
  mergeTotal: 0,
  activeGrokState: '',
  autoSwitchGrokState: false,
  availableGrokAccounts: 0,
  limitedGrokAccounts: [],
  currentVideo: 0,
  currentVideoTotal: 0,
  currentVideoProgress: 0,
  currentPhase: '',
};

function writeGrokbotv2Sse(payload: string) {
  const event = String(payload).split(/\r?\n/).map(line => `data: ${line}`).join('\n') + '\n\n';
  for (let i = grokbotv2SseClients.length - 1; i >= 0; i--) {
    const client = grokbotv2SseClients[i];
    if ((client as any).writableEnded || (client as any).destroyed) {
      grokbotv2SseClients.splice(i, 1);
      continue;
    }
    try {
      client.write(event);
    } catch {
      grokbotv2SseClients.splice(i, 1);
    }
  }
}

function grokbotv2Log(msg: string) {
  console.log(`[GROKBOTV2] ${msg}`);
  writeGrokbotv2Sse(msg);
}

// Wrapper WA untuk V2 — membaca sendWhatsApp dari grokbotv2-data.json
function sendWAMessageV2(msg: string) {
  const data = loadGrokbotV2Data();
  if (data.globalConfig?.sendWhatsApp === true) {
    originalSendWAMessage(msg);
  }
}

function grokbotv2BroadcastQueue() {
  writeGrokbotv2Sse(`[QUEUE_UPDATE]:${JSON.stringify(grokbotv2Queue)}`);
}

function grokbotv2BroadcastProgress() {
  grokbotv2Progress.browsers = getBrowserProgress();
  const progressWithRateLimits = {
    ...grokbotv2Progress,
    rateLimits: getGrokRateLimits()
  };
  writeGrokbotv2Sse(`[PROGRESS_UPDATE]:${JSON.stringify(progressWithRateLimits)}`);
}

function resetGrokbotv2Progress(overrides: Partial<typeof grokbotv2Progress> = {}) {
  grokbotv2Progress = {
    generate: 0, merge: 0, upload: 0, currentState: '',
    browsers: [], uploadedCount: 0, uploadTotal: 0,
    mergedCount: 0, mergeTotal: 0,
    activeGrokState: '', autoSwitchGrokState: false,
    availableGrokAccounts: 0, limitedGrokAccounts: [],
    currentVideo: 0, currentVideoTotal: 0, currentVideoProgress: 0, currentPhase: '',
    ...overrides
  };
}

interface GrokV2GenerationResult {
  allAccountsLimited: boolean;
  completedRaw: number;
  totalRaw: number;
  limitedAccounts: string[];
  lastAccount: string | null;
  fatalError?: string;
  recoverableError?: string;
}

function getGrokV2AccountPool(autoSwitch: boolean, fixedState?: string): string[] {
  const validStates = getSavedStates('grok')
    .filter(item => item.expiry.status !== 'expired')
    .filter(item => {
      try { JSON.parse(fs.readFileSync(path.join(GROK_STATES_DIR, item.filename), 'utf-8')); return true; } catch { return false; }
    })
    .map(item => item.filename)
    .sort((a, b) => a.localeCompare(b));
  if (!autoSwitch) return fixedState && validStates.includes(fixedState) ? [fixedState] : [];
  return validStates;
}

const GROK_V2_UNKNOWN_RATE_LIMIT_MS = 15 * 60 * 1000;
const GROK_V2_QUOTA_CACHE_TTL_MS = 45 * 1000;

interface GrokV2QuotaCacheEntry {
  value?: GrokQuotaInfo;
  expiresAt: number;
  promise?: Promise<GrokQuotaInfo>;
}

const grokV2QuotaCache = new Map<string, GrokV2QuotaCacheEntry>();

function makeExpiredGrokQuotaInfo(stateFile: string, stateName: string, checkedAt = new Date().toISOString()): GrokQuotaInfo {
  return {
    stateFile,
    stateName,
    account: stateName,
    usedPercent: null,
    remainingPercent: null,
    resetAt: null,
    available: false,
    status: 'expired',
    checkedAt,
    error: 'State Grok sudah expired.'
  };
}

async function getGrokV2Quota(stateFile: string, force = false): Promise<GrokQuotaInfo> {
  const now = Date.now();
  const cached = grokV2QuotaCache.get(stateFile);
  if (!force && cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;

  const stateName = stateFile.replace(/^grok-state-/, '').replace(/\.json$/i, '');
  const savedState = getSavedStates('grok').find(item => item.filename === stateFile);
  const promise = (async () => {
    if (savedState?.expiry.status === 'expired') return makeExpiredGrokQuotaInfo(stateFile, stateName);
    try {
      return await checkGrokQuota(stateFile);
    } catch (error: any) {
      return {
        stateFile,
        stateName,
        account: stateName,
        usedPercent: null,
        remainingPercent: null,
        resetAt: null,
        available: false,
        status: 'error' as const,
        checkedAt: new Date().toISOString(),
        error: error?.message || String(error)
      };
    }
  })();

  grokV2QuotaCache.set(stateFile, { expiresAt: 0, promise });
  try {
    const value = await promise;
    grokV2QuotaCache.set(stateFile, { value, expiresAt: Date.now() + GROK_V2_QUOTA_CACHE_TTL_MS });
    return value;
  } catch (error) {
    grokV2QuotaCache.delete(stateFile);
    throw error;
  }
}

async function refreshGrokV2Quotas(stateFiles: string[], force = false): Promise<GrokQuotaInfo[]> {
  const uniqueFiles = [...new Set(stateFiles)].filter(Boolean);
  const values: GrokQuotaInfo[] = [];
  // Query sequentially so checking many accounts does not launch many Chrome
  // instances simultaneously and overload the host/Cloudflare session.
  for (const stateFile of uniqueFiles) values.push(await getGrokV2Quota(stateFile, force));
  return values;
}

function getCachedGrokV2Quota(stateFile: string): GrokQuotaInfo | undefined {
  const value = grokV2QuotaCache.get(stateFile)?.value;
  if (value?.resetAt && Date.now() >= Date.parse(value.resetAt)) return undefined;
  return value;
}

function isGrokV2AccountQuotaUnavailable(stateFile: string): boolean {
  const info = getCachedGrokV2Quota(stateFile);
  return !!info && !info.available;
}

function getGrokV2QuotaWaitMs(accounts: string[]): number {
  const now = Date.now();
  const delays = accounts
    .map(account => getCachedGrokV2Quota(account))
    .filter((info): info is GrokQuotaInfo => !!info && !info.available)
    .map(info => info.resetAt ? Math.max(0, Date.parse(info.resetAt) - now) : GROK_V2_UNKNOWN_RATE_LIMIT_MS);
  return delays.length > 0 ? Math.min(...delays) : GROK_V2_UNKNOWN_RATE_LIMIT_MS;
}

function isGrokV2AccountUnavailable(stateFile: string): boolean {
  return isGrokV2AccountRateLimited(stateFile) || isGrokV2AccountQuotaUnavailable(stateFile);
}

function getGrokV2AvailableAccountPool(autoSwitch: boolean, fixedState?: string): string[] {
  return getGrokV2AccountPool(autoSwitch, fixedState).filter(account => !isGrokV2AccountUnavailable(account));
}

function isGrokV2AccountRateLimited(stateFile: string): boolean {
  const info = getGrokRateLimits()[stateFile];
  if (!info) return false;
  if (info.availableAt) {
    const expiry = getRateLimitExpiryDate(info.availableAt, info.detectedAt || Date.now());
    if (expiry && Date.now() >= expiry.getTime()) {
      clearGrokRateLimit(stateFile);
      return false;
    }
  } else if (Date.now() - (info.detectedAt || Date.now()) >= GROK_V2_UNKNOWN_RATE_LIMIT_MS) {
    // HTTP 429 responses often do not include a reset time. Use the same
    // conservative fallback as the legacy generator instead of blocking the
    // account forever.
    clearGrokRateLimit(stateFile);
    return false;
  }
  return true;
}

function getGrokV2RateLimitWaitMs(accounts: string[]): number {
  const now = Date.now();
  const rateLimits = getGrokRateLimits();
  const delays = accounts.map(account => {
    const info = rateLimits[account];
    if (info?.availableAt) {
      const expiry = getRateLimitExpiryDate(info.availableAt, info.detectedAt || now);
      if (expiry && expiry.getTime() > now) return expiry.getTime() - now;
    }
    return GROK_V2_UNKNOWN_RATE_LIMIT_MS;
  });
  return delays.length > 0 ? Math.min(...delays) : GROK_V2_UNKNOWN_RATE_LIMIT_MS;
}

function getGrokV2WaitMs(accounts: string[]): number {
  const now = Date.now();
  const delays: number[] = [];
  const rateLimits = getGrokRateLimits();
  for (const account of accounts) {
    if (isGrokV2AccountRateLimited(account)) {
      const info = rateLimits[account];
      if (info?.availableAt) {
        const expiry = getRateLimitExpiryDate(info.availableAt, info.detectedAt || now);
        delays.push(expiry && expiry.getTime() > now ? expiry.getTime() - now : GROK_V2_UNKNOWN_RATE_LIMIT_MS);
      } else {
        delays.push(GROK_V2_UNKNOWN_RATE_LIMIT_MS);
      }
      continue;
    }

    if (isGrokV2AccountQuotaUnavailable(account)) {
      const info = getCachedGrokV2Quota(account);
      if (info?.resetAt) {
        const resetAt = Date.parse(info.resetAt);
        delays.push(Number.isFinite(resetAt) && resetAt > now ? resetAt - now : GROK_V2_UNKNOWN_RATE_LIMIT_MS);
      } else {
        delays.push(GROK_V2_UNKNOWN_RATE_LIMIT_MS);
      }
    }
  }
  return delays.length > 0 ? Math.min(...delays) : GROK_V2_UNKNOWN_RATE_LIMIT_MS;
}

// ── GROKBOT V2 GENERATOR FUNCTION USING generateGrokVideoV2 ──
function resolveGrokV2GenerationIntervalMinutes(value: unknown, fallback = 15): number | null {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1440) return null;
  return parsed;
}

async function preflightGrokV2GenerationQuota(autoSwitch: boolean, fixedState: string): Promise<{
  accounts: string[];
  quotas: GrokQuotaInfo[];
  available: string[];
  unavailable: GrokQuotaInfo[];
}> {
  const accounts = getGrokV2AccountPool(autoSwitch, fixedState);
  const quotas = await refreshGrokV2Quotas(accounts, true);
  return {
    accounts,
    quotas,
    available: quotas.filter(info => info.available).map(info => info.stateFile),
    unavailable: quotas.filter(info => !info.available)
  };
}

function formatGrokV2QuotaPreflightDetails(unavailable: GrokQuotaInfo[]): string {
  return unavailable.map(info => {
    const reset = info.resetAt ? new Date(info.resetAt).toLocaleString('id-ID') : 'reset tidak diketahui';
    return `${info.stateName} (${info.usedPercent === null ? '?' : `${info.usedPercent}%`} terpakai, ${reset})`;
  }).join(', ');
}

async function runGrokGeneratorV2(config: {
  stateFile: string;
  grokState: string;
  bahanFolder: string;
  promptFile: string;
  mode: string;
  resolution: string;
  duration: string;
  aspectRatio: string;
  headless: boolean;
  totalVideos: number;
  merge?: boolean;
  audioFolder?: string;
  customDownloadDir?: string;
  autoSwitchGrokState?: boolean;
  generationIntervalMs?: number;
  notifyWhatsApp?: boolean;
  notificationLabel?: string;
}, log: (msg: string) => void): Promise<GrokV2GenerationResult> {
  const tiktokStateName = config.stateFile.replace('tiktok-state-', '').replace('.json', '');
  const targetDir = config.customDownloadDir || path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(targetDir, 'raw');
  // ── Debug log lengkap (grokv2-debug.js): semua event fetch/console di halaman Grok ──
  const grokDebugDir = path.join(__dirname, 'grokbotv2-logs');
  if (!fs.existsSync(grokDebugDir)) fs.mkdirSync(grokDebugDir, { recursive: true });
  const debugRunStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const debugRunLogPath = path.join(grokDebugDir, `run-${tiktokStateName}-${debugRunStamp}.log`);
  const debugWrite = (s: string) => { try { fs.appendFileSync(debugRunLogPath, s + '\n'); } catch {} };
  const debugLegendCache = new Set<string>(); // hindari baris yang sama berulang di UI
  const accountPool = getGrokV2AccountPool(!!config.autoSwitchGrokState, config.grokState);
  const limitedAccounts: string[] = [];
  let currentAccount = accountPool.find(account => !isGrokV2AccountUnavailable(account)) || null;
  let completedRaw = 0;

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  if (config.merge && !fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

  const mergeEnabled = config.merge !== false;
  const totalRawToGenerate = mergeEnabled ? config.totalVideos * 2 : config.totalVideos;
  let fatalError: string | null = null;
  let recoverableError: string | null = null;

  if (!currentAccount) {
    log('🚫 Tidak ada Grok State yang tersedia (seluruh akun limit, kedaluwarsa, atau belum dikonfigurasi).');
    return { allAccountsLimited: true, completedRaw, totalRaw: totalRawToGenerate, limitedAccounts: accountPool, lastAccount: null };
  }
  let grokStateName = currentAccount.replace('grok-state-', '').replace('.json', '');
  let grokSession: GrokV2Session | null = null;
  const tooManyRequestAttempts = new Map<number, number>();
  const transientGenerationAttempts = new Map<number, number>();
  const staleGenerationAttempts = new Map<number, number>();
  const generationIntervalMs = Math.max(0, Number(config.generationIntervalMs) || 0);
  // Infinite Generate memakai slot global agar jeda tetap berlaku saat berpindah
  // state atau memulai batch baru. Mode generate biasa tetap memakai jeda lama.
  const interVideoDelayMs = generationIntervalMs > 0 ? 0 : 20 * 1000;
  const maxTooManyRequestRetries = generationIntervalMs > 0 ? 2 : 6;
  const accountMode = config.autoSwitchGrokState ? `Auto Switch (${accountPool.length} akun)` : 'Akun Tetap';
  grokbotv2Progress.activeGrokState = currentAccount;
  grokbotv2Progress.autoSwitchGrokState = !!config.autoSwitchGrokState;
  grokbotv2Progress.availableGrokAccounts = accountPool.filter(account => !isGrokV2AccountUnavailable(account)).length;
  grokbotv2Progress.limitedGrokAccounts = accountPool.filter(isGrokV2AccountUnavailable);
  grokbotv2BroadcastProgress();
  log(`🚀 [GROK_V2_GENERATOR] Memulai generasi ${config.totalVideos} video (${totalRawToGenerate} raw) untuk TikTok State ${tiktokStateName} (${accountMode}, akun: ${grokStateName})...`);
  sendWAMessageV2(`🔑 [GrokbotV2] Menggunakan akun Grok "${grokStateName}" untuk state ${tiktokStateName} (${accountMode}).`);

  // Load Prompt File
  let promptText = 'A stunning video sequence';
  if (config.promptFile) {
    const promptPath = path.join(PROMPT_DIR, config.promptFile);
    if (fs.existsSync(promptPath)) {
      try {
        const pData = JSON.parse(fs.readFileSync(promptPath, 'utf-8'));
        promptText = pData.prompt || (Array.isArray(pData.prompts) ? pData.prompts[0] : promptText);
      } catch {}
    }
  }

  // Load Bahan Image List
  let bahanImages: string[] = [];
  if (config.bahanFolder) {
    const folderPath = path.join(BAHAN_DIR, config.bahanFolder);
    if (fs.existsSync(folderPath)) {
      const exts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
      try {
        bahanImages = fs.readdirSync(folderPath).filter(f => exts.includes(path.extname(f).toLowerCase()));
      } catch {}
    }
  }

  for (let i = 0; i < totalRawToGenerate; i++) {
    if (!grokbotv2Running && !infiniteGenV2Running && !grokbotv2FullAutoRunning) {
      log(`⛔ Generasi V2 dihentikan pengguna.`);
      break;
    }

    let imagePath: string | undefined = undefined;
    if (bahanImages.length > 0) {
      const pickedImg = bahanImages[i % bahanImages.length];
      imagePath = path.join(BAHAN_DIR, config.bahanFolder, pickedImg);
    }

    grokbotv2Progress.currentVideo = i + 1;
    grokbotv2Progress.currentVideoTotal = totalRawToGenerate;
    grokbotv2Progress.currentVideoProgress = 0;
    grokbotv2Progress.currentPhase = `Memulai raw #${i + 1}/${totalRawToGenerate}`;
    grokbotv2BroadcastProgress();

    // Saat Infinite Generate menunggu slot, tutup page lama agar polling
    // halaman (mis. quota_info) tidak terus berjalan selama cooldown.
    if (generationIntervalMs > 0 && grokSession) {
      log('[GROK_V2] Menutup sesi idle sebelum menunggu slot generate berikutnya...');
      try { await closeGrokV2Session(grokSession); } catch {}
      grokSession = null;
    }
    const generationSlotReady = await waitForGrokV2GenerationSlot(
      generationIntervalMs,
      () => grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning,
      log
    );
    if (!generationSlotReady) break;

    grokbotv2Progress.currentPhase = `Mengirim request generate raw #${i + 1}/${totalRawToGenerate}`;
    grokbotv2BroadcastProgress();
    log(`🎬 [GROK_V2] Memulai generate raw #${i + 1}/${totalRawToGenerate} via Grok V2 API...`);

    try {
      if (!grokSession || grokSession.stateName !== grokStateName) {
        if (grokSession) await closeGrokV2Session(grokSession);
        log(`[GROK_V2] Membuka satu sesi Grok untuk batch akun ${grokStateName}...`);
        grokSession = await createGrokV2Session(grokStateName, config.headless ?? true, {
          initExtraScript: buildDebugInitScript(fs.readFileSync(path.join(__dirname, 'grok_api_browser.js'), 'utf-8')),
          afterPageCreated: (page) => {
            attachPageDebugListeners(page, (event, detail) => {
              const line = `[${new Date().toISOString()}] [${grokStateName}] ${detail}`;
              debugWrite(line);
              // Tampilkan hanya event penting ke console/UI agar tidak membanjiri SSE.
              if (/429|403|rate.?limit|stale|out of date|pageerror|requestfailed|generate END|generate START/i.test(detail)) {
                const debugMessage = `[GROK_V2_DBG] ${detail.slice(0, 320)}`;
                log(debugMessage);
                grokbotv2Progress.currentPhase = debugMessage;
                grokbotv2BroadcastProgress();
                if (!debugLegendCache.has(detail)) {
                  debugLegendCache.add(detail);
                  grokbotv2Log(debugMessage);
                }
              }
            });
          },
        });
      }
      let lastGrokMessage = '';
      const res = await generateGrokVideoV2({
        stateName: grokStateName,
        promptText,
        imagePath,
        resolution: config.resolution || '720p',
        duration: config.duration || '10s',
        aspectRatio: config.aspectRatio || '9:16',
        mode: config.mode || 'Video',
        headless: config.headless ?? true
      }, (msg, pct) => {
        if (msg && msg !== lastGrokMessage) {
          lastGrokMessage = msg;
          log(`[GROK_V2_PHASE] ${msg}`);
        }
        grokbotv2Progress.currentVideoProgress = Math.min(100, Math.max(0, Number(pct) || 0));
        grokbotv2Progress.currentPhase = msg || grokbotv2Progress.currentPhase;
        const overallGen = Math.round(((i + (pct / 100)) / totalRawToGenerate) * 100);
        grokbotv2Progress.generate = Math.min(99, overallGen);
        grokbotv2BroadcastProgress();
      }, grokSession);

      if (res && res.savePath && fs.existsSync(res.savePath)) {
        const destDir = mergeEnabled ? rawDir : targetDir;
        const newFilename = mergeEnabled
          ? `grok_raw_${Date.now()}_${i + 1}.mp4`
          : `grok_${Date.now()}_${i + 1}.mp4`;
        const finalPath = path.join(destDir, newFilename);
        let producedVideoName: string | null = mergeEnabled ? null : newFilename;

        fs.copyFileSync(res.savePath, finalPath);
        try { fs.unlinkSync(res.savePath); } catch {}

        log(`✓ [GROK_V2] Raw video #${i + 1} tersimpan ke: ${newFilename}`);
        completedRaw++;

        grokbotv2Progress.generate = Math.round(((i + 1) / totalRawToGenerate) * 100);
        grokbotv2BroadcastProgress();

        if (mergeEnabled) {
          const rawFiles = fs.readdirSync(rawDir).filter(f => f.endsWith('.mp4')).sort();
          if (rawFiles.length >= 2) {
            log(`[MERGER_V2] Menggabungkan 2 raw video...`);
            const v1 = path.join(rawDir, rawFiles[0]);
            const v2 = path.join(rawDir, rawFiles[1]);

            let audioPath: string | undefined = undefined;
            if (config.audioFolder) {
              const audioDir = path.join(__dirname, 'audio', config.audioFolder);
              if (fs.existsSync(audioDir)) {
                const aFiles = fs.readdirSync(audioDir).filter(f => ['.mp3', '.wav'].includes(path.extname(f).toLowerCase()));
                if (aFiles.length > 0) {
                  audioPath = path.join(audioDir, aFiles[Math.floor(Math.random() * aFiles.length)]);
                }
              }
            }

            const mergedFilename = `grok_merged_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
            const mergedOutputPath = path.join(targetDir, mergedFilename);

            try {
              await mergeVideosCopyWithOptionalAudio([v1, v2], mergedOutputPath, audioPath, { tempDir: path.join(__dirname, '_tmp_uploads') });
              log(`[MERGER_V2] ✅ Berhasil merge ke ${mergedFilename}`);
              producedVideoName = mergedFilename;
              try { fs.unlinkSync(v1); } catch {}
              try { fs.unlinkSync(v2); } catch {}
              grokbotv2Progress.mergedCount = (grokbotv2Progress.mergedCount || 0) + 1;
              grokbotv2Progress.merge = Math.min(99, Math.round((grokbotv2Progress.mergedCount / config.totalVideos) * 100));
              grokbotv2BroadcastProgress();
            } catch (mergeErr: any) {
              log(`[MERGER_V2] ❌ Error merge: ${mergeErr.message}`);
            }
          }
        }

        if (config.notifyWhatsApp && producedVideoName) {
          const label = config.notificationLabel ? ` (${config.notificationLabel})` : '';
          sendWAMessageV2(`✅ [GrokbotV2 Infinite] Berhasil generate 1 video${label} untuk ${tiktokStateName}: ${producedVideoName}`);
        }

        tooManyRequestAttempts.delete(i);
        transientGenerationAttempts.delete(i);
        staleGenerationAttempts.delete(i);
        if (i + 1 < totalRawToGenerate) {
          grokbotv2Progress.currentPhase = 'Jeda antar-video untuk mencegah Too Many Requests';
          grokbotv2BroadcastProgress();
          log(`[GROK_V2] Jeda ${Math.ceil(interVideoDelayMs / 1000)} detik sebelum raw berikutnya...`);
          await waitWhileRunning(interVideoDelayMs, () => grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning);
        }
      } else {
        fatalError = `Gagal generate raw #${i + 1}`;
        log(`❌ [GROK_V2] ${fatalError}`);
        break;
      }
    } catch (err: any) {
      if (err instanceof TooManyRequestsError || err.name === 'TooManyRequestsError') {
        // ── Debug: tulis fetch log halaman ke file sebelum backoff/close ──
        if (grokSession && grokSession.page) {
          const dump = await dumpFetchLogToFile(grokSession.page, grokDebugDir, `429-${grokStateName}`);
          log(`[GROK_V2_DBG] 🧾 Fetch log 429 disimpan: ${dump.fname} (${dump.count} entri)`);
          const legend = filterFetchLogLegends(await collectFetchLog(grokSession.page), 30);
          for (const l of legend) log(`[GROK_V2_DBG] ${l}`);
        }
        const attempts = (tooManyRequestAttempts.get(i) || 0) + 1;
        tooManyRequestAttempts.set(i, attempts);
        if (config.notifyWhatsApp) {
          const label = config.notificationLabel ? ` (${config.notificationLabel})` : '';
          sendWAMessageV2(`⚠️ [GrokbotV2 Infinite] Too Many Requests pada ${tiktokStateName}${label}, raw #${i + 1} (percobaan ${attempts}/${maxTooManyRequestRetries}).`);
        }
        if (attempts <= maxTooManyRequestRetries) {
          const retryAfterMs = Number((err as any).retryAfterMs) || 0;
          if (generationIntervalMs > 0 && grokSession) {
            log('[GROK_V2] Menutup sesi setelah HTTP 429 sebelum retry berikutnya...');
            try { await closeGrokV2Session(grokSession); } catch {}
            grokSession = null;
          }
          const baseDelayMs = generationIntervalMs > 0
            ? Math.max(generationIntervalMs, retryAfterMs)
            : Math.max(interVideoDelayMs, retryAfterMs || 30 * 1000);
          const backoffMs = generationIntervalMs > 0
            ? baseDelayMs
            : Math.min(5 * 60 * 1000, baseDelayMs * Math.pow(2, attempts - 1));
          const waitSeconds = Math.ceil(backoffMs / 1000);
          grokbotv2Progress.currentPhase = `Too Many Requests — menunggu ${waitSeconds} detik (percobaan ${attempts}/${maxTooManyRequestRetries})`;
          grokbotv2BroadcastProgress();
          log(`⏳ [GROK_V2 BACKOFF] HTTP 429 bukan limit akun. Menunggu ${waitSeconds} detik lalu mengulang raw #${i + 1} (percobaan ${attempts}/${maxTooManyRequestRetries})...`);
          await waitWhileRunning(backoffMs, () => grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning);
          if (!grokbotv2Running && !infiniteGenV2Running && !grokbotv2FullAutoRunning) break;
          i--;
          continue;
        }
        const tooManyRequestMessage = `Grok tetap mengirim Too Many Requests setelah ${maxTooManyRequestRetries} percobaan pada raw #${i + 1}`;
        if (generationIntervalMs > 0) {
          recoverableError = tooManyRequestMessage;
          log(`⚠️ [GROK_V2] ${tooManyRequestMessage}. Batch Infinite akan dicoba lagi setelah cooldown.`);
          break;
        }
        fatalError = tooManyRequestMessage;
        log(`❌ [GROK_V2] ${fatalError}`);
        break;
      }
      if (err instanceof RateLimitError || err.name === 'RateLimitError') {
        // ── Debug: tulis fetch log halaman ke file sebelum close/switch akun ──
        if (grokSession && grokSession.page) {
          const dump = await dumpFetchLogToFile(grokSession.page, grokDebugDir, `ratelimit-${grokStateName}`);
          log(`[GROK_V2_DBG] 🧾 Fetch log rate limit disimpan: ${dump.fname} (${dump.count} entri)`);
          const legend = filterFetchLogLegends(await collectFetchLog(grokSession.page), 30);
          for (const l of legend) log(`[GROK_V2_DBG] ${l}`);
        }
        // ── Deteksi Rate Limit: catat ke shared grokRateLimits dan hentikan loop ──
        const grokStateKey = config.grokState || 'indra';
        const limitedState: string = currentAccount || grokStateKey;
        const availableAt = (err as any).availableAt || null;
        setGrokRateLimit(limitedState, availableAt);
        if (!limitedAccounts.includes(limitedState)) limitedAccounts.push(limitedState);
        log(`🚫 [GROK_V2 RATE LIMIT] Akun "${limitedState}" terkena rate limit! Tersedia kembali: ${availableAt || 'tidak diketahui'}`);
        grokbotv2BroadcastProgress(); // broadcast agar UI langsung update
        const replacement: string | undefined = accountPool.find(account => account !== limitedState && !isGrokV2AccountUnavailable(account));
        if (grokSession) {
          await closeGrokV2Session(grokSession);
          grokSession = null;
        }
        if (config.autoSwitchGrokState && replacement) {
          const previousName = limitedState.replace('grok-state-', '').replace('.json', '');
          currentAccount = replacement;
          grokStateName = replacement.replace('grok-state-', '').replace('.json', '');
          grokbotv2Progress.activeGrokState = replacement;
          grokbotv2Progress.availableGrokAccounts = accountPool.filter(account => !isGrokV2AccountUnavailable(account)).length;
          grokbotv2Progress.limitedGrokAccounts = accountPool.filter(isGrokV2AccountUnavailable);
          grokbotv2BroadcastProgress();
          const switchMessage = `🔄 [GrokbotV2] Akun ${previousName} terkena rate limit. Beralih ke akun ${grokStateName} dan mengulang video #${i + 1}.`;
          log(switchMessage);
          sendWAMessageV2(switchMessage);
          i--;
          continue;
        }
        const allLimitMessage = `🚫 [GrokbotV2] Semua akun Grok yang diizinkan terkena rate limit: ${accountPool.map(a => a.replace('grok-state-', '').replace('.json', '')).join(', ') || 'tidak ada akun'}.`;
        log(allLimitMessage);
        sendWAMessageV2(allLimitMessage);
        break;
      }
      const errorMessage = err?.message || String(err);
      const isStalePageError = err instanceof GrokStalePageError
        || err?.name === 'GrokStalePageError'
        || /page is out of date|out of date|reload to continue|code["']?\s*:\s*7/i.test(errorMessage);
      if (isStalePageError) {
        if (grokSession) {
          log('[GROK_V2] Menutup sesi stale dan akan membuat browser/context baru...');
          try { await closeGrokV2Session(grokSession); } catch {}
          grokSession = null;
        }
        if (generationIntervalMs > 0) {
          const attempts = (staleGenerationAttempts.get(i) || 0) + 1;
          staleGenerationAttempts.set(i, attempts);
          if (attempts <= 2) {
            const waitSeconds = Math.ceil(generationIntervalMs / 1000);
            grokbotv2Progress.currentPhase = `Sesi Grok stale — membuat sesi baru dalam ${waitSeconds} detik (percobaan ${attempts}/2)`;
            grokbotv2BroadcastProgress();
            log(`[GROK_V2 STALE RETRY] ${errorMessage}. Menunggu ${waitSeconds} detik lalu membuat sesi baru untuk raw #${i + 1}...`);
            await waitWhileRunning(generationIntervalMs, () => grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning);
            if (!grokbotv2Running && !infiniteGenV2Running && !grokbotv2FullAutoRunning) break;
            i--;
            continue;
          }
          recoverableError = `Sesi Grok tetap stale setelah ${attempts} percobaan pada raw #${i + 1}`;
          log(`⚠️ [GROK_V2] ${recoverableError}. Batch Infinite tetap aktif dan akan mencoba lagi setelah cooldown.`);
          break;
        }
        fatalError = errorMessage;
        log(`❌ [GROK_V2 ERROR] ${fatalError}`);
        break;
      }
      const isTransientNetworkError = generationIntervalMs > 0
        && /network error|ERR_QUIC|QUIC_TOO_MANY|ERR_NETWORK|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(errorMessage);
      if (isTransientNetworkError) {
        const attempts = (transientGenerationAttempts.get(i) || 0) + 1;
        transientGenerationAttempts.set(i, attempts);
        if (attempts <= 2) {
          if (grokSession) {
            log('[GROK_V2] Menutup sesi setelah gangguan jaringan sebelum retry berikutnya...');
            try { await closeGrokV2Session(grokSession); } catch {}
            grokSession = null;
          }
          const waitSeconds = Math.ceil(generationIntervalMs / 1000);
          grokbotv2Progress.currentPhase = `Gangguan jaringan sementara — menunggu ${waitSeconds} detik (percobaan ${attempts}/2)`;
          grokbotv2BroadcastProgress();
          log(`[GROK_V2 NETWORK RETRY] ${errorMessage}. Menunggu ${waitSeconds} detik lalu mengulang raw #${i + 1}...`);
          await waitWhileRunning(generationIntervalMs, () => grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning);
          if (!grokbotv2Running && !infiniteGenV2Running && !grokbotv2FullAutoRunning) break;
          i--;
          continue;
        }
        recoverableError = `Gangguan jaringan berulang pada raw #${i + 1}: ${errorMessage}`;
        log(`⚠️ [GROK_V2] ${recoverableError}. Batch Infinite akan dicoba lagi setelah cooldown.`);
        break;
      }
      fatalError = errorMessage;
      log(`❌ [GROK_V2 ERROR] ${fatalError}`);
      break;
    }
  }

  if (grokSession) {
    await closeGrokV2Session(grokSession);
    grokSession = null;
  }

  const allAccountsLimited = completedRaw < totalRawToGenerate && accountPool.every(isGrokV2AccountUnavailable);
  grokbotv2Progress.generate = completedRaw >= totalRawToGenerate ? 100 : Math.round((completedRaw / totalRawToGenerate) * 100);
  if (completedRaw >= totalRawToGenerate) grokbotv2Progress.merge = 100;
  grokbotv2BroadcastProgress();
  log(`${allAccountsLimited ? '🚫' : '✅'} [GROK_V2_GENERATOR] Selesai memproses generasi video V2 untuk ${tiktokStateName}`);
  return {
    allAccountsLimited,
    completedRaw,
    totalRaw: totalRawToGenerate,
    limitedAccounts,
    lastAccount: currentAccount,
    fatalError: fatalError || undefined,
    recoverableError: recoverableError || undefined
  };
}

type InfiniteStockTarget = {
  stateFile: string;
  stateName: string;
  stockType: 'utama' | 'cadangan';
  stockCount: number;
};

function countPendingVideos(folder: string, marksName: string, prefix: string): number {
  if (!fs.existsSync(folder)) return 0;
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(path.join(folder, marksName), 'utf-8')); } catch {}
  try {
    return fs.readdirSync(folder).filter(file => {
      const full = path.join(folder, file);
      return fs.statSync(full).isFile()
        && exts.includes(path.extname(file).toLowerCase())
        && file.startsWith(prefix)
        && !marks[file];
    }).length;
  } catch {
    return 0;
  }
}

async function waitWhileRunning(durationMs: number, isStillRunning: () => boolean): Promise<void> {
  const stepMs = 2000;
  let elapsed = 0;
  while (elapsed < durationMs && isStillRunning()) {
    const waitMs = Math.min(stepMs, durationMs - elapsed);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    elapsed += waitMs;
  }
}

async function waitForGrokV2GenerationSlot(
  intervalMs: number,
  isStillRunning: () => boolean,
  log: (msg: string) => void
): Promise<boolean> {
  if (intervalMs <= 0) return isStillRunning();

  const waitMs = Math.max(0, grokV2NextGenerationAtMs - Date.now());
  if (waitMs > 0) {
    const waitMinutes = Math.ceil(waitMs / 60000);
    grokbotv2Progress.currentPhase = `Menunggu slot generate berikutnya (${waitMinutes} menit)`;
    grokbotv2BroadcastProgress();
    log(`[GROK_V2] Pacing Infinite Generate: menunggu ${Math.ceil(waitMs / 1000)} detik sebelum request berikutnya...`);
    await waitWhileRunning(waitMs, isStillRunning);
  }

  if (!isStillRunning()) return false;
  grokV2NextGenerationAtMs = Date.now() + intervalMs;
  return true;
}

function formatLocalDateTime(value: Date): { scheduleDate: string; scheduleTime: string } {
  return {
    scheduleDate: `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`,
    scheduleTime: `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
  };
}

function nextScheduleBaseline(items: SchedulePlanItem[], cfg: { intervalMinutes?: number; threeUploadsPerHour?: boolean }, fallbackDate: string, fallbackTime: string) {
  if (items.length === 0) return { scheduleDate: fallbackDate, scheduleTime: fallbackTime };
  const last = items[items.length - 1];
  const lastDate = new Date(`${last.scheduleDate}T${last.scheduleTime}:00`);
  if (cfg.threeUploadsPerHour) {
    lastDate.setMinutes(0, 0, 0);
    lastDate.setHours(lastDate.getHours() + 5);
  } else {
    lastDate.setMinutes(lastDate.getMinutes() + (cfg.intervalMinutes || 60));
  }
  return formatLocalDateTime(lastDate);
}

function validateInfiniteSchedulePayload(initialRunAt: unknown, states: unknown): string | null {
  if (typeof initialRunAt !== 'string' || isNaN(new Date(initialRunAt).getTime())) return 'Initial time tidak valid';
  if (!Array.isArray(states) || states.length === 0) return 'Minimal satu state diperlukan';
  const seen = new Set<string>();
  for (const item of states as any[]) {
    if (!item || typeof item.stateFile !== 'string' || !item.stateFile) return 'State file tidak valid';
    if (seen.has(item.stateFile)) return `State duplikat: ${item.stateFile}`;
    seen.add(item.stateFile);
    if (typeof item.scheduleDate !== 'string' || typeof item.scheduleTime !== 'string'
      || isNaN(new Date(`${item.scheduleDate}T${item.scheduleTime}:00`).getTime())) {
      return `Jadwal TikTok tidak valid untuk ${item.stateFile}`;
    }
  }
  return null;
}

// ── GROKBOT V2 API ROUTES ──
app.get('/grokbotv2', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grokbotv2.html'));
});

app.get('/api/grokbotv2/config', (req, res) => {
  res.json(loadGrokbotV2Data());
});

app.get('/api/grokbotv2/quotas', async (req, res) => {
  try {
    const stateFiles = getSavedStates('grok').map(item => item.filename).sort((a, b) => a.localeCompare(b));
    const accounts = await refreshGrokV2Quotas(stateFiles, req.query.refresh === '1');
    res.json({ accounts, checkedAt: new Date().toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || String(error), accounts: [], checkedAt: new Date().toISOString() });
  }
});

app.post('/api/grokbotv2/config/save', (req, res) => {
  const { stateFile, grokState, autoSwitchGrokState, promptFile, bahanFolder, mode, resolution, duration, aspectRatio, merge, audioFolder, description, hashtags, scheduleDate, scheduleTime, intervalMinutes, grokGenerateIntervalMinutes, addProduct, productNameRadio, productTitle, productDescription, headless, threeUploadsPerHour, lastUploadDate, lastUploadTime } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadGrokbotV2Data();
  if (!data.states[stateFile]) {
    data.states[stateFile] = {
      grokState: '', autoSwitchGrokState: false, promptFile: '', bahanFolder: '', mode: 'Video',
      resolution: '720p', duration: '10s', aspectRatio: '9:16', merge: true,
      audioFolder: '', description: '', hashtags: '', scheduleDate: '',
      scheduleTime: '', intervalMinutes: 60, grokGenerateIntervalMinutes: 15,
      addProduct: false, productNameRadio: '', productTitle: '', productDescription: '',
      headless: true, threeUploadsPerHour: false, lastUploadDate: '', lastUploadTime: ''
    };
  }
  const s = data.states[stateFile];
  if (grokState !== undefined) s.grokState = grokState;
  if (autoSwitchGrokState !== undefined) s.autoSwitchGrokState = !!autoSwitchGrokState;
  if (promptFile !== undefined) s.promptFile = promptFile;
  if (bahanFolder !== undefined) s.bahanFolder = bahanFolder;
  if (mode !== undefined) s.mode = mode;
  if (resolution !== undefined) s.resolution = resolution;
  if (duration !== undefined) s.duration = duration;
  if (aspectRatio !== undefined) s.aspectRatio = aspectRatio;
  if (merge !== undefined) s.merge = merge;
  if (audioFolder !== undefined) s.audioFolder = audioFolder;
  if (description !== undefined) s.description = description;
  if (hashtags !== undefined) s.hashtags = hashtags;
  if (scheduleDate !== undefined) s.scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) s.scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) s.intervalMinutes = intervalMinutes;
  if (grokGenerateIntervalMinutes !== undefined) s.grokGenerateIntervalMinutes = grokGenerateIntervalMinutes;
  if (addProduct !== undefined) s.addProduct = addProduct;
  if (productNameRadio !== undefined) s.productNameRadio = productNameRadio;
  if (productTitle !== undefined) s.productTitle = productTitle;
  if (productDescription !== undefined) s.productDescription = productDescription;
  if (headless !== undefined) s.headless = headless;
  if (threeUploadsPerHour !== undefined) s.threeUploadsPerHour = threeUploadsPerHour;
  if (lastUploadDate !== undefined) s.lastUploadDate = lastUploadDate;
  if (lastUploadTime !== undefined) s.lastUploadTime = lastUploadTime;
  saveGrokbotV2Data(data);
  res.json({ success: true });
});

app.post('/api/grokbotv2/global-config/save', (req, res) => {
  const { headless, sendWhatsApp } = req.body;
  const data = loadGrokbotV2Data();
  if (!data.globalConfig) data.globalConfig = {};
  if (headless !== undefined) data.globalConfig.headless = headless;
  if (sendWhatsApp !== undefined) data.globalConfig.sendWhatsApp = sendWhatsApp;
  saveGrokbotV2Data(data);
  res.json({ success: true });
});

app.post('/api/grokbotv2/full-auto-settings/save', (req, res) => {
  const { enableCustomScheduler, customIntervalHours, customUploadCount } = req.body;
  const data = loadGrokbotV2Data();
  if (!data.globalConfig) data.globalConfig = {};
  if (!data.globalConfig.fullAuto) data.globalConfig.fullAuto = {};
  if (enableCustomScheduler !== undefined) data.globalConfig.fullAuto.enableCustomScheduler = enableCustomScheduler;
  if (customIntervalHours !== undefined) data.globalConfig.fullAuto.customIntervalHours = customIntervalHours;
  if (customUploadCount !== undefined) data.globalConfig.fullAuto.customUploadCount = customUploadCount;
  saveGrokbotV2Data(data);
  res.json({ success: true });
});

app.get('/api/grokbotv2/stock', (req, res) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ raw: 0, utama: 0, cadangan: 0 });
  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
  const rawDir = path.join(stateDir, 'raw');
  const cadanganDir = path.join(stateDir, 'cadangan');
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  let rawCount = 0;
  if (fs.existsSync(rawDir)) {
    try { rawCount = fs.readdirSync(rawDir).filter(f => exts.includes(path.extname(f).toLowerCase())).length; } catch {}
  }

  let mergedFiles: string[] = [];
  if (fs.existsSync(stateDir)) {
    try { mergedFiles = fs.readdirSync(stateDir).filter(f => f.startsWith('grok_') && exts.includes(path.extname(f).toLowerCase())); } catch {}
  }

  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const unuploaded = mergedFiles.filter(f => !marks[f]);

  let cadanganFiles: string[] = [];
  if (fs.existsSync(cadanganDir)) {
    try { cadanganFiles = fs.readdirSync(cadanganDir).filter(f => f.startsWith('grok_') && exts.includes(path.extname(f).toLowerCase())); } catch {}
  }
  const cadanganMarksFile = path.join(cadanganDir, '.downloaded.json');
  let cadanganMarks: Record<string, boolean> = {};
  try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

  res.json({ raw: rawCount, utama: unuploaded.length, cadangan: cadanganFiles.filter(f => !cadanganMarks[f]).length });
});

// Import video pending dari stok cadangan V2 ke stok utama V2.
app.post('/api/grokbotv2/import-cadangan', (req, res) => {
  if (grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning || grokbotv2InfiniteScheduleRunning) {
    return res.status(400).json({ success: false, error: 'Grokbot V2 sedang menjalankan proses lain.' });
  }

  const { stateFile } = req.body;
  if (typeof stateFile !== 'string' || !stateFile || stateFile.includes('..') || path.basename(stateFile) !== stateFile) {
    return res.status(400).json({ success: false, error: 'stateFile tidak valid.' });
  }

  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
  const cadanganDir = path.join(stateDir, 'cadangan');
  if (!fs.existsSync(cadanganDir)) {
    return res.status(400).json({ success: false, error: `Folder cadangan tidak ditemukan: ${cadanganDir}` });
  }

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const cadanganMarksFile = path.join(cadanganDir, '.downloaded.json');
  const utamaMarksFile = path.join(stateDir, '.downloaded.json');
  let cadanganMarks: Record<string, boolean> = {};
  let utamaMarks: Record<string, boolean> = {};
  try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}
  try { utamaMarks = JSON.parse(fs.readFileSync(utamaMarksFile, 'utf-8')); } catch {}

  const pendingFiles = fs.readdirSync(cadanganDir)
    .filter(file => file.startsWith('grok_') && exts.includes(path.extname(file).toLowerCase()) && !cadanganMarks[file])
    .sort();
  if (pendingFiles.length === 0) {
    return res.status(400).json({ success: false, error: 'Tidak ada video cadangan V2 yang tersedia untuk diimpor.' });
  }

  fs.mkdirSync(stateDir, { recursive: true });
  let movedCount = 0;
  const skipped: string[] = [];
  for (const file of pendingFiles) {
    const source = path.join(cadanganDir, file);
    const destination = path.join(stateDir, file);
    if (fs.existsSync(destination)) {
      skipped.push(`${file} (nama sudah ada di stok utama)`);
      continue;
    }
    try {
      fs.renameSync(source, destination);
      cadanganMarks[file] = true;
      delete utamaMarks[file];
      movedCount++;
    } catch (error: any) {
      skipped.push(`${file} (${error.message})`);
    }
  }

  try {
    fs.writeFileSync(cadanganMarksFile, JSON.stringify(cadanganMarks, null, 2));
    fs.writeFileSync(utamaMarksFile, JSON.stringify(utamaMarks, null, 2));
  } catch (error: any) {
    return res.status(500).json({ success: false, error: `Gagal menyimpan status import: ${error.message}` });
  }

  const suffix = skipped.length > 0 ? ` Dilewati: ${skipped.join(', ')}` : '';
  const message = `Berhasil mengimpor ${movedCount} video dari stok cadangan ke stok utama.${suffix}`;
  grokbotv2Log(`[Manual Import V2] ${stateName}: ${message}`);
  res.json({ success: true, movedCount, skipped, message });
});

app.post('/api/grokbotv2/generate-utama', async (req, res) => {
  if (grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning) return res.status(400).json({ error: 'Grokbot V2 sedang berjalan!' });
  const { stateFile, intervalMinutes } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotV2Data();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });
  if (!cfg.autoSwitchGrokState && !cfg.grokState) return res.status(400).json({ error: 'Grok State belum dipilih atau aktifkan Auto Switch!' });
  if (getGrokV2AccountPool(!!cfg.autoSwitchGrokState, cfg.grokState).length === 0) return res.status(400).json({ error: 'Tidak ada Grok State valid yang dapat digunakan!' });

  const generationIntervalMinutes = resolveGrokV2GenerationIntervalMinutes(intervalMinutes ?? cfg.grokGenerateIntervalMinutes);
  if (generationIntervalMinutes === null) return res.status(400).json({ error: 'Interval generate harus antara 1 sampai 1440 menit.' });
  const quotaPreflight = await preflightGrokV2GenerationQuota(!!cfg.autoSwitchGrokState, cfg.grokState);
  if (quotaPreflight.available.length === 0) {
    return res.status(409).json({
      success: false,
      error: `Tidak ada quota Grok yang tersedia. Akun diperiksa: ${formatGrokV2QuotaPreflightDetails(quotaPreflight.unavailable)}.`,
      quotas: quotaPreflight.quotas
    });
  }

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  let pendingCount = 0;
  if (fs.existsSync(stateDir)) {
    try { pendingCount = fs.readdirSync(stateDir).filter(f => f.startsWith('grok_') && exts.includes(path.extname(f).toLowerCase()) && !marks[f]).length; } catch {}
  }

  const needed = Math.max(1, 30 - pendingCount);

  res.json({
    success: true,
    message: `Generasi Stok Utama V2 dimulai untuk ${tiktokStateName} (butuh ${needed} video, interval ${generationIntervalMinutes} menit)`,
    quotas: quotaPreflight.quotas,
    quotaWarning: quotaPreflight.unavailable.length > 0
      ? `Auto Switch akan melewati ${quotaPreflight.unavailable.length} akun yang quota-nya tidak tersedia.`
      : null
  });

  grokbotv2Running = true;
  grokbotv2Queue = [{ stateName: tiktokStateName, stateFile, videoCount: needed, scheduleStart: 'Utama Gen V2', scheduleEnd: 'Utama Gen V2', active: true }];
  grokbotv2BroadcastQueue();
  resetGrokbotv2Progress({ currentState: tiktokStateName, mergeTotal: cfg.merge !== false ? needed : 0 });
  grokbotv2BroadcastProgress();

  grokbotv2Log(`🚀 Memulai Generate Stok Utama V2 untuk ${tiktokStateName}. Dibutuhkan: ${needed} video`);
  sendWAMessageV2(`🚀 [GrokbotV2] Generate Stok Utama dimulai untuk ${tiktokStateName}. Dibutuhkan: ${needed} video.`);

  try {
    const result = await runGrokGeneratorV2({
      stateFile,
      grokState: cfg.grokState,
      bahanFolder: cfg.bahanFolder,
      promptFile: cfg.promptFile,
      mode: cfg.mode || 'Video',
      resolution: cfg.resolution || '720p',
      duration: cfg.duration || '10s',
      aspectRatio: cfg.aspectRatio || '9:16',
      headless: isHeadlessEnabledV2(stateFile),
      totalVideos: needed,
      merge: cfg.merge,
      audioFolder: cfg.audioFolder,
      autoSwitchGrokState: !!cfg.autoSwitchGrokState,
      generationIntervalMs: Math.round(generationIntervalMinutes * 60 * 1000)
    }, grokbotv2Log);
    grokbotv2Log('===== GENERATE UTAMA V2 FINISHED =====');
    sendWAMessageV2(result.allAccountsLimited
      ? `🚫 [GrokbotV2] Generate Stok Utama ${tiktokStateName} berhenti karena semua akun Grok terkena rate limit.`
      : `✅ [GrokbotV2] Generate Stok Utama selesai untuk ${tiktokStateName}.`);
  } catch (e: any) {
    grokbotv2Log('❌ Fatal Utama Gen V2: ' + e.message);
    sendWAMessageV2(`❌ [GrokbotV2] Fatal error Generate Utama ${tiktokStateName}: ${e.message}`);
  } finally {
    grokbotv2Running = false;
    grokbotv2Queue = [];
    grokbotv2BroadcastQueue();
  }
});

app.post('/api/grokbotv2/generate-cadangan', async (req, res) => {
  if (grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning) return res.status(400).json({ error: 'Grokbot V2 sedang berjalan!' });
  const { stateFile, intervalMinutes } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotV2Data();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });
  if (!cfg.autoSwitchGrokState && !cfg.grokState) return res.status(400).json({ error: 'Grok State belum dipilih atau aktifkan Auto Switch!' });
  if (getGrokV2AccountPool(!!cfg.autoSwitchGrokState, cfg.grokState).length === 0) return res.status(400).json({ error: 'Tidak ada Grok State valid yang dapat digunakan!' });

  const generationIntervalMinutes = resolveGrokV2GenerationIntervalMinutes(intervalMinutes ?? cfg.grokGenerateIntervalMinutes);
  if (generationIntervalMinutes === null) return res.status(400).json({ error: 'Interval generate harus antara 1 sampai 1440 menit.' });
  const quotaPreflight = await preflightGrokV2GenerationQuota(!!cfg.autoSwitchGrokState, cfg.grokState);
  if (quotaPreflight.available.length === 0) {
    return res.status(409).json({
      success: false,
      error: `Tidak ada quota Grok yang tersedia. Akun diperiksa: ${formatGrokV2QuotaPreflightDetails(quotaPreflight.unavailable)}.`,
      quotas: quotaPreflight.quotas
    });
  }

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const cadanganDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName, 'cadangan');

  res.json({
    success: true,
    message: `Generasi Stok Cadangan V2 dimulai untuk ${tiktokStateName} (30 video, interval ${generationIntervalMinutes} menit)`,
    quotas: quotaPreflight.quotas,
    quotaWarning: quotaPreflight.unavailable.length > 0
      ? `Auto Switch akan melewati ${quotaPreflight.unavailable.length} akun yang quota-nya tidak tersedia.`
      : null
  });

  grokbotv2Running = true;
  grokbotv2Queue = [{ stateName: tiktokStateName, stateFile, videoCount: 30, scheduleStart: 'Cadangan Gen V2', scheduleEnd: 'Cadangan Gen V2', active: true }];
  grokbotv2BroadcastQueue();
  resetGrokbotv2Progress({ currentState: tiktokStateName, mergeTotal: 30 });
  grokbotv2BroadcastProgress();

  grokbotv2Log(`🚀 Memulai Generate Stok Cadangan V2 (30 video) untuk ${tiktokStateName}`);
  sendWAMessageV2(`🚀 [GrokbotV2] Generate Stok Cadangan dimulai untuk ${tiktokStateName} (30 video).`);

  try {
    const result = await runGrokGeneratorV2({
      stateFile,
      grokState: cfg.grokState,
      bahanFolder: cfg.bahanFolder,
      promptFile: cfg.promptFile,
      mode: cfg.mode || 'Video',
      resolution: cfg.resolution || '720p',
      duration: cfg.duration || '10s',
      aspectRatio: cfg.aspectRatio || '9:16',
      headless: isHeadlessEnabledV2(stateFile),
      totalVideos: 30,
      merge: cfg.merge,
      audioFolder: cfg.audioFolder,
      customDownloadDir: cadanganDir,
      autoSwitchGrokState: !!cfg.autoSwitchGrokState,
      generationIntervalMs: Math.round(generationIntervalMinutes * 60 * 1000)
    }, grokbotv2Log);
    grokbotv2Log('===== GENERATE CADANGAN V2 FINISHED =====');
    sendWAMessageV2(result.allAccountsLimited
      ? `🚫 [GrokbotV2] Generate Stok Cadangan ${tiktokStateName} berhenti karena semua akun Grok terkena rate limit.`
      : `✅ [GrokbotV2] Generate Stok Cadangan selesai untuk ${tiktokStateName}.`);
  } catch (e: any) {
    grokbotv2Log('❌ Fatal Cadangan Gen V2: ' + e.message);
    sendWAMessageV2(`❌ [GrokbotV2] Fatal error Generate Cadangan ${tiktokStateName}: ${e.message}`);
  } finally {
    grokbotv2Running = false;
    grokbotv2Queue = [];
    grokbotv2BroadcastQueue();
  }
});

app.post('/api/grokbotv2/schedule-only', async (req, res) => {
  if (grokbotv2Running || infiniteGenV2Running || grokbotv2FullAutoRunning) return res.status(400).json({ success: false, error: 'Grokbot V2 sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadGrokbotV2Data();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(GROK_DOWNLOAD_DIR, tiktokStateName);
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const marksFile = path.join(stateDir, '.downloaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  let allVideos = fs.readdirSync(stateDir).filter(f => exts.includes(path.extname(f).toLowerCase())).sort();
  let pendingVideos = allVideos.filter(v => !marks[v]);

  if (pendingVideos.length === 0) {
    return res.status(400).json({ success: false, error: 'Tidak ada video pending untuk diupload' });
  }

  res.json({ success: true, message: `Upload dimulai untuk ${pendingVideos.length} video` });

  grokbotv2Running = true;
  const batch = pendingVideos.slice(0, 30);
  const schedDate = cfg.scheduleDate || new Date().toISOString().split('T')[0];
  const schedTime = cfg.scheduleTime || new Date().toTimeString().slice(0, 5);

  grokbotv2Log(`🚀 [${tiktokStateName}] Jadwalkan Saja V2 dimulai (${batch.length} video)`);
  sendWAMessageV2(`🚀 [GrokbotV2] Jadwalkan Saja dimulai untuk ${tiktokStateName} (${batch.length} video).`);

  const uploadConfig = {
    videoFolder: stateDir,
    startFromVideo: batch[0],
    description: cfg.description || '',
    hashtags: cfg.hashtags || '',
    addProduct: !!cfg.addProduct,
    productNameRadio: cfg.productNameRadio || '',
    productTitle: cfg.productTitle || '',
    productDescription: cfg.productDescription || '',
    skipSwitches: true,
    headless: isHeadlessEnabledV2(stateFile),
    scheduleDate: schedDate,
    scheduleTime: schedTime,
    intervalMinutes: cfg.threeUploadsPerHour ? 300 : (cfg.intervalMinutes || 60),
    stateFile: stateFile,
    statesDir: STATES_DIR,
    randomizeIntervalSchedule: true
  };

  let uploadedCount = 0;
  const onVideoUploaded = (videoFilename: string) => {
    let m: Record<string, boolean> = {};
    try { m = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
    m[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(m, null, 2));
    grokbotv2Log(`✅ [${tiktokStateName}] ${videoFilename} terupload`);

    const videoPath = path.join(stateDir, videoFilename);
    if (fs.existsSync(videoPath)) {
      try { fs.unlinkSync(videoPath); } catch {}
    }

    uploadedCount++;
    grokbotv2Progress.uploadedCount = uploadedCount;
    grokbotv2Progress.uploadTotal = batch.length;
    grokbotv2Progress.upload = Math.round((uploadedCount / batch.length) * 100);
    grokbotv2BroadcastProgress();
  };

  try {
    await runUpload(uploadConfig, grokbotv2Log, onVideoUploaded, items => {
      sendWAMessageV2(buildScheduleListMessage(tiktokStateName, items));
    });
    sendWAMessageV2(`✅ [GrokbotV2] Jadwalkan Saja selesai untuk ${tiktokStateName}. Total terupload: ${uploadedCount} video.`);
  } catch (err: any) {
    grokbotv2Log(`❌ Upload error: ${err.message}`);
    sendWAMessageV2(`❌ [GrokbotV2] Error upload ${tiktokStateName}: ${err.message}`);
  } finally {
    grokbotv2Running = false;
    resetGrokbotv2Progress();
    grokbotv2BroadcastProgress();
    grokbotv2Queue = [];
    grokbotv2BroadcastQueue();
    grokbotv2Log('===== JADWALKAN SAJA V2 FINISHED =====');
  }
});

app.post('/api/grokbotv2/infinite-generate', async (req, res) => {
  if (infiniteGenV2Running || grokbotv2Running || grokbotv2FullAutoRunning) {
    return res.status(400).json({ success: false, error: 'Grokbot V2 sedang menjalankan proses lain!' });
  }
  const { stateFiles, stateOptions, intervalMinutes } = req.body;
  if (!Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ success: false, error: 'stateFiles diperlukan' });
  }
  const requestedIntervalMinutes = intervalMinutes === undefined
    ? GROK_V2_INFINITE_GENERATION_INTERVAL_MS / 60000
    : Number(intervalMinutes);
  if (!Number.isFinite(requestedIntervalMinutes) || requestedIntervalMinutes < 1 || requestedIntervalMinutes > 1440) {
    return res.status(400).json({ success: false, error: 'Interval generate harus antara 1 sampai 1440 menit.' });
  }
  const generationIntervalMs = Math.round(requestedIntervalMinutes * 60 * 1000);

  const startData = loadGrokbotV2Data();
  if (Array.isArray(stateOptions)) {
    for (const option of stateOptions) {
      if (!option || !stateFiles.includes(option.stateFile) || !startData.states[option.stateFile]) continue;
      const autoSwitch = !!option.autoSwitchGrokState;
      const grokState = typeof option.grokState === 'string' ? option.grokState : '';
      if (!autoSwitch && !grokState) return res.status(400).json({ success: false, error: `Grok State diperlukan untuk ${option.stateFile}` });
      if (getGrokV2AccountPool(autoSwitch, grokState).length === 0) return res.status(400).json({ success: false, error: `Tidak ada Grok State valid untuk ${option.stateFile}` });
      startData.states[option.stateFile].autoSwitchGrokState = autoSwitch;
      startData.states[option.stateFile].grokState = grokState;
    }
    saveGrokbotV2Data(startData);
  }

  const preflightAccounts = [...new Set(stateFiles.flatMap(stateFile => {
    const cfg = startData.states[stateFile];
    return cfg ? getGrokV2AccountPool(!!cfg.autoSwitchGrokState, cfg.grokState) : [];
  }))];
  const preflightQuotas = await refreshGrokV2Quotas(preflightAccounts, true);
  const preflightExhausted = preflightQuotas.filter(info => !info.available);
  const preflightAvailable = preflightQuotas.filter(info => info.available).length;

  infiniteGenV2Running = true;
  res.json({
    success: true,
    message: `Infinite Generate Grokbot V2 dimulai untuk ${stateFiles.length} state (interval ${requestedIntervalMinutes} menit)`,
    quotas: preflightQuotas,
    quotaWarning: preflightExhausted.length > 0
      ? `${preflightExhausted.length} akun tidak tersedia dan akan dilewati.${preflightAvailable === 0 ? ' Semua akun tidak tersedia; proses menunggu akun yang dapat digunakan.' : ''}`
      : null
  });
  if (preflightExhausted.length > 0) {
    const details = preflightExhausted.map(info => {
      const reset = info.resetAt ? new Date(info.resetAt).toLocaleString('id-ID') : 'waktu reset tidak diketahui';
      return `${info.stateName} (reset ${reset})`;
    }).join(', ');
    grokbotv2Log(`Pre-check quota: akun yang dilewati: ${details}.`);
  } else {
    grokbotv2Log(`Pre-check quota selesai: ${preflightAvailable} akun Grok tersedia.`);
  }
  grokbotv2Log(`♾️ Infinite Generate V2 dimulai untuk ${stateFiles.length} state aktif (interval ${requestedIntervalMinutes} menit antar-request).`);

  (async () => {
    // Proses satu video final per siklus. Jika merge aktif, satu video final
    // tetap membutuhkan dua raw; setiap request raw dipisahkan sesuai setting.
    const batchSize = 1;
    try {
      while (infiniteGenV2Running) {
        const data = loadGrokbotV2Data();
        const targets: InfiniteStockTarget[] = [];
        for (const stateFile of stateFiles) {
          const cfg = data.states[stateFile];
          if (!cfg || !cfg.promptFile || (!cfg.autoSwitchGrokState && !cfg.grokState)) continue;
          if (getGrokV2AccountPool(!!cfg.autoSwitchGrokState, cfg.grokState).length === 0) continue;
          const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
          const utamaDir = path.join(GROK_DOWNLOAD_DIR, stateName);
          const cadanganDir = path.join(utamaDir, 'cadangan');
          targets.push({ stateFile, stateName, stockType: 'utama', stockCount: countPendingVideos(utamaDir, '.downloaded.json', 'grok_') });
          targets.push({ stateFile, stateName, stockType: 'cadangan', stockCount: countPendingVideos(cadanganDir, '.downloaded.json', 'grok_') });
        }

        if (targets.length === 0) {
          grokbotv2Log('⚠️ Tidak ada state aktif dengan konfigurasi Grok dan prompt yang valid. Cek ulang 30 detik lagi.');
          await waitWhileRunning(30000, () => infiniteGenV2Running);
          continue;
        }

        const cycleAccounts = [...new Set(targets.flatMap(item => {
          const targetCfg = data.states[item.stateFile];
          return getGrokV2AccountPool(!!targetCfg.autoSwitchGrokState, targetCfg.grokState);
        }))];
        const cycleQuotas = await refreshGrokV2Quotas(cycleAccounts);
        const cycleQuotaUnavailable = cycleQuotas.filter(info => !info.available);
        if (cycleQuotaUnavailable.length > 0) {
          grokbotv2Log(`Audit quota: ${cycleQuotaUnavailable.map(info => `${info.stateName}=${info.usedPercent ?? '?'}%`).join(', ')}`);
        }

        const availableTargets = targets.filter(item => {
          const targetCfg = data.states[item.stateFile];
          return getGrokV2AccountPool(!!targetCfg.autoSwitchGrokState, targetCfg.grokState).some(account => !isGrokV2AccountUnavailable(account));
        });
        if (availableTargets.length === 0) {
          const allAccounts = [...new Set(targets.flatMap(item => {
            const targetCfg = data.states[item.stateFile];
            return getGrokV2AccountPool(!!targetCfg.autoSwitchGrokState, targetCfg.grokState);
          }))];
          const cooldownMs = getGrokV2WaitMs(allAccounts);
          const resumeAt = new Date(Date.now() + cooldownMs);
          const waitingForQuota = allAccounts.some(isGrokV2AccountQuotaUnavailable);
          infiniteGenV2WaitInfo = { rateLimitTime: new Date().toISOString(), resumeTime: resumeAt.toISOString(), targetState: 'Semua state', reason: waitingForQuota ? 'quota' : 'rate_limit' };
          const waitMinutes = Math.max(1, Math.ceil(cooldownMs / 60000));
          const limitMessage = `🚫 [GrokbotV2] Semua Grok State yang tersedia terkena ${waitingForQuota ? 'quota limit/rate limit' : 'rate limit'} (${allAccounts.map(a => a.replace('grok-state-', '').replace('.json', '')).join(', ')}). Infinite Generate dilanjutkan sekitar ${waitMinutes} menit lagi (${resumeAt.toLocaleString('id-ID')}).`;
          grokbotv2Log(limitMessage);
          sendWAMessageV2(limitMessage);
          await waitWhileRunning(cooldownMs, () => infiniteGenV2Running);
          if (!infiniteGenV2Running) break;
          allAccounts.forEach(clearGrokRateLimit);
          infiniteGenV2WaitInfo = null;
          continue;
        }

        availableTargets.sort((a, b) => a.stockCount - b.stockCount || a.stateName.localeCompare(b.stateName) || a.stockType.localeCompare(b.stockType));
        const target = availableTargets[0];

        const cfg = data.states[target.stateFile];
        const mergeEnabled = cfg.merge !== false;
        const rawCount = mergeEnabled ? batchSize * 2 : batchSize;
        const targetDir = target.stockType === 'cadangan'
          ? path.join(GROK_DOWNLOAD_DIR, target.stateName, 'cadangan')
          : path.join(GROK_DOWNLOAD_DIR, target.stateName);

        resetGrokbotv2Progress({ currentState: target.stateName, mergeTotal: mergeEnabled ? batchSize : 0 });
        grokbotv2Queue = [{ stateName: target.stateName, stateFile: target.stateFile, videoCount: batchSize, scheduleStart: `Infinite ${target.stockType}`, scheduleEnd: `Stok ${target.stockCount}`, active: true }];
        grokbotv2BroadcastQueue();
        grokbotv2BroadcastProgress();

        const startMessage = `♾️ [GrokbotV2] State ${target.stateName}, stok ${target.stockType} paling sedikit (${target.stockCount}). Akan generate ${batchSize} video (${rawCount} video mentah).`;
        grokbotv2Log(startMessage);
        sendWAMessageV2(startMessage);

    const generationResult = await runGrokGeneratorV2({
          stateFile: target.stateFile,
          grokState: cfg.grokState,
          bahanFolder: cfg.bahanFolder,
          promptFile: cfg.promptFile,
          mode: cfg.mode || 'Video',
          resolution: cfg.resolution || '720p',
          duration: cfg.duration || '10s',
          aspectRatio: cfg.aspectRatio || '9:16',
          headless: isHeadlessEnabledV2(target.stateFile),
          totalVideos: batchSize,
          merge: mergeEnabled,
          audioFolder: cfg.audioFolder,
          customDownloadDir: targetDir,
          autoSwitchGrokState: !!cfg.autoSwitchGrokState,
          generationIntervalMs,
          notifyWhatsApp: true,
          notificationLabel: target.stockType
        }, grokbotv2Log);

        if (generationResult.allAccountsLimited) grokbotv2Log(`🔎 Seluruh akun untuk ${target.stateName} limit; mengaudit akun state lain.`);
        if (generationResult.recoverableError) {
          const retryAt = new Date(Date.now() + generationIntervalMs);
          infiniteGenV2WaitInfo = {
            rateLimitTime: new Date().toISOString(),
            resumeTime: retryAt.toISOString(),
            targetState: target.stateName
          };
          const recoverableMessage = `⚠️ [GrokbotV2] ${generationResult.recoverableError}. Infinite Generate tetap aktif dan akan mencoba kembali sekitar ${retryAt.toLocaleString('id-ID')}.`;
          grokbotv2Log(recoverableMessage);
          sendWAMessageV2(recoverableMessage);
          await waitWhileRunning(generationIntervalMs, () => infiniteGenV2Running);
          infiniteGenV2WaitInfo = null;
          continue;
        }
        if (generationResult.fatalError) {
          grokbotv2Log(`❌ Infinite Generate dihentikan karena error fatal: ${generationResult.fatalError}`);
          break;
        }
        await waitWhileRunning(2000, () => infiniteGenV2Running);
      }
    } catch (error: any) {
      grokbotv2Log(`❌ Infinite Generate V2 error: ${error.message}`);
      sendWAMessageV2(`❌ [GrokbotV2] Infinite Generate error: ${error.message}`);
    } finally {
      infiniteGenV2Running = false;
      infiniteGenV2WaitInfo = null;
      grokbotv2Queue = [];
      resetGrokbotv2Progress();
      grokbotv2BroadcastQueue();
      grokbotv2BroadcastProgress();
      grokbotv2Log('===== INFINITE GENERATE V2 FINISHED =====');
    }
  })();
});

function saveGrokbotV2InfiniteSchedule(config: InfiniteScheduleConfig) {
  const data = loadGrokbotV2Data();
  data.infiniteSchedule = config;
  saveGrokbotV2Data(data);
}

async function runGrokbotV2InfiniteSchedule(): Promise<void> {
  if (grokbotv2InfiniteScheduleRunning) return;
  const initial = loadGrokbotV2Data().infiniteSchedule;
  if (!initial?.active || initial.states.length === 0) return;
  grokbotv2InfiniteScheduleRunning = true;
  grokbotv2Log('♾️ Infinite Schedule Grokbot V2 aktif.');

  try {
    while (grokbotv2InfiniteScheduleRunning) {
      const data = loadGrokbotV2Data();
      const schedule = data.infiniteSchedule;
      if (!schedule?.active || schedule.states.length === 0) break;
      schedule.states.sort((a, b) => a.order - b.order);

      if (!schedule.started) {
        const waitMs = Math.max(0, new Date(schedule.initialRunAt).getTime() - Date.now());
        if (waitMs > 0) {
          grokbotv2Log(`⏳ Infinite Schedule menunggu initial time ${new Date(schedule.initialRunAt).toLocaleString('id-ID')}`);
          await waitWhileRunning(waitMs, () => grokbotv2InfiniteScheduleRunning);
        }
        if (!grokbotv2InfiniteScheduleRunning) break;
        schedule.started = true;
        schedule.updatedAt = new Date().toISOString();
        saveGrokbotV2InfiniteSchedule(schedule);
      }

      let selectedIndex = -1;
      let selectedStock = 0;
      for (let offset = 0; offset < schedule.states.length; offset++) {
        const idx = (schedule.currentIndex + offset) % schedule.states.length;
        const entry = schedule.states[idx];
        const stateName = entry.stateFile.replace('tiktok-state-', '').replace('.json', '');
        const stock = countPendingVideos(path.join(GROK_DOWNLOAD_DIR, stateName), '.downloaded.json', 'grok_');
        if (stock > 0 && data.states[entry.stateFile]) {
          selectedIndex = idx;
          selectedStock = stock;
          break;
        }
        grokbotv2Log(`⚠️ [Infinite Schedule] ${stateName} dilewati karena stok utama kosong atau konfigurasi tidak tersedia.`);
      }

      if (selectedIndex < 0) {
        schedule.active = false;
        schedule.updatedAt = new Date().toISOString();
        saveGrokbotV2InfiniteSchedule(schedule);
        const warning = '⚠️ [GrokbotV2 Infinite Schedule] Seluruh stok state terpilih kosong. Infinite Schedule dihentikan.';
        grokbotv2Log(warning);
        sendWAMessageV2(warning);
        break;
      }

      const entry = schedule.states[selectedIndex];
      const cfg = data.states[entry.stateFile];
      const stateName = entry.stateFile.replace('tiktok-state-', '').replace('.json', '');
      const stateDir = path.join(GROK_DOWNLOAD_DIR, stateName);
      const videos = fs.readdirSync(stateDir)
        .filter(file => fs.statSync(path.join(stateDir, file)).isFile() && file.startsWith('grok_') && ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(path.extname(file).toLowerCase()))
        .sort();
      let downloaded: Record<string, boolean> = {};
      const marksFile = path.join(stateDir, '.downloaded.json');
      try { downloaded = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      const pending = videos.filter(file => !downloaded[file]);
      if (pending.length === 0) {
        schedule.currentIndex = (selectedIndex + 1) % schedule.states.length;
        saveGrokbotV2InfiniteSchedule(schedule);
        continue;
      }

      const startMessage = `🚀 [GrokbotV2 Infinite Schedule] Mulai melakukan schedule state ${stateName}. Jumlah stok: ${selectedStock}.`;
      grokbotv2Log(startMessage);
      sendWAMessageV2(startMessage);
      let successCount = 0;
      let plannedItems: SchedulePlanItem[] = [];

      await runUpload({
        videoFolder: stateDir,
        startFromVideo: pending[0],
        description: cfg.description || '',
        hashtags: cfg.hashtags || '',
        addProduct: !!cfg.addProduct,
        productNameRadio: cfg.productNameRadio || '',
        productTitle: cfg.productTitle || '',
        productDescription: cfg.productDescription || '',
        skipSwitches: true,
        headless: isHeadlessEnabledV2(entry.stateFile),
        scheduleDate: entry.scheduleDate,
        scheduleTime: entry.scheduleTime,
        intervalMinutes: cfg.threeUploadsPerHour ? 300 : (cfg.intervalMinutes || 60),
        stateFile: entry.stateFile,
        statesDir: STATES_DIR,
        threeUploadsPerHour: !!cfg.threeUploadsPerHour,
        randomizeIntervalSchedule: true
      }, grokbotv2Log, filename => {
        let marks: Record<string, boolean> = {};
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
        marks[filename] = true;
        fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
        const videoPath = path.join(stateDir, filename);
        if (fs.existsSync(videoPath)) try { fs.unlinkSync(videoPath); } catch {}
        successCount++;
      }, items => {
        plannedItems = items;
        sendWAMessageV2(buildScheduleListMessage(stateName, items));
      });

      const nextBaseline = nextScheduleBaseline(plannedItems, cfg, entry.scheduleDate, entry.scheduleTime);
      entry.scheduleDate = nextBaseline.scheduleDate;
      entry.scheduleTime = nextBaseline.scheduleTime;
      schedule.currentIndex = (selectedIndex + 1) % schedule.states.length;
      schedule.updatedAt = new Date().toISOString();
      saveGrokbotV2InfiniteSchedule(schedule);

      const nextEntry = schedule.states[schedule.currentIndex];
      const nextName = nextEntry.stateFile.replace('tiktok-state-', '').replace('.json', '');
      const remaining = countPendingVideos(stateDir, '.downloaded.json', 'grok_');
      const doneMessage = `✅ [GrokbotV2 Infinite Schedule] Telah berhasil upload schedule state ${stateName}. Berhasil: ${successCount}, gagal: ${Math.max(0, pending.length - successCount)}, stok tersisa: ${remaining}. Selanjutnya state ${nextName} pada ${new Date().toLocaleString('id-ID')}.`;
      grokbotv2Log(doneMessage);
      sendWAMessageV2(doneMessage);
    }
  } catch (error: any) {
    grokbotv2Log(`❌ Infinite Schedule V2 error: ${error.message}`);
    sendWAMessageV2(`❌ [GrokbotV2 Infinite Schedule] Error: ${error.message}`);
  } finally {
    grokbotv2InfiniteScheduleRunning = false;
    const finalData = loadGrokbotV2Data();
    if (finalData.infiniteSchedule?.active) {
      finalData.infiniteSchedule.active = false;
      finalData.infiniteSchedule.updatedAt = new Date().toISOString();
      saveGrokbotV2Data(finalData);
    }
    grokbotv2Log('===== INFINITE SCHEDULE V2 FINISHED =====');
  }
}

app.post('/api/grokbotv2/infinite-schedule', (req, res) => {
  if (grokbotv2InfiniteScheduleRunning || grokbotv2FullAutoRunning) return res.status(400).json({ success: false, error: 'Infinite Schedule atau Full Auto sedang aktif' });
  const validationError = validateInfiniteSchedulePayload(req.body.initialRunAt, req.body.states);
  if (validationError) return res.status(400).json({ success: false, error: validationError });
  const states = (req.body.states as InfiniteScheduleStateConfig[]).map((item, index) => ({ ...item, order: index }));
  const config: InfiniteScheduleConfig = { active: true, initialRunAt: req.body.initialRunAt, currentIndex: 0, started: false, states, updatedAt: new Date().toISOString() };
  saveGrokbotV2InfiniteSchedule(config);
  const lines = states.map((item, index) => `${index + 1}. ${item.stateFile.replace('tiktok-state-', '').replace('.json', '')}: ${item.scheduleDate} ${item.scheduleTime}`);
  sendWAMessageV2(`✅ [GrokbotV2] Infinite Schedule berhasil aktif.\nInitial time: ${new Date(config.initialRunAt).toLocaleString('id-ID')}\n${lines.join('\n')}`);
  void runGrokbotV2InfiniteSchedule();
  res.json({ success: true });
});

app.post('/api/grokbotv2/stop-infinite-schedule', (req, res) => {
  grokbotv2InfiniteScheduleRunning = false;
  const data = loadGrokbotV2Data();
  if (data.infiniteSchedule) {
    data.infiniteSchedule.active = false;
    data.infiniteSchedule.updatedAt = new Date().toISOString();
    saveGrokbotV2Data(data);
  }
  grokbotv2Log('⛔ Infinite Schedule V2 dihentikan.');
  res.json({ success: true });
});

app.post('/api/grokbotv2/status', (req, res) => {
  const data = loadGrokbotV2Data();
  res.json({ running: grokbotv2Running, infiniteGenRunning: infiniteGenV2Running, infiniteGenWaitInfo: infiniteGenV2WaitInfo, grokbotFullAutoRunning: grokbotv2FullAutoRunning, infiniteScheduleRunning: grokbotv2InfiniteScheduleRunning, infiniteSchedule: data.infiniteSchedule || null, queue: grokbotv2Queue, progress: grokbotv2Progress, rateLimits: getGrokRateLimits(), globalConfig: data.globalConfig || {} });
});

app.get('/api/grokbotv2/status', (req, res) => {
  const data = loadGrokbotV2Data();
  res.json({ running: grokbotv2Running, infiniteGenRunning: infiniteGenV2Running, infiniteGenWaitInfo: infiniteGenV2WaitInfo, grokbotFullAutoRunning: grokbotv2FullAutoRunning, infiniteScheduleRunning: grokbotv2InfiniteScheduleRunning, infiniteSchedule: data.infiniteSchedule || null, queue: grokbotv2Queue, progress: grokbotv2Progress, rateLimits: getGrokRateLimits(), globalConfig: data.globalConfig || {} });
});

app.post('/api/grokbotv2/stop', async (req, res) => {
  grokbotv2FullAutoRunning = false;
  grokbotv2Running = false;
  infiniteGenV2Running = false;
  grokbotv2InfiniteScheduleRunning = false;
  const stopDataV2 = loadGrokbotV2Data();
  if (stopDataV2.infiniteSchedule) { stopDataV2.infiniteSchedule.active = false; saveGrokbotV2Data(stopDataV2); }
  resetGrokbotv2Progress();
  grokbotv2BroadcastProgress();
  grokbotv2Log('⛔ ===== GROKBOT V2 STOPPED =====');
  res.json({ success: true });
});

app.post('/api/grokbotv2/stop-full-auto', (req, res) => {
  grokbotv2FullAutoRunning = false;
  grokbotv2Log('⛔ ===== FULL AUTO V2 STANDBY STOPPED =====');
  res.json({ success: true });
});

app.post('/api/grokbotv2/stop-infinite-generate', async (req, res) => {
  infiniteGenV2Running = false;
  grokbotv2Log('⛔ ===== INFINITE GENERATE V2 STOPPED =====');
  res.json({ success: true });
});

app.get('/api/grokbotv2/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  grokbotv2SseClients.push(res);
  const progressSnapshot = {
    ...grokbotv2Progress,
    browsers: getBrowserProgress(),
    rateLimits: getGrokRateLimits()
  };
  res.write(`data: [QUEUE_UPDATE]:${JSON.stringify(grokbotv2Queue)}\n\n`);
  res.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(progressSnapshot)}\n\n`);
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = grokbotv2SseClients.indexOf(res);
    if (idx >= 0) grokbotv2SseClients.splice(idx, 1);
  });
});


// ═══════════════════════════════════════════════════════════
//  LEONARDO AI INTEGRATION APIs
// ═══════════════════════════════════════════════════════════

app.get('/leonardo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leonardo.html'));
});

app.get('/api/leonardo/config', (req, res) => {
  try {
    const data = loadLeonardoData();
    const leonardoBahanDir = path.join(__dirname, 'bahan', 'leonardo');
    if (!fs.existsSync(leonardoBahanDir)) {
      fs.mkdirSync(leonardoBahanDir, { recursive: true });
    }

    const folders = fs.readdirSync(leonardoBahanDir)
      .filter(f => fs.statSync(path.join(leonardoBahanDir, f)).isDirectory());

    const bahanList = folders.map(folderName => {
      const folderPath = path.join(leonardoBahanDir, folderName);
      const files = fs.readdirSync(folderPath)
        .filter(f => ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(f).toLowerCase()))
        .map(f => `/bahan/leonardo/${folderName}/${f}`);
      return {
        name: folderName,
        images: files
      };
    });

    res.json({
      accounts: data.accounts.map(acc => ({
        id: acc.id,
        name: acc.name,
        email: acc.email,
        credits: acc.credits,
        isActive: acc.isActive
      })),
      prompts: data.prompts,
      bahan: bahanList
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leonardo/accounts/add', async (req, res) => {
  const { name, cookies } = req.body;
  if (!name || !cookies) {
    return res.status(400).json({ error: 'Nama dan Cookies wajib diisi.' });
  }

  try {
    const token = await getFreshJWT(cookies);
    const details = await fetchCreditBalance(token);
    const data = loadLeonardoData();

    const hasActive = data.accounts.some(acc => acc.isActive);

    const newAccount: LeonardoAccount = {
      id: `acc_${Date.now()}`,
      name,
      cookies,
      isActive: !hasActive,
      email: details.email,
      credits: details.credits
    };

    data.accounts.push(newAccount);
    saveLeonardoData(data);

    res.json({ success: true, account: newAccount });
  } catch (err: any) {
    console.error('Error adding Leonardo account:', err);
    res.status(500).json({ error: err.message || 'Gagal memverifikasi cookie sesi Leonardo.' });
  }
});

app.post('/api/leonardo/accounts/activate', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID akun diperlukan' });

  const data = loadLeonardoData();
  let activatedName = '';
  data.accounts.forEach(acc => {
    if (acc.id === id) {
      acc.isActive = true;
      activatedName = acc.name;
    } else {
      acc.isActive = false;
    }
  });

  if (!activatedName) {
    return res.status(404).json({ error: 'Akun tidak ditemukan' });
  }

  saveLeonardoData(data);
  res.json({ success: true, message: `Akun "${activatedName}" berhasil diaktifkan.` });
});

app.post('/api/leonardo/accounts/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID akun diperlukan' });

  const data = loadLeonardoData();
  const index = data.accounts.findIndex(acc => acc.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Akun tidak ditemukan' });
  }

  const deleted = data.accounts.splice(index, 1)[0];

  if (deleted.isActive && data.accounts.length > 0) {
    data.accounts[0].isActive = true;
  }

  saveLeonardoData(data);
  res.json({ success: true, message: `Akun "${deleted.name}" berhasil dihapus.` });
});

app.post('/api/leonardo/accounts/refresh', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID akun diperlukan' });

  const data = loadLeonardoData();
  const account = data.accounts.find(acc => acc.id === id);
  if (!account) return res.status(404).json({ error: 'Akun tidak ditemukan' });

  try {
    const token = await getFreshJWT(account.cookies);
    const details = await fetchCreditBalance(token);
    account.email = details.email;
    account.credits = details.credits;
    saveLeonardoData(data);
    res.json({ success: true, credits: details.credits, email: details.email });
  } catch (err: any) {
    console.error('Error refreshing credits:', err);
    res.status(500).json({ error: err.message || 'Gagal merefresh saldo kredit.' });
  }
});

app.post('/api/leonardo/prompts/save', (req, res) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) {
    return res.status(400).json({ error: 'Nama dan isi prompt wajib diisi.' });
  }

  const data = loadLeonardoData();
  const newPrompt: LeonardoPrompt = {
    id: `prompt_${Date.now()}`,
    name,
    prompt
  };

  data.prompts.push(newPrompt);
  saveLeonardoData(data);
  res.json({ success: true, prompt: newPrompt });
});

app.post('/api/leonardo/prompts/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID prompt diperlukan' });

  const data = loadLeonardoData();
  const index = data.prompts.findIndex(p => p.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Prompt tidak ditemukan' });
  }

  const deleted = data.prompts.splice(index, 1)[0];
  saveLeonardoData(data);
  res.json({ success: true, message: `Prompt "${deleted.name}" berhasil dihapus.` });
});

app.post('/api/leonardo/bahan/upload', bahanUpload.array('images', 100), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) {
    return res.status(400).json({ error: 'Nama bahan (folderName) diperlukan.' });
  }

  const leonardoBahanDir = path.join(__dirname, 'bahan', 'leonardo');
  const targetDir = path.join(leonardoBahanDir, folderName.trim());
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'Tidak ada file foto yang dipilih.' });
  }

  try {
    for (const f of files) {
      const dest = path.join(targetDir, f.originalname);
      fs.renameSync(f.path, dest);
    }
    res.json({ success: true, count: files.length, folderName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leonardo/bahan/delete', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama bahan diperlukan' });

  const leonardoBahanDir = path.join(__dirname, 'bahan', 'leonardo');
  const targetDir = path.join(leonardoBahanDir, name);
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Bahan tidak ditemukan' });
  }

  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Bahan "${name}" berhasil dihapus.` });
  } catch (err: any) {
    res.status(500).json({ error: `Gagal menghapus folder: ${err.message}` });
  }
});

app.post('/api/leonardo/generate', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const { promptText, duration, mode, aspectRatio, motion_has_audio, imagePath, accountId, targetFolder } = req.body;

  try {
    // 1. Get active account
    sendEvent('progress', { percent: 5, message: 'Membaca akun aktif...' });
    const db = loadLeonardoData();
    const activeAcc = accountId 
      ? db.accounts.find(a => a.id === accountId)
      : db.accounts.find(a => a.isActive);

    if (!activeAcc) {
      throw new Error(accountId ? 'Akun Leonardo yang dipilih tidak ditemukan.' : 'Tidak ada akun Leonardo yang diaktifkan. Silakan aktifkan akun terlebih dahulu di Manajemen Akun.');
    }

    // 2. Fetch fresh token
    sendEvent('progress', { percent: 15, message: `Menghubungkan ke "${activeAcc.name}" & mengambil token JWT...` });
    const token = await getFreshJWT(activeAcc.cookies);

    // 3. Check & refresh credit balance
    const creditDetails = await fetchCreditBalance(token);
    activeAcc.email = creditDetails.email;
    activeAcc.credits = creditDetails.credits;
    saveLeonardoData(db);

    // 4. Upload init image if provided
    let imageId: string | undefined;
    if (imagePath) {
      sendEvent('progress', { percent: 30, message: 'Mengunggah gambar referensi ke Leonardo AI S3...' });
      
      // Front-end sends path like /bahan/leonardo/... We resolve it locally.
      const relativePath = imagePath.startsWith('/') ? imagePath.substring(1) : imagePath;
      const physicalPath = path.join(__dirname, relativePath);
      
      if (!fs.existsSync(physicalPath)) {
        throw new Error(`File gambar referensi tidak ditemukan di path: ${physicalPath}`);
      }
      
      imageId = await uploadInitImage(token, physicalPath);
      sendEvent('progress', { percent: 45, message: 'Gambar referensi berhasil diunggah!' });
    }

    // 5. Trigger Kling generation
    sendEvent('progress', { percent: 55, message: 'Memicu generasi video model Kling-3.0...' });
    
    let width = 720;
    let height = 1280;
    if (aspectRatio === '16:9') {
      width = 1280;
      height = 720;
    } else if (aspectRatio === '1:1') {
      width = 960;
      height = 960;
    }

    const generationId = await triggerKlingGenerate(token, {
      prompt: promptText,
      imageId,
      duration: parseInt(duration) || 10,
      width,
      height,
      mode: mode || 'RESOLUTION_720',
      motion_has_audio: !!motion_has_audio
    });

    sendEvent('progress', { percent: 65, message: `Video dipicu sukses! ID: ${generationId}. Mulai polling status...` });

    // 6. Polling status loop
    let isComplete = false;
    let attempts = 0;
    const maxAttempts = 100; // 5-6 mins max
    let currentStatus = 'PENDING';
    
    while (!isComplete && attempts < maxAttempts) {
      attempts++;
      await new Promise(r => setTimeout(r, 4000));

      currentStatus = await checkGenerationStatus(token, generationId);
      sendEvent('progress', { 
        percent: Math.min(90, 65 + Math.floor(attempts * 1.2)), 
        message: `Menunggu generasi video... Status: ${currentStatus} (Polling #${attempts})` 
      });

      if (currentStatus === 'COMPLETE' || currentStatus === 'COMPLETED') {
        isComplete = true;
      } else if (currentStatus === 'FAILED' || currentStatus === 'ERROR') {
        throw new Error('Generasi video di Leonardo AI gagal atau ditolak.');
      }
    }

    if (!isComplete) {
      throw new Error('Waktu generasi video habis (timeout). Silakan periksa dashboard Leonardo Anda.');
    }

    // 7. Get final video URL
    sendEvent('progress', { percent: 92, message: 'Video selesai! Mengambil URL unduhan S3...' });
    const result = await fetchGenerationVideoUrl(token, generationId);

    // 8. Download video to local static
    sendEvent('progress', { percent: 95, message: 'Mengunduh file video ke server lokal...' });
    const localDownloadUrl = await downloadVideoToLocal(result.videoUrl, generationId);

    // Copy to target folder if specified
    if (targetFolder && fs.existsSync(targetFolder)) {
      try {
        const physicalPath = path.join(__dirname, 'public', localDownloadUrl);
        if (fs.existsSync(physicalPath)) {
          const dest = path.join(targetFolder, path.basename(localDownloadUrl));
          fs.copyFileSync(physicalPath, dest);
          sendEvent('progress', { percent: 98, message: `Berhasil menyalin video ke folder lokal: ${dest}` });
        }
      } catch (copyErr: any) {
        console.warn('Gagal menyalin file ke folder lokal target:', copyErr);
      }
    }

    // 9. Success
    sendEvent('done', {
      success: true,
      videoUrl: localDownloadUrl,
      thumbnailUrl: result.thumbnailUrl,
      message: 'Video berhasil dibuat!'
    });

  } catch (err: any) {
    console.error('[LEONARDO-GENERATE] SSE Error:', err);
    sendEvent('error', {
      success: false,
      error: err.message || 'Gagal melakukan generasi video Leonardo.'
    });
  } finally {
    res.end();
  }
});

app.get('/api/leonardo/select-folder', (req, res) => {
  const psCommand = `powershell -NoProfile -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $g = New-Object System.Windows.Forms.FolderBrowserDialog; $g.ShowDialog() | Out-Null; $g.SelectedPath"`;
  exec(psCommand, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const selectedPath = stdout.trim();
    res.json({ success: true, path: selectedPath });
  });
});

app.get('/api/leonardo/preview-local', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File video tidak ditemukan.');
  }
  res.sendFile(filePath);
});

app.post('/api/leonardo/scan-folder', (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath || !fs.existsSync(folderPath)) {
    return res.json({ success: true, videos: [] });
  }
  try {
    const files = fs.readdirSync(folderPath);
    const videos = files
      .filter(f => f.toLowerCase().endsWith('.mp4') && f.toLowerCase().startsWith('leonardo-'))
      .map(f => {
        const fullPath = path.join(folderPath, f);
        const stats = fs.statSync(fullPath);
        return {
          filename: f,
          fullPath,
          mtime: stats.mtime.getTime()
        };
      });
    
    // Urutkan berdasarkan waktu modifikasi terbaru (newest first)
    videos.sort((a, b) => b.mtime - a.mtime);
    res.json({ success: true, videos });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  VIDABOT TO TIKTOK BOT CONSTANTS & PERSISTENCE
// ═══════════════════════════════════════════════════════════
const VIDABOT_DATA_FILE = path.join(__dirname, 'vidabot-data.json');
const VIDA_DOWNLOAD_DIR = path.join(__dirname, 'vidabot-downloads');
if (!fs.existsSync(VIDA_DOWNLOAD_DIR)) fs.mkdirSync(VIDA_DOWNLOAD_DIR, { recursive: true });

interface VidabotStateConfig {
  promptFile: string;
  bahanFolder: string;
  aspectRatio: string;
  merge: boolean;
  audioFolder: string;
  description: string;
  hashtags: string;
  scheduleDate: string;
  scheduleTime: string;
  intervalMinutes: number;
  addProduct?: boolean;
  productNameRadio?: string;
  productTitle?: string;
  productDescription?: string;
  headless?: boolean;
  threeUploadsPerHour?: boolean;
  lastUploadDate?: string;
  lastUploadTime?: string;
}

interface VidabotData {
  states: Record<string, VidabotStateConfig>;
  infiniteSchedule?: InfiniteScheduleConfig;
  globalConfig?: {
    parallelBrowsers?: number;
    headless?: boolean;
    sendWhatsApp?: boolean;
    fullAuto?: {
      enableCustomScheduler?: boolean;
      customIntervalHours?: number;
      customUploadCount?: number;
      headless?: boolean;
    };
  };
}

function loadVidabotData(): VidabotData {
  try {
    if (fs.existsSync(VIDABOT_DATA_FILE)) {
      return JSON.parse(fs.readFileSync(VIDABOT_DATA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading vidabot-data.json:', e);
  }
  return { states: {} };
}

function saveVidabotData(data: VidabotData) {
  try {
    fs.writeFileSync(VIDABOT_DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error saving vidabot-data.json:', e);
  }
}

function isHeadlessEnabledVida(stateFile?: string): boolean {
  const data = loadVidabotData();
  if (data.globalConfig && data.globalConfig.headless === false) {
    return false;
  }
  if (stateFile && data.states && data.states[stateFile] && data.states[stateFile].headless === false) {
    return false;
  }
  return data.globalConfig?.headless !== false;
}

function sendWAMessageVida(msg: string) {
  const data = loadVidabotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalSendWAMessage(msg);
  }
}

function notifyScheduleStartedVida(sched: string, end: string, stateName: string) {
  const data = loadVidabotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalNotifyScheduleStarted(sched, end, stateName);
  }
}

function notifyScheduleFinishedVida(stateName: string, success: boolean, count: number, err?: string) {
  const data = loadVidabotData();
  if (data.globalConfig?.sendWhatsApp !== false) {
    originalNotifyScheduleFinished(stateName, success, count, err);
  }
}

// Global state for Vidabot SSE & Orchestration
const vidabotSseClients: Response[] = [];
let vidabotRunning = false;
let vidaInfiniteGenRunning = false;
let vidabotFullAutoRunning = false;
let vidabotInfiniteScheduleRunning = false;
let vidaInfiniteGenWaitInfo: { rateLimitTime: string; resumeTime: string; targetState: string } | null = null;
let vidabotQueue: Array<{ stateName: string; stateFile: string; videoCount: number; scheduleStart: string; scheduleEnd: string; active: boolean }> = [];
let vidabotProgress: {
  generate: number;
  merge: number;
  upload: number;
  currentState: string;
  browsers: VidabotWorkerProgress[];
  uploadedCount: number;
  uploadTotal: number;
  mergedCount: number;
  mergeTotal: number;
} = {
  generate: 0,
  merge: 0,
  upload: 0,
  currentState: '',
  browsers: [],
  uploadedCount: 0,
  uploadTotal: 0,
  mergedCount: 0,
  mergeTotal: 0,
};

function vidabotLog(msg: string) {
  console.log(`[VIDABOT] ${msg}`);
  vidabotSseClients.forEach(c => c.write(`data: ${msg}\n\n`));
}

function vidabotBroadcastQueue() {
  vidabotSseClients.forEach(c => c.write(`data: [QUEUE_UPDATE]:${JSON.stringify(vidabotQueue)}\n\n`));
}

function vidabotBroadcastProgress() {
  vidabotProgress.browsers = getVidabotBrowserProgress();
  const progressWithRateLimits = {
    ...vidabotProgress,
    rateLimits: getVidabotRateLimits()
  };
  vidabotSseClients.forEach(c => c.write(`data: [PROGRESS_UPDATE]:${JSON.stringify(progressWithRateLimits)}\n\n`));
}

function resetVidabotProgress(overrides: Partial<typeof vidabotProgress> = {}) {
  vidabotProgress = {
    generate: 0, merge: 0, upload: 0, currentState: '',
    browsers: [], uploadedCount: 0, uploadTotal: 0,
    mergedCount: 0, mergeTotal: 0,
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════
//  VIDABOT RESOURCE & ASSET ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/vidabot/bahan', (req, res) => {
  if (!fs.existsSync(BAHAN_DIR)) fs.mkdirSync(BAHAN_DIR, { recursive: true });
  const folders = fs.readdirSync(BAHAN_DIR).filter(f => fs.statSync(path.join(BAHAN_DIR, f)).isDirectory());
  res.json({ folders });
});

app.get('/api/vidabot/bahan/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Folder tidak ditemukan' });
  try {
    const files = fs.readdirSync(targetDir).filter(f => fs.statSync(path.join(targetDir, f)).isFile());
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/bahan/create-folder', (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: 'Nama folder diperlukan' });
  const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(BAHAN_DIR, cleanFolderName);
  if (fs.existsSync(targetDir)) return res.status(400).json({ error: 'Folder sudah ada' });
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, message: `Berhasil membuat folder ${cleanFolderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/bahan/upload', bahanUpload.any(), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) return res.status(400).json({ error: 'folderName diperlukan' });
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const files = (req.files || []) as Express.Multer.File[];
  if (files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });
  for (const f of files) {
    const dest = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dest);
  }
  res.json({ success: true, count: files.length });
});

app.delete('/api/vidabot/bahan/:folderName/:fileName', (req, res) => {
  const { folderName, fileName } = req.params;
  const filePath = path.join(BAHAN_DIR, folderName, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan' });
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus ${fileName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vidabot/bahan/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(BAHAN_DIR, folderName);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Folder tidak ditemukan' });
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Berhasil menghapus folder ${folderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vidabot/audio-folders', (req, res) => {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const folders = fs.readdirSync(AUDIO_DIR).filter(f => fs.statSync(path.join(AUDIO_DIR, f)).isDirectory());
  res.json({ folders });
});

app.get('/api/vidabot/audio/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Folder tidak ditemukan' });
  try {
    const files = fs.readdirSync(targetDir).filter(f => fs.statSync(path.join(targetDir, f)).isFile());
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/audio/create-folder', (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: 'Nama folder diperlukan' });
  const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.join(AUDIO_DIR, cleanFolderName);
  if (fs.existsSync(targetDir)) return res.status(400).json({ error: 'Folder sudah ada' });
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, message: `Berhasil membuat folder ${cleanFolderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/audio/upload', bahanUpload.any(), (req: any, res) => {
  const folderName = req.body.folderName;
  if (!folderName) return res.status(400).json({ error: 'folderName diperlukan' });
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const files = (req.files || []) as Express.Multer.File[];
  if (files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });
  for (const f of files) {
    const dest = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dest);
  }
  res.json({ success: true, count: files.length });
});

app.delete('/api/vidabot/audio/:folderName/:fileName', (req, res) => {
  const { folderName, fileName } = req.params;
  const filePath = path.join(AUDIO_DIR, folderName, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan' });
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Berhasil menghapus ${fileName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vidabot/audio/:folderName', (req, res) => {
  const { folderName } = req.params;
  const targetDir = path.join(AUDIO_DIR, folderName);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Folder tidak ditemukan' });
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true, message: `Berhasil menghapus folder ${folderName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vidabot/prompts', (req, res) => {
  if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const files = fs.readdirSync(PROMPT_DIR).filter(f => f.endsWith('.json'));
  res.json({ files });
});

app.get('/api/vidabot/prompts/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan' });
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const promptText = typeof data.prompt === 'string' ? data.prompt : (Array.isArray(data.prompts) ? data.prompts.join('\n') : (typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
    res.json({ success: true, filename, prompt: promptText });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vidabot/prompts/save', (req, res) => {
  const { name, prompt } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name dan prompt diperlukan' });
  const filename = name.endsWith('.json') ? name : (name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  fs.writeFileSync(path.join(PROMPT_DIR, filename), JSON.stringify({ prompt }, null, 2));
  res.json({ success: true, filename });
});

app.delete('/api/vidabot/prompts/:filename', (req, res) => {
  const { filename } = req.params;
  const filepath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File tidak ditemukan' });
  try {
    fs.unlinkSync(filepath);
    res.json({ success: true, message: `Berhasil menghapus ${filename}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  VIDABOT BOT API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/vidabot/config', (req, res) => {
  res.json(loadVidabotData());
});

app.post('/api/vidabot/config/save', (req, res) => {
  const { stateFile, promptFile, bahanFolder, aspectRatio, merge, audioFolder, description, hashtags, scheduleDate, scheduleTime, intervalMinutes, addProduct, productNameRadio, productTitle, productDescription, headless, threeUploadsPerHour, lastUploadDate, lastUploadTime } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadVidabotData();
  if (!data.states[stateFile]) {
    data.states[stateFile] = {
      promptFile: '', bahanFolder: '',
      aspectRatio: '9:16', merge: true,
      audioFolder: '', description: '', hashtags: '', scheduleDate: '',
      scheduleTime: '', intervalMinutes: 60,
      addProduct: false, productNameRadio: '', productTitle: '', productDescription: '',
      headless: true, threeUploadsPerHour: false, lastUploadDate: '', lastUploadTime: ''
    };
  }
  const s = data.states[stateFile];
  if (promptFile !== undefined) s.promptFile = promptFile;
  if (bahanFolder !== undefined) s.bahanFolder = bahanFolder;
  if (aspectRatio !== undefined) s.aspectRatio = aspectRatio;
  if (merge !== undefined) s.merge = !!merge;
  if (audioFolder !== undefined) s.audioFolder = audioFolder;
  if (description !== undefined) s.description = description;
  if (hashtags !== undefined) s.hashtags = hashtags;
  if (scheduleDate !== undefined) s.scheduleDate = scheduleDate;
  if (scheduleTime !== undefined) s.scheduleTime = scheduleTime;
  if (intervalMinutes !== undefined) s.intervalMinutes = intervalMinutes;
  if (addProduct !== undefined) s.addProduct = !!addProduct;
  if (productNameRadio !== undefined) s.productNameRadio = productNameRadio;
  if (productTitle !== undefined) s.productTitle = productTitle;
  if (productDescription !== undefined) s.productDescription = productDescription;
  if (headless !== undefined) s.headless = !!headless;
  if (threeUploadsPerHour !== undefined) s.threeUploadsPerHour = !!threeUploadsPerHour;
  if (lastUploadDate !== undefined) s.lastUploadDate = lastUploadDate;
  if (lastUploadTime !== undefined) s.lastUploadTime = lastUploadTime;
  saveVidabotData(data);
  res.json({ success: true });
});

app.post('/api/vidabot/global-config/save', (req, res) => {
  const { parallelBrowsers, headless, sendWhatsApp } = req.body;
  const data = loadVidabotData();
  if (!data.globalConfig) data.globalConfig = {};
  if (parallelBrowsers !== undefined) data.globalConfig.parallelBrowsers = Math.max(1, parseInt(parallelBrowsers) || 1);
  if (headless !== undefined) data.globalConfig.headless = !!headless;
  if (sendWhatsApp !== undefined) data.globalConfig.sendWhatsApp = !!sendWhatsApp;
  saveVidabotData(data);
  res.json({ success: true });
});

app.post('/api/vidabot/full-auto-settings/save', (req, res) => {
  const { enableCustomScheduler, customIntervalHours, customUploadCount } = req.body;
  const data = loadVidabotData();
  if (!data.globalConfig) data.globalConfig = {};
  if (!data.globalConfig.fullAuto) data.globalConfig.fullAuto = {};
  if (enableCustomScheduler !== undefined) data.globalConfig.fullAuto.enableCustomScheduler = enableCustomScheduler;
  if (customIntervalHours !== undefined) data.globalConfig.fullAuto.customIntervalHours = customIntervalHours;
  if (customUploadCount !== undefined) data.globalConfig.fullAuto.customUploadCount = customUploadCount;
  saveVidabotData(data);
  res.json({ success: true });
});

app.get('/api/vidabot/stock', (req, res) => {
  const stateFile = req.query.state as string;
  if (!stateFile) return res.json({ raw: 0, utama: 0, cadangan: 0 });
  const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDir = path.join(VIDA_DOWNLOAD_DIR, stateName);
  const rawDir = path.join(stateDir, 'raw');
  const cadanganDir = path.join(stateDir, 'cadangan');
  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  let rawCount = 0;
  if (fs.existsSync(rawDir)) {
    try { rawCount = fs.readdirSync(rawDir).filter(f => exts.includes(path.extname(f).toLowerCase())).length; } catch {}
  }

  let utamaFiles: string[] = [];
  if (fs.existsSync(stateDir)) {
    try {
      utamaFiles = fs.readdirSync(stateDir).filter(f => {
        const full = path.join(stateDir, f);
        return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.')));
      });
    } catch {}
  }

  const marksFile = path.join(stateDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const unuploadedUtama = utamaFiles.filter(f => !marks[f]);

  let cadanganFiles: string[] = [];
  if (fs.existsSync(cadanganDir)) {
    try {
      cadanganFiles = fs.readdirSync(cadanganDir).filter(f => {
        const full = path.join(cadanganDir, f);
        return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.')));
      });
    } catch {}
  }

  const cadanganMarksFile = path.join(cadanganDir, '.uploaded.json');
  let cadanganMarks: Record<string, boolean> = {};
  try { cadanganMarks = JSON.parse(fs.readFileSync(cadanganMarksFile, 'utf-8')); } catch {}

  const unuploadedCadangan = cadanganFiles.filter(f => !cadanganMarks[f]);

  res.json({ raw: rawCount, utama: unuploadedUtama.length, cadangan: unuploadedCadangan.length });
});

app.post('/api/vidabot/generate-utama', async (req, res) => {
  if (vidabotRunning || vidaInfiniteGenRunning || vidabotFullAutoRunning) return res.status(400).json({ error: 'Vidabot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadVidabotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan untuk state ini' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(stateDownloadDir, 'raw');

  if (!fs.existsSync(stateDownloadDir)) fs.mkdirSync(stateDownloadDir, { recursive: true });
  if (cfg.merge && !fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let currentUtamaCount = 0;
  if (fs.existsSync(stateDownloadDir)) {
    try {
      currentUtamaCount = fs.readdirSync(stateDownloadDir).filter(f => {
        const full = path.join(stateDownloadDir, f);
        return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
      }).length;
    } catch {}
  }

  const needed = Math.max(0, 30 - currentUtamaCount);
  if (needed === 0) {
    return res.json({ success: true, message: 'Stok utama sudah penuh (minimal 30 video)' });
  }

  const mergeEnabled = cfg.merge !== false;
  const totalRawToGenerate = mergeEnabled ? (2 * needed) : needed;

  vidabotRunning = true;
  resetVidabotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? needed : 0 });
  vidabotBroadcastProgress();
  res.json({ success: true, message: `Memulai generate ${needed} video utama (${totalRawToGenerate} raw)` });

  vidabotLog(`🚀 Memulai Generate Stok Utama Vidabot untuk ${tiktokStateName}. Dibutuhkan: ${needed} video (${totalRawToGenerate} video mentah)`);
  sendWAMessageVida(`🚀 [Vidabot] Generate Stok Utama dimulai untuk ${tiktokStateName}. Dibutuhkan: ${needed} video (${totalRawToGenerate} video mentah).`);

  const vidaConfig = {
    bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
    promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
    aspectRatio: cfg.aspectRatio || '9:16',
    downloadDir: VIDA_DOWNLOAD_DIR,
    customDownloadDir: stateDownloadDir, totalVideos: totalRawToGenerate,
    merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
    parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
  };

  const poll = setInterval(() => {
    if (!vidabotRunning) { clearInterval(poll); return; }
    const stats = getVidabotStats();
    const progressList = getVidabotBrowserProgress();
    const doneCount = stats.success + stats.failed;
    let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
    let activeCount = 0; let activeProgSum = 0;
    progressList.forEach(bp => { if (bp.status === 'running') { activeCount++; activeProgSum += bp.progress; } });
    if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
    vidabotProgress.generate = Math.min(99, overallGen);
    if (mergeEnabled) {
      vidabotProgress.mergedCount = stats.saved;
      vidabotProgress.mergeTotal = needed;
      vidabotProgress.merge = Math.min(99, Math.round((stats.saved / needed) * 100));
    } else { vidabotProgress.merge = 100; }
    vidabotBroadcastProgress();
  }, 1500);

  try {
    await runVidabotGenerator(vidaConfig, vidabotLog, __dirname);
    clearInterval(poll);
    vidabotProgress.generate = 100; vidabotProgress.merge = 100; vidabotBroadcastProgress();
    vidabotLog(`✓ Stok Utama untuk ${tiktokStateName} berhasil digenerate!`);
    sendWAMessageVida(`🤖 [${tiktokStateName}] Selesai generate stok utama via Vidabot!`);
  } catch (err: any) {
    clearInterval(poll);
    vidabotLog(`❌ Gagal generate Utama: ${err.message}`);
    sendWAMessageVida(`❌ [${tiktokStateName}] Gagal generate Utama via Vidabot: ${err.message}`);
  } finally {
    vidabotRunning = false;
    resetVidabotProgress();
    vidabotBroadcastProgress();
  }
});

app.post('/api/vidabot/generate-cadangan', async (req, res) => {
  if (vidabotRunning || vidaInfiniteGenRunning || vidabotFullAutoRunning) return res.status(400).json({ error: 'Vidabot sedang berjalan!' });
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadVidabotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan untuk state ini' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');
  const rawDir = path.join(cadanganDir, 'raw');

  if (!fs.existsSync(cadanganDir)) fs.mkdirSync(cadanganDir, { recursive: true });
  if (cfg.merge && !fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

  const marksFile = path.join(cadanganDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let currentCadanganCount = 0;
  if (fs.existsSync(cadanganDir)) {
    try {
      currentCadanganCount = fs.readdirSync(cadanganDir).filter(f => {
        const full = path.join(cadanganDir, f);
        return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
      }).length;
    } catch {}
  }

  const needed = Math.max(0, 30 - currentCadanganCount);
  if (needed === 0) {
    return res.json({ success: true, message: 'Stok cadangan sudah penuh (minimal 30 video)' });
  }

  const mergeEnabled = cfg.merge !== false;
  const totalRawToGenerate = mergeEnabled ? (2 * needed) : needed;

  vidabotRunning = true;
  resetVidabotProgress({ currentState: tiktokStateName, mergeTotal: mergeEnabled ? needed : 0 });
  vidabotBroadcastProgress();
  res.json({ success: true, message: `Memulai generate ${needed} video cadangan (${totalRawToGenerate} raw)` });

  vidabotLog(`🚀 Memulai Generate Stok Cadangan Vidabot untuk ${tiktokStateName}. Dibutuhkan: ${needed} video (${totalRawToGenerate} video mentah)`);
  sendWAMessageVida(`🚀 [Vidabot] Generate Stok Cadangan dimulai untuk ${tiktokStateName}. Dibutuhkan: ${needed} video (${totalRawToGenerate} video mentah).`);

  const vidaConfig = {
    bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
    promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
    aspectRatio: cfg.aspectRatio || '9:16',
    downloadDir: VIDA_DOWNLOAD_DIR,
    customDownloadDir: cadanganDir, totalVideos: totalRawToGenerate,
    merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
    parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
  };

  const poll = setInterval(() => {
    if (!vidabotRunning) { clearInterval(poll); return; }
    const stats = getVidabotStats();
    const progressList = getVidabotBrowserProgress();
    const doneCount = stats.success + stats.failed;
    let overallGen = Math.round((doneCount / totalRawToGenerate) * 100);
    let activeCount = 0; let activeProgSum = 0;
    progressList.forEach(bp => { if (bp.status === 'running') { activeCount++; activeProgSum += bp.progress; } });
    if (activeCount > 0) overallGen += Math.round((activeProgSum / activeCount) / totalRawToGenerate);
    vidabotProgress.generate = Math.min(99, overallGen);
    if (mergeEnabled) {
      vidabotProgress.mergedCount = stats.saved;
      vidabotProgress.mergeTotal = needed;
      vidabotProgress.merge = Math.min(99, Math.round((stats.saved / needed) * 100));
    } else { vidabotProgress.merge = 100; }
    vidabotBroadcastProgress();
  }, 1500);

  try {
    await runVidabotGenerator(vidaConfig, vidabotLog, __dirname);
    clearInterval(poll);
    vidabotProgress.generate = 100; vidabotProgress.merge = 100; vidabotBroadcastProgress();
    vidabotLog(`✓ Stok Cadangan untuk ${tiktokStateName} berhasil digenerate!`);
    sendWAMessageVida(`🤖 [${tiktokStateName}] Selesai generate stok cadangan via Vidabot!`);
  } catch (err: any) {
    clearInterval(poll);
    vidabotLog(`❌ Gagal generate Cadangan: ${err.message}`);
    sendWAMessageVida(`❌ [${tiktokStateName}] Gagal generate Cadangan via Vidabot: ${err.message}`);
  } finally {
    vidabotRunning = false;
    resetVidabotProgress();
    vidabotBroadcastProgress();
  }
});

app.post('/api/vidabot/import-cadangan', (req, res) => {
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const cadanganDir = path.join(stateDownloadDir, 'cadangan');

  if (!fs.existsSync(cadanganDir)) {
    return res.status(400).json({ error: 'Folder cadangan tidak ditemukan' });
  }

  const marksFile = path.join(cadanganDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const cadanganFiles = fs.readdirSync(cadanganDir).filter(f => {
    const full = path.join(cadanganDir, f);
    return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
  });

  if (cadanganFiles.length === 0) {
    return res.status(400).json({ error: 'Tidak ada video cadangan yang tersedia untuk diimpor' });
  }

  let importedCount = 0;
  cadanganFiles.forEach(file => {
    const src = path.join(cadanganDir, file);
    const dest = path.join(stateDownloadDir, file);
    try {
      fs.renameSync(src, dest);
      importedCount++;
    } catch (e) {
      console.error(`Gagal memindahkan ${file}:`, e);
    }
  });

  vidabotLog(`📦 [${tiktokStateName}] Berhasil mengimpor ${importedCount} video dari cadangan ke utama.`);
  res.json({ success: true, message: `Berhasil mengimpor ${importedCount} video ke stok utama` });
});

app.post('/api/vidabot/merge-only', async (req, res) => {
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });

  const data = loadVidabotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const rawDir = path.join(stateDownloadDir, 'raw');

  if (!fs.existsSync(rawDir)) return res.status(400).json({ error: 'Folder raw tidak ditemukan' });

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const rawFiles = fs.readdirSync(rawDir).filter(f => exts.includes(path.extname(f).toLowerCase()));
  if (rawFiles.length < 2) return res.status(400).json({ error: 'Minimal butuh 2 video raw untuk di-merge' });

  res.json({ success: true, message: `Memulai merge ${rawFiles.length} video raw` });

  (async () => {
    try {
      vidabotLog(`🔄 [${tiktokStateName}] Memulai proses merge manual...`);
      for (let i = 0; i < rawFiles.length - 1; i += 2) {
        const v1 = path.join(rawDir, rawFiles[i]);
        const v2 = path.join(rawDir, rawFiles[i + 1]);
        const outName = `vida_merged_${Date.now()}_${i}.mp4`;
        const outPath = path.join(stateDownloadDir, outName);

        let audioFilePath: string | undefined = undefined;
        if (cfg.audioFolder) {
          const audioFolderFull = path.join(AUDIO_DIR, cfg.audioFolder);
          if (fs.existsSync(audioFolderFull)) {
            const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg'];
            const audios = fs.readdirSync(audioFolderFull).filter(f => audioExts.includes(path.extname(f).toLowerCase()));
            if (audios.length > 0) {
              audioFilePath = path.join(audioFolderFull, audios[Math.floor(Math.random() * audios.length)]);
            }
          }
        }

        await mergeVideosCopyWithOptionalAudio([v1, v2], outPath, audioFilePath);
        vidabotLog(`✓ Berhasil merge: ${outName}`);
      }
      vidabotLog(`✅ Selesai merge untuk ${tiktokStateName}`);
    } catch (e: any) {
      vidabotLog(`❌ Gagal merge: ${e.message}`);
    }
  })();
});

app.post('/api/vidabot/schedule-only', async (req, res) => {
  const { stateFile } = req.body;
  if (!stateFile) return res.status(400).json({ error: 'stateFile diperlukan' });
  const data = loadVidabotData();
  const cfg = data.states[stateFile];
  if (!cfg) return res.status(400).json({ error: 'Config tidak ditemukan' });

  const tiktokStateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
  const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
  const marksFile = path.join(stateDownloadDir, '.uploaded.json');
  let marks: Record<string, boolean> = {};
  try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

  const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  let pendingVideos: string[] = [];
  if (fs.existsSync(stateDownloadDir)) {
    pendingVideos = fs.readdirSync(stateDownloadDir).filter(f => {
      const full = path.join(stateDownloadDir, f);
      return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
    });
  }

  if (pendingVideos.length === 0) {
    return res.status(400).json({ error: 'Tidak ada video di stok utama untuk di-upload' });
  }

  const videoToUpload = path.join(stateDownloadDir, pendingVideos[0]);
  vidabotRunning = true;
  res.json({ success: true, message: `Memulai upload 1 video untuk ${tiktokStateName}` });

  const onVideoUploaded = (videoFilename: string) => {
    marks[videoFilename] = true;
    fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));

    const uploadedVideoPath = path.join(stateDownloadDir, videoFilename);
    if (fs.existsSync(uploadedVideoPath)) {
      try {
        fs.unlinkSync(uploadedVideoPath);
        vidabotLog(`File video dihapus setelah upload: ${videoFilename}`);
      } catch (e: any) {
        vidabotLog(`Gagal menghapus file ${videoFilename}: ${e.message}`);
      }
    }
  };

  try {
    vidabotLog(`🚀 [${tiktokStateName}] Memulai upload video: ${pendingVideos[0]}`);
    await runUpload({
      stateFile,
      statesDir: STATES_DIR,
      videoFolder: stateDownloadDir,
      startFromVideo: pendingVideos[0],
      description: cfg.description || '',
      hashtags: cfg.hashtags || '',
      scheduleDate: cfg.scheduleDate || '',
      scheduleTime: cfg.scheduleTime || '',
      intervalMinutes: cfg.threeUploadsPerHour ? 300 : (cfg.intervalMinutes || 60),
      addProduct: !!cfg.addProduct,
      productNameRadio: cfg.productNameRadio || '',
      productTitle: cfg.productTitle || '',
      productDescription: cfg.productDescription || '',
      skipSwitches: false,
      headless: isHeadlessEnabledVida(stateFile),
      threeUploadsPerHour: !!cfg.threeUploadsPerHour,
      randomizeIntervalSchedule: true
    }, vidabotLog, onVideoUploaded, items => {
      sendWAMessageVida(buildScheduleListMessage(tiktokStateName, items));
    });

    vidabotLog(`✓ [${tiktokStateName}] Video berhasil diupload dan ditandai!`);
    sendWAMessageVida(`🎬 [${tiktokStateName}] Video ${pendingVideos[0]} berhasil diupload ke TikTok!`);
    sendWAMessageVida(`✅ [${tiktokStateName}] Upload schedule selesai.`);
  } catch (err: any) {
    vidabotLog(`❌ [${tiktokStateName}] Gagal upload: ${err.message}`);
    sendWAMessageVida(`❌ [${tiktokStateName}] Gagal upload ke TikTok: ${err.message}`);
  } finally {
    vidabotRunning = false;
    resetVidabotProgress();
    vidabotBroadcastProgress();
  }
});

app.post('/api/vidabot/schedule', async (req, res) => {
  if (vidabotRunning || vidaInfiniteGenRunning) return res.status(400).json({ error: 'Vidabot sedang berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  vidabotRunning = true;
  res.json({ success: true, message: 'Jadwal upload multi-state dimulai' });

  (async () => {
    try {
      for (const sf of stateFiles) {
        if (!vidabotRunning) break;
        const data = loadVidabotData();
        const cfg = data.states[sf];
        if (!cfg) continue;

        const tiktokStateName = sf.replace('tiktok-state-', '').replace('.json', '');
        const stateDownloadDir = path.join(VIDA_DOWNLOAD_DIR, tiktokStateName);
        const marksFile = path.join(stateDownloadDir, '.uploaded.json');
        let marks: Record<string, boolean> = {};
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}

        const exts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
        let pendingVideos: string[] = [];
        if (fs.existsSync(stateDownloadDir)) {
          pendingVideos = fs.readdirSync(stateDownloadDir).filter(f => {
            const full = path.join(stateDownloadDir, f);
            return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
          });
        }

        if (pendingVideos.length === 0) {
          vidabotLog(`⚠ [${tiktokStateName}] Stok kosong, mencoba generate otomatis...`);
          const mergeEnabled = cfg.merge !== false;
          const totalRaw = mergeEnabled ? 6 : 3;
          const vidaConfig = {
            bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
            promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
            aspectRatio: cfg.aspectRatio || '9:16',
            downloadDir: VIDA_DOWNLOAD_DIR,
            customDownloadDir: stateDownloadDir, totalVideos: totalRaw,
            merge: mergeEnabled, audioFolder: cfg.audioFolder || '',
            parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
          };
          try {
            await runVidabotGenerator(vidaConfig, vidabotLog, __dirname);
          } catch (e: any) {
            vidabotLog(`❌ Auto generate gagal: ${e.message}`);
            continue;
          }
        }

        // Upload first available
        const freshPending = fs.readdirSync(stateDownloadDir).filter(f => {
          const full = path.join(stateDownloadDir, f);
          return fs.statSync(full).isFile() && (f.startsWith('vida_merged_') || (exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))) && !marks[f];
        });

        if (freshPending.length > 0) {
          try {
            vidabotLog(`🚀 [${tiktokStateName}] Mengupload: ${freshPending[0]}`);
            const onVideoUploaded = (videoFilename: string) => {
              marks[videoFilename] = true;
              fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));

              const uploadedVideoPath = path.join(stateDownloadDir, videoFilename);
              if (fs.existsSync(uploadedVideoPath)) {
                try {
                  fs.unlinkSync(uploadedVideoPath);
                  vidabotLog(`File video dihapus setelah upload: ${videoFilename}`);
                } catch (e: any) {
                  vidabotLog(`Gagal menghapus file ${videoFilename}: ${e.message}`);
                }
              }
            };

            await runUpload({
              stateFile: sf,
              statesDir: STATES_DIR,
              videoFolder: stateDownloadDir,
              startFromVideo: freshPending[0],
              description: cfg.description || '',
              hashtags: cfg.hashtags || '',
              scheduleDate: cfg.scheduleDate || '',
              scheduleTime: cfg.scheduleTime || '',
              intervalMinutes: cfg.threeUploadsPerHour ? 300 : (cfg.intervalMinutes || 60),
              addProduct: !!cfg.addProduct,
              productNameRadio: cfg.productNameRadio || '',
              productTitle: cfg.productTitle || '',
              productDescription: cfg.productDescription || '',
              skipSwitches: false,
              headless: isHeadlessEnabledVida(sf),
              threeUploadsPerHour: !!cfg.threeUploadsPerHour,
              randomizeIntervalSchedule: true
            }, vidabotLog, onVideoUploaded, items => {
              sendWAMessageVida(buildScheduleListMessage(tiktokStateName, items));
            });
            vidabotLog(`✓ [${tiktokStateName}] Berhasil upload!`);
            sendWAMessageVida(`✅ [${tiktokStateName}] Upload schedule selesai.`);
          } catch (e: any) {
            vidabotLog(`❌ [${tiktokStateName}] Gagal upload: ${e.message}`);
          }
        }
      }
    } finally {
      vidabotRunning = false;
      resetVidabotProgress();
      vidabotBroadcastProgress();
    }
  })();
});

app.post('/api/vidabot/full-auto', async (req, res) => {
  if (vidabotFullAutoRunning || vidabotInfiniteScheduleRunning) return res.status(400).json({ error: 'Full Auto atau Infinite Schedule Vidabot sedang berjalan!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  vidabotFullAutoRunning = true;
  res.json({ success: true, message: 'Full Auto Vidabot Standby diaktifkan' });
  vidabotLog('🤖 ===== FULL AUTO VIDABOT STANDBY DIMULAI =====');

  (async () => {
    while (vidabotFullAutoRunning) {
      for (const sf of stateFiles) {
        if (!vidabotFullAutoRunning) break;
        // Check and process full auto routine
      }
      let elapsed = 0;
      while (elapsed < 60000 && vidabotFullAutoRunning) {
        await new Promise(r => setTimeout(r, 2000));
        elapsed += 2000;
      }
    }
    vidabotFullAutoRunning = false;
    vidabotLog('⛔ Full Auto Vidabot dihentikan.');
  })();
});

app.post('/api/vidabot/infinite-generate', async (req, res) => {
  if (vidaInfiniteGenRunning || vidabotRunning || vidabotFullAutoRunning) return res.status(400).json({ error: 'Vidabot sedang menjalankan proses lain!' });
  const { stateFiles } = req.body;
  if (!stateFiles || !Array.isArray(stateFiles) || stateFiles.length === 0) {
    return res.status(400).json({ error: 'stateFiles diperlukan' });
  }

  vidaInfiniteGenRunning = true;
  res.json({ success: true, message: 'Infinite Generate Vidabot dimulai' });
  vidabotLog(`♾️ Infinite Generate Vidabot dimulai untuk ${stateFiles.length} state`);

  (async () => {
    const batchSize = 30;
    const cooldownMs = 2 * 60 * 60 * 1000;
    try {
      while (vidaInfiniteGenRunning) {
        const data = loadVidabotData();
        const targets: InfiniteStockTarget[] = [];
        for (const stateFile of stateFiles) {
          const cfg = data.states[stateFile];
          if (!cfg || !cfg.promptFile) continue;
          const stateName = stateFile.replace('tiktok-state-', '').replace('.json', '');
          const utamaDir = path.join(VIDA_DOWNLOAD_DIR, stateName);
          const cadanganDir = path.join(utamaDir, 'cadangan');
          targets.push({ stateFile, stateName, stockType: 'utama', stockCount: countPendingVideos(utamaDir, '.uploaded.json', 'vida_') });
          targets.push({ stateFile, stateName, stockType: 'cadangan', stockCount: countPendingVideos(cadanganDir, '.uploaded.json', 'vida_') });
        }

        targets.sort((a, b) => a.stockCount - b.stockCount || a.stateName.localeCompare(b.stateName) || a.stockType.localeCompare(b.stockType));
        const target = targets[0];
        if (!target) {
          vidabotLog('⚠️ Tidak ada state aktif dengan prompt yang valid. Cek ulang 30 detik lagi.');
          await waitWhileRunning(30000, () => vidaInfiniteGenRunning);
          continue;
        }

        const cfg = data.states[target.stateFile];
        const mergeEnabled = cfg.merge !== false;
        const totalRaw = mergeEnabled ? batchSize * 2 : batchSize;
        const targetDir = target.stockType === 'cadangan'
          ? path.join(VIDA_DOWNLOAD_DIR, target.stateName, 'cadangan')
          : path.join(VIDA_DOWNLOAD_DIR, target.stateName);

        clearVidabotRateLimit(target.stateFile);
        vidabotRunning = true;
        resetVidabotProgress({ currentState: target.stateName, mergeTotal: mergeEnabled ? batchSize : 0 });
        vidabotQueue = [{ stateName: target.stateName, stateFile: target.stateFile, videoCount: batchSize, scheduleStart: `Infinite ${target.stockType}`, scheduleEnd: `Stok ${target.stockCount}`, active: true }];
        vidabotBroadcastQueue();
        vidabotBroadcastProgress();

        const startMessage = `♾️ [Vidabot] State ${target.stateName}, stok ${target.stockType} paling sedikit (${target.stockCount}). Akan generate ${batchSize} video (${totalRaw} video mentah).`;
        vidabotLog(startMessage);
        sendWAMessageVida(startMessage);

        await runVidabotGenerator({
          bahanFolder: cfg.bahanFolder || '', bahanDir: BAHAN_DIR,
          promptFile: cfg.promptFile, promptDir: PROMPT_DIR,
          aspectRatio: cfg.aspectRatio || '9:16',
          downloadDir: VIDA_DOWNLOAD_DIR,
          customDownloadDir: targetDir,
          totalVideos: totalRaw,
          merge: mergeEnabled,
          audioFolder: cfg.audioFolder || '',
          parallelBrowsers: data.globalConfig?.parallelBrowsers || 1,
          rateLimitKey: target.stateFile
        }, vidabotLog, __dirname);
        vidabotRunning = false;

        const rateLimited = !!getVidabotRateLimits()[target.stateFile];
        if (rateLimited && vidaInfiniteGenRunning) {
          const resumeAt = new Date(Date.now() + cooldownMs);
          vidaInfiniteGenWaitInfo = { rateLimitTime: new Date().toISOString(), resumeTime: resumeAt.toISOString(), targetState: target.stateName };
          const limitMessage = `🚫 [Vidabot] AI Vidabot terkena rate limit saat memproses ${target.stateName}. Infinite Generate dilanjutkan 2 jam lagi (${resumeAt.toLocaleString('id-ID')}).`;
          vidabotLog(limitMessage);
          sendWAMessageVida(limitMessage);
          await waitWhileRunning(cooldownMs, () => vidaInfiniteGenRunning);
          vidaInfiniteGenWaitInfo = null;
        } else {
          await waitWhileRunning(2000, () => vidaInfiniteGenRunning);
        }
      }
    } catch (error: any) {
      vidabotLog(`❌ Infinite Generate Vidabot error: ${error.message}`);
      sendWAMessageVida(`❌ [Vidabot] Infinite Generate error: ${error.message}`);
    } finally {
      vidaInfiniteGenRunning = false;
      vidabotRunning = false;
      vidaInfiniteGenWaitInfo = null;
      vidabotQueue = [];
      resetVidabotProgress();
      vidabotBroadcastQueue();
      vidabotBroadcastProgress();
      vidabotLog('===== INFINITE GENERATE VIDABOT FINISHED =====');
    }
  })();
});

function saveVidabotInfiniteSchedule(config: InfiniteScheduleConfig) {
  const data = loadVidabotData();
  data.infiniteSchedule = config;
  saveVidabotData(data);
}

async function runVidabotInfiniteSchedule(): Promise<void> {
  if (vidabotInfiniteScheduleRunning) return;
  const initial = loadVidabotData().infiniteSchedule;
  if (!initial?.active || initial.states.length === 0) return;
  vidabotInfiniteScheduleRunning = true;
  vidabotLog('♾️ Infinite Schedule Vidabot aktif.');

  try {
    while (vidabotInfiniteScheduleRunning) {
      const data = loadVidabotData();
      const schedule = data.infiniteSchedule;
      if (!schedule?.active || schedule.states.length === 0) break;
      schedule.states.sort((a, b) => a.order - b.order);

      if (!schedule.started) {
        const waitMs = Math.max(0, new Date(schedule.initialRunAt).getTime() - Date.now());
        if (waitMs > 0) {
          vidabotLog(`⏳ Infinite Schedule menunggu initial time ${new Date(schedule.initialRunAt).toLocaleString('id-ID')}`);
          await waitWhileRunning(waitMs, () => vidabotInfiniteScheduleRunning);
        }
        if (!vidabotInfiniteScheduleRunning) break;
        schedule.started = true;
        schedule.updatedAt = new Date().toISOString();
        saveVidabotInfiniteSchedule(schedule);
      }

      let selectedIndex = -1;
      let selectedStock = 0;
      for (let offset = 0; offset < schedule.states.length; offset++) {
        const idx = (schedule.currentIndex + offset) % schedule.states.length;
        const entry = schedule.states[idx];
        const stateName = entry.stateFile.replace('tiktok-state-', '').replace('.json', '');
        const stock = countPendingVideos(path.join(VIDA_DOWNLOAD_DIR, stateName), '.uploaded.json', 'vida_');
        if (stock > 0 && data.states[entry.stateFile]) {
          selectedIndex = idx;
          selectedStock = stock;
          break;
        }
        vidabotLog(`⚠️ [Infinite Schedule] ${stateName} dilewati karena stok utama kosong atau konfigurasi tidak tersedia.`);
      }

      if (selectedIndex < 0) {
        schedule.active = false;
        schedule.updatedAt = new Date().toISOString();
        saveVidabotInfiniteSchedule(schedule);
        const warning = '⚠️ [Vidabot Infinite Schedule] Seluruh stok state terpilih kosong. Infinite Schedule dihentikan.';
        vidabotLog(warning);
        sendWAMessageVida(warning);
        break;
      }

      const entry = schedule.states[selectedIndex];
      const cfg = data.states[entry.stateFile];
      const stateName = entry.stateFile.replace('tiktok-state-', '').replace('.json', '');
      const stateDir = path.join(VIDA_DOWNLOAD_DIR, stateName);
      const videos = fs.readdirSync(stateDir)
        .filter(file => fs.statSync(path.join(stateDir, file)).isFile() && file.startsWith('vida_') && ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(path.extname(file).toLowerCase()))
        .sort();
      let uploaded: Record<string, boolean> = {};
      const marksFile = path.join(stateDir, '.uploaded.json');
      try { uploaded = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
      const pending = videos.filter(file => !uploaded[file]);
      if (pending.length === 0) {
        schedule.currentIndex = (selectedIndex + 1) % schedule.states.length;
        saveVidabotInfiniteSchedule(schedule);
        continue;
      }

      const startMessage = `🚀 [Vidabot Infinite Schedule] Mulai melakukan schedule state ${stateName}. Jumlah stok: ${selectedStock}.`;
      vidabotLog(startMessage);
      sendWAMessageVida(startMessage);
      let successCount = 0;
      let plannedItems: SchedulePlanItem[] = [];

      await runUpload({
        videoFolder: stateDir,
        startFromVideo: pending[0],
        description: cfg.description || '',
        hashtags: cfg.hashtags || '',
        addProduct: !!cfg.addProduct,
        productNameRadio: cfg.productNameRadio || '',
        productTitle: cfg.productTitle || '',
        productDescription: cfg.productDescription || '',
        skipSwitches: false,
        headless: isHeadlessEnabledVida(entry.stateFile),
        scheduleDate: entry.scheduleDate,
        scheduleTime: entry.scheduleTime,
        intervalMinutes: cfg.threeUploadsPerHour ? 300 : (cfg.intervalMinutes || 60),
        stateFile: entry.stateFile,
        statesDir: STATES_DIR,
        threeUploadsPerHour: !!cfg.threeUploadsPerHour,
        randomizeIntervalSchedule: true
      }, vidabotLog, filename => {
        let marks: Record<string, boolean> = {};
        try { marks = JSON.parse(fs.readFileSync(marksFile, 'utf-8')); } catch {}
        marks[filename] = true;
        fs.writeFileSync(marksFile, JSON.stringify(marks, null, 2));
        const videoPath = path.join(stateDir, filename);
        if (fs.existsSync(videoPath)) try { fs.unlinkSync(videoPath); } catch {}
        successCount++;
      }, items => {
        plannedItems = items;
        sendWAMessageVida(buildScheduleListMessage(stateName, items));
      });

      const nextBaseline = nextScheduleBaseline(plannedItems, cfg, entry.scheduleDate, entry.scheduleTime);
      entry.scheduleDate = nextBaseline.scheduleDate;
      entry.scheduleTime = nextBaseline.scheduleTime;
      schedule.currentIndex = (selectedIndex + 1) % schedule.states.length;
      schedule.updatedAt = new Date().toISOString();
      saveVidabotInfiniteSchedule(schedule);

      const nextEntry = schedule.states[schedule.currentIndex];
      const nextName = nextEntry.stateFile.replace('tiktok-state-', '').replace('.json', '');
      const remaining = countPendingVideos(stateDir, '.uploaded.json', 'vida_');
      const doneMessage = `✅ [Vidabot Infinite Schedule] Telah berhasil upload schedule state ${stateName}. Berhasil: ${successCount}, gagal: ${Math.max(0, pending.length - successCount)}, stok tersisa: ${remaining}. Selanjutnya state ${nextName} pada ${new Date().toLocaleString('id-ID')}.`;
      vidabotLog(doneMessage);
      sendWAMessageVida(doneMessage);
    }
  } catch (error: any) {
    vidabotLog(`❌ Infinite Schedule Vidabot error: ${error.message}`);
    sendWAMessageVida(`❌ [Vidabot Infinite Schedule] Error: ${error.message}`);
  } finally {
    vidabotInfiniteScheduleRunning = false;
    const finalData = loadVidabotData();
    if (finalData.infiniteSchedule?.active) {
      finalData.infiniteSchedule.active = false;
      finalData.infiniteSchedule.updatedAt = new Date().toISOString();
      saveVidabotData(finalData);
    }
    vidabotLog('===== INFINITE SCHEDULE VIDABOT FINISHED =====');
  }
}

app.post('/api/vidabot/infinite-schedule', (req, res) => {
  if (vidabotInfiniteScheduleRunning || vidabotFullAutoRunning) return res.status(400).json({ success: false, error: 'Infinite Schedule atau Full Auto sedang aktif' });
  const validationError = validateInfiniteSchedulePayload(req.body.initialRunAt, req.body.states);
  if (validationError) return res.status(400).json({ success: false, error: validationError });
  const states = (req.body.states as InfiniteScheduleStateConfig[]).map((item, index) => ({ ...item, order: index }));
  const config: InfiniteScheduleConfig = { active: true, initialRunAt: req.body.initialRunAt, currentIndex: 0, started: false, states, updatedAt: new Date().toISOString() };
  saveVidabotInfiniteSchedule(config);
  const lines = states.map((item, index) => `${index + 1}. ${item.stateFile.replace('tiktok-state-', '').replace('.json', '')}: ${item.scheduleDate} ${item.scheduleTime}`);
  sendWAMessageVida(`✅ [Vidabot] Infinite Schedule berhasil aktif.\nInitial time: ${new Date(config.initialRunAt).toLocaleString('id-ID')}\n${lines.join('\n')}`);
  void runVidabotInfiniteSchedule();
  res.json({ success: true });
});

app.post('/api/vidabot/stop-infinite-schedule', (req, res) => {
  vidabotInfiniteScheduleRunning = false;
  const data = loadVidabotData();
  if (data.infiniteSchedule) {
    data.infiniteSchedule.active = false;
    data.infiniteSchedule.updatedAt = new Date().toISOString();
    saveVidabotData(data);
  }
  vidabotLog('⛔ Infinite Schedule Vidabot dihentikan.');
  res.json({ success: true });
});

app.get('/api/vidabot/status', (req, res) => {
  const data = loadVidabotData();
  res.json({
    running: vidabotRunning,
    infiniteGenRunning: vidaInfiniteGenRunning,
    infiniteGenWaitInfo: vidaInfiniteGenWaitInfo,
    vidabotFullAutoRunning,
    infiniteScheduleRunning: vidabotInfiniteScheduleRunning,
    infiniteSchedule: data.infiniteSchedule || null,
    queue: vidabotQueue,
    progress: vidabotProgress,
    rateLimits: getVidabotRateLimits()
  });
});

app.post('/api/vidabot/stop', async (req, res) => {
  vidaInfiniteGenRunning = false;
  vidabotFullAutoRunning = false;
  vidabotRunning = false;
  vidabotInfiniteScheduleRunning = false;
  const stopDataVida = loadVidabotData();
  if (stopDataVida.infiniteSchedule) { stopDataVida.infiniteSchedule.active = false; saveVidabotData(stopDataVida); }
  resetVidabotProgress();
  vidabotBroadcastProgress();
  await stopVidabotGenerator();
  await stopUploader();
  vidabotLog('⛔ ===== VIDABOT STOPPED =====');
  res.json({ success: true });
});

app.post('/api/vidabot/stop-full-auto', (req, res) => {
  vidabotFullAutoRunning = false;
  vidabotLog('⛔ ===== FULL AUTO VIDABOT STOPPED =====');
  res.json({ success: true });
});

app.post('/api/vidabot/stop-infinite-generate', async (req, res) => {
  vidaInfiniteGenRunning = false;
  await stopVidabotGenerator();
  vidabotLog('⛔ ===== INFINITE GENERATE VIDABOT STOPPED =====');
  res.json({ success: true });
});

app.get('/api/vidabot/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  vidabotSseClients.push(res);
  req.on('close', () => {
    const idx = vidabotSseClients.indexOf(res);
    if (idx >= 0) vidabotSseClients.splice(idx, 1);
  });
});


// Jalankan server
app.listen(PORT, () => {
  initAutopull();
  startWAPolling();
  if (loadGrokbotV2Data().infiniteSchedule?.active) void runGrokbotV2InfiniteSchedule();
  if (loadVidabotData().infiniteSchedule?.active) void runVidabotInfiniteSchedule();
  console.log(`🚀 State Manager berjalan di http://localhost:${PORT}`);
  console.log(`🎬 TikTok Auto Uploader: http://localhost:${PORT}/tiktok`);
  console.log(`🧠 Grok Imagine Generator: http://localhost:${PORT}/grok`);
  console.log(`🤖 YT to TikTok Bot: http://localhost:${PORT}/ytbot`);
  console.log(`🤖 Grok to TikTok Bot: http://localhost:${PORT}/grokbot`);
  console.log(`🎬 Vidabot to TikTok Bot: http://localhost:${PORT}/vidabot`);
  console.log(`🤖 Grok V2 to TikTok Bot: http://localhost:${PORT}/grokbotv2`);
  console.log(`📁 Folder state: ${STATES_DIR} & ${GROK_STATES_DIR}`);
});

