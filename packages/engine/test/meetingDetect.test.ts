import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listMeetingApps,
  matchMeetingProcess,
  matchMeetingProcesses,
  meetingAppsSupported,
  parseLinuxProcessList,
  parseWindowsProcessList,
  stemOf,
} from '../src/meeting/meetingApps';
import {
  activeCalendarHits,
  parseIcsDateTime,
  parseIcsDuration,
  parseIcsEvents,
  parseRrule,
  detectCalendar,
  unfoldIcs,
} from '../src/meeting/meetingCalendar';
import {
  detectFingerprint,
  detectMeeting,
  MeetingDetectPoller,
  shouldOfferPrompt,
  SNOOZE_MS,
} from '../src/meeting/meetingDetect';

describe('meetingApps matching', () => {
  it('stems drop .exe and case', () => {
    expect(stemOf('Zoom.exe')).toBe('zoom');
    expect(stemOf('ms-teams')).toBe('ms-teams');
  });

  it('matches known processes', () => {
    expect(matchMeetingProcess('Zoom.exe')?.app).toBe('Zoom');
    expect(matchMeetingProcess('CptHost')?.app).toBe('Zoom');
    expect(matchMeetingProcess('Teams.exe')?.app).toBe('Teams');
    expect(matchMeetingProcess('ms-teams')?.app).toBe('Teams');
    expect(matchMeetingProcess('teams-for-linux')?.app).toBe('Teams');
    expect(matchMeetingProcess('Discord.exe')?.app).toBe('Discord');
    expect(matchMeetingProcess('Skype.exe')?.app).toBe('Skype');
    expect(matchMeetingProcess('skypeforlinux')?.app).toBe('Skype');
    expect(matchMeetingProcess('webexhost')?.app).toBe('Webex');
    expect(matchMeetingProcess('telemost')?.app).toBe('Телемост');
    expect(matchMeetingProcess('notepad.exe')).toBeNull();
    expect(matchMeetingProcess('telegram-desktop')).toBeNull();
  });

  it('matches browser window titles for Meet / Telemost', () => {
    expect(matchMeetingProcess('chrome.exe', 'Google Meet - Weekly sync')?.app).toBe('Google Meet');
    expect(matchMeetingProcess('msedge', 'Телемост — созвон')?.app).toBe('Телемост');
    expect(matchMeetingProcess('chrome.exe', 'Gmail')).toBeNull();
    expect(matchMeetingProcess('Zoom.exe', 'anything')?.app).toBe('Zoom');
  });

  it('dedupes by app name', () => {
    const hits = matchMeetingProcesses([
      { name: 'Zoom.exe' },
      { name: 'CptHost.exe' },
      { name: 'chrome', title: 'Google Meet - A' },
    ]);
    expect(hits.map((h) => h.app)).toEqual(['Zoom', 'Google Meet']);
  });

  it('parses PowerShell process list lines', () => {
    const rows = parseWindowsProcessList('Zoom|Zoom Meeting\r\nchrome|Gmail\nTeams|\n');
    expect(rows).toEqual([
      { name: 'Zoom', title: 'Zoom Meeting' },
      { name: 'chrome', title: 'Gmail' },
      { name: 'Teams', title: '' },
    ]);
  });

  it('parses Linux ps comm lines', () => {
    const rows = parseLinuxProcessList('zoom\nteams\nchrome\n/usr/bin/discord\nCOMM\n');
    expect(rows).toEqual([
      { name: 'zoom', title: '' },
      { name: 'teams', title: '' },
      { name: 'chrome', title: '' },
      { name: 'discord', title: '' },
    ]);
  });

  it('meetingAppsSupported is win32 and linux only', () => {
    expect(meetingAppsSupported('win32')).toBe(true);
    expect(meetingAppsSupported('linux')).toBe(true);
    expect(meetingAppsSupported('darwin')).toBe(false);
  });

  it('listMeetingApps on Linux: hits from stubbed ps, supported on exec fail', async () => {
    const hit = await listMeetingApps({
      platform: 'linux',
      exec: async (file, args) => {
        expect(file).toBe('ps');
        expect(args).toEqual(['-eo', 'comm=']);
        return 'bash\nzoom\nteams-for-linux\nfirefox\n';
      },
    });
    expect(hit.supported).toBe(true);
    expect(hit.hits.map((h) => h.app).sort()).toEqual(['Teams', 'Zoom']);

    const fail = await listMeetingApps({
      platform: 'linux',
      exec: async () => {
        throw new Error('ps missing');
      },
    });
    expect(fail.supported).toBe(true);
    expect(fail.hits).toEqual([]);

    const noExec = await listMeetingApps({ platform: 'linux' });
    expect(noExec).toEqual({ supported: true, hits: [] });
  });

  it('listMeetingApps on darwin stays unsupported; Windows still works', async () => {
    const mac = await listMeetingApps({
      platform: 'darwin',
      exec: async () => 'zoom\n',
    });
    expect(mac).toEqual({ supported: false, hits: [] });

    const win = await listMeetingApps({
      platform: 'win32',
      exec: async (file, args) => {
        expect(file).toBe('powershell.exe');
        expect(args[0]).toBe('-NoProfile');
        return 'Zoom|Meeting\nchrome|Gmail\n';
      },
    });
    expect(win.supported).toBe(true);
    expect(win.hits.map((h) => h.app)).toEqual(['Zoom']);
  });
});

describe('meetingCalendar .ics', () => {
  it('unfolds continued lines', () => {
    expect(unfoldIcs('SUMMARY:Hello\n  world')).toBe('SUMMARY:Hello world');
  });

  it('parses floating and UTC date-times', () => {
    const local = parseIcsDateTime('20261014T150000');
    expect(local).toBe(new Date(2026, 9, 14, 15, 0, 0).getTime());
    const utc = parseIcsDateTime('20261014T120000Z');
    expect(utc).toBe(Date.UTC(2026, 9, 14, 12, 0, 0));
    expect(parseIcsDateTime('20261014')).toBe(new Date(2026, 9, 14, 0, 0, 0).getTime());
  });

  it('parses duration', () => {
    expect(parseIcsDuration('PT1H30M')).toBe(90 * 60_000);
    expect(parseIcsDuration('P1D')).toBe(24 * 60 * 60_000);
  });

  it('parses VEVENT and active window', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Созвон с клиентом
DTSTART:20261014T100000
DTEND:20261014T110000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Soon
DTSTART:20261014T120500
DURATION:PT30M
END:VEVENT
END:VCALENDAR`;
    const events = parseIcsEvents(ics);
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe('Созвон с клиентом');
    const now = new Date(2026, 9, 14, 10, 30, 0).getTime();
    const hits = activeCalendarHits(events, now, 10 * 60_000);
    expect(hits.map((h) => h.summary)).toEqual(['Созвон с клиентом']);
    const later = new Date(2026, 9, 14, 12, 0, 0).getTime();
    const soon = activeCalendarHits(events, later, 10 * 60_000);
    expect(soon).toHaveLength(1);
    expect(soon[0].kind).toBe('soon');
    expect(soon[0].summary).toBe('Soon');
  });

  it('loads a folder of .ics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-ics-'));
    try {
      writeFileSync(
        join(dir, 'a.ics'),
        'BEGIN:VEVENT\nSUMMARY:A\nDTSTART:20261014T090000\nDTEND:20261014T100000\nEND:VEVENT\n',
      );
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'ignored.ics'), 'BEGIN:VEVENT\nSUMMARY:X\nDTSTART:20261014T090000\nEND:VEVENT\n');
      const now = new Date(2026, 9, 14, 9, 30, 0).getTime();
      const hits = detectCalendar(dir, now);
      expect(hits.map((h) => h.summary)).toEqual(['A']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('meetingDetect combine + poller', () => {
  it('detectMeeting merges apps and calendar; master off → inactive', async () => {
    const now = new Date(2026, 9, 14, 10, 0, 0).getTime();
    const ics = 'BEGIN:VEVENT\nSUMMARY:Standup\nDTSTART:20261014T095000\nDTEND:20261014T103000\nEND:VEVENT\n';
    const off = await detectMeeting(
      { MeetingAutoDetect: false, MeetingAutoDetectApps: true, MeetingAutoDetectCalendar: '/x.ics' },
      {
        platform: 'win32',
        exec: async () => 'Zoom|',
        now: () => now,
        calendar: { exists: () => true, isDir: () => false, readFile: () => ics },
      },
    );
    expect(off.active).toBe(false);

    const on = await detectMeeting(
      { MeetingAutoDetect: true, MeetingAutoDetectApps: true, MeetingAutoDetectCalendar: '/x.ics' },
      {
        platform: 'win32',
        exec: async () => 'Zoom|\nchrome|Google Meet - x\n',
        now: () => now,
        calendar: { exists: () => true, isDir: () => false, readFile: () => ics },
      },
    );
    expect(on.active).toBe(true);
    expect(on.appsSupported).toBe(true);
    expect(on.apps.map((a) => a.app).sort()).toEqual(['Google Meet', 'Zoom']);
    expect(on.calendar[0].summary).toBe('Standup');

    const linux = await detectMeeting(
      { MeetingAutoDetect: true, MeetingAutoDetectApps: true, MeetingAutoDetectCalendar: '' },
      { platform: 'linux', exec: async () => 'zoom\nteams\nbash\n', now: () => now },
    );
    expect(linux.appsSupported).toBe(true);
    expect(linux.apps.map((a) => a.app).sort()).toEqual(['Teams', 'Zoom']);

    const darwin = await detectMeeting(
      { MeetingAutoDetect: true, MeetingAutoDetectApps: true, MeetingAutoDetectCalendar: '' },
      { platform: 'darwin', exec: async () => 'zoom\n', now: () => now },
    );
    expect(darwin.appsSupported).toBe(false);
    expect(darwin.apps).toEqual([]);
  });

  it('shouldOfferPrompt respects snooze, recording, fingerprint', () => {
    expect(
      shouldOfferPrompt({
        masterOn: true,
        recording: false,
        snoozeUntil: 0,
        now: 1000,
        active: true,
        offerKey: null,
        fingerprint: 'a:Zoom',
      }),
    ).toBe(true);
    expect(
      shouldOfferPrompt({
        masterOn: true,
        recording: true,
        snoozeUntil: 0,
        now: 1000,
        active: true,
        offerKey: null,
        fingerprint: 'a:Zoom',
      }),
    ).toBe(false);
    expect(
      shouldOfferPrompt({
        masterOn: true,
        recording: false,
        snoozeUntil: 2000,
        now: 1000,
        active: true,
        offerKey: null,
        fingerprint: 'a:Zoom',
      }),
    ).toBe(false);
    expect(
      shouldOfferPrompt({
        masterOn: true,
        recording: false,
        snoozeUntil: 0,
        now: 1000,
        active: true,
        offerKey: 'a:Zoom',
        fingerprint: 'a:Zoom',
      }),
    ).toBe(false);
  });

  it('poller offers once, snoozes, clears when inactive', async () => {
    let now = 1_000_000;
    const offers: string[] = [];
    let clears = 0;
    let active = true;
    const poller = new MeetingDetectPoller({
      settings: () => ({
        MeetingAutoDetect: true,
        MeetingAutoDetectApps: true,
        MeetingAutoDetectCalendar: '',
      }),
      recording: () => false,
      detect: async () => ({
        active,
        appsSupported: true,
        apps: active ? [{ app: 'Zoom', matched: 'Zoom.exe' }] : [],
        calendar: [],
        reasons: active ? ['Zoom'] : [],
      }),
      onOffer: (_r, fp) => offers.push(fp),
      onClear: () => {
        clears++;
      },
      now: () => now,
      intervalMs: 60_000,
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: () => undefined,
    });
    await poller.tick();
    expect(offers).toEqual([detectFingerprint({ active: true, appsSupported: true, apps: [{ app: 'Zoom', matched: 'Zoom.exe' }], calendar: [], reasons: ['Zoom'] })]);
    await poller.tick();
    expect(offers).toHaveLength(1); // same fingerprint — no re-offer
    poller.snooze(SNOOZE_MS);
    expect(clears).toBeGreaterThan(0);
    now += 1000;
    await poller.tick();
    expect(offers).toHaveLength(1); // still snoozed
    now += SNOOZE_MS + 1;
    active = true;
    // After snooze, offerKey was cleared — should offer again
    await poller.tick();
    expect(offers.length).toBe(2);
    active = false;
    await poller.tick();
    expect(poller.isOffering).toBe(false);
  });
});


describe('meetingCalendar RRULE / CANCELLED / EXDATE', () => {
  const lead = 10 * 60_000;

  it('skips STATUS:CANCELLED', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Отмена
STATUS:CANCELLED
DTSTART:20261014T100000
DTEND:20261014T110000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Живая
DTSTART:20261014T100000
DTEND:20261014T110000
END:VEVENT
END:VCALENDAR`;
    const events = parseIcsEvents(ics, undefined, { nowMs: new Date(2026, 9, 14, 10, 30).getTime(), leadMs: lead });
    expect(events.map((e) => e.summary)).toEqual(['Живая']);
  });

  it('weekly BYDAY hits now and soon', () => {
    // Wednesday 2026-10-14 — weekly WE from earlier Wednesday
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Стендап
DTSTART:20261007T100000
DTEND:20261007T103000
RRULE:FREQ=WEEKLY;BYDAY=WE
END:VEVENT
END:VCALENDAR`;
    const now = new Date(2026, 9, 14, 10, 10).getTime(); // during 10:00–10:30 occurrence
    const events = parseIcsEvents(ics, undefined, { nowMs: now, leadMs: lead });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const hits = activeCalendarHits(events, now, lead);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('now');
    expect(hits[0].summary).toBe('Стендап');

    const before = new Date(2026, 9, 14, 9, 55).getTime();
    const soonEvents = parseIcsEvents(ics, undefined, { nowMs: before, leadMs: lead });
    const soon = activeCalendarHits(soonEvents, before, lead);
    expect(soon).toHaveLength(1);
    expect(soon[0].kind).toBe('soon');
  });

  it('EXDATE removes an occurrence', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Стендап
DTSTART:20261007T100000
DTEND:20261007T103000
RRULE:FREQ=WEEKLY;BYDAY=WE
EXDATE:20261014T100000
END:VEVENT
END:VCALENDAR`;
    const now = new Date(2026, 9, 14, 10, 10).getTime();
    const events = parseIcsEvents(ics, undefined, { nowMs: now, leadMs: lead });
    expect(activeCalendarHits(events, now, lead)).toEqual([]);
    // Previous week still visible if we look then
    const prev = new Date(2026, 9, 7, 10, 10).getTime();
    const prevEvents = parseIcsEvents(ics, undefined, { nowMs: prev, leadMs: lead });
    expect(activeCalendarHits(prevEvents, prev, lead)[0]?.summary).toBe('Стендап');
  });

  it('UNTIL and COUNT bound expansion', () => {
    const untilIcs = `BEGIN:VEVENT
SUMMARY:До UNTIL
DTSTART:20261007T100000
DTEND:20261007T110000
RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261010T235959
END:VEVENT`;
    const now = new Date(2026, 9, 14, 10, 10).getTime();
    expect(parseIcsEvents(untilIcs, undefined, { nowMs: now, leadMs: lead })).toEqual([]);

    const countIcs = `BEGIN:VEVENT
SUMMARY:Два раза
DTSTART:20261007T150000
DTEND:20261007T160000
RRULE:FREQ=DAILY;COUNT=2
END:VEVENT`;
    // COUNT=2 → Oct 7 and Oct 8 only; Oct 14 must not appear
    const mid = new Date(2026, 9, 8, 15, 30).getTime();
    const midEvents = parseIcsEvents(countIcs, undefined, { nowMs: mid, leadMs: lead });
    expect(activeCalendarHits(midEvents, mid, lead)[0]?.summary).toBe('Два раза');
    const later = new Date(2026, 9, 14, 15, 30).getTime();
    expect(parseIcsEvents(countIcs, undefined, { nowMs: later, leadMs: lead })).toEqual([]);
  });

  it('non-recurring events unchanged; malformed RRULE skipped', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Разовая
DTSTART:20261014T120000
DTEND:20261014T130000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Сломанная
DTSTART:20261014T120000
DTEND:20261014T130000
RRULE:FREQ=YEARLY;COUNT=3
END:VEVENT
END:VCALENDAR`;
    const now = new Date(2026, 9, 14, 12, 30).getTime();
    const events = parseIcsEvents(ics, undefined, { nowMs: now, leadMs: lead });
    expect(events.map((e) => e.summary)).toEqual(['Разовая']);
    expect(parseRrule('FREQ=YEARLY')).toBeNull();
    expect(parseRrule('FREQ=WEEKLY;BYDAY=MO,WE')).toEqual({
      freq: 'WEEKLY',
      interval: 1,
      count: undefined,
      untilMs: undefined,
      byDay: [1, 3],
    });
  });

  it('TZID + weekly RRULE: Moscow wall time is now at the right UTC instant', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Москва стендап
DTSTART;TZID=Europe/Moscow:20261007T100000
DTEND;TZID=Europe/Moscow:20261007T103000
RRULE:FREQ=WEEKLY;BYDAY=WE
END:VEVENT
END:VCALENDAR`;
    // 2026-10-14 10:10 Moscow = 07:10 UTC
    const now = Date.UTC(2026, 9, 14, 7, 10, 0);
    const events = parseIcsEvents(ics, undefined, { nowMs: now, leadMs: lead });
    const hits = activeCalendarHits(events, now, lead);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('now');
    expect(hits[0].startMs).toBe(Date.UTC(2026, 9, 14, 7, 0, 0));
  });

  it('missing DTSTART yields nothing; MONTHLY day-of-month works', () => {
    expect(parseIcsEvents('BEGIN:VEVENT\nSUMMARY:X\nRRULE:FREQ=DAILY\nEND:VEVENT\n')).toEqual([]);
    const ics = `BEGIN:VEVENT
SUMMARY:Раз в месяц
DTSTART:20260914T110000
DTEND:20260914T120000
RRULE:FREQ=MONTHLY;INTERVAL=1
END:VEVENT`;
    const now = new Date(2026, 9, 14, 11, 30).getTime();
    const hits = activeCalendarHits(parseIcsEvents(ics, undefined, { nowMs: now, leadMs: lead }), now, lead);
    expect(hits[0]?.summary).toBe('Раз в месяц');
    expect(hits[0]?.kind).toBe('now');
  });
});
