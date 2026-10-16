// Extra transcript files beside name.txt: .vtt, .json, .md and .docx (IDEAS.md №6). .srt stays in
// the runner as in WPF. Each file is written whole; a failure in one format is reported on the row
// and the others still get written.

import { writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { docxParts } from '@chawo/core/transcriptDocx';
import { toJson, toMarkdown, toVtt, type TranscriptSegment } from '@chawo/core/transcriptFormat';
import type { FileExtraFormat } from '../settings';
import { buildZip } from './zip';

/** name.txt -> name.<ext> */
export function siblingPath(txtPath: string, ext: string): string {
  return txtPath.replace(/\.txt$/i, '') + '.' + ext;
}

export function docxBytes(segments: readonly TranscriptSegment[], timestamps: boolean, title: string): Buffer {
  return buildZip(docxParts(segments, timestamps, title).map((p) => ({ name: p.name, data: Buffer.from(p.xml, 'utf8'), deflate: true })));
}

export interface ExportResult {
  /** '.vtt', '.json', … for the formats written. */
  written: string[];
  /** 'docx: EACCES …' per format that failed. */
  failed: string[];
}

export function writeExtras(
  txtPath: string,
  sourcePath: string,
  segments: readonly TranscriptSegment[],
  durationSeconds: number,
  formats: readonly FileExtraFormat[],
  timestamps: boolean,
  write: (path: string, data: string | Buffer) => void = (p, d) => writeFileSync(p, d, typeof d === 'string' ? 'utf8' : undefined),
): ExportResult {
  const title = basename(sourcePath, extname(sourcePath)) || 'Transcript';
  const result: ExportResult = { written: [], failed: [] };
  for (const f of formats) {
    try {
      const data =
        f === 'vtt'
          ? toVtt(segments)
          : f === 'json'
            ? toJson(segments, { source: basename(sourcePath), duration: durationSeconds })
            : f === 'md'
              ? toMarkdown(segments, timestamps, title)
              : docxBytes(segments, timestamps, title);
      write(siblingPath(txtPath, f), data);
      result.written.push('.' + f);
    } catch (e) {
      result.failed.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
