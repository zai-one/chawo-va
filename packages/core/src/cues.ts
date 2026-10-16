// Short sound cues for a dictation take and the tray state, without Electron. With a hold hotkey the
// user often looks at another app, so a soft tone says "recording now" and "got it". The tones are
// synthesised in the renderer (Web Audio), so no sound files ship and nothing is fetched.
// Port of nothing in WPF: idea from voxtype / VoiceInk (ts/IDEAS.md №7).

import { t } from './strings';

/** start: recording began; stop: released, recognizing; cancel: the take was dropped (Esc, too short, silence). */
export type CueKind = 'start' | 'stop' | 'cancel';

/** Phase names as DictationSession reports them (DictatePhase), kept as strings to stay Electron-free. */
export type CuePhase = 'NoModel' | 'Idle' | 'Listening' | 'Recognizing';

/** Which cue a phase change deserves; null = stay quiet. */
export function cueForTransition(prev: CuePhase, next: CuePhase): CueKind | null {
  if (prev === next) return null;
  if (next === 'Listening') return 'start';
  if (prev === 'Listening' && next === 'Recognizing') return 'stop';
  if (prev === 'Listening') return 'cancel';
  // Recognizing → Idle is the text arriving: it shows up by itself, no extra beep.
  return null;
}

export interface CueTone {
  /** Hz. */
  freq: number;
  /** Offset from the cue start, ms. */
  at: number;
  /** Length, ms (with a short fade in/out, so no clicks). */
  ms: number;
  /** Peak gain 0..1. */
  gain: number;
}

/** Quiet on purpose: under −20 dBFS and under 0.3 s, so the start tone barely reaches the mic. */
export const CUE_MAX_GAIN = 0.1;

const TONES: Record<CueKind, CueTone[]> = {
  // rising fifth: "go"
  start: [
    { freq: 660, at: 0, ms: 70, gain: 0.08 },
    { freq: 990, at: 75, ms: 90, gain: 0.08 },
  ],
  // falling fifth: "got it"
  stop: [
    { freq: 990, at: 0, ms: 70, gain: 0.07 },
    { freq: 660, at: 75, ms: 100, gain: 0.07 },
  ],
  // one low soft tone: "nothing taken"
  cancel: [{ freq: 330, at: 0, ms: 160, gain: 0.07 }],
};

export function cueTones(kind: CueKind): CueTone[] {
  return TONES[kind].map((t) => ({ ...t }));
}

/** Total length of a cue, ms. */
export function cueLength(kind: CueKind): number {
  return Math.max(...TONES[kind].map((t) => t.at + t.ms));
}

/**
 * Follows the take phase and says which cue to play. The first observed phase only sets the
 * baseline (no beep at app start). `enabled` is read on every change so the checkbox acts at once.
 */
export class CueTracker {
  private last: CuePhase | null = null;

  constructor(private readonly enabled: () => boolean, private readonly play: (kind: CueKind) => void) {}

  observe(phase: CuePhase): void {
    const prev = this.last;
    this.last = phase;
    if (prev === null) return;
    const kind = cueForTransition(prev, phase);
    if (kind && this.enabled()) this.play(kind);
  }
}

/** What the tray says about the take. */
export type TrayState = 'idle' | 'recording' | 'recognizing';

export function trayStateFor(phase: CuePhase): TrayState {
  if (phase === 'Listening') return 'recording';
  if (phase === 'Recognizing') return 'recognizing';
  return 'idle';
}

export function trayTooltip(state: TrayState, base: string): string {
  if (state === 'recording') return `${base} — ${t('идёт запись', 'recording')}`;
  if (state === 'recognizing') return `${base} — ${t('распознаю', 'recognizing')}`;
  return base;
}
