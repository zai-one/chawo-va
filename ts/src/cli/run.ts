// `chawo-va transcribe`: the file queue without the window. Same decode chain (WAV / Ogg-Opus
// natively, ffmpeg for the rest — no Chromium here), same FileJob parallel plan and the same
// .txt/.srt writers as the «Расшифровка файла» page. Sessions are opened once per run and reused
// for every file. Everything is injected so tests run without a model.

import { basename, join } from 'node:path';
import { progressLine } from '../core/fileParallel';
import type { FileParallelismKind } from '../core/fileParallel';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../core/speechModels';
import { clock, toSrt, toTxt, type TranscriptSegment } from '../core/transcriptFormat';
import { helpText, langFromArgv, parseArgs, type CliOptions } from './args';

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
}

export interface EngineConfig {
  dir: string;
  kind: SpeechModelKind;
  device: SpeechDeviceKind;
  threads: FileParallelismKind;
  script: CtcScript;
}

export interface Engine {
  /** Short plan line, e.g. «Авто → 4× CPU». */
  readonly summary: string;
  readonly device: string;
  transcribe(
    samples: Float32Array,
    progress: (done: number, total: number, audioSec: number, wallSec: number) => void,
    signal: AbortSignal,
  ): Promise<TranscriptSegment[]>;
  dispose(): Promise<void>;
}

export interface BriefBrain {
  /** 'None' | 'Local' | 'Cloud' — same as FileBrain.target. */
  target: 'None' | 'Local' | 'Cloud';
  /** Saved MeetingBriefInstruction (may be empty → built-in default). */
  instruction: string;
  ask: (
    prompt: string,
    text: string,
    maxTokens: number,
    status: (line: string) => void,
    signal: AbortSignal,
  ) => Promise<string>;
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
  isDirectory(path: string): boolean;
  exists(path: string): boolean;
  collectFromFolder(folder: string): string[];
  mkdirp(dir: string): void;
  writeFile(path: string, text: string): void;
  readFile(path: string): string;
  /** Brain for `brief` (Local / Server). Tests inject a fake ask. */
  briefBrain(): BriefBrain;
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
  if (o.command === 'brief') return brief(o, d);
  return transcribe(o, defaults, d);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}


async function brief(o: CliOptions, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const fail = (line: string) => d.err(line + '\n');

  const files: string[] = [];
  let failed = 0;
  for (const input of o.inputs) {
    if (d.isDirectory(input)) {
      fail(t(`Ошибка: brief ждёт файл .txt, не папку: ${input}`, `Error: brief wants a .txt file, not a folder: ${input}`));
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
        const segments = await engine.transcribe(
          samples,
          (done, total, audioSec, wallSec) => {
            if (o.quiet || !d.isTTY) return;
            d.err(`\r\x1b[2K${prefix}${progressLine(done, total, audioSec, wallSec, engine?.summary, t)}`);
            drawn = true;
          },
          d.signal,
        );
        if (drawn) d.err('\r\x1b[2K');
        if (d.signal.aborted) break;
        const text = toTxt(segments, timestamps);
        const notes = [clock(samples.length / RATE)];
        if (o.stdout) {
          if (files.length > 1) d.out(`==> ${src} <==\n`);
          d.out(text + '\n');
        } else {
          if ((formats as readonly string[]).includes('txt')) d.writeFile(txt, text);
          if ((formats as readonly string[]).includes('srt')) {
            d.writeFile(txt.replace(/\.txt$/i, '.srt'), toSrt(segments));
            notes.push('.srt');
          }
        }
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
