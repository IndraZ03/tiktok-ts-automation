# Panduan Instalasi Project TikTok & Grok Automation

Dokumen ini berisi panduan lengkap untuk melakukan instalasi dan duplikasi project ini di komputer Windows lain agar dapat berjalan dengan lancar.

---

## 📋 Prasyarat Sistem (Prerequisites)

Sebelum memulai, pastikan komputer target memiliki:
1. **Windows 10 / 11** (Sangat disarankan karena script otomatisasi browser menggunakan fitur sistem Windows).
2. **Google Chrome** resmi (terinstall di direktori default). Playwright dikonfigurasi untuk menggunakan Google Chrome asli (`channel: 'chrome'`) guna meminimalisir deteksi bot.
3. **Koneksi Internet** yang stabil.

---

## 🛠️ Langkah-Langkah Instalasi

### 1. Install Node.js
Project ini menggunakan Node.js (versi 18.19.0+ atau versi 20+ direkomendasikan).
* Download dan jalankan installer Node.js dari [website resmi Node.js](https://nodejs.org/).
* Pastikan mencentang pilihan **"Add to PATH"** saat instalasi.
* Verifikasi instalasi melalui Command Prompt (CMD) / PowerShell:
  ```bash
  node -v
  npm -v
  ```

### 2. Copy Source Code & Hubungkan Project
* Pindahkan semua folder project ini ke direktori komputer baru (misal: `C:\tiktok-ts-automation`).

### 3. Install Dependensi Node.js
Buka Command Prompt atau PowerShell, arahkan ke direktori project (`C:\tiktok-ts-automation`), lalu jalankan perintah:
```bash
npm install
```
*Perintah ini akan membaca `package.json` dan menginstall seluruh package yang dibutuhkan seperti Express, Playwright, Execa, Multer, dan `ffmpeg-static`.*

### 4. Install Playwright Browser Binaries
Playwright membutuhkan komponen browser tambahan untuk mendukung scraping stealth. Jalankan perintah berikut di direktori project:
```bash
npx playwright install
```
Jika ingin menginstall Google Chrome khusus untuk Playwright (opsional, disarankan jika Chrome biasa belum terinstall):
```bash
npx playwright install chrome
```

### 5. Install `yt-dlp` (Penting untuk YT to TikTok Bot)
Script split video mengunduh video YouTube menggunakan tools CLI bernama `yt-dlp`. Anda harus menginstallnya secara global di Windows agar dapat dipanggil dari terminal.

#### Cara A: Menggunakan Windows Package Manager (`winget`) — **Sangat Direkomendasikan**
Buka PowerShell (sebagai Administrator), lalu ketik:
```powershell
winget install yt-dlp
```
*Tutup dan buka kembali terminal Anda agar PATH terupdate secara otomatis.*

#### Cara B: Instalasi Manual
1. Download file `yt-dlp.exe` dari release resmi di GitHub: [yt-dlp Releases](https://github.com/yt-dlp/yt-dlp/releases).
2. Buat folder baru khusus di komputer Anda, misalnya `C:\Program Files\yt-dlp\`.
3. Masukkan file `yt-dlp.exe` ke dalam folder tersebut.
4. Tambahkan folder tersebut ke Environment Variables PATH Windows:
   * Cari **"Edit the system environment variables"** di menu Windows Search.
   * Klik tombol **Environment Variables...**.
   * Di bagian *System variables*, cari variabel bernama **Path**, pilih lalu klik **Edit...**.
   * Klik **New** dan masukkan path foldernya (contoh: `C:\Program Files\yt-dlp\`).
   * Klik **OK** pada semua jendela.
5. Verifikasi di terminal baru dengan mengetik:
   ```bash
   yt-dlp --version
   ```

### 6. Install FFmpeg (Untuk Python Script)
* **Untuk Backend Node.js (`video-splitter.ts` / `video-merger.ts`):** Anda **tidak perlu** menginstall FFmpeg secara manual karena project ini sudah menggunakan package `ffmpeg-static` yang langsung mengunduh binary FFmpeg ke dalam `node_modules` secara otomatis.
* **Untuk Script Python (`video_overlay.py`):** Script python membutuhkan binary `ffmpeg` terinstall secara global di Windows PATH.

#### Cara Instalasi FFmpeg Global di Windows:
* **Menggunakan `winget` (Rekomendasi Cepat):**
  Buka PowerShell as Administrator, jalankan:
  ```powershell
  winget install Gyan.FFmpeg
  ```
  *(Restart terminal Anda setelah instalasi)*
* **Secara Manual:**
  1. Download build FFmpeg terbaru (pilih Essentials build .7z atau .zip) dari [Gyan.dev](https://www.gyan.dev/ffmpeg/builds/).
  2. Ekstrak file tersebut, lalu pindahkan foldernya ke lokasi aman (misalnya `C:\ffmpeg`).
  3. Tambahkan folder `C:\ffmpeg\bin` ke dalam Environment Variables **PATH** Windows (seperti cara instalasi manual `yt-dlp`).
  4. Verifikasi di terminal baru:
     ```bash
     ffmpeg -version
     ```

### 7. Install Python (Opsional — Hanya untuk Script `video_overlay.py`)
Jika Anda berencana menjalankan overlay video secara standalone menggunakan python:
1. Install Python 3.10+ melalui Microsoft Store atau via winget:
   ```powershell
   winget install Python.Python.3.11
   ```
2. Pastikan pilihan **"Add python.exe to PATH"** dicentang saat instalasi.
3. Script `video_overlay.py` hanya menggunakan library bawaan Python (`json`, `os`, `re`, `subprocess`, `sys`, `textwrap`, `tempfile`), jadi tidak ada package `pip` eksternal tambahan yang harus diinstall.

---

## 🚀 Cara Menjalankan Aplikasi

Setelah semua langkah di atas selesai, Anda siap menjalankan aplikasi web otomasi:

1. Buka terminal (CMD / PowerShell) di folder project.
2. Jalankan perintah untuk memulai server:
   ```bash
   npm start
   ```
3. Buka browser dan akses dashboard web di:
   👉 **[http://localhost:5000](http://localhost:5000)**

Dari web dashboard ini, Anda dapat mengakses fitur-fitur berikut:
* **State Manager (Dashboard Utama):** Mengelola sesi cookies login agar tidak perlu login ulang.
* **TikTok Auto Uploader:** [http://localhost:5000/tiktok](http://localhost:5000/tiktok)
* **Grok Imagine Generator:** [http://localhost:5000/grok](http://localhost:5000/grok)
* **YT to TikTok Bot:** [http://localhost:5000/ytbot](http://localhost:5000/ytbot)
* **Video Merger:** [http://localhost:5000/merge](http://localhost:5000/merge)
* **YouTube Splitter:** [http://localhost:5000/splitter](http://localhost:5000/splitter)

---

## 📂 Struktur Folder Hasil Gitignore

Beberapa folder telah dimasukkan ke dalam `.gitignore` agar file video berukuran besar dan sesi login sensitif tidak terunggah ke repositori Git:
* `grok-states/` & `tiktok-states/` (Menyimpan session cookies login akun X/Grok dan TikTok Anda).
* `merged-videos/` (Folder output penggabungan video).
* `ytbot-videos/` (Folder output download dan hasil potongan bot YouTube).
* `vid-dummy/` (Folder video dummy).
* `node_modules/` & `_tmp_uploads/` (Folder package NPM dan file temporary upload).

*Catatan: Saat aplikasi pertama kali dijalankan di komputer baru, folder-folder di atas akan **dibuat secara otomatis** oleh sistem jika belum ada.*
