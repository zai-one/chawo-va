// Assign speaker labels from diarization time spans onto transcript segments.
// Pure: no Electron, no native addon. Speaker ids are remapped 0,1,2… by first appearance
// in the transcript (so «Спикер 1» is whoever spoke first in the written output).

import type { TranscriptSegment } from './transcriptFormat';

/** One contiguous stretch attributed to a single speaker (seconds). */
export interface DiarSpan {
  start: number;
  end: number;
  /** Raw speaker id from the diarizer (any integer). */
  speaker: number;
}

/** Overlap length in seconds between [a0,a1] and [b0,b1]; 0 when they do not overlap. */
export function overlapSeconds(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return hi > lo ? hi - lo : 0;
}

/**
 * For each transcript segment pick the diarization span with the largest time overlap and copy
 * its speaker. Speakers are remapped by first appearance in the resulting list (0-based).
 * Segments with no positive overlap keep no `speaker` field.
 */
export function assignSpeakers(
  transcript: readonly TranscriptSegment[],
  diarSpans: readonly DiarSpan[],
): TranscriptSegment[] {
  const remap = new Map<number, number>();
  let next = 0;
  const out: TranscriptSegment[] = [];

  for (const seg of transcript) {
    const start = Number.isFinite(seg.start) ? seg.start : 0;
    const end = Number.isFinite(seg.end) ? Math.max(seg.end, start) : start;
    let best = -1;
    let bestOv = 0;
    for (const d of diarSpans) {
      const ov = overlapSeconds(start, end, d.start, d.end);
      if (ov > bestOv) {
        bestOv = ov;
        best = d.speaker;
      }
    }
    if (best < 0 || bestOv <= 0) {
      out.push({ start: seg.start, end: seg.end, text: seg.text });
      continue;
    }
    let mapped = remap.get(best);
    if (mapped === undefined) {
      mapped = next++;
      remap.set(best, mapped);
    }
    out.push({ start: seg.start, end: seg.end, text: seg.text, speaker: mapped });
  }
  return out;
}

/** True when at least one segment carries a speaker id. */
export function hasSpeakerLabels(segments: readonly TranscriptSegment[]): boolean {
  return segments.some((s) => typeof s.speaker === 'number' && Number.isFinite(s.speaker));
}

/**
 * «Спикер N:» prefix (1-based). Always Russian — the export label is product copy, not UI locale.
 * Empty when speaker is missing/invalid.
 */
export function speakerPrefix(speaker: number | undefined): string {
  if (typeof speaker !== 'number' || !Number.isFinite(speaker) || speaker < 0) return '';
  return `Спикер ${Math.floor(speaker) + 1}: `;
}
