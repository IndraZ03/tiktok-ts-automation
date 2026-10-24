import { chromium } from 'playwright';
import path from 'path';

const SESSION_FILE = 'C:\\tiktok-ts-automation\\tiktok-state-tabletmurahxprime.json';

async function getScheduledPosts() {
  console.log('Membuka browser context dengan session...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    console.log('Navigasi ke TikTok Studio...');
    await page.goto('https://www.tiktok.com/tiktokstudio/content', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);

    console.log('Mengambil data daftar postingan...');
    const result = await page.evaluate(async () => {
      const res = await fetch('/tiktok/creator/manage/item_list/v1/?aid=1988&app_name=tiktok_creator_center', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cursor: 0,
          size: 50,
          query: {
            sort_orders: [{ field_name: 'post_time', order: 2 }],
            conditions: [],
            is_recent_posts: false
          }
        })
      });
      return await res.json();
    });

    if (result.status_code !== 0) {
      console.error('API Error:', result.status_msg || `status_code ${result.status_code}`);
      return;
    }

    const items = result.item_list || [];
    const nowUnix = Math.floor(Date.now() / 1000);

    // Filter video terjadwal (memiliki schedule_time atau status scheduled 140)
    const scheduled = items.filter(item => {
      const schedTime = parseInt(item.schedule_time || '0', 10);
      const postTime = parseInt(item.post_time || '0', 10);
      return item.status === 140 || schedTime > nowUnix || (schedTime > 0 && item.play_count === '0');
    });

    console.log(`\nTotal postingan diambil: ${items.length}`);
    console.log(`Total postingan terjadwal (scheduled): ${scheduled.length}\n`);

    if (scheduled.length === 0) {
      console.log('Tidak ditemukan postingan terjadwal saat ini.');
      return;
    }

    // Urutkan jadwal dari yang paling dekat
    scheduled.sort((a, b) => {
      const timeA = parseInt(a.schedule_time || a.post_time || '0', 10);
      const timeB = parseInt(b.schedule_time || b.post_time || '0', 10);
      return timeA - timeB;
    });

    const formattedList = scheduled.map((item, index) => {
      const schedUnix = parseInt(item.schedule_time || item.post_time, 10);
      const dateObj = new Date(schedUnix * 1000);
      const jadwalStr = dateObj.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      return {
        No: index + 1,
        ID: item.item_id,
        'Waktu Jadwal (WIB)': jadwalStr,
        Status: item.status === 140 ? 'Scheduled (140)' : `Status (${item.status})`,
        Caption: item.desc ? (item.desc.length > 55 ? item.desc.substring(0, 52) + '...' : item.desc) : '(tanpa caption)'
      };
    });

    console.table(formattedList);

  } catch (error) {
    console.error('Gagal mengambil jadwal:', error.message);
  } finally {
    await browser.close();
    console.log('Selesai.');
  }
}

getScheduledPosts();
