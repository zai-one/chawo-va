// Compressed audio (MP3, AAC/M4A, FLAC, Vorbis, Opus-in-WebM, float/24-bit WAV) without ffmpeg:
// a hidden, sandboxed renderer runs WebAudio decodeAudioData at 16 kHz and sends mono back.
// This replaces Windows Media Foundation from the WPF app and works the same on Linux.
// The file is read here and handed over as bytes; the hidden page has no file or network access.

import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { downmixTo16k, type PlatformDecoder } from './file/fileTranscript';
import * as Log from './log';

/** Above this the bytes are not copied over IPC; ffmpeg (streaming) takes the file instead. */
export const MAX_CHROMIUM_BYTES = 400_000_000;
/** Hidden window is closed after this long without work, so its decode buffers are freed. */
const IDLE_MS = 60_000;

type Pending = { resolve: (s: Float32Array) => void; reject: (e: Error) => void };

let host: BrowserWindow | null = null;
let ready: Promise<BrowserWindow> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(why: string): void {
  for (const p of pending.values()) p.reject(new Error(why));
  pending.clear();
}

function closeHost(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const w = host;
  host = null;
  ready = null;
  if (w && !w.isDestroyed()) w.destroy();
}

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) closeHost();
    else armIdle();
  }, IDLE_MS);
}

function onDecoded(_e: IpcMainEvent, id: number, ok: boolean, data: Float32Array | string, rate: number): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (!ok) {
    p.reject(new Error(String(data)));
    return;
  }
  try {
    p.resolve(downmixTo16k([data as Float32Array], rate));
  } catch (err) {
    p.reject(err as Error);
  }
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  ipcMain.on('decoder:result', onDecoded);
}

function ensureHost(): Promise<BrowserWindow> {
  if (ready) return ready;
  wire();
  const w = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, 'decoderPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  host = w;
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.on('render-process-gone', (_e, d) => {
    Log.write(`file decoder renderer gone: ${d.reason}`);
    failAll(`decoder process ended (${d.reason})`);
    closeHost();
  });
  ready = w
    .loadFile(join(__dirname, '..', 'renderer', 'decoder.html'))
    .then(() => w)
    .catch((e) => {
      closeHost();
      throw e;
    });
  return ready;
}

/** Decode one file in the hidden renderer. Rejects on unsupported format, abort, or crash. */
export const chromiumDecode: PlatformDecoder = async (path, signal) => {
  const size = (await stat(path)).size;
  if (size > MAX_CHROMIUM_BYTES) throw new Error('file is large; using ffmpeg');
  const bytes = await readFile(path);
  if (signal?.aborted) throw new Error('aborted');
  const w = await ensureHost();
  const id = nextId++;
  const result = new Promise<Float32Array>((resolve, reject) => pending.set(id, { resolve, reject }));
  const onAbort = () => {
    if (!pending.has(id)) return;
    pending.get(id)!.reject(new Error('aborted'));
    pending.delete(id);
    // decodeAudioData cannot be cancelled; drop the whole renderer so it stops using CPU.
    if (pending.size === 0) closeHost();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (idleTimer) clearTimeout(idleTimer);
  try {
    w.webContents.send('decoder:decode', id, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return await result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    armIdle();
  }
};

/** For app quit and tests. */
export function disposeChromiumDecoder(): void {
  failAll('decoder closed');
  closeHost();
}
