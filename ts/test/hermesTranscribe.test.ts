import { describe, expect, it } from 'vitest';
import { wavBytes } from '../src/core/audio';
import { makeHermesTranscribe, type HermesRecognizer } from '../src/main/network/hermesTranscribe';
import * as Settings from '../src/main/settings';
import { DictationSession, type RecognizerLike } from '../src/main/dictation/dictationSession';

class Rec implements HermesRecognizer {
  readonly modelId = 'multilingual_large_ctc';
  deviceActual = 'gpu';
  provider = 'cuda';
  seen: number[] = [];
  onPiece: (() => void) | null = null;
  pieceRanges(s: Float32Array) {
    const third = Math.floor(s.length / 3);
    return [{ from: 0, to: third }, { from: third, to: 2 * third }, { from: 2 * third, to: s.length }];
  }
  async transcribePiece(s: Float32Array) {
    this.seen.push(s.length);
    this.onPiece?.();
    return this.seen.length === 2 ? '' : `часть ${this.seen.length}`;
  }
  async transcribeCancelable(): Promise<string> {
    throw new Error('not used');
  }
}

const wav = (seconds: number) => wavBytes(new Float32Array(Math.round(16000 * seconds)).fill(0.2), 16000);

describe('makeHermesTranscribe (App.HermesTranscribe)', () => {
  it('health: the loaded recognizer, or the settings name and not loaded', async () => {
    let rec: Rec | null = null;
    const tr = makeHermesTranscribe({ current: () => rec, modelName: () => 'V3E2eRnnt' });
    expect(await tr(new Uint8Array(0))).toEqual({ modelLoaded: false, text: null, model: 'V3E2eRnnt', device: '', provider: '', seconds: 0, error: null });
    rec = new Rec();
    expect(await tr(new Uint8Array(0))).toMatchObject({ modelLoaded: true, model: 'multilingual_large_ctc', device: 'gpu', provider: 'cuda' });
    expect(rec.seen).toHaveLength(0);
  });

  it('health opens the model from disk when it is not open yet (waits a little)', async () => {
    let rec: Rec | null = null;
    let loads = 0;
    const tr = makeHermesTranscribe({
      current: () => rec,
      load: async () => {
        loads++;
        rec = new Rec();
        return rec;
      },
      modelName: () => 'V3E2eRnnt',
    });
    expect((await tr(new Uint8Array(0))).modelLoaded).toBe(true);
    expect(loads).toBe(1);
    const slow = makeHermesTranscribe({ current: () => null, load: () => new Promise(() => undefined), modelName: () => 'X', healthWaitMs: 10 });
    expect((await slow(new Uint8Array(0))).modelLoaded).toBe(false);
  });

  it('POST: pieces joined with newlines, empty pieces dropped, seconds from 16 kHz', async () => {
    const rec = new Rec();
    const tr = makeHermesTranscribe({ current: () => rec, modelName: () => 'X' });
    const r = await tr(wav(3));
    expect(r).toEqual({ modelLoaded: true, text: 'часть 1\nчасть 3', model: 'multilingual_large_ctc', device: 'gpu', provider: 'cuda', seconds: 3, error: null });
    expect(rec.seen).toEqual([16000, 16000, 16000]);
    expect(tr.inFlight()).toBe(0);
  });

  it('no model → not loaded (503); bad audio → error (400)', async () => {
    const none = makeHermesTranscribe({ current: () => null, load: async () => null, modelName: () => 'X' });
    expect((await none(wav(1))).modelLoaded).toBe(false);
    const rec = new Rec();
    const tr = makeHermesTranscribe({ current: () => rec, modelName: () => 'X' });
    const r = await tr(new Uint8Array([1, 2, 3, 4, 5]));
    expect(r.modelLoaded).toBe(true);
    expect(r.error).toBe('need a wav or ogg/opus buffer');
  });

  it('the session is swapped mid-request → «model unloaded», no more pieces on the old one', async () => {
    let rec: Rec | null = new Rec();
    const first = rec;
    first.onPiece = () => { rec = null; };
    const tr = makeHermesTranscribe({ current: () => rec, modelName: () => 'X' });
    const r = await tr(wav(3));
    expect(r).toMatchObject({ modelLoaded: false, error: 'model unloaded' });
    expect(first.seen).toHaveLength(1);
  });

  it('DictationSession.current(): the open recognizer for the current settings, never on Client', async () => {
    const s = Settings.defaults();
    const fake: RecognizerLike = {
      kind: 'v3_e2e_rnnt', modelId: 'v3_e2e_rnnt', deviceActual: 'cpu', deviceNote: null, intraOpThreads: 2,
      transcribeCancelable: async () => 'x', cancelOwned: () => undefined, dispose: async () => undefined,
    };
    const sess = new DictationSession({ settings: () => s, find: (k) => `/m/${k}`, open: async () => fake, platform: 'linux' });
    expect(sess.current()).toBeNull();
    expect(await sess.ensureLoaded()).toBe(fake);
    expect(sess.current()).toBe(fake);
    s.CpuThreads = 3; // settings changed: the open one is stale until reloaded
    expect(sess.current()).toBeNull();
    s.CpuThreads = 0;
    s.NetworkRole = 'Client';
    expect(sess.current()).toBeNull();
  });
});

describe('makeHermesTranscribe + VAD pauses', () => {
  it('long audio asks the pauses hook and passes them to pieceRanges; short audio does not', async () => {
    const got: (readonly number[] | undefined)[] = [];
    class PRec extends Rec {
      pieceRanges(s: Float32Array, pauses?: readonly number[]) {
        got.push(pauses);
        return super.pieceRanges(s);
      }
    }
    let asked = 0;
    const tr = makeHermesTranscribe({
      current: () => rec,
      modelName: () => 'X',
      pauses: async () => { asked++; return [12.5, 30]; },
    });
    const rec = new PRec();
    await tr(wav(40));
    expect(asked).toBe(1);
    expect(got[0]).toEqual([12.5, 30]);
    await tr(wav(3));
    expect(asked).toBe(1);
    expect(got[1]).toBeUndefined();
  });

  it('a failing pauses hook keeps the energy split', async () => {
    const rec = new Rec();
    const tr = makeHermesTranscribe({ current: () => rec, modelName: () => 'X', pauses: async () => { throw new Error('vad'); } });
    expect((await tr(wav(40))).error).toBeNull();
  });
});
