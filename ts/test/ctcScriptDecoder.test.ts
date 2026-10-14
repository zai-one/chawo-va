import { describe, expect, it } from 'vitest';
import { chooseScript, classify } from '../src/core/ctcScriptDecoder';

describe('ctcScriptDecoder', () => {
  it('classifies tokens', () => {
    expect(classify('a')).toBe('latin');
    expect(classify('ж')).toBe('cyrillic');
    expect(classify('▁')).toBe('neutral');
    expect(classify('<blk>')).toBe('neutral');
  });

  it('forces a script when asked and picks a close Latin path in auto', () => {
    const paths = {
      free: { text: 'зум', sum: -10, frames: 10 },
      latin: { text: 'zoom', sum: -15, frames: 10 },
      cyr: { text: 'зум', sum: -10, frames: 10 },
    };
    const greedy = (lat: boolean, cyr: boolean) => (lat && cyr ? paths.free : lat ? paths.latin : paths.cyr);
    expect(chooseScript('english', greedy)).toBe('zoom');
    expect(chooseScript('russian', greedy)).toBe('зум');
    expect(chooseScript('auto', greedy)).toBe('zoom'); // gap 0.5 <= 0.75
    paths.latin.sum = -20;
    expect(chooseScript('auto', greedy)).toBe('зум'); // gap 1.0
  });
});
