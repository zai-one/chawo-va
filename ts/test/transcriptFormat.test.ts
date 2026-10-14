import { describe, expect, it } from 'vitest';
import { clock, fromJsonTranscript, fromRanges, fromSrt, fromTxt, loadTimedTranscript, splitSpeakerPrefix, srtTime, toJson, toSrt, toTxt } from '../src/core/transcriptFormat';

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

describe('fromTxt (a finished .txt read back)', () => {
  it('round-trips toTxt with timestamps: starts back, ends = next start', () => {
    const segs = [
      { start: 0, end: 2, text: 'Привет.' },
      { start: 61.7, end: 64, text: 'Как дела?' },
      { start: 3725, end: 3730, text: 'Пока.' },
    ];
    const back = fromTxt(toTxt(segs, true));
    expect(back.timestamps).toBe(true);
    expect(back.segments).toEqual([
      { start: 0, end: 61, text: 'Привет.' },
      { start: 61, end: 3725, text: 'Как дела?' },
      { start: 3725, end: 3725, text: 'Пока.' },
    ]);
    expect(toTxt(back.segments, true)).toBe(toTxt(segs, true));
  });

  it('plain lines: no timestamps, start 0; BOM, CRLF, blank and stamp-only lines are skipped', () => {
    expect(fromTxt('\uFEFFПервая.\r\n\r\n  Вторая.  \n[00:00:09]\n')).toEqual({
      timestamps: true,
      segments: [
        { start: 0, end: 0, text: 'Первая.' },
        { start: 0, end: 0, text: 'Вторая.' },
      ],
    });
    expect(fromTxt('Один.\nДва.').timestamps).toBe(false);
    expect(fromTxt('').segments).toEqual([]);
  });

  it('a line without a stamp keeps the previous start; speaker labels stay in the text; bad stamps are text', () => {
    const r = fromTxt('[00:00:05] Спикер 1: Да.\nещё строка\n[00:99:00] не время');
    expect(r.segments).toEqual([
      { start: 5, end: 5, text: 'Спикер 1: Да.' },
      { start: 5, end: 5, text: 'ещё строка' },
      { start: 5, end: 5, text: '[00:99:00] не время' },
    ]);
  });
});


describe('fromSrt', () => {
  it('round-trips toSrt (times, text, continuous cues)', () => {
    const segs = [
      { start: 0, end: 1.5, text: 'Привет' },
      { start: 2, end: 4, text: 'мир' },
    ];
    expect(fromSrt(toSrt(segs))).toEqual([
      { start: 0, end: 1.5, text: 'Привет' },
      { start: 2, end: 4, text: 'мир' },
    ]);
  });

  it('parses multi-line cues, Speaker/Спикер prefixes, comma or dot millis, BOM and CRLF', () => {
    const srt = '\uFEFF1\r\n00:00:00,000 --> 00:00:01,250\r\nСпикер 1: Hello\r\nworld\r\n\r\n2\r\n00:00:02.500 --> 00:00:03.000\r\nSpeaker 2: Bye\r\n\r\n';
    expect(fromSrt(srt)).toEqual([
      { start: 0, end: 1.25, text: 'Hello world', speaker: 0 },
      { start: 2.5, end: 3, text: 'Bye', speaker: 1 },
    ]);
  });

  it('skips empty cues and blocks without a time arrow; allows missing index line', () => {
    expect(fromSrt('00:00:01,000 --> 00:00:02,000\nТолько текст\n\n3\nnot a time\nskip\n\n')).toEqual([
      { start: 1, end: 2, text: 'Только текст' },
    ]);
    expect(fromSrt('')).toEqual([]);
    expect(fromSrt('1\n00:00:00,000 --> 00:00:00,500\n\n')).toEqual([]);
  });
});

describe('splitSpeakerPrefix / fromJsonTranscript', () => {
  it('splits speaker labels', () => {
    expect(splitSpeakerPrefix('Спикер 3: да')).toEqual({ text: 'да', speaker: 2 });
    expect(splitSpeakerPrefix('Speaker 1: hi')).toEqual({ text: 'hi', speaker: 0 });
    expect(splitSpeakerPrefix('просто текст')).toEqual({ text: 'просто текст' });
  });

  it('round-trips toJson (1-based speaker → 0-based)', () => {
    const segs = [
      { start: 0, end: 1.234, text: 'a', speaker: 0 },
      { start: 2, end: 3, text: 'b', speaker: 1 },
    ];
    const back = fromJsonTranscript(toJson(segs, { source: 'talk.wav', duration: 3 }));
    expect(back.source).toBe('talk.wav');
    expect(back.duration).toBe(3);
    expect(back.segments).toEqual([
      { start: 0, end: 1.234, text: 'a', speaker: 0 },
      { start: 2, end: 3, text: 'b', speaker: 1 },
    ]);
  });

  it('accepts a bare segments object; rejects bad JSON', () => {
    expect(fromJsonTranscript('{"segments":[{"start":1,"end":2,"text":"x"}]}').segments).toEqual([
      { start: 1, end: 2, text: 'x' },
    ]);
    expect(() => fromJsonTranscript('not json')).toThrow(/JSON/i);
    expect(() => fromJsonTranscript('{"format":"x"}')).toThrow(/segments/);
  });
});

describe('loadTimedTranscript (preference)', () => {
  const srt = toSrt([{ start: 0, end: 1, text: 'из srt' }]);
  const json = toJson([{ start: 0, end: 1, text: 'из json' }], { source: 'a.wav', duration: 1 });
  const txt = '[00:00:00] из txt\n';

  it('prefers .srt over .json over timed .txt', () => {
    const files: Record<string, string> = {
      '/a.txt': txt,
      '/a.srt': srt,
      '/a.json': json,
    };
    const read = (p: string) => (p in files ? files[p]! : null);
    expect(loadTimedTranscript('/a.txt', read)).toEqual({
      available: true,
      sourceHint: 'srt',
      segments: [{ start: 0, end: 1, text: 'из srt' }],
    });
    delete files['/a.srt'];
    expect(loadTimedTranscript('/a.txt', read).sourceHint).toBe('json');
    delete files['/a.json'];
    expect(loadTimedTranscript('/a.txt', read)).toMatchObject({ available: true, sourceHint: 'txt' });
  });

  it('reads a path that is already .srt or .json; reports no-timings / missing', () => {
    expect(loadTimedTranscript('/x.srt', (p) => (p === '/x.srt' ? srt : null)).available).toBe(true);
    expect(loadTimedTranscript('/x.json', (p) => (p === '/x.json' ? json : null)).sourceHint).toBe('json');
    expect(loadTimedTranscript('/plain.txt', (p) => (p === '/plain.txt' ? 'без меток\n' : null))).toEqual({
      available: false,
      segments: [],
      sourceHint: 'txt',
      reason: 'no-timings',
    });
    expect(loadTimedTranscript('/gone.txt', () => null).reason).toBe('missing');
  });
});
