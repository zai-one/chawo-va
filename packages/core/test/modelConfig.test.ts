import { describe, expect, it } from 'vitest';
import { parseModelConfig } from '../src/modelConfig';

describe('modelConfig', () => {
  it('falls back to defaults', () => {
    expect(parseModelConfig(null).features.nMels).toBe(64);
  });
  it('reads the scalars it needs, first key wins', () => {
    const cfg = parseModelConfig('preprocessor:\n  sample_rate: 16000\n  features: 80\n  n_fft: 400\n  win_length: 400\n  hop_length: 160\n  center: true\nsubsampling_factor: 0\npred_hidden: 512\nfeatures: 1\n');
    expect(cfg.features).toEqual({ sampleRate: 16000, nMels: 80, nFft: 400, winLength: 400, hopLength: 160, center: true });
    expect(cfg.predHidden).toBe(512);
    expect(cfg.subsamplingFactor).toBe(4);
  });
});
