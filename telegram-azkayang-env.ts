import fs from 'fs';
import path from 'path';

/**
 * Muat token AZKAYANG_BOT_TELE dari process.env atau file .env lokal
 * tanpa dependency eksternal.
 */
export function getAzkayangBotToken(): string {
  if (process.env.AZKAYANG_BOT_TELE && process.env.AZKAYANG_BOT_TELE.trim() !== '') {
    return process.env.AZKAYANG_BOT_TELE.trim();
  }

  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^AZKAYANG_BOT_TELE\s*=\s*(.*)$/);
        if (match) {
          let val = match[1].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (val) return val;
        }
      }
    } catch {
      // Abaikan bila ada error baca
    }
  }

  return '';
}
