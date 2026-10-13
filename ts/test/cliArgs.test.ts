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
});
