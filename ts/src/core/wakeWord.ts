// Optional hands-free start: the word «Чаво» spoken into the microphone starts a take, as the hold key
// does. Entirely local and off by default. No keyword model: a cheap energy gate finds the start of each
// utterance, and only its first ~1.6 s go through the speech model that is already open for dictation;
// the text must begin with the address «Чаво» (the same word that makes a take a Brain command).
// Pure: the recognizer comes in as `probe`, audio as 16 kHz chunks, the result goes to `onWake`.

export const WAKE_RATE = 16000;
const WINDOW = 512; // 32 ms

// The Brain address spelling (brain.ts AddressInner) plus the endings the model gives for the word alone
// («Чавы.», «Чаву»), only at the very start.
const WordRight = '(?![\\p{L}\\p{N}_])';
const LeadingWake = new RegExp(`^[\\s«"'(—–-]*(?:ч[аеоё]в[оаыу]|chawo|chavo)${WordRight}[\\s,.:;!?…—–»"')-]*`, 'iu');

/** «Чаво, переведи» → { rest: 'переведи' }; text that does not start with the word → null. */
export function matchWake(text: string): { rest: string } | null {
  const m = LeadingWake.exec(text);
  if (!m) return null;
  return { rest: text.slice(m[0].length).trim() };
}

export interface WakeOptions {
  /** Audio kept from before the energy gate opened (default 400 ms), so the first syllable is not cut. */
  preRollMs?: number;
  /** Pause that ends an utterance (default 450 ms). */
  endSilenceMs?: number;
  /** The probe runs once this much speech is collected, or earlier when the utterance ends (default 1600 ms). */
  probeMs?: number;
  /** Shorter bursts (clicks, a cough) are never probed (default 250 ms). */
  minSpeechMs?: number;
  /** An utterance still going after this long is dropped without a probe result (default 12 s). */
  maxUtteranceMs?: number;
}

export interface WakeHit {
  /** Pre-roll + everything heard of this utterance until the probe answered. */
  audio: Float32Array;
  /** The probe text and what followed the word in it. */
  text: string;
  rest: string;
  /** Heard after the phrase ended while the probe ran (the start of the dictation after «Чаво» and a pause). */
  after: Float32Array;
  /**
   * True when the utterance was only the word followed by a pause: start a fresh take.
   * (Seed it with `after`, so speech that began while the probe was running is not lost.)
   * False: the phrase goes on («Чаво, переведи …») — the take continues from `audio`.
   */
  wordOnly: boolean;
}

type Phase = 'quiet' | 'speech' | 'probing' | 'skip' | 'handedOff';

/**
 * Streaming detector. `push` is sync and cheap; at most one probe per utterance runs at a time. After a
 * hit the detector stays silent (`handedOff`) until the owner calls `resume()` once the take is over.
 */
export class WakeDetector {
  private readonly preRoll: number;
  private readonly endSilence: number;
  private readonly probeAt: number;
  private readonly minSpeech: number;
  private readonly maxUtterance: number;
  private ring: Float32Array;
  private ringFill = 0;
  private carry = new Float32Array(WINDOW);
  private carryFill = 0;
  private floorDb = Number.NaN;
  private phase: Phase = 'quiet';
  private chunks: Float32Array[] = [];
  private afterChunks: Float32Array[] = [];
  private collected = 0;
  private speechSamples = 0;
  private silentSamples = 0;
  private ended = false;
  private epoch = 0;
  /** Probes run so far (tests, log). */
  probes = 0;

  constructor(
    private readonly probe: (pcm: Float32Array) => Promise<string | null>,
    private readonly onWake: (hit: WakeHit) => void,
    opts: WakeOptions = {},
  ) {
    const ms = (v: number) => Math.round((WAKE_RATE * v) / 1000);
    this.preRoll = ms(opts.preRollMs ?? 400);
    this.endSilence = ms(opts.endSilenceMs ?? 450);
    this.probeAt = ms(opts.probeMs ?? 1600);
    this.minSpeech = ms(opts.minSpeechMs ?? 250);
    this.maxUtterance = ms(opts.maxUtteranceMs ?? 12_000);
    this.ring = new Float32Array(this.preRoll);
  }

  get state(): Phase {
    return this.phase;
  }

  /** After a hit (or a pause from outside): listen again from silence. */
  resume(): void {
    this.epoch++;
    this.phase = 'quiet';
    this.chunks = [];
    this.collected = 0;
    this.speechSamples = 0;
    this.silentSamples = 0;
    this.ended = false;
    this.ringFill = 0;
    this.carryFill = 0;
  }

  /** Stop reacting until `resume()` (another take is running). */
  hold(): void {
    this.epoch++;
    this.phase = 'handedOff';
    this.chunks = [];
    this.collected = 0;
  }

  push(chunk: ArrayLike<number>): void {
    if (this.phase === 'handedOff') return;
    for (let i = 0; i < chunk.length; i++) {
      const v = Number(chunk[i]);
      this.carry[this.carryFill++] = Number.isFinite(v) ? v : 0;
      if (this.carryFill === WINDOW) {
        this.carryFill = 0;
        this.window(this.carry);
        if ((this.phase as Phase) === 'handedOff') return;
      }
    }
  }

  private isSpeech(w: Float32Array): boolean {
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
    const db = 20 * Math.log10(Math.max(Math.sqrt(sum / w.length), 1e-7));
    if (Number.isNaN(this.floorDb)) this.floorDb = db;
    const speech = db > -55 && (db > this.floorDb + 10 || db > -30);
    // Same floor rule as SilenceWatch: drops at once, creeps up ~1.5 dB/s so steady noise becomes the floor.
    this.floorDb = Math.min(db, this.floorDb + 0.05);
    return speech;
  }

  private remember(w: Float32Array): void {
    if (this.preRoll === 0) return;
    if (this.ringFill + w.length > this.preRoll) {
      const keep = Math.max(0, this.preRoll - w.length);
      this.ring.copyWithin(0, this.ringFill - keep, this.ringFill);
      this.ringFill = keep;
    }
    this.ring.set(w.subarray(Math.max(0, w.length - this.preRoll)), this.ringFill);
    this.ringFill = Math.min(this.preRoll, this.ringFill + w.length);
  }

  private window(w: Float32Array): void {
    const speech = this.isSpeech(w);
    switch (this.phase) {
      case 'quiet':
        if (!speech) {
          this.remember(w);
          return;
        }
        this.phase = 'speech';
        this.chunks = [this.ring.slice(0, this.ringFill)];
        this.collected = this.ringFill;
        this.ringFill = 0;
        this.speechSamples = 0;
        this.silentSamples = 0;
        this.ended = false;
        this.add(w, speech);
        return;
      case 'speech':
        this.add(w, speech);
        if (this.silentSamples >= this.endSilence) {
          if (this.speechSamples < this.minSpeech) {
            this.toQuiet();
            return;
          }
          this.ended = true;
          this.startProbe();
        } else if (this.speechSamples >= this.probeAt) this.startProbe();
        return;
      case 'probing':
        if (!this.ended) {
          this.add(w, speech);
          if (this.silentSamples >= this.endSilence) this.ended = true;
          if (this.collected >= this.maxUtterance) this.phase = 'skip';
        } else if (this.afterChunks.length * WINDOW < this.maxUtterance) {
          this.afterChunks.push(w.slice());
          this.track(speech);
        }
        return;
      case 'skip':
        this.track(speech);
        if (this.silentSamples >= this.endSilence) this.toQuiet();
        return;
    }
  }

  private track(speech: boolean): void {
    if (speech) {
      this.speechSamples += WINDOW;
      this.silentSamples = 0;
    } else this.silentSamples += WINDOW;
  }

  private add(w: Float32Array, speech: boolean): void {
    this.chunks.push(w.slice());
    this.collected += w.length;
    this.track(speech);
  }

  /** Whether the audio heard after the phrase ends in speech that is still going (silentSamples counts the tail). */
  private speechTail(after: Float32Array[]): boolean {
    return after.length > 0 && this.silentSamples < this.endSilence;
  }

  /** A miss with a new phrase already under way: treat that audio as the start of the next phrase. */
  private restartFrom(after: Float32Array[]): void {
    this.phase = 'quiet';
    this.ringFill = 0;
    this.speechSamples = 0;
    this.silentSamples = 0;
    for (const w of after) this.window(w);
  }

  private toQuiet(): void {
    this.phase = 'quiet';
    this.chunks = [];
    this.collected = 0;
    this.ringFill = 0;
  }

  private joined(): Float32Array {
    const out = new Float32Array(this.collected);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  private startProbe(): void {
    this.phase = 'probing';
    this.afterChunks = [];
    this.probes++;
    const epoch = this.epoch;
    const clip = this.joined();
    void this.probe(clip).then(
      (text) => this.answered(epoch, text ?? ''),
      () => this.answered(epoch, ''),
    );
  }

  private answered(epoch: number, text: string): void {
    if (epoch !== this.epoch || this.phase !== 'probing') return;
    const m = matchWake(text);
    if (!m) {
      // Not for us: wait for the end of this utterance, then listen again.
      // Speech that started after the phrase ended while the probe ran is a new phrase: check it too.
      const after = this.afterChunks;
      this.afterChunks = [];
      if (!this.ended) this.phase = 'skip';
      else if (after.length > 0 && this.speechTail(after)) this.restartFrom(after);
      else this.toQuiet();
      return;
    }
    const after = this.afterChunks;
    this.afterChunks = [];
    const hit: WakeHit = { audio: this.joined(), after: concat(after), text, rest: m.rest, wordOnly: this.ended && m.rest.length === 0 };
    this.hold();
    this.onWake(hit);
  }
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
