import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  TelegramUpdate,
  TelegramMessage,
  TelegramInlineKeyboardMarkup,
  TelegramChatMember,
} from './telegram-azkayang-types.js';

export interface TelegramAzkayangApiOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseApiUrl?: string; // Default: https://api.telegram.org
  requestTimeoutMs?: number; // Default: 45_000
}

export class TelegramApiError extends Error {
  public statusCode?: number;
  public errorCode?: number;
  public description?: string;
  public parameters?: { retry_after?: number };

  constructor(message: string, statusCode?: number, errorCode?: number, description?: string, parameters?: any) {
    super(message);
    this.name = 'TelegramApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.description = description;
    this.parameters = parameters;
  }
}

export function maskTelegramToken(text: string, token: string): string {
  if (!token || !text) return text;
  return text.split(token).join('***TOKEN***');
}

export class TelegramAzkayangApi {
  private token: string;
  private fetchImpl: typeof fetch;
  private sleepImpl: (ms: number) => Promise<void>;
  private baseApiUrl: string;
  private requestTimeoutMs: number;

  constructor(token: string, options: TelegramAzkayangApiOptions = {}) {
    this.token = token.trim();
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.sleepImpl = options.sleep || ((ms: number) => new Promise(res => setTimeout(res, ms)));
    this.baseApiUrl = (options.baseApiUrl || 'https://api.telegram.org').replace(/\/+$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs || 45_000;
  }

  private getEndpointUrl(method: string): string {
    return `${this.baseApiUrl}/bot${this.token}/${method}`;
  }

  private isIdempotentMethod(method: string): boolean {
    return ['getUpdates', 'getMe', 'getChatAdministrators', 'getFile'].includes(method);
  }

  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Request aborted');
    if (!signal) { await this.sleepImpl(ms); return; }
    let onAbort: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Request aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { await Promise.race([this.sleepImpl(ms), aborted]); }
    finally { signal.removeEventListener('abort', onAbort!); }
  }

  private async callApi<T>(method: string, payload?: any, signal?: AbortSignal, maxRetries = 2, multipart?: FormData): Promise<T> {
    const url = this.getEndpointUrl(method);
    const allowNetworkRetry = this.isIdempotentMethod(method);
    let attempts = 0;

    while (attempts <= maxRetries) {
      attempts++;
      const controller = new AbortController();
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.requestTimeoutMs);

      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeoutId);
          throw new Error('Request aborted');
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: multipart ? undefined : { 'Content-Type': 'application/json' },
          body: multipart || (payload ? JSON.stringify(payload) : undefined),
          signal: controller.signal,
        });

        const data: any = await response.json();
        if (signal?.aborted) throw new Error('Request aborted');
        if (timedOut) throw new Error('Request timeout');
        if (response.status === 429 || data?.error_code === 429) {
          const retryAfter = data?.parameters?.retry_after ?? 2;
          if (Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 60 && attempts <= maxRetries) {
            clearTimeout(timeoutId);
            await this.wait(retryAfter * 1000, signal);
            continue;
          }
          const cleanDesc = maskTelegramToken(String(data?.description || 'Too Many Requests (429)'), this.token);
          throw new TelegramApiError(cleanDesc, response.status, 429, cleanDesc, { retry_after: retryAfter });
        }
        if (!response.ok || !data?.ok) {
          const rawDesc = data?.description || response.statusText;
          const cleanDesc = maskTelegramToken(rawDesc, this.token);
          throw new TelegramApiError(
            maskTelegramToken(`Telegram API error [${method}]: ${rawDesc}`, this.token),
            response.status,
            data?.error_code,
            cleanDesc,
            data?.parameters
          );
        }

        return data.result as T;
      } catch (err: any) {
        if (err instanceof TelegramApiError) throw err;
        if (signal?.aborted) throw new Error('Request aborted');
        if (timedOut) throw new Error(maskTelegramToken(`Request timeout in [${method}] (${this.requestTimeoutMs}ms)`, this.token));

        // Hanya retry network error jika method aman/idempoten
        if (allowNetworkRetry && attempts <= maxRetries) {
          clearTimeout(timeoutId);
          await this.wait(1000 * attempts, signal);
          continue;
        }

        throw new Error(maskTelegramToken(`Network error in [${method}]: ${err.message}`, this.token));
      } finally {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }

    throw new Error(`Max retries reached for ${method}`);
  }

  public async getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.callApi<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
      signal,
      2
    );
  }

  public async getMe(): Promise<{ id: number; is_bot: boolean; first_name: string; username?: string }> {
    return this.callApi('getMe');
  }

  public async sendMessage(
    chatId: number,
    text: string,
    keyboard?: TelegramInlineKeyboardMarkup,
    replyTo?: number,
    parseMode?: 'Markdown' | 'HTML'
  ): Promise<TelegramMessage> {
    const payload: any = {
      chat_id: chatId,
      text,
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (keyboard) payload.reply_markup = keyboard;
    if (replyTo) payload.reply_to_message_id = replyTo;

    return this.callApi<TelegramMessage>('sendMessage', payload);
  }

  public async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: TelegramInlineKeyboardMarkup,
    parseMode?: 'Markdown' | 'HTML'
  ): Promise<void> {
    const payload: any = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (keyboard) payload.reply_markup = keyboard;

    try {
      await this.callApi('editMessageText', payload, undefined, 0);
    } catch (e: any) {
      if (e?.description?.includes('message is not modified')) return;
      throw e;
    }
  }

  public async answerCallbackQuery(id: string, text?: string, alert?: boolean): Promise<void> {
    await this.callApi('answerCallbackQuery', {
      callback_query_id: id,
      text,
      show_alert: alert,
    }, undefined, 0).catch(() => {});
  }

  public async getChatAdministrators(chatId: number): Promise<TelegramChatMember[]> {
    return this.callApi<TelegramChatMember[]>('getChatAdministrators', { chat_id: chatId });
  }

  public async sendVideo(chatId: number, filePath: string, caption?: string): Promise<TelegramMessage> {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File video tidak ditemukan: ${resolved}`);
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 49 * 1024 * 1024) {
      throw new Error(`Ukuran video (${Math.round(stat.size / 1024 / 1024)}MB) melebihi batas Telegram (49MB)`);
    }

    const fileBuffer = fs.readFileSync(resolved);
    const blob = new Blob([fileBuffer], { type: 'video/mp4' });

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('video', blob, path.basename(resolved));
    if (caption) form.append('caption', caption);

    return this.callApi<TelegramMessage>('sendVideo', undefined, undefined, 2, form);
  }

  public async downloadPhoto(fileId: string, destPath: string): Promise<void> {
    const fileInfo = await this.callApi<{ file_id: string; file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    });

    if (!fileInfo.file_path) {
      throw new Error('Telegram tidak mengembalikan file_path');
    }

    // Telegram photo paths are relative, without URL escapes or dot segments.
    if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(fileInfo.file_path)) {
      throw new Error('Telegram mengembalikan file_path yang tidak aman');
    }
    const normalizedFilePath = fileInfo.file_path;

    // Batas file size deklarasi
    if (fileInfo.file_size && fileInfo.file_size > 10 * 1024 * 1024) {
      throw new Error('Ukuran foto terlalu besar (> 10MB)');
    }

    const downloadUrl = `${this.baseApiUrl}/file/bot${this.token}/${normalizedFilePath}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const res = await this.fetchImpl(downloadUrl, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(maskTelegramToken(`Gagal download foto [${res.status}]: ${res.statusText}`, this.token));
      }

      const limit = 10 * 1024 * 1024;
      if (Number(res.headers.get('content-length')) > limit) {
        controller.abort();
        throw new Error('Ukuran foto hasil unduhan melebihi 10MB');
      }
      if (!res.body) throw new Error('Unduhan foto kosong');
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) {
            controller.abort();
            await reader.cancel().catch(() => {});
            throw new Error('Ukuran foto hasil unduhan melebihi 10MB');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const buffer = Buffer.concat(chunks, size);

      // Validasi magic bytes (JPEG, PNG, WebP)
      const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
      const isPng = buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
      const isWebp =
        buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP';

      if (!isJpeg && !isPng && !isWebp) {
        throw new Error('File yang diupload bukan format gambar valid (JPEG/PNG/WebP)');
      }

      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const tempPath = `${destPath}.tmp_${uniqueSuffix}`;

      try {
        fs.writeFileSync(tempPath, buffer, { flag: 'wx' });
        fs.linkSync(tempPath, destPath); // Publish atomically without replacing an existing file.
        fs.unlinkSync(tempPath);
      } catch (writeErr) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        throw writeErr;
      }
    } catch (err: any) {
      throw new Error(maskTelegramToken(err.message, this.token));
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
