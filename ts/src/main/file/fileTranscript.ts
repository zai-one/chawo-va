// A long dialogue file becomes a .txt beside it. The path is read in place.
// Decode order: 16-bit PCM WAV / Ogg-Opus → platform decoder hook (Chromium WebAudio in
// Electron, replacing Windows Media Foundation) → optional ffmpeg.
// Nothing is uploaded, and no model is downloaded here. Port of src/App/FileTranscript.cs.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { readWav, resample } from '../../core/audio';
import { decodeTo16kMono } from '../../core/oggOpus';
import { t } from '../../core/strings';
import * as Log from '../log';
import * as Ffmpeg from './ffmpegTool';

/** About 1.7 GB: two hours of 44.1 kHz stereo 16-bit, with room. Larger files are refused. */
export const MAX_BYTES = 1_800_000_000;

/** Extensions the picker lists. Decode may still need ffmpeg for some of them. */
export const EXTENSIONS: readonly string[] = [
  '.wav', '.wave',
  '.ogg', '.opus',
  '.mp3',
  '.m4a', '.aac', '.mp4', '.m4v',
  '.mov', '.mkv', '.webm', '.3gp', '.3g2',
  '.flac',
  '.wma',
  '.amr',
];

/** Electron dialog filters (replaces the WPF OpenFilter string). */
export const OPEN_FILTERS = [
  { name: 'Audio', extensions: EXTENSIONS.map((e) => e.slice(1)) },
  { name: 'WAV', extensions: ['wav', 'wave'] },
  { name: 'All', extensions: ['*'] },
];

/**
 * Optional decoder for compressed formats (MP3, AAC, …), e.g. a hidden renderer running
 * AudioContext.decodeAudioData. Returns 16 kHz mono or throws.
 */
export type PlatformDecoder = (path: string, signal?: AbortSignal) => Promise<Float32Array>;

let platformDecoder: PlatformDecoder | null = null;
export function setPlatformDecoder(d: PlatformDecoder | null): void {
  platformDecoder = d;
}

/** Same folder, same base name, extension .txt. talk.wav -> talk.txt. */
export function outputPath(source: string): string {
  const full = resolve(source);
  const dir = dirname(full) || process.cwd();
  let name = basename(full, extname(full));
  if (name.length === 0) name = 'transcript';
  return join(dir, name + '.txt');
}

export function hasSupportedExtension(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return EXTENSIONS.includes(ext);
}

export function collectFromFolder(folder: string): string[] {
  try {
    if (!statSync(folder).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(folder, { withFileTypes: true })
    .filter((d) => d.isFile() && hasSupportedExtension(d.name))
    .map((d) => join(folder, d.name))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export const isWav = (d: Uint8Array) =>
  d.length >= 12 && d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 &&
  d[8] === 0x57 && d[9] === 0x41 && d[10] === 0x56 && d[11] === 0x45;

export const isOgg = (d: Uint8Array) =>
  d.length >= 4 && d[0] === 0x4f && d[1] === 0x67 && d[2] === 0x67 && d[3] === 0x53;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

/** 16 kHz mono float. Tries native WAV/Ogg, then the platform decoder, then ffmpeg if present. */
export async function load16k(path: string, signal?: AbortSignal): Promise<Float32Array> {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const size = statSync(path).size;
  if (size > MAX_BYTES) throw new Error('file is too large');

  // Fast path: our own WAV (16-bit PCM) and Ogg/Opus readers.
  throwIfAborted(signal);
  const head = Buffer.alloc(Math.min(64, size));
  const fd = openSync(path, 'r');
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (isWav(head) || isOgg(head)) {
    try {
      // Full read only when the header matches — keeps big unsupported files from filling RAM twice.
      const audio = readFileSync(path);
      throwIfAborted(signal);
      return await decodeNative(audio, path);
    } catch (e) {
      if (signal?.aborted) throw e;
      // Fall through: e.g. WAV float/24-bit, or Ogg that is not Opus.
    }
  }

  throwIfAborted(signal);
  let platformError: Error | null = null;
  if (platformDecoder) {
    try {
      return await platformDecoder(path, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      platformError = e as Error;
      Log.write(`file platform decode failed (${path}): ${platformError.name}: ${platformError.message}`);
    }
  }

  throwIfAborted(signal);
  if (Ffmpeg.find()) {
    try {
      return await Ffmpeg.decodeTo16k(path, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(
        'could not decode with the built-in decoder or ffmpeg: ' +
          (platformError?.message ?? '') + ' / ' + (e as Error).message,
      );
    }
  }

  const hint = t(
    ' Для AMR, WMA, MKV/MOV и файлов больше 400 МБ нужен ffmpeg (см. страницу «Расшифровка файла»).',
    ' AMR, WMA, MKV/MOV and files over 400 MB need ffmpeg (see the File transcription page).',
  );
  throw new Error((platformError?.message ?? 'unsupported audio format') + hint);
}

/** 16 kHz mono from a buffer. WAV must be 16-bit PCM. Ogg must be Opus. */
export function decode16k(audio: Uint8Array, label: string): Promise<Float32Array> {
  if (isWav(audio) || isOgg(audio)) return decodeNative(audio, label);
  return Promise.reject(new Error('need a wav or ogg/opus buffer'));
}

async function decodeNative(audio: Uint8Array, label: string): Promise<Float32Array> {
  if (isWav(audio)) {
    let { samples, rate } = readWav(audio, label);
    if (rate !== 16000) samples = resample(samples, rate, 16000);
    return samples;
  }
  if (isOgg(audio)) return decodeTo16kMono(audio);
  throw new Error('need a wav or ogg/opus file');
}

/** Interleaved or planar channels → mono 16 kHz (shared by platform decoders). */
export function downmixTo16k(channels: Float32Array[], rate: number): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  let mono: Float32Array;
  if (channels.length === 1) mono = channels[0];
  else {
    const n = Math.min(...channels.map((c) => c.length));
    mono = new Float32Array(n);
    const k = 1 / channels.length;
    for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] * k;
  }
  if (rate !== 16000) mono = resample(mono, rate, 16000);
  if (mono.length > Ffmpeg.MAX_SAMPLES) throw new Error('decoded audio is too large');
  return mono;
}
