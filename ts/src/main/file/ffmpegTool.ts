// Optional ffmpeg for formats the built-in WAV / Ogg-Opus readers cannot decode
// (MP3, M4A/AAC, WebM/MKV, FLAC, AMR, …). Not bundled; on Windows it is downloaded only
// when the user presses the button, elsewhere the system ffmpeg on PATH is used.
// Port of src/App/FfmpegTool.cs. Decoding pipes raw PCM from stdout (no temp WAV).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { t } from '../../core/strings';
import { localDataDir } from '../paths';
import { fetchFile } from '../models/modelDownloader';
import { listZip, extractEntry } from './zip';

/** Pinned LGPL static win64 build from BtbN (no shared DLLs). */
export const DOWNLOAD_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip';
/** Expected archive size from the BtbN "latest" asset listing (Oct 2026). */
export const EXPECTED_ZIP_BYTES = 170_539_488;
/** Allow ±2% drift if BtbN rebuilds the same tag. */
export const ZIP_SIZE_TOLERANCE = Math.floor(EXPECTED_ZIP_BYTES / 50);
/** More than 3 hours of 16 kHz mono is refused. */
export const MAX_SAMPLES = 16000 * 60 * 60 * 3;

const isWin = () => process.platform === 'win32';
export const exeName = () => (isWin() ? 'ffmpeg.exe' : 'ffmpeg');
export const toolsDir = () => join(localDataDir(), 'tools');
export const installDir = () => join(toolsDir(), 'ffmpeg');
export const exePath = () => join(installDir(), exeName());

/** Download is offered only where the pinned build exists (Windows x64). */
export const canDownload = () => isWin();

export function find(pathEnv = process.env.PATH ?? ''): string | null {
  try {
    if (existsSync(exePath()) && statSync(exePath()).size > 1_000_000) return exePath();
  } catch {
    /* ignore */
  }
  for (const raw of pathEnv.split(delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const candidate = join(dir, exeName());
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* PATH may be odd */
    }
  }
  return null;
}

export const isInstalled = () => find() !== null;

export function statusLine(): string {
  const found = find();
  if (!found) {
    return canDownload()
      ? t(
          'ffmpeg нет. MP3, M4A, FLAC и WebM открываются и без него; ffmpeg нужен для AMR, WMA, MKV/MOV и файлов больше 400 МБ — кнопка ниже скачает LGPL-сборку BtbN (~170 МБ), в архив программы не входит.',
          'ffmpeg is missing. MP3, M4A, FLAC and WebM open without it; ffmpeg is needed for AMR, WMA, MKV/MOV and files over 400 MB — the button below downloads the BtbN LGPL build (~170 MB); it is not in the app archive.',
        )
      : t(
          'ffmpeg нет. MP3, M4A, FLAC и WebM открываются и без него; ffmpeg нужен для AMR, WMA, MKV/MOV и файлов больше 400 МБ — установите его пакетным менеджером (например, apt install ffmpeg).',
          'ffmpeg is missing. MP3, M4A, FLAC and WebM open without it; ffmpeg is needed for AMR, WMA, MKV/MOV and files over 400 MB — install it with your package manager (e.g. apt install ffmpeg).',
        );
  }
  return found === exePath() ? `ffmpeg: ${found}` : t(`ffmpeg в PATH: ${found}`, `ffmpeg on PATH: ${found}`);
}

/** Download the zip, check size, extract ffmpeg(.exe) and companion DLLs into installDir. */
export async function downloadAsync(
  progress: ((line: string) => void) | undefined,
  signal?: AbortSignal,
  url = DOWNLOAD_URL,
  expectedBytes = EXPECTED_ZIP_BYTES,
  tolerance = ZIP_SIZE_TOLERANCE,
): Promise<string> {
  mkdirSync(toolsDir(), { recursive: true });
  const zipPath = join(toolsDir(), 'ffmpeg-download.zip');
  const staging = join(toolsDir(), 'ffmpeg-staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    progress?.(t('Скачиваю ffmpeg…', 'Downloading ffmpeg…'));
    let lastMb = -8;
    await fetchFile(
      url,
      zipPath,
      expectedBytes,
      (got, total) => {
        if (Math.abs(total - expectedBytes) > tolerance) {
          throw new Error(`unexpected ffmpeg zip size ${total}, expected about ${expectedBytes}`);
        }
        const mb = Math.floor(got / (1024 * 1024));
        if (mb - lastMb >= 8) {
          lastMb = mb;
          progress?.(t(`Скачиваю ffmpeg… ${mb} МБ`, `Downloading ffmpeg… ${mb} MB`));
        }
      },
      signal,
    );
    const got = statSync(zipPath).size;
    if (Math.abs(got - expectedBytes) > tolerance) {
      throw new Error(`downloaded ffmpeg zip size ${got}, expected about ${expectedBytes}`);
    }

    progress?.(t('Распаковываю ffmpeg…', 'Extracting ffmpeg…'));
    if (signal?.aborted) throw new Error('aborted');
    const entries = listZip(zipPath);
    const exe = entries.find((e) => basename(e.name).toLowerCase() === exeName() && e.size > 1_000_000);
    if (!exe) throw new Error(`${exeName()} missing from the archive`);
    const exeFolder = exe.name.slice(0, exe.name.length - basename(exe.name).length);
    const staged = join(staging, exeName());
    extractEntry(zipPath, exe, staged);
    const dlls = entries.filter(
      (e) => e.name.startsWith(exeFolder) && !e.name.slice(exeFolder.length).includes('/') && /\.dll$/i.test(e.name),
    );
    for (const d of dlls) extractEntry(zipPath, d, join(staging, basename(d.name)));

    rmSync(installDir(), { recursive: true, force: true });
    mkdirSync(installDir(), { recursive: true });
    copyFileSync(staged, exePath());
    for (const d of dlls) copyFileSync(join(staging, basename(d.name)), join(installDir(), basename(d.name)));

    const code = await runQuiet(exePath(), ['-hide_banner', '-version'], signal);
    if (code !== 0) throw new Error('ffmpeg -version failed');
    progress?.(t(`ffmpeg готов: ${exePath()}`, `ffmpeg ready: ${exePath()}`));
    return exePath();
  } finally {
    rmSync(zipPath, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

function runQuiet(cmd: string, args: string[], signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, signal });
    p.on('error', reject);
    p.on('close', (code) => resolve(code ?? -1));
  });
}

/** Decode any ffmpeg-readable file to 16 kHz mono float32 via s16le on stdout. */
export function decodeTo16k(path: string, signal?: AbortSignal, ffmpeg = find()): Promise<Float32Array> {
  if (!ffmpeg) return Promise.reject(new Error('ffmpeg not found'));
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path,
    '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let err = '';
    let tooLarge = false;
    p.stdout.on('data', (b: Buffer) => {
      if (tooLarge) return;
      bytes += b.length;
      if (bytes / 2 > MAX_SAMPLES) {
        tooLarge = true;
        p.kill();
        return;
      }
      chunks.push(b);
    });
    p.stderr.on('data', (b: Buffer) => {
      if (err.length < 8192) err += b.toString('utf8');
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      if (tooLarge) return reject(new Error('decoded audio is too large'));
      if (code !== 0) return reject(new Error('ffmpeg failed: ' + trimErr(err)));
      const all = Buffer.concat(chunks, bytes - (bytes % 2));
      const out = new Float32Array(all.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = all.readInt16LE(i * 2) / 32768;
      resolve(out);
    });
  });
}

export function trimErr(err: string): string {
  const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.slice(-3).join(' | ') : '(no stderr)';
}
