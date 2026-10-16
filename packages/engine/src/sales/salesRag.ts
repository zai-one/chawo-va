// Local sales materials: a folder of .txt / .md. No network and no model. Port of src/App/SalesRag.cs.
// Used for a card snippet when the catalog code is missing (findSnippet), and for dictionary
// suggestions the user still has to add by hand.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ReplacePair } from '@chawo/core/wordReplace';

export interface DictSuggestion {
  heard: string;
  written: string;
  /** File name (not the full path) the line came from. */
  source: string;
}

export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 512_000;
export const MAX_SUGGESTIONS = 40;
export const SNIPPET_CHARS = 220;

export interface RagSnippet {
  text: string;
  /** File name (not the full path). */
  source: string;
}

const EXTS = new Set(['.txt', '.md', '.markdown']);

export function isMaterialFile(path: string): boolean {
  return EXTS.has(extname(path).toLowerCase());
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Material file paths, depth-first, at most MAX_FILES. Unreadable folders are skipped. */
export function materialPaths(folder: string, max = MAX_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs: string[] = [];
    for (const e of entries) {
      if (out.length >= max) return;
      const p = join(dir, e.name);
      if (e.isFile() && isMaterialFile(e.name)) out.push(p);
      else if (e.isDirectory()) dirs.push(p);
    }
    for (const d of dirs) {
      if (out.length >= max) return;
      walk(d);
    }
  };
  walk(folder);
  return out;
}

/** Text of each material file: skips empty, oversized and unreadable files. BOM is dropped. */
export function* readFiles(folder: string): Generator<{ path: string; text: string }> {
  for (const path of materialPaths(folder)) {
    let text: string;
    try {
      const size = statSync(path).size;
      if (size === 0 || size > MAX_FILE_BYTES) continue;
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (!text.trim()) continue;
    yield { path, text };
  }
}

const isAsciiLetter = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
const isDigit = (c: string) => /\p{Nd}/u.test(c);
const isUpper = (c: string) => /\p{Lu}/u.test(c);
const isLetter = (c: string) => /\p{L}/u.test(c);

/** Brand-like Latin tokens: CamelCase, ALLCAPS, or Latin mixed with digits (SKU-ish). Min 3 chars. */
export function extractLatinBrands(line: string): string[] {
  const list: string[] = [];
  let sb = '';
  const flush = () => {
    if (sb.length < 3) {
      sb = '';
      return;
    }
    const tok = sb;
    sb = '';
    const chars = [...tok];
    if (!chars.some(isLetter)) return;
    if (!chars.some(isUpper) && !chars.some(isDigit)) return;
    if (chars.every(isDigit)) return;
    if (!list.includes(tok)) list.push(tok);
  };
  for (const c of line) {
    if (isAsciiLetter(c) || isDigit(c) || c === '-' || c === '_') sb += c;
    else flush();
  }
  flush();
  return list;
}

/** Lower-cased Cyrillic words (ё → е), min 3 letters, unique ignoring case. */
export function extractCyrillic(line: string): string[] {
  const list: string[] = [];
  let sb = '';
  const flush = () => {
    if (sb.length < 3) {
      sb = '';
      return;
    }
    const tok = sb;
    sb = '';
    if (!list.some((w) => w.toLowerCase() === tok.toLowerCase())) list.push(tok);
  };
  for (const raw of line) {
    const lower = (raw === 'Ё' ? 'Е' : raw === 'ё' ? 'е' : raw).toLowerCase();
    if (lower.length === 1 && lower >= 'а' && lower <= 'я') sb += lower;
    else flush();
  }
  flush();
  return list;
}

const TRANSLIT_PAIRS: [string, string][] = [
  ['ch', 'ч'], ['sh', 'ш'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ya', 'я'], ['yu', 'ю'],
  ['yo', 'е'], ['ye', 'е'], ['th', 'т'],
];

const TRANSLIT_CHARS: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л',
  m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс',
  y: 'й', z: 'з',
};

/** Rough Latin → Cyrillic so "Taptain" meets "таптайн" by letters. */
export function translitHint(latin: string): string {
  const s = latin.toLowerCase();
  let out = '';
  for (let i = 0; i < s.length; ) {
    const hit = TRANSLIT_PAIRS.find(([from]) => s.startsWith(from, i));
    if (hit) {
      out += hit[1];
      i += hit[0].length;
      continue;
    }
    const c = s[i++];
    out += TRANSLIT_CHARS[c] ?? c;
  }
  return out;
}

/** Lower case, ё → е, letters/digits/-/_ kept, everything else collapses to one space. */
export function fold(text: string): string {
  let out = '';
  for (const raw of text.trim().toLowerCase()) {
    const c = raw === 'ё' ? 'е' : raw;
    if (/[\p{L}\p{N}_-]/u.test(c)) out += c;
    else if (out.length > 0 && !out.endsWith(' ')) out += ' ';
  }
  return out.trim();
}

export function letters(folded: string): string {
  let out = '';
  for (const c of folded) if (isLetter(c)) out += c;
  return out;
}

/** How many letters of b can be matched to letters of a (multiset intersection size). */
export function sharedLetters(a: string, b: string): number {
  const counts = new Map<string, number>();
  for (const c of a) counts.set(c, (counts.get(c) ?? 0) + 1);
  let n = 0;
  for (const c of b) {
    const k = counts.get(c) ?? 0;
    if (k === 0) continue;
    counts.set(c, k - 1);
    n++;
  }
  return n;
}

/** Keep pairs that look related: shared letters or one looks like a translit of the other. */
export function nearEnough(cyr: string, latin: string): boolean {
  const a = letters(fold(cyr));
  const b = letters(fold(translitHint(latin)));
  const la = [...a].length;
  const lb = [...b].length;
  if (la < 3 || lb < 3) return false;
  const share = sharedLetters(a, b);
  if (share >= 3 && share >= Math.min(la, lb) * 0.45) return true;
  // Same line already; accept a short Cyrillic gloss next to a brand (таптайн Taptain).
  return la <= 12 && lb <= 16 && share >= 2;
}

/**
 * Brand-like Latin tokens and Cyrillic neighbors from the same line of the materials.
 * Suggestions are not applied; the caller shows them for the user to add.
 */
export function suggestDictionary(folder: string | null | undefined, existing: Iterable<ReplacePair>): DictSuggestion[] {
  const list: DictSuggestion[] = [];
  if (!folder || !folder.trim() || !isDir(folder)) return list;
  const taken = new Set<string>();
  const has = (s: string) => taken.has(s.toLowerCase());
  const add = (s: string) => {
    const k = s.toLowerCase();
    if (taken.has(k)) return false;
    taken.add(k);
    return true;
  };
  for (const pair of existing) {
    if (pair.from.trim()) add(pair.from.trim());
    if (pair.to.trim()) add(pair.to.trim());
  }

  for (const { path, text } of readFiles(folder)) {
    const file = basename(path);
    for (const line of text.split('\n')) {
      const latin = extractLatinBrands(line);
      const cyr = extractCyrillic(line);
      if (latin.length === 0 || cyr.length === 0) continue;
      for (const brand of latin) {
        if (has(brand)) continue;
        for (const neighbor of cyr) {
          if (neighbor.length < 3 || has(neighbor)) continue;
          if (!nearEnough(neighbor, brand)) continue;
          if (!add(`${neighbor}->${brand}`)) continue;
          add(neighbor);
          list.push({ heard: neighbor, written: brand, source: file });
          if (list.length >= MAX_SUGGESTIONS) return list;
          break;
        }
      }
    }
  }
  return list;
}

/** Paragraphs of a material file: blank lines split, lines are joined with a space, long runs cut at 2×SNIPPET_CHARS. */
export function splitBlocks(text: string): string[] {
  const out: string[] = [];
  let sb = '';
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      if (sb.length > 0) {
        out.push(sb);
        sb = '';
      }
      continue;
    }
    if (sb.length > 0) sb += ' ';
    sb += line;
    if (sb.length >= SNIPPET_CHARS * 2) {
      out.push(sb);
      sb = '';
    }
  }
  if (sb.length > 0) out.push(sb);
  return out;
}

/** Cuts at the last space before max (unless that is under half), adds «…». */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.lastIndexOf(' ', max);
  if (cut < max / 2) cut = max;
  return text.slice(0, cut).trimEnd() + '…';
}

/**
 * Best short paragraph from the folder that shares letters with the transcript (SalesRag.FindSnippet).
 * Null when the folder is empty, missing, or nothing is close enough. Reads only the local disk.
 */
export function findSnippet(transcript: string | null | undefined, folder: string | null | undefined): RagSnippet | null {
  if (!transcript || !transcript.trim() || !folder || !folder.trim()) return null;
  if (!isDir(folder)) return null;
  const folded = fold(transcript);
  const words = [...new Set(folded.split(' ').filter((w) => w.length > 0).map(letters).filter((w) => w.length >= 3))];
  if (words.length === 0) return null;
  const spokenLen = folded.replace(/ /g, '').length;

  let best: RagSnippet | null = null;
  let bestScore = 0;
  let bestOverlap = 0;
  for (const { path, text } of readFiles(folder)) {
    for (const block of splitBlocks(text)) {
      const blockFold = fold(block);
      const blockLetters = letters(blockFold);
      if (blockLetters.length < 8) continue;
      const blockWords = blockFold.split(' ').map(letters).filter((x) => x.length >= 3);
      let overlap = 0;
      for (const w of words) {
        if (blockFold.includes(w) || blockWords.some((b) => looksLike(b, w))) overlap += w.length;
      }
      if (overlap < 4) continue;
      const score = overlap / Math.max(blockLetters.length, spokenLen);
      if (score < 0.08) continue;
      if (score < bestScore || (Math.abs(score - bestScore) < 0.0001 && overlap <= bestOverlap)) continue;
      bestScore = score;
      bestOverlap = overlap;
      best = { text: clip(block.trim(), SNIPPET_CHARS), source: basename(path) };
    }
  }
  return best;
}

/**
 * A spoken word and a material word that differ only by an ending or a letter or two («станцию» /
 * «станция»). WPF compared each spoken word with the letters of the whole paragraph, so any long
 * paragraph matched every word and short unrelated paragraphs won; here it is word against word.
 */
export function looksLike(materialWord: string, spoken: string): boolean {
  const a = materialWord.length;
  const b = spoken.length;
  if (Math.abs(a - b) > 3) return false;
  const share = sharedLetters(materialWord, spoken);
  return share >= 4 && share >= Math.max(a, b) * 0.75 && materialWord.slice(0, 2) === spoken.slice(0, 2);
}

/** How many .txt/.md files the folder holds (the «Файлов .txt/.md: N.» line); -1 when it is not a folder. */
export function countMaterialFiles(folder: string): number {
  if (!isDir(folder)) return -1;
  return materialPaths(folder, 100_000).length;
}
