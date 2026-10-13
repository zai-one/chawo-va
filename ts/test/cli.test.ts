import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_INTERRUPTED, EXIT_NO_MODEL, EXIT_OK, EXIT_USAGE, runCli, type CliDefaults, type CliDeps, type EngineConfig } from '../src/cli/run';
import { outputPath } from '../src/main/file/fileTranscript';
import type { TranscriptSegment } from '../src/core/transcriptFormat';

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  files: Map<string, string>;
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
    writeFile: (p, text) => h.files.set(p, text),
    readFile: (p) => {
      if (opts.fileText?.[p] !== undefined) return opts.fileText[p]!;
      if (h.files.has(p)) return h.files.get(p)!;
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
    expect(h.opened).toEqual([{ dir: '/models/v3', kind: 'v3_e2e_rnnt', device: 'cpu', threads: 'auto', script: 'auto' }]);
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
    const body = JSON.stringify({ SpeechModel: 'MultilingualLargeCtc', SpeechDevice: 'Cpu', FileParallelism: 'Two', CtcScript: 'English', FileTimestamps: false, Language: 'English', KeepAwakeWhileListening: true }, null, 1);
    writeFileSync(file, body);
    const before = statSync(file).mtimeMs;
    const { readDefaults } = await import('../src/cli');
    expect(readDefaults()).toEqual({ model: 'multilingual_large_ctc', device: 'cpu', threads: 2, script: 'english', timestamps: false, language: 'English' });
    expect(readFileSync(file, 'utf8')).toBe(body);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it('no settings file → app defaults', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chawo-cli-'));
    process.env.CHAWO_APPDATA = dir;
    const { readDefaults } = await import('../src/cli');
    expect(readDefaults()).toMatchObject({ model: 'v3_e2e_rnnt', device: 'gpu', threads: 'auto', timestamps: true });
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
