import { describe, expect, it } from 'vitest';
import { assignSpeakers, hasSpeakerLabels, overlapSeconds, speakerPrefix } from '../src/diarize';
import { toSrt, toTxt } from '../src/transcriptFormat';

describe('diarize.assignSpeakers', () => {
  it('picks max overlap and remaps by first appearance', () => {
    const transcript = [
      { start: 0, end: 2, text: 'привет' },
      { start: 2, end: 4, text: 'алло' },
      { start: 4, end: 6, text: 'да' },
    ];
    // Raw ids 7 then 3 then 7 again → remapped 0, 1, 0
    const spans = [
      { start: 0, end: 2.5, speaker: 7 },
      { start: 2.2, end: 4.5, speaker: 3 },
      { start: 4, end: 7, speaker: 7 },
    ];
    const out = assignSpeakers(transcript, spans);
    expect(out.map((s) => s.speaker)).toEqual([0, 1, 0]);
    expect(out[0].text).toBe('привет');
  });

  it('leaves speaker unset when there is no overlap', () => {
    const out = assignSpeakers(
      [{ start: 0, end: 1, text: 'x' }],
      [{ start: 5, end: 6, speaker: 0 }],
    );
    expect(out[0].speaker).toBeUndefined();
    expect(hasSpeakerLabels(out)).toBe(false);
  });

  it('computes overlap', () => {
    expect(overlapSeconds(0, 2, 1, 3)).toBe(1);
    expect(overlapSeconds(0, 1, 2, 3)).toBe(0);
  });

  it('formats Russian speaker prefixes 1-based', () => {
    expect(speakerPrefix(0)).toBe('Спикер 1: ');
    expect(speakerPrefix(2)).toBe('Спикер 3: ');
    expect(speakerPrefix(undefined)).toBe('');
  });
});

describe('transcriptFormat speaker labels', () => {
  const segs = [
    { start: 0, end: 1, text: 'раз', speaker: 0 },
    { start: 1, end: 2, text: 'два', speaker: 1 },
  ];

  it('prefixes Спикер N in txt when any segment has speaker', () => {
    expect(toTxt(segs, false)).toBe('Спикер 1: раз\nСпикер 2: два');
    expect(toTxt(segs, true)).toBe('[00:00:00] Спикер 1: раз\n[00:00:01] Спикер 2: два');
  });

  it('prefixes Спикер N in srt', () => {
    const srt = toSrt(segs);
    expect(srt).toContain('Спикер 1: раз');
    expect(srt).toContain('Спикер 2: два');
  });

  it('does not prefix when no speakers', () => {
    expect(toTxt([{ start: 0, end: 1, text: 'раз' }], false)).toBe('раз');
  });
});
