import json
import os
import re
import subprocess
import sys
import textwrap
import tempfile

# ===================== KONFIGURASI =====================
KONTEN_JSON_PATH   = r"c:\tiktok_automation\konten_gemini.json"
WATERMARK_PATH     = r"c:\tiktok_automation\speedu.png"
OUTPUT_DIR         = r"c:\tiktok_automation\konten_final_overlay"
FONT_NAME          = "Arial"
FONT_SIZE          = 75           # Ukuran font sangat besar agar terlihat jelas
FADE_DURATION_MS   = 500         # Durasi fade in/out (milidetik)
TULISAN_DURATION   = 5           # Tiap tulisan tampil selama 5 detik
WATERMARK_SCALE    = 250         # Lebar watermark diperbesar
WATERMARK_MARGIN_TOP = 25        # Margin dari atas
MAX_CHARS_PER_LINE = 20          # Batas karakter per baris (dikurangi karena font super besar)
# ========================================================

def load_konten(json_path, nomor):
    """Load konten berdasarkan nomor dari JSON file."""
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    for item in data:
        if item.get("nomor") == nomor:
            return item
    return None

def seconds_to_ass_time(seconds):
    """Convert seconds to ASS subtitle timestamp format H:MM:SS.CS"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    cs = int((seconds % 1) * 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

def strip_emoji(text):
    """Hapus semua bentuk karakter emoji / simbol aneh agar murni teks."""
    # Pattern regex untuk cover Emoji & symbols
    emoji_pattern = re.compile(
        u"(\ud83d[\ude00-\ude4f])|"  # emoticons
        u"(\ud83c[\udf00-\uffff])|"  # symbols & pictographs (1 of 2)
        u"(\ud83d[\u0000-\uddff])|"  # symbols & pictographs (2 of 2)
        u"(\ud83d[\ude80-\udeff])|"  # transport & map symbols
        u"(\ud83c[\udde0-\uddff])|"  # flags (iOS)
        u"[\U00010000-\U0010ffff]|"
        u"[\u2600-\u2B55]|"          # Misc symbols (sun, moon, snow, dsb)
        u"[\u2300-\u23FF]"           # Misc technical (petir, dsb)
    )
    cleaned = emoji_pattern.sub(r'', text)
    # Bersihkan multiple spaces jika ada
    return ' '.join(cleaned.split()).strip()

def wrap_text(text, max_chars=MAX_CHARS_PER_LINE):
    """Pecah teks panjang menjadi beberapa baris."""
    lines = textwrap.wrap(text, width=max_chars)
    return lines

def generate_ass_subtitle(tulisan_list):
    """
    Generate file subtitle ASS dengan styling:
    - Teks hitam bold
    - Background box putih solid
    - Posisi di tengah-bawah layar (55% dari atas)
    - Efek fade in/out
    - Menggunakan resolusi referensi tetap 1080x1920 (libass auto-scale ke resolusi asli)
    """
    
    # Resolusi referensi tetap - libass menyesuaikan otomatis ke resolusi video asli
    ref_w, ref_h = 1080, 1920
    
    y_position = int(ref_h * 0.55)
    x_position = ref_w // 2
    
    ass_content = f"""[Script Info]
Title: Konten Overlay
ScriptType: v4.00+
PlayResX: {ref_w}
PlayResY: {ref_h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Overlay,{FONT_NAME},{FONT_SIZE},&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,25,0,5,30,30,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    
    for idx, tulisan in enumerate(tulisan_list):
        start_time = idx * TULISAN_DURATION
        end_time = start_time + TULISAN_DURATION
        
        start_ass = seconds_to_ass_time(start_time)
        end_ass = seconds_to_ass_time(end_time)
        
        # Bersihkan emoji lalu wrap text dan gabungkan dengan \N (newline ASS)
        clean_text = strip_emoji(tulisan)
        lines = wrap_text(clean_text)
        ass_text = "\\N".join(lines)
        
        # Tambahkan fade effect dan posisi
        # \fad(fade_in_ms, fade_out_ms) 
        # \pos(x,y) untuk posisi manual
        styled_text = f"{{\\fad({FADE_DURATION_MS},{FADE_DURATION_MS})\\pos({x_position},{y_position})}}{ass_text}"
        
        ass_content += f"Dialogue: 0,{start_ass},{end_ass},Overlay,,0,0,0,,{styled_text}\n"
    
    return ass_content

def process_video(video_path, konten_nomor, output_path=None):
    """Proses overlay tulisan + watermark pada video."""
    
    # Load konten dari JSON
    konten = load_konten(KONTEN_JSON_PATH, konten_nomor)
    if not konten:
        print(f"ERROR: Konten dengan nomor {konten_nomor} tidak ditemukan di {KONTEN_JSON_PATH}")
        return False
    
    topik = konten.get("topik", "Tanpa Topik")
    print(f"\nTopik: {topik}")
    print(f"Video: {video_path}")
    
    # Ambil 6 tulisan
    tulisan_list = []
    for i in range(1, 7):
        key = f"tulisan {i}"
        if key in konten:
            tulisan_list.append(konten[key])
    
    if not tulisan_list:
        print("ERROR: Tidak ada tulisan yang ditemukan di konten JSON.")
        return False
    
    print(f"Jumlah tulisan: {len(tulisan_list)}")
    for i, t in enumerate(tulisan_list):
        preview = t[:60].encode('ascii', 'replace').decode('ascii')
        print(f"  Tulisan {i+1}: {preview}...")
    
    # Buat output dir
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    if not output_path:
        base_name = os.path.splitext(os.path.basename(video_path))[0]
        output_path = os.path.join(OUTPUT_DIR, f"{base_name}_overlay.mp4")
    
    # Generate ASS subtitle file (resolusi referensi tetap 1080x1920, libass auto-scale)
    ass_content = generate_ass_subtitle(tulisan_list)
    
    # Tulis ke file sementara
    ass_file = os.path.join(OUTPUT_DIR, f"overlay_temp_{konten_nomor}.ass")
    with open(ass_file, "w", encoding="utf-8") as f:
        f.write(ass_content)
    print(f"File subtitle ASS dibuat: {ass_file}")
    
    # Escape path ASS untuk FFmpeg filter (Windows path perlu di-escape)
    ass_path_escaped = ass_file.replace("\\", "/").replace(":", "\\:")
    
    # Filter complex:
    # 1. Burn subtitle ASS ke video (ini sekaligus overlay teks + background box + fade)
    # 2. Scale watermark
    # 3. Overlay watermark di kiri atas
    # Watermark diletakkan di atas tengah: x = (video_width - wm_width) / 2
    filter_complex = (
        f"[0:v]ass='{ass_path_escaped}'[texted];"
        f"[1:v]scale={WATERMARK_SCALE}:-1[wm];"
        f"[texted][wm]overlay=(W-w)/2:{WATERMARK_MARGIN_TOP}"
    )
    
    # FFmpeg command
    # -crf 18 -preset slow = kualitas sangat tinggi, mendekati lossless
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", WATERMARK_PATH,
        "-filter_complex", filter_complex,
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "slow",
        "-c:a", "copy",
        "-map", "0:a?",
        output_path
    ]
    
    print(f"\nMemproses overlay pada video...")
    print(f"Output: {output_path}")
    print("(Proses ini membutuhkan waktu beberapa detik, mohon ditunggu...)")
    
    # Jalankan FFmpeg
    process = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW
    )
    
    if process.returncode != 0:
        print("\n[ERROR] FFmpeg gagal!")
        stderr = process.stderr.decode('utf-8', errors='ignore')
        lines = stderr.strip().split('\n')
        for line in lines[-30:]:
            print(f"  {line}")
        
        # Cleanup
        try:
            os.remove(ass_file)
        except:
            pass
        return False
    
    # Cleanup file ASS sementara
    try:
        os.remove(ass_file)
    except:
        pass
    
    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\n{'='*55}")
    print(f"  BERHASIL! Video overlay tersimpan.")
    print(f"  File  : {output_path}")
    print(f"  Ukuran: {file_size_mb:.1f} MB")
    print(f"{'='*55}")
    return True


def main():
    print("=" * 55)
    print("   VIDEO OVERLAY - Teks Konten + Watermark Speedu")
    print("=" * 55)
    
    # Input nomor konten
    try:
        nomor = int(input("\nMasukkan nomor konten dari JSON (contoh: 1): "))
    except ValueError:
        print("Input tidak valid.")
        return
    
    # Input path video
    video_path = input("Masukkan path video (contoh: konten_speedu_final\\konten1.mp4): ").strip()
    if not video_path:
        video_path = r"c:\tiktok_automation\konten_speedu_final\konten1.mp4"
        print(f"Menggunakan default: {video_path}")
    
    # Jika path relatif, jadikan absolut
    if not os.path.isabs(video_path):
        video_path = os.path.join(r"c:\tiktok_automation", video_path)
    
    video_path = os.path.normpath(video_path)
    
    if not os.path.exists(video_path):
        print(f"ERROR: File video tidak ditemukan: {video_path}")
        return
    
    process_video(video_path, nomor)


if __name__ == "__main__":
    main()
