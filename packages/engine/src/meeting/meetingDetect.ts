// Combine app + calendar sources into one detect result. Pure orchestration (injected I/O),
// so CLI and the GUI poller share the same logic. Never starts recording by itself.

import { listMeetingApps, meetingAppsSupported, type ExecLike, type MeetingAppHit } from './meetingApps';
import {
  DEFAULT_LEAD_MS,
  detectCalendar,
  type CalendarHit,
  type LoadCalendarDeps,
} from './meetingCalendar';

export const POLL_INTERVAL_MS = 45_000;
export const SNOOZE_MS = 20 * 60_000;

export interface MeetingDetectSettings {
  MeetingAutoDetect: boolean;
  MeetingAutoDetectApps: boolean;
  MeetingAutoDetectCalendar: string;
}

export interface MeetingDetectResult {
  /** True when at least one source says a meeting looks active. */
  active: boolean;
  /** False when process heuristics are not available (e.g. macOS). */
  appsSupported: boolean;
  apps: MeetingAppHit[];
  calendar: CalendarHit[];
  /** Short human reasons (RU/EN chosen by the caller via labels). */
  reasons: string[];
}

export interface DetectDeps {
  platform?: NodeJS.Platform;
  exec?: ExecLike;
  now?: () => number;
  leadMs?: number;
  calendar?: LoadCalendarDeps;
}

/** One-shot detect (CLI `meeting detect` and each GUI poll tick). */
export async function detectMeeting(
  settings: MeetingDetectSettings,
  deps: DetectDeps = {},
): Promise<MeetingDetectResult> {
  const now = (deps.now ?? Date.now)();
  const leadMs = deps.leadMs ?? DEFAULT_LEAD_MS;
  const appsOn = settings.MeetingAutoDetect && settings.MeetingAutoDetectApps;
  const calPath = settings.MeetingAutoDetectCalendar?.trim() ?? '';

  let appsSupported: boolean;
  let apps: MeetingAppHit[] = [];
  if (appsOn) {
    const listed = await listMeetingApps({ platform: deps.platform, exec: deps.exec });
    appsSupported = listed.supported;
    apps = listed.hits;
  } else {
    const platform = deps.platform ?? process.platform;
    appsSupported = meetingAppsSupported(platform);
  }

  const calendar =
    settings.MeetingAutoDetect && calPath
      ? detectCalendar(calPath, now, leadMs, deps.calendar)
      : [];

  const reasons: string[] = [];
  for (const a of apps) reasons.push(a.app);
  for (const c of calendar) reasons.push(c.summary);

  return {
    active: apps.length > 0 || calendar.length > 0,
    appsSupported,
    apps,
    calendar,
    reasons,
  };
}

/** Should the GUI show the «Записать?» prompt for this tick? */
export function shouldOfferPrompt(opts: {
  masterOn: boolean;
  recording: boolean;
  snoozeUntil: number;
  now: number;
  active: boolean;
  /** Same fingerprint already showing / just dismissed this session without snooze clear. */
  offerKey: string | null;
  fingerprint: string;
}): boolean {
  if (!opts.masterOn || opts.recording || !opts.active) return false;
  if (opts.now < opts.snoozeUntil) return false;
  if (opts.offerKey && opts.offerKey === opts.fingerprint) return false;
  return true;
}

/** Stable key for the current set of hits (so we do not re-prompt for the same Zoom call every 45s). */
export function detectFingerprint(result: MeetingDetectResult): string {
  const apps = result.apps.map((a) => `a:${a.app}`).sort();
  const cal = result.calendar.map((c) => `c:${c.startMs}:${c.summary}`).sort();
  return [...apps, ...cal].join('|');
}

/**
 * In-memory poller state machine used by meetingIpc. Timer IDs are injected so tests stay sync.
 */
export class MeetingDetectPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private snoozeUntil = 0;
  private offerKey: string | null = null;
  private offering = false;

  constructor(
    private readonly d: {
      settings: () => MeetingDetectSettings;
      recording: () => boolean;
      detect: () => Promise<MeetingDetectResult>;
      onOffer: (result: MeetingDetectResult, fingerprint: string) => void;
      onClear?: () => void;
      now?: () => number;
      intervalMs?: number;
      setInterval?: typeof setInterval;
      clearInterval?: typeof clearInterval;
    },
  ) {}

  get snoozedUntil(): number {
    return this.snoozeUntil;
  }

  get isOffering(): boolean {
    return this.offering;
  }

  start(): void {
    if (this.timer) return;
    const every = this.d.intervalMs ?? POLL_INTERVAL_MS;
    const setInt = this.d.setInterval ?? setInterval;
    this.timer = setInt(() => {
      void this.tick();
    }, every);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      const clear = this.d.clearInterval ?? clearInterval;
      clear(this.timer);
      this.timer = null;
    }
  }

  /** «Не сейчас» — snooze ~20 min and hide the prompt. */
  snooze(ms = SNOOZE_MS): void {
    const now = (this.d.now ?? Date.now)();
    this.snoozeUntil = now + ms;
    this.offering = false;
    this.offerKey = null;
    this.d.onClear?.();
  }

  /** User accepted «Записать» or dismissed forever — clear the banner. */
  clearOffer(): void {
    this.offering = false;
    this.d.onClear?.();
  }

  /** Remember the fingerprint so the same meeting is not offered again until it changes. */
  acknowledge(fingerprint: string): void {
    this.offerKey = fingerprint;
    this.offering = false;
  }

  async tick(): Promise<MeetingDetectResult | null> {
    const s = this.d.settings();
    if (!s.MeetingAutoDetect) {
      if (this.offering) {
        this.offering = false;
        this.d.onClear?.();
      }
      return null;
    }
    if (this.d.recording()) {
      if (this.offering) {
        this.offering = false;
        this.d.onClear?.();
      }
      return null;
    }
    const result = await this.d.detect();
    const now = (this.d.now ?? Date.now)();
    const fp = detectFingerprint(result);
    if (
      shouldOfferPrompt({
        masterOn: s.MeetingAutoDetect,
        recording: this.d.recording(),
        snoozeUntil: this.snoozeUntil,
        now,
        active: result.active,
        offerKey: this.offerKey,
        fingerprint: fp,
      })
    ) {
      this.offering = true;
      this.offerKey = fp;
      this.d.onOffer(result, fp);
    } else if (this.offering && !result.active) {
      this.offering = false;
      this.offerKey = null;
      this.d.onClear?.();
    }
    return result;
  }
}
