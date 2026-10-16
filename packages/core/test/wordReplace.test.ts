import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, applyRules, formatRules, parseRules } from '../src/wordReplace';

describe('wordReplace', () => {
  it('parses ->, => and = separators and skips comments', () => {
    expect(parseRules('# c\nа -> b\nв => g\nд = e\nbad line\n')).toEqual([
      { from: 'а', to: 'b' },
      { from: 'в', to: 'g' },
      { from: 'д', to: 'e' },
    ]);
    expect(parseRules('#')).toEqual([]);
  });

  it('replaces whole words, ignoring case', () => {
    expect(applyRules('Цпу и гпу, а не цпушка', DEFAULT_RULES)).toBe('CPU и GPU, а не цпушка');
    expect(applyRules('проект Таптейн и чаво-бот', DEFAULT_RULES)).toBe('проект Taptain и чаво-бот');
  });

  it('prefers longer matches first', () => {
    expect(applyRules('нью йорк', 'нью -> new\nнью йорк -> New York')).toBe('New York');
  });

  it('round-trips through format', () => {
    expect(formatRules(parseRules(DEFAULT_RULES))).toBe(DEFAULT_RULES);
  });
});
