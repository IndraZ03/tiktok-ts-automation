import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAzkayangBotToken } from './telegram-azkayang-env.js';
import { TelegramAzkayangApi } from './telegram-azkayang-api.js';
import { AzkayangStore, assertSafeSegment } from './telegram-azkayang-store.js';
import { AzkayangWorker, parseGenerateCommand } from './telegram-azkayang-worker.js';
import type { TelegramMessage, TelegramCallbackQuery, TelegramInlineKeyboardMarkup } from './telegram-azkayang-types.js';

const TARGET = 'TERNAK CUAN BARENG AYANG';
const TTL = 15 * 60_000;
type Action = () => Promise<void>;
type Button = [string, Action];
type Session = { chat: number; replyTo: number; expires: number; accept: (msg: TelegramMessage) => Promise<void> };
type Ticket = { chat: number; user: number; expires: number; action: Action };

export interface AzkayangServiceOptions {
  token?: string;
  rootDir?: string;
  api?: TelegramAzkayangApi;
  store?: AzkayangStore;
  worker?: AzkayangWorker;
  targetGroupTitle?: string;
  now?: () => Date;
}

export function wibClock(date: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export class AzkayangService {
  readonly api: TelegramAzkayangApi;
  readonly store: AzkayangStore;
  readonly worker: AzkayangWorker;
  private readonly target: string;
  private readonly now: () => Date;
  private running = false;
  private controller?: AbortController;
  private poll?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private username = '';
  private scheduling = false;
  private sessions = new Map<number, Session>();
  private tickets = new Map<string, Ticket>();

  constructor(options: AzkayangServiceOptions = {}) {
    const root = options.rootDir || process.cwd();
    this.store = options.store || new AzkayangStore(root);
    this.api = options.api || new TelegramAzkayangApi(options.token || getAzkayangBotToken());
    this.worker = options.worker || new AzkayangWorker({ store: this.store, api: this.api });
    this.target = options.targetGroupTitle || TARGET;
    this.now = options.now || (() => new Date());
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.store.load();
    this.username = (await this.api.getMe()).username || '';
    this.running = true;
    this.controller = new AbortController();
    this.poll = this.pollUpdates(this.controller.signal);
    this.timer = setInterval(() => {
      void this.checkTinggalBobokSchedule().catch(() => console.error('[AZKAYANG] Pemeriksaan jadwal gagal.'));
    }, 60_000);
    this.timer.unref();
    console.log(`[AZKAYANG] @${this.username} aktif. Admin gunakan /bind_azkayang di grup tujuan.`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    if (this.timer) clearInterval(this.timer);
    this.worker.stop();
    await this.poll;
    await this.worker.idle();
    this.sessions.clear();
    this.tickets.clear();
  }

  private async pollUpdates(signal: AbortSignal): Promise<void> {
    let offset = this.store.load().updateOffset || 0;
    while (this.running && !signal.aborted) {
      try {
        for (const update of await this.api.getUpdates(offset, signal)) {
          if (signal.aborted) break;
          if (update.update_id < offset) continue;
          // Claim before side effects: interrupted updates are not replayed after restart.
          offset = update.update_id + 1;
          this.store.update(d => { d.updateOffset = offset; });
          try {
            if (update.message) await this.handleIncomingMessage(update.message);
            else if (update.callback_query) await this.handleCallbackQuery(update.callback_query);
          } catch {
            console.error('[AZKAYANG] Update gagal diproses; gunakan /start untuk mengulang.');
          }
        }
      } catch {
        if (signal.aborted) return;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 3000);
          signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }

  async handleIncomingMessage(msg: TelegramMessage): Promise<void> {
    if (!msg.from || msg.from.is_bot || !['group', 'supergroup'].includes(msg.chat.type)) return;
    const user = msg.from.id;
    const chat = msg.chat.id;
    const text = (msg.text || '').trim();
    const command = text.match(/^\/(\w+)(?:@([\w]+))?(?:\s|$)/);
    if (command?.[2] && this.username && command[2].toLowerCase() !== this.username.toLowerCase()) return;
    const bound = this.store.load().chatId;
    if (command?.[1] === 'bind_azkayang') {
      if ((bound !== null && bound !== chat) || msg.chat.title !== this.target) return;
      if (!await this.isAdmin(chat, user)) return;
      this.store.update(d => { d.chatId = chat; d.chatTitle = msg.chat.title || null; });
      await this.api.sendMessage(chat, 'Bot terikat ke grup ini, cayang. Admin: /set_grok_accounts untuk memilih dua akun.');
      return;
    }
    if (bound !== chat) return;
    if (command) {
      this.sessions.delete(user);
      switch (command[1]) {
        case 'start': case 'menu': await this.mainMenu(chat, user); return;
        case 'help': await this.guide(chat); return;
        case 'cancel': await this.api.sendMessage(chat, 'Sesi dibatalkan ya bebeb. /start untuk menu.'); return;
        case 'set_grok_accounts': await this.configureAccounts(chat, user, text); return;
        case 'generate': {
          if (/^\/generate(?:@\w+)?$/.test(text)) { await this.generateWizard(chat, user); return; }
          const args = parseGenerateCommand(text);
          if (!args) {
            await this.api.sendMessage(chat, 'Format: /generate 1 "nama bahan" "nama prompt.json". Jumlah batch 1–3.');
            return;
          }
          await this.enqueue(chat, args.batchCount, args.bahanFolder, args.promptFile, msg.from.first_name);
          return;
        }
      }
      return;
    }
    const session = this.sessions.get(user);
    if (!session || session.chat !== chat || session.expires < Date.now()) return;
    if (msg.reply_to_message?.message_id !== session.replyTo) return;
    this.sessions.delete(user);
    try { await session.accept(msg); }
    catch (err) { await this.api.sendMessage(chat, `Gagal bebeb: ${(err as Error).message}. /start untuk ulang.`); }
  }

  async handleCallbackQuery(cb: TelegramCallbackQuery): Promise<void> {
    const chat = cb.message?.chat;
    const ticket = this.tickets.get(cb.data || '');
    if (!chat || !['group', 'supergroup'].includes(chat.type) || this.store.load().chatId !== chat.id ||
        !ticket || ticket.chat !== chat.id || ticket.expires < Date.now() || ticket.user !== cb.from.id) {
      await this.api.answerCallbackQuery(cb.id, 'Tombol bukan milikmu atau sudah kedaluwarsa. Ketik /start ya bebeb.', true);
      return;
    }
    this.tickets.delete(cb.data!);
    await this.api.answerCallbackQuery(cb.id);
    try { await ticket.action(); }
    catch (err) { await this.api.sendMessage(chat.id, `Gagal bebeb: ${(err as Error).message}. /start untuk ulang.`); }
  }

  private async buttons(chat: number, user: number, text: string, buttons: Button[]): Promise<void> {
    for (const [key, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(key);
    if (this.tickets.size > 5000) this.tickets.clear();
    const keyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: buttons.map(([label, action]) => {
      const id = randomUUID();
      this.tickets.set(id, { chat, user, expires: Date.now() + TTL, action });
      return [{ text: label.slice(0, 100), callback_data: id }];
    }) };
    await this.api.sendMessage(chat, text, keyboard);
  }

  private async pick(chat: number, user: number, title: string, values: string[], choose: (value: string) => Promise<void>, page = 0): Promise<void> {
    const start = page * 8;
    const rows: Button[] = values.slice(start, start + 8).map(v => [v, () => choose(v)]);
    if (page > 0) rows.push(['Halaman sebelumnya', () => this.pick(chat, user, title, values, choose, page - 1)]);
    if (start + 8 < values.length) rows.push(['Halaman berikutnya', () => this.pick(chat, user, title, values, choose, page + 1)]);
    rows.push(['Kembali / batal', () => this.mainMenu(chat, user)]);
    await this.buttons(chat, user, values.length ? title : `${title}\nDaftar masih kosong bebeb.`, rows);
  }

  private async ask(chat: number, user: number, text: string, accept: Session['accept']): Promise<void> {
    const message = await this.api.sendMessage(chat, `${text}\nBalas pesan ini dengan Reply. /cancel untuk batal.`);
    this.sessions.set(user, { chat, replyTo: message.message_id, expires: Date.now() + TTL, accept });
  }

  private async mainMenu(chat: number, user: number): Promise<void> {
    this.sessions.delete(user);
    for (const [key, value] of this.tickets) if (value.chat === chat && value.user === user) this.tickets.delete(key);
    await this.buttons(chat, user, 'Halo cayanggg! Pilih kebutuhan cuanmu ya bebeb.', [
      ['Yang Cayang Bisa Pake', () => this.guide(chat)],
      ['Generate video❤️', () => this.generateWizard(chat, user)],
      ['Manajemen Bahan🥰', () => this.bahanMenu(chat, user)],
      ['Manajemen Prompt💌', () => this.promptMenu(chat, user)],
      ['Tinggal Bobok😴', () => this.bobokMenu(chat, user)],
    ]);
  }

  private async guide(chat: number): Promise<void> {
    await this.api.sendMessage(chat,
      'Yang Cayang Bisa Pake\n\n/start membuka menu milikmu. /generate membuka panduan generate bertahap.\n' +
      '/generate 1 "nama bahan" "nama prompt.json" untuk langsung generate (1–3 batch).\n' +
      '1 batch = 4 video mentah, digabung pasangan berurutan menjadi 12 hasil permutasi 4P2.\n' +
      'Bahan dan prompt berbagi dengan dashboard. Kelola bahan: buat set, upload foto lewat Reply, hapus foto/set dengan konfirmasi. ' +
      'Kelola prompt: tambah nama dan teks, baca, hapus. /cancel membatalkan input.\n' +
      'Tinggal Bobok: satu jadwal harian WIB untuk grup, 1 batch/hari. Prompt tetap wajib; bahan bisa acak. Hanya admin mengubah jadwal/akun.\n' +
      'Admin: /bind_azkayang untuk mengikat grup; /set_grok_accounts untuk daftar akun. ' +
      'Pilih akun dengan /set_grok_accounts "grok-state-akun1.json" "grok-state-akun2.json".\n' +
      'Bot harus admin grup atau Group Privacy BotFather dimatikan agar balasan foto dan teks terbaca. ' +
      'Komputer dan server harus menyala. Job terputus tidak diulang otomatis; hasil parsial tetap tersimpan lokal.');
  }

  private async configureAccounts(chat: number, user: number, text: string): Promise<void> {
    if (!await this.requireAdmin(chat, user)) return;
    const available = this.store.listGrokAccounts();
    const args = parseGenerateCommand(text.replace(/^\/set_grok_accounts(?:@\w+)?/, '/generate 1'));
    if (!args || !available.includes(args.bahanFolder) || !available.includes(args.promptFile) || args.bahanFolder === args.promptFile) {
      await this.api.sendMessage(chat, 'Pilih tepat dua akun berbeda yang sudah login:\n' + available.join('\n') +
        '\nFormat: /set_grok_accounts "grok-state-akun1.json" "grok-state-akun2.json"');
      return;
    }
    this.store.update(d => { d.grokAccounts = [args.bahanFolder, args.promptFile]; });
    await this.api.sendMessage(chat, 'Dua akun Grok tersimpan ya bebeb.');
  }

  private async generateWizard(chat: number, user: number): Promise<void> {
    await this.buttons(chat, user, 'Mau berapa batch bebeb?❤️\n1 batch menghasilkan 4 video mentah dan 12 video gabungan permutasi.',
      [1, 2, 3].map(n => [`${n} batch`, () => this.pick(chat, user, 'Mau stok yang mana bebeb?❤️', this.store.listBahan(),
        bahan => this.pick(chat, user, 'Mau prompt yang apa bebeb?❤️', this.store.listPrompts(),
          prompt => this.buttons(chat, user, `Generate ${n} batch\nBahan: ${bahan}\nPrompt: ${prompt}`, [
            ['Generate sekarang', () => this.enqueue(chat, n, bahan, prompt, String(user))],
            ['Batal', () => this.mainMenu(chat, user)],
          ])))] as Button));
  }

  private async enqueue(chat: number, batchCount: number, bahanFolder: string, promptFile: string, triggeredBy: string): Promise<void> {
    const position = await this.worker.enqueue({ id: `task_${randomUUID()}`, chatId: chat, batchCount, bahanFolder, promptFile, triggeredBy });
    await this.api.sendMessage(chat, position > 0 ? `Sabar ya bebeb, antrean #${position}.` : 'Tungguin ya cayanggg lagi generate🩷🩷🩷🩷');
  }

  private async confirm(chat: number, user: number, text: string, action: Action): Promise<void> {
    await this.buttons(chat, user, `${text}\nPenghapusan permanen. Bahan/prompt juga dipakai dashboard.`, [
      ['Ya, hapus permanen', action], ['Batal', () => this.mainMenu(chat, user)],
    ]);
  }

  private async bahanMenu(chat: number, user: number): Promise<void> {
    const sets = () => this.store.listBahan();
    await this.buttons(chat, user, 'Manajemen Bahan🥰', [
      ['Daftar stok / foto', () => this.pick(chat, user, 'Pilih stok', sets(), async folder => {
        const images = this.store.listImages(folder);
        await this.api.sendMessage(chat, `${folder}: ${images.length} foto\n${images.slice(0, 50).join('\n')}`.slice(0, 4000));
      })],
      ['Buat set bahan', () => this.ask(chat, user, 'Nama set bahan baru?', async msg => {
        this.store.createBahan((msg.text || '').trim()); await this.api.sendMessage(chat, 'Set dibuat ya bebeb.');
      })],
      ['Upload foto', () => this.pick(chat, user, 'Pilih set tujuan foto', sets(), async folder => {
        const receive = async (msg: TelegramMessage): Promise<void> => {
          const photo = msg.photo?.at(-1);
          if (!photo) throw new Error('Kirim sebagai foto, bukan dokumen');
          const dest = this.store.imageUploadPath(folder, `telegram-${randomUUID()}.jpg`);
          await this.api.downloadPhoto(photo.file_id, dest);
          await this.api.sendMessage(chat, `Foto tersimpan di ${folder}.`);
          await this.ask(chat, user, 'Kirim foto berikutnya atau /cancel untuk selesai.', receive);
        };
        await this.ask(chat, user, `Kirim foto untuk set ${folder}.`, receive);
      })],
      ['Hapus satu foto', () => this.pick(chat, user, 'Pilih set bahan', sets(), folder =>
        this.pick(chat, user, 'Pilih foto yang dihapus', this.store.listImages(folder), file =>
          this.confirm(chat, user, `Hapus foto ${folder}/${file}?`, async () => {
            this.store.deleteImage(folder, file); await this.api.sendMessage(chat, 'Foto dihapus.');
          })))],
      ['Hapus set bahan', () => this.pick(chat, user, 'Pilih set yang dihapus', sets(), folder =>
        this.confirm(chat, user, `Hapus set ${folder} beserta ${this.store.listImages(folder).length} foto?`, async () => {
          this.store.deleteBahan(folder); await this.api.sendMessage(chat, 'Set bahan dihapus.');
        }))],
      ['Menu utama', () => this.mainMenu(chat, user)],
    ]);
  }

  private async promptMenu(chat: number, user: number): Promise<void> {
    await this.buttons(chat, user, 'Manajemen Prompt💌', [
      ['Daftar / baca prompt', () => this.pick(chat, user, 'Pilih prompt', this.store.listPrompts(), async name => {
        const text = this.store.readPrompt(name);
        for (let i = 0; i < text.length; i += 3500) await this.api.sendMessage(chat, text.slice(i, i + 3500));
      })],
      ['Tambah prompt', () => this.ask(chat, user, 'Nama prompt baru?', async msg => {
        const name = (msg.text || '').trim().replace(/\.json$/i, '') + '.json';
        assertSafeSegment(name);
        if (this.store.listPrompts().includes(name)) throw new Error('Nama prompt sudah ada');
        await this.ask(chat, user, `Isi prompt ${name}?`, async input => {
          this.store.savePrompt(name, (input.text || '').trim()); await this.api.sendMessage(chat, 'Prompt tersimpan bebeb.');
        });
      })],
      ['Hapus prompt', () => this.pick(chat, user, 'Pilih prompt yang dihapus', this.store.listPrompts(), name =>
        this.confirm(chat, user, `Hapus prompt ${name}?`, async () => {
          this.store.deletePrompt(name); await this.api.sendMessage(chat, 'Prompt dihapus.');
        }))],
      ['Menu utama', () => this.mainMenu(chat, user)],
    ]);
  }

  private async bobokMenu(chat: number, user: number): Promise<void> {
    const cfg = this.store.load().tinggalBobok;
    const adminAction = (action: Action): Action => async () => { if (await this.requireAdmin(chat, user)) await action(); };
    await this.buttons(chat, user,
      `Tinggal Bobok😴\nStatus: ${cfg.enabled ? 'aktif' : 'nonaktif'}\nJam: ${cfg.timeWib} WIB\nPrompt: ${cfg.promptFile || 'wajib dipilih'}\n` +
      `Bahan: ${cfg.bahanFolder || 'acak'}\nTerakhir dicoba: ${cfg.lastRunDate || '-'}\nSatu batch per hari. Pengaturan khusus admin.`, [
      ['Set jam WIB', adminAction(() => this.ask(chat, user, 'Jam harian HH:mm WIB?', async msg => {
        if (!await this.requireAdmin(chat, user)) return;
        const time = (msg.text || '').trim();
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Gunakan HH:mm, contoh 07:30');
        this.store.update(d => { d.tinggalBobok.timeWib = time; }); await this.bobokMenu(chat, user);
      }))],
      ['Pilih prompt wajib', adminAction(() => this.pick(chat, user, 'Pilih prompt tetap', this.store.listPrompts(), adminValue(async value => {
        this.store.readPrompt(value); this.store.update(d => { d.tinggalBobok.promptFile = value; }); await this.bobokMenu(chat, user);
      })))],
      ['Pilih bahan / acak', adminAction(() => this.pick(chat, user, 'Pilih bahan', ['Acak setiap hari', ...this.store.listBahan()], adminValue(async value => {
        this.store.update(d => { d.tinggalBobok.bahanFolder = value === 'Acak setiap hari' ? null : value; }); await this.bobokMenu(chat, user);
      })))],
      ['Aktifkan / matikan', adminAction(async () => {
        const current = this.store.load().tinggalBobok;
        if (!current.enabled) {
          if (!current.promptFile) throw new Error('Pilih prompt tetap dahulu');
          this.store.readPrompt(current.promptFile);
          if (new Set(this.store.load().grokAccounts.filter(Boolean)).size !== 2) throw new Error('Admin perlu memilih dua akun Grok');
        }
        this.store.update(d => { d.tinggalBobok.enabled = !current.enabled; }); await this.bobokMenu(chat, user);
      })],
      ['Menu utama', () => this.mainMenu(chat, user)],
    ]);
    function adminValue(action: (value: string) => Promise<void>): (value: string) => Promise<void> {
      return value => adminAction(() => action(value))();
    }
  }

  async checkTinggalBobokSchedule(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      const data = this.store.load();
      const cfg = data.tinggalBobok;
      const clock = wibClock(this.now());
      if (!cfg.enabled || data.chatId === null || !cfg.promptFile || clock.time !== cfg.timeWib || clock.date === cfg.lastRunDate) return;
      // Persist claim before awaiting to prevent duplicate daily jobs. Interrupted claims are not replayed.
      this.store.update(d => { d.tinggalBobok.lastRunDate = clock.date; });
      try {
        const available = this.store.listBahan().filter(name => this.store.listImages(name).length > 0);
        const bahan = cfg.bahanFolder || available[Math.floor(Math.random() * available.length)];
        if (!bahan) throw new Error('Belum ada stok foto yang dapat dipakai');
        await this.enqueue(data.chatId, 1, bahan, cfg.promptFile, 'Tinggal Bobok');
      } catch (err) {
        await this.api.sendMessage(data.chatId, `Tinggal Bobok gagal hari ini: ${(err as Error).message}. Perbaiki lalu /generate manual.`);
      }
    } finally { this.scheduling = false; }
  }

  private async isAdmin(chat: number, user: number): Promise<boolean> {
    try { return (await this.api.getChatAdministrators(chat)).some(a => a.user.id === user && ['administrator', 'creator'].includes(a.status)); }
    catch { return false; }
  }

  private async requireAdmin(chat: number, user: number): Promise<boolean> {
    if (await this.isAdmin(chat, user)) return true;
    await this.api.sendMessage(chat, 'Pengaturan ini khusus admin grup ya cayang.');
    return false;
  }
}

let active: AzkayangService | null = null;
export async function startAzkayangBot(): Promise<void> {
  if (active) return;
  const token = getAzkayangBotToken();
  if (!token) { console.log('[AZKAYANG] Token belum tersedia; bot nonaktif.'); return; }
  const service = new AzkayangService({ token });
  active = service;
  try { await service.start(); }
  catch (err) { active = null; await service.stop(); throw err; }
}
export async function stopAzkayangBot(): Promise<void> {
  const service = active;
  active = null;
  await service?.stop();
}
