// Sample accumulator and VU meter for one dictation take. Port of the platform-neutral part of
// src/App/Recorder.cs (Append / Level / TakePeak / Snapshot / StopAsync) plus the take checks from
// App.xaml.cs (MinTakeSamples, SilenceFloor, HasSpeechDynamics, quiet-take gain). The Windows
// waveIn/WASAPI backends are not ported: in Electron the renderer captures with getUserMedia and an
// AudioWorklet and sends 16 kHz mono float chunks here.

export const SAMPLE_RATE = 16000;

/** A take longer than this is stopped by itself: the key is stuck or the hook died. */
export const MAX_TAKE_SECONDS = 5 * 60;
export const MAX_TAKE_SAMPLES = MAX_TAKE_SECONDS * SAMPLE_RATE;

/** Takes shorter than this are treated as an accidental key press (App.MinTakeSamples). */
export const MIN_TAKE_SAMPLES = SAMPLE_RATE / 4;

/** Peak below this (about -75 dBFS) is digital silence: nothing reached the input at all. */
export const SILENCE_FLOOR = 0.0002;

/** Quiet takes are scaled up to this peak before recognition; the model expects normal speech levels. */
export const TARGET_PEAK = 0.5;
export const MAX_GAIN = 200;

/**
 * The display meter adapts to the input: it tracks the noise floor and the loudest recent buffer and
 * stretches the bars between them, so a quiet line-level receiver and a hot USB microphone both fill
 * the wave. Recognition uses its own gain; this is display only.
 */
export const METER_MIN_SPAN_DB = 15; // never stretch a span narrower than this
export const METER_FLOOR_RISE_DB = 0.2; // noise floor creeps up this much per 40 ms buffer (5 dB/s)
export const METER_PEAK_FALL_DB = 0.4; // ceiling falls this much per buffer (10 dB/s)

const BLOCK = SAMPLE_RATE * 10; // storage grows in 10 s blocks, no per-sample array pushes

export class TakeBuffer {
  private blocks: Float32Array[] = [];
  private count = 0;
  private levelSinceRead = 0;
  private peak = 0;
  private capHit = false;
  private noiseDb = Number.NaN;
  private peakDb = Number.NaN;
  private recording = false;

  /** Called once when the take reaches MAX_TAKE_SAMPLES. Samples keep coming until stop(). */
  onTakeTooLong: (() => void) | null = null;

  constructor(private readonly maxSamples = MAX_TAKE_SAMPLES) {}

  get isRecording(): boolean {
    return this.recording;
  }

  /** Samples collected so far in this take. */
  get length(): number {
    return this.count;
  }

  get seconds(): number {
    return this.count / SAMPLE_RATE;
  }

  /** Loudest absolute sample of the current take, 0..1. */
  get takePeak(): number {
    return this.peak;
  }

  /** Loudness of the buffers since the last read, 0..1, shaped for a VU-style display. Reading resets it. */
  get level(): number {
    const p = this.levelSinceRead;
    this.levelSinceRead = 0;
    return p;
  }

  /** Begins a new take: forgets the previous one and resets the meter (Recorder.StartAsync). */
  start(): void {
    this.reset();
    this.recording = true;
  }

  /** Adds one capture buffer. Ignored when no take is running (a late chunk after stop). */
  append(chunk: ArrayLike<number>): void {
    if (!this.recording) return;
    const n = chunk.length;
    if (n === 0) return;
    let sum = 0;
    let peak = this.peak;
    for (let i = 0; i < n; i++) {
      let v = Number(chunk[i]);
      if (!Number.isFinite(v)) v = 0;
      this.push(v);
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    this.peak = peak;
    const rms = Math.sqrt(sum / n);
    const db = 20 * Math.log10(Math.max(rms, 1e-7));
    if (Number.isNaN(this.noiseDb)) {
      this.noiseDb = db;
      this.peakDb = db + METER_MIN_SPAN_DB;
    }
    this.noiseDb = Math.min(db, this.noiseDb + METER_FLOOR_RISE_DB); // floor: drops at once, rises slowly
    this.peakDb = Math.max(db, this.peakDb - METER_PEAK_FALL_DB); // ceiling: rises at once, falls slowly
    const span = Math.max(this.peakDb - this.noiseDb, METER_MIN_SPAN_DB);
    const level = Math.min(1, Math.max(0, (db - this.noiseDb) / span));
    this.levelSinceRead = Math.max(this.levelSinceRead, level);
    if (!this.capHit && this.count >= this.maxSamples) {
      this.capHit = true;
      this.onTakeTooLong?.();
    }
  }

  /** A copy of the samples so far. Does not stop the take. */
  snapshot(): Float32Array {
    const out = new Float32Array(this.count);
    let at = 0;
    for (const b of this.blocks) {
      const take = Math.min(b.length, this.count - at);
      if (take <= 0) break;
      out.set(take === b.length ? b : b.subarray(0, take), at);
      at += take;
    }
    return out;
  }

  /** Ends the take and returns everything recorded since start(). takePeak stays readable. */
  stop(): Float32Array {
    const result = this.snapshot();
    this.recording = false;
    this.blocks = [];
    this.count = 0;
    this.levelSinceRead = 0;
    return result;
  }

  /** Drops the take without returning it (cancel). */
  clear(): void {
    this.reset();
    this.recording = false;
  }

  private reset(): void {
    this.blocks = [];
    this.count = 0;
    this.levelSinceRead = 0;
    this.peak = 0;
    this.capHit = false;
    this.noiseDb = Number.NaN;
    this.peakDb = Number.NaN;
  }

  private push(v: number): void {
    const i = this.count % BLOCK;
    if (i === 0 && this.count / BLOCK >= this.blocks.length) this.blocks.push(new Float32Array(BLOCK));
    this.blocks[this.blocks.length - 1][i] = v;
    this.count++;
  }
}

/** True when the take has bursts (speech) rather than a flat floor (silence or hum). App.HasSpeechDynamics. */
export function hasSpeechDynamics(samples: Float32Array): boolean {
  const window = SAMPLE_RATE / 10; // 100 ms
  const minLoudToQuietRatio = 2; // permissive on purpose: a wrong "silence" verdict hides real speech
  const n = Math.floor(samples.length / window);
  if (n < 3) return true; // too short to judge; let the model decide
  const rms = new Float64Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (let i = w * window; i < (w + 1) * window; i++) sum += samples[i] * samples[i];
    rms[w] = Math.sqrt(sum / window);
  }
  rms.sort();
  const quiet = rms[Math.floor(n / 4)] + 1e-7; // lower quartile: the floor
  const loud = rms[n - 1 - Math.floor(n / 20)]; // near the top, ignoring one-off clicks
  return loud / quiet > minLoudToQuietRatio;
}

/** Silence verdict App.HandleReleaseAsync uses before recognition. */
export function isSilentTake(samples: Float32Array, peak: number): boolean {
  return peak < SILENCE_FLOOR || !hasSpeechDynamics(samples);
}

/** Scales a quiet take up to TARGET_PEAK (gain capped at MAX_GAIN), in place. Returns the gain used. */
export function normalizeQuietTake(samples: Float32Array, peak: number): number {
  if (!(peak > 0) || peak >= TARGET_PEAK) return 1;
  const gain = Math.min(TARGET_PEAK / peak, MAX_GAIN);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return gain;
}
