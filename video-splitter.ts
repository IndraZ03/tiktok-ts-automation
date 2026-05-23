import { execa } from 'execa';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';

export type SplitProgressStage = 'metadata' | 'download' | 'split' | 'cleanup' | 'done';

export interface SplitProgressEvent {
  stage: SplitProgressStage;
  message: string;
  percent?: number;
  part?: number;
  totalParts?: number;
}

export interface SplitAndProcessVideoOptions {
  youtubeUrl: string;
  outputDir: string;
  tempDir?: string;
  segmentDuration?: number;
  watermarkText?: string;
  onProgress?: (event: SplitProgressEvent) => void;
}

export interface SplitAndProcessVideoResult {
  title: string;
  duration: number;
  totalParts: number;
  outputDir: string;
  outputFiles: string[];
  downloadedVideoDeleted: boolean;
}

interface YoutubeMetadata {
  title: string;
  duration: number;
}

function ensureFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static tidak menemukan binary ffmpeg.');
  }
  return ffmpegPath;
}

function sanitizeFilename(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'youtube-video';
}

function escapeDrawtext(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

function ffmpegFontPath(): string {
  const windowsArial = 'C:\\Windows\\Fonts\\arial.ttf';
  if (fs.existsSync(windowsArial)) {
    return windowsArial.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  }

  return '';
}

function progressBar(percent: number, width = 28): string {
  const safePercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((safePercent / 100) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${safePercent.toFixed(1)}%`;
}

function readableOverlayTitle(title: string): string {
  const normalizedTitle = title.replace(/\s+/g, ' ').trim();
  const maxLen = 40; // Truncate to 40 characters if title is long like in video_overlay.py
  return normalizedTitle.length > maxLen ? `${normalizedTitle.slice(0, maxLen - 3)}...` : normalizedTitle;
}

function centerTextFontSize(text: string): number {
  return Math.max(34, Math.min(54, Math.floor(1120 / Math.max(text.length, 1))));
}

function emitProgress(
  onProgress: SplitAndProcessVideoOptions['onProgress'],
  event: SplitProgressEvent
): void {
  const percentSuffix = typeof event.percent === 'number' ? ` ${progressBar(event.percent)}` : '';
  console.log(`[SPLITTER] ${event.message}${percentSuffix}`);
  onProgress?.(event);
}

async function getYoutubeMetadata(youtubeUrl: string): Promise<YoutubeMetadata> {
  const { stdout } = await execa('yt-dlp', [
    '--dump-json',
    '--no-playlist',
    youtubeUrl,
  ], { windowsHide: true });

  const metadata = JSON.parse(stdout);
  const duration = Number(metadata.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Durasi video YouTube tidak dapat dibaca.');
  }

  return {
    title: String(metadata.title || 'youtube-video'),
    duration,
  };
}

async function downloadYoutubeVideo(
  youtubeUrl: string,
  outputPath: string,
  onProgress?: SplitAndProcessVideoOptions['onProgress']
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const ffmpegDir = path.dirname(ensureFfmpegPath());
  
  // Bulletproof the environment PATH so that yt-dlp can always locate ffmpeg.exe and other dependencies
  const env = {
    ...process.env,
    PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`
  };

  const subprocess = execa('yt-dlp', [
    '--newline',
    '--no-playlist',
    '--ffmpeg-location',
    ffmpegDir,
    '-f',
    'bv*[vcodec^=avc]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '-o',
    outputPath,
    youtubeUrl,
  ], {
    all: true,
    buffer: false,
    windowsHide: true,
    env,
  });

  if (subprocess.all) {
    subprocess.all.setEncoding('utf8');
    subprocess.all.on('data', chunk => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const match = line.match(/\[download]\s+(\d+(?:\.\d+)?)%/);
        if (match) {
          const percent = Number(match[1]);
          emitProgress(onProgress, {
            stage: 'download',
            message: `Download video YouTube ${progressBar(percent)}`,
            percent,
          });
        }
      }
    });
  }

  await subprocess;
}

async function splitPart(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
  title: string,
  part: number,
  totalParts: number,
  watermarkText: string,
  onProgress?: SplitAndProcessVideoOptions['onProgress']
): Promise<void> {
  const fontPath = ffmpegFontPath();
  const fontOption = fontPath ? `:fontfile='${fontPath}'` : '';
  const centerText = `Part ${part}/${totalParts} - ${readableOverlayTitle(title)}`;
  const centerFontSize = centerTextFontSize(centerText);
  // Periksa apakah file logo.png ada di folder project
  const logoPath = path.resolve('logo.png');
  const hasLogo = fs.existsSync(logoPath);

  let ffmpegArgs: string[] = [
    '-hide_banner',
    '-nostats',
    '-ss',
    String(startSeconds),
    '-i',
    inputPath,
  ];

  if (hasLogo) {
    ffmpegArgs.push('-i', logoPath);
  }

  ffmpegArgs.push('-t', String(durationSeconds));

  if (hasLogo) {
    // scale=1080:1920:force_original_aspect_ratio=decrease, pad=1080:1920 to keep standard vertical container
    // Teks diposisikan di area bawah (bottom black bar) bukan di tengah (y=h-250)
    // Logo scaled to 250px width and placed at top center (x=(W-w)/2, y=50) like in video_overlay.py
    const filterComplex = [
      `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[v_padded]`,
      `[v_padded]drawtext=text='${escapeDrawtext(centerText)}'${fontOption}:x=(w-text_w)/2:y=h-250:fontsize=${centerFontSize}:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=24[v_texted]`,
      `[1:v]scale=250:-1[logo_scaled]`,
      `[v_texted][logo_scaled]overlay=36:36[v_out]`
    ].join(';');

    ffmpegArgs.push(
      '-filter_complex', filterComplex,
      '-map', '[v_out]',
      '-map', '0:a?'
    );
  } else {
    // Fallback jika tidak ada logo.png
    // Watermark teks di kiri atas, judul di area bawah (y=h-250)
    const filter = [
      'scale=1080:1920:force_original_aspect_ratio=decrease',
      'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
      `drawtext=text='${escapeDrawtext(watermarkText)}'${fontOption}:x=36:y=36:fontsize=38:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=16`,
      `drawtext=text='${escapeDrawtext(centerText)}'${fontOption}:x=(w-text_w)/2:y=h-250:fontsize=${centerFontSize}:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=24`,
    ].join(',');

    ffmpegArgs.push('-vf', filter);
  }

  ffmpegArgs.push(
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-y',
    outputPath
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const subprocess = execa(ensureFfmpegPath(), ffmpegArgs, {
    stderr: 'pipe',
    stdout: 'ignore',
    buffer: false,
    windowsHide: true,
  });

  if (subprocess.stderr) {
    subprocess.stderr.setEncoding('utf8');
    subprocess.stderr.on('data', chunk => {
      const lines = String(chunk).split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)/);
        if (!match) continue;

        const processedSeconds = Number(match[1]) / 1_000_000;
        const percent = Math.min(100, (processedSeconds / durationSeconds) * 100);
        emitProgress(onProgress, {
          stage: 'split',
          message: `Split part ${part}/${totalParts} ${progressBar(percent)}`,
          percent,
          part,
          totalParts,
        });
      }
    });
  }

  await subprocess;
}

/**
 * Download video dari link YouTube lalu membaginya menjadi beberapa video vertikal 9:16.
 * Parameter utama: youtubeUrl sebagai sumber, outputDir untuk hasil, tempDir opsional untuk file download,
 * segmentDuration opsional dalam detik (default 180), watermarkText opsional, dan onProgress untuk progress real-time.
 * Mengembalikan metadata video, jumlah part, daftar file output, dan status penghapusan file video asli hasil download.
 */
export async function splitAndProcessVideo(
  options: SplitAndProcessVideoOptions
): Promise<SplitAndProcessVideoResult> {
  const segmentDuration = options.segmentDuration || 180;
  if (!options.youtubeUrl) {
    throw new Error('youtubeUrl wajib diisi.');
  }

  if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) {
    throw new Error('segmentDuration harus berupa angka positif.');
  }

  const outputDir = path.resolve(options.outputDir);
  const tempDir = path.resolve(options.tempDir || path.join(outputDir, '_source'));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  emitProgress(options.onProgress, {
    stage: 'metadata',
    message: 'Membaca metadata YouTube',
  });

  const metadata = await getYoutubeMetadata(options.youtubeUrl);
  const safeTitle = sanitizeFilename(metadata.title);
  const totalParts = Math.ceil(metadata.duration / segmentDuration);
  const downloadedPath = path.join(tempDir, `${safeTitle}-${Date.now()}.mp4`);
  const outputFiles: string[] = [];
  let downloadedVideoDeleted = false;

  try {
    await downloadYoutubeVideo(options.youtubeUrl, downloadedPath, options.onProgress);

    for (let index = 0; index < totalParts; index += 1) {
      const part = index + 1;
      const startSeconds = index * segmentDuration;
      const partDuration = Math.min(segmentDuration, metadata.duration - startSeconds);
      const outputPath = path.join(outputDir, `${safeTitle}-part-${String(part).padStart(2, '0')}-of-${String(totalParts).padStart(2, '0')}.mp4`);

      emitProgress(options.onProgress, {
        stage: 'split',
        message: `Mulai split part ${part}/${totalParts}`,
        percent: 0,
        part,
        totalParts,
      });

      await splitPart(
        downloadedPath,
        outputPath,
        startSeconds,
        partDuration,
        metadata.title,
        part,
        totalParts,
        options.watermarkText || 'TikTok Automation',
        options.onProgress
      );

      outputFiles.push(outputPath);
    }

    fs.unlinkSync(downloadedPath);
    downloadedVideoDeleted = true;
    emitProgress(options.onProgress, {
      stage: 'cleanup',
      message: 'Video asli hasil download sudah dihapus',
      percent: 100,
    });

    emitProgress(options.onProgress, {
      stage: 'done',
      message: `Split selesai: ${outputFiles.length} file dibuat`,
      percent: 100,
    });

    return {
      title: metadata.title,
      duration: metadata.duration,
      totalParts,
      outputDir,
      outputFiles,
      downloadedVideoDeleted,
    };
  } catch (error) {
    if (fs.existsSync(downloadedPath) && outputFiles.length === totalParts) {
      try {
        fs.unlinkSync(downloadedPath);
        downloadedVideoDeleted = true;
      } catch {
        downloadedVideoDeleted = false;
      }
    }

    throw error;
  }
}
