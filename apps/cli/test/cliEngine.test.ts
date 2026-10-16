// `chawo-va transcribe` engine: the same piece split as the page (fileRanges → Silero pauses for long
// files when VadEnabled and the model is on disk, energy split otherwise). Fake FileJob, no model.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineFromJob, type JobLike } from '../src/cli/engine';
import { Recognizer } from '@chawo/core/recognizer';
import { VAD_CONTEXT, VAD_INPUT, VAD_WINDOW, type VadSessionLike } from '@chawo/core/vad';
import { VadRuntime, setVadRuntime } from '@chawo/engine/vad/vadModel';

const R = 16000;
const en = (_ru: string, e: string) => e;

function fakeJob(): JobLike & { runs: Array<ReadonlyArray<{ from: number; to: number }>>; cancelled: number; disposed: number } {
  const j = {
    runs: [] as Array<ReadonlyArray<{ from: number; to: number }>>,
    cancelled: 0,
    disposed: 0,
    plan: { summaryRu: 'Авто → 2× CPU', summaryEn: 'Auto → 2× CPU' },
    deviceActual: 'cpu',
    provider: 'cpu',
    run: async (_s: Float32Array, ranges: ReadonlyArray<{ from: number; to: number }>, progress: ((d: number, t: number, a: number, w: number) => void) | null) => {
      j.runs.push(ranges);
      progress?.(ranges.length, ranges.length, 1, 1);
      return ranges.map((_r, i) => `кусок ${i + 1}`);
    },
    cancel: () => void j.cancelled++,
    dispose: async () => void j.disposed++,
  };
  return j as never;
}

/** Speech in [1,20), [21,40), [41,59) s… repeated: a long file with clear pauses at 20.5, 40.5, … */
function longSpeech(seconds: number): Float32Array {
  const x = new Float32Array(seconds * R);
  for (let i = 0; i < x.length; i++) {
    const sec = (i / R) % 20;
    if (sec >= 1) x[i] = 0.3 * Math.sin(i * 0.17);
  }
  return x;
}

/** A fake Silero v5 session: speech where the new samples are loud. */
function fakeSession(): VadSessionLike {
  return {
    run: async (feeds: Record<string, { data: unknown; dims: readonly number[] }>) => {
      const batch = Number(feeds.input.dims[0]);
      const input = feeds.input.data as Float32Array;
      const out = new Float32Array(batch);
      for (let b = 0; b < batch; b++) {
        let sum = 0;
        for (let i = VAD_CONTEXT; i < VAD_INPUT; i++) sum += input[b * VAD_INPUT + i] ** 2;
        out[b] = Math.sqrt(sum / VAD_WINDOW) > 0.05 ? 0.95 : 0.02;
      }
      return { output: { data: out }, stateN: { data: new Float32Array((feeds.state.data as Float32Array).length) } };
    },
  } as never;
}

/** Identity, not a deep compare of a million samples. */
function expectSplit(split: { mock: { calls: unknown[][] } }, samples: Float32Array, pauses: number[] | undefined): void {
  const call = split.mock.calls.at(-1)!;
  expect(call[0]).toBe(samples);
  expect(call[1]).toBe(R);
  expect(call[2]).toEqual(pauses);
}

afterEach(() => {
  vi.restoreAllMocks();
  setVadRuntime(null);
});

describe('cli engine: VAD pauses for long files (same as the page)', () => {
  it('long file + vad on: pauses are found, status said once, splitRanges gets them', async () => {
    const split = vi.spyOn(Recognizer, 'splitRanges');
    const pauses = vi.fn(async (s: { VadEnabled: boolean }) => (s.VadEnabled ? [20.5, 40.5, 60.5] : undefined));
    const job = fakeJob();
    const e = engineFromJob(job, { vad: true, t: en, pauses });
    expect(e.summary).toBe('Auto → 2× CPU');
    expect(e.device).toBe('cpu/cpu');
    const status: string[] = [];
    const samples = longSpeech(80);
    const segs = await e.transcribe(samples, () => undefined, new AbortController().signal, (l) => status.push(l));
    expect(pauses).toHaveBeenCalledTimes(1);
    expect(pauses.mock.calls[0]![0]).toEqual({ VadEnabled: true });
    expectSplit(split, samples, [20.5, 40.5, 60.5]);
    expect(job.runs).toHaveLength(1);
    expect(segs.map((s) => s.text)).toEqual(job.runs[0]!.map((_r, i) => `кусок ${i + 1}`));
  });

  it('vad off: no Silero, the energy split (no pauses) as before', async () => {
    const split = vi.spyOn(Recognizer, 'splitRanges');
    const e = engineFromJob(fakeJob(), { vad: false, t: en });
    const samples = longSpeech(80);
    await e.transcribe(samples, () => undefined, new AbortController().signal);
    expectSplit(split, samples, undefined);
  });

  it('short file: pauses are not looked for at all', async () => {
    const pauses = vi.fn(async () => [1]);
    const split = vi.spyOn(Recognizer, 'splitRanges');
    const e = engineFromJob(fakeJob(), { vad: true, t: en, pauses });
    const samples = new Float32Array(10 * R);
    await e.transcribe(samples, () => undefined, new AbortController().signal);
    expect(pauses).not.toHaveBeenCalled();
    expectSplit(split, samples, undefined);
  });

  it('the real filePauses: Silero on disk → pauses + «Finding pauses…»; no model → energy split, no download', async () => {
    const split = vi.spyOn(Recognizer, 'splitRanges');
    setVadRuntime(new VadRuntime(() => '/m/silero_vad.onnx', async () => fakeSession() as never));
    const status: string[] = [];
    const samples = longSpeech(80);
    await engineFromJob(fakeJob(), { vad: true, t: en }).transcribe(samples, () => undefined, new AbortController().signal, (l) => status.push(l));
    expect(status).toEqual(['Finding pauses in speech…']);
    const got = split.mock.calls.at(-1)![2]!;
    expect(got.length).toBeGreaterThan(0);
    expect(got.some((p) => p > 19.5 && p < 21.5)).toBe(true);

    const fetchTo = vi.fn();
    setVadRuntime(new VadRuntime(() => null, async () => fakeSession() as never, fetchTo));
    const status2: string[] = [];
    await engineFromJob(fakeJob(), { vad: true, t: en }).transcribe(samples, () => undefined, new AbortController().signal, (l) => status2.push(l));
    expect(split.mock.calls.at(-1)![2]).toBeUndefined();
    expect(status2).toEqual([]);
    expect(fetchTo).not.toHaveBeenCalled();
  });

  it('abort cancels the job; dispose goes to the job', async () => {
    const job = fakeJob();
    const ac = new AbortController();
    job.run = async () => {
      ac.abort();
      return [];
    };
    const e = engineFromJob(job, { vad: false, t: en });
    await e.transcribe(new Float32Array(R), () => undefined, ac.signal);
    expect(job.cancelled).toBe(1);
    await e.dispose();
    expect(job.disposed).toBe(1);
  });
});
