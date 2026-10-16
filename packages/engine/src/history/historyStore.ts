// Dictation history: one row per finished take in chawo.db (table history), in the local data folder.
// Local only, never sent anywhere; no audio is kept. The user picks how long entries live
// (Settings.HistoryKeep: Off / a day / a week / a month / forever); "Off" also deletes them all.
// A history.jsonl of an older version beside the database is imported once and kept as .bak.
// No Electron imports, so the store is unit-tested on a temp folder with an injected clock.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { database, flushDeleted, retireLegacyFile, transaction } from '../storage/database';

export type HistoryKeep = 'Off' | 'Day' | 'Week' | 'Month' | 'Forever';
export const HISTORY_KEEPS: readonly HistoryKeep[] = ['Off', 'Day', 'Week', 'Month', 'Forever'];

/** Upper bound on entries whatever the period, so the file never grows without limit. */
export const MAX_ENTRIES = 2000;
/** One phrase longer than this is cut (a take is at most 5 minutes; this is far above it). */
export const MAX_TEXT = 20000;

const DAY = 24 * 60 * 60 * 1000;

export function keepMs(k: HistoryKeep): number {
  switch (k) {
    case 'Off': return 0;
    case 'Day': return DAY;
    case 'Week': return 7 * DAY;
    case 'Month': return 30 * DAY;
    default: return Number.POSITIVE_INFINITY;
  }
}

export interface HistoryEntry {
  id: string;
  /** Unix ms when the take finished. */
  ts: number;
  /** Recognized text after the dictionary, before the Brain (with a «Чаво, …» command if said). */
  raw: string;
  /** What went to the clipboard / the app. */
  final: string;
  /** The «Чаво, …» command, or null for plain dictation. */
  command: string | null;
  /** The Brain ran on this take (command or every take). */
  brain: boolean;
  /** The Brain was asked but failed, so `final` is the text as recognized. */
  brainFailed: boolean;
  /** Take length in seconds (one decimal). */
  seconds: number;
}

export type NewEntry = Omit<HistoryEntry, 'id' | 'ts'> & { ts?: number };

/** Lowercase and ё→е, so «ещё» finds «еще» and the other way round. */
export function fold(s: string): string {
  return s.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

/** Every word of the query must occur in the phrase (raw, final or command). Empty query matches all. */
export function matches(e: HistoryEntry, query: string): boolean {
  const words = fold(query).split(/\s+/u).filter((w) => w.length > 0);
  if (words.length === 0) return true;
  const hay = fold(`${e.final}\n${e.raw}\n${e.command ?? ''}`);
  return words.every((w) => hay.includes(w));
}

function parseLine(line: string): HistoryEntry | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return null;
    if (typeof o.raw !== 'string' || typeof o.final !== 'string') return null;
    return {
      id: o.id,
      ts: o.ts,
      raw: o.raw,
      final: o.final,
      command: typeof o.command === 'string' ? o.command : null,
      brain: o.brain === true,
      brainFailed: o.brainFailed === true,
      seconds: typeof o.seconds === 'number' && Number.isFinite(o.seconds) ? o.seconds : 0,
    };
  } catch {
    return null; // a half-written last line after a crash: skip it
  }
}

interface Row {
  id: string;
  ts: number;
  raw: string;
  final: string;
  command: string | null;
  brain: number;
  brain_failed: number;
  seconds: number;
}

const toEntry = (r: Row): HistoryEntry => ({
  id: r.id,
  ts: r.ts,
  raw: r.raw,
  final: r.final,
  command: r.command,
  brain: r.brain === 1,
  brainFailed: r.brain_failed === 1,
  seconds: r.seconds,
});

const imported = new Set<string>();

export class HistoryStore {
  /** @param path chawo.db (the database of the local data folder) */
  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  private db(): DatabaseSync {
    const db = database(this.path);
    if (!imported.has(this.path)) {
      imported.add(this.path);
      importJsonl(db, join(dirname(this.path), 'history.jsonl'));
    }
    return db;
  }

  private insert(db: DatabaseSync, e: HistoryEntry): void {
    db.prepare('INSERT OR REPLACE INTO history (id, ts, raw, final, command, brain, brain_failed, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.ts, e.raw, e.final, e.command, e.brain ? 1 : 0, e.brainFailed ? 1 : 0, e.seconds);
  }

  /** Oldest first. */
  private all(): HistoryEntry[] {
    return (this.db().prepare('SELECT * FROM history ORDER BY ts, rowid').all() as unknown as Row[]).map(toEntry);
  }

  /** Appends a take unless history is off. Returns the stored entry or null. */
  add(e: NewEntry, keep: HistoryKeep): HistoryEntry | null {
    if (keep === 'Off') return null;
    const entry: HistoryEntry = {
      id: randomUUID(),
      ts: e.ts ?? this.now(),
      raw: e.raw.slice(0, MAX_TEXT),
      final: e.final.slice(0, MAX_TEXT),
      command: e.command,
      brain: e.brain,
      brainFailed: e.brainFailed,
      seconds: Math.round(e.seconds * 10) / 10,
    };
    this.insert(this.db(), entry);
    this.prune(keep);
    return entry;
  }

  /** Drops entries older than the period and beyond MAX_ENTRIES; "Off" deletes them all. Returns how many went. */
  prune(keep: HistoryKeep): number {
    const db = this.db();
    if (keep === 'Off') {
      const n = Number(db.prepare('DELETE FROM history').run().changes);
      flushDeleted(db);
      return n;
    }
    return transaction(db, () => {
      let n = 0;
      const ms = keepMs(keep);
      if (Number.isFinite(ms)) n += Number(db.prepare('DELETE FROM history WHERE ts < ?').run(this.now() - ms).changes);
      n += Number(db.prepare('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY ts DESC, rowid DESC LIMIT ?)').run(MAX_ENTRIES).changes);
      return n;
    });
  }

  /** Newest first, filtered by the query. */
  list(query = '', limit = Number.POSITIVE_INFINITY): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    const list = this.all();
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
      if (matches(list[i], query)) out.push(list[i]);
    }
    return out;
  }

  count(query = ''): number {
    if (!query.trim()) return Number((this.db().prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number }).n);
    return this.all().filter((e) => matches(e, query)).length;
  }

  get(id: string): HistoryEntry | null {
    const r = this.db().prepare('SELECT * FROM history WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toEntry(r) : null;
  }

  /** New final text after «Мозг заново». */
  setFinal(id: string, final: string, brainFailed: boolean): HistoryEntry | null {
    const db = this.db();
    db.prepare('UPDATE history SET final = ?, brain = 1, brain_failed = ? WHERE id = ?').run(final.slice(0, MAX_TEXT), brainFailed ? 1 : 0, id);
    return this.get(id);
  }

  /** «Исправить»: the user's own text replaces `final` (the Brain flags stay as they were). */
  setText(id: string, final: string): HistoryEntry | null {
    this.db().prepare('UPDATE history SET final = ? WHERE id = ?').run(final.slice(0, MAX_TEXT), id);
    return this.get(id);
  }

  remove(id: string): boolean {
    const db = this.db();
    const gone = Number(db.prepare('DELETE FROM history WHERE id = ?').run(id).changes) > 0;
    if (gone) flushDeleted(db);
    return gone;
  }

  clear(): void {
    const db = this.db();
    db.prepare('DELETE FROM history').run();
    flushDeleted(db);
  }
}

/** history.jsonl of an older version: its lines go into the table once, the file becomes .bak. */
function importJsonl(db: DatabaseSync, legacy: string): void {
  if (!existsSync(legacy) || legacy === db.location()) return;
  const rows = readFileSync(legacy, 'utf8').split('\n').map(parseLine).filter((e): e is HistoryEntry => e !== null);
  transaction(db, () => {
    const ins = db.prepare('INSERT OR IGNORE INTO history (id, ts, raw, final, command, brain, brain_failed, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of rows) ins.run(e.id, e.ts, e.raw, e.final, e.command, e.brain ? 1 : 0, e.brainFailed ? 1 : 0, e.seconds);
  });
  retireLegacyFile(legacy);
}
