// Runtime wrapper around sherpa-onnx OfflineSpeakerDiarization.
// The native addon is lazy-required so unit tests run without it. The backend is injectable
// for FakeDiarizer in fileRunner tests. Models live under userData (see diarizeModels.ts).

import type { DiarSpan } from '../../core/diarize';
import * as Log from '../log';
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
  process(pcm: Float32Array): DiarSpan[];
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

export function sherpaBackendFactory(sherpa: SherpaModule): BackendFactory {
  return (paths) => {
    const sd = new sherpa.OfflineSpeakerDiarization({
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
    });
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

  constructor(
    private readonly find: () => DiarModelPaths | null = findDiarizationModels,
    private readonly create: BackendFactory | null = null,
    private readonly fetchTo?: FetchToFile,
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
        this.backend = null;
        this.backendKey = '';
        return paths;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        Log.write(`diarization download failed: ${this.lastError}`);
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
    return b.process(pcm);
  }

  release(): void {
    this.backend = null;
    this.backendKey = '';
  }

  private ensureBackend(): DiarizeBackend | null {
    const paths = this.find();
    if (!paths) return null;
    const key = `${paths.segmentation}|${paths.embedding}`;
    if (this.backend && this.backendKey === key) return this.backend;
    const factory = this.create ?? defaultFactory();
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
 */
export function diarizeHook(
  runtime: () => DiarizeRuntime = getDiarizeRuntime,
  statusLine: () => string = () => 'Разделяю спикеров…',
): (pcm: Float32Array, status: (line: string) => void, signal: AbortSignal) => Promise<DiarSpan[] | null> {
  return async (pcm, status, signal) => {
    const diar = runtime();
    if (!diar.ready) return null;
    status(statusLine());
    return diar.run(pcm, signal);
  };
}

/** Tests swap the app-wide runtime. */
export function setDiarizeRuntime(r: DiarizeRuntime | null): void {
  shared = r;
}
