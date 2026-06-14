// State and Configurations
let activePlatform = 'tiktok'; // default

const platforms = {
  tiktok: {
    name: 'TikTok',
    url: 'https://www.tiktok.com',
    domain: '.tiktok.com',
    fallbackDomain: 'tiktok.com',
    important: ['sessionid', 'sessionid_ss', 'ttwid', 'msToken', 'odin_tt', 'passport_csrf_token', 's_v_web_id'],
    themeClass: 'tiktok-theme',
    btnText: 'Ambil TikTok Cookies',
    btnIcon: '🎵',
    detectPattern: /tiktok\.com/i,
    infoMsg: 'Pastikan Anda sudah login ke akun TikTok di browser Anda untuk mengekstrak cookie login.'
  },
  grok: {
    name: 'Grok AI',
    url: 'https://grok.com',
    domain: '.grok.com',
    fallbackDomain: 'grok.com',
    important: ['sso', 'sso-rw'],
    themeClass: 'grok-theme',
    btnText: 'Ambil Grok Cookies',
    btnIcon: '🤖',
    detectPattern: /grok\.com/i,
    infoMsg: 'Pastikan Anda sudah login ke akun Grok AI (grok.com) di browser Anda untuk mengekstrak cookie login.'
  }
};

// UI Selectors
const tabButtons = document.querySelectorAll('.tab-btn');
const infoTitle = document.getElementById('info-title');
const infoDesc = document.getElementById('info-desc');
const extractBtn = document.getElementById('extract');
const statusBadge = document.getElementById('status');
const cookiesDiv = document.getElementById('cookies');

// Function to switch platform UI
function switchPlatform(platformKey) {
  activePlatform = platformKey;
  const config = platforms[platformKey];

  // Update tabs visual state
  tabButtons.forEach(btn => {
    if (btn.getAttribute('data-tab') === platformKey) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update Button theme & content
  extractBtn.className = `action-btn ${config.themeClass}`;
  extractBtn.innerHTML = `<span>${config.btnIcon}</span> ${config.btnText}`;

  // Update Info panel
  infoTitle.textContent = `Info Ekstraksi ${config.name}`;
  infoDesc.textContent = config.infoMsg;

  // Reset status & results view if not active
  statusBadge.className = 'status-badge';
  statusBadge.textContent = 'Silakan klik tombol di atas';
  cookiesDiv.textContent = 'Hasil ekstraksi cookie JSON akan muncul di sini dan otomatis tersalin ke clipboard Anda.';
}

// Auto-detect based on current tab
async function init() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      const activeTabUrl = tabs[0].url || '';
      
      if (platforms.grok.detectPattern.test(activeTabUrl)) {
        switchPlatform('grok');
        infoTitle.textContent = `🤖 Terdeteksi Grok AI`;
        infoDesc.textContent = `Ekstensi mendeteksi Anda sedang membuka Grok AI. Siap mengekstrak cookie login.`;
      } else if (platforms.tiktok.detectPattern.test(activeTabUrl)) {
        switchPlatform('tiktok');
        infoTitle.textContent = `🎵 Terdeteksi TikTok`;
        infoDesc.textContent = `Ekstensi mendeteksi Anda sedang membuka TikTok. Siap mengekstrak cookie login.`;
      } else {
        // Default to tiktok but prompt user to open the page
        switchPlatform('tiktok');
        infoTitle.textContent = `🔍 Deteksi Halaman`;
        infoDesc.textContent = `Silakan buka tiktok.com atau grok.com untuk mengekstrak cookie secara langsung, atau klik tombol di bawah.`;
      }
    }
  } catch (err) {
    console.error('Error querying active tab:', err);
  }
}

// Set up Tab Click handlers
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const targetTab = btn.getAttribute('data-tab');
    switchPlatform(targetTab);
  });
});

// Extract Logic
extractBtn.addEventListener('click', async () => {
  const config = platforms[activePlatform];
  
  // Set UI state to Loading
  statusBadge.className = 'status-badge loading';
  statusBadge.textContent = `⏳ Mengekstrak cookies ${config.name}...`;
  cookiesDiv.textContent = 'Sedang memproses...';

  let allCookies = [];
  let cleanDomainPattern = config.fallbackDomain;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentTab = tabs[0] || {};

    // 1. Ambil seluruh cookies yang bisa diakses oleh ekstensi
    allCookies = await chrome.cookies.getAll({});
    
    // 2. Filter cookies berdasarkan domain platform target secara manual
    const cookies = allCookies.filter(c => {
      const domainLower = c.domain.toLowerCase();
      return domainLower.includes(cleanDomainPattern);
    });

    if (!cookies || cookies.length === 0) {
      throw new Error(`Tidak ditemukan cookies untuk domain "${cleanDomainPattern}" di Chrome.`);
    }

    const result = {
      timestamp: new Date().toISOString(),
      platform: config.name,
      url: currentTab.url || '',
      cookieCount: cookies.length,
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : null
      }))
    };

    const jsonString = JSON.stringify(result, null, 2);

    // Copy ke clipboard
    await navigator.clipboard.writeText(jsonString);

    // Update Status
    statusBadge.className = 'status-badge success';
    statusBadge.textContent = '✅ Berhasil dicopy!';

    // Tampilkan ringkasan penting
    let summary = `✅ Berhasil mengekstrak ${config.name} Cookies!\n\n`;
    summary += `Total Cookies: ${cookies.length}\n`;
    summary += `Timestamp: ${result.timestamp}\n\n`;
    summary += `🔑 Cookies Penting:\n`;

    let foundImportant = false;
    config.important.forEach(key => {
      const found = cookies.find(c => c.name === key || c.name.includes(key));
      if (found) {
        foundImportant = true;
        summary += `   • ${key}: ${found.value.substring(0, 40)}${found.value.length > 40 ? '...' : ''}\n`;
      }
    });

    if (!foundImportant) {
      summary += `   (Tidak ada cookies penting yang terdeteksi. Silakan pastikan Anda sudah login.)\n`;
    }

    summary += `\n📋 Full JSON sudah otomatis dicopy ke clipboard!\nSiap digunakan untuk otomatisasi headless.`;
    cookiesDiv.textContent = summary;

    console.log(`${config.name} Cookies Full JSON:`, result);

  } catch (err) {
    statusBadge.className = 'status-badge error';
    statusBadge.textContent = '❌ Gagal Ekstraksi';

    // Ambil info permissions aktif untuk diagnosa
    let activePerms = null;
    try {
      activePerms = await new Promise((resolve) => {
        chrome.permissions.getAll(resolve);
      });
    } catch (e) {
      console.warn('Gagal membaca permissions:', e);
    }

    let errorDetail = `Error: ${err.message}\n\n`;
    errorDetail += `=== DIAGNOSIS EKSTENSI ===\n`;
    errorDetail += `Platform: ${config.name}\n`;
    errorDetail += `Target Domain: ${cleanDomainPattern}\n`;
    if (activePerms) {
      errorDetail += `Izin API Aktif: ${JSON.stringify(activePerms.permissions || [])}\n`;
      errorDetail += `Host/Origins Aktif: ${JSON.stringify(activePerms.origins || [])}\n`;
    } else {
      errorDetail += `Izin API Aktif: Gagal mengambil data izin.\n`;
    }
    errorDetail += `Total Cookie Diakses di Browser: ${allCookies ? allCookies.length : 0}\n`;
    errorDetail += `=========================\n\n`;
    errorDetail += `Solusi Langkah demi Langkah:\n`;
    errorDetail += `1. Masuk ke chrome://extensions/\n`;
    errorDetail += `2. Klik tombol "Hapus" (Remove) pada kartu ekstensi TikTok & Grok Cookie Extractor.\n`;
    errorDetail += `3. Klik tombol "Load unpacked" di pojok kiri atas dan pilih kembali folder c:\\tiktok-extractor.\n`;
    errorDetail += `4. Segarkan (Refresh) halaman grok.com Anda, lalu buka kembali pop-up ekstensi dan klik Ambil Grok Cookies.`;
    
    cookiesDiv.textContent = errorDetail;
    console.error(err);
  }
});

// Run Init
init();