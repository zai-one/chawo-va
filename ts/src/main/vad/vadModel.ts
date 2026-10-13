// Silero VAD model on disk and in memory. The 2 MB ONNX file lives next to the speech models
// (%LOCALAPPDATA%\ChawoVoiceAssistant\models\silero-vad\silero_vad.onnx, or CHAWO_MODEL_DIR). It is
// fetched only on a user action (the «Распознавание» button, or together with a speech model the user
// asked to download), from the official snakers4/silero-vad repository at a pinned tag, and checked
// against its SHA-256. Loading is lazy; any failure means the energy fallback, never a broken take.

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Vad, gapMidpoints, sileroScorer, type VadSessionLike } from '../../core/vad';
import * as Log from '../log';
import { fetchFile, verifySha } from '../models/modelDownloader';
import { env, localDataDir, modelDirOverride } from '../paths';
import type { SettingsData } from '../settings';

export const VAD_FILE = 'silero_vad.onnx';
export const VAD_MODEL_URL = 'https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx';
export const VAD_SHA256 = '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f';
export const VAD_SIZE = 2327524;

/** Where a download puts the model. */
export function vadModelPath(): string {
  return join(localDataDir(), 'models', 'silero-vad', VAD_FILE);
}

/** CHAWO_VAD_MODEL (a file), the canonical path, then CHAWO_MODEL_DIR. Null when none is there. */
export function findVadModel(): string | null {
  const candidates: string[] = [];
  const explicit = env('VAD_MODEL');
  if (explicit) candidates.push(explicit);
  candidates.push(vadModelPath());
  const dir = modelDirOverride();
  if (dir) candidates.push(join(dir, VAD_FILE), join(dir, 'silero-vad', VAD_FILE));
  for (const p of candidates) {
    try {
      if (existsSync(p) && statSync(p).isFile() && statSync(p).size > 0) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export type FetchToFile = (url: string, dest: string, size: number, signal?: AbortSignal) => Promise<void>;

/** Downloads and verifies the model into `vadModelPath()`. Throws on network or checksum errors. */
export async function downloadVadModel(signal?: AbortSignal, fetchTo?: FetchToFile): Promise<string> {
  const dest = vadModelPath();
  const part = dest + '.part';
  mkdirSync(dirname(dest), { recursive: true });
  const get: FetchToFile = fetchTo ?? ((url, to, size, sig) => fetchFile(url, to, size, () => {}, sig));
  try {
    await get(VAD_MODEL_URL, part, VAD_SIZE, signal);
    verifySha(part, VAD_SHA256);
    renameSync(part, dest);
    Log.write(`vad model downloaded: ${dest}`);
    return dest;
  } finally {
    try {
      rmSync(part, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export type SessionFactory = (path: string) => Promise<VadSessionLike & { release?: () => Promise<void> }>;

async function ortSession(path: string): Promise<VadSessionLike & { release?: () => Promise<void> }> {
  const ort = await import('onnxruntime-node');
  return (await ort.InferenceSession.create(path, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    logSeverityLevel: 3,
  })) as unknown as VadSessionLike & { release?: () => Promise<void> };
}

/**
 * One lazily loaded Silero session for the whole app (dictation and files share it; the ONNX session
 * itself is stateless, the recurrent state travels with each call). `vad()` never throws: no file or a
 * failed load gives the energy Vad.
 */
export class VadRuntime {
  private session: (VadSessionLike & { release?: () => Promise<void> }) | null = null;
  private loadedPath = '';
  private loading: Promise<Vad> | null = null;
  private failedKey = '';
  private downloading: Promise<string> | null = null;
  private lastError = '';

  constructor(
    private readonly find: () => string | null = findVadModel,
    private readonly create: SessionFactory = ortSession,
    private readonly fetchTo?: FetchToFile,
  ) {}

  /** The model file is on disk. */
  get onDisk(): boolean {
    return this.find() !== null;
  }

  get isDownloading(): boolean {
    return this.downloading !== null;
  }

  /** Last download/load error, '' if none. */
  get error(): string {
    return this.lastError;
  }

  /** True once a Silero session is open. */
  get loaded(): boolean {
    return this.session !== null;
  }

  vad(): Promise<Vad> {
    const path = this.find();
    if (!path) return Promise.resolve(new Vad(null));
    if (this.session && this.loadedPath === path) return Promise.resolve(new Vad(sileroScorer(this.session)));
    let key = path;
    try {
      key = `${path}|${statSync(path).mtimeMs}`;
    } catch {
      /* use the path */
    }
    if (this.failedKey === key) return Promise.resolve(new Vad(null));
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const s = await this.create(path);
        await this.dropSession();
        this.session = s;
        this.loadedPath = path;
        this.lastError = '';
        Log.write(`vad model loaded: ${path}`);
        return new Vad(sileroScorer(s));
      } catch (e) {
        this.failedKey = key;
        this.lastError = e instanceof Error ? e.message : String(e);
        Log.write(`vad model load failed, energy fallback: ${this.lastError}`);
        return new Vad(null);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Downloads the model once (concurrent calls share the run). */
  download(signal?: AbortSignal): Promise<string> {
    if (this.downloading) return this.downloading;
    this.lastError = '';
    this.downloading = (async () => {
      try {
        const p = await downloadVadModel(signal, this.fetchTo);
        this.failedKey = '';
        return p;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        Log.write(`vad model download failed: ${this.lastError}`);
        throw e;
      } finally {
        this.downloading = null;
      }
    })();
    return this.downloading;
  }

  async release(): Promise<void> {
    await this.dropSession();
  }

  private async dropSession(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.loadedPath = '';
    if (!s?.release) return;
    try {
      await s.release();
    } catch {
      /* ignore */
    }
  }
}

let shared: VadRuntime | null = null;

export function getVadRuntime(): VadRuntime {
  shared ??= new VadRuntime();
  return shared;
}

/** Tests swap the app-wide runtime. */
export function setVadRuntime(r: VadRuntime | null): void {
  shared = r;
}

/**
 * Cut candidates for a long file from Silero, or undefined to keep the energy `silences()` split:
 * VAD off, no model, a load error, or no speech found at all (then pauses tell nothing).
 */
export async function filePauses(
  s: Pick<SettingsData, 'VadEnabled'>,
  samples: Float32Array,
  rate: number,
  opts: { signal?: AbortSignal; onStart?: () => void; runtime?: VadRuntime } = {},
): Promise<number[] | undefined> {
  if (!s.VadEnabled) return undefined;
  const { signal } = opts;
  try {
    const vad = await (opts.runtime ?? getVadRuntime()).vad();
    if (!vad.silero) return undefined;
    opts.onStart?.();
    const t0 = Date.now();
    const segs = await vad.segments(samples, rate, signal);
    if (segs.length === 0) return undefined;
    const pauses = gapMidpoints(segs, samples.length / rate);
    Log.write(`vad file ${(samples.length / rate).toFixed(0)}s segments=${segs.length} pauses=${pauses.length} in ${Date.now() - t0} ms`);
    return pauses;
  } catch (e) {
    if (signal?.aborted) throw e;
    Log.write(`vad file failed, energy split: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * Dictation trim: leading/trailing silence cut by Silero (100 ms kept on each side). Without the model
 * the take is left as it is, so the energy path is the old behaviour. Never throws.
 */
export async function trimTake(
  s: SettingsData,
  samples: Float32Array,
  rate: number,
  runtime: VadRuntime = getVadRuntime(),
): Promise<Float32Array> {
  if (!s.VadEnabled) return samples;
  try {
    const vad = await runtime.vad();
    if (!vad.silero) return samples;
    const r = await vad.trimSpeech(samples, rate);
    if (r.samples !== samples) Log.write(`vad trim ${(samples.length / rate).toFixed(2)}s → ${r.start.toFixed(2)}–${r.end.toFixed(2)}s`);
    return r.samples;
  } catch (e) {
    Log.write(`vad trim failed: ${e instanceof Error ? e.message : String(e)}`);
    return samples;
  }
}
