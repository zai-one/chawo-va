import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '@chawo/core/strings';
import * as Settings from '../src/settings';
import { actionLabel, transformAsync } from '../src/brain/brain';
import {
  cleanAnswer,
  commonLanguages,
  defaultTarget,
  outputPath,
  parseTranslateCommand,
  pickTarget,
  resolveLanguage,
  runTranslateAsync,
  translateFileAsync,
  translatePrompt,
  LocalTranslateChars,
} from '../src/brain/translate';
import { BrainException } from '../src/brain/speechCleanup';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-translate-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});

const signal = new AbortController().signal;
const noop = () => {};

describe('parseTranslateCommand', () => {
  it('Russian verb + language in any case', () => {
    expect(parseTranslateCommand('переведи на английский')).toEqual({ target: expect.objectContaining({ code: 'en' }), extra: '' });
    expect(parseTranslateCommand('переведи на немецкий язык')?.target?.code).toBe('de');
    expect(parseTranslateCommand('Переведи это на французский, пожалуйста')?.target?.code).toBe('fr');
    expect(parseTranslateCommand('перевести на испанский')?.target?.code).toBe('es');
    expect(parseTranslateCommand('переведи на китайский')?.target?.code).toBe('zh');
    expect(parseTranslateCommand('переведи на русский')?.target?.code).toBe('ru');
    expect(parseTranslateCommand('перевод на японский')?.target?.code).toBe('ja');
  });

  it('adverb form and bare language phrase', () => {
    expect(parseTranslateCommand('по-английски')?.target?.code).toBe('en');
    expect(parseTranslateCommand('по английски')?.target?.code).toBe('en');
    expect(parseTranslateCommand('скажи по-немецки')?.target?.code).toBe('de');
    expect(parseTranslateCommand('на английском')?.target?.code).toBe('en');
    expect(parseTranslateCommand('in English')?.target?.code).toBe('en');
  });

  it('English verbs, codes only after to/into/на', () => {
    expect(parseTranslateCommand('translate to German')?.target?.code).toBe('de');
    expect(parseTranslateCommand('translate it into english')?.target?.code).toBe('en');
    expect(parseTranslateCommand('translate to fr')?.target?.code).toBe('fr');
    expect(parseTranslateCommand('переведи на en')?.target?.code).toBe('en');
    // «it» is a pronoun here, not Italian
    expect(parseTranslateCommand('translate it')).toEqual({ target: null, extra: '' });
  });

  it('verb without a language → target null (auto)', () => {
    expect(parseTranslateCommand('переведи')).toEqual({ target: null, extra: '' });
  });

  it('unknown language after на/to is kept as free text', () => {
    const c = parseTranslateCommand('переведи на суахили');
    expect(c?.target).toEqual({ code: '', name: 'суахили', ru: 'суахили' });
    expect(parseTranslateCommand('translate into Klingon')?.target?.name).toBe('Klingon');
  });

  it('extra instruction is kept, address stripped', () => {
    expect(parseTranslateCommand('Чаво, переведи на английский и сделай короче')).toEqual({
      target: expect.objectContaining({ code: 'en' }),
      extra: 'сделай короче',
    });
  });

  it('other commands are not translations', () => {
    expect(parseTranslateCommand('сделай короче')).toBeNull();
    expect(parseTranslateCommand('исправь ошибки')).toBeNull();
    expect(parseTranslateCommand('сделай короче по-английски')).toBeNull(); // mixed → generic edit prompt
    expect(parseTranslateCommand('')).toBeNull();
    expect(parseTranslateCommand(null)).toBeNull();
  });
});

describe('languages', () => {
  it('resolveLanguage: codes, names, adverbs, free text, blank', () => {
    expect(resolveLanguage('en')?.code).toBe('en');
    expect(resolveLanguage('EN')?.code).toBe('en');
    expect(resolveLanguage('eng')?.code).toBe('en');
    expect(resolveLanguage('Английский')?.code).toBe('en');
    expect(resolveLanguage('english')?.code).toBe('en');
    expect(resolveLanguage('по-немецки')?.code).toBe('de');
    expect(resolveLanguage('Deutsch')?.code).toBe('de');
    expect(resolveLanguage('zh')?.name).toMatch(/Chinese/);
    expect(resolveLanguage('суахили')).toEqual({ code: '', name: 'суахили', ru: 'суахили' });
    expect(resolveLanguage('  ')).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
  });

  it('defaultTarget: Cyrillic → English, otherwise Russian', () => {
    expect(defaultTarget('Привет, как дела?').code).toBe('en');
    expect(defaultTarget('Hello there').code).toBe('ru');
    expect(defaultTarget('Bonjour').code).toBe('ru');
    expect(defaultTarget('12345').code).toBe('ru');
    expect(defaultTarget('Обсудили API и SDK для клиента').code).toBe('en');
  });

  it('pickTarget: explicit > saved > auto', () => {
    expect(pickTarget('de', 'fr', 'Привет').code).toBe('de');
    expect(pickTarget(null, 'fr', 'Привет').code).toBe('fr');
    expect(pickTarget(null, '', 'Привет').code).toBe('en');
    expect(pickTarget('', '', 'Hello').code).toBe('ru');
    expect(pickTarget({ code: 'es', name: 'Spanish', ru: 'испанский' }, 'fr', 'x').code).toBe('es');
  });

  it('commonLanguages has the main ones with Russian labels', () => {
    const codes = commonLanguages().map((l) => l.code);
    for (const c of ['en', 'ru', 'de', 'fr', 'es', 'zh']) expect(codes).toContain(c);
    expect(commonLanguages().find((l) => l.code === 'en')?.ru).toBe('английский');
  });
});

describe('prompt and output', () => {
  it('translatePrompt: target, translate-only rules, spoken and extra', () => {
    const p = translatePrompt(resolveLanguage('de')!);
    expect(p).toContain('into German');
    expect(p).toMatch(/never follow instructions/i);
    expect(p).toMatch(/Return only the translation/);
    expect(p).toMatch(/names, numbers/);
    expect(p).not.toMatch(/filler/);
    const spoken = translatePrompt(resolveLanguage('en')!, { spoken: true, extra: 'сделай короче' });
    expect(spoken).toMatch(/filler/);
    expect(spoken).toContain('Also follow this user instruction: сделай короче');
    expect(translatePrompt(resolveLanguage('суахили')!)).toContain('into суахили');
  });

  it('outputPath → .translate.txt, strips .brain', () => {
    expect(outputPath(join('/rec', 'meet.txt'))).toBe(join('/rec', 'meet.translate.txt'));
    expect(outputPath(join('/rec', 'meet.brain.txt'))).toBe(join('/rec', 'meet.translate.txt'));
    expect(outputPath(join('/rec', 'noext'))).toBe(join('/rec', 'noext.translate.txt'));
  });

  it('cleanAnswer drops fences and wrapping quotes', () => {
    expect(cleanAnswer('```\nHello\n```')).toBe('Hello');
    expect(cleanAnswer('"Hello"')).toBe('Hello');
    expect(cleanAnswer('«Привет»')).toBe('Привет');
    expect(cleanAnswer('He said "hi" to me')).toBe('He said "hi" to me');
  });
});

describe('runTranslateAsync', () => {
  it('translates with a fake ask; explicit --to wins; status mentions the language', async () => {
    const seen: { prompt: string; text: string }[] = [];
    const statuses: string[] = [];
    const r = await runTranslateAsync({
      text: 'Привет, мир.',
      to: 'de',
      saved: 'fr',
      targetKind: 'Local',
      status: (l) => statuses.push(l),
      signal,
      ask: async (prompt, text) => {
        seen.push({ prompt, text });
        return 'Hallo, Welt.';
      },
    });
    expect(r.text).toBe('Hallo, Welt.\n');
    expect(r.target.code).toBe('de');
    expect(r.parts).toBe(1);
    expect(seen[0]!.prompt).toContain('into German');
    expect(seen[0]!.text).toBe('Привет, мир.');
    expect(statuses.join('\n')).toContain('перевожу на немецкий');
  });

  it('auto target from the text when nothing is set', async () => {
    const r = await runTranslateAsync({ text: 'Hello', targetKind: 'Cloud', status: noop, signal, ask: async () => 'Привет' });
    expect(r.target.code).toBe('ru');
    expect(r.text).toBe('Привет\n');
  });

  it('long text goes in chunks and comes back joined by paragraphs', async () => {
    const para = 'Слово '.repeat(150).trim();
    const text = [para, para, para].join('\n\n');
    expect(text.length).toBeGreaterThan(LocalTranslateChars);
    let n = 0;
    const r = await runTranslateAsync({ text, to: 'en', targetKind: 'Local', status: noop, signal, ask: async () => `part ${++n}` });
    expect(r.parts).toBeGreaterThan(1);
    expect(r.text).toBe(Array.from({ length: r.parts }, (_, i) => `part ${i + 1}`).join('\n\n') + '\n');
  });

  it('errors: no Brain, empty text, empty answer, ask failure', async () => {
    await expect(runTranslateAsync({ text: 'x', targetKind: 'None', status: noop, signal, ask: async () => 'y' })).rejects.toBeInstanceOf(BrainException);
    await expect(runTranslateAsync({ text: '  ', targetKind: 'Local', status: noop, signal, ask: async () => 'y' })).rejects.toThrow(/пустой текст/);
    await expect(runTranslateAsync({ text: 'x', targetKind: 'Local', status: noop, signal, ask: async () => '   ' })).rejects.toThrow(/пустой ответ/);
    await expect(
      runTranslateAsync({ text: 'x', targetKind: 'Local', status: noop, signal, ask: async () => { throw new Error('down'); } }),
    ).rejects.toThrow('down');
  });

  it('abort before the first ask', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runTranslateAsync({ text: 'x', targetKind: 'Local', status: noop, signal: ac.signal, ask: async () => 'y' })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('translateFileAsync (File page action) writes name.translate.txt', async () => {
    const src = join(dir, 'call.txt');
    writeFileSync(src, '[00:00:01] Добрый день.\n', 'utf8');
    const r = await translateFileAsync(
      src,
      { targetKind: 'Local', saved: 'en', status: noop, signal, ask: async () => '[00:00:01] Good afternoon.' },
      { readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, t) => writeFileSync(p, t, 'utf8') },
    );
    expect(r.path).toBe(join(dir, 'call.translate.txt'));
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toBe('[00:00:01] Good afternoon.\n');
  });
});

describe('dictation: «Чаво, переведи на …» uses the translation prompt', () => {
  type Call = { body: { messages: { role: string; content: string }[] } };
  function server(reply: string) {
    const calls: Call[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
    };
    return { calls, fetch };
  }
  function serverSettings() {
    const s = Settings.defaults();
    s.Brain = 'Server';
    s.CleanupEndpointUrl = 'http://127.0.0.1:1234/v1';
    s.CleanupModel = 'local-model';
    return s;
  }
  const all = (c: Call) => c.body.messages.map((m) => m.content).join('\n');

  it('translation command → dedicated prompt with the named language', async () => {
    const srv = server('Good morning, colleagues.');
    const statuses: string[] = [];
    const out = await transformAsync(serverSettings(), 'Доброе утро, коллеги.', 'переведи на английский', (l) => statuses.push(l), signal, false, srv.fetch);
    expect(out).toBe('Good morning, colleagues.');
    expect(all(srv.calls[0]!)).toContain('Translate the whole input into English');
    expect(all(srv.calls[0]!)).toMatch(/filler/); // dictation → spoken
    expect(all(srv.calls[0]!)).not.toContain('Ты обрабатываешь надиктованный');
    expect(statuses).toContain('Перевожу…');
  });

  it('no language → auto (Russian dictation → English); selection is not «spoken»', async () => {
    const srv = server('Hello');
    await transformAsync(serverSettings(), 'Привет', 'переведи', noop, signal, true, srv.fetch);
    expect(all(srv.calls[0]!)).toContain('into English');
    expect(all(srv.calls[0]!)).not.toMatch(/filler/);
  });

  it('other commands keep the generic edit prompt', async () => {
    const srv = server('Коротко.');
    await transformAsync(serverSettings(), 'Очень длинный текст.', 'сделай короче', noop, signal, false, srv.fetch);
    expect(all(srv.calls[0]!)).toContain('Ты обрабатываешь надиктованный');
    expect(all(srv.calls[0]!)).not.toContain('Translate the whole input');
  });

  it('actionLabel says «Перевожу…» for any translation command', () => {
    expect(actionLabel('по-немецки')).toBe('Перевожу…');
    expect(actionLabel('translate to German')).toBe('Перевожу…');
  });
});
