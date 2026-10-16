// Long-file transcription: dedicated sessions so dictation is not locked out,
// CPU workers in parallel, GPU batches on one session.
// Port of src/Core/FileJob.cs.
//
// Multi-worker CPU path uses separate Recognizer instances with Promise concurrency
// matching plan.workers (faithful to C# threads, simpler than worker_threads + ORT).

import { freemem, cpus } from 'node:os';
import { resolvePlan, type FileParallelismKind, type FileParallelPlan } from './fileParallel';
import { isMemoryPressureMessage, isTerminateMessage, Recognizer } from './recognizer';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from './speechModels';

export type FileProgress = (
  done: number,
  total: number,
  audioSecDone: number,
  wallSec: number,
) => void;

function availableBytesGuess(availableBytes: number): number {
  if (availableBytes >= 0) return availableBytes;
  try {
    return Math.max(0, freemem());
  } catch {
    return 4 * 1024 ** 3;
  }
}

function cores(): number {
  return Math.max(1, cpus().length);
}

export class FileJob {
  private readonly workers: Recognizer[];
  readonly plan: FileParallelPlan;
  private disposed = 0;

  private constructor(workers: Recognizer[], plan: FileParallelPlan) {
    this.workers = workers;
    this.plan = plan;
  }

  get deviceActual(): string {
    return this.workers[0].deviceActual;
  }

  get provider(): string {
    return this.workers[0].provider;
  }

  /**
   * Opens sessions used only for this file. Does not touch the dictation recognizer.
   * On GPU always one session (GPU EPs are not safe for concurrent Run).
   */
  static async open(
    modelDir: string,
    kind: SpeechModelKind,
    device: SpeechDeviceKind,
    parallelism: FileParallelismKind,
    script: CtcScript,
    availableBytes = -1,
  ): Promise<FileJob> {
    const bytes = availableBytesGuess(availableBytes);
    const nCores = cores();
    // First session: learn real device (GPU may fall back) and whether the graph batches.
    let first: Recognizer | null = await Recognizer.open(modelDir, kind, device, Math.max(1, Math.floor(nCores / 2)));
    first.script = script;
    const useGpu = first.deviceActual === 'gpu';
    const plan = resolvePlan(parallelism, useGpu, first.encoderAcceptsBatch, kind, nCores, bytes);

    let workers: Recognizer[];
    try {
      if (plan.workers === 1) {
        if (first.intraOpThreads !== plan.intraOpThreads && !useGpu) {
          await first.dispose();
          first = await Recognizer.open(modelDir, kind, 'cpu', plan.intraOpThreads);
          first.script = script;
        }
        workers = [first];
        first = null;
      } else {
        await first.dispose();
        first = null;
        workers = new Array<Recognizer>(plan.workers);
        for (let i = 0; i < plan.workers; i++) {
          workers[i] = await Recognizer.open(modelDir, kind, 'cpu', plan.intraOpThreads);
          workers[i].script = script;
        }
      }
    } catch (e) {
      if (first) await first.dispose().catch(() => undefined);
      throw e;
    }

    return new FileJob(workers, plan);
  }

  /**
   * Transcribe every piece. Results stay in piece order. Empty pieces stay empty strings.
   */
  async run(
    samplesAtModelRate: Float32Array,
    ranges: ReadonlyArray<{ from: number; to: number }>,
    onProgress: FileProgress | null,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const n = ranges.length;
    const texts: string[] = new Array<string>(n);
    if (n === 0) return texts;

    const t0 = Date.now();
    let done = 0;
    let audioDone = 0;

    const report = (pieceSamples: number) => {
      done++;
      audioDone += pieceSamples / Math.max(1, this.workers[0].sampleRate);
      onProgress?.(done, n, audioDone, (Date.now() - t0) / 1000);
    };

    if (this.plan.useGpu || this.plan.workers === 1) {
      const rec = this.workers[0];
      let batch = Math.max(1, this.plan.batchSize);
      let readyWaves: Float32Array[] | null = null;
      let readyLengths: number[] | null = null;
      let readyAt = 0;
      let readyTake = 0;

      const copyBatch = (at: number, take: number): { waves: Float32Array[]; lengths: number[] } => {
        const waves: Float32Array[] = new Array<Float32Array>(take);
        const lengths: number[] = new Array<number>(take);
        for (let k = 0; k < take; k++) {
          const { from, to } = ranges[at + k];
          lengths[k] = to - from;
          waves[k] = samplesAtModelRate.slice(from, to);
        }
        return { waves, lengths };
      };

      let i = 0;
      while (i < n) {
        if (signal?.aborted) throw abortError();
        const take = Math.min(batch, n - i);
        let waves: Float32Array[];
        let lengths: number[];
        if (readyWaves != null && readyAt === i && readyTake === take) {
          waves = readyWaves;
          lengths = readyLengths!;
          readyWaves = null;
        } else {
          ({ waves, lengths } = copyBatch(i, take));
        }

        const nextAt = i + take;
        const nextTake = nextAt < n ? Math.min(batch, n - nextAt) : 0;
        let prep: Promise<void> | null = null;
        if (nextTake > 0) {
          prep = Promise.resolve().then(() => {
            const { waves: w, lengths: lens } = copyBatch(nextAt, nextTake);
            readyWaves = w;
            readyLengths = lens;
            readyAt = nextAt;
            readyTake = nextTake;
          });
        }

        let bits: string[];
        try {
          bits = take === 1 ? [await rec.transcribePiece(waves[0])] : await rec.transcribeBatch(waves, signal);
        } catch (ex) {
          const msg = ex instanceof Error ? ex.message : String(ex);
          if (take > 1 && isMemoryPressureMessage(msg)) {
            try {
              await prep;
            } catch {
              /* ignore */
            }
            readyWaves = null;
            batch = Math.max(1, Math.floor(take / 2));
            continue;
          }
          throw ex;
        }

        for (let k = 0; k < take; k++) {
          texts[i + k] = bits[k] ?? '';
          report(lengths[k]);
        }
        i += take;
        if (prep) {
          try {
            await prep;
          } catch {
            readyWaves = null;
          }
        }
      }
      return texts;
    }

    // Multi-worker CPU: Promise pool, one Recognizer per worker.
    let next = 0;
    let fault: Error | null = null;
    const localAbort = new AbortController();
    const onAbort = () => {
      for (const r of this.workers) {
        try {
          r.cancelRun();
        } catch {
          /* ignore */
        }
      }
      localAbort.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const workerLoop = async (wid: number): Promise<void> => {
      const rec = this.workers[wid];
      try {
        while (true) {
          if (fault || localAbort.signal.aborted || signal?.aborted) return;
          const idx = next++;
          if (idx >= n) return;
          const { from, to } = ranges[idx];
          const piece = samplesAtModelRate.slice(from, to);
          let bit: string;
          try {
            bit = await rec.transcribePiece(piece);
          } catch (ex) {
            const msg = ex instanceof Error ? ex.message : String(ex);
            if (localAbort.signal.aborted || signal?.aborted || isTerminateMessage(msg)) return;
            throw ex;
          }
          texts[idx] = bit ?? '';
          report(piece.length);
        }
      } catch (ex) {
        fault = ex instanceof Error ? ex : new Error(String(ex));
        try {
          localAbort.abort();
        } catch {
          /* ignore */
        }
        for (const r of this.workers) {
          try {
            r.cancelRun();
          } catch {
            /* ignore */
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: this.plan.workers }, (_, w) => workerLoop(w)));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted) throw abortError();
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- a worker's own failure, rethrown as is
    if (fault) throw fault;
    return texts;
  }

  cancel(): void {
    for (const r of this.workers) {
      try {
        r.cancelRun();
      } catch {
        /* ignore */
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed !== 0) return;
    this.disposed = 1;
    for (const r of this.workers) {
      try {
        await r.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

function abortError(): Error {
  const e = new Error('Operation canceled');
  e.name = 'AbortError';
  return e;
}
