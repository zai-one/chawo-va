import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_SUGGESTIONS,
  extractCyrillic,
  extractLatinBrands,
  fold,
  materialPaths,
  nearEnough,
  sharedLetters,
  suggestDictionary,
  translitHint,
} from '../src/main/sales';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-rag-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SalesRag helpers', () => {
  it('latin brands: CamelCase, ALLCAPS, SKU-ish; plain words and numbers are skipped', () => {
    expect(extractLatinBrands('таптайн Taptain, GPU и rtx3070, hello 12345 Ab')).toEqual(['Taptain', 'GPU', 'rtx3070']);
  });
  it('cyrillic words are lower-cased, ё → е, unique, min 3 letters', () => {
    expect(extractCyrillic('Ёлка ёлка и Таптайн — да')).toEqual(['елка', 'таптайн']);
  });
  it('translit and fold', () => {
    expect(translitHint('Taptain')).toBe('таптаин');
    expect(translitHint('Chawo')).toBe('чаво');
    expect(fold('  Привет,  Ёж!  ')).toBe('привет еж');
    expect(sharedLetters('таптайн', 'таптаин')).toBe(6);
  });
  it('nearEnough keeps look-alike pairs', () => {
    expect(nearEnough('таптайн', 'Taptain')).toBe(true);
    expect(nearEnough('чаво', 'Chawo')).toBe(true);
    expect(nearEnough('молоко', 'XYZ')).toBe(false);
  });
});

describe('SalesRag.suggestDictionary', () => {
  it('like WPF, the first same-line Russian word that passes the loose check wins', () => {
    const f = join(dir, 'first');
    mkdirSync(f);
    writeFileSync(join(f, 'a.txt'), 'Наш бренд таптайн Taptain\n');
    expect(suggestDictionary(f, [])).toEqual([{ heard: 'наш', written: 'Taptain', source: 'a.txt' }]);
  });

  it('missing or empty folder gives nothing', () => {
    expect(suggestDictionary('', [])).toEqual([]);
    expect(suggestDictionary(join(dir, 'nope'), [])).toEqual([]);
  });

  it('suggests Russian neighbor → Latin brand from .txt/.md, skips taken and other files', () => {
    const f = join(dir, 'a');
    mkdirSync(join(f, 'sub'), { recursive: true });
    writeFileSync(join(f, 'brands.txt'), '\uFEFFтаптайн Taptain для звонков\r\nчаво Chawo помощник\n');
    writeFileSync(join(f, 'sub', 'more.md'), '# Цены\nкарта видео гипер HyperX\n');
    writeFileSync(join(f, 'skip.pdf'), 'таптайн Taptain');
    writeFileSync(join(f, 'empty.txt'), '');
    const got = suggestDictionary(f, []);
    expect(got).toContainEqual({ heard: 'таптайн', written: 'Taptain', source: 'brands.txt' });
    expect(got).toContainEqual({ heard: 'чаво', written: 'Chawo', source: 'brands.txt' });
    expect(got.some((g) => g.written === 'HyperX' && g.source === 'more.md')).toBe(true);
    expect(got.every((g) => g.source !== 'skip.pdf')).toBe(true);

    const again = suggestDictionary(f, [{ from: 'чаво', to: 'Chawo' }, { from: 'x', to: 'TAPTAIN' }]);
    expect(again.some((g) => g.written === 'Chawo')).toBe(false);
    expect(again.some((g) => g.written === 'Taptain')).toBe(false);
  });

  it('skips files over 512000 bytes and caps the list at 40', () => {
    const f = join(dir, 'big');
    mkdirSync(f);
    writeFileSync(join(f, 'huge.txt'), 'таптайн Taptain\n' + 'x'.repeat(520_000));
    expect(suggestDictionary(f, [])).toEqual([]);
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(`бренд${'абвгдежзик'[i % 10]}${'лмнопрстуф'[Math.floor(i / 10)]} Brend${i}`);
    writeFileSync(join(f, 'many.txt'), lines.join('\n'));
    expect(suggestDictionary(f, []).length).toBe(MAX_SUGGESTIONS);
  });

  it('materialPaths stops at the file cap', () => {
    const f = join(dir, 'cap');
    mkdirSync(f);
    for (let i = 0; i < 5; i++) writeFileSync(join(f, `${i}.txt`), 'x');
    expect(materialPaths(f, 3)).toHaveLength(3);
  });
});
