// The `chawo-va transcribe` engine over one FileJob: the same piece split as the «Расшифровка файла»
// page (`fileRanges`: Silero VAD pauses for long files when VadEnabled and the model is on disk, else
// the energy split), the same parallel run and segment builder. The job and the pause finder are
// injected so tests run without a model.

import type { FileJob } from '../core/fileJob';
import { fromRanges } from '../core/transcriptFormat';
import { fileRanges, type PausesFn } from '../main/file/localTranscriber';
import type { Engine } from './run';

const RATE = 16000;

export type JobLike = Pick<FileJob, 'plan' | 'deviceActual' | 'provider' | 'run' | 'cancel' | 'dispose'>;

export function engineFromJob(
  job: JobLike,
  opts: { vad: boolean; t: (ru: string, en: string) => string; pauses?: PausesFn },
): Engine {
  const t = opts.t;
  return {
    summary: t(job.plan.summaryRu, job.plan.summaryEn),
    device: `${job.deviceActual}/${job.provider}`,
    async transcribe(samples, progress, signal, status) {
      const onAbort = () => job.cancel();
      signal.addEventListener('abort', onAbort);
      try {
        const ranges = await fileRanges({ VadEnabled: opts.vad }, samples, {
          signal,
          pauses: opts.pauses,
          onStart: () => status?.(t('Ищу паузы в речи…', 'Finding pauses in speech…')),
        });
        progress(0, ranges.length, 0, 0);
        const bits = await job.run(samples, ranges, progress, signal);
        return fromRanges(ranges.map((r) => [r.from, r.to] as const), bits, RATE);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    dispose: () => job.dispose(),
  };
}
