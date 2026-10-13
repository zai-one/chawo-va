// Dictation history: one JSON line per finished take in %LOCALAPPDATA%\ChawoVoiceAssistant\history.jsonl.
// Local only, never sent anywhere; no audio is kept. The user picks how long entries live
// (Settings.HistoryKeep: Off / a day / a week / a month / forever); "Off" also wipes the file.
// No Electron imports, so the store is unit-tested on a temp folder with an injected clock.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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

export class HistoryStore {
  private entries: HistoryEntry[] | null = null;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): HistoryEntry[] {
    if (this.entries) return this.entries;
    const list: HistoryEntry[] = [];
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        const e = parseLine(line);
        if (e) list.push(e);
      }
    }
    list.sort((a, b) => a.ts - b.ts);
    this.entries = list;
    return list;
  }

  private writeAll(list: HistoryEntry[]): void {
    if (list.length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, list.map((e) => JSON.stringify(e)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Appends a take unless history is off. Returns the stored entry or null. */
  add(e: NewEntry, keep: HistoryKeep): HistoryEntry | null {
    if (keep === 'Off') return null;
    const list = this.load();
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
    list.push(entry);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    this.prune(keep);
    return entry;
  }

  /** Drops entries older than the period and beyond MAX_ENTRIES; "Off" deletes the file. Returns how many went. */
  prune(keep: HistoryKeep): number {
    if (keep === 'Off') {
      const n = this.load().length;
      this.clear();
      return n;
    }
    const list = this.load();
    const cutoff = this.now() - keepMs(keep);
    let kept = list.filter((e) => e.ts >= cutoff);
    if (kept.length > MAX_ENTRIES) kept = kept.slice(kept.length - MAX_ENTRIES);
    const dropped = list.length - kept.length;
    if (dropped > 0) {
      this.entries = kept;
      this.writeAll(kept);
    }
    return dropped;
  }

  /** Newest first, filtered by the query. */
  list(query = '', limit = Number.POSITIVE_INFINITY): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    const list = this.load();
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
      if (matches(list[i]!, query)) out.push(list[i]!);
    }
    return out;
  }

  count(query = ''): number {
    if (!query.trim()) return this.load().length;
    return this.load().filter((e) => matches(e, query)).length;
  }

  get(id: string): HistoryEntry | null {
    return this.load().find((e) => e.id === id) ?? null;
  }

  /** New final text after «Мозг заново». */
  setFinal(id: string, final: string, brainFailed: boolean): HistoryEntry | null {
    const list = this.load();
    const e = list.find((x) => x.id === id);
    if (!e) return null;
    e.final = final.slice(0, MAX_TEXT);
    e.brain = true;
    e.brainFailed = brainFailed;
    this.writeAll(list);
    return e;
  }

  remove(id: string): boolean {
    const list = this.load();
    const kept = list.filter((e) => e.id !== id);
    if (kept.length === list.length) return false;
    this.entries = kept;
    this.writeAll(kept);
    return true;
  }

  clear(): void {
    this.entries = [];
    rmSync(this.path, { force: true });
    rmSync(this.path + '.tmp', { force: true });
  }
}
