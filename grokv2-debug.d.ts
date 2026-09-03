// Deklarasi tipe untuk grokv2-debug.js (modul JS tanpa tipe)
import type { Page } from 'playwright';

export const GROK_FETCH_LOGGER_SRC: string;
export const GROK_GENERATE_WRAPPER_SRC: string;
export const GROK_WEBDRIVER_SPOOF_SRC: string;

export function buildDebugInitScript(browserScript: string): string;

export function attachPageDebugListeners(
  page: Page,
  onEvent: (event: string, detail: string) => void
): void;

export function collectFetchLog(page: Page): Promise<any[]>;

export function filterFetchLogLegends(entries: any[], max?: number): string[];

export function dumpFetchLogToFile(
  page: Page,
  dir: string,
  label: string
): Promise<{ fname: string | null; count: number; error?: string }>;