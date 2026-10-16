import { describe, expect, it } from 'vitest';
import { chunkBounds, readWav, resample, silences, wavBytes } from '../src/audio';

describe('audio', () => {
  it('round-trips a mono 16-bit WAV', () => {
    const x = Float32Array.from([0, 0.5, -0.5, 0.25]);
    const back = readWav(wavBytes(x, 16000));
    expect(back.rate).toBe(16000);
    expect(back.samples.length).toBe(4);
    back.samples.forEach((v, i) => expect(v).toBeCloseTo(x[i], 3));
  });

  it('rejects non-WAV data', () => {
    expect(() => readWav(new Uint8Array(64))).toThrow(/Not a WAV/);
  });

  it('resamples length proportionally', () => {
    expect(resample(new Float32Array(48000), 48000, 16000).length).toBe(16000);
  });

  it('finds pause midpoints and cuts chunks at them', () => {
    const rate = 1000;
    const x = new Float32Array(10 * rate).fill(0.5);
    x.fill(0, 4000, 5000); // 1 s pause centred at 4.5 s
    expect(silences(x, rate)).toEqual([4.5]);
    expect(chunkBounds(10, [4.5], 6)).toEqual([[0, 4.5], [4.5, 10]]);
    expect(chunkBounds(10, [], 6)).toEqual([[0, 6], [6, 10]]);
  });
});
