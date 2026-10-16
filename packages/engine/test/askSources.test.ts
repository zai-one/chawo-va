import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dictationSources, documentsFolder, isTranscriptFile, loadSources, meetingFolders, parseFolders, transcriptFiles } from '../src/history/askSources';
import type { HistoryEntry } from '../src/history/historyStore';

const tr = (ru: string) => ru;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'chawo-ask-'));
  dirs.push(d);
  return d;
};

const entry = (ts: number, final: string): HistoryEntry => ({ id: String(ts), ts, raw: final, final, command: null, brain: false, brainFailed: false, seconds: 1 });

describe('askSources', () => {
  it('groups dictation phrases by day with times', () => {
    const a = new Date(2026, 9, 13, 9, 5).getTime();
    const b = new Date(2026, 9, 13, 18, 30).getTime();
    const c = new Date(2026, 9, 14, 8, 0).getTime();
    const list = dictationSources([entry(c, 'третья'), entry(a, 'первая\nстрока'), entry(b, 'вторая'), entry(b + 1, '  ')], tr);
    expect(list.map((s) => s.title)).toEqual(['Диктовка 13.10', 'Диктовка 14.10']);
    expect(list[0].text).toBe('[09:05] первая строка\n[18:30] вторая');
    expect(list[0].kind).toBe('dictation');
    expect(list[0].path).toBeNull();
  });

  it('parseFolders: unique, trimmed, non-empty', () => {
    expect(parseFolders(' /a \n\n/b\r\n/a\n')).toEqual(['/a', '/b']);
    expect(parseFolders('')).toEqual([]);
  });

  it('transcript files: .txt/.md, no translations, no .brain.txt beside its source, newest first', () => {
    const d = tmp();
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'call.txt'), 'расшифровка');
    writeFileSync(join(d, 'call.brain.txt'), 'дубль');
    writeFileSync(join(d, 'call.translate.txt'), 'translation');
    writeFileSync(join(d, 'only.brain.txt'), 'одна');
    writeFileSync(join(d, 'audio.wav'), 'RIFF');
    writeFileSync(join(d, 'empty.txt'), '');
    writeFileSync(join(d, 'sub', 'notes.md'), 'заметки');
    utimesSync(join(d, 'sub', 'notes.md'), new Date(2020, 1, 1), new Date(2020, 1, 1));
    const files = transcriptFiles([d, join(d, 'call.txt'), '/nope']);
    expect(files.map((f) => f.slice(resolve(d).length + 1)).sort()).toEqual(['call.txt', 'only.brain.txt', join('sub', 'notes.md')].sort());
    expect(files.at(-1)).toContain('notes.md');
    expect(isTranscriptFile('/x/a.srt', new Set())).toBe(false);
  });

  it('loadSources mixes dictation and transcripts; meeting folders in both languages', () => {
    const d = tmp();
    mkdirSync(join(d, 'Chawo VA', 'Meetings'), { recursive: true });
    writeFileSync(join(d, 'Chawo VA', 'Meetings', 'm.txt'), 'встреча');
    expect(meetingFolders(d)).toEqual([join(d, 'Chawo VA', 'Meetings')]);
    expect(meetingFolders(d, '/override')).toEqual(['/override']);
    const all = loadSources({ history: [entry(Date.now(), 'фраза')], inputs: meetingFolders(d) }, tr);
    expect(all.map((s) => s.kind)).toEqual(['dictation', 'transcript']);
    expect(all[1].title).toBe('m.txt');
  });

  it('documentsFolder honours XDG_DOCUMENTS_DIR on Linux', () => {
    expect(documentsFolder('linux', '/home/u', 'XDG_DOCUMENTS_DIR="$HOME/Документы"\n')).toBe('/home/u/Документы');
    expect(documentsFolder('linux', '/home/u', 'XDG_DOCUMENTS_DIR="$HOME/"\n')).toBe(join('/home/u', 'Documents'));
    expect(documentsFolder('win32', 'C:\\Users\\u', null)).toBe(join('C:\\Users\\u', 'Documents'));
  });
});
