// Which published GigaAM weights to run. Port of src/Core/SpeechModels.cs.

export type SpeechModelKind = 'multilingual_large_ctc' | 'v3_e2e_rnnt';
export type SpeechDeviceKind = 'gpu' | 'cpu';

/**
 * Letter script for the multilingual CTC argmax. The ONNX graph has no language input.
 * v3 RNN-T ignores this.
 */
export type CtcScript = 'auto' | 'russian' | 'english';

/** Local port the "Hermes" LAN speech server listens on (same as the WPF app). */
export const HERMES_PORT = 17831;

export const modelId = (kind: SpeechModelKind): string => kind;

export const modelFolder = (kind: SpeechModelKind): string =>
  kind === 'v3_e2e_rnnt' ? 'v3-e2e-rnnt' : 'multilingual-large-ctc';
