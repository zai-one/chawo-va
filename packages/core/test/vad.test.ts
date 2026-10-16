import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { chunkBounds, readWav, silences } from '../src/audio';
import { Recognizer } from '../src/recognizer';
import { fromRanges } from '../src/transcriptFormat';
import {
  SilenceWatch,
  VAD_CONTEXT,
  VAD_INPUT,
  VAD_WINDOW,
  Vad,
  energyProbabilities,
  gapMidpoints,
  lanesFor,
  pauseMidpoints,
  probsToSegments,
  segments,
  sileroScorer,
  speechProbabilities,
  trimSpeech,
  type FrameScorer,
  type VadSessionLike,
} from '../src/vad';

const R = 16000;

/** Fixture builder: [startSec, endSec, amplitude] tone bursts over an optional noise floor. */
function audio(seconds: number, bursts: [number, number, number][], noise = 0, seed = 1): Float32Array {
  const x = new Float32Array(Math.round(seconds * R));
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < x.length; i++) x[i] = noise * 2 * rnd();
  for (const [a, b, amp] of bursts) {
    for (let i = Math.round(a * R); i < Math.min(x.length, Math.round(b * R)); i++) x[i] += amp * Math.sin(i * 0.17);
  }
  return x;
}

/** Deterministic stand-in for Silero: speech when the 512 new samples are louder than 0.05 RMS. */
function fakeScorer(log?: { batches: number[]; inputs: Float32Array[] }): FrameScorer {
  return (input, state, batch) => {
    log?.batches.push(batch);
    log?.inputs.push(input);
    expect(input.length).toBe(batch * VAD_INPUT);
    expect(state.length).toBe(2 * batch * 128);
    const probs = new Float32Array(batch);
    for (let b = 0; b < batch; b++) {
      let sum = 0;
      for (let i = VAD_CONTEXT; i < VAD_INPUT; i++) sum += input[b * VAD_INPUT + i] ** 2;
      probs[b] = Math.sqrt(sum / VAD_WINDOW) > 0.05 ? 0.9 : 0.05;
    }
    const next = Float32Array.from(state, (v) => v + 1); // proves the state is threaded through
    return { probs, state: next };
  };
}

const near = (a: number, b: number, tol = 0.05) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('vad: Silero window plumbing', () => {
  it('feeds 64 samples of context + 512 new ones and threads the state', async () => {
    const x = new Float32Array(3 * VAD_WINDOW).map((_, i) => i / 10000);
    const states: number[] = [];
    const inputs: Float32Array[] = [];
    const scorer: FrameScorer = (input, state) => {
      inputs.push(input);
      states.push(state[0]);
      return { probs: [0.1], state: Float32Array.from(state, (v) => v + 1) };
    };
    const p = await speechProbabilities(x, scorer);
    expect(p.length).toBe(3);
    expect(states).toEqual([0, 1, 2]);
    expect(Array.from(inputs[0].subarray(0, VAD_CONTEXT))).toEqual(new Array(VAD_CONTEXT).fill(0));
    expect(inputs[0][VAD_CONTEXT]).toBeCloseTo(0);
    expect(Array.from(inputs[1].subarray(0, VAD_CONTEXT))).toEqual(Array.from(x.subarray(VAD_WINDOW - VAD_CONTEXT, VAD_WINDOW)));
    expect(inputs[2][VAD_CONTEXT]).toBeCloseTo(x[2 * VAD_WINDOW]);
  });

  it('a short last window is zero-padded; other rates are resampled to 16 kHz', async () => {
    const p = await speechProbabilities(new Float32Array(VAD_WINDOW + 10), fakeScorer());
    expect(p.length).toBe(2);
    const p8 = await speechProbabilities(new Float32Array(8000), fakeScorer(), 8000);
    expect(p8.length).toBe(Math.ceil(16000 / VAD_WINDOW));
  });

  it('lanes score contiguous parts of long audio in one batch with the same result', async () => {
    const x = audio(10, [[1, 3, 0.3], [6, 8, 0.3]]);
    const log = { batches: [] as number[], inputs: [] as Float32Array[] };
    const one = await speechProbabilities(x, fakeScorer());
    const four = await speechProbabilities(x, fakeScorer(log), R, { lanes: 4 });
    expect(log.batches.every((b) => b === 4)).toBe(true);
    expect(log.batches.length).toBe(Math.ceil(one.length / 4));
    expect(Array.from(four)).toEqual(Array.from(one));
    expect(lanesFor(30 * R)).toBe(1);
    expect(lanesFor(10 * 60 * R)).toBe(10);
    expect(lanesFor(3600 * R)).toBe(16);
  });

  it('sileroScorer builds input/state/sr tensors and reads output/stateN', async () => {
    let seen: Record<string, { dims: readonly number[]; type: string }> = {};
    const session: VadSessionLike = {
      run: async (feeds) => {
        seen = Object.fromEntries(Object.entries(feeds).map(([k, v]) => [k, { dims: v.dims, type: v.type }]));
        return { output: { data: new Float32Array([0.7, 0.2]) }, stateN: { data: new Float32Array(2 * 2 * 128).fill(3) } };
      },
    };
    const r = await sileroScorer(session)(new Float32Array(2 * VAD_INPUT), new Float32Array(2 * 2 * 128), 2);
    expect(seen.input).toEqual({ dims: [2, 576], type: 'float32' });
    expect(seen.state).toEqual({ dims: [2, 2, 128], type: 'float32' });
    expect(seen.sr).toEqual({ dims: [], type: 'int64' });
    expect(Array.from(r.probs)).toEqual([expect.closeTo(0.7), expect.closeTo(0.2)]);
    expect(r.state[0]).toBe(3);
    const bad: VadSessionLike = { run: async () => ({ output: { data: new Float32Array(0) } }) };
    await expect(sileroScorer(bad)(new Float32Array(VAD_INPUT), new Float32Array(256), 1)).rejects.toThrow(/unexpected/);
  });
});

describe('vad: segments with a fake scorer (fixtures ±50 ms)', () => {
  const vad = new Vad(fakeScorer());

  it('all silence → no segments, trim keeps the take, no pauses', async () => {
    const x = audio(3, []);
    expect(await vad.segments(x)).toEqual([]);
    const t = await vad.trimSpeech(x);
    expect(t.samples).toBe(x);
    expect(t).toMatchObject({ start: 0, end: 3 });
    expect(await vad.pauseMidpoints(x)).toEqual([]);
  });

  it('speech + silence + speech → two segments with 30 ms padding', async () => {
    const x = audio(4, [[0.5, 1.5, 0.3], [2.5, 3.2, 0.3]]);
    const segs = await vad.segments(x);
    expect(segs).toHaveLength(2);
    near(segs[0].start, 0.47);
    near(segs[0].end, 1.53);
    near(segs[1].start, 2.47);
    near(segs[1].end, 3.23);
    const pauses = await vad.pauseMidpoints(x);
    expect(pauses).toHaveLength(3); // lead-in, the gap, the tail
    near(pauses[1], 2.0);
  });

  it('noise below the speech level → nothing; speech over the same noise is found', async () => {
    expect(await vad.segments(audio(3, [], 0.02))).toEqual([]);
    const segs = await vad.segments(audio(3, [[1, 2, 0.3]], 0.02));
    expect(segs).toHaveLength(1);
    near(segs[0].start, 0.97);
    near(segs[0].end, 2.03);
  });

  it('bursts shorter than 250 ms are dropped, gaps under 100 ms do not split', async () => {
    expect(await vad.segments(audio(2, [[0.5, 0.65, 0.3]]))).toEqual([]);
    const segs = await vad.segments(audio(3, [[0.5, 1.2, 0.3], [1.26, 2.0, 0.3]]));
    expect(segs).toHaveLength(1);
  });

  it('trimSpeech cuts the ends, keeps ~100 ms and the original times', async () => {
    const x = audio(3, [[1, 2, 0.3]]);
    const t = await vad.trimSpeech(x);
    near(t.start, 0.87);
    near(t.end, 2.13);
    expect(t.samples.length).toBe(Math.round((t.end - t.start) * R));
    expect(t.samples[Math.round((1.5 - t.start) * R)]).toBeCloseTo(x[Math.round(1.5 * R)]);
    const sync = trimSpeech(x, R, { probs: await vad.probabilities(x), padMs: 50 });
    near(sync.start, 0.92);
  });

  it('works at 48 kHz too (times stay in seconds of the original)', async () => {
    const x48 = new Float32Array(3 * 48000);
    for (let i = 48000; i < 96000; i++) x48[i] = 0.3 * Math.sin(i * 0.05);
    const segs = await vad.segments(x48, 48000);
    expect(segs).toHaveLength(1);
    near(segs[0].start, 0.97);
    const t = await vad.trimSpeech(x48, 48000);
    near(t.start, 0.87);
    expect(t.samples.length).toBe(Math.round((t.end - t.start) * 48000));
  });
});

describe('vad: pause midpoints feed chunkBounds without cutting speech', () => {
  it('every cut of a 70 s talk lands in a pause and the pieces cover the whole file', async () => {
    const bursts: [number, number, number][] = [];
    for (let t = 0.5; t < 69; t += 3.5) bursts.push([t, t + 2.8, 0.3]); // 2.8 s phrases, 0.7 s pauses
    const x = audio(70, bursts, 0.02);
    const pauses = await new Vad(fakeScorer()).pauseMidpoints(x);
    const bounds = chunkBounds(70, pauses, Recognizer.MaxChunkSeconds);
    expect(bounds.length).toBeGreaterThan(2);
    expect(bounds[0][0]).toBe(0);
    expect(bounds[bounds.length - 1][1]).toBe(70);
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i][0]).toBe(bounds[i - 1][1]);
      const cut = bounds[i][0];
      expect(bursts.some(([a, b]) => cut > a && cut < b)).toBe(false);
    }
  });

  it('gapMidpoints: leading/trailing gaps count, short ones do not', () => {
    expect(gapMidpoints([{ start: 1, end: 2 }, { start: 2.2, end: 3 }, { start: 4, end: 5 }], 5.1)).toEqual([0.5, 3.5]);
    expect(gapMidpoints([], 10)).toEqual([]);
  });
});

describe('vad: energy fallback', () => {
  it('no scorer → energy probabilities, same API', async () => {
    const v = new Vad(null);
    expect(v.silero).toBe(false);
    const x = audio(4, [[0.5, 1.5, 0.3], [2.5, 3.2, 0.3]]);
    const segs = await v.segments(x);
    expect(segs).toHaveLength(2);
    near(segs[0].start, 0.47);
    near(segs[1].end, 3.23);
    expect(segments(x)).toEqual(segs);
  });

  it('digital silence and a steady quiet hiss are not speech', () => {
    expect(segments(new Float32Array(3 * R))).toEqual([]);
    expect(segments(audio(3, [], 0.003))).toEqual([]);
    expect(pauseMidpoints(new Float32Array(3 * R))).toEqual([]);
  });

  it('pauses agree with silences() on a clean recording', () => {
    const x = audio(10, [[0.5, 4, 0.3], [5, 9, 0.3]]);
    const p = pauseMidpoints(x);
    const s = silences(x, R);
    expect(p.length).toBeGreaterThanOrEqual(1);
    near(p.find((v) => v > 4 && v < 5)!, s.find((v) => v > 4 && v < 5)!, 0.06);
  });

  it('energy probabilities are in 0..1 and one per window', () => {
    const p = energyProbabilities(audio(1, [[0.2, 0.8, 0.3]]));
    expect(p.length).toBe(Math.ceil(R / VAD_WINDOW));
    expect(Math.max(...p)).toBeLessThanOrEqual(1);
    expect(Math.min(...p)).toBeGreaterThanOrEqual(0);
  });

  it('probsToSegments: a segment open at the end closes at the end of the audio', () => {
    const probs = [0, 0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];
    const segs = probsToSegments(probs, probs.length * VAD_WINDOW);
    expect(segs).toHaveLength(1);
    near(segs[0].end, (probs.length * VAD_WINDOW) / R, 0.001);
  });
});

describe('vad: SilenceWatch (auto-stop)', () => {
  const feed = (w: SilenceWatch, x: Float32Array) => {
    for (let i = 0; i < x.length; i += 640) if (w.push(x.subarray(i, i + 640))) return i / R;
    return null;
  };

  it('fires once after the limit of silence that follows speech', () => {
    const w = new SilenceWatch(800);
    const at = feed(w, audio(4, [[0.5, 1.5, 0.3]], 0.001));
    expect(at).not.toBeNull();
    near(at!, 1.5 + 0.8, 0.08);
    expect(w.push(new Float32Array(R))).toBe(false);
  });

  it('silence alone never stops a take; 0 ms is off', () => {
    expect(feed(new SilenceWatch(500), audio(5, [], 0.001))).toBeNull();
    expect(feed(new SilenceWatch(0), audio(3, [[0.2, 0.6, 0.3]]))).toBeNull();
  });

  it('short pauses between words do not stop it', () => {
    const w = new SilenceWatch(700);
    expect(feed(w, audio(4, [[0.2, 1, 0.3], [1.4, 2.2, 0.3], [2.6, 3.9, 0.3]], 0.001))).toBeNull();
    expect(w.speechHeard).toBe(true);
  });
});

describe('recognizer split with VAD pauses: no word lost on piece boundaries', () => {
  // 80 s of 1.2 s "words" every 1.6 s over a hiss louder than −35 dBFS, so the energy split finds no
  // pause and hard-cuts at 24 s. A fake recognizer returns the words whose burst lies fully in a piece.
  const words: [number, number, number][] = [];
  for (let t = 0.3, k = 0; t < 79; t += 1.6, k++) words.push([t, t + 1.2, 0.3]);
  const x = audio(80, words, 0.05);
  const recognize = (from: number, to: number) =>
    words.map(([a, b], i) => (a * R >= from && b * R <= to ? `w${i}` : '')).filter(Boolean).join(' ');
  const all = words.map((_, i) => `w${i}`).join(' ');

  it('energy split (old default) is unchanged without pauses', () => {
    const ranges = Recognizer.splitRanges(x, R);
    expect(ranges[0]).toEqual({ from: 0, to: 24 * R });
  });

  it('with VAD pauses every word survives and the ranges are contiguous', async () => {
    const pauses = await new Vad(fakeScorer()).pauseMidpoints(x);
    const ranges = Recognizer.splitRanges(x, R, pauses);
    expect(ranges.length).toBeGreaterThan(3);
    expect(ranges[0].from).toBe(0);
    expect(ranges[ranges.length - 1].to).toBe(x.length);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBe(ranges[i - 1].to);
    for (const r of ranges) expect(r.to - r.from).toBeLessThanOrEqual(Recognizer.MaxChunkSeconds * R);
    const segs = fromRanges(ranges.map((r) => [r.from, r.to] as const), ranges.map((r) => recognize(r.from, r.to)), R);
    expect(segs.map((s) => s.text).join(' ')).toBe(all);
  });
});

// Real Silero v5 weights, only when present (CHAWO_VAD_TEST_MODEL=/path/silero_vad.onnx). Not in CI.
const realModel = process.env.CHAWO_VAD_TEST_MODEL;
const realWav = process.env.CHAWO_VAD_TEST_WAV;
describe.skipIf(!realModel || !existsSync(realModel))('vad: real Silero v5 model', () => {
  it('finds no speech in hiss and speech in a real recording', async () => {
    const ort = await import('onnxruntime-node');
    const session = await ort.InferenceSession.create(realModel!);
    const v = new Vad(sileroScorer(session as unknown as VadSessionLike));
    expect(await v.segments(audio(3, [], 0.003))).toEqual([]);
    if (realWav && existsSync(realWav)) {
      const { samples, rate } = readWav(readFileSync(realWav));
      const segs = await v.segments(samples, rate);
      expect(segs.length).toBeGreaterThan(0);
    }
  });
});
