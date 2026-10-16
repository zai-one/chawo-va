import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clip, countMaterialFiles, findSnippet, hasToken, match, nameIsClose, splitBlocks, withRag, SNIPPET_CHARS } from '../src/sales';
import type { SalesCatalogItem } from '../src/settings';

const item = (Code: string, Name: string, Line = '', SimilarCode = ''): SalesCatalogItem => ({ Code, Name, Line, SimilarCode });
const catalog = [
  item('TP-100', 'таптайн про', 'Флагман, 12 900 ₽, в наличии', 'TP-90'),
  item('TP-10', 'таптайн мини', 'Компактный, 4 900 ₽'),
  item('CH5', 'Чаво станция', ' Голосовая станция, под заказ '),
];

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-sales-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SalesCatalog.match', () => {
  it('a code as its own word is an exact hit; the longest code wins', () => {
    const hit = match('Клиент спрашивает про tp-100, есть ли скидка', catalog);
    expect(hit).toEqual({ kind: 'Exact', name: 'таптайн про', line: 'Флагман, 12 900 ₽, в наличии', code: 'TP-100', ragSnippet: '' });
    expect(match('нужен TP-10 и ch5', catalog)?.code).toBe('TP-10');
  });
  it('a code inside a longer word is not a token', () => {
    expect(match('артикул TP-1000', catalog)?.kind).not.toBe('Exact');
    expect(hasToken('артикул TP-1000', 'TP-100')).toBe(false);
    expect(hasToken('артикул «TP-100».', 'tp-100')).toBe(true);
  });
  it('a similar code gives a «похоже» hit on that row', () => {
    expect(match('у них стоял TP-90', catalog)).toMatchObject({ kind: 'Similar', code: 'TP-100', name: 'таптайн про' });
  });
  it('without a code the nearest name by letters, capitals and ё folded', () => {
    expect(match('а сколько стоит таптайн мини', catalog)).toMatchObject({ kind: 'Similar', code: 'TP-10' });
    // Two words glued: «чаво станция» → чавостанция.
    expect(match('нужна чаво станция в офис', catalog)).toMatchObject({ kind: 'Similar', code: 'CH5', line: 'Голосовая станция, под заказ' });
  });
  it('nothing close: null; empty input: null', () => {
    expect(match('добрый день, как погода', catalog)).toBeNull();
    expect(match('   ', catalog)).toBeNull();
    expect(match('TP-100', [])).toBeNull();
  });
  it('a row without a name shows its code', () => {
    expect(match('нужен X5', [item('X5', '', 'строка')])).toMatchObject({ name: 'X5', kind: 'Exact' });
  });
  it('nameIsClose and withRag', () => {
    expect(nameIsClose('про таптайн мини', 'Таптайн мини')).toBe(true);
    expect(nameIsClose('про погоду', 'Таптайн')).toBe(false);
    const h = match('TP-10', catalog)!;
    expect(withRag(h, '  кусок  ').ragSnippet).toBe('кусок');
    expect(withRag(h, '   ').ragSnippet).toBe('');
  });
});

describe('SalesRag.findSnippet', () => {
  it('looksLike: same stem, an ending apart', async () => {
    const { looksLike } = await import('../src/sales');
    expect(looksLike('станция', 'станцию')).toBe(true);
    expect(looksLike('доставка', 'станция')).toBe(false);
    expect(looksLike('кот', 'кот')).toBe(false); // under 4 letters: only an exact substring counts
  });
  it('splitBlocks joins lines, splits on blank lines and long runs; clip cuts on a space', () => {
    expect(splitBlocks('a\r\nb\n\n\nc')).toEqual(['a b', 'c']);
    const long = Array.from({ length: 100 }, () => 'слово').join('\n');
    expect(splitBlocks(long).every((b) => b.length <= SNIPPET_CHARS * 2 + 6)).toBe(true);
    expect(clip('раз два три четыре', 12)).toBe('раз два три…');
    expect(clip('коротко', 20)).toBe('коротко');
    expect(clip('x'.repeat(30), 10)).toBe('x'.repeat(10) + '…');
  });
  it('the paragraph that shares the most letters, clipped to 220 chars, with its file name', () => {
    const f = join(dir, 'mat');
    mkdirSync(join(f, 'sub'), { recursive: true });
    writeFileSync(join(f, 'about.md'), '# О компании\n\nМы продаём кофемашины и чай.\n\nДоставка по городу бесплатно от 5000 рублей.');
    writeFileSync(join(f, 'sub', 'stations.txt'), '\ufeffСтанция Чаво умеет слушать встречи и подсказывать артикулы менеджеру.\nРаботает без облака.');
    writeFileSync(join(f, 'image.png'), 'станция чаво станция чаво');
    const s = findSnippet('а ваша станция чаво работает без интернета', f);
    expect(s).toEqual({ text: 'Станция Чаво умеет слушать встречи и подсказывать артикулы менеджеру. Работает без облака.', source: 'stations.txt' });
    expect(findSnippet('доставка по городу', f)?.source).toBe('about.md');
    expect(findSnippet('ыыы', f)).toBeNull();
    expect(findSnippet('станция', join(dir, 'missing'))).toBeNull();
    expect(findSnippet('', f)).toBeNull();
    // An inflected word still finds its paragraph; a short unrelated paragraph does not win by size.
    expect(findSnippet('покажите станцию', f)?.source).toBe('stations.txt');
    expect(countMaterialFiles(f)).toBe(2);
    expect(countMaterialFiles(join(dir, 'missing'))).toBe(-1);
  });
});
