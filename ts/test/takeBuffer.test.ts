import { describe, expect, it } from 'vitest';
import {
  MAX_TAKE_SAMPLES,
  METER_MIN_SPAN_DB,
  MIN_TAKE_SAMPLES,
  SAMPLE_RATE,
  TakeBuffer,
  hasSpeechDynamics,
  isSilentTake,
  normalizeQuietTake,
} from '../src/core/takeBuffer';

const CHUNK = 640; // 40 ms at 16 kHz, what the worklet posts

function tone(n: number, amp: number, freq = 440, phase0 = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * (i + phase0)) / SAMPLE_RATE);
  return out;
}

const db = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-7));

describe('TakeBuffer', () => {
  it('constants match Recorder.cs / App.xaml.cs', () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(MAX_TAKE_SAMPLES).toBe(5 * 60 * 16000);
    expect(MIN_TAKE_SAMPLES).toBe(4000);
  });

  it('collects chunks in order across storage blocks and returns them on stop', () => {
    const b = new TakeBuffer();
    b.start();
    const total = SAMPLE_RATE * 10 + 1234; // crosses the 10 s block boundary
    let written = 0;
    while (written < total) {
      const n = Math.min(CHUNK, total - written);
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) c[i] = ((written + i) % 1000) / 1000;
      b.append(c);
      written += n;
    }
    expect(b.length).toBe(total);
    expect(b.seconds).toBeCloseTo(total / SAMPLE_RATE, 6);
    const snap = b.snapshot();
    expect(snap.length).toBe(total);
    expect(b.isRecording).toBe(true);
    const out = b.stop();
    expect(out.length).toBe(total);
    for (const i of [0, 999, 1000, SAMPLE_RATE * 10 - 1, SAMPLE_RATE * 10, total - 1]) expect(out[i]).toBeCloseTo((i % 1000) / 1000, 6);
    expect(b.isRecording).toBe(false);
    expect(b.length).toBe(0);
  });

  it('ignores chunks when no take is running, and start forgets the previous take', () => {
    const b = new TakeBuffer();
    b.append(tone(CHUNK, 0.5));
    expect(b.length).toBe(0);
    b.start();
    b.append(tone(CHUNK, 0.5));
    b.start();
    expect(b.length).toBe(0);
    expect(b.takePeak).toBe(0);
  });

  it('tracks the loudest absolute sample; takePeak survives stop until the next start', () => {
    const b = new TakeBuffer();
    b.start();
    b.append(Float32Array.from([0.1, -0.7, 0.3]));
    b.append(Float32Array.from([0.2]));
    expect(b.takePeak).toBeCloseTo(0.7, 6);
    b.stop();
    expect(b.takePeak).toBeCloseTo(0.7, 6);
    b.start();
    expect(b.takePeak).toBe(0);
  });

  it('non-finite samples count as silence', () => {
    const b = new TakeBuffer();
    b.start();
    b.append([Number.NaN, Number.POSITIVE_INFINITY, 0.25]);
    expect(Array.from(b.stop())).toEqual([0, 0, 0.25]);
  });

  it('level is consume-on-read and keeps the max since the last read', () => {
    const b = new TakeBuffer();
    b.start();
    b.append(tone(CHUNK, 0.001)); // first buffer sets the floor
    b.append(tone(CHUNK, 0.5));
    b.append(tone(CHUNK, 0.01));
    const first = b.level;
    expect(first).toBeGreaterThan(0.9);
    expect(b.level).toBe(0);
  });

  it('adaptive meter: floor drops at once and rises 0.2 dB per buffer, ceiling rises at once and falls 0.4 dB', () => {
    // Mirror of Recorder.Append with the same constants, checked against the class.
    const amps = [0.001, 0.001, 0.3, 0.3, 0.02, 0.02, 0.02, 0.0005, 0.1, 0.004, 0.004];
    let noise = Number.NaN;
    let peak = Number.NaN;
    const b = new TakeBuffer();
    b.start();
    for (const a of amps) {
      const c = tone(CHUNK, a);
      let sum = 0;
      for (const v of c) sum += v * v;
      const d = db(Math.sqrt(sum / c.length));
      if (Number.isNaN(noise)) { noise = d; peak = d + METER_MIN_SPAN_DB; }
      noise = Math.min(d, noise + 0.2);
      peak = Math.max(d, peak - 0.4);
      const span = Math.max(peak - noise, 15);
      const want = Math.min(1, Math.max(0, (d - noise) / span));
      b.append(c);
      expect(b.level).toBeCloseTo(want, 4);
    }
  });

  it('a steady input settles near the floor (the meter does not stay full on hum)', () => {
    const b = new TakeBuffer();
    b.start();
    for (let i = 0; i < 5; i++) b.append(tone(CHUNK, 0.2));
    // Floor starts at the first buffer's level, so equal buffers read 0.
    expect(b.level).toBeCloseTo(0, 6);
  });

  it('raises onTakeTooLong once when the cap is reached, and keeps collecting', () => {
    let hits = 0;
    const b = new TakeBuffer(CHUNK * 3);
    b.onTakeTooLong = () => hits++;
    b.start();
    b.append(tone(CHUNK, 0.1));
    b.append(tone(CHUNK, 0.1));
    expect(hits).toBe(0);
    b.append(tone(CHUNK, 0.1));
    expect(hits).toBe(1);
    b.append(tone(CHUNK, 0.1));
    expect(hits).toBe(1);
    expect(b.length).toBe(CHUNK * 4);
    b.start();
    b.append(tone(CHUNK * 3, 0.1));
    expect(hits).toBe(2);
  });

  it('clear drops the take and stops recording', () => {
    const b = new TakeBuffer();
    b.start();
    b.append(tone(CHUNK, 0.3));
    b.clear();
    expect(b.isRecording).toBe(false);
    expect(b.length).toBe(0);
    expect(b.level).toBe(0);
  });
});

describe('take checks', () => {
  it('hasSpeechDynamics: bursts over a quiet floor are speech, a flat tone is not', () => {
    const speech = new Float32Array(SAMPLE_RATE * 2);
    speech.set(tone(SAMPLE_RATE / 2, 0.3), SAMPLE_RATE / 2);
    for (let i = 0; i < speech.length; i++) speech[i] += 0.001 * Math.sin(i * 1.7);
    expect(hasSpeechDynamics(speech)).toBe(true);
    expect(hasSpeechDynamics(tone(SAMPLE_RATE * 2, 0.3))).toBe(false);
    // Under 300 ms: too short to judge, let the model decide.
    expect(hasSpeechDynamics(new Float32Array(SAMPLE_RATE / 5))).toBe(true);
  });

  it('isSilentTake: digital silence or no dynamics', () => {
    expect(isSilentTake(new Float32Array(SAMPLE_RATE), 0.0001)).toBe(true);
    expect(isSilentTake(tone(SAMPLE_RATE, 0.3), 0.3)).toBe(true);
    const speech = new Float32Array(SAMPLE_RATE);
    speech.set(tone(4000, 0.3), 6000);
    for (let i = 0; i < speech.length; i++) speech[i] += 0.001 * Math.sin(i);
    expect(isSilentTake(speech, 0.3)).toBe(false);
  });

  it('normalizeQuietTake scales to 0.5 peak with gain capped at 200', () => {
    const a = Float32Array.from([0.05, -0.1]);
    expect(normalizeQuietTake(a, 0.1)).toBeCloseTo(5, 6);
    expect(a[1]).toBeCloseTo(-0.5, 6);
    const b = Float32Array.from([0.0001]);
    expect(normalizeQuietTake(b, 0.0001)).toBe(200);
    expect(b[0]).toBeCloseTo(0.02, 6);
    const c = Float32Array.from([0.8]);
    expect(normalizeQuietTake(c, 0.8)).toBe(1);
    expect(c[0]).toBeCloseTo(0.8, 6);
  });
});
