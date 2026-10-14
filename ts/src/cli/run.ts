// `chawo-va transcribe`: the file queue without the window. Same decode chain (WAV / Ogg-Opus
// natively, ffmpeg for the rest — no Chromium here), same FileJob parallel plan and the same
// .txt/.srt writers as the «Расшифровка файла» page. Sessions are opened once per run and reused
// for every file. Everything is injected so tests run without a model.

import { basename, join } from 'node:path';
import { clip, contextBlock, withContext, CONTEXT_MAX_CHARS } from '../core/brainContext';
import { progressLine } from '../core/fileParallel';
import type { FileParallelismKind } from '../core/fileParallel';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../core/speechModels';
import { computeCallStats, formatCallStats, parseTrackers } from '../core/callStats';
import { clock, fromTxt, loadTimedTranscript, srtTime, toSrt, toTxt, type TranscriptSegment } from '../core/transcriptFormat';
import { writeExtras } from '../main/file/transcriptExport';
import { applyDiarization, type FileDiarizeHook } from '../main/file/fileRunner';
import { helpText, langFromArgv, parseArgs, type CliOptions } from './args';
import { runServe, type ServeDeps } from './serveRun';
import { transcribeViaServer } from './serveClient';
import { HistoryStore, keepMs, type HistoryEntry, type HistoryKeep } from '../main/history/historyStore';
import { isLinkInput, parseMediaUrl } from '../core/mediaUrl';
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
  /** settings CallScoreEnabled: «Проверка по чек-листу» after the .txt (default false). */
  score?: boolean;
  /** settings CallScoreChecklist: the checklist picked in the app ('' = built-in sales). */
  checklist?: string;
  /** settings CallTrackers: «Название: термин, …» per line; '' = built-in trackers. */
  callTrackers?: string;
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
  /** yt-dlp for `transcribe <link>` (the app's tools/yt-dlp, then PATH); null = none. Never downloaded here. */
  findYtDlp?(): string | null;
  /** Runs yt-dlp for one link (same as «По ссылке» on the page); resolves with the saved audio path. */
  fetchAudio?(url: string, outDir: string, progress: (percent: number) => void, signal: AbortSignal): Promise<string>;
  /** Where link audio is saved without --out: Downloads/Chawo, like the page. */
  urlFolder?(): string;
  /** «Свой скрипт» runner; defaults to core runPostScript (tests may inject). */
  runScript?: (r: PostScriptRun) => Promise<PostScriptResult>;
  /** snippets.json of the app (read and written by `chawo-va snippets`). */
  snippetsPath?: () => string;
  /** learned-words.json of the app (`chawo-va dictionary`, the «Из исправлений» block). */
  learnedPath?: () => string;
  /** settings.json of the app: `chawo-va dictionary` only reads WordReplacementRules in it. */
  settingsFile?: () => string;
  /** crm.json (settings + tokens) and crm-sent.json for `chawo-va crm`. */
  crmConfigPath?: () => string;
  crmSentPath?: () => string;
  /** HTTP for `crm send`; tests inject a mock. */
  crmFetch?: import('../core/crm').Fetch;
  /** SSRF check before `crm send` (tests stub it; default resolves DNS). */
  crmCheckHost?: (url: string) => Promise<string>;
  /** stdin is a terminal: `crm send` may ask «Отправить?». */
  stdinIsTTY?: boolean;
  /** One y/N question on the terminal. */
  ask?: (question: string) => Promise<boolean>;
  /** Whole stdin as text (for `snippets add <trigger> -`). */
  readStdin?: () => Promise<string>;
  /** Custom «Кратко и задачи» templates (brief-templates.json, read-only here). */
  briefTemplates?: () => import('../main/brain/briefTemplates').CustomTemplate[];
  /** Brain for `ask` (Local / Server), the same target as brief. Tests inject a fake ask. */
  askBrain?(): FileBrainDep;
  /** Default `ask` folders: the meetings folder(s) plus Settings.AskFolders. */
  askFolders?(): string[];
  /** Custom call checklists (checklists.json, read-only here). */
  checklists?: () => import('../main/brain/callScore').CustomChecklist[];
  /** history.jsonl of the app (read, never written by the CLI). */
  historyPath?: () => string;
  /** Auto-detect settings for `chawo-va meeting detect` (from settings.json, read-only). */
  meetingDetectSettings?: () => {
    MeetingAutoDetectApps: boolean;
    MeetingAutoDetectCalendar: string;
  };
  /** Injected process listing for meeting detect tests. */
  meetingExec?: import('../main/meeting/meetingApps').ExecLike;
  meetingPlatform?: NodeJS.Platform;
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
  if (o.command === 'score') return scoreCommand(o, defaults, d);
  if (o.command === 'translate') return translate(o, d);
  if (o.command === 'history') return history(o, defaults, d);
  if (o.command === 'ask') return askCommand(o, defaults, d);
  if (o.command === 'segments') return segmentsCommand(o, d);
  if (o.command === 'stats') return statsCommand(o, defaults, d);
  if (o.command === 'snippets') return snippetsCommand(o, d);
  if (o.command === 'dictionary') return dictionaryCommand(o, d);
  if (o.command === 'crm') return (await import('./crmCommand')).crmCommand(o.inputs, d);
  if (o.command === 'meeting') return meetingCommand(o, d);
  if (o.command === 'serve') {
    const serveDeps: ServeDeps = {
      t: d.t,
      out: d.out,
      err: d.err,
      findModel: d.findModel,
      log: d.log,
      signal: d.signal,
    };
    return runServe(o, serveDeps);
  }
  if (o.command === 'transcribe' && o.server) return transcribeViaServer(o, defaults, d);
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

  const ctx = cliContext(o, d, brain.cloud, say, fail);
  if (ctx === null) return EXIT_FAILED;
  const ask = withContext(brain.ask, ctx);

  const FileBrain = await import('../main/brain/fileBrain');
  if (o.outDir && !o.stdout) d.mkdirp(o.outDir);

  for (let i = 0; i < files.length; i++) {
    if (d.signal.aborted) break;
    const src = files[i]!;
    const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : '';
    say(prefix + src);
    try {
      const parsed = fromTxt(d.readFile(src));
      const result = noAnswer(await FileBrain.runWithAsk(brain.target, parsed.segments, o.timestamps ?? parsed.timestamps, (line) => say(prefix + line), d.signal, ask), t);
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
 * «Контекст для Мозга» from --context / --context-file: the fenced block ('' without a flag), or null
 * when the file cannot be read (already reported). Says how much goes and where (cloud).
 */
function cliContext(o: CliOptions, d: CliDeps, cloud: string | null | undefined, say: (l: string) => void, fail: (l: string) => void): string | null {
  const t = d.t;
  let text = o.context;
  if (o.contextFile != null) {
    try {
      text = d.readFile(o.contextFile);
    } catch (e) {
      fail(t(`Не прочитать --context-file: ${o.contextFile}: ${message(e)}`, `Cannot read --context-file: ${o.contextFile}: ${message(e)}`));
      return null;
    }
  }
  const block = contextBlock({ text });
  if (block) {
    const n = clip(text, CONTEXT_MAX_CHARS).length;
    say(cloud
      ? t(`Контекст для Мозга: ${n} знаков, уходит в ${cloud}`, `Brain context: ${n} characters, goes to ${cloud}`)
      : t(`Контекст для Мозга: ${n} знаков`, `Brain context: ${n} characters`));
  }
  return block;
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

/** --template: 'list' prints every template; a name gives its instruction; unknown → null (usage error printed). */
async function templateInstruction(o: CliOptions, d: CliDeps): Promise<{ list: true } | { instruction: string | null } | null> {
  if (o.template == null) return { instruction: null };
  const T = await import('../main/brain/briefTemplates');
  const custom = d.briefTemplates?.() ?? [];
  if (o.template.toLowerCase() === 'list') {
    for (const x of T.allTemplates(custom)) d.out(`${x.builtin ? x.id : x.name}\t${x.builtin ? x.name : d.t('свой', 'custom')}\n`);
    return { list: true };
  }
  const tpl = T.findTemplate(o.template, custom);
  if (!tpl) {
    const names = T.allTemplates(custom).map((x) => (x.builtin ? x.id : x.name)).join(', ');
    d.err(d.t(`chawo-va: нет шаблона «${o.template}». Есть: ${names}\n`, `chawo-va: no template «${o.template}». Available: ${names}\n`));
    return null;
  }
  d.log(`cli brief template ${tpl.builtin ? tpl.id : 'custom'}`);
  return { instruction: tpl.instruction };
}

/** --checklist: 'list' prints them; a name (or the app's pick) gives the checklist; unknown → null (usage error printed). */
async function pickChecklist(o: CliOptions, defaults: CliDefaults, d: CliDeps): Promise<{ list: true } | { checklist: import('../main/brain/callScore').Checklist } | null> {
  const C = await import('../main/brain/callScore');
  const custom = d.checklists?.() ?? [];
  if (o.checklist != null && o.checklist.toLowerCase() === 'list') {
    for (const x of C.allChecklists(custom)) d.out(`${x.builtin ? x.id : x.name}\t${x.builtin ? x.name : d.t('свой', 'custom')}\t${x.items.length}\n`);
    return { list: true };
  }
  if (o.checklist == null) return { checklist: C.resolveChecklist(defaults.checklist ?? '', custom) };
  const c = C.findChecklist(o.checklist, custom);
  if (!c) {
    const names = C.allChecklists(custom).map((x) => (x.builtin ? x.id : x.name)).join(', ');
    d.err(d.t(`chawo-va: нет чек-листа «${o.checklist}». Есть: ${names}\n`, `chawo-va: no checklist «${o.checklist}». Available: ${names}\n`));
    return null;
  }
  return { checklist: c };
}

async function scoreCommand(o: CliOptions, defaults: CliDefaults, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const fail = (line: string) => d.err(line + '\n');
  const picked = await pickChecklist(o, defaults, d);
  if (!picked) return EXIT_USAGE;
  if ('list' in picked) return EXIT_OK;
  const checklist = picked.checklist;

  const inputs = textInputs(o, d, fail);
  let failed = inputs.failed;
  if (inputs.files.length === 0) return EXIT_FAILED;
  const brain = d.briefBrain();
  if (brain.target === 'None') {
    fail(t('Ошибка: Мозг не настроен. Скачайте локальную модель на «Мозге» или укажите сервер в настройках.', 'Error: the Brain is not set up. Download a local model on Brain, or configure a server in settings.'));
    return EXIT_NO_MODEL;
  }
  if (brain.cloud) say(t(`Мозг: текст уходит в ${brain.cloud}`, `Brain: the text goes to ${brain.cloud}`));
  const C = await import('../main/brain/callScore');
  if (o.outDir && !o.stdout) d.mkdirp(o.outDir);
  const files = inputs.files;
  for (let i = 0; i < files.length; i++) {
    if (d.signal.aborted) break;
    const src = files[i]!;
    const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : '';
    say(prefix + src + ' · ' + checklist.name);
    try {
      const r = await C.scoreAsync({ transcript: d.readFile(src), checklist, targetKind: brain.target, ask: brain.ask, status: (line) => say(prefix + line), signal: d.signal, source: src });
      if (o.stdout) {
        if (files.length > 1 && !o.json) d.out(`==> ${src} <==\n`);
        d.out(o.json ? JSON.stringify(r) + '\n' : C.formatText(r));
      } else {
        const beside = C.outputPaths(src);
        const at = (p: string) => (o.outDir ? join(o.outDir, basename(p)) : p);
        d.writeFile(at(beside.json), JSON.stringify(r, null, 2) + '\n');
        d.writeFile(at(beside.txt), C.formatText(r));
        say(prefix + t(`Готово: ${at(beside.txt)} — ${r.score} из ${r.max} (${r.percent}%)`, `Done: ${at(beside.txt)} — ${r.score} of ${r.max} (${r.percent}%)`));
      }
      d.log(`cli score ${src} ok ${r.percent}%`);
    } catch (e) {
      if (d.signal.aborted) break;
      failed++;
      fail(prefix + t(`Ошибка: ${src}: ${message(e)}`, `Error: ${src}: ${message(e)}`));
      d.log(`cli score ${src} failed: ${message(e)}`);
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
  const tpl = await templateInstruction(o, d);
  if (!tpl) return EXIT_USAGE;
  if ('list' in tpl) return EXIT_OK;
  if (tpl.instruction) o = { ...o, instruction: tpl.instruction };

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

/**
 * `chawo-va segments <file…>`: print timed phrases from a finished transcript (.srt / .json / timed .txt).
 * Same parsers as the File page «Расшифровка» card. Playback stays GUI-only.
 */
async function segmentsCommand(o: CliOptions, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  let failed = 0;
  let printed = 0;
  for (const input of o.inputs) {
    if (!d.exists(input)) {
      d.err(t(`Ошибка: нет файла ${input}`, `Error: no such file ${input}`) + '\n');
      failed++;
      continue;
    }
    const loaded = loadTimedTranscript(input, (p) => {
      try {
        return d.exists(p) ? d.readFile(p) : null;
      } catch {
        return null;
      }
    });
    if (!loaded.available) {
      const why =
        loaded.reason === 'no-timings'
          ? t('нет меток времени (включите .srt / метки в .txt)', 'no timings (enable .srt / timestamps in .txt)')
          : loaded.reason === 'empty'
            ? t('файл пуст', 'file is empty')
            : loaded.reason === 'bad'
              ? t('не удалось прочитать JSON', 'could not parse JSON')
              : t('файл не найден', 'file not found');
      d.err(t(`Ошибка: ${input}: ${why}`, `Error: ${input}: ${why}`) + '\n');
      failed++;
      continue;
    }
    if (o.inputs.length > 1) say(t(`— ${input} (${loaded.sourceHint})`, `— ${input} (${loaded.sourceHint})`));
    for (const seg of loaded.segments) {
      if (o.json) {
        const row: Record<string, unknown> = { start: seg.start, end: seg.end, text: seg.text };
        if (typeof seg.speaker === 'number') row.speaker = seg.speaker + 1;
        d.out(JSON.stringify(row) + '\n');
      } else {
        const sp = typeof seg.speaker === 'number' ? t(`Спикер ${seg.speaker + 1}: `, `Speaker ${seg.speaker + 1}: `) : '';
        d.out(`${srtTime(seg.start)} → ${srtTime(seg.end)}  ${sp}${seg.text}\n`);
      }
      printed++;
    }
  }
  if (printed > 0) say(t(`Фраз: ${printed}.`, `${printed} phrases.`));
  d.log(`cli segments files=${o.inputs.length} phrases=${printed} failed=${failed}`);
  if (failed > 0 && printed === 0) return EXIT_FAILED;
  return failed > 0 ? EXIT_FAILED : EXIT_OK;
}

/** Why a timed transcript could not be read, in the message language. */
function timedReason(reason: string, t: (ru: string, en: string) => string): string {
  return reason === 'no-timings'
    ? t('нет меток времени (включите .srt / метки в .txt)', 'no timings (enable .srt / timestamps in .txt)')
    : reason === 'empty'
      ? t('файл пуст', 'file is empty')
      : reason === 'bad'
        ? t('не удалось прочитать JSON', 'could not parse JSON')
        : t('файл не найден', 'file not found');
}

/**
 * `chawo-va stats <file…>`: «Статистика разговора» from the command line — talk ratio per speaker,
 * monologues, questions, pace and keyword trackers. Same parsers and numbers as the File page card.
 * --track replaces the trackers from settings (CallTrackers; empty = built-in). Read-only.
 */
async function statsCommand(o: CliOptions, defaults: CliDefaults, d: CliDeps): Promise<number> {
  const t = d.t;
  const trackers = parseTrackers(o.track.length > 0 ? o.track.join('\n') : defaults.callTrackers ?? '');
  let failed = 0;
  let done = 0;
  for (const input of o.inputs) {
    if (!d.exists(input)) {
      d.err(t(`Ошибка: нет файла ${input}`, `Error: no such file ${input}`) + '\n');
      failed++;
      continue;
    }
    const loaded = loadTimedTranscript(input, (p) => {
      try {
        return d.exists(p) ? d.readFile(p) : null;
      } catch {
        return null;
      }
    });
    if (!loaded.available) {
      d.err(t(`Ошибка: ${input}: ${timedReason(loaded.reason, t)}`, `Error: ${input}: ${timedReason(loaded.reason, t)}`) + '\n');
      failed++;
      continue;
    }
    const st = computeCallStats(loaded.segments, trackers);
    if (o.json) {
      // One JSON object per file (JSON Lines); speakers 1-based like «Спикер N», null = no labels.
      const out = {
        file: input,
        source: loaded.sourceHint,
        ...st,
        speakers: st.speakers.map((s) => ({ ...s, speaker: s.speaker < 0 ? null : s.speaker + 1, share: Math.round(s.share * 1000) / 1000 })),
        longestMonologue: st.longestMonologue ? { ...st.longestMonologue, speaker: st.longestMonologue.speaker < 0 ? null : st.longestMonologue.speaker + 1 } : null,
        trackers: st.trackers.map((r) => ({ ...r, hits: r.hits.map((h) => ({ ...h, speaker: typeof h.speaker === 'number' ? h.speaker + 1 : null })) })),
      };
      d.out(JSON.stringify(out) + '\n');
    } else {
      if (o.inputs.length > 1) d.out(`— ${input}\n`);
      d.out(formatCallStats(st, t, { hits: o.hits }));
      if (o.inputs.length > 1) d.out('\n');
    }
    done++;
  }
  d.log(`cli stats files=${o.inputs.length} done=${done} failed=${failed} trackers=${trackers.length}`);
  return failed > 0 ? EXIT_FAILED : EXIT_OK;
}

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

/**
 * `chawo-va ask <вопрос…>`: «Спросить историю» from the command line. Local search over the
 * dictation phrases (within «Хранить») and transcripts (meetings folder + AskFolders, or --in);
 * the Brain gets only the question and the found excerpts. --search, or no Brain: excerpts only.
 */
async function askCommand(o: CliOptions, defaults: CliDefaults, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const question = o.inputs.join(' ').trim();
  const Ask = await import('../core/askHistory');
  const Sources = await import('../main/history/askSources');

  let history: HistoryEntry[] = [];
  const keep = defaults.historyKeep ?? 'Week';
  if (!o.noHistory && keep !== 'Off' && d.historyPath) {
    const now = (d.clock ?? Date.now)();
    try {
      history = new HistoryStore(d.historyPath(), () => now).list('').filter((e) => e.ts >= now - keepMs(keep));
    } catch (e) {
      say(t(`История не читается: ${message(e)}`, `History cannot be read: ${message(e)}`));
    }
  }
  const folders = o.askIn.length > 0 ? o.askIn : (d.askFolders?.() ?? []);
  for (const f of o.askIn) if (!d.exists(f)) say(t(`Нет такой папки или файла: ${f}`, `No such folder or file: ${f}`));
  const sources = Sources.loadSources({ history, inputs: folders }, t);
  if (sources.length === 0) {
    d.err(t('Искать негде: нет фраз диктовки и расшифровок (папка встреч пуста; добавьте папку через --in).',
      'Nothing to search: no dictation phrases and no transcripts (the meetings folder is empty; add a folder with --in).') + '\n');
    return EXIT_FAILED;
  }

  const brain = o.searchOnly ? null : (d.askBrain ?? d.fileBrain)?.() ?? null;
  const useBrain = brain && brain.target !== 'None' ? brain : null;
  if (!o.searchOnly && !useBrain) say(t('Мозг не настроен: покажу найденные отрывки.', 'The Brain is not set up: showing the found excerpts.'));
  if (useBrain?.cloud) say(t(`Вопрос и найденные отрывки уйдут в ${useBrain.cloud}.`, `The question and the found excerpts will go to ${useBrain.cloud}.`));
  const budget = useBrain?.target === 'Cloud' ? Ask.CLOUD_CONTEXT_CHARS : Ask.LOCAL_CONTEXT_CHARS;

  let r: import('../core/askHistory').AskResult;
  try {
    r = await Ask.runAsk({
      question,
      sources,
      ask: useBrain ? useBrain.ask : null,
      budget,
      top: o.limit ?? Ask.DEFAULT_TOP,
      status: (line) => say(line),
      signal: d.signal,
    });
  } catch (e) {
    if (d.signal.aborted) {
      d.err(t('Прервано.', 'Interrupted.') + '\n');
      return EXIT_INTERRUPTED;
    }
    d.err(t(`Ошибка: Мозг не ответил: ${message(e)}`, `Error: the Brain did not answer: ${message(e)}`) + '\n');
    d.log(`cli ask failed: ${message(e)}`);
    return EXIT_FAILED;
  }
  d.log(`cli ask sources=${r.sources} passages=${r.passages} excerpts=${r.excerpts.length} brain=${r.answer ? 'yes' : 'no'}`);

  if (o.json) {
    d.out(JSON.stringify({
      question: r.question,
      answer: r.answer,
      cited: r.cited,
      excerpts: r.excerpts.map((e) => ({ n: e.n, source: e.title, kind: e.kind, date: e.when ? new Date(e.when).toISOString() : null, path: e.path, score: e.score, text: e.text })),
      searched: { sources: r.sources, passages: r.passages },
    }, null, 2) + '\n');
    return EXIT_OK;
  }
  if (r.excerpts.length === 0) {
    say(t(`Ничего не нашлось (просмотрено источников: ${r.sources}).`, `Nothing found (${r.sources} sources searched).`));
    return EXIT_OK;
  }
  if (r.answer) d.out(r.answer + '\n\n' + t('Источники:', 'Sources:') + '\n');
  const shown = r.answer && r.cited.length > 0 ? r.excerpts.filter((e) => r.cited.includes(e.n)) : r.excerpts;
  for (const e of shown) {
    const when = Ask.dateText(e.when);
    const head = `[${e.n}] ${e.title}${when ? ` · ${when}` : ''}${e.path ? ` · ${e.path}` : ''}`;
    if (r.answer) d.out(head + '\n');
    else d.out(`${head}\n${e.text}\n\n`);
  }
  say(t(`Отрывков: ${r.excerpts.length} из ${r.passages} (источников: ${r.sources}).`, `${r.excerpts.length} excerpts of ${r.passages} (${r.sources} sources).`));
  return EXIT_OK;
}

/**
 * `transcribe <link>`: the same yt-dlp run as «По ссылке» on the page, one link after another.
 * code ≠ null ends the run (no model / no yt-dlp → 3, Ctrl+C → 130) before or during downloads.
 */
async function downloadLinks(
  links: string[],
  kind: SpeechModelKind,
  o: CliOptions,
  d: CliDeps,
  say: (line: string) => void,
  fail: (line: string) => void,
): Promise<{ files: string[]; failed: number; code: number | null; noModel?: boolean }> {
  const t = d.t;
  if (!d.findModel(kind, o.modelDir)) return { files: [], failed: 0, code: EXIT_NO_MODEL, noModel: true };
  if (!d.fetchAudio || !d.findYtDlp?.()) {
    fail(
      t(
        'Ошибка: для ссылок нужен yt-dlp. Скачайте его в приложении («Расшифровка файла» → «По ссылке» → «Скачать yt-dlp») или поставьте в PATH.',
        'Error: links need yt-dlp. Download it in the app (File transcription → By link → Download yt-dlp) or put it on PATH.',
      ),
    );
    return { files: [], failed: 0, code: EXIT_NO_MODEL };
  }
  const folder = o.outDir ?? d.urlFolder?.() ?? '.';
  say(t(`По ссылке: через сеть идёт только скачивание звука (в ${folder}), расшифровка — на этом компьютере.`, `By link: only the audio download (to ${folder}) uses the network; transcription stays on this computer.`));
  const files: string[] = [];
  let failed = 0;
  for (let i = 0; i < links.length; i++) {
    if (d.signal.aborted) break;
    const url = links[i]!;
    const prefix = links.length > 1 ? `[${i + 1}/${links.length}] ` : '';
    const host = new URL(url).hostname;
    const line = t(`Скачиваю звук с ${host}…`, `Downloading audio from ${host}…`);
    say(prefix + line);
    let drawn = false;
    let shown = -1;
    try {
      const path = await d.fetchAudio(
        url,
        folder,
        (p) => {
          if (o.quiet || !d.isTTY || Math.floor(p) === shown) return;
          shown = Math.floor(p);
          d.err(`\r\x1b[2K${prefix}${line} ${shown}%`);
          drawn = true;
        },
        d.signal,
      );
      if (drawn) d.err('\r\x1b[2K');
      say(prefix + t(`Скачано: ${path}`, `Downloaded: ${path}`));
      d.log(`cli url ${host} → ${path}`);
      if (!files.includes(path)) files.push(path);
    } catch (e) {
      if (drawn) d.err('\r\x1b[2K');
      if (d.signal.aborted) break;
      failed++;
      fail(prefix + t(`Ошибка: не скачалось: ${url}: ${message(e)}`, `Error: download failed: ${url}: ${message(e)}`));
      d.log(`cli url ${host} failed: ${message(e)}`);
    }
  }
  if (d.signal.aborted) {
    fail(t('Прервано.', 'Interrupted.'));
    return { files, failed, code: EXIT_INTERRUPTED };
  }
  return { files, failed, code: null };
}

async function transcribe(o: CliOptions, defaults: CliDefaults, d: CliDeps): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const fail = (line: string) => d.err(line + '\n');

  // Inputs: files as given, folders expanded (no recursion), http(s) links downloaded below,
  // duplicates dropped.
  const files: string[] = [];
  const links: string[] = [];
  let failed = 0;
  for (const input of o.inputs) {
    if (isLinkInput(input)) {
      const check = parseMediaUrl(input);
      if (!check.ok) {
        fail(t(`Ошибка: не ссылка: ${input}`, `Error: not a valid link: ${input}`));
        failed++;
      } else if (!links.includes(check.url)) links.push(check.url);
    } else if (d.isDirectory(input)) {
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
  if (files.length === 0 && links.length === 0) return EXIT_FAILED;

  const kind = o.model ?? defaults.model;
  const noModel = () =>
    fail(
      o.modelDir
        ? t(`Ошибка: в ${o.modelDir} нет полной модели ${kind}.`, `Error: ${o.modelDir} has no complete ${kind} model.`)
        : t(
            'Ошибка: модели нет на диске. Откройте в приложении «Распознавание» и скачайте её, или укажите --model-dir.',
            'Error: the model is not on disk. Download it on the Speech page of the app, or pass --model-dir.',
          ),
    );

  // «По ссылке»: yt-dlp saves the audio (Downloads/Chawo, or --out), then it is an ordinary file.
  // Model and yt-dlp are checked first so nothing is downloaded for a run that cannot finish.
  if (links.length > 0) {
    const r = await downloadLinks(links, kind, o, d, say, fail);
    if (r.code !== null) {
      if (r.code === EXIT_NO_MODEL && r.noModel) noModel();
      return r.code;
    }
    failed += r.failed;
    for (const f of r.files) if (!files.includes(f)) files.push(f);
    if (files.length === 0) return EXIT_FAILED;
  }

  const formats = o.formats.length > 0 ? o.formats : (['txt'] as const);
  const timestamps = o.timestamps ?? defaults.timestamps;
  const script = o.noPostScript ? null : scriptCommand(o.postScript ?? defaults.postScript ?? null);
  const vad = o.vad ?? defaults.vad ?? true;
  const diarize = o.diarize ?? defaults.diarize ?? false;
  const useBrain = o.brain ?? defaults.brain ?? false;
  const useBrief = o.brief ?? defaults.brief ?? false;
  if (o.template != null) {
    const tpl = await templateInstruction(o, d);
    if (!tpl || 'list' in tpl) return EXIT_USAGE;
    if (!useBrief) say(t('--template без --brief: карточки не будет.', '--template without --brief: no card.'));
    o = { ...o, instruction: tpl.instruction };
  }
  const useScore = o.score ?? defaults.score ?? false;
  let scoreList: import('../main/brain/callScore').Checklist | null = null;
  if (useScore || o.checklist != null) {
    const c = await pickChecklist(o, defaults, d);
    if (!c || 'list' in c) return EXIT_USAGE;
    if (!useScore) say(t('--checklist без --score: проверки не будет.', '--checklist without --score: no scoring.'));
    scoreList = c.checklist;
  }
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

  const dir = d.findModel(kind, o.modelDir);
  if (!dir) {
    noModel();
    return EXIT_NO_MODEL;
  }

  // «Прогнать через мозг» / «Кратко и задачи» after each .txt, like the page (FileUseBrain /
  // MeetingBriefEnabled). Soft: a missing or failing Brain is a note, the transcript still counts.
  const fileBrain = useBrain ? d.fileBrain?.() ?? null : null;
  const briefBrain = useBrief || useScore ? d.briefBrain() : null;
  const FileBrain = fileBrain && fileBrain.target !== 'None' ? await import('../main/brain/fileBrain') : null;
  const MeetingBrief = briefBrain && briefBrain.target !== 'None' ? await import('../main/brain/meetingBrief') : null;
  if (useBrain && !FileBrain) say(t('Мозг не настроен: .brain.txt не будет.', 'The Brain is not set up: no .brain.txt.'));
  const CallScore = useScore && briefBrain && briefBrain.target !== 'None' ? await import('../main/brain/callScore') : null;
  if (useScore && !CallScore) say(t('Мозг не настроен: .score.json не будет.', 'The Brain is not set up: no .score.json.'));
  if (useBrief && !MeetingBrief) say(t('Мозг не настроен: .brief.txt не будет.', 'The Brain is not set up: no .brief.txt.'));
  const cloud = (FileBrain ? fileBrain?.cloud : null) || (MeetingBrief || CallScore ? briefBrain?.cloud : null);
  if (cloud) say(t(`Мозг: текст уходит в ${cloud}`, `Brain: the text goes to ${cloud}`));
  // «Контекст для Мозга» for .brain.txt (not for .brief.txt), only with --context / --context-file.
  if (!useBrain && (o.context != null || o.contextFile != null))
    say(t('--context без Мозга: «Прогнать через мозг» выключен, добавьте --brain.', '--context without the Brain: «Run through the Brain» is off, add --brain.'));
  let brainAsk = fileBrain?.ask ?? null;
  if (FileBrain && fileBrain) {
    const ctx = cliContext(o, d, fileBrain.cloud, say, (l) => d.err(l + '\n'));
    if (ctx === null) return EXIT_FAILED;
    brainAsk = withContext(fileBrain.ask, ctx);
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
              const r = noAnswer(await FileBrain.runWithAsk(fileBrain.target, segments, timestamps, status, d.signal, brainAsk ?? fileBrain.ask), t);
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
        if (useScore && scoreList) {
          if (!CallScore || !briefBrain) notes.push(t('чек-лист: мозг не настроен', 'checklist: the Brain is not set up'));
          else {
            try {
              const r = await CallScore.scoreAsync({ transcript: recognized, checklist: scoreList, targetKind: briefBrain.target, ask: briefBrain.ask, status, signal: d.signal, source: txt });
              if (o.stdout) d.out(`\n==> ${t('Проверка по чек-листу', 'Checklist score')} <==\n` + CallScore.formatText(r));
              else {
                const p = CallScore.outputPaths(txt);
                d.writeFile(p.json, JSON.stringify(r, null, 2) + '\n');
                d.writeFile(p.txt, CallScore.formatText(r));
              }
              notes.push(t(`чек-лист ${r.percent}%`, `checklist ${r.percent}%`) + (o.stdout ? '' : ' · .score.json'));
              d.log(`cli ${src} score ok ${r.percent}%`);
            } catch (e) {
              if (d.signal.aborted) break;
              notes.push(t(`чек-лист: ${message(e)}`, `checklist: ${message(e)}`));
              d.log(`cli ${src} score failed: ${message(e)}`);
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

/** `chawo-va snippets list|add|remove`: the «Сниппеты» block of «Словарь» from the command line. */
async function snippetsCommand(o: CliOptions, d: CliDeps): Promise<number> {
  const t = d.t;
  const S = await import('../core/snippets');
  if (!d.snippetsPath) {
    d.err(t('Ошибка: сниппеты недоступны.', 'Error: snippets are not available.') + '\n');
    return EXIT_FAILED;
  }
  const path = d.snippetsPath();
  const list = S.loadSnippets(path);
  const [action, a1, a2] = o.inputs;
  if (action === 'list') {
    if (o.json) d.out(JSON.stringify(list, null, 2) + '\n');
    else if (list.length === 0) {
      if (!o.quiet) d.err(t('Сниппетов нет. Добавить: chawo-va snippets add подпись "С уважением, …"', 'No snippets. Add one: chawo-va snippets add signature "Best regards, …"') + '\n');
    } else {
      for (const s of list) d.out(`${s.trigger}\t${s.text.replace(/\n/g, '\\n')}\n`);
    }
    d.log(`cli snippets list ${list.length}`);
    return EXIT_OK;
  }
  if (action === 'add') {
    let text = a2;
    if (text === '-') {
      if (!d.readStdin) {
        d.err(t('Ошибка: stdin недоступен.', 'Error: stdin is not available.') + '\n');
        return EXIT_FAILED;
      }
      text = (await d.readStdin()).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    }
    if (!S.normTrigger(a1)) {
      d.err(t('Ошибка: фраза должна содержать буквы или цифры.', 'Error: the trigger needs letters or digits.') + '\n');
      return EXIT_USAGE;
    }
    if (!text.trim()) {
      d.err(t('Ошибка: пустой текст.', 'Error: empty text.') + '\n');
      return EXIT_USAGE;
    }
    const existed = list.some((x) => S.normTrigger(x.trigger) === S.normTrigger(a1));
    try {
      S.saveSnippets(path, S.upsertSnippet(list, { trigger: a1, text }));
    } catch (e) {
      d.err(t(`Ошибка: не удалось сохранить ${path}: `, `Error: could not save ${path}: `) + (e instanceof Error ? e.message : String(e)) + '\n');
      return EXIT_FAILED;
    }
    if (!o.quiet) d.err((existed ? t(`Заменён: «${a1}». Скажите «вставь ${a1}».`, `Replaced: «${a1}». Say «вставь ${a1}».`) : t(`Добавлен: «${a1}». Скажите «вставь ${a1}».`, `Added: «${a1}». Say «вставь ${a1}».`)) + '\n');
    d.log(`cli snippets add ${existed ? 'replace' : 'new'}`);
    return EXIT_OK;
  }
  const { list: next, removed } = S.removeSnippet(list, a1);
  if (!removed) {
    d.err(t(`Ошибка: сниппета «${a1}» нет.`, `Error: no snippet «${a1}».`) + '\n');
    return EXIT_FAILED;
  }
  S.saveSnippets(path, next);
  if (!o.quiet) d.err(t(`Удалён: «${a1}».`, `Removed: «${a1}».`) + '\n');
  d.log('cli snippets remove');
  return EXIT_OK;
}

/**
 * `chawo-va dictionary`: the «Словарь» rules and «Из исправлений» from the command line. settings.json
 * is only read: accepted rows are queued in learned-words.json and the app moves them into «Словарь»
 * on its next look (dictation, the page), so a running app never overwrites them.
 */
async function dictionaryCommand(o: CliOptions, d: CliDeps): Promise<number> {
  const t = d.t;
  const L = await import('../core/selfDictionary');
  const W = await import('../core/wordReplace');
  if (!d.learnedPath || !d.settingsFile) {
    d.err(t('Ошибка: словарь недоступен.', 'Error: the dictionary is not available.') + '\n');
    return EXIT_FAILED;
  }
  const lpath = d.learnedPath();
  const spath = d.settingsFile();
  let raw: Record<string, unknown> = {};
  try {
    if (d.exists(spath)) raw = JSON.parse(d.readFile(spath)) as Record<string, unknown>;
  } catch (e) {
    d.err(t(`Ошибка: не прочитать ${spath}: `, `Error: could not read ${spath}: `) + (e instanceof Error ? e.message : String(e)) + '\n');
    return EXIT_FAILED;
  }
  const stored = typeof raw.WordReplacementRules === 'string' ? raw.WordReplacementRules : '';
  const data = L.loadLearned(lpath);
  const rules = L.withPending(W.parseRules(stored.trim() ? stored : W.DEFAULT_RULES), data);
  const [action, a1, a2] = o.inputs;
  const line = (p: { from: string; to: string }) => `${p.from}\t${p.to}`;
  try {
    if (action === 'list') {
      if (o.json) d.out(JSON.stringify(rules, null, 2) + '\n');
      else for (const r of rules) d.out(line(r) + '\n');
      d.log(`cli dictionary list ${rules.length}`);
      return EXIT_OK;
    }
    if (action === 'suggest') {
      const list = L.suggestions(data, rules);
      if (o.json) d.out(JSON.stringify(list.map(({ from, to, count }) => ({ from, to, count })), null, 2) + '\n');
      else if (list.length === 0) {
        if (!o.quiet) d.err(t(`Предложений нет. Исправления копятся из «Истории» → «Исправить» и chawo-va dictionary learn; нужна одна и та же правка ${L.SUGGEST_AT} раза.`,
          `No suggestions. Fixes come from History → Fix and chawo-va dictionary learn; the same fix is needed ${L.SUGGEST_AT} times.`) + '\n');
      } else for (const p of list) d.out(`${line(p)}\t${p.count}\n`);
      d.log(`cli dictionary suggest ${list.length}`);
      return EXIT_OK;
    }
    if (action === 'accept') {
      const p = L.findPair(data, a1!, a2);
      const to = (a2 ?? p?.to ?? '').trim();
      if (!to) {
        d.err(t(`Ошибка: предложения «${a1}» нет. Укажите и как писать: chawo-va dictionary accept ${a1} <как писать>`, `Error: no suggestion «${a1}». Give the written form too: chawo-va dictionary accept ${a1} <written>`) + '\n');
        return EXIT_FAILED;
      }
      const from = (p?.from ?? a1!).trim();
      if (/[\r\n]/.test(from + to) || !from) {
        d.err(t('Ошибка: пустая или многострочная строка.', 'Error: empty or multi-line text.') + '\n');
        return EXIT_USAGE;
      }
      L.saveLearned(lpath, L.addPending(L.forget(data, from), from, to));
      if (!o.quiet) d.err(t(`В словаре: ${from} → ${to}.`, `In the dictionary: ${from} → ${to}.`) + '\n');
      d.log('cli dictionary accept');
      return EXIT_OK;
    }
    if (action === 'dismiss') {
      const p = L.findPair(data, a1!, a2);
      if (!p) {
        d.err(t(`Ошибка: предложения «${a1}» нет.`, `Error: no suggestion «${a1}».`) + '\n');
        return EXIT_FAILED;
      }
      L.saveLearned(lpath, L.dismiss(data, p.from, p.to));
      if (!o.quiet) d.err(t(`Скрыто: ${p.from} → ${p.to}.`, `Hidden: ${p.from} → ${p.to}.`) + '\n');
      d.log('cli dictionary dismiss');
      return EXIT_OK;
    }
    if (action === 'auto') {
      const on = a1 === 'on';
      L.saveLearned(lpath, { ...data, autoAdd: on });
      if (!o.quiet) d.err((on ? t('Исправления, повторённые дважды, будут добавляться в словарь сами.', 'Fixes repeated twice will be added to the dictionary by themselves.') : t('Исправления только предлагаются.', 'Fixes are only suggested.')) + '\n');
      d.log(`cli dictionary auto ${a1}`);
      return EXIT_OK;
    }
    // learn <before> <after>
    for (const f of [a1!, a2!]) {
      if (!d.exists(f)) {
        d.err(t(`Ошибка: нет файла ${f}`, `Error: no file ${f}`) + '\n');
        return EXIT_FAILED;
      }
    }
    const r = L.learnEdit(data, rules, d.readFile(a1!), d.readFile(a2!), (d.clock ?? Date.now)());
    let next = r.data;
    for (const p of r.added) next = L.addPending(next, p.from, p.to);
    if (r.fixes.length > 0) L.saveLearned(lpath, next);
    if (o.json) d.out(JSON.stringify({ fixes: r.fixes, added: r.added, suggested: r.suggested }, null, 2) + '\n');
    else {
      for (const p of r.fixes) d.out(line(p) + '\n');
      if (!o.quiet) {
        const pairs = (l: { from: string; to: string }[]) => l.map((p) => `${p.from} → ${p.to}`).join(', ');
        d.err((r.fixes.length === 0 ? t('Исправлений слов не найдено.', 'No word fixes found.')
          : t(`Запомнено исправлений: ${r.fixes.length}.`, `Fixes remembered: ${r.fixes.length}.`)
            + (r.added.length ? t(` В словарь добавлено: ${pairs(r.added)}.`, ` Added to the dictionary: ${pairs(r.added)}.`) : '')
            + (r.suggested.length ? t(` Предложено: ${pairs(r.suggested)} (chawo-va dictionary accept …).`, ` Suggested: ${pairs(r.suggested)} (chawo-va dictionary accept …).`) : '')) + '\n');
      }
    }
    d.log(`cli dictionary learn ${r.fixes.length}`);
    return EXIT_OK;
  } catch (e) {
    d.err(t('Ошибка: ', 'Error: ') + (e instanceof Error ? e.message : String(e)) + '\n');
    return EXIT_FAILED;
  }
}

/**
 * `chawo-va meeting detect [--json]`: whether a meeting looks active (apps / local .ics).
 * Never starts recording. Uses settings MeetingAutoDetectApps and MeetingAutoDetectCalendar
 * (master switch is ignored here — the CLI always runs a one-shot check).
 */
async function meetingCommand(o: CliOptions, d: CliDeps): Promise<number> {
  const t = d.t;
  const { detectMeeting } = await import('../main/meeting/meetingDetect');
  const s = d.meetingDetectSettings
    ? d.meetingDetectSettings()
    : { MeetingAutoDetectApps: true, MeetingAutoDetectCalendar: '' };
  const result = await detectMeeting(
    {
      MeetingAutoDetect: true,
      MeetingAutoDetectApps: s.MeetingAutoDetectApps,
      MeetingAutoDetectCalendar: s.MeetingAutoDetectCalendar,
    },
    {
      exec: d.meetingExec,
      platform: d.meetingPlatform ?? process.platform,
      now: d.now,
    },
  );
  d.log(`cli meeting detect active=${result.active} apps=${result.apps.length} cal=${result.calendar.length}`);
  if (o.json) {
    d.out(JSON.stringify({
      active: result.active,
      appsSupported: result.appsSupported,
      apps: result.apps,
      calendar: result.calendar.map((c) => ({
        summary: c.summary,
        startMs: c.startMs,
        endMs: c.endMs,
        kind: c.kind,
        file: c.file,
      })),
      reasons: result.reasons,
    }) + '\n');
    return EXIT_OK;
  }
  if (!result.active) {
    if (!o.quiet) {
      d.out(t('Встреча не обнаружена.\n', 'No meeting detected.\n'));
      if (!result.appsSupported && s.MeetingAutoDetectApps) {
        d.err(t('Подсказка: приложения встреч распознаются на Windows; календарь .ics — на любой ОС.\n',
          'Note: meeting apps are detected on Windows; .ics calendar works on any OS.\n'));
      }
    }
    return EXIT_OK;
  }
  const lines: string[] = [];
  for (const a of result.apps) lines.push(t(`приложение: ${a.app} (${a.matched})`, `app: ${a.app} (${a.matched})`));
  for (const c of result.calendar) {
    const when = c.kind === 'now' ? t('сейчас', 'now') : t('скоро', 'soon');
    lines.push(t(`календарь: ${c.summary} (${when})`, `calendar: ${c.summary} (${when})`));
  }
  d.out(t('Похоже, идёт встреча:\n', 'A meeting looks active:\n') + lines.map((l) => `  ${l}\n`).join(''));
  return EXIT_OK;
}
