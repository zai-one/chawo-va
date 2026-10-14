import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiarizeRuntime } from '../src/main/diarize/diarizeRuntime';
import { looksComplete, unpackTarBz2Flat } from '../src/main/diarize/diarizeModels';
import { buildUstar } from '../src/main/models/tarGz';
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
    const { diarizeHook } = await import('../src/main/diarize/diarizeRuntime');
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
