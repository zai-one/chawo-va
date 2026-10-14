// Command-line arguments for `chawo-va transcribe | brain | brief | translate | history …`. Pure parsing, no I/O, so it is unit-tested
// on its own. Anything not given here falls back to the app's settings.json (read-only).

import type { FileParallelismKind } from '../core/fileParallel';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../core/speechModels';

export const FORMATS = ['txt', 'srt', 'vtt', 'json', 'md', 'docx'] as const;
export type OutputFormat = (typeof FORMATS)[number];

export interface CliOptions {
  command: 'transcribe' | 'brain' | 'brief' | 'score' | 'translate' | 'history' | 'ask' | 'segments' | 'stats' | 'serve' | 'snippets' | 'dictionary' | 'meeting' | 'crm' | 'help' | 'version';
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
  /** brief / transcribe --brief: «Кратко и задачи» template (built-in alias or custom name); 'list' prints them. */
  template: string | null;
  /** score / transcribe --score: checklist (built-in alias or custom name); 'list' prints them. */
  checklist: string | null;
  /** transcribe: --score / --no-score; null = settings CallScoreEnabled (→ .score.json / .score.txt). */
  score: boolean | null;
  /** stats: «Название: термин, …» per --track (replaces the trackers from settings). */
  track: string[];
  /** stats: also print the phrases each tracker matched. */
  hits: boolean;
  /** translate: target language (code, name or free text); null = settings TranslateTarget / auto. */
  to: string | null;
  /** transcribe: «Свой скрипт» command for the text; null = settings (PostScript when PostScriptFiles is on). */
  postScript: string | null;
  /** transcribe: --no-post-script, skip the script even when settings have one. */
  noPostScript: boolean;
  /** history: how many entries to print; null = default (20), Infinity = all. */
  limit: number | null;
  /** ask: folders / transcript files to search instead of the meetings folder and AskFolders. */
  askIn: string[];
  /** ask: leave the dictation phrases out. */
  noHistory: boolean;
  /** ask: only print the found excerpts, no Brain. */
  searchOnly: boolean;
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
  /** brain / transcribe --brain: --context <text> — «Контекст для Мозга» (names, terms). Opt-in. */
  context: string | null;
  /** brain: --context-file <file> — the same, read from a text file. */
  contextFile: string | null;
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
const VALUED = new Set(['--format', '-f', '--out', '-o', '--model', '--device', '--threads', '-j', '--script', '--model-dir', '--lang', '--instruction', '--template', '--checklist', '--track', '--to', '--post-script', '--limit', '-n', '--server', '--token', '--host', '--port', '--data-dir', '--context', '--context-file', '--in']);

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
    template: null,
    checklist: null,
    score: null,
    track: [],
    hits: false,
    to: null,
    postScript: null,
    noPostScript: false,
    limit: null,
    askIn: [],
    noHistory: false,
    searchOnly: false,
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
    context: null,
    contextFile: null,
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
  // `crm` has its own small option set (src/cli/crmCommand.ts parses the rest).
  if (first === 'crm') return { ok: true, options: { ...blank('crm'), inputs: args.slice(1) } };
  if (first !== 'transcribe' && first !== 'brain' && first !== 'brief' && first !== 'score' && first !== 'translate' && first !== 'history' && first !== 'ask' && first !== 'segments' && first !== 'stats' && first !== 'serve' && first !== 'snippets' && first !== 'dictionary' && first !== 'meeting') return { ok: false, error: `unknown command: ${first}` };

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
      case '--template':
        if (!v) return { ok: false, error: '--template is empty' };
        o.template = v;
        break;
      case '--checklist':
        if (!v) return { ok: false, error: '--checklist is empty' };
        o.checklist = v;
        break;
      case '--score':
      case '--no-score':
        toggles.add(a);
        o.score = a === '--score';
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
      case '--context':
        if (!v.trim()) return { ok: false, error: '--context is empty' };
        o.context = v;
        break;
      case '--context-file':
        if (!v) return { ok: false, error: '--context-file is empty' };
        o.contextFile = v;
        break;
      case '--json':
        o.json = true;
        break;
      case '--in':
        if (!v) return { ok: false, error: '--in is empty' };
        o.askIn.push(v);
        break;
      case '--no-history':
        o.noHistory = true;
        break;
      case '--search':
        o.searchOnly = true;
        break;
      case '--hits':
        o.hits = true;
        break;
      case '--track':
        if (!v || !v.trim()) return { ok: false, error: '--track is empty' };
        o.track.push(v);
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
  if (o.command !== 'snippets' && o.inputs.includes('-')) return { ok: false, error: 'reading audio from stdin is not supported; pass a file path' };
  if (toggles.has('--vad') && toggles.has('--no-vad')) return { ok: false, error: '--vad and --no-vad cannot be used together' };
  if (toggles.has('--diarize') && toggles.has('--no-diarize')) return { ok: false, error: '--diarize and --no-diarize cannot be used together' };
  if ((o.vad !== null || o.diarize !== null) && o.command !== 'transcribe') return { ok: false, error: '--vad and --diarize are for transcribe' };
  if (toggles.has('--brain') && toggles.has('--no-brain')) return { ok: false, error: '--brain and --no-brain cannot be used together' };
  if (toggles.has('--brief') && toggles.has('--no-brief')) return { ok: false, error: '--brief and --no-brief cannot be used together' };
  if (toggles.has('--score') && toggles.has('--no-score')) return { ok: false, error: '--score and --no-score cannot be used together' };
  if ((o.brain !== null || o.brief !== null) && o.command !== 'transcribe')
    return { ok: false, error: o.command === 'brain' || o.command === 'brief' ? `--brain / --brief are switches for transcribe; \`${o.command}\` already does it` : '--brain and --brief are for transcribe' };
  if (o.server != null && o.command !== 'transcribe') return { ok: false, error: '--server is for transcribe' };
  if ((o.askIn.length > 0 || o.noHistory || o.searchOnly) && o.command !== 'ask') return { ok: false, error: '--in, --no-history and --search are for ask' };
  if (o.server != null && (o.score === true || o.checklist != null)) return { ok: false, error: '--score does not work with --server; run `chawo-va score` on the .txt afterwards' };
  if ((o.track.length > 0 || o.hits) && o.command !== 'stats') return { ok: false, error: '--track and --hits are for stats' };
  if (o.template != null) {
    if (o.command !== 'brief' && o.command !== 'transcribe') return { ok: false, error: '--template is for brief (or transcribe --brief)' };
    if (o.instruction != null) return { ok: false, error: '--template and --instruction cannot be used together' };
    if (o.command === 'brief' && o.template.toLowerCase() === 'list') {
      if (o.inputs.length > 0) return { ok: false, error: '--template list takes no files' };
      return { ok: true, options: o };
    }
  }
  if (o.score !== null && o.command !== 'transcribe')
    return { ok: false, error: o.command === 'score' ? '--score / --no-score are switches for transcribe; `score` already does it' : '--score is for transcribe' };
  if (o.checklist != null) {
    if (o.command !== 'score' && o.command !== 'transcribe') return { ok: false, error: '--checklist is for score (or transcribe --score)' };
    if (o.command === 'score' && o.checklist.toLowerCase() === 'list') {
      if (o.inputs.length > 0) return { ok: false, error: '--checklist list takes no files' };
      return { ok: true, options: o };
    }
  }
  if ((o.host != null || o.port != null || o.dataDir != null) && o.command !== 'serve')
    return { ok: false, error: '--host, --port and --data-dir are for serve' };
  if (o.token != null && o.command !== 'serve' && o.command !== 'transcribe')
    return { ok: false, error: '--token is for serve or transcribe --server' };
  if (o.command === 'serve') {
    if (o.template != null) return { ok: false, error: 'serve does not take --template' };
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
  if (o.command === 'ask') {
    // Words after `ask` are the question; -n = how many excerpts.
    const speech = o.model || o.device || o.threads || o.script || o.modelDir;
    if (o.formats.length > 0 || o.outDir || o.stdout || o.timestamps !== null || o.skipExisting || speech || o.instruction != null || o.to != null || o.postScript != null || o.noPostScript || o.raw || o.context != null || o.contextFile != null || o.checklist != null || o.score !== null)
      return { ok: false, error: 'ask prints to stdout; it takes a question, --in, --no-history, --search, -n, --json' };
    if (o.inputs.join(' ').trim().length === 0) return { ok: false, error: 'ask needs a question' };
    if (o.limit === Number.POSITIVE_INFINITY) o.limit = 30;
    return { ok: true, options: o };
  }
  if (o.command === 'snippets') {
    // snippets list | add <фраза> <текст…|-> | remove <фраза>
    const speech = o.model || o.device || o.threads || o.script || o.modelDir;
    if (o.formats.length > 0 || o.outDir || o.stdout || o.timestamps !== null || o.skipExisting || speech || o.instruction != null || o.to != null || o.postScript != null || o.noPostScript || o.limit !== null || o.raw)
      return { ok: false, error: 'snippets takes list | add <trigger> <text|-> | remove <trigger>, and --json for list' };
    const sub = (o.inputs[0] ?? 'list').toLowerCase();
    if (sub === 'list' || sub === 'ls') {
      if (o.inputs.length > 1) return { ok: false, error: 'snippets list takes no arguments' };
      o.inputs = ['list'];
    } else if (sub === 'add') {
      if (o.inputs.length < 3) return { ok: false, error: 'snippets add needs a trigger and a text (or - for stdin)' };
      if (o.json) return { ok: false, error: '--json is for snippets list' };
      o.inputs = ['add', o.inputs[1], o.inputs.slice(2).join(' ')];
    } else if (sub === 'remove' || sub === 'rm') {
      if (o.inputs.length < 2) return { ok: false, error: 'snippets remove needs a trigger' };
      if (o.json) return { ok: false, error: '--json is for snippets list' };
      o.inputs = ['remove', o.inputs.slice(1).join(' ')];
    } else return { ok: false, error: `unknown snippets action: ${o.inputs[0]} (use list, add or remove)` };
    return { ok: true, options: o };
  }
  if (o.command === 'dictionary') {
    // dictionary list | suggest | accept <как слышно> [как писать] | dismiss <как слышно> | learn <было> <стало> | auto on|off
    const speech = o.model || o.device || o.threads || o.script || o.modelDir;
    const usage = 'dictionary takes list | suggest | accept <heard> [written] | dismiss <heard> | learn <before.txt> <after.txt> | auto on|off, and --json for list/suggest/learn';
    if (o.formats.length > 0 || o.outDir || o.stdout || o.timestamps !== null || o.skipExisting || speech || o.instruction != null || o.to != null || o.postScript != null || o.noPostScript || o.limit !== null || o.raw)
      return { ok: false, error: usage };
    const sub = (o.inputs[0] ?? 'list').toLowerCase();
    const rest = o.inputs.slice(1);
    if (o.json && sub !== 'list' && sub !== 'ls' && sub !== 'suggest' && sub !== 'learn') return { ok: false, error: '--json is for dictionary list, suggest and learn' };
    if (sub === 'list' || sub === 'ls' || sub === 'suggest') {
      if (rest.length > 0) return { ok: false, error: `dictionary ${sub} takes no arguments` };
      o.inputs = [sub === 'suggest' ? 'suggest' : 'list'];
    } else if (sub === 'accept') {
      if (rest.length < 1 || rest.length > 2) return { ok: false, error: 'dictionary accept needs a heard form and, optionally, the written form' };
      o.inputs = ['accept', ...rest];
    } else if (sub === 'dismiss') {
      if (rest.length < 1 || rest.length > 2) return { ok: false, error: 'dictionary dismiss needs a heard form' };
      o.inputs = ['dismiss', ...rest];
    } else if (sub === 'learn') {
      if (rest.length !== 2) return { ok: false, error: 'dictionary learn needs two files: the text before and after your fixes' };
      o.inputs = ['learn', ...rest];
    } else if (sub === 'auto') {
      const v = (rest[0] ?? '').toLowerCase();
      if (rest.length !== 1 || (v !== 'on' && v !== 'off')) return { ok: false, error: 'dictionary auto takes on or off' };
      o.inputs = ['auto', v];
    } else return { ok: false, error: `unknown dictionary action: ${o.inputs[0]} (use list, suggest, accept, dismiss, learn or auto)` };
    return { ok: true, options: o };
  }
  if (o.command === 'meeting') {
    // meeting detect [--json]
    const speech = o.model || o.device || o.threads || o.script || o.modelDir;
    if (o.formats.length > 0 || o.outDir || o.stdout || o.timestamps !== null || o.skipExisting || speech || o.instruction != null || o.to != null || o.postScript != null || o.noPostScript || o.limit !== null || o.raw)
      return { ok: false, error: 'meeting detect takes optional --json only' };
    const sub = (o.inputs[0] ?? 'detect').toLowerCase();
    if (sub !== 'detect') return { ok: false, error: `unknown meeting action: ${o.inputs[0] ?? ''} (use detect)` };
    if (o.inputs.length > 1) return { ok: false, error: 'meeting detect takes no file arguments' };
    o.inputs = ['detect'];
    return { ok: true, options: o };
  }
  if (o.command === 'stats') {
    const speech = o.model || o.device || o.threads || o.script || o.modelDir;
    if (o.formats.length > 0 || o.outDir || o.stdout || o.timestamps !== null || o.skipExisting || speech)
      return { ok: false, error: 'stats prints to stdout; pass transcript .txt/.srt/.json files, --track, --hits, --json' };
    if (o.instruction != null || o.to != null || o.postScript != null || o.noPostScript || o.limit !== null || o.raw)
      return { ok: false, error: 'stats takes transcript files, --track, --hits and --json' };
    if (o.inputs.length === 0) return { ok: false, error: 'stats needs transcript files' };
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
  if ((o.context != null || o.contextFile != null) && o.command !== 'brain' && o.command !== 'transcribe') return { ok: false, error: '--context / --context-file are for brain and transcribe --brain' };
  if ((o.context != null || o.contextFile != null) && o.command === 'transcribe') {
    if (o.brain === false) return { ok: false, error: '--context needs the Brain; drop --no-brain' };
    if (o.server != null) return { ok: false, error: '--context does not work with --server (the Brain is not run there)' };
  }
  if (o.context != null && o.contextFile != null) return { ok: false, error: '--context and --context-file cannot be used together' };
  if (o.limit !== null || (o.json && o.command !== 'score') || o.raw) return { ok: false, error: '-n, --json and --raw are for history ( --json also for segments and score)' };
  if (o.command === 'score' && o.json && !o.stdout) return { ok: false, error: 'score --json needs --stdout (files are always .score.json and .score.txt)' };
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
  if (o.command === 'score') {
    if (o.formats.length > 0) return { ok: false, error: 'score writes .score.json and .score.txt (or --stdout); drop --format' };
    if (o.model || o.device || o.threads || o.script || o.modelDir) return { ok: false, error: 'score takes a transcript .txt (speech options are for transcribe)' };
    if (o.instruction != null || o.template != null) return { ok: false, error: '--instruction / --template are for brief; score takes --checklist' };
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
    `Chawo Voice Assistant — расшифровка файлов, «Кратко и задачи», чек-лист, статистика, вопросы к истории, словарь, сниппеты и выгрузка в CRM из командной строки. Всё локально, ничего не отправляется (по ссылке — только скачивание).

Использование:
  chawo-va transcribe <файлы, папки или ссылки…> [параметры]
  chawo-va brain <расшифровки.txt…> [параметры]
  chawo-va brief <расшифровки.txt…> [параметры]
  chawo-va score <расшифровки.txt…> [--checklist имя|list] [параметры]
  chawo-va translate <тексты.txt…> [--to язык] [параметры]
  chawo-va history [слова для поиска…] [-n 20|all] [--json] [--raw]
  chawo-va ask <вопрос…> [--in папка|файл.txt]… [--no-history] [--search] [-n 8] [--json]
  chawo-va segments <файлы.txt|.srt|.json…> [--json]
  chawo-va stats <файлы.txt|.srt|.json…> [--track «Название: слово, слов*»] [--hits] [--json]
  chawo-va snippets list [--json] | add <фраза> <текст|-> | remove <фраза>
  chawo-va dictionary list|suggest [--json] | accept <как слышно> [как писать] | dismiss <как слышно>
  chawo-va dictionary learn <было.txt> <стало.txt> [--json] | auto on|off
  chawo-va meeting detect [--json]
  chawo-va crm send <файл.brief.txt> --to amocrm|bitrix|hubspot|webhook [--id N] [--score] [--dry-run] [--yes]
  chawo-va crm config [--to … параметры]
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
      --context <текст> / --context-file <файл>
                         контекст для .brain.txt (как у brain; нужен Мозг)
      --brief / --no-brief
                         ещё и «Кратко и задачи» → .brief.txt (--template / --instruction — формат);
                         по умолчанию — из настроек. Сбой Мозга — пометка, .txt всё равно пишется
      --score / --no-score
                         ещё и «Проверка по чек-листу» → .score.json и .score.txt (--checklist — какой);
                         по умолчанию — из настроек
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
      --context <текст>  контекст для Мозга: имена, термины (только подсказка, в текст не вставляется;
                         с облачным Мозгом уходит на сервер)
      --context-file <файл>  то же из текстового файла (первые 2000 знаков)
      --lang ru|en       язык сообщений
  -q, --quiet

Параметры brief:
      --template <имя>   шаблон: standard, sales-call (разбор звонка продаж), minutes (протокол встречи),
                         summary (краткое резюме) или имя своего шаблона; --template list — показать все
      --instruction «…»  своя инструкция формата (иначе — шаблон из настроек / встроенная)
      --stdout           печатать карточку в stdout вместо .brief.txt
  -o, --out <папка>      куда писать .brief.txt
      --lang ru|en       язык сообщений
  -q, --quiet

Параметры score:
      --checklist <имя>  чек-лист: sales (звонок продаж, встроенный) или имя своего; --checklist list —
                         показать все. По умолчанию — выбранный в приложении
      --stdout           печатать результат в stdout вместо .score.json / .score.txt
      --json             с --stdout: печатать JSON вместо текста
  -o, --out <папка>      куда писать .score.json и .score.txt
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

Параметры stats («Статистика разговора»: доля речи по спикерам, монологи, вопросы, темп, трекеры слов):
  файлы…             .txt (с метками или рядом .srt/.json), .srt или .json; спикеры — после --diarize
      --track «Цена: дорог*, скидк*»
                         свой трекер (можно несколько; «*» — начало слова, фраза — слова подряд);
                         без --track — трекеры из настроек (страница «Файл»), иначе встроенные
      --hits             ещё и фразы, где сработал каждый трекер
      --json             JSON: длительность, спикеры (доля, слова, темп, монолог), трекеры с фразами

Параметры snippets (сниппеты для «вставь <фраза>» при диктовке, тот же snippets.json, что на странице «Словарь»):
      list [--json]      показать (JSON: [{trigger, text}])
      add <фраза> <текст> добавить или заменить; текст «-» — читать из stdin (несколько строк)
      remove <фраза>     удалить

Параметры dictionary (словарь замен «Словаря» и «Из исправлений», learned-words.json; settings.json
только читается — принятые строки приложение перенесёт в «Словарь» само):
      list [--json]      правила: как слышно<TAB>как писать
      suggest [--json]   исправления, повторённые 2+ раза: как слышно<TAB>как писать<TAB>сколько
      accept <как слышно> [как писать]  в словарь (без «как писать» — из предложения)
      dismiss <как слышно>              больше не предлагать
      learn <было.txt> <стало.txt>      запомнить ваши правки слов (--json: fixes, added, suggested)
      auto on|off        добавлять повторённые исправления в словарь сами (по умолчанию off)

Параметры meeting (автоопределение встречи без запуска записи; настройки — из settings.json):
      detect [--json]    есть ли сейчас встреча: приложения (Windows/Linux) и/или локальный .ics (RRULE/EXDATE)
                         JSON: {active, appsSupported, apps, calendar, reasons}

Параметры history (история диктовки, только чтение, новые сверху):
      слова…             поиск: каждое слово должно встретиться (ё = е), как на странице
  -n, --limit <N|all>    сколько записей (по умолчанию 20)
      --json             JSON Lines: id, ts, seconds, final, raw, command, brain, brainFailed
      --raw              ещё и текст до Мозга, если он отличается
  -q, --quiet            без строки «Найдено …»

Параметры ask («Спросить историю»: вопрос по фразам диктовки и расшифровкам встреч):
      вопрос…            например: что обещали клиенту Иванову?
      --in <папка|файл>  где искать вместо папки встреч и папок из настроек (можно несколько)
      --no-history       без фраз диктовки
      --search           только найденные отрывки, без Мозга
  -n, --limit <N>        сколько отрывков (по умолчанию 8, до 30)
      --json             {question, answer, cited, excerpts[…]}

Чего нет в параметрах, берётся из настроек приложения (settings.json, только чтение).
Модели не скачиваются (речь, VAD, спикеры): сначала скачайте их в приложении.
WAV и Ogg/Opus читаются сами, остальные форматы (MP3, M4A, FLAC, …) — через ffmpeg.
Папки — без подпапок, как в приложении.
Ссылки http(s)://… (YouTube и другие сайты) скачиваются через yt-dlp, как «По ссылке» в приложении:
звук — в «Загрузки/Chawo» (или в -o), дальше обычная локальная расшифровка. Через сеть идёт только
скачивание. yt-dlp CLI не скачивает: кнопка «Скачать yt-dlp» в приложении или yt-dlp в PATH.
brain читает готовый .txt и пишет .brain.txt: абзацы без слов-паразитов и «Кратко».
brief читает готовый .txt (рядом с записью или .brain.txt) и пишет .brief.txt через Мозг.
score проверяет звонок по чек-листу через Мозг: по каждому пункту да / частично / нет, цитата и итог.
translate переводит готовый .txt через Мозг (локальный по умолчанию) и пишет .translate.txt.
segments печатает фразы со временем (как карточка «Расшифровка»): .srt → .json → метки в .txt.
stats печатает статистику разговора по готовой расшифровке (как «Статистика разговора» на странице «Файл»).
ask ищет ответ локально; в Мозг уходят только вопрос и несколько найденных отрывков (как «Спросить» на «Истории»).

Коды выхода: 0 — всё готово, 1 — часть файлов не удалась, 2 — ошибка параметров,
3 — нет модели / Мозга / yt-dlp, 130 — прервано (Ctrl+C).`,
    `Chawo Voice Assistant — file transcription, «Brief and tasks», checklist score, call stats, questions over history, dictionary, snippets and CRM export from the command line. Everything is local; nothing is uploaded (links only download).

Usage:
  chawo-va transcribe <files, folders or links…> [options]
  chawo-va brain <transcript.txt…> [options]
  chawo-va brief <transcript.txt…> [options]
  chawo-va score <transcript.txt…> [--checklist name|list] [options]
  chawo-va translate <text.txt…> [--to language] [options]
  chawo-va history [search words…] [-n 20|all] [--json] [--raw]
  chawo-va ask <question…> [--in folder|file.txt]… [--no-history] [--search] [-n 8] [--json]
  chawo-va segments <files.txt|.srt|.json…> [--json]
  chawo-va stats <files.txt|.srt|.json…> [--track "Name: word, wor*"] [--hits] [--json]
  chawo-va snippets list [--json] | add <trigger> <text|-> | remove <trigger>
  chawo-va dictionary list|suggest [--json] | accept <heard> [written] | dismiss <heard>
  chawo-va dictionary learn <before.txt> <after.txt> [--json] | auto on|off
  chawo-va meeting detect [--json]
  chawo-va crm send <file.brief.txt> --to amocrm|bitrix|hubspot|webhook [--id N] [--score] [--dry-run] [--yes]
  chawo-va crm config [--to … options]
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
      --context <text> / --context-file <file>
                         context for .brain.txt (as for brain; needs the Brain)
      --brief / --no-brief
                         also «Brief and tasks» → .brief.txt (--template / --instruction for the format);
                         default: settings. A Brain failure is a note; the .txt is written anyway
      --score / --no-score
                         also «Checklist score» → .score.json and .score.txt (--checklist picks one);
                         default: settings
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
      --context <text>   context for the Brain: names, terms (a hint only, never inserted;
                         with a cloud Brain it goes to the server)
      --context-file <file>  the same from a text file (first 2000 characters)
      --lang ru|en       message language
  -q, --quiet

brief options:
      --template <name>  template: standard, sales-call, minutes, summary or your own template's name;
                         --template list shows them all
      --instruction "…"  custom format instruction (else the template from settings / built-in)
      --stdout           print the card to stdout instead of .brief.txt
  -o, --out <dir>        where to write .brief.txt
      --lang ru|en       message language
  -q, --quiet

score options:
      --checklist <name> checklist: sales (built-in sales call) or your own one's name; --checklist list
                         shows them all. Default: the one picked in the app
      --stdout           print the result instead of writing .score.json / .score.txt
      --json             with --stdout: print JSON instead of text
  -o, --out <dir>        where to write .score.json and .score.txt
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

stats options («Call stats»: talk ratio per speaker, monologues, questions, pace, keyword trackers):
  files…             .txt (with stamps or a sibling .srt/.json), .srt or .json; speakers come from --diarize
      --track "Price: pric*, discount*"
                         your own tracker (repeatable; «*» = word start, a phrase = words in a row);
                         without --track: trackers from settings (File page), else the built-in ones
      --hits             also the phrases each tracker matched
      --json             JSON: duration, speakers (share, words, pace, monologue), trackers with phrases

snippets options (text for «вставь <trigger>» while dictating; the same snippets.json as the Dictionary page):
      list [--json]      show them (JSON: [{trigger, text}])
      add <trigger> <text> add or replace; text «-» reads stdin (several lines)
      remove <trigger>   delete

dictionary options (the Dictionary rules and «From your fixes», learned-words.json; settings.json is
only read — the app moves accepted rows into the Dictionary by itself):
      list [--json]      rules: heard<TAB>written
      suggest [--json]   fixes repeated 2+ times: heard<TAB>written<TAB>count
      accept <heard> [written]   into the dictionary (no written form = from the suggestion)
      dismiss <heard>            do not suggest again
      learn <before.txt> <after.txt>  remember your word fixes (--json: fixes, added, suggested)
      auto on|off        add repeated fixes to the dictionary by themselves (default off)

meeting options (meeting auto-detect without starting a recording; settings from settings.json):
      detect [--json]    whether a meeting looks active: apps (Windows/Linux) and/or a local .ics (RRULE/EXDATE)
                         JSON: {active, appsSupported, apps, calendar, reasons}

history options (dictation history, read-only, newest first):
      words…             search: every word must occur (ё = е), same as the page
  -n, --limit <N|all>    how many entries (default 20)
      --json             JSON Lines: id, ts, seconds, final, raw, command, brain, brainFailed
      --raw              also the text before the Brain, when it differs
  -q, --quiet            no «Found …» line

ask options («Ask history»: a question over dictation phrases and meeting transcripts):
      question…          e.g.: what did we promise client Ivanov?
      --in <dir|file>    where to look instead of the meetings folder and folders from settings (repeatable)
      --no-history       leave dictation phrases out
      --search           only the found excerpts, no Brain
  -n, --limit <N>        how many excerpts (default 8, up to 30)
      --json             {question, answer, cited, excerpts[…]}

Anything not given falls back to the app's settings (settings.json, read-only).
No model is downloaded (speech, VAD, speakers): download them in the app first.
WAV and Ogg/Opus are read natively; other formats (MP3, M4A, FLAC, …) need ffmpeg.
Folders are not searched recursively, same as in the app.
http(s)://… links (YouTube and other sites) are downloaded with yt-dlp, like «By link» in the app:
the audio goes to Downloads/Chawo (or -o), then it is transcribed locally. Only the download uses
the network. The CLI does not fetch yt-dlp: use «Download yt-dlp» in the app or have yt-dlp on PATH.
brain reads a finished .txt and writes .brain.txt: paragraphs without filler words plus «Summary».
brief reads a finished .txt (beside the recording or .brain.txt) and writes .brief.txt via the Brain.
score checks a call against a checklist via the Brain: yes / partial / no per item, a quote and a total.
translate translates a finished .txt via the Brain (local by default) and writes .translate.txt.
segments prints timed phrases (like the Transcript card): .srt → .json → stamps in .txt.
stats prints call stats for a finished transcript (like «Call stats» on the File page).
ask searches locally; only the question and a few found excerpts go to the Brain (like «Ask» on History).

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
