// vidapure.cjs — bersihkan seluruh referensi grok dari public/vidabot.html agar pure vidabot
const fs = require('fs');
const p = 'C:/tiktok-ts-automation/public/vidabot.html';
let h = fs.readFileSync(p, 'utf8');
const b = h;

function rm(re, rep) { h = h.replace(re, rep); }

// 1) Hapus kolom "Grok States Column" di tab Sesi (endpoint & teks grok)
rm(/<!-- Grok States Column -->[\s\S]*?\n          <\/div>\n        <\/div>\n      <\/div>/, '');

// 2) Tab Sesi jadi satu kolom (TikTok saja)
rm(/<div class="grid grid-cols-1 lg:grid-cols-2 gap-8">\n          <!-- TikTok States Column -->/, '<div class="grid grid-cols-1 gap-8">\n          <!-- TikTok States Column -->');

// 3) Hapus dropdown "Grok State (Session)" di kartu konfigurasi
rm(/\n\s*<div>\n\s*<label[^>]*>Grok State \(Session\)<\/label>\n\s*<select id="grokState-\$\{fn\}"[\s\S]*?<\/select>\n\s*<\/div>\n/, '\n');

// 4) Hapus baris grokStateOpts
rm(/\n\s*const grokStateOpts = grokStates\.map[\s\S]*?\n/, '\n');

// 5) Default config: hapus field grokState
rm(/grokState: '', promptFile: ''/, "promptFile: ''");

// 6) saveConfig: hapus ambil grokState
rm(/\n\s*grokState: document\.getElementById\(`grokState-\$\{fn\}`\)\?\.value \|\| '',\n/, '\n');

// 7) Hapus deklarasi grokStates
rm(/\n\s*\/\/ Loaded lists from Grok endpoints\n\s*let grokStates = \[\];\s*\/\/ \[\{filename, name, expiry\}\]\n/, '\n');

// 8) preloadOptions: hapus fetch platform=grok + perbaiki log
rm(/const resGrok = await fetch\('\/api\/states\?platform=grok'\);\n\s*grokStates = await resGrok\.json\(\);\n?\s*/, '');
rm(/\$\{grokStates\.length\} Grok State, /, '');

// 9) Endpoint aset grok -> vidabot
rm(/\/api\/grok\//g, '/api/vidabot/');

// 10) switchTab: jangan load state grok
rm(/\n\s*loadStatesTab\('grok'\);\n/, '\n');

// 11) Hapus container rate limit
rm(/\n\s*<div id="grok-rate-limit-container" class="mb-8 hidden"><\/div>\n/, '\n');

// 12) Hapus fungsi renderRateLimits & clearRateLimit
let rlStart = h.indexOf('//  RATE LIMIT DISPLAY RENDER');
if (rlStart >= 0) {
  rlStart = h.lastIndexOf('\n', rlStart - 1);
  const rlEnd = h.indexOf('//  UPDATE 3-SEGMENT PROGRESS UI');
  if (rlEnd > rlStart) h = h.slice(0, rlStart) + '\n' + h.slice(rlEnd);
}

// 13) Hapus pemanggilan renderRateLimits
rm(/\n\s*if \(prog\.rateLimits\) renderRateLimits\(prog\.rateLimits\);\n/, '\n');
rm(/\n\s*if \(data\.rateLimits\) renderRateLimits\(data\.rateLimits\);\n/, '\n');

// 14) Hapus blok "Grok Rate Limit Wait" di renderQueue
rm(/if \(currentWaitInfo\) \{[\s\S]*?\n      \}\n/, '\n');

// 15) platform 'grok' di loadStatesTab -> selalu gradient-btn
rm(/const btnTheme = platform === 'grok' \? 'gradient-btn-blue' : 'gradient-btn';/, "const btnTheme = 'gradient-btn';");

// 16) Teks branding
rm(/Grok to TikTok Bot/g, 'Vida to TikTok Bot');
rm(/Grok AI/g, 'Vidabot AI');
rm(/Grok Generate/g, 'Vidabot Generate');
rm(/Generator Grok AI/g, 'Generator Vidabot');
rm(/Grok premium/g, 'Vidabot premium');
rm(/Prompt Grok/g, 'Prompt Vidabot');
rm(/Manajemen Prompt Grok/g, 'Manajemen Prompt Vidabot');
rm(/prompt Grok/g, 'prompt Vidabot');

// 17) Hapus link nav Grokbot V2 & Grok Imagine
rm(/\n\s*<a href="\/grokbotv2"[\s\S]*?\n\s*<\/a>\n/, '\n');
rm(/\n\s*<a href="\/grok"[\s\S]*?\n\s*<\/a>\n/, '\n');

fs.writeFileSync(p, h);
console.log('changed:', b !== h, '| chars:', h.length);