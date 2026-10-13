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
