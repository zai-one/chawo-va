// Local file recognition in a worker thread (see localJob.ts for why). Started by its built path
// (out/main/fileJobWorker.js) from localTranscriber.ts, one worker per file: it opens the model, sends
// progress lines back, then the segments, and is ended by the main thread.

import { parentPort } from 'node:worker_threads';
import { applyLanguage } from '@chawo/core/strings';
import type { TranscriptSegment } from '@chawo/core/transcriptFormat';
import { runLocalJob, type LocalJobRequest } from './localJob';

export type FileJobWorkerMessage =
  | { type: 'run'; req: LocalJobRequest; path: string; samples: Float32Array; ru: boolean }
  | { type: 'cancel' };

export type FileJobWorkerReply =
  | { type: 'status'; line: string; fraction?: number }
  | { type: 'done'; segments: TranscriptSegment[] }
  | { type: 'error'; name: string; message: string };

const ctrl = new AbortController();
const reply = (r: FileJobWorkerReply) => parentPort?.postMessage(r);

parentPort?.on('message', (m: FileJobWorkerMessage) => {
  if (m.type === 'cancel') {
    ctrl.abort();
    return;
  }
  // Progress lines in the window's language.
  applyLanguage(m.ru ? 'Russian' : 'English');
  runLocalJob(m.req, m.path, m.samples, (line, fraction) => reply({ type: 'status', line, fraction }), ctrl.signal).then(
    (segments) => reply({ type: 'done', segments }),
    (e: unknown) => reply({ type: 'error', name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) }),
  );
});
