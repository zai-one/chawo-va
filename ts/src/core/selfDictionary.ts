// «Словарь из исправлений»: when the user fixes a recognized text (history «Исправить», or
// `chawo-va dictionary learn before after`), the changed words are counted here. A pair seen
// SUGGEST_AT times becomes a suggestion for «Словарь»; with «Добавлять сами» it goes in by itself.
// Local only: learned-words.json beside settings.json, nothing is sent anywhere.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReplacePair } from './wordReplace';

/** Times the same fix must be seen before it is suggested (or auto-added). */
export const SUGGEST_AT = 2;
/** Longest fix taken, in words on each side. */
export const MAX_SPAN = 3;
/** Pairs kept; the oldest rare ones go first. */
export const MAX_PAIRS = 500;
const MAX_TOKENS = 3000;

export interface LearnedPair {
  from: string;
  to: string;
  count: number;
  /** Unix ms of the last time it was seen. */
  last: number;
  /** «Скрыть»: never suggested again (still counted, so it does not come back). */
  dismissed?: boolean;
}

export interface LearnedData {
  /** «Добавлять в словарь сами» (off by default). */
  autoAdd: boolean;
  pairs: LearnedPair[];
  /**
   * Rules added from the command line (`dictionary accept`, `learn` with autoAdd). The CLI never
   * rewrites settings.json, so the app moves these into «Словарь» the next time it looks.
   */
  pending?: ReplacePair[];
}

interface Tok { word: string; start: number; end: number }

const TOKEN_RE = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ word: m[0], start: m.index!, end: m.index! + m[0].length });
  return out;
}

export const foldWord = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Case-only change that is just a capital first letter (sentence start), not a brand like CPU. */
function trivialCase(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.toLowerCase() !== b.toLowerCase()) return false;
  return !/\p{Lu}/u.test(b.slice(1));
}

/**
 * The word fixes between two versions of a text: spans of 1..MAX_SPAN words replaced by 1..MAX_SPAN
 * words. Insertions and deletions are not fixes. A rewrite (more than two thirds of the words, and more than MAX_SPAN, changed) and
 * pure numbers give nothing.
 */
export function wordCorrections(before: string, after: string): ReplacePair[] {
  const a = tokens(before ?? '');
  const b = tokens(after ?? '');
  if (a.length === 0 || b.length === 0 || a.length > MAX_TOKENS || b.length > MAX_TOKENS) return [];
  const n = a.length;
  const m = b.length;
  // LCS on exact words (case matters, so «чаво» → «Чаво» stays visible as a change).
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i]!.word === b[j]!.word ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const same = dp[0]![0]!;
  const changed = n - same;
  if (changed > MAX_SPAN && changed * 3 > n * 2) return [];
  const out: ReplacePair[] = [];
  let i = 0;
  let j = 0;
  const flush = (i0: number, i1: number, j0: number, j1: number) => {
    const la = i1 - i0;
    const lb = j1 - j0;
    if (la < 1 || lb < 1 || la > MAX_SPAN || lb > MAX_SPAN) return;
    const from = a.slice(i0, i1).map((x) => x.word).join(' ');
    const to = after.slice(b[j0]!.start, b[j1 - 1]!.end).replace(/\s+/g, ' ').trim();
    if (trivialCase(from, to)) return;
    if (/^[\p{N}\s]+$/u.test(from) && /^[\p{N}\s.,]+$/u.test(to)) return;
    if (!out.some((p) => p.from === from && p.to === to)) out.push({ from, to });
  };
  let si = 0;
  let sj = 0;
  while (i < n && j < m) {
    if (a[i]!.word === b[j]!.word) {
      flush(si, i, sj, j);
      i++;
      j++;
      si = i;
      sj = j;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  flush(si, n, sj, m);
  return out;
}

export function emptyLearned(): LearnedData {
  return { autoAdd: false, pairs: [] };
}

export function loadLearned(path: string): LearnedData {
  try {
    if (!existsSync(path)) return emptyLearned();
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LearnedData>;
    const pairs = Array.isArray(raw.pairs)
      ? raw.pairs.filter((p): p is LearnedPair => !!p && typeof p.from === 'string' && typeof p.to === 'string' && p.from.trim() !== '' && p.to.trim() !== '' && !/[\r\n]/.test(p.from + p.to))
        .map((p) => ({ from: p.from, to: p.to, count: Math.max(1, Math.floor(Number(p.count) || 1)), last: Number(p.last) || 0, ...(p.dismissed ? { dismissed: true } : {}) }))
      : [];
    const pending = Array.isArray(raw.pending)
      ? raw.pending.filter((p): p is ReplacePair => !!p && typeof p.from === 'string' && typeof p.to === 'string' && p.from.trim() !== '' && p.to.trim() !== '' && !/[\r\n]/.test(p.from + p.to))
        .map((p) => ({ from: p.from.trim(), to: p.to.trim() }))
      : [];
    return { autoAdd: raw.autoAdd === true, pairs, ...(pending.length ? { pending } : {}) };
  } catch {
    return emptyLearned();
  }
}

export function saveLearned(path: string, d: LearnedData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

const key = (from: string, to: string) => `${foldWord(from)}\u0000${to}`;

/** Rules already cover this heard form (whole-word match ignores case). */
export function covered(rules: readonly ReplacePair[], from: string): boolean {
  const f = foldWord(from.trim());
  return rules.some((r) => r.from.trim() && foldWord(r.from.trim()) === f);
}

/** Counts the fixes. `ready` = pairs that just reached SUGGEST_AT and are not hidden. */
export function learn(d: LearnedData, fixes: readonly ReplacePair[], now: number): { data: LearnedData; ready: LearnedPair[] } {
  const pairs = d.pairs.map((p) => ({ ...p }));
  const ready: LearnedPair[] = [];
  for (const f of fixes) {
    const k = key(f.from, f.to);
    let p = pairs.find((x) => key(x.from, x.to) === k);
    if (!p) {
      p = { from: f.from, to: f.to, count: 0, last: now };
      pairs.push(p);
    }
    p.count++;
    p.last = now;
    if (p.count === SUGGEST_AT && !p.dismissed) ready.push({ ...p });
  }
  if (pairs.length > MAX_PAIRS) {
    pairs.sort((x, y) => y.count - x.count || y.last - x.last);
    pairs.length = MAX_PAIRS;
  }
  return { data: { ...d, pairs }, ready };
}

/** What «Словарь» offers: seen often enough, not hidden, not in the rules yet. Most seen first. */
export function suggestions(d: LearnedData, rules: readonly ReplacePair[]): LearnedPair[] {
  return d.pairs
    .filter((p) => p.count >= SUGGEST_AT && !p.dismissed && !covered(rules, p.from))
    .sort((x, y) => y.count - x.count || y.last - x.last)
    .map((p) => ({ ...p }));
}

/** Finds a suggestion by its heard form (and written form when given). */
export function findPair(d: LearnedData, from: string, to?: string): LearnedPair | null {
  const f = foldWord(from.trim());
  const hits = d.pairs.filter((p) => foldWord(p.from) === f && (to === undefined || p.to === to.trim()));
  if (hits.length === 0) return null;
  return [...hits].sort((x, y) => y.count - x.count)[0]!;
}

/** After «В словарь»: the heard form leaves the learned list (the rule is the record now). */
export function forget(d: LearnedData, from: string): LearnedData {
  const f = foldWord(from.trim());
  return { ...d, pairs: d.pairs.filter((p) => foldWord(p.from) !== f) };
}

export function dismiss(d: LearnedData, from: string, to: string): LearnedData {
  const k = key(from, to);
  return { ...d, pairs: d.pairs.map((p) => (key(p.from, p.to) === k ? { ...p, dismissed: true } : p)) };
}

/** Rules with one more row; an existing row for the same heard form is replaced. */
export function withRule(rules: readonly ReplacePair[], from: string, to: string): ReplacePair[] {
  const f = foldWord(from.trim());
  const kept = rules.filter((r) => foldWord(r.from.trim()) !== f);
  return [...kept, { from: from.trim(), to: to.trim() }];
}

/**
 * One fixed text end to end: count the fixes; with autoAdd, pairs that just became ready are added
 * to the rules. Returns the new data, the new rules (null = unchanged), the fixes and what was added.
 */
export function learnEdit(d: LearnedData, rules: readonly ReplacePair[], before: string, after: string, now: number): {
  data: LearnedData;
  rules: ReplacePair[] | null;
  fixes: ReplacePair[];
  added: ReplacePair[];
  suggested: ReplacePair[];
} {
  const fixes = wordCorrections(before, after);
  if (fixes.length === 0) return { data: d, rules: null, fixes, added: [], suggested: [] };
  let { data, ready } = learn(d, fixes, now);
  ready = ready.filter((p) => !covered(rules, p.from));
  if (!data.autoAdd || ready.length === 0) return { data, rules: null, fixes, added: [], suggested: ready.map(({ from, to }) => ({ from, to })) };
  let next = [...rules];
  for (const p of ready) {
    next = withRule(next, p.from, p.to);
    data = forget(data, p.from);
  }
  return { data, rules: next, fixes, added: ready.map(({ from, to }) => ({ from, to })), suggested: [] };
}

/** Rules as the app will have them: the stored ones plus the CLI's pending rows. */
export function withPending(rules: readonly ReplacePair[], d: LearnedData): ReplacePair[] {
  let out = [...rules];
  for (const p of d.pending ?? []) out = withRule(out, p.from, p.to);
  return out;
}

/** Queues a CLI rule for the app (a newer row for the same heard form wins). */
export function addPending(d: LearnedData, from: string, to: string): LearnedData {
  return { ...d, pending: withRule(d.pending ?? [], from, to) };
}
