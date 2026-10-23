// One file through the local speech model: pieces (Silero pauses or the energy split), a FileJob with its
// own sessions, timed segments. The page runs it in a worker thread (fileJobWorker.ts): onnxruntime-node
// runs the model synchronously, and in Electron the main thread is the window's thread, so a long file in
// it froze the window for seconds at a time. Plain inputs only, so it runs the same in either thread.

import { FileJob } from '@chawo/core/fileJob';
import { progressLine, type FileParallelismKind } from '@chawo/core/fileParallel';
import { Recognizer } from '@chawo/core/recognizer';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '@chawo/core/speechModels';
import { t } from '@chawo/core/strings';
import { fromRanges, type TranscriptSegment } from '@chawo/core/transcriptFormat';
import * as Log from '../log';
import type { SettingsData } from '../settings';
import { filePauses } from '../vad/vadModel';

const RATE = 16000;

export type PausesFn = typeof filePauses;

/** What a file run needs from the settings, read once when the file starts. */
export interface LocalJobRequest {
  modelDir: string;
  kind: SpeechModelKind;
  device: SpeechDeviceKind;
  parallelism: FileParallelismKind;
  script: CtcScript;
  vadEnabled: boolean;
}

/**
 * Pieces of a file for FileJob: Silero pauses when the file is longer than one chunk, VadEnabled is on
 * and its model is on disk, else the energy split as before. Shared by the page and `chawo-va transcribe`.
 * Never downloads the VAD model.
 */
export async function fileRanges(
  s: Pick<SettingsData, 'VadEnabled'>,
  samples: Float32Array,
  opts: { signal?: AbortSignal; onStart?: () => void; pauses?: PausesFn } = {},
): Promise<Array<{ from: number; to: number }>> {
  const pauses = samples.length > (Recognizer.MaxChunkSeconds + 1) * RATE
    ? await (opts.pauses ?? filePauses)(s, samples, RATE, { signal: opts.signal, onStart: opts.onStart })
    : undefined;
  return Recognizer.splitRanges(samples, RATE, pauses);
}

/** Recognizes one file; status() gets the progress line and the share of pieces done. */
export async function runLocalJob(
  req: LocalJobRequest,
  path: string,
  samples: Float32Array,
  status: (line: string, fraction?: number) => void,
  signal: AbortSignal,
): Promise<TranscriptSegment[]> {
  const job = await FileJob.open(req.modelDir, req.kind, req.device, req.parallelism, req.script);
  const onAbort = () => job.cancel();
  signal.addEventListener('abort', onAbort);
  try {
    const plan = job.plan;
    const planShown = t(plan.summaryRu, plan.summaryEn);
    const ranges = await fileRanges({ VadEnabled: req.vadEnabled }, samples, { signal, onStart: () => status(t('Ищу паузы в речи…', 'Finding pauses in speech…')) });
    Log.write(
      `file parallel workers=${plan.workers} batch=${plan.batchSize} intra=${plan.intraOpThreads} gpu=${plan.useGpu} device=${job.deviceActual}/${job.provider} → ${planShown}`,
    );
    status(progressLine(0, ranges.length, 0, 0, planShown, t), 0);
    const t0 = Date.now();
    const bits = await job.run(
      samples,
      ranges,
      (done, total, audioDone, wall) => status(progressLine(done, total, audioDone, wall, planShown, t), total > 0 ? done / total : undefined),
      signal,
    );
    const wall = (Date.now() - t0) / 1000;
    const audio = samples.length / RATE;
    Log.write(`file local ${audio.toFixed(0)}s pieces=${ranges.length} wall=${wall.toFixed(1)}s rtf=${(wall > 0.05 ? audio / wall : 0).toFixed(2)}x <- ${path}`);
    return fromRanges(ranges.map((r) => [r.from, r.to] as const), bits, RATE);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await job.dispose();
  }
}
