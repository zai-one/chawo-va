// How long-file transcription splits work across CPU workers or a GPU batch. Port of src/Core/FileParallel.cs.

import type { SpeechModelKind } from './speechModels';

/** "Скорость длинных записей": auto, 1, 2, 4, max. */
export type FileParallelismKind = 'auto' | 1 | 2 | 4 | 'max';

export interface FileParallelPlan {
  workers: number;
  batchSize: number;
  intraOpThreads: number;
  useGpu: boolean;
  encoderBatch: boolean;
  kind: FileParallelismKind;
  summaryRu: string;
  summaryEn: string;
}

const MB = 1024 * 1024;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Rough resident set of one inference session set, so Auto does not spawn more workers than RAM allows. */
export const estimateSessionBytes = (kind: SpeechModelKind): number => (kind === 'v3_e2e_rnnt' ? 550 * MB : 2800 * MB);

export function resolvePlan(
  kind: FileParallelismKind,
  useGpu: boolean,
  encoderAcceptsBatch: boolean,
  model: SpeechModelKind,
  cores: number,
  availableBytes: number,
): FileParallelPlan {
  cores = Math.max(1, cores);
  const auto = kind === 'auto';
  const asked = kind === 'max' ? (useGpu ? 8 : cores) : auto ? 0 : kind;

  if (useGpu) {
    let batch = auto ? (encoderAcceptsBatch ? 4 : 1) : asked;
    if (!encoderAcceptsBatch) batch = 1;
    batch = clamp(batch, 1, 8);
    return {
      workers: 1,
      batchSize: batch,
      intraOpThreads: Math.min(4, cores),
      useGpu: true,
      encoderBatch: encoderAcceptsBatch && batch > 1,
      kind,
      summaryRu: auto ? `Авто → пакет ${batch}` : `пакет ${batch}`,
      summaryEn: auto ? `Auto → batch ${batch}` : `batch ${batch}`,
    };
  }

  let workers = auto ? clamp(Math.floor(cores / 2), 1, 4) : Math.max(1, asked);
  const per = estimateSessionBytes(model);
  // Keep about 1.2 GB for the OS, the UI and a warm dictation session.
  const budget = Math.max(per, availableBytes - 1200 * MB);
  const byRam = Math.max(1, Math.floor(budget / Math.max(1, per)));
  workers = clamp(Math.min(workers, byRam), 1, cores);
  return {
    workers,
    batchSize: 1,
    intraOpThreads: Math.max(1, Math.floor(cores / workers)),
    useGpu: false,
    encoderBatch: false,
    kind,
    summaryRu: auto ? `Авто → ${workers}× CPU` : `${workers}× CPU`,
    summaryEn: auto ? `Auto → ${workers}× CPU` : `${workers}× CPU`,
  };
}

/** C# "0.#" formatting: at most one decimal, no trailing zero. */
const oneDecimal = (x: number) => String(Math.round(x * 10) / 10);
const d2 = (n: number) => String(n).padStart(2, '0');

/** Progress line body after the optional file prefix. t(ru, en) picks the UI language. */
export function progressLine(
  done: number,
  total: number,
  audioSecondsDone: number,
  wallSeconds: number,
  planSummary: string | null | undefined,
  t: (ru: string, en: string) => string,
): string {
  done = clamp(done, 0, Math.max(0, total));
  const rtf = wallSeconds > 0.05 && audioSecondsDone > 0 ? audioSecondsDone / wallSeconds : 0;
  let left = '';
  if (rtf > 0.05 && done > 0 && done < total && total > 0) {
    const audioLeft = (total - done) * (audioSecondsDone / done);
    const secLeft = audioLeft / rtf;
    const mm = Math.trunc(secLeft / 60);
    const ss = Math.trunc(secLeft % 60);
    left = t(` · осталось ~${d2(mm)}:${d2(ss)}`, ` · ~${d2(mm)}:${d2(ss)} left`);
  }
  const speed = rtf > 0.05 ? t(` · ${oneDecimal(rtf)}× быстрее реального времени`, ` · ${oneDecimal(rtf)}× faster than real time`) : '';
  const pick = planSummary ? ` · ${planSummary}` : '';
  return t(`Кусок ${done} из ${total}`, `Piece ${done} of ${total}`) + speed + left + pick;
}
