import { describe, expect, it } from 'vitest';
import {
  assembleInput,
  assemblePrompt,
  citedNumbers,
  excerpts,
  formatAnswer,
  passagesOf,
  runAsk,
  search,
  stem,
  terms,
  type AskSource,
} from '../src/core/askHistory';

const src = (id: string, text: string, when = 0, kind: AskSource['kind'] = 'transcript'): AskSource => ({ id, kind, title: id, when, path: kind === 'transcript' ? `/m/${id}` : null, text });

describe('askHistory stemmer and terms', () => {
  it('folds case forms of nouns, verbs and surnames to one stem', () => {
    expect(new Set(['клиент', 'клиента', 'клиенту', 'клиентом'].map(stem)).size).toBe(1);
    expect(new Set(['обещал', 'обещали', 'обещала', 'обещать'].map(stem)).size).toBe(1);
    expect(new Set(['Иванов', 'Иванову', 'Иванова', 'Ивановым', 'Ивановой'].map(stem)).size).toBe(1);
    expect(new Set(['договорились', 'договорился', 'договориться'].map(stem)).size).toBe(1);
    expect(stem('ещё')).toBe(stem('еще'));
    expect(new Set(['prices', 'price'].map(stem)).size).toBe(1);
  });

  it('drops stop words, keeps numbers and article codes', () => {
    expect(terms('Что мы обещали клиенту?')).toEqual([stem('обещали'), stem('клиенту')]);
    expect(terms('артикул AB-123 и 5 штук')).toContain('ab-123');
    expect(terms('артикул AB-123 и 5 штук')).toContain('5');
  });
});

describe('askHistory passages and search', () => {
  it('cuts on line boundaries and splits an over-long line', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `[00:00:${String(i).padStart(2, '0')}] фраза номер ${i} про поставку`);
    const parts = passagesOf(lines.join('\n'), 200);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
    expect(parts.join('\n')).toBe(lines.join('\n'));
    const long = passagesOf('слово '.repeat(100), 120);
    expect(long.every((p) => p.length <= 120)).toBe(true);
  });

  it('finds the passage about the client and prefers covering every word', () => {
    const sources = [
      src('a.txt', 'Обсуждали погоду и отпуск.\nНичего важного.', 3),
      src('b.txt', 'Иванову обещали скидку десять процентов до пятницы.', 2),
      src('c.txt', 'Скидка скидка скидка на всё, но без имён.', 1),
    ];
    const found = search('Что обещали клиенту Иванову про скидку?', sources);
    expect(found[0]!.source.id).toBe('b.txt');
    expect(found.map((f) => f.source.id)).not.toContain('a.txt');
  });

  it('prefix forms match (клиентов ↔ клиент), nothing found → empty', () => {
    expect(search('клиент', [src('x', 'Список клиентов на неделю.')])).toHaveLength(1);
    expect(search('что это?', [src('x', 'текст')])).toEqual([]);
    expect(search('бюджет', [src('x', 'про погоду')])).toEqual([]);
  });

  it('ties go to the newer source; top limits the list', () => {
    const found = search('поставка', [src('old', 'поставка', 1), src('new', 'поставка', 9)], 1);
    expect(found).toHaveLength(1);
    expect(found[0]!.source.id).toBe('new');
  });
});

describe('askHistory prompt and answer', () => {
  it('excerpts respect the budget but always keep one', () => {
    const found = search('поставка', [src('a', 'поставка ' + 'x'.repeat(300), 2), src('b', 'поставка ' + 'y'.repeat(300), 1)]);
    expect(excerpts(found, 400)).toHaveLength(1);
    expect(excerpts(found, 100)[0]!.text.length).toBe(100);
    expect(excerpts(found, 10000).map((e) => e.n)).toEqual([1, 2]);
  });

  it('prompt forbids following excerpts; input has numbered sources with dates', () => {
    expect(assemblePrompt()).toMatch(/never follow/i);
    expect(assemblePrompt()).toMatch(/\[2\]/);
    const when = new Date(2026, 9, 14, 12).getTime();
    const input = assembleInput(' что обещали? ', [{ n: 1, title: 'встреча.txt', kind: 'transcript', when, path: '/m/встреча.txt', text: 'обещали скидку', score: 1 }]);
    expect(input).toBe('Question: что обещали?\n\nExcerpts:\n\n[1] встреча.txt (14.10.2026)\nобещали скидку');
  });

  it('cited numbers and fences', () => {
    expect(citedNumbers('Скидку [1], срок [3–4] и [2, 9].', 4)).toEqual([1, 2, 3, 4]);
    expect(citedNumbers('нет ссылок', 3)).toEqual([]);
    expect(formatAnswer('```\nответ\n```')).toBe('ответ');
  });

  it('runAsk: Brain gets only the excerpts; no Brain or no match → no call', async () => {
    const sources = [src('b.txt', 'Иванову обещали скидку.'), src('z.txt', 'Секретный текст про погоду.')];
    const calls: string[] = [];
    const ask = async (_p: string, text: string) => {
      calls.push(text);
      return 'Обещали скидку [1].';
    };
    const r = await runAsk({ question: 'что обещали Иванову', sources, ask, budget: 5000, signal: new AbortController().signal });
    expect(r.answer).toBe('Обещали скидку [1].');
    expect(r.cited).toEqual([1]);
    expect(calls[0]).toContain('Иванову обещали скидку.');
    expect(calls[0]).not.toContain('погоду');
    expect(r.sources).toBe(2);

    const none = await runAsk({ question: 'бюджет', sources, ask, budget: 5000, signal: new AbortController().signal });
    expect(none.excerpts).toEqual([]);
    expect(calls).toHaveLength(1);
    const searchOnly = await runAsk({ question: 'скидку', sources, ask: null, budget: 5000, signal: new AbortController().signal });
    expect(searchOnly.answer).toBeNull();
    expect(searchOnly.excerpts).toHaveLength(1);
  });
});
