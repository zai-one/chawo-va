import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_INTERRUPTED, EXIT_NO_MODEL, EXIT_OK, EXIT_USAGE, runCli, type CliDefaults, type CliDeps, type EngineConfig } from '../src/cli/run';
import { outputPath } from '../src/main/file/fileTranscript';
import type { TranscriptSegment } from '../src/core/transcriptFormat';
import { HistoryStore, type HistoryEntry, type HistoryKeep } from '../src/main/history/historyStore';

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  files: Map<string, string | Buffer>;
  opened: EngineConfig[];
  disposed: number;
  logs: string[];
  ac: AbortController;
}

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 2.5, text: 'Привет.' },
  { start: 3, end: 3.1, text: '  ' },
  { start: 61, end: 64, text: 'Как дела?' },
];

function harness(opts: {
  existing?: string[];
  dirs?: Record<string, string[]>;
  model?: string | null;
  defaults?: Partial<CliDefaults>;
  loadFails?: Record<string, string>;
  /** writeFile throws for paths ending like this. */
  writeFails?: string;
  engineFails?: string;
  isTTY?: boolean;
  onTranscribe?: (h: Harness) => void;
  /** Seed file contents for readFile (brief). */
  fileText?: Record<string, string>;
  briefTarget?: 'None' | 'Local' | 'Cloud';
  briefInstruction?: string;
  briefAsk?: (prompt: string, text: string) => Promise<string>;
  translateTarget?: 'None' | 'Local' | 'Cloud';
  /** Saved TranslateTarget. */
  translateTo?: string;
  translateAsk?: (prompt: string, text: string) => Promise<string>;
} = {}): Harness {
  let lang: 'ru' | 'en' = 'en';
  const h = { out: [], err: [], files: new Map(), opened: [], disposed: 0, logs: [], ac: new AbortController() } as unknown as Harness;
  const existing = new Set(opts.existing ?? []);
  let clock = 1000;
  h.deps = {
    version: '9.9.9',
    out: (s) => h.out.push(s),
    err: (s) => h.err.push(s),
    isTTY: opts.isTTY ?? false,
    defaults: () => ({ model: 'v3_e2e_rnnt', device: 'cpu', threads: 'auto', script: 'auto', timestamps: true, language: 'English', ...opts.defaults }),
    applyLanguage: (c) => {
      lang = c === 'Russian' ? 'ru' : 'en';
    },
    t: (ru, en) => (lang === 'ru' ? ru : en),
    findModel: (_kind, override) => (override ? (override === '/good' ? override : null) : opts.model === undefined ? '/models/v3' : opts.model),
    openEngine: async (cfg) => {
      h.opened.push(cfg);
      if (opts.engineFails) throw new Error(opts.engineFails);
      return {
        summary: 'Auto → 2× CPU',
        device: 'cpu/cpu',
        async transcribe(samples, progress) {
          progress(0, 2, 0, 0);
          progress(1, 2, 30, 3);
          opts.onTranscribe?.(h);
          progress(2, 2, 60, 6);
          return SEGMENTS;
        },
        dispose: async () => {
          h.disposed++;
        },
      };
    },
    load16k: async (path) => {
      if (opts.loadFails?.[path]) throw new Error(opts.loadFails[path]);
      return path.includes('silent') ? new Float32Array(0) : new Float32Array(16000 * 65);
    },
    outputPath,
    briefOutputPath: (txt) => (txt.endsWith('.brain.txt') ? txt.slice(0, -'.brain.txt'.length) : txt.replace(/\.txt$/i, '')) + '.brief.txt',
    translateOutputPath: (txt) => (txt.endsWith('.brain.txt') ? txt.slice(0, -'.brain.txt'.length) : txt.replace(/\.txt$/i, '')) + '.translate.txt',
    translateBrain: () => ({
      target: opts.translateTarget ?? 'Local',
      to: opts.translateTo ?? '',
      ask: async (prompt, text) => (opts.translateAsk ? opts.translateAsk(prompt, text) : 'Hello, world.'),
    }),
    isDirectory: (p) => Boolean(opts.dirs?.[p]),
    exists: (p) => existing.has(p) || h.files.has(p) || Boolean(opts.fileText?.[p]),
    collectFromFolder: (p) => opts.dirs?.[p] ?? [],
    mkdirp: () => undefined,
    writeFile: (p, data) => {
      if (opts.writeFails && p.endsWith(opts.writeFails)) throw new Error('EACCES: permission denied');
      h.files.set(p, data);
    },
    readFile: (p) => {
      if (opts.fileText?.[p] !== undefined) return opts.fileText[p]!;
      if (h.files.has(p)) return String(h.files.get(p)!);
      throw new Error('no such file: ' + p);
    },
    briefBrain: () => ({
      target: opts.briefTarget ?? 'Local',
      instruction: opts.briefInstruction ?? '',
      ask: async (prompt, text) => {
        if (opts.briefAsk) return opts.briefAsk(prompt, text);
        return 'Кратко\n- тест\n\nЗадачи\n- сделать дело\n';
      },
    }),
    log: (l) => h.logs.push(l),
    now: () => (clock += 1500),
    signal: h.ac.signal,
  };
  // Seed fileText into existing set
  for (const k of Object.keys(opts.fileText ?? {})) existing.add(k);
  return h;
}

const run = (h: Harness, ...argv: string[]) => runCli(argv, h.deps);

describe('runCli', () => {
  it('help and version go to stdout', async () => {
    const h = harness();
    expect(await run(h, '--help')).toBe(EXIT_OK);
    expect(h.out.join('')).toContain('chawo-va transcribe');
    expect(await run(h, '--version')).toBe(EXIT_OK);
    expect(h.out.at(-1)).toBe('chawo-va 9.9.9\n');
  });

  it('usage errors → 2 with a hint, in the settings language', async () => {
    const h = harness({ defaults: { language: 'Russian' } });
    expect(await run(h, 'transcribe', 'a.wav', '--model', 'x')).toBe(EXIT_USAGE);
    expect(h.err.join('')).toContain('Справка: chawo-va --help');
    const e = harness({ defaults: { language: 'Russian' } });
    expect(await run(e, 'transcribe', '--lang', 'en')).toBe(EXIT_USAGE);
    expect(e.err.join('')).toContain('See: chawo-va --help');
  });

  it('one file: txt beside the source with timestamps from settings, engine from settings', async () => {
    const h = harness({ existing: ['/rec/talk.wav'] });
    expect(await run(h, 'transcribe', '/rec/talk.wav')).toBe(EXIT_OK);
    expect([...h.files.keys()]).toEqual(['/rec/talk.txt']);
    expect(h.files.get('/rec/talk.txt')).toBe('[00:00:00] Привет.\n[00:01:01] Как дела?');
    expect(h.opened).toEqual([{ dir: '/models/v3', kind: 'v3_e2e_rnnt', device: 'cpu', threads: 'auto', script: 'auto', vad: true }]);
    expect(h.disposed).toBe(1);
    const log = h.err.join('');
    expect(log).toContain('Device: cpu/cpu · Auto → 2× CPU');
    expect(log).toContain('Done: /rec/talk.txt (00:01:05 · 1.5 s)');
    expect(log).not.toContain('[1/1]');
    expect(h.logs[0]).toMatch(/^cli \/rec\/talk.wav audio=65s/);
  });

  it('flags override settings; srt only; --out', async () => {
    const h = harness({ existing: ['/rec/talk.ogg'] });
    expect(await run(h, 'transcribe', '/rec/talk.ogg', '-f', 'srt', '-o', '/out', '--model', 'ctc', '--device', 'gpu', '-j', '4', '--script', 'ru')).toBe(EXIT_OK);
    expect([...h.files.keys()]).toEqual(['/out/talk.srt']);
    expect(h.files.get('/out/talk.srt')).toContain('00:01:01,000 --> 00:01:04,000');
    expect(h.opened[0]).toMatchObject({ kind: 'multilingual_large_ctc', device: 'gpu', threads: 4, script: 'russian' });
  });

  it('--no-timestamps and txt+srt', async () => {
    const h = harness({ existing: ['/a.wav'] });
    expect(await run(h, 'transcribe', '/a.wav', '--no-timestamps', '-f', 'txt,srt')).toBe(EXIT_OK);
    expect(h.files.get('/a.txt')).toBe('Привет.\nКак дела?');
    expect(h.files.has('/a.srt')).toBe(true);
    expect(h.err.join('')).toContain('(00:01:05 · .srt ·');
  });

  it('vtt, json, md, docx beside the .txt, same writers as the page', async () => {
    const h = harness({ existing: ['/rec/talk.wav'] });
    expect(await run(h, 'transcribe', '/rec/talk.wav', '-f', 'txt,vtt,json,md,docx')).toBe(EXIT_OK);
    expect([...h.files.keys()].sort()).toEqual(['/rec/talk.docx', '/rec/talk.json', '/rec/talk.md', '/rec/talk.txt', '/rec/talk.vtt']);
    const vtt = String(h.files.get('/rec/talk.vtt'));
    expect(vtt.startsWith('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\nПривет.')).toBe(true);
    expect(vtt).toContain('2\n00:01:01.000 --> 00:01:04.000\nКак дела?');
    const json = JSON.parse(String(h.files.get('/rec/talk.json'))) as { format: string; source: string; duration: number; segments: unknown[] };
    expect(json).toMatchObject({ format: 'chawo-transcript', source: 'talk.wav', duration: 65 });
    expect(json.segments).toHaveLength(2);
    const md = String(h.files.get('/rec/talk.md'));
    expect(md).toContain('# talk');
    expect(md).toContain('00:01:01');
    const docx = h.files.get('/rec/talk.docx');
    expect(Buffer.isBuffer(docx)).toBe(true);
    expect((docx as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
    expect((docx as Buffer).includes(Buffer.from('word/document.xml'))).toBe(true);
    expect(h.err.join('')).toContain('Done: /rec/talk.txt (00:01:05 · .vtt · .json · .md · .docx ·');
  });

  it('without txt only the asked formats; --out applies to them too', async () => {
    const h = harness({ existing: ['/rec/talk.wav'] });
    expect(await run(h, 'transcribe', '/rec/talk.wav', '-f', 'vtt', '-o', '/out')).toBe(EXIT_OK);
    expect([...h.files.keys()]).toEqual(['/out/talk.vtt']);
  });

  it('one format failing to write: others written, error line, exit 1', async () => {
    const h = harness({ existing: ['/a.wav'], writeFails: '.docx' });
    expect(await run(h, 'transcribe', '/a.wav', '-f', 'txt,docx,vtt')).toBe(EXIT_FAILED);
    expect([...h.files.keys()].sort()).toEqual(['/a.txt', '/a.vtt']);
    expect(h.err.join('')).toContain('Error: docx: EACCES: permission denied');
    expect(h.logs.some((l) => l.includes('export failed: docx'))).toBe(true);
  });

  it('folders expand, duplicates drop, numbered prefixes, model opened once', async () => {
    const h = harness({ existing: ['/d/a.wav'], dirs: { '/d': ['/d/a.wav', '/d/b.mp3'] } });
    expect(await run(h, 'transcribe', '/d/a.wav', '/d')).toBe(EXIT_OK);
    expect([...h.files.keys()].sort()).toEqual(['/d/a.txt', '/d/b.txt']);
    expect(h.opened).toHaveLength(1);
    const log = h.err.join('');
    expect(log).toContain('[1/2] /d/a.wav');
    expect(log).toContain('[2/2] Done: /d/b.txt');
  });

  it('missing file and empty folder count as failures but the rest still runs', async () => {
    const h = harness({ existing: ['/ok.wav'], dirs: { '/empty': [] } });
    expect(await run(h, 'transcribe', '/nope.wav', '/empty', '/ok.wav')).toBe(EXIT_FAILED);
    expect(h.files.has('/ok.txt')).toBe(true);
    expect(h.err.join('')).toContain('no such file: /nope.wav');
    expect(h.err.join('')).toContain('no audio files in /empty');
  });

  it('nothing to do → 1 without loading a model', async () => {
    const h = harness();
    expect(await run(h, 'transcribe', '/nope.wav')).toBe(EXIT_FAILED);
    expect(h.opened).toHaveLength(0);
  });

  it('no model → 3; bad --model-dir names the folder', async () => {
    const h = harness({ existing: ['/a.wav'], model: null });
    expect(await run(h, 'transcribe', '/a.wav')).toBe(EXIT_NO_MODEL);
    expect(h.err.join('')).toContain('--model-dir');
    const b = harness({ existing: ['/a.wav'] });
    expect(await run(b, 'transcribe', '/a.wav', '--model-dir', '/bad')).toBe(EXIT_NO_MODEL);
    expect(b.err.join('')).toContain('/bad has no complete v3_e2e_rnnt model');
    const g = harness({ existing: ['/a.wav'] });
    expect(await run(g, 'transcribe', '/a.wav', '--model-dir', '/good')).toBe(EXIT_OK);
    expect(g.opened[0].dir).toBe('/good');
  });

  it('decode failure and silent file fail only that file', async () => {
    const h = harness({ existing: ['/x.amr', '/silent.wav', '/y.wav'], loadFails: { '/x.amr': 'unsupported audio format' } });
    expect(await run(h, 'transcribe', '/x.amr', '/silent.wav', '/y.wav')).toBe(EXIT_FAILED);
    expect([...h.files.keys()]).toEqual(['/y.txt']);
    const log = h.err.join('');
    expect(log).toContain('[1/3] Error: /x.amr: unsupported audio format');
    expect(log).toContain('[2/3] Error: /silent.wav: The file has no audio.');
  });

  it('engine load failure → 1', async () => {
    const h = harness({ existing: ['/a.wav'], engineFails: 'bad onnx' });
    expect(await run(h, 'transcribe', '/a.wav')).toBe(EXIT_FAILED);
    expect(h.err.join('')).toContain('the model did not load: bad onnx');
  });

  it('two sources mapping to one --out name: the second is refused', async () => {
    const h = harness({ existing: ['/a/talk.wav', '/b/talk.mp3'] });
    expect(await run(h, 'transcribe', '/a/talk.wav', '/b/talk.mp3', '-o', '/out')).toBe(EXIT_FAILED);
    expect([...h.files.keys()]).toEqual(['/out/talk.txt']);
    expect(h.err.join('')).toContain('/out/talk.txt is already written for /a/talk.wav');
  });

  it('--skip-existing skips without loading a model when nothing is left', async () => {
    const h = harness({ existing: ['/a.wav', '/a.txt'], model: null });
    expect(await run(h, 'transcribe', '/a.wav', '--skip-existing')).toBe(EXIT_OK);
    expect(h.opened).toHaveLength(0);
    expect(h.err.join('')).toContain('Skipped, already there: /a.txt');
  });

  it('--stdout prints text, headers only for several files, writes nothing', async () => {
    const one = harness({ existing: ['/a.wav'] });
    expect(await run(one, 'transcribe', '/a.wav', '--stdout', '--no-timestamps', '-q')).toBe(EXIT_OK);
    expect(one.out.join('')).toBe('Привет.\nКак дела?\n');
    expect(one.err).toEqual([]);
    expect(one.files.size).toBe(0);
    const two = harness({ existing: ['/a.wav', '/b.wav'] });
    expect(await run(two, 'transcribe', '/a.wav', '/b.wav', '--stdout')).toBe(EXIT_OK);
    expect(two.out.join('')).toContain('==> /a.wav <==\n[00:00:00] Привет.');
    expect(two.out.join('')).toContain('==> /b.wav <==');
  });

  it('progress redraws one line only on a terminal', async () => {
    const tty = harness({ existing: ['/a.wav'], isTTY: true });
    await run(tty, 'transcribe', '/a.wav');
    expect(tty.err.join('')).toContain('\r\x1b[2KPiece 1 of 2 · 10× faster than real time · ~00:03 left · Auto → 2× CPU');
    const pipe = harness({ existing: ['/a.wav'] });
    await run(pipe, 'transcribe', '/a.wav');
    expect(pipe.err.join('')).not.toContain('Piece');
    const quiet = harness({ existing: ['/a.wav'], isTTY: true });
    await run(quiet, 'transcribe', '/a.wav', '-q');
    expect(quiet.err).toEqual([]);
  });

  it('Ctrl+C mid-file → 130, no output written, engine disposed', async () => {
    const h = harness({ existing: ['/a.wav', '/b.wav'], onTranscribe: (x) => x.ac.abort() });
    expect(await run(h, 'transcribe', '/a.wav', '/b.wav')).toBe(EXIT_INTERRUPTED);
    expect(h.files.size).toBe(0);
    expect(h.disposed).toBe(1);
    expect(h.err.join('')).toContain('Interrupted.');
  });

  it('Russian messages follow settings, --lang overrides', async () => {
    const ru = harness({ existing: ['/a.wav'], defaults: { language: 'Russian' } });
    await run(ru, 'transcribe', '/a.wav');
    expect(ru.err.join('')).toContain('Готово: /a.txt (00:01:05 · 1.5 с)');
    const en = harness({ existing: ['/a.wav'], defaults: { language: 'Russian' } });
    await run(en, 'transcribe', '/a.wav', '--lang', 'en');
    expect(en.err.join('')).toContain('Done: /a.txt');
  });
});

describe('readDefaults (settings.json read-only)', () => {
  const saved = { ...process.env };
  let dir = '';
  afterEach(() => {
    process.env = { ...saved };
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('maps the app settings and never rewrites the file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chawo-cli-'));
    process.env.CHAWO_APPDATA = dir;
    process.env.CHAWO_LOCALAPPDATA = dir;
    const app = join(dir, 'ChawoVoiceAssistant');
    mkdirSync(app, { recursive: true });
    const file = join(app, 'settings.json');
    const body = JSON.stringify({ SpeechModel: 'MultilingualLargeCtc', SpeechDevice: 'Cpu', FileParallelism: 'Two', CtcScript: 'English', FileTimestamps: false, Language: 'English', KeepAwakeWhileListening: true, PostScript: ' python fix.py ', PostScriptFiles: true, HistoryKeep: 'Week' }, null, 1);
    writeFileSync(file, body);
    const before = statSync(file).mtimeMs;
    const { readDefaults } = await import('../src/cli');
    expect(readDefaults()).toEqual({ model: 'multilingual_large_ctc', device: 'cpu', threads: 2, script: 'english', timestamps: false, language: 'English', postScript: 'python fix.py', historyKeep: 'Week', vad: true, diarize: false });
    expect(readFileSync(file, 'utf8')).toBe(body);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it('VadEnabled / FileDiarize are read from settings', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chawo-cli-'));
    process.env.CHAWO_APPDATA = dir;
    process.env.CHAWO_LOCALAPPDATA = dir;
    const app = join(dir, 'ChawoVoiceAssistant');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'settings.json'), JSON.stringify({ VadEnabled: false, FileDiarize: true }));
    const { readDefaults } = await import('../src/cli');
    expect(readDefaults()).toMatchObject({ vad: false, diarize: true });
  });

  it('no settings file → app defaults', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chawo-cli-'));
    process.env.CHAWO_APPDATA = dir;
    const { readDefaults } = await import('../src/cli');
    expect(readDefaults()).toMatchObject({ model: 'v3_e2e_rnnt', device: 'gpu', threads: 'auto', timestamps: true, vad: true, diarize: false });
  });
});

describe('runCli brief', () => {
  it('writes .brief.txt beside the transcript via injected ask', async () => {
    const h = harness({
      fileText: { '/rec/meet.txt': 'Иван: сделаем отчёт к пятнице. Мария согласна.' },
      briefAsk: async () => 'Кратко\n- Обсудили отчёт\n\nЗадачи\n- Иван: отчёт к пятнице\n',
    });
    expect(await run(h, 'brief', '/rec/meet.txt')).toBe(EXIT_OK);
    expect(h.files.get('/rec/meet.brief.txt')).toContain('Задачи');
    expect(h.files.get('/rec/meet.brief.txt')).toContain('Иван');
    expect(h.err.join('')).toContain('Done: /rec/meet.brief.txt');
  });

  it('--instruction override and --stdout', async () => {
    const seen: string[] = [];
    const h = harness({
      fileText: { '/a.txt': 'Hello world meeting.' },
      briefAsk: async (prompt) => {
        seen.push(prompt);
        return 'Summary\n- Hi\n\nTasks\n- none\n';
      },
    });
    expect(await run(h, 'brief', '/a.txt', '--instruction', 'Use English headings only.', '--stdout')).toBe(EXIT_OK);
    expect(seen[0]).toContain('Use English headings only.');
    expect(h.out.join('')).toContain('Summary');
    expect([...h.files.keys()]).toEqual([]);
  });

  it('no Brain → EXIT_NO_MODEL', async () => {
    const h = harness({ fileText: { '/a.txt': 'x' }, briefTarget: 'None' });
    expect(await run(h, 'brief', '/a.txt')).toBe(EXIT_NO_MODEL);
    expect(h.err.join('')).toMatch(/Brain is not set up|Мозг не настроен/);
  });

  it('rejects --format on brief', async () => {
    const h = harness();
    expect(await run(h, 'brief', 'a.txt', '-f', 'srt')).toBe(EXIT_USAGE);
  });
});

describe('runCli translate', () => {
  it('writes .translate.txt beside the transcript; --to picks the language', async () => {
    const seen: string[] = [];
    const h = harness({
      fileText: { '/rec/call.txt': 'Добрый день, коллеги.' },
      translateAsk: async (prompt) => {
        seen.push(prompt);
        return 'Good afternoon, colleagues.';
      },
    });
    expect(await run(h, 'translate', '/rec/call.txt', '--to', 'en')).toBe(EXIT_OK);
    expect(h.files.get('/rec/call.translate.txt')).toBe('Good afternoon, colleagues.\n');
    expect(seen[0]).toContain('into English');
    expect(h.err.join('')).toContain('Done: /rec/call.translate.txt');
  });

  it('no --to → saved TranslateTarget, else auto by the text', async () => {
    const seen: string[] = [];
    const ask = async (prompt: string) => {
      seen.push(prompt);
      return 'x';
    };
    const saved = harness({ fileText: { '/a.txt': 'Привет' }, translateTo: 'немецкий', translateAsk: ask });
    expect(await run(saved, 'translate', '/a.txt')).toBe(EXIT_OK);
    expect(seen[0]).toContain('into German');
    const auto = harness({ fileText: { '/b.txt': 'Hello there' }, translateAsk: ask });
    expect(await run(auto, 'translate', '/b.txt')).toBe(EXIT_OK);
    expect(seen[1]).toContain('into Russian');
  });

  it('--stdout prints and writes nothing; -o puts the file in that folder', async () => {
    const h = harness({ fileText: { '/a.txt': 'Привет' } });
    expect(await run(h, 'translate', '/a.txt', '--to', 'en', '--stdout')).toBe(EXIT_OK);
    expect(h.out.join('')).toBe('Hello, world.\n');
    expect([...h.files.keys()]).toEqual([]);
    const h2 = harness({ fileText: { '/rec/a.brain.txt': 'Привет' } });
    expect(await run(h2, 'translate', '/rec/a.brain.txt', '-o', '/out')).toBe(EXIT_OK);
    expect(h2.files.has(join('/out', 'a.translate.txt'))).toBe(true);
  });

  it('no Brain → EXIT_NO_MODEL; missing file and Brain error → EXIT_FAILED', async () => {
    const none = harness({ fileText: { '/a.txt': 'x' }, translateTarget: 'None' });
    expect(await run(none, 'translate', '/a.txt')).toBe(EXIT_NO_MODEL);
    expect(none.err.join('')).toMatch(/Brain is not set up|Мозг не настроен/);
    const missing = harness();
    expect(await run(missing, 'translate', '/nope.txt')).toBe(EXIT_FAILED);
    const broken = harness({ fileText: { '/a.txt': 'x' }, translateAsk: async () => { throw new Error('brain down'); } });
    expect(await run(broken, 'translate', '/a.txt')).toBe(EXIT_FAILED);
    expect(broken.err.join('')).toContain('brain down');
  });

  it('rejects --format / speech options on translate', async () => {
    expect(await run(harness(), 'translate', 'a.txt', '-f', 'srt')).toBe(EXIT_USAGE);
    expect(await run(harness(), 'translate', 'a.txt', '--model', 'v3')).toBe(EXIT_USAGE);
  });
});

describe('runCli transcribe + «Свой скрипт»', () => {
  const node = JSON.stringify(process.execPath);
  const upper = `${node} ${JSON.stringify(join(__dirname, 'fixtures', 'postscript', 'upper.cjs'))}`;

  it('--post-script runs a real script on the .txt (srt untouched) with CHAWO_FILE', async () => {
    const h = harness({ existing: ['/rec/talk.wav'] });
    expect(await run(h, 'transcribe', '/rec/talk.wav', '-f', 'txt,srt', '--no-timestamps', '--post-script', upper + ' --tag')).toBe(EXIT_OK);
    expect(h.files.get('/rec/talk.txt')).toBe('ПРИВЕТ.\nКАК ДЕЛА? [file talk.wav]');
    expect(h.files.get('/rec/talk.srt')).toContain('Привет.');
    expect(h.err.join('')).toContain('Done: /rec/talk.txt (00:01:05 · script ·');
    expect(h.logs.some((l) => /^post script \(file\): ok/.test(l))).toBe(true);
  });

  it('the script changes only the .txt; vtt/json keep the recognized text', async () => {
    const h = harness({ existing: ['/rec/talk.wav'] });
    expect(await run(h, 'transcribe', '/rec/talk.wav', '-f', 'txt,vtt,json', '--no-timestamps', '--post-script', upper)).toBe(EXIT_OK);
    expect(h.files.get('/rec/talk.txt')).toBe('ПРИВЕТ.\nКАК ДЕЛА?');
    expect(String(h.files.get('/rec/talk.vtt'))).toContain('Привет.');
    expect(String(h.files.get('/rec/talk.json'))).toContain('Как дела?');
  });

  it('settings script applies to --stdout; --no-post-script skips it', async () => {
    const h = harness({ existing: ['/a.wav'], defaults: { postScript: upper } });
    expect(await run(h, 'transcribe', '/a.wav', '--stdout', '--no-timestamps')).toBe(EXIT_OK);
    expect(h.out.join('')).toBe('ПРИВЕТ.\nКАК ДЕЛА?\n');
    const n = harness({ existing: ['/a.wav'], defaults: { postScript: upper } });
    expect(await run(n, 'transcribe', '/a.wav', '--stdout', '--no-timestamps', '--no-post-script')).toBe(EXIT_OK);
    expect(n.out.join('')).toBe('Привет.\nКак дела?\n');
  });

  it('a failing script: .txt as recognized, exit 0, the line says why', async () => {
    const h = harness({ existing: ['/a.wav'] });
    expect(await run(h, 'transcribe', '/a.wav', '--no-timestamps', '--post-script', `${node} -e "process.exit(4)"`)).toBe(EXIT_OK);
    expect(h.files.get('/a.txt')).toBe('Привет.\nКак дела?');
    expect(h.err.join('')).toContain('script: exit code 4, .txt without it');
  });
});

describe('runCli transcribe: VAD and speakers (CLI parity with the page)', () => {
  /** Fake diarizer: the same hook shape as the page's diarizeHook; records calls. */
  function diarizer(result: Array<{ start: number; end: number; speaker: number }> | null | Error) {
    const calls: number[] = [];
    const hook: NonNullable<CliDeps['runDiarize']> = async (pcm, status) => {
      calls.push(pcm.length);
      if (result === null) return null;
      if (result instanceof Error) throw result;
      status('Separating speakers…');
      return result;
    };
    return { hook, calls };
  }
  const TWO = [
    { start: 0, end: 10, speaker: 7 },
    { start: 60, end: 65, speaker: 3 },
  ];

  it('--diarize: speakers from the injected diarizer go into txt, srt, md and --stdout', async () => {
    const h = harness({ existing: ['/rec/talk.wav'] });
    const d = diarizer(TWO);
    h.deps.runDiarize = d.hook;
    expect(await run(h, 'transcribe', '/rec/talk.wav', '--diarize', '-f', 'txt,srt,md,vtt,json')).toBe(EXIT_OK);
    expect(d.calls).toEqual([16000 * 65]);
    expect(h.files.get('/rec/talk.txt')).toBe('[00:00:00] Спикер 1: Привет.\n[00:01:01] Спикер 2: Как дела?');
    expect(String(h.files.get('/rec/talk.srt'))).toContain('Спикер 2: Как дела?');
    expect(String(h.files.get('/rec/talk.md'))).toContain('**[00:00:00]** Спикер 1: Привет.');
    expect(String(h.files.get('/rec/talk.vtt'))).toContain('Спикер 2: Как дела?');
    expect(JSON.parse(String(h.files.get('/rec/talk.json'))).segments.map((x: { speaker?: number }) => x.speaker)).toEqual([1, 2]);
    const log = h.err.join('');
    expect(log).toContain('Separating speakers…');
    expect(log).toMatch(/Done: \/rec\/talk\.txt \(00:01:05 · speakers · \.srt · .*\.md/);

    const o = harness({ existing: ['/a.wav'] });
    o.deps.runDiarize = diarizer(TWO).hook;
    expect(await run(o, 'transcribe', '/a.wav', '--diarize', '--stdout', '--no-timestamps')).toBe(EXIT_OK);
    expect(o.out.join('')).toBe('Спикер 1: Привет.\nСпикер 2: Как дела?\n');
  });

  it('settings FileDiarize turns it on; --no-diarize turns it off; off by default', async () => {
    const on = harness({ existing: ['/a.wav'], defaults: { diarize: true } });
    const d1 = diarizer(TWO);
    on.deps.runDiarize = d1.hook;
    expect(await run(on, 'transcribe', '/a.wav', '--no-timestamps')).toBe(EXIT_OK);
    expect(on.files.get('/a.txt')).toBe('Спикер 1: Привет.\nСпикер 2: Как дела?');

    const off = harness({ existing: ['/a.wav'], defaults: { diarize: true } });
    const d2 = diarizer(TWO);
    off.deps.runDiarize = d2.hook;
    expect(await run(off, 'transcribe', '/a.wav', '--no-timestamps', '--no-diarize')).toBe(EXIT_OK);
    expect(d2.calls).toEqual([]);
    expect(off.files.get('/a.txt')).toBe('Привет.\nКак дела?');

    const dflt = harness({ existing: ['/a.wav'] });
    const d3 = diarizer(TWO);
    dflt.deps.runDiarize = d3.hook;
    expect(await run(dflt, 'transcribe', '/a.wav')).toBe(EXIT_OK);
    expect(d3.calls).toEqual([]);
    expect(dflt.err.join('')).not.toContain('speakers');
  });

  it('models not downloaded: transcript without speakers, exit 0, the line says so (like the page)', async () => {
    const h = harness({ existing: ['/a.wav', '/b.wav'], defaults: { language: 'Russian' } });
    h.deps.runDiarize = diarizer(null).hook;
    expect(await run(h, 'transcribe', '/a.wav', '/b.wav', '--diarize', '--no-timestamps')).toBe(EXIT_OK);
    expect(h.files.get('/a.txt')).toBe('Привет.\nКак дела?');
    expect(h.files.get('/b.txt')).toBe('Привет.\nКак дела?');
    expect(h.err.join('')).toContain('[1/2] Готово: /a.txt (00:01:05 · спикеры: модели не скачаны ·');

    const none = harness({ existing: ['/a.wav'] });
    expect(await run(none, 'transcribe', '/a.wav', '--diarize')).toBe(EXIT_OK);
    expect(none.err.join('')).toContain('speakers: models not downloaded');
  });

  it('a diarizer error or no spans: soft note, transcript written, exit 0', async () => {
    const h = harness({ existing: ['/a.wav'] });
    h.deps.runDiarize = diarizer(new Error('bad onnx')).hook;
    expect(await run(h, 'transcribe', '/a.wav', '--diarize', '--no-timestamps')).toBe(EXIT_OK);
    expect(h.files.get('/a.txt')).toBe('Привет.\nКак дела?');
    expect(h.err.join('')).toContain('speakers: bad onnx');

    const e = harness({ existing: ['/a.wav'] });
    e.deps.runDiarize = diarizer([]).hook;
    expect(await run(e, 'transcribe', '/a.wav', '--diarize')).toBe(EXIT_OK);
    expect(e.err.join('')).toContain('speakers: no segments');
  });

  it('speakers before «Свой скрипт»: the script sees the labelled text', async () => {
    const node = JSON.stringify(process.execPath);
    const upper = `${node} ${JSON.stringify(join(__dirname, 'fixtures', 'postscript', 'upper.cjs'))}`;
    const h = harness({ existing: ['/a.wav'] });
    h.deps.runDiarize = diarizer(TWO).hook;
    expect(await run(h, 'transcribe', '/a.wav', '--diarize', '--no-timestamps', '--post-script', upper)).toBe(EXIT_OK);
    expect(h.files.get('/a.txt')).toBe('СПИКЕР 1: ПРИВЕТ.\nСПИКЕР 2: КАК ДЕЛА?');
  });

  it('Ctrl+C during diarization → 130, nothing written', async () => {
    const h = harness({ existing: ['/a.wav'] });
    h.deps.runDiarize = async () => {
      h.ac.abort();
      return TWO;
    };
    expect(await run(h, 'transcribe', '/a.wav', '--diarize')).toBe(EXIT_INTERRUPTED);
    expect(h.files.size).toBe(0);
  });

  it('VadEnabled from settings goes to the engine; --vad / --no-vad override; engine status lines are printed', async () => {
    const h = harness({ existing: ['/a.wav'], defaults: { vad: false } });
    expect(await run(h, 'transcribe', '/a.wav')).toBe(EXIT_OK);
    expect(h.opened[0]).toMatchObject({ vad: false });
    expect(await run(h, 'transcribe', '/a.wav', '--vad', '--skip-existing')).toBe(EXIT_OK);
    expect(h.opened).toHaveLength(1);
    const v = harness({ existing: ['/a.wav'], defaults: { vad: false } });
    expect(await run(v, 'transcribe', '/a.wav', '--vad')).toBe(EXIT_OK);
    expect(v.opened[0]).toMatchObject({ vad: true });
    const n = harness({ existing: ['/a.wav'] });
    expect(await run(n, 'transcribe', '/a.wav', '--no-vad')).toBe(EXIT_OK);
    expect(n.opened[0]).toMatchObject({ vad: false });

    const s = harness({ existing: ['/a.wav'], isTTY: true });
    const open = s.deps.openEngine;
    s.deps.openEngine = async (cfg) => {
      const e = await open(cfg);
      return { ...e, transcribe: (x, p, sig, status) => (status?.('Finding pauses in speech…'), e.transcribe(x, p, sig, status)) };
    };
    expect(await run(s, 'transcribe', '/a.wav')).toBe(EXIT_OK);
    expect(s.err).toContain('Finding pauses in speech…\n');
    const q = harness({ existing: ['/a.wav'] });
    q.deps.openEngine = s.deps.openEngine;
    expect(await run(q, 'transcribe', '/a.wav', '-q')).toBe(EXIT_OK);
    expect(q.err.join('')).toBe('');
  });
});

describe('cli history', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const DAY = 86400000;
  // 2026-10-13 15:00 local
  const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime();

  function seeded(entries: Array<Partial<HistoryEntry> & { final: string; ago: number }>, keep: HistoryKeep = 'Forever') {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-hist-'));
    dirs.push(dir);
    const path = join(dir, 'history.jsonl');
    const store = new HistoryStore(path, () => NOW);
    for (const e of entries) {
      store.add({ raw: e.raw ?? e.final, final: e.final, command: e.command ?? null, brain: e.brain ?? false, brainFailed: e.brainFailed ?? false, seconds: e.seconds ?? 2, ts: NOW - e.ago }, 'Forever');
    }
    const h = harness({ defaults: { historyKeep: keep } });
    h.deps.historyPath = () => path;
    h.deps.clock = () => NOW;
    return { h, path, before: readFileSync(path, 'utf8') };
  }

  it('newest first, same tags as the page; read-only', async () => {
    const { h, path, before } = seeded([
      { final: 'Старая фраза про счёт.', ago: 3 * DAY },
      { final: 'Hello, world.', raw: 'привет мир', command: 'переведи на английский', brain: true, ago: DAY, seconds: 3.25 },
      { final: 'Свежая фраза.', ago: 60000, brainFailed: true, brain: true },
    ]);
    expect(await run(h, 'history')).toBe(EXIT_OK);
    const out = h.out.join('');
    expect(out.indexOf('Свежая')).toBeLessThan(out.indexOf('Hello'));
    expect(out.indexOf('Hello')).toBeLessThan(out.indexOf('Старая'));
    expect(out).toContain('— today 14:59 · 2.0 s · Brain failed\nСвежая фраза.\n');
    expect(out).toContain('— yesterday 15:00 · 3.3 s · Brain · «переведи на английский»\nHello, world.\n');
    expect(out).toContain('— 10.10 15:00 · 2.0 s\nСтарая фраза про счёт.\n');
    expect(out).not.toContain('Recognized');
    expect(h.err.join('')).toContain('3 phrases.');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('search: every word, ё = е, over final/raw/command; count line', async () => {
    const { h } = seeded([
      { final: 'Выставить счёт Иванову.', ago: 3 * DAY },
      { final: 'Счет оплачен.', ago: 2 * DAY },
      { final: 'Hello.', raw: 'счет иванову отправлен', ago: DAY },
      { final: 'Другое.', ago: 1000 },
    ]);
    expect(await run(h, 'history', 'СЧЕТ', 'иванову')).toBe(EXIT_OK);
    const out = h.out.join('');
    expect(out).toContain('Выставить счёт Иванову.');
    expect(out).toContain('Hello.');
    expect(out).not.toContain('Счет оплачен');
    expect(out).not.toContain('Другое');
    expect(h.err.join('')).toContain('Found 2 of 4.');
  });

  it('--raw shows the text before the Brain only when it differs', async () => {
    const { h } = seeded([
      { final: 'Hello.', raw: 'привет', brain: true, ago: 2000 },
      { final: 'Same.', raw: 'Same.', ago: 1000 },
    ]);
    expect(await run(h, 'history', '--raw')).toBe(EXIT_OK);
    const out = h.out.join('');
    expect(out).toContain('Hello.\n  Recognized: привет\n');
    expect(out.match(/Recognized/g)?.length).toBe(1);
  });

  it('-n limits, says how many; -n all shows all; -q drops the line', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ final: `Фраза ${i}.`, ago: (25 - i) * 60000 }));
    const { h, path } = seeded(many);
    expect(await run(h, 'history')).toBe(EXIT_OK);
    expect(h.out.join('').match(/^— /gm)?.length).toBe(20);
    expect(h.out.join('')).toContain('Фраза 24.');
    expect(h.out.join('')).not.toContain('Фраза 4.');
    expect(h.err.join('')).toContain('Showing the last 20 of 25 (-n all for every one).');
    const a = harness({ defaults: { historyKeep: 'Forever' } });
    a.deps.historyPath = () => path;
    a.deps.clock = () => NOW;
    expect(await run(a, 'history', '-n', 'all', '-q')).toBe(EXIT_OK);
    expect(a.out.join('').match(/^— /gm)?.length).toBe(25);
    expect(a.err.join('')).toBe('');
    const s = harness({ defaults: { historyKeep: 'Forever' } });
    s.deps.historyPath = () => path;
    s.deps.clock = () => NOW;
    expect(await run(s, 'history', 'фраза', '-n', '3')).toBe(EXIT_OK);
    expect(s.err.join('')).toContain('Found 25 of 25, showing 3 (-n all for every one).');
  });

  it('--json: one JSON line per entry with ISO ts', async () => {
    const { h } = seeded([{ final: 'Привет.', raw: 'привет', command: 'исправь', brain: true, ago: 1000, seconds: 1.5 }]);
    expect(await run(h, 'history', '--json')).toBe(EXIT_OK);
    const lines = h.out.join('').trim().split('\n');
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]!);
    expect(o).toMatchObject({ ts: new Date(NOW - 1000).toISOString(), seconds: 1.5, final: 'Привет.', raw: 'привет', command: 'исправь', brain: true, brainFailed: false });
    expect(typeof o.id).toBe('string');
  });

  it('«Хранить» period hides older entries without deleting them; Off says so', async () => {
    const { h, path, before } = seeded([
      { final: 'Неделю назад.', ago: 8 * DAY },
      { final: 'Сегодня.', ago: 1000 },
    ], 'Week');
    expect(await run(h, 'history')).toBe(EXIT_OK);
    expect(h.out.join('')).toContain('Сегодня.');
    expect(h.out.join('')).not.toContain('Неделю назад');
    expect(readFileSync(path, 'utf8')).toBe(before);
    const off = harness({ defaults: { historyKeep: 'Off' } });
    off.deps.historyPath = () => path;
    expect(await run(off, 'history')).toBe(EXIT_OK);
    expect(off.out.join('')).toBe('');
    expect(off.err.join('')).toContain('History is off');
  });

  it('no file / nothing found / Russian messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-hist-'));
    dirs.push(dir);
    const h = harness({ defaults: { historyKeep: 'Month' } });
    h.deps.historyPath = () => join(dir, 'history.jsonl');
    expect(await run(h, 'history')).toBe(EXIT_OK);
    expect(h.err.join('')).toContain('Empty so far');
    const { h: r } = seeded([{ final: 'Привет.', ago: 1000 }]);
    expect(await run(r, 'history', 'нет-такого', '--lang', 'ru')).toBe(EXIT_OK);
    expect(r.out.join('')).toBe('');
    expect(r.err.join('')).toContain('Ничего не нашлось (всего фраз: 1).');
    const { h: ru } = seeded([{ final: 'Привет.', ago: 60000, seconds: 2.5 }]);
    expect(await run(ru, 'history', '--lang', 'ru')).toBe(EXIT_OK);
    expect(ru.out.join('')).toContain('— сегодня 14:59 · 2,5 с\nПривет.\n');
    expect(ru.err.join('')).toContain('Всего фраз: 1.');
  });
});

