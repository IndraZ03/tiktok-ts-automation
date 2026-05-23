import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // Konfigurasi stealth yang kamu inginkan
  use: {
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    locale: 'id-ID',
    timezoneId: 'Asia/Makassar',
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    },
    // Opsional: screenshot & trace biar lebih mudah debug
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },

  // Project default (Chromium + Chrome asli)
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',                    // pakai Google Chrome asli
      },
    },
  ],
});