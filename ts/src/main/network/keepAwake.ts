// Asks the OS not to idle-sleep this PC while Hermes listens. Does not block the user from shutting
// down or sleeping by hand. Cleared when the checkbox is off or the listener stops.
// Port of KeepAwake.cs (SetThreadExecutionState) on Electron's powerSaveBlocker; outside Electron
// (tests, a CLI) it is a no-op unless a blocker is injected.

export interface Blocker {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

let blocker: Blocker | null | undefined;
let id: number | null = null;

function electronBlocker(): Blocker | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const e = require('electron') as { powerSaveBlocker?: Blocker } | string;
    return typeof e === 'object' && e?.powerSaveBlocker ? e.powerSaveBlocker : null;
  } catch {
    return null;
  }
}

function get(): Blocker | null {
  if (blocker === undefined) blocker = electronBlocker();
  return blocker;
}

/** Tests: a fake blocker; null turns it off; undefined goes back to Electron's. */
export function setBlocker(b: Blocker | null | undefined): void {
  if (id !== null) allowSleep();
  blocker = b;
}

export function preventSleep(): void {
  const b = get();
  if (!b) return;
  if (id !== null && b.isStarted(id)) return;
  id = b.start('prevent-app-suspension');
}

export function allowSleep(): void {
  const b = get();
  if (b && id !== null && b.isStarted(id)) b.stop(id);
  id = null;
}

export function isPreventing(): boolean {
  const b = get();
  return !!b && id !== null && b.isStarted(id);
}
