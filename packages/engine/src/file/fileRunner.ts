// Runs the file queue: one file after another, files added during a run are picked up by the
// same run, the next file is decoded while the current one is recognized, one failure is
// skipped and the rest continue. Port of App.RunFileQueueAsync / RunQueue / RunOneFile.
//
// Everything platform-specific is injected (decoder, transcriber, settings, notifications),
// so the loop is unit-tested without a speech model and reused by a future CLI/server.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assignSpeakers, type DiarSpan } from '@chawo/core/diarize';
import { clock, toSrt, toTxt, type TranscriptSegment } from '@chawo/core/transcriptFormat';
import { t } from '@chawo/core/strings';
import { FileQueue, type FileQueueItem } from './fileQueue';
import { MAX_BYTES, outputPath } from './fileTranscript';
import { outputPath as brainOutputPath } from '../brain/fileBrain';
import { outputPath as briefOutputPath } from '../brain/meetingBrief';
import type { FileExtraFormat } from '../settings';
import { writeExtras } from './transcriptExport';
import * as Log from '../log';
import { FILE_TIMEOUT_MS, failureText, logLine, runPostScript, type PostScriptResult, type PostScriptRun } from '@chawo/core/postScript';

export interface FileRunOptions {
  timestamps: boolean;
  srt: boolean;
  /** .vtt / .json / .md / .docx beside the .txt (setting FileExtraFormats). */
  extra?: FileExtraFormat[];
  /** When true, try Brain post-edit after the raw .txt (via runBrain when provided). */
  useBrain: boolean;
  /** When true, run local speaker diarization after transcription (via runDiarize when ready). */
  diarize: boolean;
  /** When true, write name.brief.txt («Кратко и задачи») via runBrief when provided. */
  brief: boolean;
  /** When true, score the call against the selected checklist via runScore (writes .score.json/.txt). */
  score?: boolean;
  /** «Свой скрипт» for the .txt (settings PostScript with PostScriptFiles on); null/absent = off. */
  postScript?: string | null;
}

/** Turns 16 kHz samples into segments. status() shows a progress line for the current file. */
export type FileTranscriber = (
  path: string,
  samples16k: Float32Array,
  status: (line: string) => void,
  signal: AbortSignal,
) => Promise<TranscriptSegment[]>;

/**
 * Optional Brain post-edit after the raw .txt is written.
 * Return `text` to have the runner write name.brain.txt; `note` goes on the queue row.
 */
export type FileBrainHook = (
  segments: TranscriptSegment[],
  opts: FileRunOptions & { rawTxtPath: string },
  status: (line: string) => void,
  signal: AbortSignal,
) => Promise<{ note: string; text?: string }>;

/**
 * Optional local speaker diarization after transcription.
 * Return spans to assign; return null when models are missing (queue continues, status noted).
 */

/**
 * Optional «Кратко и задачи» after the raw .txt (and optional .brain.txt).
 * Return `text` to write name.brief.txt; failures should be soft (note only) so transcription still counts as Done.
 */
export type FileBriefHook = (
  segments: TranscriptSegment[],
  opts: FileRunOptions & { rawTxtPath: string },
  status: (line: string) => void,
  signal: AbortSignal,
) => Promise<{ note: string; text?: string }>;
export type FileDiarizeHook = (
  pcm: Float32Array,
  status: (line: string) => void,
  signal: AbortSignal,
) => Promise<DiarSpan[] | null>;

export interface FileRunnerDeps {
  queue: FileQueue;
  load16k: (path: string, signal?: AbortSignal) => Promise<Float32Array>;
  /** Called once per run, before the first file: opens nothing, just checks the model is there. */
  prepare: () => Promise<{ ok: true; transcriber: FileTranscriber } | { ok: false; message: string }>;
  options: () => FileRunOptions;
  status: (line: string, busy: boolean) => void;
  /** Long run finished: tray notification. lastOutput is the .txt to reveal on click. */
  notifyDone?: (title: string, body: string, ok: boolean, lastOutput: string | null) => void;
  now?: () => number;
  /** When useBrain is true, call this after writing the raw .txt. */
  runBrain?: FileBrainHook;
  /** When brief is true, call this after Brain (or after the raw .txt). */
  runBrief?: FileBriefHook;
  /** When score is true, call this last; the hook writes the .score files itself. */
  runScore?: FileBriefHook;
  /** When diarize is true, call this after local transcription and before writing .txt/.srt. */
  runDiarize?: FileDiarizeHook;
  /**
   * Errors that end the whole run (a dead remote host): returns the status line, else null. The file
   * is marked failed, the rest stays queued.
   */
  fatal?: (e: unknown) => string | null;
  /** «Свой скрипт» runner; defaults to core runPostScript. */
  runScript?: (r: PostScriptRun) => Promise<PostScriptResult>;
  /** Decode the next file while this one runs (WPF skips it in the Client role). Default true. */
  prefetch?: () => boolean;
}

export const NOTIFY_AFTER_MS = 60_000;

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (e instanceof Error && e.name === 'AbortError');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class FileRunner {
  private ctrl: AbortController | null = null;
  private lastStatus = '';

  constructor(private readonly d: FileRunnerDeps) {}

  get busy(): boolean {
    return this.ctrl !== null;
  }

  get status(): string {
    return this.lastStatus;
  }

  private say(line: string): void {
    this.lastStatus = line;
    this.d.status(line, this.busy);
  }

  /** «Остановить»: cancels the running file; finished .txt stay, the rest waits in the queue. */
  stop(): void {
    this.ctrl?.abort();
  }

  /** «Расшифровать». Resolves when the run ends (done, stopped or failed). */
  async run(): Promise<void> {
    const q = this.d.queue;
    if (q.queuedCount === 0) {
      this.say(t('Очередь пуста. Добавьте файлы или перетащите их в окно.', 'The queue is empty. Add files or drop them onto the window.'));
      return;
    }
    if (this.ctrl) {
      this.say(t('Уже идёт расшифровка — новые файлы пойдут следом.', 'Transcription is running; new files follow.'));
      return;
    }
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.say(t('Читаю файл…', 'Reading the file…'));
    try {
      const opts = this.d.options();
      let brainNote = '';
      if (opts.useBrain && !this.d.runBrain) {
        brainNote = t('мозг не настроен', 'the Brain is not set up');
      }
      const prep = await this.d.prepare();
      if (!prep.ok) {
        this.say(prep.message);
        return;
      }
      await this.loop(prep.transcriber, opts, brainNote, ctrl.signal);
    } catch (e) {
      const fatal = this.d.fatal?.(e) ?? null;
      if (fatal !== null && !ctrl.signal.aborted) {
        Log.write(`file run ended: ${message(e)}`);
        this.say(fatal);
      } else if (isAbort(e, ctrl.signal)) {
        q.markRunningStopped(t('остановлено', 'stopped'));
        this.say(t('Остановлено. Уже записанные .txt остаются, остальное ждёт в очереди.', 'Stopped. Finished .txt files stay; the rest waits in the queue.'));
      } else {
        Log.write(`file: ${message(e)}`);
        q.markRunningStopped(message(e));
        this.say(t(`Не получилось: ${message(e)}`, `Failed: ${message(e)}`));
      }
    } finally {
      this.ctrl = null;
      this.d.status(this.lastStatus, false);
    }
  }

  private async loop(tr: FileTranscriber, opts: FileRunOptions, brainNote: string, signal: AbortSignal): Promise<void> {
    const q = this.d.queue;
    const now = this.d.now ?? Date.now;
    const started = now();
    let ok = 0;
    let fail = 0;
    let lastOk: string | null = null;
    let ahead: { id: number; samples: Promise<Float32Array> } | null = null;

    for (;;) {
      if (signal.aborted) throw abortError();
      const item = q.takeNext();
      if (!item) break;
      const index = ok + fail + 1;
      const total = index + q.queuedCount;
      const prefix = total > 1 ? t(`Файл ${index} из ${total}: `, `File ${index} of ${total}: `) : '';
      try {
        let preloaded: Promise<Float32Array> | null = null;
        if (ahead) {
          if (ahead.id === item.id) preloaded = ahead.samples;
          else ahead.samples.catch(() => undefined); // prefetched file was removed: drop quietly
          ahead = null;
        }
        const peek = this.d.prefetch?.() === false ? null : q.peekNext();
        if (peek) {
          const p = this.d.load16k(peek.path, signal);
          p.catch(() => undefined); // surfaced when its turn comes
          ahead = { id: peek.id, samples: p };
        }
        let note = await this.one(item, prefix, preloaded, tr, opts, signal);
        if (brainNote) note = note ? `${note} · ${brainNote}` : brainNote;
        ok++;
        lastOk = outputPath(item.path);
        q.finish(item.id, 'Done', note, lastOk);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        const fatal = this.d.fatal?.(e) ?? null;
        if (fatal !== null) {
          q.finish(item.id, 'Failed', fatal);
          throw e;
        }
        fail++;
        Log.write(`file skip ${item.path}: ${message(e)}`);
        q.finish(item.id, 'Failed', message(e));
        this.say(prefix + t(`пропуск — ${message(e)}`, `skipped — ${message(e)}`));
      }
    }
    if (ok + fail > 1) {
      const tail = lastOk ? t(` Последний текст: ${lastOk}`, ` Last text: ${lastOk}`) : '';
      this.say(t(`Готово ${ok}, пропуск ${fail}.`, `Done ${ok}, skipped ${fail}.`) + tail);
    }
    if (this.d.notifyDone && now() - started >= NOTIFY_AFTER_MS && ok + fail > 0) {
      const title = fail === 0 ? t('Расшифровка готова', 'Transcription finished') : t('Расшифровка закончена с ошибками', 'Transcription finished with errors');
      let body =
        ok + fail === 1
          ? lastOk
            ? basename(lastOk)
            : t('Не получилось — подробности в окне.', 'Failed; see the window.')
          : t(`Готово ${ok}, пропуск ${fail}.`, `Done ${ok}, skipped ${fail}.`) + (lastOk ? ' ' + basename(lastOk) : '');
      if (lastOk) body += t(' Нажмите, чтобы открыть папку.', ' Click to open the folder.');
      this.d.notifyDone(title, body, fail === 0, lastOk);
    }
  }

  /** Writes name.txt (and name.srt, .vtt, .json, .md, .docx when chosen) beside the source. Returns the short note for the row. */
  private async one(
    item: FileQueueItem,
    prefix: string,
    preloaded: Promise<Float32Array> | null,
    tr: FileTranscriber,
    opts: FileRunOptions,
    signal: AbortSignal,
  ): Promise<string> {
    if (!existsSync(item.path)) throw new Error(t('Такого файла нет.', 'That file is not there.'));
    let size: number;
    try {
      size = statSync(item.path).size;
    } catch {
      throw new Error(t('Файл не открыть.', 'The file cannot be opened.'));
    }
    if (size > MAX_BYTES) throw new Error(t('Файл больше примерно 1,7 ГБ.', 'The file is over about 1.7 GB.'));

    const out = outputPath(item.path);
    this.say(prefix + t('Декодирую…', 'Decoding…'));
    const samples = await (preloaded ?? this.d.load16k(item.path, signal));
    if (signal.aborted) throw abortError();
    if (samples.length === 0) throw new Error(t('В файле нет звука.', 'The file has no audio.'));

    let segments = await tr(item.path, samples, (line) => this.say(prefix + line), signal);
    if (signal.aborted) throw abortError();

    const notes = [clock(samples.length / 16000)];
    if (opts.diarize) {
      const r = await applyDiarization(segments, samples, this.d.runDiarize, (line) => this.say(prefix + line), signal, item.path);
      segments = r.segments;
      notes.push(r.note);
    }

    let txt = toTxt(segments, opts.timestamps);
    if (opts.postScript) {
      this.say(prefix + t('Свой скрипт…', 'Your script…'));
      const res = await (this.d.runScript ?? runPostScript)({ command: opts.postScript, text: txt, source: 'file', file: item.path, timeoutMs: FILE_TIMEOUT_MS, signal });
      if (signal.aborted) throw abortError();
      Log.write(logLine(res, 'file', txt.length));
      if (res.ok) {
        txt = res.text;
        notes.push(t('скрипт', 'script'));
      } else {
        notes.push(t(`скрипт: ${failureText(res, t)}`, `script: ${failureText(res, t)}`));
      }
    }
    writeFileSync(out, txt, 'utf8');
    if (opts.srt) {
      writeFileSync(out.replace(/\.txt$/i, '.srt'), toSrt(segments), 'utf8');
      notes.push('.srt');
    }
    if (opts.extra?.length) {
      const res = writeExtras(out, item.path, segments, samples.length / 16000, opts.extra, opts.timestamps);
      notes.push(...res.written);
      for (const f of res.failed) {
        Log.write(`file export ${item.path}: ${f}`);
        notes.push(f);
      }
    }

    if (opts.useBrain && this.d.runBrain) {
      try {
        const brain = await this.d.runBrain(segments, { ...opts, rawTxtPath: out }, (line) => this.say(prefix + line), signal);
        if (brain.text != null && brain.text.length > 0) {
          writeFileSync(brainOutputPath(out), brain.text, 'utf8');
        }
        if (brain.note) notes.push(brain.note);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        const msg = message(e);
        Log.write(`file brain ${item.path}: ${msg}`);
        notes.push(msg);
      }
    }

    if (opts.brief && this.d.runBrief) {
      try {
        const brief = await this.d.runBrief(segments, { ...opts, rawTxtPath: out }, (line) => this.say(prefix + line), signal);
        if (brief.text != null && brief.text.length > 0) {
          writeFileSync(briefOutputPath(out), brief.text, 'utf8');
        }
        if (brief.note) notes.push(brief.note);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        const msg = message(e);
        Log.write(`file brief ${item.path}: ${msg}`);
        notes.push(msg);
      }
    }

    if (opts.score && this.d.runScore) {
      try {
        const sc = await this.d.runScore(segments, { ...opts, rawTxtPath: out }, (line) => this.say(prefix + line), signal);
        if (sc.note) notes.push(sc.note);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        const msg = message(e);
        Log.write(`file score ${item.path}: ${msg}`);
        notes.push(msg);
      }
    }

    this.say(prefix + t(`Готово: ${out}`, `Done: ${out}`));
    return notes.join(' · ');
  }
}

function abortError(): Error {
  const e = new Error('Operation canceled');
  e.name = 'AbortError';
  return e;
}

/**
 * Speakers onto the segments after transcription — the page and `chawo-va transcribe` share it.
 * Soft by design: no hook / models not downloaded / no spans / a backend error leave the segments as
 * they are and only say so in the note; an abort is rethrown.
 */
export async function applyDiarization(
  segments: TranscriptSegment[],
  samples: Float32Array,
  hook: FileDiarizeHook | undefined,
  status: (line: string) => void,
  signal: AbortSignal,
  source: string,
  tr: (ru: string, en: string) => string = t,
): Promise<{ segments: TranscriptSegment[]; note: string; ok: boolean }> {
  const missing = tr('спикеры: модели не скачаны', 'speakers: models not downloaded');
  if (!hook) return { segments, note: missing, ok: false };
  try {
    const spans = await hook(samples, status, signal);
    if (signal.aborted) throw abortError();
    if (spans === null) {
      Log.write(`file diarize ${source}: models not ready, no speakers`);
      return { segments, note: missing, ok: false };
    }
    if (spans.length === 0) return { segments, note: tr('спикеры: нет сегментов', 'speakers: no segments'), ok: false };
    return { segments: assignSpeakers(segments, spans), note: tr('спикеры', 'speakers'), ok: true };
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    const msg = message(e);
    Log.write(`file diarize ${source}: ${msg}`);
    return { segments, note: tr(`спикеры: ${msg}`, `speakers: ${msg}`), ok: false };
  }
}
