// Waveform -> log-mel spectrogram, exactly what the encoder expects. Port of src/Core/Features.cs.
// Any deviation from torchaudio's extractor yields garbage, so the math mirrors the C# step by step
// (periodic Hann, plain DFT against cos/sin tables, melscale_fbanks(norm=None), clamp, ln).
// Float32Array keeps the same single-precision accumulation targets as the C# float[] code.

import type { FeatureConfig } from './modelConfig';

const hzToMel = (f: number) => 2595.0 * Math.log10(1.0 + f / 700.0);
const melToHz = (m: number) => 700.0 * (Math.pow(10.0, m / 2595.0) - 1.0);

/** Triangular filters as torchaudio melscale_fbanks(norm=None), laid out [nMels][nFreqs]. */
export function melFilterbank(nFreqs: number, fMin: number, fMax: number, nMels: number, sampleRate: number): Float32Array {
  const top = sampleRate / 2.0;
  const allFreqs = new Float64Array(nFreqs);
  for (let i = 0; i < nFreqs; i++) allFreqs[i] = (top * i) / (nFreqs - 1);
  const mMin = hzToMel(fMin);
  const mMax = hzToMel(fMax);
  const fPts = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) fPts[i] = melToHz(mMin + ((mMax - mMin) * i) / (nMels + 1));
  const fDiff = new Float64Array(nMels + 1);
  for (let i = 0; i < nMels + 1; i++) fDiff[i] = fPts[i + 1] - fPts[i];
  const fb = new Float32Array(nMels * nFreqs);
  for (let m = 0; m < nMels; m++) {
    for (let i = 0; i < nFreqs; i++) {
      const down = -(fPts[m] - allFreqs[i]) / fDiff[m];
      const up = (fPts[m + 2] - allFreqs[i]) / fDiff[m + 1];
      fb[m * nFreqs + i] = Math.max(0.0, Math.min(down, up));
    }
  }
  return fb;
}

function dot(a: Float32Array, b: Float32Array, bOff: number, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[bOff + i];
  return Math.fround(s);
}

export class Features {
  readonly config: FeatureConfig;
  private readonly nFreqs: number;
  private readonly window: Float32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly fb: Float32Array;

  constructor(cfg: FeatureConfig) {
    this.config = cfg;
    if (cfg.winLength !== cfg.nFft) throw new Error('win_length must equal n_fft; torch would center-pad the window');
    this.nFreqs = Math.floor(cfg.nFft / 2) + 1;
    this.window = new Float32Array(cfg.winLength);
    for (let i = 0; i < cfg.winLength; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / cfg.winLength);
    this.cos = new Float32Array(this.nFreqs * cfg.nFft);
    this.sin = new Float32Array(this.nFreqs * cfg.nFft);
    for (let k = 0; k < this.nFreqs; k++) {
      for (let n = 0; n < cfg.nFft; n++) {
        const a = (2.0 * Math.PI * k * n) / cfg.nFft;
        this.cos[k * cfg.nFft + n] = Math.cos(a);
        this.sin[k * cfg.nFft + n] = -Math.sin(a);
      }
    }
    this.fb = melFilterbank(this.nFreqs, 0.0, cfg.sampleRate / 2.0, cfg.nMels, cfg.sampleRate);
  }

  /** Number of frames the model will see for a given sample count. */
  outLen(samples: number): number {
    const c = this.config;
    return c.center ? Math.floor(samples / c.hopLength) + 1 : Math.floor((samples - c.winLength) / c.hopLength) + 1;
  }

  /** Waveform -> features laid out [nMels, frames] row-major (encoder input [1, nMels, frames]). */
  compute(wave: Float32Array): { values: Float32Array; frames: number } {
    const cfg = this.config;
    let x: Float32Array;
    if (cfg.center) {
      const pad = Math.floor(cfg.nFft / 2);
      x = new Float32Array(wave.length + 2 * pad);
      for (let i = 0; i < pad; i++) x[i] = wave[Math.min(pad - i, wave.length - 1)];
      x.set(wave, pad);
      for (let i = 0; i < pad; i++) x[pad + wave.length + i] = wave[Math.max(0, wave.length - 2 - i)];
    } else {
      x = wave;
    }
    const n = Math.max(0, Math.floor((x.length - cfg.nFft) / cfg.hopLength) + 1);
    if (n === 0) return { values: new Float32Array(0), frames: 0 };

    const frame = new Float32Array(cfg.nFft);
    const power = new Float32Array(this.nFreqs);
    const out = new Float32Array(cfg.nMels * n);
    for (let f = 0; f < n; f++) {
      const off = f * cfg.hopLength;
      for (let j = 0; j < cfg.nFft; j++) frame[j] = x[off + j] * this.window[j];
      for (let k = 0; k < this.nFreqs; k++) {
        const re = dot(frame, this.cos, k * cfg.nFft, cfg.nFft);
        const im = dot(frame, this.sin, k * cfg.nFft, cfg.nFft);
        power[k] = re * re + im * im;
      }
      for (let m = 0; m < cfg.nMels; m++) {
        let mel = dot(power, this.fb, m * this.nFreqs, this.nFreqs);
        mel = Math.min(Math.max(mel, 1e-9), 1e9);
        out[m * n + f] = Math.log(mel);
      }
    }
    return { values: out, frames: n };
  }
}
