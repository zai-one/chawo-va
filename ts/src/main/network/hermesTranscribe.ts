// App.HermesTranscribe: what Hermes runs for one request. Reuses the dictation session's recognizer
// (the one WPF keeps in _recognizer); when it is not open yet and the model is on disk, the session
// opens it (never downloads). One pause-split piece at a time, so a dictation take on this PC can run
// between pieces; if the session is swapped or closed mid-request, the request ends as «model
// unloaded» (503) instead of running on a disposed session.

import { Recognizer } from '../../core/recognizer';
import { decode16k } from '../file/fileTranscript';
import * as Log from '../log';
import type { HermesResult } from './hermesServer';

export interface HermesRecognizer {
  readonly modelId: string;
  deviceActual: string;
  provider?: string;
  pieceRanges?(samples16k: Float32Array): Array<{ from: number; to: number }>;
  transcribePiece?(samples16k: Float32Array): Promise<string>;
  transcribeCancelable(samples: Float32Array, rate: number, stillWanted: (() => boolean) | null): Promise<string>;
}

export interface HermesTranscribeHooks {
  /** The open recognizer, or null (nothing loaded / Client / settings changed). */
  current: () => HermesRecognizer | null;
  /** Opens it from disk when possible (dictation session ensureLoaded). Never downloads. */
  load?: () => Promise<HermesRecognizer | null>;
  /** Name for the health answer when nothing is loaded (settings.SpeechModel). */
  modelName: () => string;
  decode?: (audio: Uint8Array, label: string) => Promise<Float32Array>;
  /** How long a health probe waits for a load it started (the client's check gives up after 5 s). */
  healthWaitMs?: number;
}

const notLoaded = (error: string | null = null): HermesResult => ({
  modelLoaded: false, text: null, model: '', device: '', provider: '', seconds: 0, error,
});

async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function makeHermesTranscribe(h: HermesTranscribeHooks): ((audio: Uint8Array) => Promise<HermesResult>) & { inFlight: () => number } {
  const decode = h.decode ?? decode16k;
  let inFlight = 0;
  const fn = async (audio: Uint8Array): Promise<HermesResult> => {
    let rec = h.current();
    if (audio.length === 0) {
      if (!rec && h.load) {
        const loading = h.load().catch(() => null);
        rec = await within(loading, h.healthWaitMs ?? 3_000);
      }
      return {
        modelLoaded: rec !== null,
        text: null,
        model: rec?.modelId ?? h.modelName(),
        device: rec?.deviceActual ?? '',
        provider: rec?.provider ?? '',
        seconds: 0,
        error: null,
      };
    }
    if (!rec && h.load) rec = await h.load().catch(() => null);
    if (!rec) return notLoaded();
    inFlight++;
    try {
      const samples = await decode(audio, 'request');
      const ranges = rec.pieceRanges ? rec.pieceRanges(samples) : Recognizer.splitRanges(samples, 16000);
      const parts: string[] = [];
      for (const { from, to } of ranges) {
        if (h.current() !== rec) return notLoaded('model unloaded');
        const piece = samples.slice(from, to);
        const bit = rec.transcribePiece ? await rec.transcribePiece(piece) : await rec.transcribeCancelable(piece, 16000, null);
        if (bit.length > 0) parts.push(bit);
      }
      const text = parts.join('\n');
      Log.write(`hermes ${(samples.length / 16000).toFixed(1)}s pieces=${ranges.length} -> ${text.length} chars`);
      return {
        modelLoaded: true, text, model: rec.modelId, device: rec.deviceActual, provider: rec.provider ?? '',
        seconds: samples.length / 16000, error: null,
      };
    } catch (e) {
      Log.write(`hermes decode failed: ${e instanceof Error ? e.name : 'Error'}`);
      return {
        modelLoaded: true, text: null, model: rec.modelId, device: rec.deviceActual, provider: rec.provider ?? '',
        seconds: 0, error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      inFlight--;
    }
  };
  return Object.assign(fn, { inFlight: () => inFlight });
}
