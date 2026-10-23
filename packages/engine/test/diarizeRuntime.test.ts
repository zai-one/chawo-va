import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiarizeRuntime } from '../src/diarize/diarizeRuntime';
import { looksComplete, unpackTarBz2Flat } from '../src/diarize/diarizeModels';
import { buildUstar } from '../src/models/tarGz';
import { execFileSync } from 'node:child_process';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-diar-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_DIAR_DIR;
});

describe('DiarizeRuntime', () => {
  it('is not ready without models; injectable backend diarizes when paths exist', async () => {
    const rt = new DiarizeRuntime(
      () => null,
      () => ({ process: () => [{ start: 0, end: 1, speaker: 0 }] }),
    );
    expect(rt.onDisk).toBe(false);
    expect(rt.ready).toBe(false);
    expect(await rt.run(new Float32Array(1600))).toEqual([]);
  });

  it('uses injected backend when models are found', async () => {
    const modelDir = join(dir, 'models');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.onnx'), Buffer.alloc(1_500_000));
    writeFileSync(join(modelDir, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'), Buffer.alloc(6_000_000));
    expect(looksComplete(modelDir)).toBe(true);
    process.env.CHAWO_DIAR_DIR = modelDir;

    const rt = new DiarizeRuntime(undefined, (paths) => {
      expect(paths.segmentation).toContain('model.onnx');
      return {
        process: (pcm) => [{ start: 0, end: pcm.length / 16000, speaker: 9 }],
      };
    });
    expect(rt.ready).toBe(true);
    const spans = await rt.run(new Float32Array(32000));
    expect(spans).toEqual([{ start: 0, end: 2, speaker: 9 }]);
  });

  it('downloads via injectable fetch and unpacks tar.bz2', async () => {
    // Build a tiny tar.bz2 with model.onnx via python
    const onnx = Buffer.alloc(1_200_000, 1);
    const tarBuf = buildUstar([{ name: 'sherpa/model.onnx', data: onnx }]);
    const tarPath = join(dir, 'seg.tar');
    const bzPath = join(dir, 'seg.tar.bz2');
    writeFileSync(tarPath, tarBuf);
    execFileSync('python3', ['-c', 'import bz2,sys; open(sys.argv[2],"wb").write(bz2.compress(open(sys.argv[1],"rb").read()))', tarPath, bzPath]);

    const emb = Buffer.alloc(5_500_000, 2);
    const files: Record<string, Buffer> = {
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2':
        readFileSync(bzPath),
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx':
        emb,
    };

    const rt = new DiarizeRuntime(
      undefined,
      () => ({ process: () => [] }),
      async (url, dest) => {
        const body = files[url];
        if (!body) throw new Error('unexpected url ' + url);
        writeFileSync(dest, body);
      },
    );
    const paths = await rt.download();
    expect(paths.segmentation).toContain('model.onnx');
    expect(rt.onDisk).toBe(true);
  });
});

describe('unpackTarBz2Flat', () => {
  it('extracts basenames from a bz2 archive', async () => {
    const data = Buffer.from('hello-onnx');
    const tarBuf = buildUstar([{ name: 'nested/model.onnx', data }]);
    const tarPath = join(dir, 'a.tar');
    const bzPath = join(dir, 'a.tar.bz2');
    writeFileSync(tarPath, tarBuf);
    execFileSync('python3', ['-c', 'import bz2,sys; open(sys.argv[2],"wb").write(bz2.compress(open(sys.argv[1],"rb").read()))', tarPath, bzPath]);
    const out = join(dir, 'out');
    const names = await unpackTarBz2Flat(bzPath, out);
    expect(names).toContain('model.onnx');
    expect(readFileSync(join(out, 'model.onnx'), 'utf8')).toBe('hello-onnx');
  });
});

describe('diarizeHook (shared by the file page and chawo-va transcribe)', () => {
  it('null when not ready (soft), else status line + spans from the runtime', async () => {
    const { diarizeHook } = await import('../src/diarize/diarizeRuntime');
    const missing = diarizeHook(() => new DiarizeRuntime(() => null, () => ({ process: () => [] })));
    const said: string[] = [];
    expect(await missing(new Float32Array(16000), (l) => said.push(l), new AbortController().signal)).toBeNull();
    expect(said).toEqual([]);

    const paths = { segmentation: '/m/model.onnx', embedding: '/m/e.onnx' };
    const ready = diarizeHook(
      () => new DiarizeRuntime(() => paths, () => ({ process: (pcm) => [{ start: 0, end: pcm.length / 16000, speaker: 4 }] })),
      () => 'Separating speakers…',
    );
    expect(await ready(new Float32Array(32000), (l) => said.push(l), new AbortController().signal)).toEqual([{ start: 0, end: 2, speaker: 4 }]);
    expect(said).toEqual(['Separating speakers…']);
  });
});

describe('DiarizeRuntime in a worker thread', () => {
  const paths = { segmentation: '/m/model.onnx', embedding: '/m/e.onnx' };
  /** A stand-in for out/main/diarizeWorker.js: answers like it, without sherpa-onnx. */
  const fakeWorker = (body: string) => {
    const f = join(dir, `worker-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(f, `const { parentPort } = require('node:worker_threads');\nparentPort.on('message', (m) => {\n${body}\n});\n`);
    return f;
  };

  it('diarizes in the worker; the config and samples go over, the caller keeps its samples', async () => {
    const file = fakeWorker(
      `parentPort.postMessage({ ok: true, spans: [{ start: 0, end: m.pcm.length / 16000, speaker: m.config.clustering.numClusters === -1 ? 3 : 0 }] });`,
    );
    const rt = new DiarizeRuntime(() => paths, null, undefined, () => file);
    const pcm = new Float32Array(32000);
    expect(await rt.run(pcm)).toEqual([{ start: 0, end: 2, speaker: 3 }]);
    expect(pcm.length).toBe(32000);
    // The same worker serves the next file.
    expect(await rt.run(new Float32Array(16000))).toEqual([{ start: 0, end: 1, speaker: 3 }]);
    rt.release();
  });

  it('a sherpa error comes back as an error (the queue notes it softly)', async () => {
    const file = fakeWorker(`parentPort.postMessage({ ok: false, error: 'bad model' });`);
    const rt = new DiarizeRuntime(() => paths, null, undefined, () => file);
    await expect(rt.run(new Float32Array(1600))).rejects.toThrow('bad model');
    rt.release();
  });

  it('Stop ends a long diarization at once: the worker is terminated, AbortError', async () => {
    const file = fakeWorker(`/* sherpa busy for minutes */ const end = Date.now() + 60000; while (Date.now() < end) {}`);
    const rt = new DiarizeRuntime(() => paths, null, undefined, () => file);
    const ctrl = new AbortController();
    const run = rt.run(new Float32Array(1600), ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    const t0 = Date.now();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(5000);
    rt.release();
  });

  it('no sherpa-onnx in the worker: falls back to this thread (no models at /m here → no spans)', async () => {
    const file = fakeWorker(`parentPort.postMessage({ ok: false, error: 'Cannot find module', noSherpa: true });`);
    const rt = new DiarizeRuntime(() => paths, null, undefined, () => file);
    expect(await rt.run(new Float32Array(1600))).toEqual([]);
    // This thread tried itself: sherpa-onnx is missing here, or it refused the made-up model paths.
    expect(rt.error).not.toBe('');
  });

  it('a worker file that cannot start falls back the same way', async () => {
    const rt = new DiarizeRuntime(() => paths, null, undefined, () => join(dir, 'missing-worker.js'));
    expect(await rt.run(new Float32Array(1600))).toEqual([]);
  });
});

describe('diarizeHook progress', () => {
  it('shows the time spent while sherpa-onnx works (it reports no percent)', async () => {
    const { diarizeHook } = await import('../src/diarize/diarizeRuntime');
    const paths = { segmentation: '/m/model.onnx', embedding: '/m/e.onnx' };
    const slow = () =>
      new DiarizeRuntime(() => paths, () => ({ process: () => new Promise((r) => setTimeout(() => r([{ start: 0, end: 1, speaker: 0 }]), 1150)) }));
    const said: string[] = [];
    await diarizeHook(slow, () => 'Separating speakers…', 500)(new Float32Array(16000), (l) => said.push(l), new AbortController().signal);
    expect(said[0]).toBe('Separating speakers…');
    expect(said.slice(1)).toEqual(['Separating speakers… 0:00', 'Separating speakers… 0:01']);
  });
});
