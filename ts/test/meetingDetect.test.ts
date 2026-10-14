import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  matchMeetingProcess,
  matchMeetingProcesses,
  parseWindowsProcessList,
  stemOf,
} from '../src/main/meeting/meetingApps';
import {
  activeCalendarHits,
  parseIcsDateTime,
  parseIcsDuration,
  parseIcsEvents,
  detectCalendar,
  unfoldIcs,
} from '../src/main/meeting/meetingCalendar';
import {
  detectFingerprint,
  detectMeeting,
  MeetingDetectPoller,
  shouldOfferPrompt,
  SNOOZE_MS,
} from '../src/main/meeting/meetingDetect';

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
    expect(matchMeetingProcess('Discord.exe')?.app).toBe('Discord');
    expect(matchMeetingProcess('Skype.exe')?.app).toBe('Skype');
    expect(matchMeetingProcess('webexhost')?.app).toBe('Webex');
    expect(matchMeetingProcess('telemost')?.app).toBe('Телемост');
    expect(matchMeetingProcess('notepad.exe')).toBeNull();
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
    expect(events[0]!.summary).toBe('Созвон с клиентом');
    const now = new Date(2026, 9, 14, 10, 30, 0).getTime();
    const hits = activeCalendarHits(events, now, 10 * 60_000);
    expect(hits.map((h) => h.summary)).toEqual(['Созвон с клиентом']);
    const later = new Date(2026, 9, 14, 12, 0, 0).getTime();
    const soon = activeCalendarHits(events, later, 10 * 60_000);
    expect(soon).toHaveLength(1);
    expect(soon[0]!.kind).toBe('soon');
    expect(soon[0]!.summary).toBe('Soon');
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
    expect(on.calendar[0]!.summary).toBe('Standup');

    const linux = await detectMeeting(
      { MeetingAutoDetect: true, MeetingAutoDetectApps: true, MeetingAutoDetectCalendar: '' },
      { platform: 'linux', exec: async () => 'Zoom|', now: () => now },
    );
    expect(linux.appsSupported).toBe(false);
    expect(linux.apps).toEqual([]);
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
