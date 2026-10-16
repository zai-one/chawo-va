import { describe, expect, it } from 'vitest';
import { editTranscriptPhrase, siblingTranscripts } from '../src/transcriptEdit';

function fs(files: Record<string, string>) {
  const written: Record<string, string> = {};
  return {
    read: (p: string) => (p in written ? written[p]! : files[p] ?? null),
    write: (p: string, d: string) => void (written[p] = d),
    written,
  };
}

describe('editTranscriptPhrase', () => {
  it('replaces the phrase once in every sibling that has it exactly once', () => {
    const f = fs({
      '/m.txt': '[00:00:01] Спикер 1: звонок в таптейн\n[00:00:02] ещё\n',
      '/m.srt': '1\n00:00:01,000 --> 00:00:02,000\nСпикер 1: звонок в таптейн\n',
      '/m.json': JSON.stringify({ segments: [{ text: 'звонок в таптейн "x"' }] }),
      '/m.md': 'звонок в таптейн и звонок в таптейн',
    });
    const changed = editTranscriptPhrase('/m.txt', 'звонок в таптейн', 'звонок в  Taptain', f.read, f.write);
    expect(changed).toEqual(['/m.txt', '/m.srt', '/m.json']);
    expect(f.written['/m.txt']).toContain('звонок в Taptain');
    expect(JSON.parse(f.written['/m.json']!).segments[0].text).toBe('звонок в Taptain "x"');
    expect(f.written['/m.md']).toBeUndefined(); // twice → ambiguous, left alone
  });
  it('nothing for empty, unchanged or missing text; $ in the new text is literal', () => {
    const f = fs({ '/a.txt': 'цена 5' });
    expect(editTranscriptPhrase('/a.txt', 'цена 5', 'цена 5', f.read, f.write)).toEqual([]);
    expect(editTranscriptPhrase('/a.txt', 'нет', 'да', f.read, f.write)).toEqual([]);
    expect(editTranscriptPhrase('/a.txt', 'цена 5', '', f.read, f.write)).toEqual([]);
    expect(editTranscriptPhrase('/a.txt', 'цена 5', 'цена $& 5', f.read, f.write)).toEqual(['/a.txt']);
    expect(f.written['/a.txt']).toBe('цена $& 5');
    expect(siblingTranscripts('/x/a.TXT')).toContain('/x/a.srt');
  });
});
