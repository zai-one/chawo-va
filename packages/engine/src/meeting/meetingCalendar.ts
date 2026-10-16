// Local calendar: parse a user-chosen .ics file or a folder of .ics (no cloud APIs). Pure logic,
// unit-tested. An event "looks like a meeting" when it is in progress or starts within leadMs.
// Recurring VEVENTs (RRULE) are expanded only around "now" for detection; cloud calendars are never fetched.

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

const DAY_MS = 24 * 60 * 60_000;

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
  const candidates = [t, ...(/([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(t)?.slice(1) ?? [])];
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

const BYDAY_TO_JS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface ParsedRrule {
  freq: Freq;
  interval: number;
  count?: number;
  untilMs?: number;
  /** JS getDay() values (0=Sun…6=Sat). Empty = no BYDAY filter. */
  byDay: number[];
}

/** Parse RRULE enough for Outlook/Google exports. Malformed → null (caller skips the event). */
export function parseRrule(raw: string): ParsedRrule | null {
  const parts = raw.trim().split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let freq: Freq | undefined;
  let interval = 1;
  let count: number | undefined;
  let untilMs: number | undefined;
  const byDay: number[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1).trim();
    if (!val) return null;
    if (key === 'FREQ') {
      const f = val.toUpperCase();
      if (f !== 'DAILY' && f !== 'WEEKLY' && f !== 'MONTHLY') return null;
      freq = f;
    } else if (key === 'INTERVAL') {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) return null;
      interval = n;
    } else if (key === 'COUNT') {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) return null;
      count = n;
    } else if (key === 'UNTIL') {
      const u = parseIcsDateTime(val);
      if (u == null || !Number.isFinite(u)) return null;
      untilMs = u;
    } else if (key === 'BYDAY') {
      for (const tok of val.split(',')) {
        const t = tok.trim().toUpperCase();
        // Plain MO..SU; strip ordinal prefix like 1MO / -1FR (treat as that weekday).
        const plain = /^-?\d*([A-Z]{2})$/.exec(t)?.[1] ?? t;
        const d = BYDAY_TO_JS[plain];
        if (d == null) return null;
        if (!byDay.includes(d)) byDay.push(d);
      }
    }
    // Other parts (WKST, BYMONTH, …): ignore for the detection window.
  }
  if (!freq) return null;
  return { freq, interval, count, untilMs, byDay };
}

/** Zone for weekday / wall-clock stepping: IANA/UTC, or null = floating local. */
function occurrenceZone(dtRaw: string, tzid?: string): string | null {
  if (/Z$/i.test(dtRaw.trim())) return 'UTC';
  return resolveTzid(tzid);
}

interface WallParts {
  Y: number;
  Mo: number;
  D: number;
  h: number;
  mi: number;
  s: number;
}

function wallPartsAt(ms: number, zone: string | null): WallParts {
  if (!zone) {
    const d = new Date(ms);
    return { Y: d.getFullYear(), Mo: d.getMonth(), D: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { Y: n('year'), Mo: n('month') - 1, D: n('day'), h: n('hour') % 24, mi: n('minute'), s: n('second') };
}

function wallToMs(w: WallParts, zone: string | null): number {
  if (!zone) return new Date(w.Y, w.Mo, w.D, w.h, w.mi, w.s, 0).getTime();
  return zonedToUtc(zone, w.Y, w.Mo, w.D, w.h, w.mi, w.s);
}

function weekdayAt(ms: number, zone: string | null): number {
  if (!zone) return new Date(ms).getDay();
  const short = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(new Date(ms));
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[short] ?? 0;
}

function addWallDays(ms: number, days: number, zone: string | null): number {
  const w = wallPartsAt(ms, zone);
  const utcNoon = Date.UTC(w.Y, w.Mo, w.D + days, 12, 0, 0);
  const d = new Date(utcNoon);
  return wallToMs({ Y: d.getUTCFullYear(), Mo: d.getUTCMonth(), D: d.getUTCDate(), h: w.h, mi: w.mi, s: w.s }, zone);
}

function addWallMonths(ms: number, months: number, zone: string | null): number {
  const w = wallPartsAt(ms, zone);
  const anchor = new Date(Date.UTC(w.Y, w.Mo + months, 1, 12, 0, 0));
  const dim = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  const D = Math.min(w.D, dim);
  return wallToMs({ Y: anchor.getUTCFullYear(), Mo: anchor.getUTCMonth(), D, h: w.h, mi: w.mi, s: w.s }, zone);
}

function ymdKey(ms: number, zone: string | null): string {
  const w = wallPartsAt(ms, zone);
  return `${w.Y}-${w.Mo + 1}-${w.D}`;
}

interface ExdateEntry {
  ms: number;
  allDay: boolean;
  zone: string | null;
}

function isExcluded(occMs: number, occZone: string | null, exdates: readonly ExdateEntry[]): boolean {
  for (const ex of exdates) {
    if (ex.allDay) {
      if (ymdKey(occMs, occZone) === ymdKey(ex.ms, ex.zone ?? occZone)) return true;
    } else if (ex.ms === occMs) {
      return true;
    }
  }
  return false;
}

function sameWallClock(ms: number, template: WallParts, zone: string | null): number {
  const w = wallPartsAt(ms, zone);
  return wallToMs({ Y: w.Y, Mo: w.Mo, D: w.D, h: template.h, mi: template.mi, s: template.s }, zone);
}

/**
 * Expand one DTSTART (+ duration) under RRULE into occurrences that can matter for detection:
 * roughly [now − max(duration, 24h), now + leadMs].
 */
export function expandRruleOccurrences(
  startMs: number,
  endMs: number,
  rrule: ParsedRrule,
  exdates: readonly ExdateEntry[],
  nowMs: number,
  leadMs: number,
  zone: string | null,
): { startMs: number; endMs: number }[] {
  const duration = Math.max(0, endMs - startMs);
  const windowStart = nowMs - Math.max(duration, DAY_MS);
  const windowEnd = nowMs + leadMs;
  const out: { startMs: number; endMs: number }[] = [];
  const clock = wallPartsAt(startMs, zone);
  const byDay = rrule.byDay;
  const useByDay = byDay.length > 0;

  let emitted = 0;
  const pushIfVisible = (t: number): 'ok' | 'count' | 'until' => {
    if (rrule.untilMs != null && t > rrule.untilMs) return 'until';
    if (rrule.count != null && emitted >= rrule.count) return 'count';
    if (!isExcluded(t, zone, exdates)) {
      const occEnd = t + duration;
      if (occEnd > windowStart && t <= windowEnd) {
        out.push({ startMs: t, endMs: occEnd });
      }
    }
    emitted++;
    if (rrule.count != null && emitted >= rrule.count) return 'count';
    return 'ok';
  };

  if (rrule.freq === 'DAILY') {
    let t = startMs;
    for (let i = 0; i < 800; i++) {
      const dayOk = !useByDay || byDay.includes(weekdayAt(t, zone));
      // DTSTART is always the first instance even if it fails BYDAY.
      if (t === startMs || dayOk) {
        const r = pushIfVisible(t);
        if (r !== 'ok') break;
      }
      t = addWallDays(t, rrule.interval, zone);
      if (t > windowEnd && t > startMs) break;
      if (rrule.untilMs != null && t > rrule.untilMs) break;
    }
  } else if (rrule.freq === 'WEEKLY') {
    if (!useByDay) {
      let t = startMs;
      for (let i = 0; i < 400; i++) {
        const r = pushIfVisible(t);
        if (r !== 'ok') break;
        t = addWallDays(t, 7 * rrule.interval, zone);
        if (t > windowEnd && t > startMs) break;
      }
    } else {
      const startDay = wallToMs({ ...wallPartsAt(startMs, zone), h: 0, mi: 0, s: 0 }, zone);
      // Always emit DTSTART first.
      {
        const r = pushIfVisible(startMs);
        if (r !== 'ok') return out;
      }
      let day = addWallDays(startMs, 1, zone);
      day = sameWallClock(day, clock, zone);
      for (let i = 0; i < 800; i++) {
        if (rrule.untilMs != null && day > rrule.untilMs) break;
        if (rrule.count != null && emitted >= rrule.count) break;
        if (day > windowEnd && day > startMs) break;
        const dayStart = wallToMs({ ...wallPartsAt(day, zone), h: 0, mi: 0, s: 0 }, zone);
        const weekIndex = Math.round((dayStart - startDay) / (7 * DAY_MS));
        if (weekIndex >= 0 && weekIndex % rrule.interval === 0 && byDay.includes(weekdayAt(day, zone))) {
          const r = pushIfVisible(day);
          if (r !== 'ok') break;
        }
        day = sameWallClock(addWallDays(day, 1, zone), clock, zone);
      }
    }
  } else {
    // MONTHLY
    for (let monthOffset = 0; monthOffset < 48; monthOffset += rrule.interval) {
      if (rrule.count != null && emitted >= rrule.count) break;
      const baseMs = addWallMonths(startMs, monthOffset, zone);
      if (!useByDay) {
        if (rrule.untilMs != null && baseMs > rrule.untilMs) break;
        const r = pushIfVisible(baseMs);
        if (r !== 'ok') break;
        if (baseMs > windowEnd && monthOffset > 0) break;
      } else {
        const base = wallPartsAt(baseMs, zone);
        const dim = new Date(Date.UTC(base.Y, base.Mo + 1, 0)).getUTCDate();
        let stop = false;
        for (let d = 1; d <= dim; d++) {
          const t = wallToMs({ Y: base.Y, Mo: base.Mo, D: d, h: clock.h, mi: clock.mi, s: clock.s }, zone);
          if (t < startMs) continue;
          if (!byDay.includes(weekdayAt(t, zone))) continue;
          const r = pushIfVisible(t);
          if (r !== 'ok') {
            stop = true;
            break;
          }
        }
        if (stop) break;
        const monthStart = wallToMs({ Y: base.Y, Mo: base.Mo, D: 1, h: 0, mi: 0, s: 0 }, zone);
        if (monthStart > windowEnd && monthOffset > 0) break;
      }
    }
  }

  return out;
}

export interface ParseIcsOpts {
  /** Anchor for RRULE expansion (default: Date.now()). */
  nowMs?: number;
  /** Lead window for “soon” (default: DEFAULT_LEAD_MS). */
  leadMs?: number;
}

/** Extract VEVENT blocks from one .ics body. Recurring events are expanded around nowMs. */
export function parseIcsEvents(text: string, file?: string, opts: ParseIcsOpts = {}): CalendarEvent[] {
  const nowMs = opts.nowMs ?? Date.now();
  const leadMs = opts.leadMs ?? DEFAULT_LEAD_MS;
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
  let status = '';
  let rruleRaw = '';
  const exdateRaws: { value: string; tzid?: string }[] = [];

  const reset = () => {
    summary = '';
    startRaw = '';
    endRaw = '';
    durationRaw = '';
    startAllDay = false;
    startTz = undefined;
    endTz = undefined;
    status = '';
    rruleRaw = '';
    exdateRaws.length = 0;
  };

  const flush = () => {
    if (!startRaw) return;
    if (status === 'CANCELLED') return;
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
      endMs = startMs + DAY_MS;
    } else {
      endMs = startMs + 60 * 60_000;
    }
    if (endMs < startMs) endMs = startMs + 60 * 60_000;

    const summaryText = summary.trim() || 'Meeting';
    const zone = occurrenceZone(startRaw, startTz);

    if (!rruleRaw) {
      events.push({ summary: summaryText, startMs, endMs, file });
      return;
    }

    const rrule = parseRrule(rruleRaw);
    if (!rrule) return; // malformed RRULE → skip event safely

    const exdates: ExdateEntry[] = [];
    for (const ex of exdateRaws) {
      for (const piece of ex.value.split(',')) {
        const raw = piece.trim();
        if (!raw) continue;
        const allDay = !raw.includes('T');
        const ms = parseIcsDateTime(raw, ex.tzid ?? startTz);
        if (ms == null || !Number.isFinite(ms)) continue;
        exdates.push({ ms, allDay, zone: occurrenceZone(raw, ex.tzid ?? startTz) });
      }
    }

    for (const occ of expandRruleOccurrences(startMs, endMs, rrule, exdates, nowMs, leadMs, zone)) {
      events.push({ summary: summaryText, startMs: occ.startMs, endMs: occ.endMs, file });
    }
  };

  for (const line of lines) {
    const u = line.toUpperCase();
    if (u === 'BEGIN:VEVENT') {
      inEvent = true;
      reset();
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
    } else if (p.name === 'DURATION') durationRaw = p.value.trim();
    else if (p.name === 'STATUS') status = p.value.trim().toUpperCase();
    else if (p.name === 'RRULE') rruleRaw = p.value.trim();
    else if (p.name === 'EXDATE') exdateRaws.push({ value: p.value.trim(), tzid: p.tzid });
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
export function loadCalendarEvents(
  path: string,
  deps: LoadCalendarDeps = {},
  opts: ParseIcsOpts = {},
): CalendarEvent[] {
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
      events.push(...parseIcsEvents(readFile(f), f, opts));
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
  return activeCalendarHits(loadCalendarEvents(path, deps, { nowMs, leadMs }), nowMs, leadMs);
}
