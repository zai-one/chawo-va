// Where «Спросить историю» looks: dictation phrases (history.jsonl, within «Хранить»), the meetings
// folder and any folders the user added (Settings.AskFolders, one per line). Only .txt / .md
// transcripts are read; nothing is written or sent. No Electron imports: the GUI passes the
// meetings folder in, the CLI computes it the same way (documents/Chawo VA/Встречи|Meetings).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { AskSource } from '@chawo/core/askHistory';
import type { HistoryEntry } from './historyStore';

export const MAX_FILES = 400;
export const MAX_FILE_BYTES = 2_000_000;
export const MAX_DEPTH = 4;
export const MAX_FOLDERS = 20;

const pad = (n: number) => String(n).padStart(2, '0');

/** Dictation phrases grouped by local day: one source per day, «[14:05] текст» per line. */
export function dictationSources(entries: readonly HistoryEntry[], tr: (ru: string, en: string) => string): AskSource[] {
  const days = new Map<string, HistoryEntry[]>();
  for (const e of [...entries].sort((a, b) => a.ts - b.ts)) {
    if (!e.final.trim()) continue;
    const d = new Date(e.ts);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const list = days.get(key) ?? [];
    list.push(e);
    days.set(key, list);
  }
  const out: AskSource[] = [];
  for (const [key, list] of days) {
    const d = new Date(list[0].ts);
    out.push({
      id: `dictation:${key}`,
      kind: 'dictation',
      title: tr(`Диктовка ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`, `Dictation ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`),
      when: list[list.length - 1].ts,
      path: null,
      text: list.map((e) => {
        const t = new Date(e.ts);
        return `[${pad(t.getHours())}:${pad(t.getMinutes())}] ${e.final.replace(/\s*\n\s*/g, ' ').trim()}`;
      }).join('\n'),
    });
  }
  return out;
}

/** Settings.AskFolders → unique non-empty lines (at most MAX_FOLDERS). */
export function parseFolders(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const v = raw.trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_FOLDERS) break;
  }
  return out;
}

const TEXT_EXT = new Set(['.txt', '.md']);

/** A transcript file worth reading: .txt / .md, not a translation, not a .brain.txt next to its source. */
export function isTranscriptFile(path: string, siblings: ReadonlySet<string>): boolean {
  const name = basename(path).toLowerCase();
  if (!TEXT_EXT.has(extname(name))) return false;
  if (name.endsWith('.translate.txt')) return false;
  if (name.endsWith('.brain.txt') && siblings.has(name.slice(0, -'.brain.txt'.length) + '.txt')) return false;
  return true;
}

/** Transcript files under the given folders (or the files themselves), newest first, deduped, at most `max`. */
export function transcriptFiles(inputs: readonly string[], max = MAX_FILES): string[] {
  const found = new Map<string, number>();
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase()));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p, depth + 1);
      } else if (e.isFile() && isTranscriptFile(p, names)) {
        add(p);
      }
    }
  };
  const add = (p: string) => {
    const full = resolve(p);
    if (found.has(full)) return;
    try {
      const st = statSync(full);
      if (st.size > 0 && st.size <= MAX_FILE_BYTES) found.set(full, st.mtimeMs);
    } catch {
      /* gone */
    }
  };
  for (const input of inputs) {
    let st;
    try {
      st = statSync(input);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(input, 0);
    else if (st.isFile()) add(input);
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([p]) => p);
}

/** Reads transcripts as sources (BOM dropped, unreadable files skipped). */
export function transcriptSources(files: readonly string[]): AskSource[] {
  const out: AskSource[] = [];
  for (const path of files) {
    try {
      let text = readFileSync(path, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text.trim()) continue;
      out.push({ id: path, kind: 'transcript', title: basename(path), when: statSync(path).mtimeMs, path, text });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * XDG_DOCUMENTS_DIR on Linux (like downloadsFolder), else <home>/Documents. Electron's
 * app.getPath('documents') is used by the app itself; this is the CLI's best equal.
 */
export function documentsFolder(platform: string, home: string, userDirs: string | null): string {
  if (platform === 'linux' && userDirs) {
    for (const raw of userDirs.split('\n')) {
      const m = /^\s*XDG_DOCUMENTS_DIR\s*=\s*"([^"]*)"\s*$/.exec(raw);
      if (!m) continue;
      const v = m[1].replace(/^\$HOME(?=\/|$)/, home);
      if (v.startsWith('/') && v.replace(/\/+$/, '') !== home.replace(/\/+$/, '')) return v.replace(/\/+$/, '');
    }
  }
  return join(home, 'Documents');
}

/** The meetings folder in both UI languages (the app names it by the language at the time). */
export function meetingFolders(documents: string, override?: string): string[] {
  if (override) return [override];
  return [join(documents, 'Chawo VA', 'Встречи'), join(documents, 'Chawo VA', 'Meetings')].filter((p) => existsSync(p));
}

export interface AskScope {
  /** Dictation phrases within «Хранить» (empty when history is off or not wanted). */
  history: readonly HistoryEntry[];
  /** Folders and / or files with transcripts. */
  inputs: readonly string[];
}

export function loadSources(scope: AskScope, tr: (ru: string, en: string) => string): AskSource[] {
  return [...dictationSources(scope.history, tr), ...transcriptSources(transcriptFiles(scope.inputs))];
}
