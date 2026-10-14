// Snippets: user-saved text blocks (signature, requisites, canned replies) inserted by a voice
// trigger during dictation. «вставь подпись» (or «вставить …», «вставка …», «insert …») anywhere in
// the phrase, or the trigger said as the whole phrase, puts the saved text in its place.
// Stored locally in snippets.json next to settings.json (one file shared by the app and the CLI).
// Pure matching + small file helpers, no Electron imports, unit-tested.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Snippet {
  /** What you say after «вставь», e.g. «подпись». */
  trigger: string;
  /** What goes in (may be several lines). */
  text: string;
}

/** Words that announce a snippet. Matched case-insensitively, ё = е. */
export const INSERT_VERBS = ['вставь', 'вставьте', 'вставить', 'вставка', 'insert', 'paste'];

export const MAX_TRIGGER = 80;
export const MAX_TEXT = 20000;
export const MAX_SNIPPETS = 500;

/** Lowercase, ё→е, words only (punctuation dropped, spaces collapsed). */
export function normTrigger(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Cleans a list: trims, drops empty/duplicate triggers (last wins), caps sizes. */
export function cleanSnippets(list: readonly unknown[]): Snippet[] {
  const byKey = new Map<string, Snippet>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const trigger = typeof r.trigger === 'string' ? r.trigger.replace(/\s+/g, ' ').trim().slice(0, MAX_TRIGGER) : '';
    const text = typeof r.text === 'string' ? r.text.replace(/\r\n?/g, '\n').slice(0, MAX_TEXT) : '';
    const key = normTrigger(trigger);
    if (!key || !text.trim()) continue;
    byKey.delete(key);
    byKey.set(key, { trigger, text });
  }
  return [...byKey.values()].slice(0, MAX_SNIPPETS);
}

interface Word {
  w: string;
  start: number;
  end: number;
}

function words(text: string): Word[] {
  const out: Word[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ w: m[0].toLowerCase().replace(/ё/g, 'е'), start: m.index, end: m.index + m[0].length });
  return out;
}

export interface SnippetMatch {
  /** Text with every trigger replaced by its snippet. */
  text: string;
  /** Triggers that fired, in order. */
  used: string[];
}

/**
 * Replaces «вставь <trigger>» spans (and a phrase that is only the trigger) with the snippet text.
 * The longest trigger wins; a trailing «.»/«,» after the trigger goes with it. No match = text as is.
 */
export function applySnippets(text: string, snippets: readonly Snippet[], tokenFor?: (i: number) => string): SnippetMatch {
  const list = cleanSnippets(snippets)
    .map((s) => ({ s, toks: normTrigger(s.trigger).split(' ') }))
    .sort((a, b) => b.toks.length - a.toks.length);
  if (list.length === 0 || !text) return { text, used: [] };
  const ws = words(text);
  const verbs = new Set(INSERT_VERBS);
  const put = (s: Snippet, i: number) => (tokenFor ? tokenFor(i) : s.text);
  const at = (i: number, toks: string[]) => toks.every((t, k) => ws[i + k]?.w === t);

  // Whole phrase is just a trigger (optionally with the verb): the snippet replaces everything.
  for (const [idx, { s, toks }] of list.entries()) {
    const off = ws.length === toks.length + 1 && verbs.has(ws[0].w) ? 1 : 0;
    if (ws.length === toks.length + off && at(off, toks)) return { text: put(s, idx), used: [s.trigger] };
  }

  let out = '';
  let last = 0;
  const used: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    if (!verbs.has(ws[i].w)) continue;
    const hit = list.findIndex(({ toks }) => at(i + 1, toks));
    if (hit < 0) continue;
    const { s, toks } = list[hit];
    const endWord = ws[i + toks.length];
    let end = endWord.end;
    const tail = /^[.,;!?…]/.exec(text.slice(end));
    if (tail) end += tail[0].length;
    out += text.slice(last, ws[i].start) + put(s, hit);
    last = end;
    used.push(s.trigger);
    i += toks.length;
  }
  if (used.length === 0) return { text, used };
  out += text.slice(last);
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim(), used };
}

/** Private-use marker for a snippet while the rest of the phrase goes through Brain / simple syntax. */
export const snippetToken = (i: number) => `\uE100${String.fromCharCode(0xe200 + i)}\uE101`;

/** Puts snippet texts back where {@link snippetToken} markers are; a lost marker's text is appended. */
export function expandTokens(text: string, snippets: readonly Snippet[], used: readonly string[] = []): string {
  const usedKeys = new Set(used.map(normTrigger));
  const list = cleanSnippets(snippets)
    .map((s) => ({ s, n: normTrigger(s.trigger).split(' ').length }))
    .sort((a, b) => b.n - a.n)
    .map((x) => x.s);
  let out = text;
  const missing: string[] = [];
  list.forEach((s, i) => {
    const tok = snippetToken(i);
    if (!out.includes(tok)) {
      if (usedKeys.has(normTrigger(s.trigger))) missing.push(s.text);
      return;
    }
    out = out.split(tok).join(s.text);
  });
  // Any stray marker characters the Brain may have mangled.
  out = out.replace(/[\uE100\uE101\uE200-\uE3FF]/g, '');
  return missing.length ? `${out}\n${missing.join('\n')}` : out;
}

// ---- file ----

let cache: { path: string; mtime: number; size: number; list: Snippet[] } | null = null;

/** Reads snippets.json; a missing or broken file is an empty list. Cached by mtime. */
export function loadSnippets(path: string): Snippet[] {
  try {
    if (!existsSync(path)) return [];
    const st = statSync(path);
    if (cache && cache.path === path && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.list.map((s) => ({ ...s }));
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { snippets?: unknown }).snippets) ? (raw as { snippets: unknown[] }).snippets : [];
    const list = cleanSnippets(arr);
    cache = { path, mtime: st.mtimeMs, size: st.size, list };
    return list.map((s) => ({ ...s }));
  } catch {
    return [];
  }
}

/** Writes snippets.json atomically (temp file + rename). */
export function saveSnippets(path: string, list: readonly Snippet[]): Snippet[] {
  const clean = cleanSnippets(list);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, snippets: clean }, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  cache = null;
  return clean;
}

/** Adds or replaces (same trigger) one snippet. */
export function upsertSnippet(list: readonly Snippet[], s: Snippet): Snippet[] {
  const key = normTrigger(s.trigger);
  const at = list.findIndex((x) => normTrigger(x.trigger) === key);
  const next = [...list];
  if (at >= 0) next[at] = s;
  else next.push(s);
  return cleanSnippets(next);
}

/** Removes by trigger (case/ё/punctuation-insensitive). */
export function removeSnippet(list: readonly Snippet[], trigger: string): { list: Snippet[]; removed: boolean } {
  const key = normTrigger(trigger);
  const next = list.filter((x) => normTrigger(x.trigger) !== key);
  return { list: next, removed: next.length !== list.length };
}
