// Plain text and SubRip output for a transcribed file. Port of src/Core/TranscriptFormat.cs.
// WebVTT, JSON and Markdown were added in the TS port (IDEAS.md №6); DOCX lives in transcriptDocx.ts.
// The segment shape (start, end, text) is what a server backend would store per chunk.

import { hasSpeakerLabels, speakerPrefix } from './diarize';

/** One recognized piece. start/end are seconds in the source recording. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** 0-based speaker id after diarization; omitted when unknown / diarization off. */
  speaker?: number;
}

const p2 = (n: number) => String(n).padStart(2, '0');

function wholeSeconds(seconds: number): number {
  return Number.isNaN(seconds) || seconds < 0 ? 0 : seconds;
}

/** 00:00:00, hours always shown, seconds floored. */
export function clock(seconds: number): string {
  const s = Math.floor(wholeSeconds(seconds));
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
}

/** 00:00:00,000 as SubRip wants it. */
export function srtTime(seconds: number): string {
  const ms = Math.round(wholeSeconds(seconds) * 1000);
  const s = Math.floor(ms / 1000);
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)},${String(ms % 1000).padStart(3, '0')}`;
}

function lineText(seg: TranscriptSegment, withSpeakers: boolean): string {
  const text = (seg.text ?? '').trim();
  if (!text) return '';
  if (!withSpeakers) return text;
  return speakerPrefix(seg.speaker) + text;
}

/** One line per non-empty piece; with timestamps each line starts with [hh:mm:ss]. */
export function toTxt(segments: readonly TranscriptSegment[], timestamps: boolean): string {
  const withSpeakers = hasSpeakerLabels(segments);
  const lines: string[] = [];
  for (const seg of segments) {
    const text = lineText(seg, withSpeakers);
    if (!text) continue;
    lines.push(timestamps ? `[${clock(seg.start)}] ${text}` : text);
  }
  return lines.join('\n');
}

/**
 * Back from a finished .txt (as toTxt wrote it, or edited by hand): one segment per non-empty line.
 * «[hh:mm:ss] text» gives the start; a line without it keeps the previous start. `timestamps` says
 * whether any line had one, so a re-run (e.g. `chawo-va brain`) writes the same style back.
 * «Спикер N:» stays part of the text — the Brain sees it as written.
 */
export function fromTxt(text: string): { segments: TranscriptSegment[]; timestamps: boolean } {
  const segments: TranscriptSegment[] = [];
  let timestamps = false;
  let start = 0;
  for (const raw of (text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const m = /^\[(\d{1,3}):([0-5]\d):([0-5]\d)\]\s*/.exec(line);
    if (m) {
      timestamps = true;
      start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      line = line.slice(m[0].length).trim();
      if (!line) continue;
    }
    segments.push({ start, end: start, text: line });
  }
  for (let i = 0; i < segments.length; i++) {
    const next = segments[i + 1];
    segments[i].end = next && next.start > segments[i].start ? next.start : segments[i].start;
  }
  return { segments, timestamps };
}

/** SubRip: index, start --> end, text, blank line. Empty pieces skipped, numbering continuous. */
export function toSrt(segments: readonly TranscriptSegment[]): string {
  const withSpeakers = hasSpeakerLabels(segments);
  let out = '';
  let n = 0;
  for (const seg of segments) {
    const text = lineText(seg, withSpeakers);
    if (!text) continue;
    n++;
    const end = Math.max(seg.end, seg.start + 0.5);
    out += `${n}\r\n${srtTime(seg.start)} --> ${srtTime(end)}\r\n${text.replace(/\r\n/g, '\n').replace(/\n/g, ' ')}\r\n\r\n`;
  }
  return out;
}

/** Segments from pause-split sample ranges and the texts the model returned for them. */
export function fromRanges(
  ranges: readonly (readonly [number, number])[],
  texts: readonly string[],
  rate: number,
): TranscriptSegment[] {
  const r = Math.max(1, rate);
  const list: TranscriptSegment[] = [];
  for (let i = 0; i < ranges.length && i < texts.length; i++) {
    list.push({ start: ranges[i][0] / r, end: ranges[i][1] / r, text: texts[i] ?? '' });
  }
  return list;
}

/** Extra files written next to the .txt. srt is the WPF one (setting FileSrt), the rest are new. */
export type ExtraFormat = 'srt' | 'vtt' | 'json' | 'md' | 'docx';
export const EXTRA_FORMATS: readonly ExtraFormat[] = ['srt', 'vtt', 'json', 'md', 'docx'];

/** Formats that need real per-piece timings (a remote host must then get each piece on its own). */
export function needsTimings(formats: readonly ExtraFormat[], timestamps: boolean): boolean {
  if (formats.includes('srt') || formats.includes('vtt') || formats.includes('json')) return true;
  return timestamps && (formats.includes('md') || formats.includes('docx'));
}

/** 00:00:00.000 as WebVTT wants it (hours always shown). */
export function vttTime(seconds: number): string {
  return srtTime(seconds).replace(',', '.');
}

function oneLine(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s*\n\s*/g, ' ');
}

function nonEmpty(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  const list: TranscriptSegment[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    list.push(typeof seg.speaker === 'number' ? { start: seg.start, end: seg.end, text, speaker: seg.speaker } : { start: seg.start, end: seg.end, text });
  }
  return list;
}

/** WebVTT: header, numbered cues, & < > escaped so a phrase never breaks the cue syntax. */
export function toVtt(segments: readonly TranscriptSegment[]): string {
  let out = 'WEBVTT\n\n';
  let n = 0;
  for (const seg of nonEmpty(segments)) {
    n++;
    const end = Math.max(seg.end, seg.start + 0.5);
    const text = (speakerPrefix(seg.speaker) + oneLine(seg.text)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out += `${n}\n${vttTime(seg.start)} --> ${vttTime(end)}\n${text}\n\n`;
  }
  return out;
}

const ms = (seconds: number) => Math.round(wholeSeconds(seconds) * 1000) / 1000;

/**
 * JSON for scripts and integrations: the same shape a server backend would store.
 * Times are seconds rounded to milliseconds; empty pieces are left out.
 */
export function toJson(
  segments: readonly TranscriptSegment[],
  info: { source: string; duration: number },
): string {
  // speaker: 1-based like «Спикер N» in the .txt; only when diarization labelled the piece.
  const list = nonEmpty(segments).map((s) => {
    const item: { start: number; end: number; text: string; speaker?: number } = { start: ms(s.start), end: ms(Math.max(s.end, s.start)), text: s.text };
    if (speakerPrefix(s.speaker)) item.speaker = Math.floor(s.speaker!) + 1;
    return item;
  });
  const doc = {
    format: 'chawo-transcript',
    version: 1,
    source: info.source,
    duration: ms(info.duration),
    text: list.map((s) => s.text).join('\n'),
    segments: list,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Escapes what Markdown would otherwise read as formatting, plus a list/heading marker at the start. */
export function mdEscape(text: string): string {
  let s = text.replace(/([\\`*_[\]<>|])/g, '\\$1');
  s = s.replace(/^(\s*)([#+-])(?=\s|$)/, '$1\\$2').replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');
  return s;
}

/** Markdown: the file name as a heading, one paragraph per piece, optional **[hh:mm:ss]** prefix. */
export function toMarkdown(segments: readonly TranscriptSegment[], timestamps: boolean, title: string): string {
  const parts = [`# ${mdEscape(oneLine(title.trim()) || 'Transcript')}`];
  for (const seg of nonEmpty(segments)) {
    const text = mdEscape(speakerPrefix(seg.speaker) + oneLine(seg.text));
    parts.push(timestamps ? `**[${clock(seg.start)}]** ${text}` : text);
  }
  return parts.join('\n\n') + '\n';
}

const SRT_TIME = /(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})/;
const SRT_ARROW = /^\s*(\d{1,3}:[0-5]\d:[0-5]\d[,.]\d{1,3})\s*-->\s*(\d{1,3}:[0-5]\d:[0-5]\d[,.]\d{1,3})/;
const SPEAKER_LINE = /^(?:Спикер|Speaker)\s+(\d+)\s*:\s*/i;

function parseSrtClock(raw: string): number | null {
  const m = SRT_TIME.exec(raw.trim());
  if (!m) return null;
  const ms = Number((m[4] + '000').slice(0, 3));
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

/** Strip a leading «Спикер N:» / «Speaker N:» into a 0-based speaker id. */
export function splitSpeakerPrefix(text: string): { text: string; speaker?: number } {
  const m = SPEAKER_LINE.exec(text);
  if (!m) return { text };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return { text };
  return { text: text.slice(m[0].length).trim(), speaker: Math.floor(n) - 1 };
}

/**
 * Back from a SubRip file (as toSrt wrote it, or edited by hand). Multi-line cues are joined with a
 * space; an optional «Спикер N:» / «Speaker N:» on the first text line becomes `speaker` (0-based).
 */
export function fromSrt(text: string): TranscriptSegment[] {
  const body = (text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!body) return [];
  const blocks = body.split(/\n\s*\n+/);
  const list: TranscriptSegment[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    if (i >= lines.length) continue;
    const arrow = SRT_ARROW.exec(lines[i].trim());
    if (!arrow) continue;
    const start = parseSrtClock(arrow[1]);
    const end = parseSrtClock(arrow[2]);
    if (start === null || end === null) continue;
    i++;
    const rawText = lines.slice(i).map((l) => l.trim()).filter(Boolean).join(' ');
    if (!rawText) continue;
    const { text: cue, speaker } = splitSpeakerPrefix(rawText);
    if (!cue) continue;
    const seg: TranscriptSegment = { start, end: Math.max(end, start), text: cue };
    if (speaker !== undefined) seg.speaker = speaker;
    list.push(seg);
  }
  return list;
}

/**
 * Back from a toJson / chawo-transcript document. `speaker` in JSON is 1-based (like «Спикер N»);
 * the returned segments use 0-based ids. A bare `{ segments: [...] }` is accepted too.
 */
export function fromJsonTranscript(text: string): { segments: TranscriptSegment[]; source: string; duration: number } {
  let doc: unknown;
  try {
    doc = JSON.parse((text ?? '').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('not valid JSON');
  }
  if (!doc || typeof doc !== 'object') throw new Error('not a transcript object');
  const o = doc as Record<string, unknown>;
  const raw = Array.isArray(o.segments) ? o.segments : Array.isArray(doc) ? doc : null;
  if (!raw) throw new Error('no segments');
  const segments: TranscriptSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const start = Number(s.start);
    const end = Number(s.end);
    const t = typeof s.text === 'string' ? s.text.trim() : '';
    if (!t || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const seg: TranscriptSegment = { start: Math.max(0, start), end: Math.max(end, start), text: t };
    const sp = Number(s.speaker);
    if (Number.isFinite(sp) && sp >= 1) seg.speaker = Math.floor(sp) - 1;
    else if (Number.isFinite(sp) && sp >= 0 && Number.isInteger(sp) && s.speaker === 0) {
      /* ignore 0 — toJson never writes it */
    }
    segments.push(seg);
  }
  return {
    segments,
    source: typeof o.source === 'string' ? o.source : '',
    duration: Number.isFinite(Number(o.duration)) ? Number(o.duration) : 0,
  };
}

export type TimedSourceHint = 'srt' | 'json' | 'txt';

export type TimedTranscriptLoad =
  | { available: true; segments: TranscriptSegment[]; sourceHint: TimedSourceHint }
  | { available: false; segments: []; sourceHint?: TimedSourceHint; reason: 'missing' | 'no-timings' | 'empty' | 'bad' };

/**
 * Prefer a sibling .srt, else a sibling .json with segments, else a .txt that has `[hh:mm:ss]` stamps.
 * `txtPath` may also be the .srt / .json itself (CLI). `read` returns file text or null when missing.
 */
export function loadTimedTranscript(
  txtPath: string,
  read: (path: string) => string | null,
): TimedTranscriptLoad {
  const p = (txtPath ?? '').trim();
  if (!p) return { available: false, segments: [], reason: 'missing' };
  const lower = p.toLowerCase();
  if (lower.endsWith('.srt')) {
    const raw = read(p);
    if (raw === null) return { available: false, segments: [], reason: 'missing' };
    const segments = fromSrt(raw);
    return segments.length > 0
      ? { available: true, segments, sourceHint: 'srt' }
      : { available: false, segments: [], sourceHint: 'srt', reason: 'empty' };
  }
  if (lower.endsWith('.json')) {
    const raw = read(p);
    if (raw === null) return { available: false, segments: [], reason: 'missing' };
    try {
      const { segments } = fromJsonTranscript(raw);
      return segments.length > 0
        ? { available: true, segments, sourceHint: 'json' }
        : { available: false, segments: [], sourceHint: 'json', reason: 'empty' };
    } catch {
      return { available: false, segments: [], sourceHint: 'json', reason: 'bad' };
    }
  }
  const base = p.replace(/\.[^./\\]+$/, '');
  const srtRaw = read(base + '.srt');
  if (srtRaw !== null) {
    const segments = fromSrt(srtRaw);
    if (segments.length > 0) return { available: true, segments, sourceHint: 'srt' };
  }
  const jsonRaw = read(base + '.json');
  if (jsonRaw !== null) {
    try {
      const { segments } = fromJsonTranscript(jsonRaw);
      if (segments.length > 0) return { available: true, segments, sourceHint: 'json' };
    } catch {
      /* fall through to txt */
    }
  }
  const txtRaw = read(lower.endsWith('.txt') ? p : base + '.txt');
  if (txtRaw === null) return { available: false, segments: [], reason: 'missing' };
  const back = fromTxt(txtRaw);
  if (!back.timestamps || back.segments.length === 0) {
    return { available: false, segments: [], sourceHint: 'txt', reason: back.segments.length === 0 ? 'empty' : 'no-timings' };
  }
  // «Спикер N:» becomes `speaker`, as fromSrt does, so call stats and the editor see the speakers of a
  // diarized .txt-only transcript (the default format). fromTxt keeps the prefix for the Brain.
  const segments = back.segments.map((seg) => {
    const { text, speaker } = splitSpeakerPrefix(seg.text);
    return speaker === undefined || !text ? seg : { ...seg, text, speaker };
  });
  return { available: true, segments, sourceHint: 'txt' };
}
