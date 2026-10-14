// «Начинать запись по слову «Чаво»»: the always-on microphone stream from the window goes through the
// WakeDetector; a hit starts a 'wake' take in the DictationSession and the same stream then feeds that
// take until it ends by itself (pause) or is cancelled (Escape, Stop). Takes started by the key or the
// button pause the detector. Local only: the probe is the session's own recognizer, never the network.

import { WakeDetector, type WakeHit, type WakeOptions } from '../../core/wakeWord';
import type { SettingsData } from '../settings';
import type { DictatePhase } from './dictationPage';
import * as Log from '../log';

/** The part of DictationSession the listener drives (tests: the real session with a fake recognizer). */
export interface WakeSessionLike {
  readonly phase: DictatePhase;
  readonly isBusy: boolean;
  startTake(source: 'wake'): { ok: boolean };
  appendPcm(chunk: ArrayLike<number>): void;
  probeWake(samples: Float32Array): Promise<string | null>;
}

/** One chunk is ~640 samples; anything far bigger is not from our worklet. */
const MAX_CHUNK = 16000;

export class WakeListener {
  private readonly detector: WakeDetector;
  private wakeTake = false;
  /** Hits so far (tests, log). */
  hits = 0;

  constructor(
    private readonly session: WakeSessionLike,
    private readonly settings: () => SettingsData,
    opts: WakeOptions & { started?: (hit: WakeHit) => void } = {},
  ) {
    this.detector = new WakeDetector((pcm) => this.session.probeWake(pcm), (hit) => this.onWake(hit, opts.started), opts);
  }

  /** The window should keep the microphone open for the word: on, and recognition is local. */
  wanted(s: SettingsData = this.settings()): boolean {
    return s.WakeWord && s.NetworkRole !== 'Client';
  }

  /** A «Чаво» take is running and fed from the word's microphone stream. */
  get inTake(): boolean {
    return this.wakeTake;
  }

  get listening(): boolean {
    return this.wanted() && !this.wakeTake && !this.session.isBusy;
  }

  push(chunk: unknown): void {
    if (!(chunk instanceof Float32Array) || chunk.length > MAX_CHUNK) return;
    if (this.wakeTake) {
      if (this.session.phase === 'Listening') {
        this.session.appendPcm(chunk);
        return;
      }
      // The take ended (pause, Escape, Stop): listen for the word again from silence.
      this.wakeTake = false;
      this.detector.resume();
    }
    if (!this.wanted()) return;
    if (this.session.isBusy) {
      // A take from the key or the button (or its recognition): not ours, and the word must not fire in it.
      if (this.detector.state !== 'handedOff') this.detector.hold();
      return;
    }
    if (this.detector.state === 'handedOff') this.detector.resume();
    this.detector.push(chunk);
  }

  private onWake(hit: WakeHit, started?: (hit: WakeHit) => void): void {
    if (!this.wanted() || this.session.isBusy) {
      this.detector.resume();
      return;
    }
    const r = this.session.startTake('wake');
    if (!r.ok) {
      this.detector.resume();
      return;
    }
    this.hits++;
    this.wakeTake = true;
    // Only the length goes to the log, never the words.
    Log.write(`wake word: take started (${hit.wordOnly ? 'word only' : 'phrase goes on'}, ${(hit.audio.length / 16000).toFixed(1)} s heard)`);
    // «Чаво, переведи…» in one breath: the take starts with what was already said (a Brain command).
    // «Чаво» and a pause: a fresh take, the word itself is not part of it.
    if (!hit.wordOnly) this.session.appendPcm(hit.audio);
    started?.(hit);
  }
}

export interface WakeStopper {
  stopTake(): Promise<unknown>;
}

/** The word was switched off (or the role changed) during a «Чаво» take: finish it with what was heard. */
export function finishWakeTake(listener: WakeListener, session: WakeSessionLike & WakeStopper): void {
  if (listener.inTake && session.phase === 'Listening') void session.stopTake();
}
