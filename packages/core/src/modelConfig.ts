// Model settings read from the yaml next to the ONNX files. Port of src/Core/ModelConfig.cs.
// Every key we care about is unique in that file, so a line scan is enough.

export interface FeatureConfig {
  sampleRate: number;
  nMels: number;
  nFft: number;
  winLength: number;
  hopLength: number;
  center: boolean;
}

export interface ModelConfig {
  features: FeatureConfig;
  predHidden: number;
  predLayers: number;
  /** Encoder time is this many feature frames, for CTC models. */
  subsamplingFactor: number;
}

export function defaultModelConfig(): ModelConfig {
  return {
    features: { sampleRate: 16000, nMels: 64, nFft: 320, winLength: 320, hopLength: 160, center: false },
    predHidden: 320,
    predLayers: 1,
    subsamplingFactor: 4,
  };
}

/** Parses the yaml text; pass null/undefined when the file is missing to get defaults. */
export function parseModelConfig(yaml: string | null | undefined): ModelConfig {
  const cfg = defaultModelConfig();
  if (!yaml) return cfg;
  const values = new Map<string, string>();
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!value || values.has(key)) continue;
    values.set(key, value);
  }
  const int = (key: string, fallback: number) => {
    const v = values.get(key);
    return v !== undefined && /^[+-]?\d+$/.test(v) ? parseInt(v, 10) : fallback;
  };
  const bool = (key: string, fallback: boolean) => (values.has(key) ? values.get(key) === 'true' : fallback);

  const f = cfg.features;
  f.nMels = int('features', f.nMels);
  f.sampleRate = int('sample_rate', f.sampleRate);
  f.nFft = int('n_fft', f.nFft);
  f.winLength = int('win_length', f.winLength);
  f.hopLength = int('hop_length', f.hopLength);
  f.center = bool('center', f.center);
  cfg.predHidden = int('pred_hidden', cfg.predHidden);
  cfg.predLayers = int('pred_rnn_layers', cfg.predLayers);
  cfg.subsamplingFactor = int('subsampling_factor', cfg.subsamplingFactor);
  if (cfg.subsamplingFactor < 1) cfg.subsamplingFactor = 4;
  return cfg;
}
