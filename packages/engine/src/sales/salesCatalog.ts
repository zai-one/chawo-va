// Local sales catalog matching. Port of src/App/SalesCatalog.cs: letters on this PC, no network, no model.
// Exact when the live text holds a catalog code as its own word; otherwise a similar-code word, or the
// nearest name by shared letters (labelled «похоже» on the card).

import type { SalesCatalogItem } from '../settings';
import { fold, letters, sharedLetters } from './salesRag';

export type SalesHitKind = 'Exact' | 'Similar';

export interface SalesHit {
  kind: SalesHitKind;
  name: string;
  line: string;
  code: string;
  /** Short paragraph from the materials folder; only on a «похоже» hit. */
  ragSnippet: string;
}

function showName(item: SalesCatalogItem): string {
  const name = item.Name.trim();
  return name.length > 0 ? name : item.Code.trim();
}

function hitOf(kind: SalesHitKind, item: SalesCatalogItem): SalesHit {
  return { kind, name: showName(item), line: item.Line.trim(), code: item.Code.trim(), ragSnippet: '' };
}

/** True when token is its own word in the folded text. */
function containsToken(folded: string, token: string): boolean {
  let from = 0;
  while (from <= folded.length - token.length) {
    const at = folded.indexOf(token, from);
    if (at < 0) return false;
    const left = at === 0 || folded[at - 1] === ' ';
    const end = at + token.length;
    const right = end === folded.length || folded[end] === ' ';
    if (left && right) return true;
    from = at + 1;
  }
  return false;
}

interface Nearest {
  item: SalesCatalogItem | null;
  best: number;
  bestOverlap: number;
}

function consider(item: SalesCatalogItem, name: string, chunk: string, n: Nearest): void {
  if (chunk.length < 3) return;
  const overlap = sharedLetters(name, chunk);
  if (overlap < 3) return;
  const score = overlap / Math.max(name.length, chunk.length);
  if (score < 0.6) return;
  if (score < n.best || (Math.abs(score - n.best) < 0.0001 && overlap <= n.bestOverlap)) return;
  n.best = score;
  n.bestOverlap = overlap;
  n.item = item;
}

function nearestByName(words: string[], items: readonly SalesCatalogItem[], nameOf: (i: SalesCatalogItem) => string): SalesCatalogItem | null {
  const n: Nearest = { item: null, best: 0, bestOverlap: 0 };
  for (const item of items) {
    const name = nameOf(item);
    if (name.length < 3) continue;
    for (let i = 0; i < words.length; i++) {
      consider(item, name, letters(words[i]), n);
      if (i + 1 < words.length) consider(item, name, letters(words[i] + words[i + 1]), n);
    }
  }
  return n.item;
}

function longestToken(folded: string, items: readonly SalesCatalogItem[], codeOf: (i: SalesCatalogItem) => string): SalesCatalogItem | null {
  let found: SalesCatalogItem | null = null;
  let len = -1;
  for (const item of items) {
    const code = fold(codeOf(item));
    if (code.length < 2 || !containsToken(folded, code) || code.length <= len) continue;
    found = item;
    len = code.length;
  }
  return found;
}

/**
 * Exact when the live text contains a catalog code as its own token. Otherwise a similar-code token,
 * or the nearest name by shared letters. Null when nothing is close enough to show.
 */
export function match(transcript: string | null | undefined, items: readonly SalesCatalogItem[]): SalesHit | null {
  if (!transcript || !transcript.trim() || items.length === 0) return null;
  const folded = fold(transcript);
  const exact = longestToken(folded, items, (i) => i.Code);
  if (exact) return hitOf('Exact', exact);
  const similar = longestToken(folded, items, (i) => i.SimilarCode);
  if (similar) return hitOf('Similar', similar);
  const words = folded.split(' ').filter((w) => w.length > 0);
  // WPF takes Letters(item.Name) unfolded, so «Таптайн» never shared its capital Т with the lower-case
  // transcript. Folded here (like NameIsClose already did), so a capitalised name scores the same.
  const nearest = nearestByName(words, items, (i) => letters(fold(i.Name)));
  return nearest ? hitOf('Similar', nearest) : null;
}

export function withRag(hit: SalesHit, snippet: string | null | undefined): SalesHit {
  return { ...hit, ragSnippet: !snippet || !snippet.trim() ? '' : snippet.trim() };
}

/** True when the live text shares enough letters with a catalog name. Same bar as the nearest-name hit. */
export function nameIsClose(transcript: string | null | undefined, name: string | null | undefined): boolean {
  if (!transcript || !transcript.trim() || !name || !name.trim()) return false;
  const l = letters(fold(name));
  if (l.length < 3) return false;
  const words = fold(transcript).split(' ').filter((w) => w.length > 0);
  const dummy: SalesCatalogItem = { Code: '', Name: name, Line: '', SimilarCode: '' };
  return nearestByName(words, [dummy], () => l) !== null;
}

/** True when token is its own word in the transcript, after the same folding as code matching. */
export function hasToken(transcript: string | null | undefined, token: string | null | undefined): boolean {
  if (!transcript || !transcript.trim() || !token || !token.trim()) return false;
  const code = fold(token);
  return code.length >= 2 && containsToken(fold(transcript), code);
}
