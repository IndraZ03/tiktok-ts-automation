import type { SplitProgressEvent } from './video-splitter.js';

type Sender = (message: string) => boolean | Promise<boolean>;

export interface YtbotUploadOutcome {
  uploadedCount: number;
  total: number;
  stopped: boolean;
  error?: string;
}

export class YtbotNotifier {
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    private sender: Sender,
    private log: (message: string) => void,
    private isEnabled: () => boolean = () => true
  ) {}

  private diagnostic(message: string): void {
    try { this.log(`[YTBot WhatsApp] ${message}`); } catch {}
  }

  private enqueue(message: string): void {
    if (!this.isEnabled()) return;
    if (this.pending >= 256) {
      this.diagnostic('Antrean penuh; notifikasi dilewati.');
      return;
    }
    this.pending++;
    this.queue = this.queue.then(async () => {
      try {
        if (!this.isEnabled()) return;
        if (!await this.sender(message)) this.diagnostic('Pesan tidak terkirim; tanpa retry.');
      } catch (error) {
        this.diagnostic(`Gagal mengirim: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.pending--;
      }
    });
  }

  private job(state: string): (key: string, text: string) => void {
    const sent = new Set<string>();
    return (key, text) => {
      if (sent.has(key)) return;
      sent.add(key);
      this.enqueue(`[YTBot][${state}] ${text}`);
    };
  }

  youtube(state: string, url: string) {
    const notify = this.job(state);
    return {
      progress: (event: SplitProgressEvent): void => {
        if (!event.phase) return;
        const title = event.title || url;
        const key = `${event.stage}:${event.phase}`;
        if (key === 'download:started') notify(key, `Mulai mengunduh video: ${url}\nJudul: ${title}`);
        else if (key === 'download:completed') notify(key, `Selesai mengunduh video: "${title}"`);
        else if (key === 'split:started') notify(key, `Mulai split video menjadi part vertikal: "${title}"`);
        else if (key === 'split:completed') notify(key, `Selesai split video: ${event.totalParts ?? 0} part dari "${title}"`);
      },
      failed: (error: string): void => notify('failed', `Gagal download/split: ${error}\nURL: ${url}`),
    };
  }

  upload(state: string) {
    const notify = this.job(state);
    return {
      started: (total: number, schedule: string): void => {
        notify('started', `Mulai proses upload untuk penjadwalan TikTok.\nPending terdeteksi: ${total} video.\nJadwal awal: ${schedule}`);
      },
      finished: ({ uploadedCount, total, stopped, error }: YtbotUploadOutcome): void => {
        let status: string;
        if (stopped) status = 'Upload dihentikan pengguna.';
        else if (error !== undefined) status = 'Upload gagal / selesai sebagian.';
        else if (uploadedCount === 0) status = 'Proses upload berakhir tanpa upload terkonfirmasi.';
        else if (uploadedCount < total) status = 'Upload selesai sebagian.';
        else status = 'Upload selesai.';
        notify('finished', `${status}\nBerhasil dijadwalkan: ${uploadedCount}/${total} video.${error !== undefined ? `\nError: ${error}` : ''}\nVideo terjadwal belum berarti sudah tayang.`);
      },
    };
  }

  broadcast(message: string): void {
    this.enqueue(message);
  }

  drain(): Promise<void> {
    return this.queue;
  }
}
