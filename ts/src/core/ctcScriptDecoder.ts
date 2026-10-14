// Letter-script choice for multilingual CTC greedy decoding. Port of src/Core/CtcScriptDecoder.cs.
// Forcing a script means skipping those letter ids when picking the best logit of each frame.

import type { CtcScript } from './speechModels';

/** Auto accepts the Latin-only path when its mean chosen logit is within this of the free path. */
export const AUTO_LATIN_GAP_PER_FRAME = 0.75;

export type TokenKind = 'neutral' | 'latin' | 'cyrillic';

export interface CtcPath {
  text: string;
  sum: number;
  frames: number;
}

const isLatin = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
const isCyrillic = (c: string) => c >= '\u0400' && c <= '\u052F';

export function classify(token: string): TokenKind {
  if (!token || token[0] === '<') return 'neutral';
  let lat = false;
  let cyr = false;
  for (const ch of token) {
    if (isLatin(ch)) lat = true;
    else if (isCyrillic(ch)) cyr = true;
  }
  if (cyr && !lat) return 'cyrillic';
  if (lat && !cyr) return 'latin';
  return 'neutral';
}

function countLetters(text: string): { lat: number; cyr: number } {
  let lat = 0;
  let cyr = 0;
  for (const ch of text) {
    if (isLatin(ch)) lat++;
    else if (isCyrillic(ch)) cyr++;
  }
  return { lat, cyr };
}

export function mostlyLatin(text: string): boolean {
  const { lat, cyr } = countLetters(text);
  return lat > 0 && lat >= cyr;
}

export function hasLatinLetter(text: string): boolean {
  return countLetters(text).lat > 0;
}

/** greedy(allowLatin, allowCyrillic). Neutral tokens, including blank, stay allowed in every call. */
export function chooseScript(script: CtcScript, greedy: (allowLatin: boolean, allowCyrillic: boolean) => CtcPath): string {
  if (script === 'english') return greedy(true, false).text;
  if (script === 'russian') return greedy(false, true).text;
  const free = greedy(true, true);
  if (mostlyLatin(free.text)) return free.text;
  const latin = greedy(true, false);
  if (!hasLatinLetter(latin.text)) return free.text;
  const frames = Math.max(1, free.frames, latin.frames);
  const gap = (free.sum - latin.sum) / frames;
  return gap <= AUTO_LATIN_GAP_PER_FRAME ? latin.text : free.text;
}
