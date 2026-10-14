// Local calendar: parse a user-chosen .ics file or a folder of .ics (no cloud APIs). Pure logic,
// unit-tested. An event "looks like a meeting" when it is in progress or starts within leadMs.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CalendarEvent {
  summary: string;
  /** Epoch ms (Z → UTC; TZID → that zone; floating → local time). */
  startMs: number;
  endMs: number;
  /** Source .ics path (for debugging / CLI). */
  file?: string;
}

export interface CalendarHit {
  summary: string;
  startMs: number;
  endMs: number;
  /** 'now' = in progress; 'soon' = starts within the lead window. */
  kind: 'now' | 'soon';
  file?: string;
}

/** Default: suggest when the event starts within 5 minutes or is already running. */
export const DEFAULT_LEAD_MS = 5 * 60_000;

/** Unfold ICS lines (RFC 5545 §3.1): a line starting with space/tab continues the previous. */
export function unfoldIcs(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/** Unescape common ICS text escapes. */
export function unescapeIcsText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

const WINDOWS_TZ: Record<string, string> = {
  'russian standard time': 'Europe/Moscow',
  'russia time zone 3': 'Europe/Samara',
  'ekaterinburg standard time': 'Asia/Yekaterinburg',
  'n. central asia standard time': 'Asia/Novosibirsk',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
};

/**
 * TZID value → IANA zone usable by Intl, or null (then the time is treated as local).
 * Accepts IANA ids, quoted ids, prefixed ids (`/mozilla.org/…/Europe/Moscow`) and common Windows names.
 */
export function resolveTzid(tzid: string | undefined): string | null {
  if (!tzid) return null;
  let t = tzid.trim().replace(/^"|"$/g, '');
  const win = WINDOWS_TZ[t.toLowerCase()];
  if (win) t = win;
  const candidates = [t, ...(/([A-Za-z_]+\/[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)?)$/.exec(t)?.slice(1) ?? [])];
  for (const c of candidates) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: c });
      return c;
    } catch { /* not a zone */ }
  }
  return null;
}

/** Offset of `zone` from UTC at instant `ms`, in ms (Moscow → +3h). */
function zoneOffset(zone: string, ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second')) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in an IANA zone → epoch ms (two passes settle DST edges). */
function zonedToUtc(zone: string, Y: number, Mo: number, D: number, h: number, mi: number, s: number): number {
  const wall = Date.UTC(Y, Mo, D, h, mi, s);
  let t = wall - zoneOffset(zone, wall);
  t = wall - zoneOffset(zone, t);
  return t;
}

/**
 * Parse an ICS date-time: YYYYMMDD, YYYYMMDDTHHMMSS, YYYYMMDDTHHMMSSZ.
 * Z → UTC. With a TZID parameter the wall time is in that zone (IANA or a common Windows name).
 * Floating (no Z, no known TZID) is local time of the machine.
 */
export function parseIcsDateTime(raw: string, tzid?: string): number | null {
  const v = raw.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(v);
  if (!m) return null;
  const Y = Number(m[1]);
  const Mo = Number(m[2]) - 1;
  const D = Number(m[3]);
  if (m[4] == null) {
    // All-day: local midnight; DTEND exclusive is handled by the caller / end logic.
    return new Date(Y, Mo, D, 0, 0, 0, 0).getTime();
  }
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  if (m[7]) return Date.UTC(Y, Mo, D, h, mi, s);
  const zone = resolveTzid(tzid);
  if (zone) return zonedToUtc(zone, Y, Mo, D, h, mi, s);
  return new Date(Y, Mo, D, h, mi, s, 0).getTime();
}

/** Parse PTnHnMnS / PnD roughly → ms. */
export function parseIcsDuration(raw: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(raw.trim());
  if (!m) return null;
  const days = Number(m[1] || 0);
  const h = Number(m[2] || 0);
  const mi = Number(m[3] || 0);
  const s = Number(m[4] || 0);
  const ms = ((days * 24 + h) * 60 + mi) * 60_000 + s * 1000;
  return ms > 0 ? ms : null;
}

function propValue(line: string): { name: string; value: string; tzid?: string } | null {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const left = line.slice(0, i);
  const value = line.slice(i + 1);
  const name = (left.split(';')[0] ?? '').toUpperCase();
  if (!name) return null;
  const tz = /;TZID=("[^"]*"|[^;:]*)/i.exec(left)?.[1];
  return { name, value, ...(tz ? { tzid: tz.replace(/^"|"$/g, '') } : {}) };
}

/** Extract VEVENT blocks from one .ics body. */
export function parseIcsEvents(text: string, file?: string): CalendarEvent[] {
  const lines = unfoldIcs(text).split(/\n/);
  const events: CalendarEvent[] = [];
  let inEvent = false;
  let summary = '';
  let startRaw = '';
  let endRaw = '';
  let durationRaw = '';
  let startAllDay = false;
  let startTz: string | undefined;
  let endTz: string | undefined;
  const flush = () => {
    if (!startRaw) return;
    const startMs = parseIcsDateTime(startRaw, startTz);
    if (startMs == null || !Number.isFinite(startMs)) return;
    let endMs: number;
    if (endRaw) {
      const e = parseIcsDateTime(endRaw, endTz ?? startTz);
      endMs = e != null && Number.isFinite(e) ? e : startMs + 60 * 60_000;
    } else if (durationRaw) {
      const d = parseIcsDuration(durationRaw);
      endMs = startMs + (d ?? 60 * 60_000);
    } else if (startAllDay) {
      endMs = startMs + 24 * 60 * 60_000;
    } else {
      endMs = startMs + 60 * 60_000;
    }
    if (endMs < startMs) endMs = startMs + 60 * 60_000;
    events.push({ summary: summary.trim() || 'Meeting', startMs, endMs, file });
  };
  for (const line of lines) {
    const u = line.toUpperCase();
    if (u === 'BEGIN:VEVENT') {
      inEvent = true;
      summary = '';
      startRaw = '';
      endRaw = '';
      durationRaw = '';
      startAllDay = false;
      startTz = undefined;
      endTz = undefined;
      continue;
    }
    if (u === 'END:VEVENT') {
      if (inEvent) flush();
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const p = propValue(line);
    if (!p) continue;
    if (p.name === 'SUMMARY') summary = unescapeIcsText(p.value);
    else if (p.name === 'DTSTART') {
      startRaw = p.value.trim();
      startTz = p.tzid;
      startAllDay = !startRaw.includes('T');
    } else if (p.name === 'DTEND') {
      endRaw = p.value.trim();
      endTz = p.tzid;
    }
    else if (p.name === 'DURATION') durationRaw = p.value.trim();
  }
  return events;
}

/** Which events are in progress or about to start. */
export function activeCalendarHits(
  events: readonly CalendarEvent[],
  nowMs: number,
  leadMs = DEFAULT_LEAD_MS,
): CalendarHit[] {
  const out: CalendarHit[] = [];
  for (const e of events) {
    if (nowMs >= e.startMs && nowMs < e.endMs) {
      out.push({ summary: e.summary, startMs: e.startMs, endMs: e.endMs, kind: 'now', file: e.file });
    } else if (e.startMs > nowMs && e.startMs <= nowMs + leadMs) {
      out.push({ summary: e.summary, startMs: e.startMs, endMs: e.endMs, kind: 'soon', file: e.file });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

export interface LoadCalendarDeps {
  readFile?: (path: string) => string;
  readDir?: (path: string) => string[];
  isDir?: (path: string) => boolean;
  exists?: (path: string) => boolean;
}

function defaultExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Load events from a .ics file or every *.ics in a folder (non-recursive). */
export function loadCalendarEvents(path: string, deps: LoadCalendarDeps = {}): CalendarEvent[] {
  const p = path.trim();
  if (!p) return [];
  const exists = deps.exists ?? defaultExists;
  const readFile = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
  const readDir = deps.readDir ?? ((d: string) => readdirSync(d));
  const isDir =
    deps.isDir ??
    ((d: string) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
  if (!exists(p)) return [];
  const files: string[] = [];
  if (isDir(p)) {
    for (const name of readDir(p)) {
      if (name.toLowerCase().endsWith('.ics')) files.push(join(p, name));
    }
  } else if (p.toLowerCase().endsWith('.ics')) {
    files.push(p);
  } else {
    return [];
  }
  const events: CalendarEvent[] = [];
  for (const f of files) {
    try {
      events.push(...parseIcsEvents(readFile(f), f));
    } catch {
      /* unreadable file: skip */
    }
  }
  return events;
}

/** Hits for a calendar path at `nowMs`. */
export function detectCalendar(
  path: string,
  nowMs: number,
  leadMs = DEFAULT_LEAD_MS,
  deps: LoadCalendarDeps = {},
): CalendarHit[] {
  return activeCalendarHits(loadCalendarEvents(path, deps), nowMs, leadMs);
}
