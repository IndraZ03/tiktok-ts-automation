// ytbot-core.ts
// Helper logika murni untuk kalkulasi jadwal, manipulasi config, dan prioritas sorting YTBot.

export interface YtbotStateConfig {
  ytLinks: string[];
  description: string;
  hashtags: string;
  scheduleDate: string;
  scheduleTime: string;
  intervalMinutes: number;
  lastUploadDate?: string;
  lastUploadTime?: string;
}

export interface YtbotData {
  states: Record<string, YtbotStateConfig>;
}

// Transaksi tetap sinkron agar endpoint tidak menyela load–mutate–save.
export function mutateYtbotData(
  load: () => YtbotData,
  save: (data: YtbotData) => void,
  mutator: (data: YtbotData) => void
): void {
  const data = load();
  const result = mutator(data) as unknown;
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
    throw new Error('Mutasi YTBot harus sinkron.');
  }
  save(data);
}

/**
 * Menghitung estimasi timestamp upload terakhir dari config state.
 * Fallback: jika lastUploadDate/Time kosong, gunakan scheduleDate/Time dikurangi intervalMinutes.
 * Jika tidak ada jadwal valid, kembalikan 0.
 */
export function calculateYtbotStateLastUploadMs(cfg?: YtbotStateConfig): number {
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

/**
 * Mengurutkan stateFiles berdasarkan timestamp upload terakhir secara ASCENDING (terlama dahulu).
 * State yang paling lama tidak upload atau belum pernah upload (0) akan diprioritaskan lebih dulu.
 */
export function sortYtbotStatesOldestFirst(
  stateFiles: string[],
  statesConfigMap: Record<string, YtbotStateConfig | undefined>
): string[] {
  return [...stateFiles].sort((a, b) => {
    const msA = calculateYtbotStateLastUploadMs(statesConfigMap[a]);
    const msB = calculateYtbotStateLastUploadMs(statesConfigMap[b]);
    return msA - msB;
  });
}

/**
 * Menghapus URL video tertentu dari antrean ytLinks secara aman (mencocokkan link aktual).
 * Mengembalikan true jika link ditemukan dan dihapus.
 */
export function removeYtLinkFromState(cfg: YtbotStateConfig, linkToRemove: string): boolean {
  if (!cfg || !Array.isArray(cfg.ytLinks)) return false;
  const idx = cfg.ytLinks.indexOf(linkToRemove);
  if (idx >= 0) {
    cfg.ytLinks.splice(idx, 1);
    return true;
  }
  return false;
}
