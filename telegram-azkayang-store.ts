import fs from 'fs';
import path from 'path';
import { AzkayangStoreData } from './telegram-azkayang-types.js';

const DEFAULT_STORE: AzkayangStoreData = {
  chatId: null,
  chatTitle: null,
  grokAccounts: ['', ''],
  tinggalBobok: {
    enabled: false,
    timeWib: '07:00',
    promptFile: null,
    bahanFolder: null,
    lastRunDate: null,
  },
};

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

export function assertSafeSegment(name: string): void {
  if (!name || name.trim() !== name || name === '.' || name === '..' || name.endsWith('.') || name.length > 180 || /[\\/:*?"<>|\x00-\x1F]/.test(name)) {
    throw new Error(`Nama tidak valid: ${name}`);
  }
  const base = name.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) {
    throw new Error(`Nama file/folder terlarang: ${name}`);
  }
}

export function assertContainment(target: string, root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path berada di luar folder yang diizinkan');
  }
}

function ensureNoSymlink(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Symlink tidak diizinkan');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function validateStore(data: AzkayangStoreData): void {
  const validId = (value: unknown) => value === null || (Number.isSafeInteger(value) && value !== 0);
  if (!validId(data.chatId) || !(data.chatTitle === null || typeof data.chatTitle === 'string') ||
      (data.updateOffset !== undefined && (!Number.isSafeInteger(data.updateOffset) || data.updateOffset < 0)) ||
      !Array.isArray(data.grokAccounts) || data.grokAccounts.length !== 2 ||
      !data.grokAccounts.every(value => typeof value === 'string')) throw new Error('Schema konfigurasi tidak valid');
  for (const account of data.grokAccounts) if (account) assertSafeSegment(account);
  const cfg = data.tinggalBobok;
  if (!cfg || typeof cfg.enabled !== 'boolean' || typeof cfg.timeWib !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.timeWib) ||
      !(cfg.lastRunDate === null || (typeof cfg.lastRunDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cfg.lastRunDate)))) {
    throw new Error('Schema jadwal tidak valid');
  }
  for (const value of [cfg.promptFile, cfg.bahanFolder]) if (value !== null) {
    if (typeof value !== 'string') throw new Error('Schema katalog tidak valid');
    assertSafeSegment(value);
  }
}

export class AzkayangStore {
  public readonly rootDir: string;
  private readonly storePath: string;

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
    this.storePath = path.join(this.rootDir, 'telegram-azkayang-data.json');
  }

  public load(): AzkayangStoreData {
    if (!fs.existsSync(this.storePath)) {
      return JSON.parse(JSON.stringify(DEFAULT_STORE));
    }
    try {
      ensureNoSymlink(this.storePath);
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Schema konfigurasi tidak valid');
      const merged: AzkayangStoreData = {
        ...JSON.parse(JSON.stringify(DEFAULT_STORE)),
        ...data,
        tinggalBobok: { ...DEFAULT_STORE.tinggalBobok, ...(data.tinggalBobok || {}) },
      };
      validateStore(merged);
      return merged;
    } catch {
      throw new Error('Konfigurasi AZKAYANG rusak. Pulihkan telegram-azkayang-data.json; binding grup tidak direset otomatis.');
    }
  }

  public update(mutator: (draft: AzkayangStoreData) => void): AzkayangStoreData {
    const draft = this.load();
    mutator(draft);
    validateStore(draft);
    ensureNoSymlink(this.storePath);
    const tmp = `${this.storePath}.tmp`;
    ensureNoSymlink(tmp);
    fs.writeFileSync(tmp, JSON.stringify(draft, null, 2));
    fs.renameSync(tmp, this.storePath);
    return draft;
  }

  private safePath(base: string, name: string): string {
    assertSafeSegment(name);
    const root = path.join(this.rootDir, base);
    const target = path.join(root, name);
    assertContainment(target, root);
    ensureNoSymlink(root);
    ensureNoSymlink(target);
    return target;
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  public listBahan(): string[] {
    const base = path.join(this.rootDir, 'bahan');
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).filter((name: string) => {
      try {
        const p = this.safePath('bahan', name);
        return fs.statSync(p).isDirectory();
      } catch { return false; }
    }).sort();
  }

  public listImages(folder: string): string[] {
    const dir = this.safePath('bahan', folder);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((file: string) => {
      try {
        assertSafeSegment(file);
        const p = path.join(dir, file);
        ensureNoSymlink(p);
        return fs.statSync(p).isFile() && IMAGE_EXTS.includes(path.extname(file).toLowerCase());
      } catch { return false; }
    }).sort();
  }

  public createBahan(folder: string): void {
    const dir = this.safePath('bahan', folder);
    if (fs.existsSync(dir)) throw new Error('Folder bahan sudah ada');
    this.ensureDir(dir);
  }

  public imageUploadPath(folder: string, filename: string): string {
    const dir = this.safePath('bahan', folder);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Set bahan tidak ditemukan');
    assertSafeSegment(filename);
    const target = path.join(dir, filename);
    ensureNoSymlink(target);
    return target;
  }

  public deleteImage(folder: string, filename: string): void {
    const dir = this.safePath('bahan', folder);
    assertSafeSegment(filename);
    const p = path.join(dir, filename);
    assertContainment(p, dir);
    ensureNoSymlink(p);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  public deleteBahan(folder: string): void {
    const dir = this.safePath('bahan', folder);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  public listPrompts(): string[] {
    const base = path.join(this.rootDir, 'prompt');
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).filter((name: string) => {
      try {
        const p = this.safePath('prompt', name);
        return fs.statSync(p).isFile() && name.endsWith('.json');
      } catch { return false; }
    }).sort();
  }

  public readPrompt(name: string): string {
    const p = this.safePath('prompt', name);
    if (!fs.existsSync(p)) throw new Error(`Prompt tidak ditemukan: ${name}`);
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const text = typeof data.prompt === 'string' ? data.prompt : (Array.isArray(data.prompts) ? data.prompts[0] : '');
    if (!text || typeof text !== 'string') throw new Error('Isi prompt tidak valid/kosong');
    return text;
  }

  public savePrompt(name: string, promptText: string, allowOverwrite = false): void {
    const finalName = name.endsWith('.json') ? name : `${name}.json`;
    const p = this.safePath('prompt', finalName);
    if (fs.existsSync(p) && !allowOverwrite) throw new Error('Nama prompt sudah ada');
    if (!promptText.trim()) throw new Error('Isi prompt tidak boleh kosong');
    this.ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify({ prompt: promptText }, null, 2));
  }

  public deletePrompt(name: string): void {
    const p = this.safePath('prompt', name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  public listGrokAccounts(): string[] {
    const base = path.join(this.rootDir, 'grok-states');
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).filter((name: string) => /^grok-state-.+\.json$/i.test(name)).sort();
  }
}
