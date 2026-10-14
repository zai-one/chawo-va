// Command-line arguments for `chawo-va transcribe | brain | brief | translate | history …`. Pure parsing, no I/O, so it is unit-tested
// on its own. Anything not given here falls back to the app's settings.json (read-only).

import type { FileParallelismKind } from '../core/fileParallel';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../core/speechModels';

export const FORMATS = ['txt', 'srt', 'vtt', 'json', 'md', 'docx'] as const;
export type OutputFormat = (typeof FORMATS)[number];

export interface CliOptions {
  command: 'transcribe' | 'brain' | 'brief' | 'translate' | 'history' | 'segments' | 'serve' | 'help' | 'version';
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
  /** Override MeetingBriefInstruction; null = settings / built-in default. */
  instruction: string | null;
  /** translate: target language (code, name or free text); null = settings TranslateTarget / auto. */
  to: string | null;
  /** transcribe: «Свой скрипт» command for the text; null = settings (PostScript when PostScriptFiles is on). */
  postScript: string | null;
  /** transcribe: --no-post-script, skip the script even when settings have one. */
  noPostScript: boolean;
  /** history: how many entries to print; null = default (20), Infinity = all. */
  limit: number | null;
  /** history: JSON Lines instead of text. */
  json: boolean;
  /** history: also print the text as recognized (before the Brain) when it differs. */
  raw: boolean;
  /** transcribe: --vad / --no-vad; null = settings VadEnabled (Silero pauses for long files when on disk). */
  vad: boolean | null;
  /** transcribe: --diarize / --no-diarize; null = settings FileDiarize («Разделять спикеров»). */
  diarize: boolean | null;
  /** transcribe: --brain / --no-brain; null = settings FileUseBrain («Прогнать через мозг» → .brain.txt). */
  brain: boolean | null;
  /** transcribe: --brief / --no-brief; null = settings MeetingBriefEnabled («Кратко и задачи» → .brief.txt). */
  brief: boolean | null;
  /** transcribe: remote 'chawo-va serve' base URL; null = local model. */
  server: string | null;
  /** serve / transcribe --server: Bearer token; also CHAWO_SERVE_TOKEN. */
  token: string | null;
  /** serve: listen host (default 127.0.0.1 without token, 0.0.0.0 with token). */
  host: string | null;
  /** serve: listen port (default 17831). */
  port: number | null;
  /** serve: job/transcript data directory. */
  dataDir: string | null;
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
const VALUED = new Set(['--format', '-f', '--out', '-o', '--model', '--device', '--threads', '-j', '--script', '--model-dir', '--lang', '--instruction', '--to', '--post-script', '--limit', '-n', '--server', '--token', '--host', '--port', '--data-dir']);

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
    instruction: null,
    to: null,
    postScript: null,
    noPostScript: false,
    limit: null,
    json: false,
    raw: false,
    vad: null,
    diarize: null,
    brain: null,
    brief: null,
    server: null,
    token: null,
    host: null,
    port: null,
    dataDir: null,
  };
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const args = [...argv];
  // `--lang` may also come before the command (`chawo-va --lang ru --help`, `chawo-va --lang en transcribe …`).
  const lead: string[] = [];
  while (args.length > 0 && (args[0] === '--lang' || args[0].startsWith('--lang='))) {
    if (args[0] === '--lang' && args.length < 2) return { ok: false, error: '--lang needs a value' };
    lead.push(...args.splice(0, args[0] === '--lang' ? 2 : 1));
  }
  if (args.length === 0) return { ok: true, options: blank('help') };
  const first = args[0];
  if (first === '--help' || first === '-h' || first === 'help') return { ok: true, options: blank('help') };
  if (first === '--version' || first === '-v' || first === 'version') return { ok: true, options: blank('version') };
  if (first !== 'transcribe' && first !== 'brain' && first !== 'brief' && first !== 'translate' && first !== 'history' && first !== 'segments' && first !== 'serve') return { ok: false, error: `unknown command: ${first}` };

  args.splice(1, 0, ...lead);
  const o = blank(first);
  let onlyFiles = false;
  const toggles = new Set<string>();
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
      case '--instruction':
        if (!v) return { ok: false, error: '--instruction is empty' };
        o.instruction = v;
        break;
      case '--to':
        if (!v) return { ok: false, error: '--to is empty' };
        o.to = v;
        break;
      case '--post-script':
        if (!v) return { ok: false, error: '--post-script is empty' };
        o.postScript = v;
        break;
      case '--no-post-script':
        o.noPostScript = true;
        break;
      case '--limit':
      case '-n': {
        if (lower === 'all' || lower === 'все' || lower === '0') {
          o.limit = Number.POSITIVE_INFINITY;
          break;
        }
        if (!/^\d{1,6}$/.test(lower)) return { ok: false, error: `bad --limit: ${v} (a number or all)` };
        o.limit = Number(lower);
        break;
      }
      case '--json':
        o.json = true;
        break;
      case '--raw':
        o.raw = true;
        break;
      case '--vad':
      case '--no-vad':
        toggles.add(a);
        o.vad = a === '--vad';
        break;
      case '--diarize':
      case '--no-diarize':
        toggles.add(a);
        o.diarize = a === '--diarize';
        break;
      case '--brain':
      case '--no-brain':
        toggles.add(a);
        o.brain = a === '--brain';
        break;
      case '--brief':
      case '--no-brief':
        toggles.add(a);
        o.brief = a === '--brief';
        break;
      case '--server':
        if (!v) return { ok: false, error: '--server is empty' };
        o.server = v;
        break;
      case '--token':
        if (!v) return { ok: false, error: '--token is empty' };
        o.token = v;
        break;
      case '--host':
        if (!v) return { ok: false, error: '--host is empty' };
        o.host = v;
        break;
      case '--port': {
        if (!/^\d{1,5}$/.test(lower)) return { ok: false, error: `bad --port: ${v}` };
        const n = Number(lower);
        if (n < 1 || n > 65535) return { ok: false, error: `bad --port: ${v}` };
        o.port = n;
        break;
      }
      case '--data-dir':
        if (!v) return { ok: false, error: '--data-dir is empty' };
        o.dataDir = v;
        break;
      default:
        return { ok: false, error: `unknown option: ${a}` };
    }
  }
  if (o.inputs.includes('-')) return { ok: false, error: 'reading audio from stdin is not supported; pass a file path' };
  if (toggles.has('--vad') && toggles.has('--no-vad')) return { ok: false, error: '--vad and --no-vad cannot be used together' };
  if (toggles.has('--diarize') && toggles.has('--no-diarize')) return { ok: false, error: '--diarize and --no-diarize cannot be used together' };
  if ((o.vad !== null || o.diarize !== null) && o.command !== 'transcribe') return { ok: false, error: '--vad and --diarize are for transcribe' };
  if (toggles.has('--brain') && toggles.has('--no-brain')) return { ok: false, error: '--brain and --no-brain cannot be used together' };
  if (toggles.has('--brief') && toggles.has('--no-brief')) return { ok: false, error: '--brief and --no-brief cannot be used together' };
  if ((o.brain !== null || o.brief !== null) && o.command !== 'transcribe')
    return { ok: false, error: o.command === 'brain' || o.command === 'brief' ? `--brain / --brief are switches for transcribe; \`${o.command}\` already does it` : '--brain and --brief are for transcribe' };
  if (o.server != null && o.command !== 'transcribe') return { ok: false, error: '--server is for transcribe' };
  if ((o.host != null || o.port != null || o.dataDir != null) && o.command !== 'serve')
    return { ok: false, error: '--host, --port and --data-dir are for serve' };
  if (o.token != null && o.command !== 'serve' && o.command !== 'transcribe')
    return { ok: false, error: '--token is for serve or transcribe --server' };
  if (o.command === 'serve') {
    if (o.inputs.length > 0) return { ok: false, error: 'serve takes no file arguments' };
    if (o.formats.length > 0 || o.outDir || o.stdout || o.timestamps !== null || o.skipExisting)
      return { ok: false, error: 'serve does not take --format / --out / --stdout / --timestamps / --skip-existing' };
    if (o.instruction != null || o.to != null || o.postScript != null || o.noPostScript || o.limit !== null || o.json || o.raw)
      return { ok: false, error: 'serve takes --host --port --token --data-dir --model --model-dir --threads --script --lang' };
    if (o.vad !== null || o.diarize !== null || o.brain !== null || o.brief !== null || o.server != null)
      return { ok: false, error: 'serve does not take --vad / --diarize / --brain / --brief / --server' };
    if (o.device === 'gpu') return { ok: false, error: 'serve is CPU-only; drop --device gpu' };
    return { ok: true, options: o };
  }
  if (o.command === 'history') {
    // Words after `history` are the search, like the page's search box (every word must occur).
    const speech = o.model || o.device || o.threads || o.script || o.modelDir;
    if (o.formats.length > 0 || o.outDir || o.stdout || o.timestamps !== null || o.skipExisting || speech)
      return { ok: false, error: 'history prints to stdout; it takes search words, -n, --json, --raw' };
    if (o.instruction != null || o.to != null || o.postScript != null || o.noPostScript)
      return { ok: false, error: 'history takes search words, -n, --json, --raw' };
    return { ok: true, options: o };
  }
  if (o.command === 'segments') {
    const speech = o.model || o.device || o.threads || o.script || o.modelDir;
    if (o.formats.length > 0 || o.outDir || o.stdout || o.timestamps !== null || o.skipExisting || speech)
      return { ok: false, error: 'segments prints to stdout; pass transcript .txt/.srt/.json files and optional --json' };
    if (o.instruction != null || o.to != null || o.postScript != null || o.noPostScript || o.limit !== null || o.raw)
      return { ok: false, error: 'segments takes transcript files and optional --json' };
    if (o.inputs.length === 0) return { ok: false, error: 'no files given' };
    return { ok: true, options: o };
  }
  if (o.limit !== null || o.json || o.raw) return { ok: false, error: '-n, --json and --raw are for history ( --json also for segments)' };
  if (o.inputs.length === 0) return { ok: false, error: 'no files given' };
  if (o.command === 'brain') {
    if (o.formats.length > 0) return { ok: false, error: 'brain writes .brain.txt (or --stdout); drop --format' };
    if (o.model || o.device || o.threads || o.script || o.modelDir) return { ok: false, error: 'brain takes a transcript .txt (speech options are for transcribe)' };
    if (o.instruction != null) return { ok: false, error: '--instruction is for brief' };
  }
  if (o.command === 'brief') {
    if (o.formats.length > 0) return { ok: false, error: 'brief writes .brief.txt (or --stdout); drop --format' };
    if (o.model || o.device || o.threads || o.script || o.modelDir) return { ok: false, error: 'brief takes a transcript .txt (speech options are for transcribe)' };
  }
  if (o.command === 'translate') {
    if (o.formats.length > 0) return { ok: false, error: 'translate writes .translate.txt (or --stdout); drop --format' };
    if (o.model || o.device || o.threads || o.script || o.modelDir) return { ok: false, error: 'translate takes a transcript .txt (speech options are for transcribe)' };
    if (o.instruction != null) return { ok: false, error: '--instruction is for brief; translate takes --to' };
  }
  if ((o.postScript != null || o.noPostScript) && o.command !== 'transcribe') return { ok: false, error: '--post-script is for transcribe' };
  if (o.postScript != null && o.noPostScript) return { ok: false, error: '--post-script and --no-post-script cannot be used together' };
  if (o.to != null && o.command !== 'translate') return { ok: false, error: '--to is for translate' };
  if (o.stdout && o.outDir) return { ok: false, error: '--stdout and --out cannot be used together' };
  if (o.stdout && o.formats.some((f) => f !== 'txt')) return { ok: false, error: `--stdout prints text only; drop --format ${o.formats.filter((f) => f !== 'txt').join(',')}` };
  return { ok: true, options: o };
}

export function helpText(t: (ru: string, en: string) => string): string {
  return t(
    `Chawo Voice Assistant — расшифровка файлов, «Кратко и задачи», перевод и история диктовки из командной строки. Всё локально, ничего не отправляется (по ссылке — только скачивание).

Использование:
  chawo-va transcribe <файлы, папки или ссылки…> [параметры]
  chawo-va brain <расшифровки.txt…> [параметры]
  chawo-va brief <расшифровки.txt…> [параметры]
  chawo-va translate <тексты.txt…> [--to язык] [параметры]
  chawo-va history [слова для поиска…] [-n 20|all] [--json] [--raw]
  chawo-va segments <файлы.txt|.srt|.json…> [--json]
  chawo-va serve [--host 127.0.0.1|0.0.0.0] [--port 17831] [--token …] [--data-dir …]

Параметры:
  -f, --format txt,srt,vtt,json,md,docx
                         какие файлы писать (по умолчанию txt), можно несколько через запятую
  -o, --out <папка>      куда писать (по умолчанию рядом с исходным файлом)
  -t, --timestamps       [чч:мм:сс] в начале строк txt; --no-timestamps — без них
      --stdout           печатать текст в stdout вместо файлов
      --skip-existing    пропускать файлы, у которых уже есть .txt
      --model v3|ctc     модель распознавания
      --device cpu|gpu   устройство
  -j, --threads auto|1|2|4|max   параллельность длинных записей
      --script auto|ru|en        алфавит для модели ctc
      --model-dir <папка>        папка с моделью (иначе — где её скачало приложение)
      --post-script «команда»  свой скрипт: текст на stdin, что напечатает — в .txt / stdout
                         (иначе — из настроек, если там включено «и для файлов»);
      --no-post-script   без скрипта
      --vad / --no-vad   резать длинные записи по паузам Silero VAD (если модель VAD скачана
                         в приложении) или по громкости; по умолчанию — из настроек
      --diarize / --no-diarize
                         разделять спикеров («Спикер 1: …» в txt/srt/…); по умолчанию — из
                         настроек «Разделять спикеров». Модели спикеров (~47 МБ) скачиваются
                         в приложении; без них — расшифровка без спикеров, с пометкой
      --brain / --no-brain
                         ещё и «Прогнать через мозг» → .brain.txt (убрать слова-паразиты +
                         «Кратко»); по умолчанию — из настроек
      --brief / --no-brief
                         ещё и «Кратко и задачи» → .brief.txt (--instruction — свой формат);
                         по умолчанию — из настроек. Сбой Мозга — пометка, .txt всё равно пишется
      --server <URL>     расшифровать на удалённом 'chawo-va serve' (job API; локальной модели нет)
      --token <секрет>   Bearer для --server / для serve (или CHAWO_SERVE_TOKEN)
      --lang ru|en       язык сообщений
  -q, --quiet            без прогресса
  -h, --help / -v, --version

Параметры serve (headless CPU-сервер, без GUI):
      --host <адрес>     127.0.0.1 без токена; с --token можно 0.0.0.0
      --port <N>         порт (по умолчанию 17831)
      --token <секрет>   обязателен, чтобы слушать не-localhost (или CHAWO_SERVE_TOKEN)
      --data-dir <папка> задания и txt (TTL 2 ч); иначе ~/.local/share/chawo-serve или /tmp/chawo-serve
      --model / --model-dir / -j --threads / --script — как у transcribe; устройство всегда CPU

Параметры brain (то же, что «Прогнать через мозг» на странице):
  -t / --no-timestamps   [чч:мм:сс] в .brain.txt (по умолчанию — как в исходном .txt)
      --stdout           печатать в stdout вместо .brain.txt
  -o, --out <папка>      куда писать .brain.txt
      --lang ru|en       язык сообщений
  -q, --quiet

Параметры brief:
      --instruction «…»  своя инструкция формата (иначе — из настроек / встроенная)
      --stdout           печатать карточку в stdout вместо .brief.txt
  -o, --out <папка>      куда писать .brief.txt
      --lang ru|en       язык сообщений
  -q, --quiet

Параметры translate:
      --to <язык>        на какой язык: en, ru, de, fr, es, zh, … или название
                         («английский», «немецкий», «суахили»). Без --to — из настроек,
                         иначе авто: русский текст → английский, остальной → русский
      --stdout           печатать перевод в stdout вместо .translate.txt
  -o, --out <папка>      куда писать .translate.txt
      --lang ru|en       язык сообщений (не язык перевода)
  -q, --quiet

Параметры segments (фразы со временем из готовой расшифровки, только чтение):
  файлы…             .txt (с метками или рядом .srt/.json), .srt или .json
      --json             JSON: start, end, text, speaker?
  -q, --quiet            без строки «N фраз»

Параметры history (история диктовки, только чтение, новые сверху):
      слова…             поиск: каждое слово должно встретиться (ё = е), как на странице
  -n, --limit <N|all>    сколько записей (по умолчанию 20)
      --json             JSON Lines: id, ts, seconds, final, raw, command, brain, brainFailed
      --raw              ещё и текст до Мозга, если он отличается
  -q, --quiet            без строки «Найдено …»

Чего нет в параметрах, берётся из настроек приложения (settings.json, только чтение).
Модели не скачиваются (речь, VAD, спикеры): сначала скачайте их в приложении.
WAV и Ogg/Opus читаются сами, остальные форматы (MP3, M4A, FLAC, …) — через ffmpeg.
Папки — без подпапок, как в приложении.
Ссылки http(s)://… (YouTube и другие сайты) скачиваются через yt-dlp, как «По ссылке» в приложении:
звук — в «Загрузки/Chawo» (или в -o), дальше обычная локальная расшифровка. Через сеть идёт только
скачивание. yt-dlp CLI не скачивает: кнопка «Скачать yt-dlp» в приложении или yt-dlp в PATH.
brain читает готовый .txt и пишет .brain.txt: абзацы без слов-паразитов и «Кратко».
brief читает готовый .txt (рядом с записью или .brain.txt) и пишет .brief.txt через Мозг.
translate переводит готовый .txt через Мозг (локальный по умолчанию) и пишет .translate.txt.
segments печатает фразы со временем (как карточка «Расшифровка»): .srt → .json → метки в .txt.

Коды выхода: 0 — всё готово, 1 — часть файлов не удалась, 2 — ошибка параметров,
3 — нет модели / Мозга / yt-dlp, 130 — прервано (Ctrl+C).`,
    `Chawo Voice Assistant — file transcription, «Brief and tasks», translation and dictation history from the command line. Everything is local; nothing is uploaded (links only download).

Usage:
  chawo-va transcribe <files, folders or links…> [options]
  chawo-va brain <transcript.txt…> [options]
  chawo-va brief <transcript.txt…> [options]
  chawo-va translate <text.txt…> [--to language] [options]
  chawo-va history [search words…] [-n 20|all] [--json] [--raw]
  chawo-va segments <files.txt|.srt|.json…> [--json]
  chawo-va serve [--host 127.0.0.1|0.0.0.0] [--port 17831] [--token …] [--data-dir …]

Options:
  -f, --format txt,srt,vtt,json,md,docx
                         which files to write (default txt), several comma-separated
  -o, --out <dir>        where to write (default: beside the source file)
  -t, --timestamps       [hh:mm:ss] at the start of txt lines; --no-timestamps to drop them
      --stdout           print the text to stdout instead of writing files
      --skip-existing    skip files that already have a .txt
      --model v3|ctc     speech model
      --device cpu|gpu   device
  -j, --threads auto|1|2|4|max   parallelism for long recordings
      --script auto|ru|en        alphabet for the ctc model
      --model-dir <dir>          model folder (default: where the app downloaded it)
      --post-script "command"  your script: text on stdin, what it prints goes to .txt / stdout
                         (else settings, when "also for files" is on there);
      --no-post-script   skip the script
      --vad / --no-vad   cut long recordings at Silero VAD pauses (when the VAD model was
                         downloaded in the app) or by loudness; default: settings
      --diarize / --no-diarize
                         separate speakers ("Спикер 1: …" in txt/srt/…); default: the
                         "Separate speakers" setting. Speaker models (~47 MB) are downloaded
                         in the app; without them the transcript has no speakers and a note says so
      --brain / --no-brain
                         also «Run through the Brain» → .brain.txt (filler words removed +
                         «Summary»); default: settings
      --brief / --no-brief
                         also «Brief and tasks» → .brief.txt (--instruction for your format);
                         default: settings. A Brain failure is a note; the .txt is written anyway
      --server <URL>     transcribe on a remote 'chawo-va serve' (job API; no local model)
      --token <secret>   Bearer for --server / for serve (or CHAWO_SERVE_TOKEN)
      --lang ru|en       message language
  -q, --quiet            no progress
  -h, --help / -v, --version

serve options (headless CPU server, no GUI):
      --host <addr>      127.0.0.1 without a token; with --token you may use 0.0.0.0
      --port <N>         port (default 17831)
      --token <secret>   required to listen off localhost (or CHAWO_SERVE_TOKEN)
      --data-dir <dir>   jobs and txt (TTL 2 h); else ~/.local/share/chawo-serve or /tmp/chawo-serve
      --model / --model-dir / -j --threads / --script — same as transcribe; device is always CPU

brain options (same as «Run through the Brain» on the page):
  -t / --no-timestamps   [hh:mm:ss] in .brain.txt (default: as in the source .txt)
      --stdout           print to stdout instead of .brain.txt
  -o, --out <dir>        where to write .brain.txt
      --lang ru|en       message language
  -q, --quiet

brief options:
      --instruction "…"  custom format instruction (else settings / built-in)
      --stdout           print the card to stdout instead of .brief.txt
  -o, --out <dir>        where to write .brief.txt
      --lang ru|en       message language
  -q, --quiet

translate options:
      --to <language>    target: en, ru, de, fr, es, zh, … or a name
                         ("English", "German", "Swahili"). Without --to: settings,
                         else auto: Russian text → English, anything else → Russian
      --stdout           print the translation to stdout instead of .translate.txt
  -o, --out <dir>        where to write .translate.txt
      --lang ru|en       message language (not the translation target)
  -q, --quiet

segments options (timed phrases from a finished transcript, read-only):
  files…             .txt (with stamps or a sibling .srt/.json), .srt or .json
      --json             JSON: start, end, text, speaker?
  -q, --quiet            no «N phrases» line

history options (dictation history, read-only, newest first):
      words…             search: every word must occur (ё = е), same as the page
  -n, --limit <N|all>    how many entries (default 20)
      --json             JSON Lines: id, ts, seconds, final, raw, command, brain, brainFailed
      --raw              also the text before the Brain, when it differs
  -q, --quiet            no «Found …» line

Anything not given falls back to the app's settings (settings.json, read-only).
No model is downloaded (speech, VAD, speakers): download them in the app first.
WAV and Ogg/Opus are read natively; other formats (MP3, M4A, FLAC, …) need ffmpeg.
Folders are not searched recursively, same as in the app.
http(s)://… links (YouTube and other sites) are downloaded with yt-dlp, like «By link» in the app:
the audio goes to Downloads/Chawo (or -o), then it is transcribed locally. Only the download uses
the network. The CLI does not fetch yt-dlp: use «Download yt-dlp» in the app or have yt-dlp on PATH.
brain reads a finished .txt and writes .brain.txt: paragraphs without filler words plus «Summary».
brief reads a finished .txt (beside the recording or .brain.txt) and writes .brief.txt via the Brain.
translate translates a finished .txt via the Brain (local by default) and writes .translate.txt.
segments prints timed phrases (like the Transcript card): .srt → .json → stamps in .txt.

Exit codes: 0 all done, 1 some files failed, 2 bad arguments, 3 no model/Brain/yt-dlp, 130 interrupted (Ctrl+C).`,
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
