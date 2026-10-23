// Runtime wrapper around sherpa-onnx OfflineSpeakerDiarization.
// The native addon is lazy-required so unit tests run without it. The backend is injectable
// for FakeDiarizer in fileRunner tests. Models live under userData (see diarizeModels.ts).
// In the app the work runs in a worker thread (diarizeWorker.ts); without its file, in this thread.

import { Worker } from 'node:worker_threads';
import type { DiarSpan } from '@chawo/core/diarize';
import * as Log from '../log';
import { builtWorkerFile } from '../workerFile';
import type { DiarizeWorkerReply, DiarizeWorkerRequest } from './diarizeWorker';
import {
  DIAR_TOTAL_BYTES,
  downloadDiarizationModels,
  findDiarizationModels,
  type DiarModelPaths,
  type FetchToFile,
  type ProgressFn,
} from './diarizeModels';

export interface DiarizeBackend {
  /** Run diarization on float32 mono 16 kHz PCM in [-1, 1]. */
  process(pcm: Float32Array, signal?: AbortSignal): DiarSpan[] | Promise<DiarSpan[]>;
  /** Frees the native object / stops the worker. */
  dispose?(): void;
}

export type BackendFactory = (paths: DiarModelPaths) => DiarizeBackend;

/** Clustering / duration knobs from the sherpa-onnx speaker-diarization example. */
export const DIAR_CLUSTERING = {
  numClusters: -1,
  threshold: 0.5,
  minDurationOn: 0.2,
  minDurationOff: 0.5,
} as const;

type SherpaModule = {
  OfflineSpeakerDiarization: new (config: Record<string, unknown>) => {
    sampleRate: number;
    process(samples: Float32Array): { start: number; end: number; speaker: number }[];
  };
};

/** Lazy require — returns null when the native addon is missing (tests / unsupported OS). */
export function tryLoadSherpa(): SherpaModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('sherpa-onnx-node') as SherpaModule;
  } catch (e) {
    Log.write(`sherpa-onnx-node unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** OfflineSpeakerDiarization config, the same in this thread and in the worker. */
function sherpaConfig(paths: DiarModelPaths): Record<string, unknown> {
  return {
    segmentation: {
      pyannote: { model: paths.segmentation },
    },
    embedding: { model: paths.embedding },
    clustering: {
      numClusters: DIAR_CLUSTERING.numClusters,
      threshold: DIAR_CLUSTERING.threshold,
    },
    minDurationOn: DIAR_CLUSTERING.minDurationOn,
    minDurationOff: DIAR_CLUSTERING.minDurationOff,
  };
}

export function sherpaBackendFactory(sherpa: SherpaModule): BackendFactory {
  return (paths) => {
    const sd = new sherpa.OfflineSpeakerDiarization(sherpaConfig(paths));
    return {
      process(pcm: Float32Array): DiarSpan[] {
        const segs = sd.process(pcm);
        return (segs ?? []).map((s) => ({
          start: s.start,
          end: s.end,
          speaker: s.speaker,
        }));
      },
    };
  };
}

/** The worker could not start or load sherpa-onnx there: the runtime falls back to this thread. */
class WorkerUnavailable extends Error {}

/** out/main/diarizeWorker.js of the built app; null = no worker file. */
const defaultWorkerFile = (): string | null => builtWorkerFile('diarizeWorker.js');

/**
 * Backend in a worker thread: the main thread (the window, IPC, progress) stays free while sherpa-onnx
 * works. The worker is kept between files; Stop terminates it, the next file starts a new one.
 */
export function workerBackendFactory(file: string): BackendFactory {
  return (paths) => {
    const config = sherpaConfig(paths);
    const key = `${paths.segmentation}|${paths.embedding}`;
    let worker: Worker | null = null;
    const drop = (w: Worker) => {
      if (worker === w) worker = null;
      void w.terminate().catch(() => undefined);
    };
    return {
      process: (pcm, signal) =>
        new Promise<DiarSpan[]>((resolve, reject) => {
          if (signal?.aborted) return reject(abortErr());
          let w: Worker;
          try {
            w = worker ?? new Worker(file);
          } catch (e) {
            return reject(new WorkerUnavailable(e instanceof Error ? e.message : String(e)));
          }
          const fresh = worker !== w;
          worker = w;
          // An idle worker must not keep `chawo-va transcribe` alive; a busy one must.
          w.ref();
          const done = () => {
            w.off('message', onMessage);
            w.off('error', onError);
            w.off('exit', onExit);
            signal?.removeEventListener('abort', onAbort);
            w.unref();
          };
          const onMessage = (r: DiarizeWorkerReply) => {
            done();
            if (r.ok) resolve(r.spans);
            else if (r.noSherpa) {
              drop(w);
              reject(new WorkerUnavailable(r.error));
            } else reject(new Error(r.error));
          };
          const onError = (e: Error) => {
            done();
            drop(w);
            // A worker that fails before its first answer cannot load here (path, asar): use this thread.
            reject(fresh ? new WorkerUnavailable(e.message) : e);
          };
          const onExit = (code: number) => {
            done();
            if (worker === w) worker = null;
            reject(fresh ? new WorkerUnavailable(`exit ${code}`) : new Error(`diarization worker exited (${code})`));
          };
          const onAbort = () => {
            done();
            drop(w);
            reject(abortErr());
          };
          w.on('message', onMessage);
          w.on('error', onError);
          w.on('exit', onExit);
          signal?.addEventListener('abort', onAbort, { once: true });
          // A copy goes over (the caller keeps its samples); its buffer is moved, not cloned again.
          const copy = pcm.slice();
          const req: DiarizeWorkerRequest = { config, key, pcm: copy };
          w.postMessage(req, [copy.buffer]);
        }),
      dispose: () => {
        if (worker) drop(worker);
      },
    };
  };
}

/**
 * App-wide diarization runtime: finds models, downloads on demand, builds a backend once.
 * `ready` is true only when models are on disk and a backend can be created (or was injected).
 */
export class DiarizeRuntime {
  private backend: DiarizeBackend | null = null;
  private backendKey = '';
  private downloading: Promise<DiarModelPaths> | null = null;
  private lastError = '';
  private downloadProgress = { received: 0, total: DIAR_TOTAL_BYTES, stage: '' };

  /** Set when the worker cannot run here; later files diarize in this thread. */
  private noWorker = false;

  constructor(
    private readonly find: () => DiarModelPaths | null = findDiarizationModels,
    private readonly create: BackendFactory | null = null,
    private readonly fetchTo?: FetchToFile,
    private readonly workerFile: () => string | null = defaultWorkerFile,
  ) {}

  /** Models present on disk. */
  get onDisk(): boolean {
    return this.find() !== null;
  }

  /** A backend can be opened (models + sherpa, or an injected factory). */
  get ready(): boolean {
    if (!this.onDisk) return false;
    if (this.create) return true;
    return tryLoadSherpa() !== null;
  }

  get isDownloading(): boolean {
    return this.downloading !== null;
  }

  get error(): string {
    return this.lastError;
  }

  get progress(): { received: number; total: number; stage: string } {
    return { ...this.downloadProgress };
  }

  /** Status line for the file page (Russian/English via caller). */
  statusRu(): string {
    if (this.isDownloading) {
      const p = this.downloadProgress;
      const pct = p.total > 0 ? Math.min(99, Math.floor((100 * p.received) / p.total)) : 0;
      return `Скачиваю модели спикеров… ${pct}%`;
    }
    if (this.lastError) return `Диаризация: ${this.lastError}`;
    if (!this.onDisk) return 'Модели разделения спикеров не скачаны (~47 МБ).';
    if (!this.ready) return 'Модели на диске, но sherpa-onnx-node недоступен.';
    return 'Модели разделения спикеров готовы.';
  }

  statusEn(): string {
    if (this.isDownloading) {
      const p = this.downloadProgress;
      const pct = p.total > 0 ? Math.min(99, Math.floor((100 * p.received) / p.total)) : 0;
      return `Downloading speaker models… ${pct}%`;
    }
    if (this.lastError) return `Diarization: ${this.lastError}`;
    if (!this.onDisk) return 'Speaker diarization models are not downloaded (~47 MB).';
    if (!this.ready) return 'Models on disk, but sherpa-onnx-node is unavailable.';
    return 'Speaker diarization models are ready.';
  }

  download(signal?: AbortSignal, onProgress?: ProgressFn): Promise<DiarModelPaths> {
    if (this.downloading) return this.downloading;
    this.lastError = '';
    this.downloadProgress = { received: 0, total: DIAR_TOTAL_BYTES, stage: 'start' };
    this.downloading = (async () => {
      try {
        const paths = await downloadDiarizationModels(
          (received, total, stage) => {
            this.downloadProgress = { received, total, stage };
            onProgress?.(received, total, stage);
          },
          signal,
          this.fetchTo,
        );
        this.release();
        return paths;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        Log.write(`diarization download failed: ${msg}`);
        // A cancelled download is not an error to show on the page.
        if (!(signal?.aborted || (e instanceof Error && e.name === 'AbortError'))) this.lastError = msg;
        throw e;
      } finally {
        this.downloading = null;
      }
    })();
    return this.downloading;
  }

  /**
   * Diarize PCM. Throws only on hard backend failures; caller should catch and continue the queue.
   * Returns [] when not ready (caller should skip without failing).
   */
  async run(pcm: Float32Array, signal?: AbortSignal): Promise<DiarSpan[]> {
    if (signal?.aborted) throw abortErr();
    const b = this.ensureBackend();
    if (!b) return [];
    if (signal?.aborted) throw abortErr();
    try {
      return await b.process(pcm, signal);
    } catch (e) {
      if (!(e instanceof WorkerUnavailable)) throw e;
      Log.write(`diarization worker unavailable, running in the main thread: ${e.message}`);
      this.noWorker = true;
      this.release();
      const local = this.ensureBackend();
      if (!local) return [];
      return local.process(pcm, signal);
    }
  }

  release(): void {
    this.backend?.dispose?.();
    this.backend = null;
    this.backendKey = '';
  }

  private ensureBackend(): DiarizeBackend | null {
    const paths = this.find();
    if (!paths) return null;
    const key = `${paths.segmentation}|${paths.embedding}`;
    if (this.backend && this.backendKey === key) return this.backend;
    const file = this.create || this.noWorker ? null : this.workerFile();
    const factory = this.create ?? (file ? workerBackendFactory(file) : defaultFactory());
    if (!factory) {
      this.lastError = 'sherpa-onnx-node unavailable';
      return null;
    }
    try {
      this.backend = factory(paths);
      this.backendKey = key;
      this.lastError = '';
      Log.write(`diarization backend ready: ${paths.segmentation}`);
      return this.backend;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      Log.write(`diarization backend failed: ${this.lastError}`);
      this.backend = null;
      this.backendKey = '';
      return null;
    }
  }
}

function defaultFactory(): BackendFactory | null {
  const sherpa = tryLoadSherpa();
  return sherpa ? sherpaBackendFactory(sherpa) : null;
}

function abortErr(): Error {
  const e = new Error('Operation canceled');
  e.name = 'AbortError';
  return e;
}

let shared: DiarizeRuntime | null = null;

export function getDiarizeRuntime(): DiarizeRuntime {
  shared ??= new DiarizeRuntime();
  return shared;
}

/**
 * The file diarization hook (fileRunner `runDiarize`, `chawo-va transcribe`): null when the models or
 * sherpa-onnx are not there (caller notes it softly), else the spans. Never downloads.
 * sherpa-onnx reports no progress, so the line shows the time spent: the step is alive, not hung.
 */
export function diarizeHook(
  runtime: () => DiarizeRuntime = getDiarizeRuntime,
  statusLine: () => string = () => 'Разделяю спикеров…',
  tickMs = 1000,
): (pcm: Float32Array, status: (line: string) => void, signal: AbortSignal) => Promise<DiarSpan[] | null> {
  return async (pcm, status, signal) => {
    const diar = runtime();
    if (!diar.ready) return null;
    const t0 = Date.now();
    status(statusLine());
    const tick = setInterval(() => status(`${statusLine()} ${elapsed(Date.now() - t0)}`), tickMs);
    tick.unref?.();
    try {
      return await diar.run(pcm, signal);
    } finally {
      clearInterval(tick);
    }
  };
}

/** 83_000 ms → "1:23", an hour and more → "1:02:03". */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** Tests swap the app-wide runtime. */
export function setDiarizeRuntime(r: DiarizeRuntime | null): void {
  shared = r;
}
