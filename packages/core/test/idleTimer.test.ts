import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_UNLOAD_MINUTES, IDLE_UNLOAD_MINUTES, IdleTimer, normalizeIdleMinutes } from '../src/idleTimer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('IdleTimer', () => {
  it('fires once after the delay counted from the last touch', () => {
    let fired = 0;
    const t = new IdleTimer({ ms: () => 1000, onIdle: () => void fired++ });
    t.touch();
    vi.advanceTimersByTime(900);
    t.touch();
    vi.advanceTimersByTime(900);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(100);
    expect(fired).toBe(1);
    expect(t.armed).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(fired).toBe(1);
  });

  it('0 means never; cancel stops a pending unload', () => {
    let fired = 0;
    let ms = 0;
    const t = new IdleTimer({ ms: () => ms, onIdle: () => void fired++ });
    t.touch();
    expect(t.armed).toBe(false);
    vi.advanceTimersByTime(60 * 60_000);
    expect(fired).toBe(0);
    ms = 500;
    t.touch();
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(0);
  });

  it('busy at the deadline waits another full delay; a throwing busy counts as busy', () => {
    let fired = 0;
    let busy: () => boolean = () => true;
    const t = new IdleTimer({ ms: () => 1000, busy: () => busy(), onIdle: () => void fired++ });
    t.touch();
    vi.advanceTimersByTime(3000);
    expect(fired).toBe(0);
    expect(t.armed).toBe(true);
    busy = () => {
      throw new Error('x');
    };
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(0);
    busy = () => false;
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(1);
  });

  it('reads the delay on every touch (a settings change applies from the next use)', () => {
    let fired = 0;
    let ms = 5000;
    const t = new IdleTimer({ ms: () => ms, onIdle: () => void fired++ });
    t.touch();
    ms = 200;
    t.touch();
    vi.advanceTimersByTime(200);
    expect(fired).toBe(1);
  });
});

describe('normalizeIdleMinutes', () => {
  it('keeps the offered choices and snaps the rest', () => {
    for (const m of IDLE_UNLOAD_MINUTES) expect(normalizeIdleMinutes(m)).toBe(m);
    expect(normalizeIdleMinutes(-3)).toBe(0);
    expect(normalizeIdleMinutes(1)).toBe(5);
    expect(normalizeIdleMinutes(20)).toBe(15);
    expect(normalizeIdleMinutes(25)).toBe(30);
    expect(normalizeIdleMinutes(500)).toBe(60);
    expect(normalizeIdleMinutes('15')).toBe(DEFAULT_IDLE_UNLOAD_MINUTES);
    expect(normalizeIdleMinutes(Number.NaN)).toBe(DEFAULT_IDLE_UNLOAD_MINUTES);
    expect(DEFAULT_IDLE_UNLOAD_MINUTES).toBe(15);
  });
});
