// Local speech for files: dedicated FileJob sessions per file, so dictation keeps its own
// recognizer. Never downloads a model. Port of App.TranscribeLocal.
// Each file is recognized in a worker thread (fileJobWorker.ts) when the built app has one, so the
// window stays responsive; otherwise, and when a worker cannot start here, in this thread.

import { Worker } from 'node:worker_threads';
import { isRussian, t } from '@chawo/core/strings';
import type { TranscriptSegment } from '@chawo/core/transcriptFormat';
import * as Log from '../log';
import { findComplete } from '../models/speechModelStore';
import { toCtcScript, toFileParallelism, toSpeechDeviceKind, toSpeechModelKind, type SettingsData } from '../settings';
import { builtWorkerFile } from '../workerFile';
import type { FileJobWorkerMessage, FileJobWorkerReply } from './fileJobWorker';
import { runLocalJob, type LocalJobRequest } from './localJob';
import type { FileRunnerDeps, FileTranscriber } from './fileRunner';

export { fileRanges, type PausesFn } from './localJob';

/** The worker did not start or died before its first answer: the file is recognized in this thread. */
class WorkerUnavailable extends Error {
  override name = 'WorkerUnavailable';
}

/** How long a cancelled worker may take to close its sessions before it is terminated. */
const CANCEL_GRACE_MS = 5000;

/** One file in a fresh worker; it is ended when the file is done, failed or stopped. */
export function transcribeInWorker(
  file: string,
  req: LocalJobRequest,
  path: string,
  samples: Float32Array,
  status: (line: string, fraction?: number) => void,
  signal: AbortSignal,
): Promise<TranscriptSegment[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    let w: Worker;
    try {
      w = new Worker(file);
    } catch (e) {
      return reject(new WorkerUnavailable(e instanceof Error ? e.message : String(e)));
    }
    let answered = false;
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const end = () => {
      if (grace) clearTimeout(grace);
      void w.terminate().catch(() => undefined);
    };
    const onAbort = () => {
      // The worker cancels its job and closes the sessions; Stop answers at once either way.
      w.postMessage({ type: 'cancel' } satisfies FileJobWorkerMessage);
      grace = setTimeout(end, CANCEL_GRACE_MS);
      finish(() => reject(abortError()));
    };
    w.on('message', (r: FileJobWorkerReply) => {
      answered = true;
      if (r.type === 'status') {
        if (!settled) status(r.line, r.fraction);
        return;
      }
      end();
      if (r.type === 'done') finish(() => resolve(r.segments));
      else finish(() => reject(Object.assign(new Error(r.message), { name: r.name })));
    });
    w.on('error', (e: Error) => {
      end();
      finish(() => reject(answered ? e : new WorkerUnavailable(e.message)));
    });
    w.on('exit', (code) => {
      if (grace) clearTimeout(grace);
      finish(() => reject(answered ? new Error(t(`Распознавание прервалось (код ${code}).`, `Recognition stopped unexpectedly (code ${code}).`)) : new WorkerUnavailable(`exit ${code}`)));
    });
    signal.addEventListener('abort', onAbort, { once: true });
    // A copy goes over (the runner keeps its samples for speakers); its buffer is moved, not cloned again.
    const copy = samples.slice();
    w.postMessage({ type: 'run', req, path, samples: copy, ru: isRussian() } satisfies FileJobWorkerMessage, [copy.buffer]);
  });
}

export function localPrepare(
  settings: () => SettingsData,
  workerFile: () => string | null = () => builtWorkerFile('fileJobWorker.js'),
): FileRunnerDeps['prepare'] {
  let noWorker = false;
  return async () => {
    const s = settings();
    const kind = toSpeechModelKind(s.SpeechModel);
    const dir = findComplete(kind);
    if (!dir) {
      return {
        ok: false,
        message: t(
          'Модели нет на диске. Откройте «Распознавание» и скачайте выбранную модель.',
          'The model is not on disk. Open Speech and download the selected model.',
        ),
      };
    }
    const transcriber: FileTranscriber = async (path, samples, status, signal) => {
      const cur = settings();
      const req: LocalJobRequest = {
        modelDir: dir,
        kind,
        device: toSpeechDeviceKind(cur.SpeechDevice),
        parallelism: toFileParallelism(cur.FileParallelism),
        script: toCtcScript(cur.CtcScript),
        vadEnabled: cur.VadEnabled,
      };
      const file = noWorker ? null : workerFile();
      if (file) {
        try {
          return await transcribeInWorker(file, req, path, samples, status, signal);
        } catch (e) {
          if (!(e instanceof WorkerUnavailable)) throw e;
          Log.write(`file worker unavailable, recognizing in the main thread: ${e.message}`);
          noWorker = true;
        }
      }
      return runLocalJob(req, path, samples, status, signal);
    };
    return { ok: true, transcriber };
  };
}

function abortError(): Error {
  const e = new Error('Operation canceled');
  e.name = 'AbortError';
  return e;
}
