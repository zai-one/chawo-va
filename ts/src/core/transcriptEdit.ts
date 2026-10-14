// One phrase fixed in the «Расшифровка» editor: the same text is replaced in the transcript files
// beside it (.txt, .srt, .vtt, .md, .json). A file is changed only when the old phrase occurs in it
// exactly once, so an ambiguous phrase never edits the wrong line. .docx is left as it was.

export const EDITABLE_EXTS = ['.txt', '.srt', '.vtt', '.md', '.json'] as const;

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function siblingTranscripts(txtPath: string): string[] {
  const base = txtPath.replace(/\.txt$/i, '');
  return EDITABLE_EXTS.map((e) => base + e);
}

/** Returns the files that were rewritten (empty = the phrase was not found once anywhere). */
export function editTranscriptPhrase(
  txtPath: string,
  oldText: string,
  newText: string,
  read: (path: string) => string | null,
  write: (path: string, data: string) => void,
): string[] {
  const from = oldText.trim();
  const to = newText.replace(/\s+/g, ' ').trim();
  if (!from || !to || from === to) return [];
  const changed: string[] = [];
  for (const p of siblingTranscripts(txtPath)) {
    const body = read(p);
    if (body == null) continue;
    const json = p.toLowerCase().endsWith('.json');
    const a = json ? JSON.stringify(from).slice(1, -1) : from;
    const b = json ? JSON.stringify(to).slice(1, -1) : to;
    if (count(body, a) !== 1) continue;
    write(p, body.replace(a, () => b));
    changed.push(p);
  }
  return changed;
}
