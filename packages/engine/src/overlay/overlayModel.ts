// The floating pill's state, without Electron: port of the state logic in src/App/OverlayWindow.xaml.cs
// (ShowListening / ShowRecognizing / ShowPartial / ShowHint / ShowCaption / ShowStatus / HideNow / Tail).
// overlayWindow.ts renders it in a frameless always-on-top window that never takes focus; the
// DictationSession drives it through OverlaySink. Dark pill only: the app has no light theme.

import { t } from '@chawo/core/strings';

/** What DictationSession calls on the pill (OverlayWindow's public surface). */
export interface OverlaySink {
  showListening(): void;
  showRecognizing(): void;
  showPartial(text: string): void;
  showStatus(text: string): void;
  showHint(text: string): void;
  showCaption(text: string, ms?: number): void;
  hideNow(): void;
}

/**
 * listening: bars jump with the voice, live line under them.
 * recognizing: calm ripple, the last live line stays.
 * text: a hint or a status instead of the bars.
 */
export type OverlayMode = 'listening' | 'recognizing' | 'text';

export interface OverlayState {
  visible: boolean;
  mode: OverlayMode;
  /** Hint or status text (mode 'text'). */
  label: string;
  /** Caption next to the bars while listening, e.g. "120 characters selected". */
  caption: string;
  /** Live draft line under the bars; empty = hidden. */
  live: string;
}

export const HINT_MS = 2200;
export const CAPTION_MS = 2500;
const LIVE_MAX = 280;

/** Last 280 chars of a draft, with an ellipsis in front when cut (OverlayWindow.Tail). */
export function tail(text: string): string {
  const s = text.trim();
  if (s.length <= LIVE_MAX) return s;
  return '…' + s.slice(s.length - (LIVE_MAX - 1));
}

export interface OverlayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
}

export class OverlayModel implements OverlaySink {
  private s: OverlayState = { visible: false, mode: 'text', label: '', caption: '', live: '' };
  private hintSerial = 0;
  private captionSerial = 0;
  private readonly timers: OverlayTimers;

  constructor(
    private readonly onChange: (state: OverlayState) => void = () => {},
    timers?: OverlayTimers,
  ) {
    this.timers = timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms) };
  }

  get state(): OverlayState {
    return { ...this.s };
  }

  private set(next: Partial<OverlayState>): void {
    this.s = { ...this.s, ...next };
    this.onChange(this.state);
  }

  private get active(): boolean {
    return this.s.visible && (this.s.mode === 'listening' || this.s.mode === 'recognizing');
  }

  showListening(): void {
    this.hintSerial++;
    this.captionSerial++;
    this.set({ visible: true, mode: 'listening', label: '', caption: '', live: t('Слушаю…', 'Listening…') });
  }

  /** Recording is over, the model is working: bars keep moving with a calm ripple. */
  showRecognizing(): void {
    this.set({ visible: true, mode: 'recognizing', caption: '' });
  }

  hideNow(): void {
    this.set({ visible: false, live: '', caption: '' });
  }

  /** Draft from a pass over the audio so far. Not the text that will be inserted. Empty keeps the previous line. */
  showPartial(text: string): void {
    if (!this.active) return;
    const shown = tail(text);
    if (shown.length === 0) return;
    this.set({ live: shown });
  }

  /** A short message (e.g. "heard nothing") that hides after a moment. */
  showHint(text: string): void {
    this.showText(text);
    const mine = ++this.hintSerial;
    this.timers.setTimeout(() => {
      // A new take may have started meanwhile; only the latest hint may hide the pill.
      if (mine === this.hintSerial && this.s.mode === 'text') this.set({ visible: false });
    }, HINT_MS);
  }

  /** A caption next to the wave while listening; goes away by itself. */
  showCaption(text: string, ms = CAPTION_MS): void {
    if (!(this.s.visible && this.s.mode === 'listening')) return;
    const mine = ++this.captionSerial;
    this.set({ caption: text });
    this.timers.setTimeout(() => {
      if (mine !== this.captionSerial || this.s.mode !== 'listening') return;
      this.set({ caption: '' });
    }, ms);
  }

  /** A message that stays until the next state, e.g. "Starting the Brain… 12s". */
  showStatus(text: string): void {
    this.hintSerial++;
    this.showText(text);
  }

  private showText(text: string): void {
    this.captionSerial++;
    this.set({ visible: true, mode: 'text', label: text, caption: '', live: '' });
  }
}

const BOTTOM_GAP = 40;

function clampTo(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** OverlayWindow.Place without the caret: pinned top-left or bottom centre, clamped to the work area. */
export function overlayPosition(
  area: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
  pinned: { x: number; y: number } | null,
): { x: number; y: number } {
  let x = pinned ? pinned.x : Math.round(area.x + area.width / 2 - width / 2);
  let y = pinned ? pinned.y : area.y + area.height - height - BOTTOM_GAP;
  x = clampTo(x, area.x, Math.max(area.x, area.x + area.width - width));
  y = clampTo(y, area.y, Math.max(area.y, area.y + area.height - height));
  return { x, y };
}
