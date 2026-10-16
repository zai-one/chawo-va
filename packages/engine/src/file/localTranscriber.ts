// Local speech for files: dedicated FileJob sessions per file, so dictation keeps its own
// recognizer. Never downloads a model. Port of App.TranscribeLocal.

import { FileJob } from '@chawo/core/fileJob';
import { progressLine } from '@chawo/core/fileParallel';
import { Recognizer } from '@chawo/core/recognizer';
import { t } from '@chawo/core/strings';
import { fromRanges } from '@chawo/core/transcriptFormat';
import * as Log from '../log';
import { findComplete } from '../models/speechModelStore';
import { toCtcScript, toFileParallelism, toSpeechDeviceKind, toSpeechModelKind, type SettingsData } from '../settings';
import { filePauses } from '../vad/vadModel';
import type { FileRunnerDeps, FileTranscriber } from './fileRunner';

const RATE = 16000;

export type PausesFn = typeof filePauses;

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

export function localPrepare(settings: () => SettingsData): FileRunnerDeps['prepare'] {
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
      const job = await FileJob.open(
        dir,
        kind,
        toSpeechDeviceKind(cur.SpeechDevice),
        toFileParallelism(cur.FileParallelism),
        toCtcScript(cur.CtcScript),
      );
      const onAbort = () => job.cancel();
      signal.addEventListener('abort', onAbort);
      try {
        const plan = job.plan;
        const planShown = t(plan.summaryRu, plan.summaryEn);
        const ranges = await fileRanges(cur, samples, { signal, onStart: () => status(t('Ищу паузы в речи…', 'Finding pauses in speech…')) });
        Log.write(
          `file parallel workers=${plan.workers} batch=${plan.batchSize} intra=${plan.intraOpThreads} gpu=${plan.useGpu} device=${job.deviceActual}/${job.provider} → ${planShown}`,
        );
        status(progressLine(0, ranges.length, 0, 0, planShown, t));
        const t0 = Date.now();
        const bits = await job.run(
          samples,
          ranges,
          (done, total, audioDone, wall) => status(progressLine(done, total, audioDone, wall, planShown, t)),
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
    };
    return { ok: true, transcriber };
  };
}
