import { execa } from 'execa';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import os from 'os';
function ensureFfmpegPath() {
    if (!ffmpegPath) {
        throw new Error('ffmpeg-static tidak menemukan binary ffmpeg.');
    }
    return ffmpegPath;
}
function escapeConcatPath(filePath) {
    return path.resolve(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''");
}
export async function mergeVideosCopy(videoPaths, outputPath, options = {}) {
    if (!Array.isArray(videoPaths) || videoPaths.length < 2) {
        throw new Error('Minimal 2 video diperlukan untuk merge.');
    }
    for (const videoPath of videoPaths) {
        const stat = fs.existsSync(videoPath) ? fs.statSync(videoPath) : null;
        if (!stat?.isFile()) {
            throw new Error(`File video tidak ditemukan: ${videoPath}`);
        }
    }
    const resolvedOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    const tempRoot = options.tempDir || os.tmpdir();
    fs.mkdirSync(tempRoot, { recursive: true });
    const listPath = path.join(tempRoot, `ffmpeg-concat-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const concatList = videoPaths
        .map(videoPath => `file '${escapeConcatPath(videoPath)}'`)
        .join('\n');
    fs.writeFileSync(listPath, concatList, 'utf-8');
    try {
        await execa(ensureFfmpegPath(), [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            listPath,
            '-c',
            'copy',
            '-y',
            resolvedOutput,
        ], { windowsHide: true });
        return {
            outputPath: resolvedOutput,
            inputCount: videoPaths.length,
            audioReplaced: false,
        };
    }
    finally {
        try {
            fs.unlinkSync(listPath);
        }
        catch {
            // Temporary concat list cleanup failure should not hide the merge result.
        }
    }
}
export async function replaceVideoAudio(videoPath, audioPath, outputPath) {
    const videoStat = fs.existsSync(videoPath) ? fs.statSync(videoPath) : null;
    if (!videoStat?.isFile()) {
        throw new Error(`File video tidak ditemukan: ${videoPath}`);
    }
    const audioStat = fs.existsSync(audioPath) ? fs.statSync(audioPath) : null;
    if (!audioStat?.isFile()) {
        throw new Error(`File audio tidak ditemukan: ${audioPath}`);
    }
    const resolvedOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    await execa(ensureFfmpegPath(), [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        path.resolve(videoPath),
        '-i',
        path.resolve(audioPath),
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        resolvedOutput,
    ], { windowsHide: true });
    return { outputPath: resolvedOutput };
}
export async function mergeVideosCopyWithOptionalAudio(videoPaths, outputPath, audioPath, options = {}) {
    if (!audioPath) {
        return mergeVideosCopy(videoPaths, outputPath, options);
    }
    const resolvedOutput = path.resolve(outputPath);
    const tempRoot = options.tempDir || os.tmpdir();
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempMergedPath = path.join(tempRoot, `merged-video-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
    try {
        const merged = await mergeVideosCopy(videoPaths, tempMergedPath, options);
        await replaceVideoAudio(tempMergedPath, audioPath, resolvedOutput);
        return {
            outputPath: resolvedOutput,
            inputCount: merged.inputCount,
            audioReplaced: true,
        };
    }
    finally {
        try {
            fs.unlinkSync(tempMergedPath);
        }
        catch {
            // Temporary merged video cleanup failure should not hide the final result.
        }
    }
}
