import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type ConnectionState
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGrokRateLimits } from './grok-uploader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_DIR = path.join(__dirname, 'baileys_auth');
export const TARGET_GROUP = "120363426226443899@g.us";

export type ConnectionStatusType = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface BaileysState {
  status: ConnectionStatusType;
  qrCodeDataUrl: string | null;
  qrRaw: string | null;
  user: {
    id: string;
    name?: string;
  } | null;
  lastError: string | null;
  lastConnectedAt: string | null;
}

const baileysState: BaileysState = {
  status: 'disconnected',
  qrCodeDataUrl: null,
  qrRaw: null,
  user: null,
  lastError: null,
  lastConnectedAt: null
};

let sock: WASocket | null = null;
let isStarting = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reminderIntervalStarted = false;

export function getBaileysStatus() {
  return {
    ...baileysState,
    targetGroup: TARGET_GROUP
  };
}

export async function initBaileys(): Promise<void> {
  if (isStarting) {
    console.log('[Baileys] Sedang proses inisialisasi, skip duplicate start.');
    return;
  }

  if (baileysState.status === 'connected' && sock) {
    console.log('[Baileys] Sudah terkoneksi.');
    return;
  }

  isStarting = true;
  baileysState.status = 'connecting';
  baileysState.lastError = null;

  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307] as [number, number, number],
      isLatest: false
    }));

    console.log(`[Baileys] Memulai koneksi WhatsApp (v${version.join('.')}, isLatest: ${isLatest})...`);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['TikTok Automation Bot', 'Chrome', '128.0.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[Baileys] QR Code baru diterima, membuat gambar QR...');
        baileysState.qrRaw = qr;
        baileysState.status = 'qr_ready';
        try {
          baileysState.qrCodeDataUrl = await QRCode.toDataURL(qr, {
            width: 320,
            margin: 2,
            color: {
              dark: '#0f172a',
              light: '#ffffff'
            }
          });
        } catch (err: any) {
          console.error('[Baileys] Gagal convert QR ke DataURL:', err.message);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const reason = (lastDisconnect?.error as any)?.message || `Code ${statusCode}`;
        console.log(`[Baileys] Koneksi ditutup: ${reason}`);

        baileysState.status = 'disconnected';
        baileysState.qrCodeDataUrl = null;
        baileysState.qrRaw = null;
        baileysState.user = null;
        baileysState.lastError = reason;
        sock = null;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[Baileys] User logout. Menghapus folder auth session...');
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {}
        } else if (shouldReconnect) {
          console.log('[Baileys] Mencoba reconnect dalam 5 detik...');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            initBaileys().catch(e => console.error('[Baileys] Reconnect error:', e.message));
          }, 5000);
        }
      } else if (connection === 'open') {
        console.log('[Baileys] ✅ Terhubung ke WhatsApp!');
        baileysState.status = 'connected';
        baileysState.qrCodeDataUrl = null;
        baileysState.qrRaw = null;
        baileysState.lastError = null;
        baileysState.lastConnectedAt = new Date().toISOString();

        if (sock?.user) {
          baileysState.user = {
            id: sock.user.id ? sock.user.id.split(':')[0] : 'Unknown',
            name: sock.user.name || sock.user.notify || 'WhatsApp Bot'
          };
          console.log(`[Baileys] Login sebagai: ${baileysState.user.name} (${baileysState.user.id})`);
        }
      }
    });

    // Handle incoming messages untuk command bot
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (msg.key.fromMe || !msg.message) continue;

        const remoteJid = msg.key.remoteJid;
        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim();

        if (!text) continue;

        console.log(`[Baileys Msg] Dari ${remoteJid}: "${text}"`);

        // Respon perintah jika pesan berasal dari TARGET_GROUP atau chat langsung
        if (remoteJid === TARGET_GROUP || text.startsWith('/')) {
          if (text === '/list_schedule') {
            const scheduleFile = path.join(__dirname, 'whatsapp-schedule-info.json');
            if (!fs.existsSync(scheduleFile)) {
              await sendWAMessage("Belum ada schedule yang terdaftar.", remoteJid);
            } else {
              try {
                const sData = JSON.parse(fs.readFileSync(scheduleFile, 'utf-8'));
                const reply = `📋 Informasi Schedule Terakhir:\n- State: ${sData.stateName || 'Tidak diketahui'}\n- Mulai: ${sData.firstUploadTime}\n- Selesai: ${sData.lastUploadTime}`;
                await sendWAMessage(reply, remoteJid);
              } catch {
                await sendWAMessage("Gagal membaca informasi schedule.", remoteJid);
              }
            }
          } else if (text === '/list_grok') {
            try {
              const rateLimits = getGrokRateLimits();
              const keys = Object.keys(rateLimits);
              if (keys.length === 0) {
                await sendWAMessage("🤖 Status Grok: Available", remoteJid);
              } else {
                let reply = "🤖 Status Grok Rate Limit:\n";
                for (const key of keys) {
                  const limit = rateLimits[key];
                  const name = key.replace('grok-state-', '').replace('.json', '');
                  const avail = limit.availableAt || "tidak diketahui";
                  reply += `- State ${name}: Limit sampai ${avail}\n`;
                }
                await sendWAMessage(reply, remoteJid);
              }
            } catch (e: any) {
              await sendWAMessage(`Gagal mengambil status Grok: ${e.message}`, remoteJid);
            }
          } else if (text === '/ping') {
            await sendWAMessage("🏓 Pong! Bot Baileys aktif dan terhubung.", remoteJid);
          }
        }
      }
    });

  } catch (err: any) {
    baileysState.status = 'disconnected';
    baileysState.lastError = err.message;
    console.error('[Baileys] Error saat inisialisasi:', err.message);
  } finally {
    isStarting = false;
  }
}

export async function logoutBaileys(): Promise<boolean> {
  console.log('[Baileys] Memproses logout...');
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
  } catch (e: any) {
    console.warn('[Baileys] Logout error (abaikan):', e.message);
  }

  baileysState.status = 'disconnected';
  baileysState.qrCodeDataUrl = null;
  baileysState.qrRaw = null;
  baileysState.user = null;
  baileysState.lastError = null;

  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (e: any) {
    console.error('[Baileys] Gagal menghapus folder auth:', e.message);
  }

  console.log('[Baileys] Berhasil logout & session dihapus.');
  return true;
}

export async function sendWAMessage(msg: string, targetJid: string = TARGET_GROUP): Promise<boolean> {
  if (!sock || baileysState.status !== 'connected') {
    console.warn(`[Baileys] Tidak bisa kirim pesan (status: ${baileysState.status}): "${msg}"`);
    return false;
  }

  try {
    let jid = targetJid;
    if (!jid.includes('@')) {
      jid = `${jid}@s.whatsapp.net`;
    }
    await sock.sendMessage(jid, { text: msg });
    console.log(`[Baileys] Pesan terkirim ke ${jid}: "${msg.substring(0, 50)}..."`);
    return true;
  } catch (err: any) {
    console.error(`[Baileys] Gagal kirim pesan ke ${targetJid}:`, err.message);
    return false;
  }
}

export function notifyScheduleStarted(firstUploadTime: string, lastUploadTime: string, stateName: string) {
  const msg = `🚀 Schedule Baru Dimulai!\n🔑 State: ${stateName}\n📅 Upload Pertama: ${firstUploadTime}\n📅 Upload Terakhir: ${lastUploadTime}`;
  sendWAMessage(msg);

  let reminderTime = "";
  try {
    const lastUploadDate = new Date(lastUploadTime.trim().replace(' ', 'T') + ':00');
    if (!isNaN(lastUploadDate.getTime())) {
      const reminderMs = lastUploadDate.getTime() - (5 * 60 * 60 * 1000);
      const reminderDate = new Date(reminderMs);
      reminderTime = `${reminderDate.getFullYear()}-${String(reminderDate.getMonth() + 1).padStart(2, '0')}-${String(reminderDate.getDate()).padStart(2, '0')} ${String(reminderDate.getHours()).padStart(2, '0')}:${String(reminderDate.getMinutes()).padStart(2, '0')}`;
    }
  } catch (e: any) {
    console.error("[Baileys] Error kalkulasi reminder time:", e.message);
  }

  const file = path.join(__dirname, 'whatsapp-schedule-info.json');
  const data = {
    firstUploadTime,
    lastUploadTime,
    reminderTime,
    reminderSent: false,
    stateName
  };
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.error("[Baileys] Error menulis schedule info:", e.message);
  }
}

export function notifyScheduleFinished(stateName: string, success: boolean, totalUploaded: number, error?: string) {
  let msg = `✅ Schedule Selesai!\n🔑 State: ${stateName}\n📊 Total Video Terupload: ${totalUploaded}`;
  if (!success) {
    msg = `⚠️ Schedule Berhenti dengan Status Error!\n🔑 State: ${stateName}\n📊 Total Video Terupload: ${totalUploaded}\n❌ Error: ${error || 'Unknown Error'}`;
  }
  sendWAMessage(msg);
}

export function startWAPolling() {
  if (reminderIntervalStarted) return;
  reminderIntervalStarted = true;

  console.log('[Baileys] Memulai interval pengecekan reminder schedule...');

  setInterval(() => {
    const file = path.join(__dirname, 'whatsapp-schedule-info.json');
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (data.reminderTime && !data.reminderSent) {
        const now = Date.now();
        const reminderTimeMs = new Date(data.reminderTime.trim().replace(' ', 'T') + ':00').getTime();
        if (now >= reminderTimeMs) {
          const lastUploadMs = new Date(data.lastUploadTime.trim().replace(' ', 'T') + ':00').getTime();
          if (now < lastUploadMs) {
            sendWAMessage(`⚠️ Peringatan: Schedule untuk state ${data.stateName || 'unknown'} anda hampir habis! (Sisa kurang dari 5 jam)`);
          }
          data.reminderSent = true;
          fs.writeFileSync(file, JSON.stringify(data, null, 2));
        }
      }
    } catch (e: any) {
      console.error("[Baileys] Error checking reminders:", e.message);
    }
  }, 60000);

  // Inisialisasi koneksi Baileys saat server start
  initBaileys().catch(e => console.error('[Baileys] Inisialisasi awal error:', e.message));
}
