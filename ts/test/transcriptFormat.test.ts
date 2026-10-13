import { describe, expect, it } from 'vitest';
import { clock, fromRanges, srtTime, toSrt, toTxt } from '../src/core/transcriptFormat';

describe('transcriptFormat', () => {
  it('formats clocks like the WPF app', () => {
    expect(clock(0)).toBe('00:00:00');
    expect(clock(3725.9)).toBe('01:02:05');
    expect(clock(-3)).toBe('00:00:00');
    expect(clock(NaN)).toBe('00:00:00');
    expect(srtTime(1.2345)).toBe('00:00:01,235');
    expect(srtTime(3600.5)).toBe('01:00:00,500');
  });

  it('writes txt with and without timestamps, skipping empty pieces', () => {
    const segs = [
      { start: 0, end: 2, text: ' Привет ' },
      { start: 2, end: 3, text: '  ' },
      { start: 65, end: 70, text: 'мир' },
    ];
    expect(toTxt(segs, false)).toBe('Привет\nмир');
    expect(toTxt(segs, true)).toBe('[00:00:00] Привет\n[00:01:05] мир');
  });

  it('writes SubRip with continuous numbering and a 0.5 s minimum length', () => {
    const srt = toSrt([
      { start: 0, end: 0.1, text: 'a\nb' },
      { start: 1, end: 1, text: '' },
      { start: 2, end: 4, text: 'c' },
    ]);
    expect(srt).toBe('1\r\n00:00:00,000 --> 00:00:00,500\r\na b\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\nc\r\n\r\n');
  });

  it('builds segments from sample ranges', () => {
    expect(fromRanges([[0, 16000], [16000, 40000]], ['x', 'y', 'z'], 16000)).toEqual([
      { start: 0, end: 1, text: 'x' },
      { start: 1, end: 2.5, text: 'y' },
    ]);
  });
});
