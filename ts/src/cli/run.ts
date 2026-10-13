// `chawo-va transcribe`: the file queue without the window. Same decode chain (WAV / Ogg-Opus
// natively, ffmpeg for the rest — no Chromium here), same FileJob parallel plan and the same
// .txt/.srt writers as the «Расшифровка файла» page. Sessions are opened once per run and reused
// for every file. Everything is injected so tests run without a model.

import { basename, join } from 'node:path';
import { progressLine } from '../core/fileParallel';
import type { FileParallelismKind } from '../core/fileParallel';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../core/speechModels';
import { clock, fromTxt, toSrt, toTxt, type TranscriptSegment } from '../core/transcriptFormat';
import { writeExtras } from '../main/file/transcriptExport';
import { applyDiarization, type FileDiarizeHook } from '../main/file/fileRunner';
import { helpText, langFromArgv, parseArgs, type CliOptions } from './args';
import { HistoryStore, keepMs, type HistoryEntry, type HistoryKeep } from '../main/history/historyStore';
import { FILE_TIMEOUT_MS, failureText, logLine, runPostScript, scriptCommand, type PostScriptResult, type PostScriptRun } from '../core/postScript';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_NO_MODEL = 3;
export const EXIT_INTERRUPTED = 130;

const RATE = 16000;

export interface CliDefaults {
  model: SpeechModelKind;
  device: SpeechDeviceKind;
  threads: FileParallelismKind;
  script: CtcScript;
  timestamps: boolean;
  language: 'Auto' | 'Russian' | 'English';
  /** «Свой скрипт» from settings: PostScript when PostScriptFiles is on, else null. */
  postScript?: string | null;
  /** «История → Хранить»; entries older than it are not shown (the app deletes them). */
  historyKeep?: HistoryKeep;
  /** settings VadEnabled: Silero pauses for long files when its model is on disk (default true). */
  vad?: boolean;
  /** settings FileDiarize: «Разделять спикеров» (default false). */
  diarize?: boolean;
  /** settings FileUseBrain: «Прогнать через мозг» after the .txt (default false). */
  brain?: boolean;
  /** settings MeetingBriefEnabled: «Кратко и задачи» after the .txt (default false). */
  brief?: boolean;
}

export interface EngineConfig {
  dir: string;
  kind: SpeechModelKind;
  device: SpeechDeviceKind;
  threads: FileParallelismKind;
  script: CtcScript;
  /** Silero VAD pauses for long files (only when the model is on disk; never downloaded here). */
  vad: boolean;
}

export interface Engine {
  /** Short plan line, e.g. «Авто → 4× CPU». */
  readonly summary: string;
  readonly device: string;
  transcribe(
    samples: Float32Array,
    progress: (done: number, total: number, audioSec: number, wallSec: number) => void,
    signal: AbortSignal,
    /** One-off status lines, e.g. «Ищу паузы в речи…». */
    status?: (line: string) => void,
  ): Promise<TranscriptSegment[]>;
  dispose(): Promise<void>;
}

export interface BriefBrain {
  /** 'None' | 'Local' | 'Cloud' — same as FileBrain.target. */
  target: 'None' | 'Local' | 'Cloud';
  /** Saved MeetingBriefInstruction (may be empty → built-in default). */
  instruction: string;
  /** Where the text goes when it leaves this PC (cloud service / host), null = stays here. */
  cloud?: string | null;
  ask: (
    prompt: string,
    text: string,
    maxTokens: number,
    status: (line: string) => void,
    signal: AbortSignal,
  ) => Promise<string>;
}

/** «Прогнать через мозг» (FileBrain): the same target and ask as the File page. */
export interface FileBrainDep {
  target: 'None' | 'Local' | 'Cloud';
  /** Where the text goes when it leaves this PC, null = stays here. */
  cloud?: string | null;
  ask: BriefBrain['ask'];
}

export interface TranslateBrain {
  /** 'None' | 'Local' | 'Cloud' — same as FileBrain.target. */
  target: 'None' | 'Local' | 'Cloud';
  /** Saved TranslateTarget (may be empty → auto by the text). */
  to: string;
  ask: BriefBrain['ask'];
}

export interface CliDeps {
  version: string;
  out(text: string): void;
  err(text: string): void;
  /** stderr is a terminal: progress redraws one line. */
  isTTY: boolean;
  defaults(): CliDefaults;
  applyLanguage(choice: 'Auto' | 'Russian' | 'English'): void;
  t(ru: string, en: string): string;
  /** A complete model folder: the given one if it looks complete, else the app's usual places. */
  findModel(kind: SpeechModelKind, override: string | null): string | null;
  openEngine(cfg: EngineConfig): Promise<Engine>;
  load16k(path: string, signal: AbortSignal): Promise<Float32Array>;
  outputPath(source: string): string;
  /** .brief.txt path beside a transcript .txt. */
  briefOutputPath(transcriptTxt: string): string;
  /** .brain.txt path beside a transcript .txt. */
  brainOutputPath?(transcriptTxt: string): string;
  /** .translate.txt path beside a transcript .txt. */
  translateOutputPath(transcriptTxt: string): string;
  isDirectory(path: string): boolean;
  exists(path: string): boolean;
  collectFromFolder(folder: string): string[];
  mkdirp(dir: string): void;
  writeFile(path: string, data: string | Buffer): void;
  readFile(path: string): string;
  /** Brain for `brief` (Local / Server). Tests inject a fake ask. */
  briefBrain(): BriefBrain;
  /** Brain for `translate` (Local / Server). Tests inject a fake ask. */
  translateBrain(): TranslateBrain;
  /** Brain for `brain` / `transcribe --brain` (Local / Server). Tests inject a fake ask. */
  fileBrain?(): FileBrainDep;
  /**
   * Speaker diarization, the same hook as the page (`diarizeHook`): null when the models / sherpa-onnx
   * are not there (soft: the transcript is written without speakers). Tests inject a fake diarizer.
   */
  runDiarize?: FileDiarizeHook;
  /** «Свой скрипт» runner; defaults to core runPostScript (tests may inject). */
  runScript?: (r: PostScriptRun) => Promise<PostScriptResult>;
  /** history.jsonl of the app (read, never written by the CLI). */
  historyPath?: () => string;
  /** Wall clock for history dates (defaults to Date.now; `now` above may be a test counter). */
  clock?: () => number;
  log(line: string): void;
  now(): number;
  signal: AbortSignal;
}

export async function runCli(argv: readonly string[], d: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  let defaults: CliDefaults;
  try {
    defaults = d.defaults();
  } catch {
    defaults = { model: 'v3_e2e_rnnt', device: 'gpu', threads: 'auto', script: 'auto', timestamps: true, language: 'Auto' };
  }
  d.applyLanguage(langFromArgv(argv) ?? defaults.language);
  const t = d.t;

  if (!parsed.ok) {
    d.err(t(`chawo-va: ${parsed.error}\nСправка: chawo-va --help\n`, `chawo-va: ${parsed.error}\nSee: chawo-va --help\n`));
    return EXIT_USAGE;
  }
  const o = parsed.options;
  if (o.command === 'help') {
    d.out(helpText(t) + '\n');
    return EXIT_OK;
  }
  if (o.command === 'version') {
    d.out(`chawo-va ${d.version}\n`);
    return EXIT_OK;
  }
  if (o.command === 'brain') return brainCommand(o, d);
  if (o.command === 'brief') return brief(o, d);
  if (o.command === 'translate') return translate(o, d);
  if (o.command === 'history') return history(o, defaults, d);
  return transcribe(o, defaults, d);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}


const NO_BRAIN_RU = 'Ошибка: Мозг не настроен. Скачайте локальную модель на «Мозге» или укажите сервер в настройках.';
const NO_BRAIN_EN = 'Error: the Brain is not set up. Download a local model on Brain, or configure a server in settings.';

/** .brain.txt beside a transcript (FileBrain.outputPath shape) when the deps do not give one. */
function brainPath(d: CliDeps, txt: string): string {
  if (d.brainOutputPath) return d.brainOutputPath(txt);
  return txt.replace(/\.[^./\\]+$/, '') + '.brain.txt';
}

/**
 * `chawo-va brain <txt…>`: «Прогнать через мозг» for a finished transcript. The .txt is read back
 * into pieces ([hh:mm:ss] lines keep their start), then the same FileBrain pass as the page
 * (runWithAsk: paragraphs without filler words, unfaithful answers kept as-is, «Кратко»).
 */
async function brainCommand(o: CliOptions, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const fail = (line: string) => d.err(line + '\n');

  const picked = textInputs(o, d, fail);
  const files = picked.files;
  let failed = picked.failed;
  if (files.length === 0) return EXIT_FAILED;

  const brain = d.fileBrain?.() ?? null;
  if (!brain || brain.target === 'None') {
    fail(t(NO_BRAIN_RU, NO_BRAIN_EN));
    return EXIT_NO_MODEL;
  }
  if (brain.cloud) say(t(`Мозг: текст уходит в ${brain.cloud}`, `Brain: the text goes to ${brain.cloud}`));

  const FileBrain = await import('../main/brain/fileBrain');
  if (o.outDir && !o.stdout) d.mkdirp(o.outDir);

  for (let i = 0; i < files.length; i++) {
    if (d.signal.aborted) break;
    const src = files[i]!;
    const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : '';
    say(prefix + src);
    try {
      const parsed = fromTxt(d.readFile(src));
      const result = noAnswer(await FileBrain.runWithAsk(brain.target, parsed.segments, o.timestamps ?? parsed.timestamps, (line) => say(prefix + line), d.signal, brain.ask), t);
      const note = brainNote(result, t);
      if (o.stdout) {
        if (files.length > 1) d.out(`==> ${src} <==\n`);
        d.out(result.text.endsWith('\n') ? result.text : result.text + '\n');
        say(prefix + t('Готово', 'Done') + ` (${note})`);
      } else {
        const beside = brainPath(d, src);
        const out = o.outDir ? join(o.outDir, basename(beside)) : beside;
        d.writeFile(out, result.text);
        say(prefix + t(`Готово: ${out}`, `Done: ${out}`) + ` (${note})`);
      }
      d.log(`cli brain ${src} paragraphs=${result.paragraphs} kept=${result.keptAsIs}${result.summaryError ? ' summary failed' : ''}`);
    } catch (e) {
      if (d.signal.aborted) break;
      failed++;
      fail(prefix + t(`Ошибка: ${src}: ${message(e)}`, `Error: ${src}: ${message(e)}`));
      d.log(`cli brain ${src} failed: ${message(e)}`);
    }
  }

  if (d.signal.aborted) {
    fail(t('Прервано.', 'Interrupted.'));
    return EXIT_INTERRUPTED;
  }
  return failed > 0 ? EXIT_FAILED : EXIT_OK;
}

/**
 * Nothing came back at all (every paragraph kept as-is and «Кратко» failed — e.g. the server is
 * down): an error instead of a .brain.txt that only repeats the transcript.
 */
function noAnswer<R extends { paragraphs: number; keptAsIs: number; summaryError: string | null }>(r: R, t: CliDeps['t']): R {
  if (r.summaryError && r.keptAsIs >= r.paragraphs) throw new Error(t(`Мозг не ответил: ${r.summaryError}`, `the Brain did not answer: ${r.summaryError}`));
  return r;
}

/** Same words as the queue row on the page. */
function brainNote(r: { paragraphs: number; keptAsIs: number; summaryError: string | null }, t: CliDeps['t']): string {
  const base = r.keptAsIs > 0
    ? t(`мозг · абзацев ${r.paragraphs}, как есть ${r.keptAsIs}`, `brain · ${r.paragraphs} paragraphs, kept as-is ${r.keptAsIs}`)
    : t(`мозг · абзацев ${r.paragraphs}`, `brain · ${r.paragraphs} paragraphs`);
  return r.summaryError ? base + t(' · «Кратко» не получилось', ' · summary failed') : base;
}

/** .txt inputs for brain / brief / translate: no folders, must exist, no duplicates. */
function textInputs(o: CliOptions, d: CliDeps, fail: (line: string) => void): { files: string[]; failed: number } {
  const t = d.t;
  const files: string[] = [];
  let failed = 0;
  for (const input of o.inputs) {
    if (d.isDirectory(input)) {
      fail(t(`Ошибка: ${o.command} ждёт файл .txt, не папку: ${input}`, `Error: ${o.command} wants a .txt file, not a folder: ${input}`));
      failed++;
      continue;
    }
    if (!d.exists(input)) {
      fail(t(`Ошибка: такого файла нет: ${input}`, `Error: no such file: ${input}`));
      failed++;
      continue;
    }
    if (!files.includes(input)) files.push(input);
  }
  return { files, failed };
}

async function translate(o: CliOptions, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const fail = (line: string) => d.err(line + '\n');

  const picked = textInputs(o, d, fail);
  const files = picked.files;
  let failed = picked.failed;
  if (files.length === 0) return EXIT_FAILED;

  const brain = d.translateBrain();
  if (brain.target === 'None') {
    fail(
      t(
        'Ошибка: Мозг не настроен. Скачайте локальную модель на «Мозге» или укажите сервер в настройках.',
        'Error: the Brain is not set up. Download a local model on Brain, or configure a server in settings.',
      ),
    );
    return EXIT_NO_MODEL;
  }

  const Translate = await import('../main/brain/translate');
  if (o.outDir && !o.stdout) d.mkdirp(o.outDir);

  for (let i = 0; i < files.length; i++) {
    if (d.signal.aborted) break;
    const src = files[i]!;
    const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : '';
    say(prefix + src);
    try {
      const text = d.readFile(src);
      const result = await Translate.runTranslateAsync({
        targetKind: brain.target,
        text,
        to: o.to,
        saved: brain.to,
        status: (line) => say(prefix + line),
        signal: d.signal,
        ask: brain.ask,
      });
      if (o.stdout) {
        if (files.length > 1) d.out(`==> ${src} <==\n`);
        d.out(result.text.endsWith('\n') ? result.text : result.text + '\n');
      } else {
        const beside = d.translateOutputPath(src);
        const out = o.outDir ? join(o.outDir, basename(beside)) : beside;
        d.writeFile(out, result.text);
        say(prefix + t(`Готово: ${out}`, `Done: ${out}`));
      }
      d.log(`cli translate ${src} → ${result.target.code || result.target.name} ok`);
    } catch (e) {
      if (d.signal.aborted) break;
      failed++;
      fail(prefix + t(`Ошибка: ${src}: ${message(e)}`, `Error: ${src}: ${message(e)}`));
      d.log(`cli translate ${src} failed: ${message(e)}`);
    }
  }

  if (d.signal.aborted) {
    fail(t('Прервано.', 'Interrupted.'));
    return EXIT_INTERRUPTED;
  }
  return failed > 0 ? EXIT_FAILED : EXIT_OK;
}

async function brief(o: CliOptions, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const fail = (line: string) => d.err(line + '\n');

  const picked = textInputs(o, d, fail);
  const files = picked.files;
  let failed = picked.failed;
  if (files.length === 0) return EXIT_FAILED;

  const brain = d.briefBrain();
  if (brain.target === 'None') {
    fail(
      t(
        'Ошибка: Мозг не настроен. Скачайте локальную модель на «Мозге» или укажите сервер в настройках.',
        'Error: the Brain is not set up. Download a local model on Brain, or configure a server in settings.',
      ),
    );
    return EXIT_NO_MODEL;
  }

  // Lazy import keeps the CLI entry light when only transcribing.
  const { runBriefAsync } = await import('../main/brain/meetingBrief');
  const instruction = o.instruction ?? brain.instruction;

  if (o.outDir && !o.stdout) d.mkdirp(o.outDir);

  for (let i = 0; i < files.length; i++) {
    if (d.signal.aborted) break;
    const src = files[i]!;
    const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : '';
    say(prefix + src);
    try {
      const transcript = d.readFile(src);
      const result = await runBriefAsync({
        targetKind: brain.target,
        transcript,
        instruction,
        status: (line) => say(prefix + line),
        signal: d.signal,
        ask: brain.ask,
      });
      if (o.stdout) {
        if (files.length > 1) d.out(`==> ${src} <==\n`);
        d.out(result.text.endsWith('\n') ? result.text : result.text + '\n');
      } else {
        const beside = d.briefOutputPath(src);
        const out = o.outDir ? join(o.outDir, basename(beside)) : beside;
        d.writeFile(out, result.text);
        say(prefix + t(`Готово: ${out}`, `Done: ${out}`) + (result.warning ? ` (${result.warning})` : ''));
      }
      d.log(`cli brief ${src} ok`);
    } catch (e) {
      if (d.signal.aborted) break;
      failed++;
      fail(prefix + t(`Ошибка: ${src}: ${message(e)}`, `Error: ${src}: ${message(e)}`));
      d.log(`cli brief ${src} failed: ${message(e)}`);
    }
  }

  if (d.signal.aborted) {
    fail(t('Прервано.', 'Interrupted.'));
    return EXIT_INTERRUPTED;
  }
  return failed > 0 ? EXIT_FAILED : EXIT_OK;
}

export const HISTORY_DEFAULT_LIMIT = 20;

/** One entry as JSON Lines: plain fields, ts as ISO 8601. */
export function historyJson(e: HistoryEntry): string {
  return JSON.stringify({
    id: e.id,
    ts: new Date(e.ts).toISOString(),
    seconds: e.seconds,
    final: e.final,
    raw: e.raw,
    command: e.command,
    brain: e.brain,
    brainFailed: e.brainFailed,
  });
}

/**
 * `chawo-va history [words…]`: the «История» page from the command line. Same file, same search
 * (`matches`: every word, ё = е, over final/raw/command), same «Хранить» period, newest first.
 * Read-only: nothing is pruned or rewritten here; the app does that when the page is opened.
 */
async function history(o: CliOptions, defaults: CliDefaults, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const keep = defaults.historyKeep ?? 'Week';
  if (keep === 'Off') {
    say(t('История выключена («История → Хранить: Не хранить»), фраз нет.', 'History is off («History → Keep: Do not keep»); no phrases.'));
    return EXIT_OK;
  }
  if (!d.historyPath) {
    d.err(t('Ошибка: история недоступна.', 'Error: history is not available.') + '\n');
    return EXIT_FAILED;
  }
  const path = d.historyPath();
  const now = (d.clock ?? Date.now)();
  const cutoff = now - keepMs(keep);
  const fresh = (e: HistoryEntry) => e.ts >= cutoff;
  const query = o.inputs.join(' ').slice(0, 200);
  let all: HistoryEntry[];
  let total: number;
  try {
    const store = new HistoryStore(path, () => now);
    all = store.list(query).filter(fresh);
    total = query.trim() ? store.list('').filter(fresh).length : all.length;
  } catch (e) {
    d.err(t(`Ошибка: не читается ${path}: ${message(e)}`, `Error: cannot read ${path}: ${message(e)}`) + '\n');
    return EXIT_FAILED;
  }
  const limit = o.limit ?? HISTORY_DEFAULT_LIMIT;
  const shown = all.slice(0, limit);

  if (shown.length === 0) {
    say(query.trim()
      ? t(`Ничего не нашлось (всего фраз: ${total}).`, `Nothing found (${total} phrases in all).`)
      : t('Пока пусто: продиктуйте фразу в приложении.', 'Empty so far: dictate a phrase in the app.'));
    return EXIT_OK;
  }
  const { whenText } = await import('../main/history/historyPage');
  if (o.json) {
    for (const e of shown) d.out(historyJson(e) + '\n');
  } else {
    shown.forEach((e, i) => {
      const head = [whenText(e.ts, now, t), t(`${e.seconds.toFixed(1).replace('.', ',')} с`, `${e.seconds.toFixed(1)} s`)];
      if (e.brainFailed) head.push(t('Мозг не справился', 'Brain failed'));
      else if (e.brain) head.push(t('Мозг', 'Brain'));
      if (e.command) head.push(`«${e.command}»`);
      if (i > 0) d.out('\n');
      d.out(`— ${head.join(' · ')}\n${e.final}\n`);
      if (o.raw && e.raw.trim() && e.raw !== e.final) d.out(t(`  Распознано: ${e.raw}\n`, `  Recognized: ${e.raw}\n`));
    });
  }
  if (query.trim()) say(t(`Найдено ${all.length} из ${total}${shown.length < all.length ? `, показаны ${shown.length} (-n all — все)` : ''}.`,
    `Found ${all.length} of ${total}${shown.length < all.length ? `, showing ${shown.length} (-n all for every one)` : ''}.`));
  else if (shown.length < total) say(t(`Показаны последние ${shown.length} из ${total} (-n all — все).`, `Showing the last ${shown.length} of ${total} (-n all for every one).`));
  else say(t(`Всего фраз: ${total}.`, `${total} phrases.`));
  d.log(`cli history q=${query.trim() ? 'yes' : 'no'} shown=${shown.length} of ${total}`);
  return EXIT_OK;
}

async function transcribe(o: CliOptions, defaults: CliDefaults, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const fail = (line: string) => d.err(line + '\n');

  // Inputs: files as given, folders expanded (no recursion), duplicates dropped.
  const files: string[] = [];
  let failed = 0;
  for (const input of o.inputs) {
    if (d.isDirectory(input)) {
      const found = d.collectFromFolder(input);
      if (found.length === 0) {
        fail(t(`Ошибка: в папке ${input} нет аудиофайлов.`, `Error: no audio files in ${input}.`));
        failed++;
      }
      for (const f of found) if (!files.includes(f)) files.push(f);
    } else if (d.exists(input)) {
      if (!files.includes(input)) files.push(input);
    } else {
      fail(t(`Ошибка: такого файла нет: ${input}`, `Error: no such file: ${input}`));
      failed++;
    }
  }
  if (files.length === 0) return EXIT_FAILED;

  const formats = o.formats.length > 0 ? o.formats : (['txt'] as const);
  const timestamps = o.timestamps ?? defaults.timestamps;
  const script = o.noPostScript ? null : scriptCommand(o.postScript ?? defaults.postScript ?? null);
  const vad = o.vad ?? defaults.vad ?? true;
  const diarize = o.diarize ?? defaults.diarize ?? false;
  const useBrain = o.brain ?? defaults.brain ?? false;
  const useBrief = o.brief ?? defaults.brief ?? false;
  // Output collisions and --skip-existing are settled before any model is loaded.
  const targets = new Map<string, string>();
  const work: { src: string; txt: string; prefix: string }[] = [];
  files.forEach((src, i) => {
    const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : '';
    const beside = d.outputPath(src);
    const txt = o.outDir ? join(o.outDir, basename(beside)) : beside;
    if (!o.stdout) {
      const owner = targets.get(txt);
      if (owner) {
        fail(prefix + t(`Ошибка: ${src} — ${txt} уже пишет ${owner}.`, `Error: ${src} — ${txt} is already written for ${owner}.`));
        failed++;
        return;
      }
      targets.set(txt, src);
      if (o.skipExisting && d.exists(txt)) {
        say(prefix + t(`Пропуск, уже есть: ${txt}`, `Skipped, already there: ${txt}`));
        return;
      }
    }
    work.push({ src, txt, prefix });
  });
  if (work.length === 0) return failed > 0 ? EXIT_FAILED : EXIT_OK;

  const kind = o.model ?? defaults.model;
  const dir = d.findModel(kind, o.modelDir);
  if (!dir) {
    fail(
      o.modelDir
        ? t(`Ошибка: в ${o.modelDir} нет полной модели ${kind}.`, `Error: ${o.modelDir} has no complete ${kind} model.`)
        : t(
            'Ошибка: модели нет на диске. Откройте в приложении «Распознавание» и скачайте её, или укажите --model-dir.',
            'Error: the model is not on disk. Download it on the Speech page of the app, or pass --model-dir.',
          ),
    );
    return EXIT_NO_MODEL;
  }

  // «Прогнать через мозг» / «Кратко и задачи» after each .txt, like the page (FileUseBrain /
  // MeetingBriefEnabled). Soft: a missing or failing Brain is a note, the transcript still counts.
  const fileBrain = useBrain ? d.fileBrain?.() ?? null : null;
  const briefBrain = useBrief ? d.briefBrain() : null;
  const FileBrain = fileBrain && fileBrain.target !== 'None' ? await import('../main/brain/fileBrain') : null;
  const MeetingBrief = briefBrain && briefBrain.target !== 'None' ? await import('../main/brain/meetingBrief') : null;
  if (useBrain && !FileBrain) say(t('Мозг не настроен: .brain.txt не будет.', 'The Brain is not set up: no .brain.txt.'));
  if (useBrief && !MeetingBrief) say(t('Мозг не настроен: .brief.txt не будет.', 'The Brain is not set up: no .brief.txt.'));
  const cloud = (FileBrain ? fileBrain?.cloud : null) || (MeetingBrief ? briefBrain?.cloud : null);
  if (cloud) say(t(`Мозг: текст уходит в ${cloud}`, `Brain: the text goes to ${cloud}`));

  let engine: Engine | null = null;
  try {
    if (o.outDir && !o.stdout) d.mkdirp(o.outDir);
    say(t(`Модель: ${kind} · ${dir}`, `Model: ${kind} · ${dir}`));
    engine = await d.openEngine({
      dir,
      kind,
      device: o.device ?? defaults.device,
      threads: o.threads ?? defaults.threads,
      script: o.script ?? defaults.script,
      vad,
    });
    say(t(`Устройство: ${engine.device} · ${engine.summary}`, `Device: ${engine.device} · ${engine.summary}`));

    for (const { src, txt, prefix } of work) {
      if (d.signal.aborted) break;
      say(prefix + src);
      const t0 = d.now();
      try {
        const samples = await d.load16k(src, d.signal);
        if (samples.length === 0) throw new Error(t('В файле нет звука.', 'The file has no audio.'));
        let drawn = false;
        let segments = await engine.transcribe(
          samples,
          (done, total, audioSec, wallSec) => {
            if (o.quiet || !d.isTTY) return;
            d.err(`\r\x1b[2K${prefix}${progressLine(done, total, audioSec, wallSec, engine?.summary, t)}`);
            drawn = true;
          },
          d.signal,
          (line) => {
            if (drawn) d.err('\r\x1b[2K');
            drawn = false;
            say(prefix + line);
          },
        );
        if (drawn) d.err('\r\x1b[2K');
        if (d.signal.aborted) break;
        const notes = [clock(samples.length / RATE)];
        // «Разделять спикеров»: the same hook and assignSpeakers as the page; soft when models are missing.
        if (diarize) {
          const r = await applyDiarization(segments, samples, d.runDiarize, (line) => say(prefix + line), d.signal, src, t);
          if (d.signal.aborted) break;
          segments = r.segments;
          notes.push(r.note);
        }
        let text = toTxt(segments, timestamps);
        // «Кратко и задачи» gets the recognized text, as on the page (not the script's output).
        const recognized = text;
        if (script) {
          const res = await (d.runScript ?? runPostScript)({ command: script, text, source: 'file', file: src, timeoutMs: FILE_TIMEOUT_MS, signal: d.signal });
          if (d.signal.aborted) break;
          d.log(logLine(res, 'file', text.length));
          if (res.ok) {
            text = res.text;
            notes.push(t('скрипт', 'script'));
          } else {
            notes.push(t(`скрипт: ${failureText(res, t)}, .txt без него`, `script: ${failureText(res, t)}, .txt without it`));
          }
        }
        if (o.stdout) {
          if (files.length > 1) d.out(`==> ${src} <==\n`);
          d.out(text + '\n');
        } else {
          if ((formats as readonly string[]).includes('txt')) d.writeFile(txt, text);
          if ((formats as readonly string[]).includes('srt')) {
            d.writeFile(txt.replace(/\.txt$/i, '.srt'), toSrt(segments));
            notes.push('.srt');
          }
          // .vtt/.json/.md/.docx: the same writers as «Ещё сохранять рядом» on the page; built from
          // the segments, so «Свой скрипт» changes only the .txt there too.
          const extras = formats.filter((f): f is 'vtt' | 'json' | 'md' | 'docx' => f === 'vtt' || f === 'json' || f === 'md' || f === 'docx');
          if (extras.length > 0) {
            const res = writeExtras(txt, src, segments, samples.length / RATE, extras, timestamps, (p, data) => d.writeFile(p, data));
            notes.push(...res.written);
            for (const f of res.failed) {
              fail(prefix + t(`Ошибка: ${f}`, `Error: ${f}`));
              d.log(`cli ${src} export failed: ${f}`);
            }
            if (res.failed.length > 0) failed++;
          }
        }
        const status = (line: string) => say(prefix + line);
        if (useBrain) {
          if (!FileBrain || !fileBrain) notes.push(t('мозг не настроен', 'the Brain is not set up'));
          else {
            try {
              const r = noAnswer(await FileBrain.runWithAsk(fileBrain.target, segments, timestamps, status, d.signal, fileBrain.ask), t);
              if (o.stdout) d.out(`\n==> ${t('Мозг', 'Brain')} <==\n` + (r.text.endsWith('\n') ? r.text : r.text + '\n'));
              else d.writeFile(brainPath(d, txt), r.text);
              notes.push(brainNote(r, t) + (o.stdout ? '' : ' · .brain.txt'));
              d.log(`cli ${src} brain paragraphs=${r.paragraphs} kept=${r.keptAsIs}`);
            } catch (e) {
              if (d.signal.aborted) break;
              const m = message(e);
              notes.push(m.startsWith(t('Мозг не ответил', 'the Brain did not answer')) ? m : t(`мозг: ${m}`, `brain: ${m}`));
              d.log(`cli ${src} brain failed: ${message(e)}`);
            }
          }
        }
        if (useBrief) {
          if (!MeetingBrief || !briefBrain) notes.push(t('краткое: мозг не настроен', 'brief: the Brain is not set up'));
          else {
            try {
              const r = await MeetingBrief.runBriefAsync({
                targetKind: briefBrain.target,
                transcript: recognized,
                instruction: o.instruction ?? briefBrain.instruction,
                status,
                signal: d.signal,
                ask: briefBrain.ask,
              });
              if (o.stdout) d.out(`\n==> ${t('Кратко и задачи', 'Brief and tasks')} <==\n` + (r.text.endsWith('\n') ? r.text : r.text + '\n'));
              else d.writeFile(d.briefOutputPath(txt), r.text);
              notes.push(t('кратко и задачи', 'brief') + (o.stdout ? '' : ' · .brief.txt') + (r.warning ? ` (${r.warning})` : ''));
              d.log(`cli ${src} brief ok`);
            } catch (e) {
              if (d.signal.aborted) break;
              notes.push(t(`краткое: ${message(e)}`, `brief: ${message(e)}`));
              d.log(`cli ${src} brief failed: ${message(e)}`);
            }
          }
        }
        if (d.signal.aborted) break;
        const wall = (d.now() - t0) / 1000;
        notes.push(t(`${wall.toFixed(1)} с`, `${wall.toFixed(1)} s`));
        d.log(`cli ${src} audio=${(samples.length / RATE).toFixed(0)}s wall=${wall.toFixed(1)}s`);
        say(prefix + (o.stdout ? t('Готово', 'Done') : t(`Готово: ${txt}`, `Done: ${txt}`)) + ` (${notes.join(' · ')})`);
      } catch (e) {
        if (d.signal.aborted) break;
        failed++;
        fail(prefix + t(`Ошибка: ${src}: ${message(e)}`, `Error: ${src}: ${message(e)}`));
        d.log(`cli ${src} failed: ${message(e)}`);
      }
    }
  } catch (e) {
    if (!d.signal.aborted) {
      fail(t(`Ошибка: модель не загрузилась: ${message(e)}`, `Error: the model did not load: ${message(e)}`));
      d.log(`cli engine failed: ${message(e)}`);
      return EXIT_FAILED;
    }
  } finally {
    await engine?.dispose().catch(() => undefined);
  }

  if (d.signal.aborted) {
    fail(t('Прервано.', 'Interrupted.'));
    return EXIT_INTERRUPTED;
  }
  return failed > 0 ? EXIT_FAILED : EXIT_OK;
}
