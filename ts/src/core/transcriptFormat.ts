// Plain text and SubRip output for a transcribed file. Port of src/Core/TranscriptFormat.cs.
// The segment shape (start, end, text) is what a server backend would store per chunk.

/** One recognized piece. start/end are seconds in the source recording. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
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

/** One line per non-empty piece; with timestamps each line starts with [hh:mm:ss]. */
export function toTxt(segments: readonly TranscriptSegment[], timestamps: boolean): string {
  const lines: string[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    lines.push(timestamps ? `[${clock(seg.start)}] ${text}` : text);
  }
  return lines.join('\n');
}

/** SubRip: index, start --> end, text, blank line. Empty pieces skipped, numbering continuous. */
export function toSrt(segments: readonly TranscriptSegment[]): string {
  let out = '';
  let n = 0;
  for (const seg of segments) {
    const text = (seg.text ?? '').trim();
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
