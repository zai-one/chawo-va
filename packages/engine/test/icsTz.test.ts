import { describe, expect, it } from 'vitest';
import { activeCalendarHits, parseIcsDateTime, parseIcsEvents, resolveTzid } from '../src/meeting/meetingCalendar';

const ics = (start: string, end: string) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Демо\r\n${start}\r\n${end}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

describe('ICS TZID', () => {
  it('Europe/Moscow wall time → UTC−3h (no DST)', () => {
    expect(parseIcsDateTime('20261014T100000', 'Europe/Moscow')).toBe(Date.UTC(2026, 9, 14, 7, 0, 0));
    expect(parseIcsDateTime('20260115T100000', 'Europe/Moscow')).toBe(Date.UTC(2026, 0, 15, 7, 0, 0));
  });
  it('Z is UTC whatever the TZID says', () => {
    expect(parseIcsDateTime('20261014T100000Z', 'Europe/Moscow')).toBe(Date.UTC(2026, 9, 14, 10, 0, 0));
  });
  it('DST zones: summer and winter offsets, and the spring-forward day', () => {
    expect(parseIcsDateTime('20260701T090000', 'America/Los_Angeles')).toBe(Date.UTC(2026, 6, 1, 16));
    expect(parseIcsDateTime('20261201T090000', 'America/Los_Angeles')).toBe(Date.UTC(2026, 11, 1, 17));
    expect(parseIcsDateTime('20260308T120000', 'America/Los_Angeles')).toBe(Date.UTC(2026, 2, 8, 19));
    expect(parseIcsDateTime('20260329T120000', 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 10));
  });
  it('quoted, prefixed and Windows TZIDs; unknown → floating local', () => {
    expect(resolveTzid('"Europe/Moscow"')).toBe('Europe/Moscow');
    expect(resolveTzid('/mozilla.org/20070129_1/Europe/Moscow')).toBe('Europe/Moscow');
    expect(resolveTzid('Russian Standard Time')).toBe('Europe/Moscow');
    expect(resolveTzid('Nowhere/Land')).toBeNull();
    expect(parseIcsDateTime('20261014T100000', 'Nowhere/Land')).toBe(new Date(2026, 9, 14, 10).getTime());
  });
  it('parseIcsEvents applies DTSTART/DTEND TZID; a meeting in Moscow is "now" at the right instant', () => {
    const [e] = parseIcsEvents(ics('DTSTART;TZID=Europe/Moscow:20261014T100000', 'DTEND;TZID=Europe/Moscow:20261014T110000'));
    expect(e!.startMs).toBe(Date.UTC(2026, 9, 14, 7));
    expect(e!.endMs).toBe(Date.UTC(2026, 9, 14, 8));
    expect(activeCalendarHits([e!], Date.UTC(2026, 9, 14, 7, 30))[0]?.kind).toBe('now');
    expect(activeCalendarHits([e!], Date.UTC(2026, 9, 14, 10, 30))).toEqual([]);
    const [z] = parseIcsEvents(ics('DTSTART:20261014T070000Z', 'DTEND:20261014T080000Z'));
    expect([z!.startMs, z!.endMs]).toEqual([e!.startMs, e!.endMs]);
    const [w] = parseIcsEvents(ics('DTSTART;TZID="Russian Standard Time":20261014T100000', 'DTEND;TZID="Russian Standard Time":20261014T110000'));
    expect(w!.startMs).toBe(e!.startMs);
  });
});
