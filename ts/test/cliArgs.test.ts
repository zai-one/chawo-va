import { describe, expect, it } from 'vitest';
import { helpText, parseArgs } from '../src/cli/args';

const ok = (argv: string[]) => {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error(r.error);
  return r.options;
};
const err = (argv: string[]) => {
  const r = parseArgs(argv);
  if (r.ok) throw new Error('expected an error');
  return r.error;
};

describe('cli args', () => {
  it('no arguments, --help, help → help; --version → version', () => {
    expect(ok([]).command).toBe('help');
    expect(ok(['--help']).command).toBe('help');
    expect(ok(['-h']).command).toBe('help');
    expect(ok(['help']).command).toBe('help');
    expect(ok(['transcribe', 'a.wav', '--help']).command).toBe('help');
    expect(ok(['--version']).command).toBe('version');
    expect(ok(['-v']).command).toBe('version');
  });

  it('unknown command is an error', () => {
    expect(err(['transcode', 'a.wav'])).toContain('unknown command');
  });

  it('defaults leave everything to settings', () => {
    const o = ok(['transcribe', 'a.wav', 'dir']);
    expect(o.inputs).toEqual(['a.wav', 'dir']);
    expect(o).toMatchObject({ formats: [], outDir: null, timestamps: null, model: null, device: null, threads: null, script: null, modelDir: null, stdout: false, skipExisting: false, quiet: false, lang: null });
  });

  it('formats: comma list, dots, repeats, dedupe, unknown rejected', () => {
    expect(ok(['transcribe', 'a', '-f', 'srt,.TXT']).formats).toEqual(['srt', 'txt']);
    expect(ok(['transcribe', 'a', '--format=txt', '--format', 'srt,txt']).formats).toEqual(['txt', 'srt']);
    expect(err(['transcribe', 'a', '-f', 'pdf'])).toContain('unknown format: pdf');
    expect(err(['transcribe', 'a', '-f', ','])).toContain('empty');
  });

  it('formats: vtt, json, md, docx like «Ещё сохранять рядом»; --stdout names what to drop', () => {
    expect(ok(['transcribe', 'a', '-f', 'txt,srt,vtt,json,md,docx']).formats).toEqual(['txt', 'srt', 'vtt', 'json', 'md', 'docx']);
    expect(ok(['transcribe', 'a', '-f', '.DOCX,Md']).formats).toEqual(['docx', 'md']);
    expect(err(['transcribe', 'a', '-f', 'pdf'])).toContain('txt, srt, vtt, json, md, docx');
    expect(err(['transcribe', 'a', '--stdout', '-f', 'txt,vtt,json'])).toContain('drop --format vtt,json');
  });

  it('valued options in both spellings', () => {
    const o = ok(['transcribe', 'a', '-o', 'out', '--model=ctc', '--device', 'CPU', '-j', '2', '--script', 'en', '--model-dir', '/m', '--lang', 'ru']);
    expect(o).toMatchObject({ outDir: 'out', model: 'multilingual_large_ctc', device: 'cpu', threads: 2, script: 'english', modelDir: '/m', lang: 'Russian' });
    expect(ok(['transcribe', 'a', '--model', 'v3', '-j', 'max']).threads).toBe('max');
    expect(ok(['transcribe', 'a', '--model', 'v3']).model).toBe('v3_e2e_rnnt');
    expect(ok(['transcribe', 'a', '--threads=auto']).threads).toBe('auto');
  });

  it('bad values are named', () => {
    expect(err(['transcribe', 'a', '--model', 'whisper'])).toContain('unknown model');
    expect(err(['transcribe', 'a', '--device', 'npu'])).toContain('unknown device');
    expect(err(['transcribe', 'a', '-j', '3'])).toContain('--threads');
    expect(err(['transcribe', 'a', '--script', 'de'])).toContain('--script');
    expect(err(['transcribe', 'a', '--lang', 'de'])).toContain('--lang');
    expect(err(['transcribe', 'a', '--out'])).toContain('needs a value');
    expect(err(['transcribe', 'a', '--quiet=yes'])).toContain('takes no value');
    expect(err(['transcribe', 'a', '--wat'])).toContain('unknown option');
  });

  it('flags', () => {
    expect(ok(['transcribe', 'a', '-t', '-q', '--skip-existing'])).toMatchObject({ timestamps: true, quiet: true, skipExisting: true });
    expect(ok(['transcribe', 'a', '--no-timestamps']).timestamps).toBe(false);
    expect(ok(['transcribe', 'a', '--stdout']).stdout).toBe(true);
  });

  it('-- ends options; stdin and empty input refused', () => {
    expect(ok(['transcribe', '--', '-odd.wav', '--x']).inputs).toEqual(['-odd.wav', '--x']);
    expect(err(['transcribe'])).toContain('no files');
    expect(err(['transcribe', '-q'])).toContain('no files');
    expect(err(['transcribe', '-'])).toContain('stdin');
  });

  it('--stdout conflicts', () => {
    expect(err(['transcribe', 'a', '--stdout', '-o', 'x'])).toContain('--stdout');
    expect(err(['transcribe', 'a', '--stdout', '-f', 'srt'])).toContain('--stdout');
    expect(ok(['transcribe', 'a', '--stdout', '-f', 'txt']).stdout).toBe(true);
  });


  it('brief command + --instruction; rejects speech-only flags', () => {
    expect(ok(['brief', 'a.txt']).command).toBe('brief');
    expect(ok(['brief', 'a.txt', '--instruction', 'Только задачи']).instruction).toBe('Только задачи');
    expect(err(['brief', 'a.txt', '-f', 'srt'])).toContain('brief writes');
    expect(err(['brief', 'a.txt', '--model', 'v3'])).toContain('transcript');
    expect(err(['brief', '--instruction'])).toContain('needs a value');
  });

  it('translate command + --to; rejects speech-only flags and misplaced options', () => {
    expect(ok(['translate', 'a.txt']).command).toBe('translate');
    expect(ok(['translate', 'a.txt']).to).toBeNull();
    expect(ok(['translate', 'a.txt', '--to', 'en']).to).toBe('en');
    expect(ok(['translate', 'a.txt', '--to=немецкий']).to).toBe('немецкий');
    expect(ok(['translate', 'a.txt', '--stdout']).stdout).toBe(true);
    expect(err(['translate', 'a.txt', '-f', 'srt'])).toContain('translate writes');
    expect(err(['translate', 'a.txt', '--device', 'gpu'])).toContain('transcript');
    expect(err(['translate', 'a.txt', '--instruction', 'x'])).toContain('--instruction is for brief');
    expect(err(['translate', 'a.txt', '--to'])).toContain('needs a value');
    expect(err(['translate', 'a.txt', '--to', ' '])).toContain('--to is empty');
    expect(err(['brief', 'a.txt', '--to', 'en'])).toContain('--to is for translate');
    expect(err(['transcribe', 'a.wav', '--to', 'en'])).toContain('--to is for translate');
  });

  it('help mentions translate and --to in both languages', () => {
    for (const lang of [(ru: string) => ru, (_: string, en: string) => en]) {
      const h = helpText(lang);
      expect(h).toContain('chawo-va translate');
      expect(h).toContain('--to');
      expect(h).toContain('.translate.txt');
    }
  });

  it('help in both languages names every option and the exit codes', () => {
    for (const lang of [(ru: string) => ru, (_: string, en: string) => en]) {
      const h = helpText(lang);
      for (const opt of ['--format', '--out', '--timestamps', '--no-timestamps', '--stdout', '--skip-existing', '--model', '--device', '--threads', '--script', '--model-dir', '--lang', '--quiet', '--version']) {
        expect(h).toContain(opt);
      }
      expect(h).toContain('130');
    }
  });
});

describe('langFromArgv', () => {
  it('finds --lang even in a broken line, stops at --', async () => {
    const { langFromArgv } = await import('../src/cli/args');
    expect(langFromArgv(['transcribe', '--wat', '--lang', 'en'])).toBe('English');
    expect(langFromArgv(['transcribe', '--lang=RU'])).toBe('Russian');
    expect(langFromArgv(['transcribe', '--lang', 'de'])).toBeNull();
    expect(langFromArgv(['transcribe', '--', '--lang', 'en'])).toBeNull();
    expect(langFromArgv(['transcribe', '--lang'])).toBeNull();
  });

  it('--vad / --no-vad / --diarize / --no-diarize: transcribe only, null = settings, not both', () => {
    expect(ok(['transcribe', 'a.wav'])).toMatchObject({ vad: null, diarize: null });
    expect(ok(['transcribe', 'a.wav', '--vad', '--diarize'])).toMatchObject({ vad: true, diarize: true });
    expect(ok(['transcribe', 'a.wav', '--no-vad', '--no-diarize'])).toMatchObject({ vad: false, diarize: false });
    expect(ok(['transcribe', '--diarize', 'a.wav', '-f', 'srt'])).toMatchObject({ diarize: true, inputs: ['a.wav'], formats: ['srt'] });
    expect(ok(['transcribe', '--', '--diarize']).inputs).toEqual(['--diarize']);
    expect(err(['transcribe', 'a.wav', '--vad', '--no-vad'])).toContain('--vad and --no-vad cannot be used together');
    expect(err(['transcribe', 'a.wav', '--no-diarize', '--diarize'])).toContain('--diarize and --no-diarize cannot be used together');
    expect(err(['transcribe', 'a.wav', '--diarize=yes'])).toContain('--diarize takes no value');
    expect(err(['brief', 'a.txt', '--diarize'])).toContain('are for transcribe');
    expect(err(['translate', 'a.txt', '--no-vad'])).toContain('are for transcribe');
    expect(err(['history', '--diarize'])).toContain('are for transcribe');
    for (const lang of ['ru', 'en'] as const) {
      const help = helpText((ru, en) => (lang === 'ru' ? ru : en));
      for (const flag of ['--vad', '--no-vad', '--diarize', '--no-diarize']) expect(help).toContain(flag);
      expect(help).toContain('Спикер 1');
    }
    expect(helpText((ru) => ru)).toContain('разделять спикеров');
    expect(helpText((_ru, en) => en)).toContain('separate speakers');
  });

  it('--post-script / --no-post-script: transcribe only, not both', () => {
    expect(ok(['transcribe', 'a.wav']).postScript).toBeNull();
    expect(ok(['transcribe', 'a.wav']).noPostScript).toBe(false);
    expect(ok(['transcribe', 'a.wav', '--post-script', 'python fix.py']).postScript).toBe('python fix.py');
    expect(ok(['transcribe', 'a.wav', '--post-script=sed s/a/b/']).postScript).toBe('sed s/a/b/');
    expect(ok(['transcribe', 'a.wav', '--no-post-script']).noPostScript).toBe(true);
    expect(err(['transcribe', 'a.wav', '--post-script', ' '])).toContain('--post-script is empty');
    expect(err(['transcribe', 'a.wav', '--post-script', 'x', '--no-post-script'])).toContain('cannot be used together');
    expect(err(['brief', 'a.txt', '--post-script', 'x'])).toContain('--post-script is for transcribe');
    expect(err(['translate', 'a.txt', '--no-post-script'])).toContain('--post-script is for transcribe');
    const help = helpText((_ru, en) => en);
    expect(help).toContain('--post-script');
    expect(help).toContain('--no-post-script');
  });

  it('history: search words, -n N|all, --json, --raw; no file/speech options; history flags elsewhere refused', () => {
    const o = ok(['history']);
    expect(o.command).toBe('history');
    expect(o.inputs).toEqual([]);
    expect(o.limit).toBeNull();
    expect(ok(['history', 'счёт', 'Иванов']).inputs).toEqual(['счёт', 'Иванов']);
    expect(ok(['history', '-n', '5']).limit).toBe(5);
    expect(ok(['history', '--limit=all']).limit).toBe(Number.POSITIVE_INFINITY);
    expect(ok(['history', '-n', '0']).limit).toBe(Number.POSITIVE_INFINITY);
    expect(ok(['history', '--json', '--raw', '-q', '--lang', 'ru'])).toMatchObject({ json: true, raw: true, quiet: true, lang: 'Russian' });
    expect(ok(['history', '--', '-минус']).inputs).toEqual(['-минус']);
    expect(err(['history', '-n', 'ten'])).toContain('bad --limit');
    expect(err(['history', '-n', '-3'])).toContain('bad --limit');
    expect(err(['history', '--stdout'])).toContain('history prints to stdout');
    expect(err(['history', '-o', 'x'])).toContain('history prints to stdout');
    expect(err(['history', '-f', 'srt'])).toContain('history prints to stdout');
    expect(err(['history', '--model', 'v3'])).toContain('history prints to stdout');
    expect(err(['history', '--to', 'en'])).toContain('history takes');
    expect(err(['transcribe', 'a.wav', '--json'])).toContain('are for history');
    expect(err(['brief', 'a.txt', '-n', '3'])).toContain('are for history');
    expect(err(['translate', 'a.txt', '--raw'])).toContain('are for history');
    for (const lang of ['ru', 'en'] as const) {
      const help = helpText((ru, en) => (lang === 'ru' ? ru : en));
      expect(help).toContain('chawo-va history');
      expect(help).toContain('chawo-va segments');
      expect(help).toContain('--limit');
      expect(help).toContain('--json');
      expect(help).toContain('--raw');
    }
  });

  it('stats: transcript files, --track (repeatable), --hits, --json; refuses others', () => {
    expect(ok(['stats', 'a.srt'])).toMatchObject({ command: 'stats', inputs: ['a.srt'], json: false, hits: false, track: [] });
    expect(ok(['stats', 'a.json', '--json', '--hits', '--track', 'Цена: цен*', '--track=Шаг: созвон*'])).toMatchObject({ json: true, hits: true, track: ['Цена: цен*', 'Шаг: созвон*'] });
    expect(err(['stats'])).toMatch(/no files|needs transcript files/);
    expect(err(['stats', 'a.txt', '--raw'])).toContain('stats takes');
    expect(err(['stats', 'a.txt', '--model', 'v3'])).toContain('stats prints');
    expect(err(['stats', 'a.txt', '--track', ' '])).toContain('--track is empty');
    expect(err(['segments', 'a.txt', '--hits'])).toContain('are for stats');
    expect(err(['transcribe', 'a.wav', '--track', 'x'])).toContain('are for stats');
    for (const lang of ['ru', 'en'] as const) {
      const help = helpText((ru, en) => (lang === 'ru' ? ru : en));
      expect(help).toContain('chawo-va stats');
      expect(help).toContain('--track');
      expect(help).toContain('--hits');
    }
  });

  it('segments: transcript files and optional --json; refuses speech/history-only flags', () => {
    expect(ok(['segments', 'a.srt', 'b.txt'])).toMatchObject({ command: 'segments', inputs: ['a.srt', 'b.txt'], json: false });
    expect(ok(['segments', 'a.json', '--json', '-q'])).toMatchObject({ command: 'segments', json: true, quiet: true });
    expect(err(['segments'])).toContain('no files');
    expect(err(['segments', 'a.txt', '--raw'])).toContain('segments takes');
    expect(err(['segments', 'a.txt', '--model', 'v3'])).toContain('segments prints');
    expect(err(['segments', 'a.txt', '-n', '3'])).toContain('segments takes');
  });
});

describe('brain command and --brain / --brief', () => {
  it('brain takes .txt files, -t/--no-timestamps, --stdout, -o; refuses speech/format/brief options', () => {
    expect(ok(['brain', 'a.txt', 'b.txt'])).toMatchObject({ command: 'brain', inputs: ['a.txt', 'b.txt'], timestamps: null, stdout: false });
    expect(ok(['brain', 'a.txt', '--no-timestamps', '--stdout'])).toMatchObject({ timestamps: false, stdout: true });
    expect(ok(['brain', 'a.txt', '-o', 'out'])).toMatchObject({ outDir: 'out' });
    expect(err(['brain', 'a.txt', '-f', 'srt'])).toContain('brain writes .brain.txt');
    expect(err(['brain', 'a.txt', '--model', 'v3'])).toContain('speech options are for transcribe');
    expect(err(['brain', 'a.txt', '--instruction', 'x'])).toContain('--instruction is for brief');
    expect(err(['brain', 'a.txt', '--to', 'en'])).toContain('--to is for translate');
    expect(err(['brain'])).toBe('no files given');
  });

  it('--brain / --brief: transcribe only, null = settings, not both ways at once', () => {
    expect(ok(['transcribe', 'a.wav'])).toMatchObject({ brain: null, brief: null });
    expect(ok(['transcribe', 'a.wav', '--brain', '--no-brief'])).toMatchObject({ brain: true, brief: false });
    expect(ok(['transcribe', 'a.wav', '--brief', '--instruction', 'Only tasks.'])).toMatchObject({ brief: true, instruction: 'Only tasks.' });
    expect(err(['transcribe', 'a.wav', '--brain', '--no-brain'])).toContain('cannot be used together');
    expect(err(['transcribe', 'a.wav', '--brief', '--no-brief'])).toContain('cannot be used together');
    expect(err(['brain', 'a.txt', '--brief'])).toContain('already does it');
    expect(err(['translate', 'a.txt', '--brain'])).toBe('--brain and --brief are for transcribe');
    expect(err(['history', '--brief'])).toBe('--brain and --brief are for transcribe');
  });

  it('help names brain, --brain and --brief in both languages', () => {
    for (const lang of ['ru', 'en'] as const) {
      const help = helpText((ru, en) => (lang === 'ru' ? ru : en));
      expect(help).toContain('chawo-va brain <');
      expect(help).toContain('--brain / --no-brain');
      expect(help).toContain('--brief / --no-brief');
      expect(help).toContain('.brain.txt');
    }
  });
});

describe('--lang before the command', () => {
  it('moves a leading --lang after the command', () => {
    const r = parseArgs(['--lang', 'ru', 'transcribe', 'a.wav']);
    expect(r.ok && r.options).toMatchObject({ command: 'transcribe', inputs: ['a.wav'], lang: 'Russian' });
    const eq = parseArgs(['--lang=en', 'history', 'ёж']);
    expect(eq.ok && eq.options).toMatchObject({ command: 'history', inputs: ['ёж'], lang: 'English' });
  });
  it('still reaches help / version and reports a missing value', () => {
    const h = parseArgs(['--lang', 'ru', '--help']);
    expect(h.ok && h.options.command).toBe('help');
    const v = parseArgs(['--lang', 'en', '--version']);
    expect(v.ok && v.options.command).toBe('version');
    const bad = parseArgs(['--lang']);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('--lang');
  });

  it('serve: host/port/token/data-dir; no files; gpu refused', () => {
    const o = ok(['serve', '--host', '0.0.0.0', '--port', '19000', '--token', 'sekrit', '--data-dir', '/tmp/x', '--model', 'v3', '-j', '2']);
    expect(o).toMatchObject({ command: 'serve', host: '0.0.0.0', port: 19000, token: 'sekrit', dataDir: '/tmp/x', model: 'v3_e2e_rnnt', threads: 2, inputs: [] });
    expect(err(['serve', 'a.wav'])).toContain('no file');
    expect(err(['serve', '--device', 'gpu'])).toContain('CPU-only');
    expect(err(['serve', '--port', '99999'])).toContain('bad --port');
    expect(err(['transcribe', 'a.wav', '--host', '0.0.0.0'])).toContain('for serve');
  });

  it('transcribe --server / --token', () => {
    const o = ok(['transcribe', 'a.wav', '--server', 'http://192.168.1.2:17831', '--token', 't']);
    expect(o).toMatchObject({ server: 'http://192.168.1.2:17831', token: 't' });
    expect(err(['brain', 'a.txt', '--server', 'http://x'])).toContain('--server is for transcribe');
    expect(err(['transcribe', 'a.wav', '--server'])).toContain('needs a value');
    expect(helpText((r) => r)).toMatch(/chawo-va serve/);
    expect(helpText((_, e) => e)).toMatch(/--server/);
  });

});

describe('ask command', () => {
  it('question words, --in (repeatable), --no-history, --search, -n, --json', () => {
    const o = ok(['ask', 'что', 'обещали', 'Иванову?', '--in', '/a', '--in=/b', '--no-history', '--search', '-n', '5', '--json']);
    expect(o.command).toBe('ask');
    expect(o.inputs).toEqual(['что', 'обещали', 'Иванову?']);
    expect(o.askIn).toEqual(['/a', '/b']);
    expect(o.noHistory).toBe(true);
    expect(o.searchOnly).toBe(true);
    expect(o.limit).toBe(5);
    expect(o.json).toBe(true);
    expect(ok(['ask', 'x', '-n', 'all']).limit).toBe(30);
  });

  it('refuses a missing question, file options and ask flags elsewhere', () => {
    expect(err(['ask'])).toContain('needs a question');
    expect(err(['ask', 'x', '--out', '/o'])).toContain('ask prints to stdout');
    expect(err(['ask', 'x', '--context', 'y'])).toContain('ask prints to stdout');
    expect(err(['ask', 'x', '--in'])).toContain('--in needs a value');
    expect(err(['history', '--search'])).toContain('are for ask');
    expect(err(['transcribe', 'a.wav', '--in', '/a'])).toContain('are for ask');
  });
});
describe('brain --context / --context-file («Контекст для Мозга»)', () => {
  it('parses both forms; off by default', () => {
    const a = parseArgs(['brain', 'a.txt']);
    expect(a.ok && a.options.context === null && a.options.contextFile === null).toBe(true);
    const b = parseArgs(['brain', 'a.txt', '--context', 'Анна Карпенко']);
    expect(b.ok && b.options.context).toBe('Анна Карпенко');
    const c = parseArgs(['brain', 'a.txt', '--context-file=ctx.txt']);
    expect(c.ok && c.options.contextFile).toBe('ctx.txt');
  });
  it('rejects misuse', () => {
    expect(parseArgs(['brain', 'a.txt', '--context', ' '])).toMatchObject({ ok: false });
    expect(parseArgs(['brain', 'a.txt', '--context', 'x', '--context-file', 'y'])).toMatchObject({ ok: false });
    expect(parseArgs(['brief', 'a.txt', '--context', 'x'])).toMatchObject({ ok: false, error: '--context / --context-file are for brain and transcribe --brain' });
    expect(parseArgs(['transcribe', 'a.wav', '--no-brain', '--context', 'x'])).toMatchObject({ ok: false, error: '--context needs the Brain; drop --no-brain' });
    expect(parseArgs(['transcribe', 'a.wav', '--server', 'http://h:1', '--context', 'x'])).toMatchObject({ ok: false });
    const tr = parseArgs(['transcribe', 'a.wav', '--brain', '--context-file', 'c.txt']);
    expect(tr.ok && tr.options.contextFile).toBe('c.txt');
  });
  it('help mentions the options in both languages', () => {
    expect(helpText((ru) => ru)).toContain('--context-file <файл>');
    expect(helpText((_ru, en) => en)).toContain('--context <text>');
  });
});

