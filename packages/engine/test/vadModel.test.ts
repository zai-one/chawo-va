import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { VAD_CONTEXT, VAD_INPUT, VAD_WINDOW, type VadSessionLike } from '@chawo/core/vad';
import * as Settings from '../src/settings';
import {
  VAD_MODEL_URL,
  VadRuntime,
  downloadVadModel,
  filePauses,
  findVadModel,
  trimTake,
  vadModelPath,
} from '../src/vad/vadModel';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-vad-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
  delete process.env.CHAWO_VAD_MODEL;
});

const R = 16000;
function burst(seconds: number, a: number, b: number): Float32Array {
  const x = new Float32Array(seconds * R);
  for (let i = a * R; i < b * R; i++) x[i] = 0.3 * Math.sin(i * 0.17);
  return x;
}

/** A fake ORT session with the Silero v5 IO: speech where the new samples are loud. */
function fakeSession(): VadSessionLike & { runs: number; released: number; release: () => Promise<void> } {
  const s = {
    runs: 0,
    released: 0,
    run: async (feeds: Record<string, { data: unknown; dims: readonly number[] }>) => {
      s.runs++;
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
    release: async () => void s.released++,
  };
  return s as never;
}

describe('vadModel: paths and download', () => {
  it('canonical path under LOCALAPPDATA/models/silero-vad; CHAWO_VAD_MODEL wins', () => {
    expect(vadModelPath()).toBe(join(dir, 'local', 'ChawoVoiceAssistant', 'models', 'silero-vad', 'silero_vad.onnx'));
    expect(findVadModel()).toBeNull();
    const own = join(dir, 'own.onnx');
    writeFileSync(own, 'x');
    process.env.CHAWO_VAD_MODEL = own;
    expect(findVadModel()).toBe(own);
    delete process.env.CHAWO_VAD_MODEL;
  });

  it('official pinned snakers4 URL, checksum mismatch leaves no file behind', async () => {
    expect(VAD_MODEL_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\/snakers4\/silero-vad\/v5\.1\.2\//);
    let asked = '';
    await expect(downloadVadModel(undefined, async (url, dest) => {
      asked = url;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, 'not a model');
    })).rejects.toThrow(/checksum/);
    expect(asked).toBe(VAD_MODEL_URL);
    expect(existsSync(vadModelPath())).toBe(false);
    expect(existsSync(vadModelPath() + '.part')).toBe(false);
  });
});

describe('VadRuntime', () => {
  it('no file → energy Vad, nothing created', async () => {
    let created = 0;
    const rt = new VadRuntime(() => null, async () => { created++; return fakeSession(); });
    expect((await rt.vad()).silero).toBe(false);
    expect(created).toBe(0);
    expect(rt.onDisk).toBe(false);
  });

  it('loads once and shares the session; release frees it', async () => {
    const s = fakeSession();
    let created = 0;
    const rt = new VadRuntime(() => '/m/silero_vad.onnx', async () => { created++; return s; });
    const [a, b] = await Promise.all([rt.vad(), rt.vad()]);
    expect(a.silero && b.silero).toBe(true);
    await rt.vad();
    expect(created).toBe(1);
    expect(rt.loaded).toBe(true);
    await rt.release();
    expect(s.released).toBe(1);
    expect(rt.loaded).toBe(false);
  });

  it('a failed load falls back to energy and is not retried for the same file', async () => {
    let created = 0;
    const rt = new VadRuntime(() => '/m/broken.onnx', async () => { created++; throw new Error('bad model'); });
    expect((await rt.vad()).silero).toBe(false);
    expect((await rt.vad()).silero).toBe(false);
    expect(created).toBe(1);
    expect(rt.error).toBe('bad model');
  });

  it('download is shared between concurrent callers and reports errors', async () => {
    let calls = 0;
    const rt = new VadRuntime(() => null, async () => fakeSession(), async () => { calls++; throw new Error('offline'); });
    const p1 = rt.download();
    const p2 = rt.download();
    expect(rt.isDownloading).toBe(true);
    await expect(p1).rejects.toThrow('offline');
    await expect(p2).rejects.toThrow('offline');
    expect(calls).toBe(1);
    expect(rt.isDownloading).toBe(false);
    expect(rt.error).toBe('offline');
  });
});

describe('filePauses / trimTake', () => {
  const s = Settings.defaults();
  const withModel = () => new VadRuntime(() => '/m/silero_vad.onnx', async () => fakeSession());

  it('Silero pauses for a long file; undefined (energy split) when off, no model or no speech', async () => {
    const x = new Float32Array(60 * R);
    for (const [a, b] of [[1, 20], [21, 40], [41, 59]]) for (let i = a * R; i < b * R; i++) x[i] = 0.3 * Math.sin(i * 0.17);
    let started = 0;
    const p = await filePauses(s, x, R, { runtime: withModel(), onStart: () => void started++ });
    expect(p).toBeDefined();
    expect(p!.some((v) => v > 20 && v < 21)).toBe(true);
    expect(p!.some((v) => v > 40 && v < 41)).toBe(true);
    expect(started).toBe(1);
    expect(await filePauses({ ...s, VadEnabled: false }, x, R, { runtime: withModel() })).toBeUndefined();
    expect(await filePauses(s, x, R, { runtime: new VadRuntime(() => null) })).toBeUndefined();
    expect(await filePauses(s, new Float32Array(60 * R), R, { runtime: withModel() })).toBeUndefined();
  });

  it('a scorer error keeps the energy split; an abort propagates', async () => {
    const broken = new VadRuntime(() => '/m/x.onnx', async () => ({ run: async () => { throw new Error('ort'); } }));
    expect(await filePauses(s, burst(30, 1, 2), R, { runtime: broken })).toBeUndefined();
    const ac = new AbortController();
    ac.abort();
    await expect(filePauses(s, burst(30, 1, 2), R, { runtime: withModel(), signal: ac.signal })).rejects.toThrow();
  });

  it('trimTake: cut with the model, untouched without it or when off', async () => {
    const x = burst(3, 1, 2);
    const cut = await trimTake(s, x, R, withModel());
    expect(cut.length).toBeLessThan(x.length);
    expect(Math.abs(cut.length / R - 1.26)).toBeLessThan(0.07);
    expect(await trimTake(s, x, R, new VadRuntime(() => null))).toBe(x);
    expect(await trimTake({ ...s, VadEnabled: false }, x, R, withModel())).toBe(x);
  });
});
