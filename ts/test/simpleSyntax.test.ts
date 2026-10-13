import { describe, expect, it } from 'vitest';
import { applySimpleSyntax } from '../src/core/simpleSyntax';

describe('SimpleSyntax (SimpleSyntax.Apply)', () => {
  it('one sentence: drops the closing period and lowercases the first capital', () => {
    expect(applySimpleSyntax('Привет, как дела.')).toBe('привет, как дела');
    expect(applySimpleSyntax('  Hello there.  ')).toBe('hello there');
    expect(applySimpleSyntax('Без точки')).toBe('без точки');
  });

  it('keeps a question or an exclamation mark', () => {
    expect(applySimpleSyntax('Ты где?')).toBe('ты где?');
    expect(applySimpleSyntax('Отлично!')).toBe('отлично!');
    expect(applySimpleSyntax('Ну и ну…')).toBe('ну и ну…');
  });

  it('several sentences or an inner sentence end: returned untouched (not even trimmed)', () => {
    expect(applySimpleSyntax('Привет. Как дела.')).toBe('Привет. Как дела.');
    expect(applySimpleSyntax(' Да! Нет ')).toBe(' Да! Нет ');
    expect(applySimpleSyntax('Яблоки, груши и т.д.')).toBe('Яблоки, груши и т.д.');
    expect(applySimpleSyntax('Раз; два')).toBe('Раз; два');
  });

  it('multi-line or empty text: returned untouched', () => {
    expect(applySimpleSyntax('Первая строка\nВторая.')).toBe('Первая строка\nВторая.');
    expect(applySimpleSyntax('   ')).toBe('   ');
    expect(applySimpleSyntax('')).toBe('');
  });

  it('leaves acronyms and all-caps first words alone', () => {
    expect(applySimpleSyntax('NASA запустила ракету.')).toBe('NASA запустила ракету');
    expect(applySimpleSyntax('СДЭК привёз посылку.')).toBe('СДЭК привёз посылку');
    // A single capital letter is not an acronym: "Я" becomes "я".
    expect(applySimpleSyntax('Я дома.')).toBe('я дома');
    // Digits upper-case to themselves, as in .NET: "2024" counts as all caps but has no capital anyway.
    expect(applySimpleSyntax('2024 был хорошим.')).toBe('2024 был хорошим');
  });

  it('an already lowercase phrase only loses its period', () => {
    expect(applySimpleSyntax('ок.')).toBe('ок');
    expect(applySimpleSyntax('.')).toBe('');
  });
});
