// Voice activity detection: Silero VAD v5 (ONNX, through the onnxruntime-node the recognizer already
// uses) with a pure-JS energy fallback, so every function here also works without the model file.
// The model is never loaded from here: the caller passes a frame scorer (a real ORT session wrapped
// by `sileroScorer`, or a fake in tests). Segment rules follow silero-vad `get_speech_timestamps`.

import * as ort from 'onnxruntime-node';
import { resample } from './audio';

export const VAD_RATE = 16000;
/** New samples per Silero v5 window at 16 kHz. */
export const VAD_WINDOW = 512;
/** Tail of the previous window prepended to every input (v5 needs it). */
export const VAD_CONTEXT = 64;
export const VAD_INPUT = VAD_WINDOW + VAD_CONTEXT; // 576
/** One stream's recurrent state: [2, 1, 128]. */
export const VAD_STATE = 2 * 128;
export const VAD_WINDOW_SECONDS = VAD_WINDOW / VAD_RATE; // 0.032

export interface SpeechSegment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
}

export interface VadOptions {
  /** Speech starts at prob ≥ threshold (Silero default 0.5). */
  threshold?: number;
  /** Speech ends below this (default threshold − 0.15). */
  negThreshold?: number;
  /** Shorter bursts are dropped (default 250 ms). */
  minSpeechMs?: number;
  /** A pause must last this long to end a segment (default 100 ms). */
  minSilenceMs?: number;
  /** Padding added on both sides of every segment (default 30 ms). */
  speechPadMs?: number;
}

/**
 * Scores `batch` independent windows at once. `input` is batch × 576 samples (64 context + 512 new),
 * `state` is the [2, batch, 128] recurrent state. Returns one speech probability per window and the
 * next state. Sync or async: a fake in tests, `sileroScorer` in the app.
 */
export type FrameScorer = (
  input: Float32Array,
  state: Float32Array,
  batch: number,
) => { probs: ArrayLike<number>; state: Float32Array } | Promise<{ probs: ArrayLike<number>; state: Float32Array }>;

/** The part of ort.InferenceSession the scorer needs (tests can fake it). */
export interface VadSessionLike {
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, { data: unknown }>>;
}

/** Silero v5 ONNX: inputs `input` [B,576], `state` [2,B,128], `sr` int64 scalar; outputs `output` [B,1], `stateN`. */
export function sileroScorer(session: VadSessionLike): FrameScorer {
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_RATE)]), []);
  return async (input, state, batch) => {
    const out = await session.run({
      input: new ort.Tensor('float32', input, [batch, VAD_INPUT]),
      state: new ort.Tensor('float32', state, [2, batch, 128]),
      sr,
    });
    const probs = out.output?.data as ArrayLike<number> | undefined;
    const next = out.stateN?.data as ArrayLike<number> | undefined;
    if (!probs || probs.length < batch || !next || next.length !== state.length) throw new Error('Silero VAD: unexpected output');
    return { probs, state: next instanceof Float32Array ? next : Float32Array.from(next) };
  };
}

function to16k(pcm: Float32Array, rate: number): Float32Array {
  return rate === VAD_RATE ? pcm : resample(pcm, rate, VAD_RATE);
}

function windowCount(n: number): number {
  return Math.ceil(n / VAD_WINDOW);
}

/**
 * Silero probability per 512-sample window (32 ms) of 16 kHz audio (other rates are resampled).
 * Long audio is cut into `lanes` contiguous streams scored as one batch (each lane starts with a fresh
 * state, which costs a few windows of accuracy at its start and makes an hour-long file ~3× faster).
 */
export async function speechProbabilities(
  pcm: Float32Array,
  scorer: FrameScorer,
  rate = VAD_RATE,
  opts: { lanes?: number; signal?: AbortSignal } = {},
): Promise<Float32Array> {
  const x = to16k(pcm, rate);
  const windows = windowCount(x.length);
  const probs = new Float32Array(windows);
  if (windows === 0) return probs;
  const lanes = Math.max(1, Math.min(opts.lanes ?? 1, windows));
  const per = Math.ceil(windows / lanes);
  let state: Float32Array = new Float32Array(2 * lanes * 128);
  const context = new Float32Array(lanes * VAD_CONTEXT);
  const input = new Float32Array(lanes * VAD_INPUT);
  for (let step = 0; step < per; step++) {
    if (opts.signal?.aborted) {
      const e = new Error('Operation canceled');
      e.name = 'AbortError';
      throw e;
    }
    input.fill(0);
    for (let b = 0; b < lanes; b++) {
      const base = b * VAD_INPUT;
      input.set(context.subarray(b * VAD_CONTEXT, (b + 1) * VAD_CONTEXT), base);
      const w = b * per + step;
      if (w < windows) {
        const from = w * VAD_WINDOW;
        const to = Math.min(x.length, from + VAD_WINDOW);
        input.set(x.subarray(from, to), base + VAD_CONTEXT);
      }
      context.set(input.subarray(base + VAD_INPUT - VAD_CONTEXT, base + VAD_INPUT), b * VAD_CONTEXT);
    }
    const r = await scorer(input.slice(), state, lanes);
    state = r.state;
    for (let b = 0; b < lanes; b++) {
      const w = b * per + step;
      if (w < windows) probs[w] = clamp01(Number(r.probs[b]));
    }
  }
  return probs;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Pure-JS stand-in for Silero: a pseudo-probability per 512-sample window from its loudness against
 * the recording's own floor (10th percentile). Threshold = floor + 12 dB, kept within −50…−25 dBFS:
 * digital silence and a steady quiet hiss read as non-speech, anything clearly louder as speech.
 */
export function energyProbabilities(pcm: Float32Array, rate = VAD_RATE): Float32Array {
  const x = to16k(pcm, rate);
  const windows = windowCount(x.length);
  const db = new Float32Array(windows);
  for (let w = 0; w < windows; w++) {
    const from = w * VAD_WINDOW;
    const to = Math.min(x.length, from + VAD_WINDOW);
    let sum = 0;
    for (let i = from; i < to; i++) sum += x[i] * x[i];
    db[w] = 20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(1, to - from)), 1e-7));
  }
  const probs = new Float32Array(windows);
  if (windows === 0) return probs;
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor((windows - 1) * 0.1)];
  const thr = Math.min(-25, Math.max(-50, floor + 12));
  for (let w = 0; w < windows; w++) probs[w] = 1 / (1 + Math.exp(-(db[w] - thr) / 2));
  return probs;
}

/** get_speech_timestamps over window probabilities. `samples` is the 16 kHz length the probs cover. */
export function probsToSegments(probs: ArrayLike<number>, samples: number, opts: VadOptions = {}): SpeechSegment[] {
  const threshold = opts.threshold ?? 0.5;
  const neg = opts.negThreshold ?? Math.max(0.01, threshold - 0.15);
  const minSpeech = (VAD_RATE * (opts.minSpeechMs ?? 250)) / 1000;
  const minSilence = (VAD_RATE * (opts.minSilenceMs ?? 100)) / 1000;
  const pad = Math.trunc((VAD_RATE * (opts.speechPadMs ?? 30)) / 1000);
  const raw: { start: number; end: number }[] = [];
  let triggered = false;
  let start = 0;
  let tempEnd = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    const at = i * VAD_WINDOW;
    if (p >= threshold && tempEnd) tempEnd = 0;
    if (p >= threshold && !triggered) {
      triggered = true;
      start = at;
      continue;
    }
    if (p < neg && triggered) {
      if (!tempEnd) tempEnd = at;
      if (at - tempEnd < minSilence) continue;
      if (tempEnd - start > minSpeech) raw.push({ start, end: tempEnd });
      triggered = false;
      tempEnd = 0;
    }
  }
  if (triggered && samples - start > minSpeech) raw.push({ start, end: samples });
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (i === 0) s.start = Math.max(0, s.start - pad);
    if (i < raw.length - 1) {
      const next = raw[i + 1];
      const gap = next.start - s.end;
      if (gap < 2 * pad) {
        s.end += Math.floor(gap / 2);
        next.start = Math.max(0, next.start - Math.floor(gap / 2));
      } else {
        s.end = Math.min(samples, s.end + pad);
        next.start = Math.max(0, next.start - pad);
      }
    } else {
      s.end = Math.min(samples, s.end + pad);
    }
  }
  return raw.map((s) => ({ start: s.start / VAD_RATE, end: s.end / VAD_RATE }));
}

function samples16k(pcm: Float32Array, rate: number): number {
  return rate === VAD_RATE ? pcm.length : Math.max(pcm.length > 0 ? 1 : 0, Math.floor((pcm.length * VAD_RATE) / rate));
}

/**
 * Speech segments in seconds. Sync: pass `probs` from `speechProbabilities` (Silero) or leave it out
 * for the energy fallback.
 */
export function segments(pcm: Float32Array, rate = VAD_RATE, opts: VadOptions & { probs?: ArrayLike<number> } = {}): SpeechSegment[] {
  const probs = opts.probs ?? energyProbabilities(pcm, rate);
  return probsToSegments(probs, samples16k(pcm, rate), opts);
}

/**
 * Cuts leading and trailing non-speech, keeping `padMs` (default 100 ms) around the speech. No speech
 * found → the original audio. Times are seconds into the original.
 */
export function trimSpeech(
  pcm: Float32Array,
  rate = VAD_RATE,
  opts: VadOptions & { probs?: ArrayLike<number>; segments?: readonly SpeechSegment[]; padMs?: number } = {},
): { samples: Float32Array; start: number; end: number } {
  const total = pcm.length / rate;
  const segs = opts.segments ?? segments(pcm, rate, opts);
  if (segs.length === 0) return { samples: pcm, start: 0, end: total };
  const pad = (opts.padMs ?? 100) / 1000;
  const start = Math.max(0, segs[0].start - pad);
  const end = Math.min(total, segs[segs.length - 1].end + pad);
  const from = Math.max(0, Math.min(pcm.length, Math.floor(start * rate)));
  const to = Math.max(from, Math.min(pcm.length, Math.ceil(end * rate)));
  if (from === 0 && to === pcm.length) return { samples: pcm, start: 0, end: total };
  return { samples: pcm.slice(from, to), start: from / rate, end: to / rate };
}

/**
 * Midpoints (seconds) of non-speech gaps of at least `minGapSeconds` between, before and after the
 * speech segments. Drop-in for `silences()` in `chunkBounds`, so a cut never lands inside speech.
 */
export function pauseMidpoints(
  pcm: Float32Array,
  rate = VAD_RATE,
  opts: VadOptions & { probs?: ArrayLike<number>; segments?: readonly SpeechSegment[]; minGapSeconds?: number } = {},
): number[] {
  const segs = opts.segments ?? segments(pcm, rate, opts);
  return gapMidpoints(segs, pcm.length / rate, opts.minGapSeconds ?? 0.3);
}

export function gapMidpoints(segs: readonly SpeechSegment[], total: number, minGap = 0.3): number[] {
  if (segs.length === 0) return [];
  const out: number[] = [];
  let prev = 0;
  for (const s of segs) {
    if (s.start - prev >= minGap) out.push((prev + s.start) / 2);
    prev = Math.max(prev, s.end);
  }
  if (total - prev >= minGap) out.push((prev + total) / 2);
  return out;
}

/** Lanes for a long file: one per minute of audio, at most 16. */
export function lanesFor(samplesAt16k: number): number {
  return Math.max(1, Math.min(16, Math.floor(samplesAt16k / (60 * VAD_RATE))));
}

/**
 * One VAD: Silero when a scorer is given, the energy fallback otherwise. Async because ORT is.
 */
export class Vad {
  constructor(
    private readonly scorer: FrameScorer | null = null,
    readonly opts: VadOptions = {},
  ) {}

  /** True when backed by the Silero model (not the energy fallback). */
  get silero(): boolean {
    return this.scorer !== null;
  }

  async probabilities(pcm: Float32Array, rate = VAD_RATE, signal?: AbortSignal): Promise<Float32Array> {
    if (!this.scorer) return energyProbabilities(pcm, rate);
    return speechProbabilities(pcm, this.scorer, rate, { lanes: lanesFor(samples16k(pcm, rate)), signal });
  }

  async segments(pcm: Float32Array, rate = VAD_RATE, signal?: AbortSignal): Promise<SpeechSegment[]> {
    return segments(pcm, rate, { ...this.opts, probs: await this.probabilities(pcm, rate, signal) });
  }

  async trimSpeech(pcm: Float32Array, rate = VAD_RATE, padMs = 100): Promise<{ samples: Float32Array; start: number; end: number }> {
    return trimSpeech(pcm, rate, { padMs, segments: await this.segments(pcm, rate) });
  }

  async pauseMidpoints(pcm: Float32Array, rate = VAD_RATE, minGapSeconds = 0.3, signal?: AbortSignal): Promise<number[]> {
    return gapMidpoints(await this.segments(pcm, rate, signal), pcm.length / rate, minGapSeconds);
  }
}

/**
 * Streaming trailing-silence detector for auto-stop. Energy only (sync, cheap on every capture
 * chunk): a 32 ms window is speech when it is above −55 dBFS and 10 dB over the running noise floor
 * (or simply louder than −30 dBFS).
 * `push` returns true once, when `limitMs` of non-speech followed some speech.
 */
export class SilenceWatch {
  private carry = new Float32Array(VAD_WINDOW);
  private filled = 0;
  private floorDb = Number.NaN;
  private silentWindows = 0;
  private heard = false;
  private fired = false;

  constructor(
    readonly limitMs: number,
    private readonly rate = VAD_RATE,
  ) {}

  get speechHeard(): boolean {
    return this.heard;
  }

  /** Trailing non-speech so far, ms. */
  get trailingMs(): number {
    return (this.silentWindows * VAD_WINDOW * 1000) / this.rate;
  }

  push(chunk: ArrayLike<number>): boolean {
    if (this.fired || this.limitMs <= 0) return false;
    for (let i = 0; i < chunk.length; i++) {
      const v = Number(chunk[i]);
      this.carry[this.filled++] = Number.isFinite(v) ? v : 0;
      if (this.filled === VAD_WINDOW) {
        this.filled = 0;
        this.window();
        if (this.heard && this.trailingMs >= this.limitMs) {
          this.fired = true;
          return true;
        }
      }
    }
    return false;
  }

  private window(): void {
    let sum = 0;
    for (let i = 0; i < VAD_WINDOW; i++) sum += this.carry[i] * this.carry[i];
    const db = 20 * Math.log10(Math.max(Math.sqrt(sum / VAD_WINDOW), 1e-7));
    if (Number.isNaN(this.floorDb)) this.floorDb = db;
    const speech = db > -55 && (db > this.floorDb + 10 || db > -30);
    // floor: drops at once, creeps up 0.05 dB per window (~1.5 dB/s) so steady noise becomes the floor
    this.floorDb = Math.min(db, this.floorDb + 0.05);
    if (speech) {
      this.heard = true;
      this.silentWindows = 0;
    } else {
      this.silentWindows++;
    }
  }
}
