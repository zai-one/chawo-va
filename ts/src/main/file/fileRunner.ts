// Runs the file queue: one file after another, files added during a run are picked up by the
// same run, the next file is decoded while the current one is recognized, one failure is
// skipped and the rest continue. Port of App.RunFileQueueAsync / RunQueue / RunOneFile.
//
// Everything platform-specific is injected (decoder, transcriber, settings, notifications),
// so the loop is unit-tested without a speech model and reused by a future CLI/server.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { clock, toSrt, toTxt, type TranscriptSegment } from '../../core/transcriptFormat';
import { t } from '../../core/strings';
import { FileQueue, type FileQueueItem } from './fileQueue';
import { MAX_BYTES, outputPath } from './fileTranscript';
import * as Log from '../log';

export interface FileRunOptions {
  timestamps: boolean;
  srt: boolean;
  /** Brain post-edit is not ported yet; when asked for, the row says so and the raw .txt is written. */
  useBrain: boolean;
}

/** Turns 16 kHz samples into segments. status() shows a progress line for the current file. */
export type FileTranscriber = (
  path: string,
  samples16k: Float32Array,
  status: (line: string) => void,
  signal: AbortSignal,
) => Promise<TranscriptSegment[]>;

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
      if (opts.useBrain) brainNote = t('мозг пока не перенесён', 'Brain not ported yet');
      const prep = await this.d.prepare();
      if (!prep.ok) {
        this.say(prep.message);
        return;
      }
      await this.loop(prep.transcriber, opts, brainNote, ctrl.signal);
    } catch (e) {
      if (isAbort(e, ctrl.signal)) {
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
        const peek = q.peekNext();
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

  /** Writes name.txt (and name.srt) beside the source. Returns the short note for the row. */
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

    const segments = await tr(item.path, samples, (line) => this.say(prefix + line), signal);
    if (signal.aborted) throw abortError();
    writeFileSync(out, toTxt(segments, opts.timestamps), 'utf8');
    const notes = [clock(samples.length / 16000)];
    if (opts.srt) {
      writeFileSync(out.replace(/\.txt$/i, '.srt'), toSrt(segments), 'utf8');
      notes.push('.srt');
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
