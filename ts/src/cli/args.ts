// Command-line arguments for `chawo-va transcribe …`. Pure parsing, no I/O, so it is unit-tested
// on its own. Anything not given here falls back to the app's settings.json (read-only).

import type { FileParallelismKind } from '../core/fileParallel';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../core/speechModels';

export const FORMATS = ['txt', 'srt'] as const;
export type OutputFormat = (typeof FORMATS)[number];

export interface CliOptions {
  command: 'transcribe' | 'help' | 'version';
  inputs: string[];
  /** Empty = not given (txt). */
  formats: OutputFormat[];
  outDir: string | null;
  /** null = not given (settings.json FileTimestamps). */
  timestamps: boolean | null;
  model: SpeechModelKind | null;
  device: SpeechDeviceKind | null;
  threads: FileParallelismKind | null;
  script: CtcScript | null;
  modelDir: string | null;
  stdout: boolean;
  skipExisting: boolean;
  quiet: boolean;
  lang: 'Russian' | 'English' | null;
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

const MODELS: Record<string, SpeechModelKind> = {
  v3: 'v3_e2e_rnnt',
  rnnt: 'v3_e2e_rnnt',
  v3_e2e_rnnt: 'v3_e2e_rnnt',
  ctc: 'multilingual_large_ctc',
  multilingual: 'multilingual_large_ctc',
  multilingual_large_ctc: 'multilingual_large_ctc',
};

const THREADS: Record<string, FileParallelismKind> = { auto: 'auto', '1': 1, '2': 2, '4': 4, max: 'max' };
const SCRIPTS: Record<string, CtcScript> = { auto: 'auto', ru: 'russian', russian: 'russian', en: 'english', english: 'english' };
const LANGS: Record<string, 'Russian' | 'English'> = { ru: 'Russian', russian: 'Russian', en: 'English', english: 'English' };

/** Options that take a value: --out DIR and --out=DIR both work. */
const VALUED = new Set(['--format', '-f', '--out', '-o', '--model', '--device', '--threads', '-j', '--script', '--model-dir', '--lang']);

function blank(command: CliOptions['command']): CliOptions {
  return {
    command,
    inputs: [],
    formats: [],
    outDir: null,
    timestamps: null,
    model: null,
    device: null,
    threads: null,
    script: null,
    modelDir: null,
    stdout: false,
    skipExisting: false,
    quiet: false,
    lang: null,
  };
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const args = [...argv];
  if (args.length === 0) return { ok: true, options: blank('help') };
  const first = args[0];
  if (first === '--help' || first === '-h' || first === 'help') return { ok: true, options: blank('help') };
  if (first === '--version' || first === '-v' || first === 'version') return { ok: true, options: blank('version') };
  if (first !== 'transcribe') return { ok: false, error: `unknown command: ${first}` };

  const o = blank('transcribe');
  let onlyFiles = false;
  for (let i = 1; i < args.length; i++) {
    let a = args[i];
    if (onlyFiles || a === '-' || !a.startsWith('-')) {
      o.inputs.push(a);
      continue;
    }
    if (a === '--') {
      onlyFiles = true;
      continue;
    }
    let value: string | undefined;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 2) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (VALUED.has(a) && value === undefined) {
      if (i + 1 >= args.length) return { ok: false, error: `${a} needs a value` };
      value = args[++i];
    } else if (!VALUED.has(a) && value !== undefined) {
      return { ok: false, error: `${a} takes no value` };
    }
    const v = (value ?? '').trim();
    const lower = v.toLowerCase();
    switch (a) {
      case '--help':
      case '-h':
        return { ok: true, options: blank('help') };
      case '--format':
      case '-f': {
        for (const raw of lower.split(',')) {
          const f = raw.trim().replace(/^\./, '');
          if (!f) continue;
          if (!(FORMATS as readonly string[]).includes(f)) return { ok: false, error: `unknown format: ${raw.trim()} (use ${FORMATS.join(', ')})` };
          if (!o.formats.includes(f as OutputFormat)) o.formats.push(f as OutputFormat);
        }
        if (o.formats.length === 0) return { ok: false, error: '--format is empty' };
        break;
      }
      case '--out':
      case '-o':
        if (!v) return { ok: false, error: '--out is empty' };
        o.outDir = v;
        break;
      case '--model':
        if (!MODELS[lower]) return { ok: false, error: `unknown model: ${v} (use v3 or ctc)` };
        o.model = MODELS[lower];
        break;
      case '--device':
        if (lower !== 'cpu' && lower !== 'gpu') return { ok: false, error: `unknown device: ${v} (use cpu or gpu)` };
        o.device = lower;
        break;
      case '--threads':
      case '-j':
        if (!(lower in THREADS)) return { ok: false, error: `unknown --threads: ${v} (use auto, 1, 2, 4 or max)` };
        o.threads = THREADS[lower];
        break;
      case '--script':
        if (!SCRIPTS[lower]) return { ok: false, error: `unknown --script: ${v} (use auto, ru or en)` };
        o.script = SCRIPTS[lower];
        break;
      case '--model-dir':
        if (!v) return { ok: false, error: '--model-dir is empty' };
        o.modelDir = v;
        break;
      case '--lang':
        if (!LANGS[lower]) return { ok: false, error: `unknown --lang: ${v} (use ru or en)` };
        o.lang = LANGS[lower];
        break;
      case '--timestamps':
      case '-t':
        o.timestamps = true;
        break;
      case '--no-timestamps':
        o.timestamps = false;
        break;
      case '--stdout':
        o.stdout = true;
        break;
      case '--skip-existing':
        o.skipExisting = true;
        break;
      case '--quiet':
      case '-q':
        o.quiet = true;
        break;
      default:
        return { ok: false, error: `unknown option: ${a}` };
    }
  }
  if (o.inputs.includes('-')) return { ok: false, error: 'reading audio from stdin is not supported; pass a file path' };
  if (o.inputs.length === 0) return { ok: false, error: 'no files given' };
  if (o.stdout && o.outDir) return { ok: false, error: '--stdout and --out cannot be used together' };
  if (o.stdout && o.formats.some((f) => f !== 'txt')) return { ok: false, error: '--stdout prints text only; drop --format srt' };
  return { ok: true, options: o };
}

export function helpText(t: (ru: string, en: string) => string): string {
  return t(
    `Chawo Voice Assistant — расшифровка файлов из командной строки. Всё локально, ничего не отправляется.

Использование:
  chawo-va transcribe <файлы или папки…> [параметры]

Параметры:
  -f, --format txt,srt   какие файлы писать (по умолчанию txt)
  -o, --out <папка>      куда писать (по умолчанию рядом с исходным файлом)
  -t, --timestamps       [чч:мм:сс] в начале строк txt; --no-timestamps — без них
      --stdout           печатать текст в stdout вместо файлов
      --skip-existing    пропускать файлы, у которых уже есть .txt
      --model v3|ctc     модель распознавания
      --device cpu|gpu   устройство
  -j, --threads auto|1|2|4|max   параллельность длинных записей
      --script auto|ru|en        алфавит для модели ctc
      --model-dir <папка>        папка с моделью (иначе — где её скачало приложение)
      --lang ru|en       язык сообщений
  -q, --quiet            без прогресса
  -h, --help / -v, --version

Чего нет в параметрах, берётся из настроек приложения (settings.json, только чтение).
Модель не скачивается: сначала скачайте её в приложении («Распознавание»).
WAV и Ogg/Opus читаются сами, остальные форматы (MP3, M4A, FLAC, …) — через ffmpeg.
Папки — без подпапок, как в приложении.

Коды выхода: 0 — всё готово, 1 — часть файлов не удалась, 2 — ошибка параметров,
3 — нет модели, 130 — прервано (Ctrl+C).`,
    `Chawo Voice Assistant — file transcription from the command line. Everything is local; nothing is uploaded.

Usage:
  chawo-va transcribe <files or folders…> [options]

Options:
  -f, --format txt,srt   which files to write (default txt)
  -o, --out <dir>        where to write (default: beside the source file)
  -t, --timestamps       [hh:mm:ss] at the start of txt lines; --no-timestamps to drop them
      --stdout           print the text to stdout instead of writing files
      --skip-existing    skip files that already have a .txt
      --model v3|ctc     speech model
      --device cpu|gpu   device
  -j, --threads auto|1|2|4|max   parallelism for long recordings
      --script auto|ru|en        alphabet for the ctc model
      --model-dir <dir>          model folder (default: where the app downloaded it)
      --lang ru|en       message language
  -q, --quiet            no progress
  -h, --help / -v, --version

Anything not given falls back to the app's settings (settings.json, read-only).
No model is downloaded: download it in the app first (Speech page).
WAV and Ogg/Opus are read natively; other formats (MP3, M4A, FLAC, …) need ffmpeg.
Folders are not searched recursively, same as in the app.

Exit codes: 0 all done, 1 some files failed, 2 bad arguments, 3 no model, 130 interrupted (Ctrl+C).`,
  );
}

/** --lang even when the rest of the line does not parse, so the error itself is in that language. */
export function langFromArgv(argv: readonly string[]): 'Russian' | 'English' | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    const v = a.startsWith('--lang=') ? a.slice(7) : a === '--lang' ? argv[i + 1] : undefined;
    if (v !== undefined) return LANGS[v.trim().toLowerCase()] ?? null;
  }
  return null;
}
