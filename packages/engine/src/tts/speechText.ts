// Text for reading aloud: tidied and cut into pieces a speech service accepts (services cap one request,
// OpenAI at 4096 characters). Cuts fall on sentence ends, then on commas or spaces, never inside a word.

/** Longest text read at once (a selection is capped at 20 000 characters by the helper anyway). */
export const MAX_SPEECH_CHARS = 20_000;

/** Whitespace folded, invisible characters dropped; '' when nothing readable is left. */
export function speechInput(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_SPEECH_CHARS);
}

/** Pieces of at most `max` characters, split at the best boundary before the limit. */
export function splitForSpeech(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const re of [/[.!?…][»"')\]]?\s/g, /\n/g, /[,;:—–]\s/g, /\s/g]) {
      let m: RegExpExecArray | null;
      let last = -1;
      while ((m = re.exec(window)) !== null) last = m.index + m[0].length;
      if (last > max * 0.4) {
        cut = last;
        break;
      }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out.filter((p) => p.length > 0);
}
