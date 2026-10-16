import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Features } from '../src/features';
import { defaultModelConfig } from '../src/modelConfig';

describe('Features', () => {
  it('matches an independent numpy rfft log-mel reference', () => {
    const golden = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/features-golden.json'), 'utf8')) as {
      frames: number;
      values: number[];
    };
    const sr = 16000;
    const x = new Float32Array(8000);
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      x[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * Math.sin(2 * Math.PI * 3000 * t) + 0.01 * Math.cos(2 * Math.PI * 97 * t);
    }
    const f = new Features(defaultModelConfig().features);
    const { values, frames } = f.compute(x);
    expect(frames).toBe(golden.frames);
    expect(f.outLen(x.length)).toBe(frames);
    let worst = 0;
    for (let i = 0; i < values.length; i++) {
      // Bins near the 1e-9 floor are numerically noisy in float32; judge the meaningful ones.
      if (golden.values[i] < -12) continue;
      worst = Math.max(worst, Math.abs(values[i] - golden.values[i]));
    }
    expect(worst).toBeLessThan(2e-3);
  });

  it('returns no frames for too-short input', () => {
    expect(new Features(defaultModelConfig().features).compute(new Float32Array(100)).frames).toBe(0);
  });
});
