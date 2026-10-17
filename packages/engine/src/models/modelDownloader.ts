// Speech-model download. Nothing runs until the user asks.
// Port of src/App/ModelDownloader.cs. Tests never hit the network.

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  closeSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SpeechModelKind } from '@chawo/core/speechModels';
import { localDataDir } from '../paths';
import { unpackTarGzFlat } from './tarGz';

export type DownloadFailure = 'network' | 'noSpace' | 'corrupt' | 'rejected';

export class ModelDownloadException extends Error {
  readonly kind: DownloadFailure;
  constructor(kind: DownloadFailure, message: string, cause?: unknown) {
    super(message);
    this.name = 'ModelDownloadException';
    this.kind = kind;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export const V3_ARCHIVE_URL =
  'https://github.com/moznoazachem/giga-pisar-cli/releases/latest/download/gigaam-v3-onnx-int8.tar.gz';

const LARGE_BASE = 'https://huggingface.co/istupakov/gigaam-multilingual-large-ctc-onnx/resolve/main/';

interface RemoteFile {
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export const LARGE_FILES: readonly RemoteFile[] = [
  {
    name: 'multilingual_large_ctc.onnx',
    url: LARGE_BASE + 'multilingual_large_ctc.onnx',
    sha256: '4a2d22279e90648262e1259e82982f1f1f7e2c4957e187c2b68459458c92fd5f',
    size: 909828,
  },
  {
    name: 'multilingual_large_ctc.onnx.data',
    url: LARGE_BASE + 'multilingual_large_ctc.onnx.data',
    sha256: '5a7bf60fd3883a707dda19862b58a9a30777bde3e439ff76b49580da1f18b1f1',
    size: 2343837696,
  },
  {
    name: 'multilingual_large_ctc.yaml',
    url: LARGE_BASE + 'multilingual_large_ctc.yaml',
    sha256: 'a76e9370be21c0e416d627b59262ae567cbcdd21e58458f58498ea42ce0685a0',
    size: 1180,
  },
  {
    name: 'multilingual_vocab.txt',
    url: LARGE_BASE + 'multilingual_vocab.txt',
    sha256: '4d130287892e1099fedfb3f93c4b4cf8a263151158801680b28977d1be4133f4',
    size: 393,
  },
];

export const V3_SHA256: Readonly<Record<string, string>> = {
  'v3_e2e_rnnt_encoder.onnx': 'dbea5c6158413e34b3707b99b65ec394c63cbd32da4164311f86dd65f86563d6',
  'v3_e2e_rnnt_decoder.onnx': 'a0f27fd86246d57cbe2c7138f3355591fd039e3e1015fd4ff2fd2d3d2d4d319d',
  'v3_e2e_rnnt_joint.onnx': '8bf573aca80d99ca4226aa0f9d43398998280ec505705955b5c6d92238b3e6d5',
  'v3_e2e_rnnt_tokenizer.model': '828c12c991019eef952a960661f25a92d6ad279591e2ea466b4aeddf1d20a18a',
};

const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const READ_BUFFER = 1 << 16;
const IDLE_TIMEOUT_MS = 120_000;
const USER_AGENT = 'ChawoVoiceAssistant/2.2.0';

export interface DownloadProgress {
  received: number;
  total: number;
  stage: string;
}

export type ProgressCallback = (p: DownloadProgress) => void;

export function approxBytes(kind: SpeechModelKind): number {
  return kind === 'v3_e2e_rnnt' ? 220 << 20 : LARGE_FILES.reduce((s, f) => s + f.size, 0);
}

export async function downloadAsync(
  kind: SpeechModelKind,
  targetDir: string,
  progress: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (kind === 'v3_e2e_rnnt') await downloadV3(targetDir, progress, signal);
  else await downloadLarge(targetDir, progress, signal);
}

async function downloadLarge(
  targetDir: string,
  progress: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  const need = approxBytes('multilingual_large_ctc') + (1 << 30);
  ensureSpace(need);
  const temp = targetDir + '.tmp';
  try {
    if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { recursive: true });
    const total = LARGE_FILES.reduce((s, f) => s + f.size, 0);
    let done = 0;
    for (const file of LARGE_FILES) {
      const dest = join(temp, file.name);
      await fetchFile(file.url, dest, file.size, (got, fileTotal) => {
        progress({ received: done + got, total: fileTotal > 0 ? total : total, stage: 'download' });
      }, signal);
      progress({ received: done, total, stage: 'verify' });
      verifySha(dest, file.sha256);
      done += file.size;
      progress({ received: done, total, stage: 'download' });
    }
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    renameSync(temp, targetDir);
    progress({ received: 1, total: 1, stage: 'done' });
  } catch (e) {
    rethrowDownload(e);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function downloadV3(
  targetDir: string,
  progress: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  ensureSpace(1 << 30);
  mkdirSync(localDataDir(), { recursive: true });
  const archive = join(localDataDir(), 'model.tar.gz.part');
  const temp = targetDir + '.tmp';
  try {
    await fetchFile(V3_ARCHIVE_URL, archive, -1, (got, total) => {
      progress({ received: got, total, stage: 'download' });
    }, signal);
    progress({ received: 0, total: 0, stage: 'unpack' });
    if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    await unpackTarGzFlat(archive, temp, { maxFileBytes: MAX_FILE_BYTES, signal });
    for (const [name, expected] of Object.entries(V3_SHA256)) {
      const path = join(temp, name);
      if (!existsSync(path)) throw new ModelDownloadException('corrupt', `missing ${name}`);
      verifySha(path, expected);
    }
    if (!existsSync(join(temp, 'v3_e2e_rnnt.yaml'))) {
      throw new ModelDownloadException('corrupt', 'missing model config');
    }
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    renameSync(temp, targetDir);
    progress({ received: 1, total: 1, stage: 'done' });
  } catch (e) {
    rethrowDownload(e);
  } finally {
    try {
      if (existsSync(archive)) rmSync(archive, { force: true });
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function rethrowDownload(e: unknown): never {
  if (e instanceof ModelDownloadException) throw e;
  if (e instanceof Error && e.name === 'AbortError') throw e;
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- an abort is passed on exactly as it came
  if (typeof e === 'object' && e && (e as { code?: string }).code === 'ABORT_ERR') throw e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOSPC|no space|only \d+ MB free/i.test(msg)) {
    throw new ModelDownloadException('noSpace', msg, e);
  }
  if (/checksum|corrupt|missing |too large|Invalid/i.test(msg)) {
    throw new ModelDownloadException('corrupt', msg, e);
  }
  throw new ModelDownloadException('network', msg, e);
}

/** Available free bytes on the volume holding localDataDir, or null if unknown. */
export function availableBytes(path?: string): number | null {
  const target = path ?? localDataDir();
  try {
    // Node 18.15+ / 20+: fs.statfs
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs') & {
      statfsSync?: (p: string) => { bavail: number | bigint; bsize: number | bigint };
    };
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(target);
      return Number(s.bavail) * Number(s.bsize);
    }
  } catch {
    /* parent may not exist yet */
  }
  try {
    mkdirSync(target, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs') & {
      statfsSync?: (p: string) => { bavail: number | bigint; bsize: number | bigint };
    };
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(target);
      return Number(s.bavail) * Number(s.bsize);
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function ensureSpace(bytes: number): void {
  const free = availableBytes();
  if (free === null) return;
  if (free < bytes) {
    throw new ModelDownloadException('noSpace', `only ${free >> 20} MB free`);
  }
}

export async function fetchFile(
  url: string,
  dest: string,
  expectedSize: number,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const idle = new AbortController();
  const onOuterAbort = () => idle.abort();
  if (signal) {
    if (signal.aborted) throw new ModelDownloadException('network', 'aborted');
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let idleTimer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS);
  };

  try {
    const res = await fetch(url, {
      signal: idle.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new ModelDownloadException('network', `HTTP ${res.status}`);
    }
    const cl = res.headers.get('content-length');
    let total = cl ? Number(cl) : expectedSize;
    if (!Number.isFinite(total) || total < 0) total = expectedSize > 0 ? expectedSize : 0;
    if (total > MAX_FILE_BYTES) {
      throw new ModelDownloadException('corrupt', `file too large: ${total}`);
    }
    if (!res.body) throw new ModelDownloadException('network', 'empty body');

    mkdirSync(dirname(dest), { recursive: true });
    const file = createWriteStream(dest);
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
    let received = 0;
    let lastReport = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bumpIdle();
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > MAX_FILE_BYTES) {
          throw new ModelDownloadException('corrupt', 'file too large');
        }
        if (!file.write(chunk)) {
          await new Promise<void>((r) => file.once('drain', r));
        }
        const now = Date.now();
        if (now - lastReport > 100) {
          onProgress(received, total);
          lastReport = now;
        }
      }
      await new Promise<void>((resolve, reject) => {
        file.end(() => resolve());
        file.on('error', reject);
      });
    } catch (e) {
      file.destroy();
      try {
        rmSync(dest, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    }
    if (total > 0 && received !== total) {
      throw new ModelDownloadException('network', `incomplete download: ${received} of ${total}`);
    }
    onProgress(received, total > 0 ? total : received);
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

export function verifySha(path: string, expected: string): void {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(READ_BUFFER);
    let n: number;
    while (true) {
      n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch for ${path.split(/[/\\]/).pop()}`);
  }
}

/** SHA-256 hex of a buffer (tests / helpers). */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Verify a buffer against expected hex (no file I/O). */
export function verifyShaBuffer(data: Buffer, expected: string, label = 'buffer'): void {
  const actual = sha256Hex(data);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch for ${label}`);
  }
}

/** Data that does not match what was expected (size cap, checksum, archive layout). Maps to 'corrupt'. */
export class InvalidDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDataError';
  }
}

/** SHA-256 of a file without blocking the main process on a multi-GB read. */
export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  const onAbort = () => stream.destroy(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw abortError();
  return hash.digest('hex');
}

/** Async verifySha; throws InvalidDataError("checksum mismatch for the <what>"). */
export async function verifyShaAsync(path: string, expected: string, what: string, signal?: AbortSignal): Promise<void> {
  const actual = await sha256File(path, signal);
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new InvalidDataError(`checksum mismatch for the ${what}`);
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export interface ResumableOptions {
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** No bytes for this long: the download is treated as stalled. C# DownloadIdleTimeout, 60 s for the Brain. */
  idleMs?: number;
  /** Hard cap when `expected` is 0 (custom GGUF). */
  maxBytes?: number;
  userAgent?: string;
}

/**
 * Downloads url into path, continuing from what is already there (HTTP Range). Port of LocalBrain.FetchAsync:
 * 416 on a resumed request means the file is complete; a server that ignores Range (200) restarts from zero;
 * a response larger than `expected` (or `maxBytes` when expected is 0) is refused. The .part file is kept on
 * network errors so the next attempt resumes.
 */
export async function fetchResumable(
  url: string,
  path: string,
  expected: number,
  onProgress: ((received: number, total: number) => void) | null,
  signal?: AbortSignal,
  opts: ResumableOptions = {},
): Promise<void> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const idleMs = opts.idleMs ?? 60_000;
  const cap = expected > 0 ? expected : (opts.maxBytes ?? MAX_FILE_BYTES);
  let have = existsSync(path) ? statSync(path).size : 0;
  if (have > cap) {
    rmSync(path, { force: true });
    have = 0;
  }
  if (signal?.aborted) throw abortError();

  const idle = new AbortController();
  let stalled = false;
  const onOuterAbort = () => idle.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  let idleTimer: NodeJS.Timeout | null = null;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      idle.abort();
    }, idleMs);
  };
  bumpIdle();

  const headers: Record<string, string> = { 'User-Agent': opts.userAgent ?? USER_AGENT };
  if (have > 0) headers.Range = `bytes=${have}-`;
  let file: ReturnType<typeof createWriteStream> | null = null;
  try {
    const res = await doFetch(url, { signal: idle.signal, headers, redirect: 'follow' });
    if (have > 0 && res.status === 416) {
      await res.body?.cancel().catch(() => undefined);
      return; // already complete
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new ModelDownloadException('network', `HTTP ${res.status}`);
    }
    if (have > 0 && res.status !== 206) have = 0; // server ignored Range
    const cl = res.headers.get('content-length');
    const len = cl != null && cl !== '' ? Number(cl) : NaN;
    const total = Number.isFinite(len) && len >= 0 ? have + len : expected;
    if (total > cap) {
      await res.body?.cancel().catch(() => undefined);
      throw new InvalidDataError(`${basename(path)} is larger than expected: ${total}`);
    }
    if (!res.body) throw new ModelDownloadException('network', 'empty body');

    mkdirSync(dirname(path), { recursive: true });
    const out = (file = createWriteStream(path, { flags: have > 0 ? 'a' : 'w' }));
    const failed = new Promise<never>((_, reject) => out.once('error', reject));
    failed.catch(() => undefined);
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
    let received = have;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      bumpIdle();
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (received > cap) throw new InvalidDataError('download larger than expected');
      if (!out.write(chunk)) await Promise.race([new Promise<void>((r) => out.once('drain', r)), failed]);
      const now = Date.now();
      if (onProgress && now - lastReport > 100) {
        onProgress(received, total);
        lastReport = now;
      }
    }
    await Promise.race([new Promise<void>((r) => out.end(() => r())), failed]);
    file = null;
    if (total > 0 && received !== total) {
      throw new ModelDownloadException('network', `incomplete download: ${received} of ${total}`);
    }
    if (expected === 0 && received < 1024) throw new ModelDownloadException('network', 'download too small to be a GGUF');
    onProgress?.(received, total > 0 ? total : received);
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (stalled && !(e instanceof ModelDownloadException) && !(e instanceof InvalidDataError)) {
      throw new ModelDownloadException('network', 'download stalled', e);
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onOuterAbort);
    if (file) {
      // Keep what arrived for the next Range request; a broken stream is just dropped.
      const f = file;
      if (f.destroyed || f.errored) f.destroy();
      else await new Promise<void>((r) => f.end(() => r()));
    }
  }
}
