import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mdEscape,
  needsTimings,
  toJson,
  toMarkdown,
  toVtt,
  vttTime,
} from '@chawo/core/transcriptFormat';
import { documentXml, xmlText } from '@chawo/core/transcriptDocx';
import { docxBytes, siblingPath, writeExtras } from '../src/file/transcriptExport';
import { listZip, readEntry } from '../src/file/zip';
import { asExtraFormats, defaults, fromJsonObject, toJsonObject } from '../src/settings';
import { FileQueue } from '../src/file/fileQueue';
import { FileRunner } from '../src/file/fileRunner';

const segs = [
  { start: 0, end: 0.2, text: ' Привет, <мир> & «всё» ' },
  { start: 3, end: 3, text: '   ' },
  { start: 3725.25, end: 3730.5, text: 'вторая\nстрока' },
];

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-export-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
});

describe('WebVTT', () => {
  it('uses a dot before milliseconds and always shows hours', () => {
    expect(vttTime(1.2345)).toBe('00:00:01.235');
    expect(vttTime(3600.5)).toBe('01:00:00.500');
    expect(vttTime(-1)).toBe('00:00:00.000');
  });

  it('writes header and cues, escapes markup, skips empty pieces, 0.5 s minimum', () => {
    expect(toVtt(segs)).toBe(
      'WEBVTT\n\n' +
        '1\n00:00:00.000 --> 00:00:00.500\nПривет, &lt;мир&gt; &amp; «всё»\n\n' +
        '2\n01:02:05.250 --> 01:02:10.500\nвторая строка\n\n',
    );
    expect(toVtt([])).toBe('WEBVTT\n\n');
  });
});

describe('JSON', () => {
  it('keeps segments with ms times, the joined text and the source', () => {
    const doc = JSON.parse(toJson(segs, { source: 'talk.mp3', duration: 3731.23456 }));
    expect(doc).toEqual({
      format: 'chawo-transcript',
      version: 1,
      source: 'talk.mp3',
      duration: 3731.235,
      text: 'Привет, <мир> & «всё»\nвторая\nстрока',
      segments: [
        { start: 0, end: 0.2, text: 'Привет, <мир> & «всё»' },
        { start: 3725.25, end: 3730.5, text: 'вторая\nстрока' },
      ],
    });
  });
});

describe('Markdown', () => {
  it('heading from the file name, paragraphs, optional bold time marks', () => {
    expect(toMarkdown(segs, true, 'встреча_1')).toBe(
      '# встреча\\_1\n\n**[00:00:00]** Привет, \\<мир\\> & «всё»\n\n**[01:02:05]** вторая строка\n',
    );
    expect(toMarkdown(segs, false, '')).toBe('# Transcript\n\nПривет, \\<мир\\> & «всё»\n\nвторая строка\n');
  });

  it('escapes formatting and list/heading markers at the start', () => {
    expect(mdEscape('# нет')).toBe('\\# нет');
    expect(mdEscape('- пункт')).toBe('\\- пункт');
    expect(mdEscape('1. раз')).toBe('1\\. раз');
    expect(mdEscape('a*b*_c_ [x](y) `z` |')).toBe('a\\*b\\*\\_c\\_ \\[x\\](y) \\`z\\` \\|');
    expect(mdEscape('минус - в середине')).toBe('минус - в середине');
  });
});

describe('DOCX', () => {
  it('escapes XML and drops characters XML cannot hold', () => {
    expect(xmlText('a<b>&"c"\u0001\u0007\tz')).toBe('a&lt;b&gt;&amp;&quot;c&quot;\tz');
  });

  it('document.xml has a title, one paragraph per piece and grey time marks', () => {
    const xml = documentXml(segs, true, 'Встреча');
    expect(xml).toContain('<w:t xml:space="preserve">Встреча</w:t>');
    expect(xml.match(/<w:p>/g)!.length).toBe(3);
    expect(xml).toContain('<w:color w:val="808080"/></w:rPr><w:t xml:space="preserve">[01:02:05] </w:t>');
    expect(xml).toContain('Привет, &lt;мир&gt; &amp; «всё»');
    expect(xml).toContain('вторая строка');
    expect(documentXml(segs, false, 'x')).not.toContain('808080');
  });

  it('is a zip with content types, rels and the document', () => {
    const p = join(dir, 'z.docx');
    writeFileSync(p, docxBytes(segs, true, 'Встреча'));
    const entries = listZip(p);
    expect(entries.map((e) => e.name)).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    const doc = readEntry(p, entries[2]).toString('utf8');
    expect(doc).toContain('вторая строка');
    expect(readEntry(p, entries[0]).toString('utf8')).toContain('wordprocessingml.document.main+xml');
  });
});

describe('writeExtras', () => {
  it('writes each chosen format beside the .txt and reports a failing one without stopping', () => {
    const txt = join(dir, 'talk.txt');
    const res = writeExtras(txt, join(dir, 'talk.m4a'), segs, 3731, ['vtt', 'json', 'md', 'docx'], true);
    expect(res).toEqual({ written: ['.vtt', '.json', '.md', '.docx'], failed: [] });
    expect(readFileSync(join(dir, 'talk.vtt'), 'utf8')).toMatch(/^WEBVTT/);
    expect(JSON.parse(readFileSync(join(dir, 'talk.json'), 'utf8')).source).toBe('talk.m4a');
    expect(readFileSync(join(dir, 'talk.md'), 'utf8')).toMatch(/^# talk\n/);
    expect(readFileSync(join(dir, 'talk.docx')).subarray(0, 2).toString()).toBe('PK');

    const seen: string[] = [];
    const res2 = writeExtras(txt, 'talk.m4a', segs, 1, ['vtt', 'md'], false, (p) => {
      seen.push(p);
      if (p.endsWith('.vtt')) throw new Error('EACCES');
    });
    expect(res2).toEqual({ written: ['.md'], failed: ['vtt: EACCES'] });
    expect(seen).toEqual([siblingPath(txt, 'vtt'), siblingPath(txt, 'md')]);
  });

  it('siblingPath swaps only the trailing .txt', () => {
    expect(siblingPath('/a/b.txt.txt', 'vtt')).toBe('/a/b.txt.vtt');
    expect(siblingPath('/a/B.TXT', 'md')).toBe('/a/B.md');
  });
});

describe('timings and settings', () => {
  it('needsTimings: srt/vtt/json always, md/docx only with timestamps', () => {
    expect(needsTimings([], true)).toBe(false);
    expect(needsTimings(['md', 'docx'], false)).toBe(false);
    expect(needsTimings(['md'], true)).toBe(true);
    expect(needsTimings(['json'], false)).toBe(true);
    expect(needsTimings(['vtt'], false)).toBe(true);
  });

  it('FileExtraFormats: known names, each once, fixed order; round-trips; off by default', () => {
    expect(defaults().FileExtraFormats).toEqual([]);
    expect(asExtraFormats(['docx', 'exe', 'vtt', 'vtt', 3])).toEqual(['vtt', 'docx']);
    expect(asExtraFormats('vtt')).toEqual([]);
    const { settings } = fromJsonObject({ FileExtraFormats: ['md', 'json'] });
    expect(settings.FileExtraFormats).toEqual(['json', 'md']);
    expect(toJsonObject(settings).FileExtraFormats).toEqual(['json', 'md']);
  });
});

describe('FileRunner with extra formats', () => {
  it('writes them after .txt/.srt and lists them on the row', async () => {
    const queue = new FileQueue();
    const src = join(dir, 'call.wav');
    writeFileSync(src, 'x');
    const runner = new FileRunner({
      queue,
      load16k: async () => new Float32Array(16000 * 5),
      prepare: async () => ({ ok: true, transcriber: async () => [{ start: 1, end: 4, text: 'алло' }] }),
      options: () => ({ timestamps: false, srt: true, extra: ['vtt', 'json', 'md', 'docx'], useBrain: false, diarize: false, brief: false }),
      status: () => {},
    });
    queue.add([src], false);
    await runner.run();
    const [row] = queue.snapshot();
    expect(row.state).toBe('Done');
    expect(row.note).toBe('00:00:05 · .srt · .vtt · .json · .md · .docx');
    for (const ext of ['txt', 'srt', 'vtt', 'json', 'md', 'docx']) expect(existsSync(join(dir, `call.${ext}`))).toBe(true);
    expect(readFileSync(join(dir, 'call.vtt'), 'utf8')).toContain('00:00:01.000 --> 00:00:04.000\nалло');
    expect(JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8')).duration).toBe(5);
  });
});

describe('speaker labels in vtt / json / md / docx (diarization, page and CLI)', () => {
  const segs = [
    { start: 0, end: 2, text: 'Привет.', speaker: 0 },
    { start: 2, end: 2.1, text: ' ', speaker: 1 },
    { start: 3, end: 5, text: 'Как дела?', speaker: 1 },
    { start: 6, end: 7, text: 'Без спикера.' },
  ];
  it('«Спикер N:» prefix like .txt/.srt; json carries a 1-based speaker field', () => {
    expect(toVtt(segs)).toContain('00:00:00.000 --> 00:00:02.000\nСпикер 1: Привет.\n');
    expect(toVtt(segs)).toContain('\nСпикер 2: Как дела?\n');
    expect(toVtt(segs)).toContain('\nБез спикера.\n');
    const j = JSON.parse(toJson(segs, { source: 'a.wav', duration: 7 })) as { segments: Array<{ text: string; speaker?: number }> };
    expect(j.segments).toEqual([
      { start: 0, end: 2, text: 'Привет.', speaker: 1 },
      { start: 3, end: 5, text: 'Как дела?', speaker: 2 },
      { start: 6, end: 7, text: 'Без спикера.' },
    ]);
    expect(toMarkdown(segs, true, 't')).toContain('**[00:00:03]** Спикер 2: Как дела?');
    expect(documentXml(segs, false, 'x')).toContain('Спикер 1: Привет.');
  });
  it('no speakers → unchanged output', () => {
    const plain = segs.map(({ start, end, text }) => ({ start, end, text }));
    expect(toVtt(plain)).not.toContain('Спикер');
    expect(toJson(plain, { source: 'a', duration: 7 })).not.toContain('speaker');
    expect(toMarkdown(plain, false, 't')).not.toContain('Спикер');
  });
});
