// Unloads a model after the user has not used it for a while (IDEAS №13, after voxtype's idle unload).
// Pure: the clock is injected, so tests drive it with fake timers. The delay is read on every arm, so a
// settings change applies from the next use. Busy at the deadline (a take, a Hermes request) re-arms
// instead of unloading; 0 minutes means «never».

export type IdleClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export interface IdleTimerOptions {
  /** Current delay in ms; 0 or less keeps the model loaded. */
  ms: () => number;
  /** Something is using the model right now: wait another full delay. */
  busy?: () => boolean;
  /** Time is up and nothing is busy. */
  onIdle: () => void;
  clock?: IdleClock;
}

const realClock: IdleClock = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    // Never keeps a CLI or a test process alive on its own.
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Allowed choices for «Выгружать модели при простое», in minutes (0 = never). */
export const IDLE_UNLOAD_MINUTES = [0, 5, 15, 30, 60] as const;
export const DEFAULT_IDLE_UNLOAD_MINUTES = 15;

/** Snaps a stored value to the nearest allowed choice; junk falls back to the default. */
export function normalizeIdleMinutes(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : Number.NaN;
  if (Number.isNaN(n)) return DEFAULT_IDLE_UNLOAD_MINUTES;
  if (n <= 0) return 0;
  let best: number = IDLE_UNLOAD_MINUTES[1];
  for (const m of IDLE_UNLOAD_MINUTES) if (m > 0 && Math.abs(m - n) < Math.abs(best - n)) best = m;
  return best;
}

export class IdleTimer {
  private handle: unknown = null;
  private readonly clock: IdleClock;

  constructor(private readonly o: IdleTimerOptions) {
    this.clock = o.clock ?? realClock;
  }

  get armed(): boolean {
    return this.handle !== null;
  }

  /** The model was just used (or loaded): start the delay over. */
  touch(): void {
    this.cancel();
    const ms = this.o.ms();
    if (!(ms > 0)) return;
    this.handle = this.clock.setTimeout(() => {
      this.handle = null;
      let busy = false;
      try {
        busy = this.o.busy?.() ?? false;
      } catch {
        busy = true;
      }
      if (busy) this.touch();
      else this.o.onIdle();
    }, ms);
  }

  /** The model is gone anyway (unloaded, settings changed, quit). */
  cancel(): void {
    if (this.handle !== null) this.clock.clearTimeout(this.handle);
    this.handle = null;
  }
}
