import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  looksComplete,
  findComplete,
  candidateDirectories,
  deleteButtonLabel,
  deletableTargets,
  deleteInstalled,
} from '../src/main/models/speechModelStore';
import { modelDirectory, localDataDir } from '../src/main/paths';

const ENV_KEYS = [
  'CHAWO_APPDATA',
  'CHAWO_LOCALAPPDATA',
  'CHAWO_MODEL_DIR',
  'PISAR_APPDATA',
  'PISAR_LOCALAPPDATA',
  'PISAR_MODEL_DIR',
] as const;

let saved: Record<string, string | undefined> = {};
let root: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = mkdtempSync(join(tmpdir(), 'chawo-store-'));
  process.env.CHAWO_APPDATA = join(root, 'roaming');
  process.env.CHAWO_LOCALAPPDATA = join(root, 'local');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function writeSized(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w');
  try {
    if (bytes > 0) {
      writeSync(fd, Buffer.from([1]), 0, 1, 0);
      ftruncateSync(fd, bytes);
    }
  } finally {
    closeSync(fd);
  }
}

function plantV3(dir: string, sizes: 'tiny' | 'ok'): void {
  mkdirSync(dir, { recursive: true });
  const n = sizes === 'ok' ? (21 << 20) : 100;
  writeSized(join(dir, 'v3_e2e_rnnt_encoder.onnx'), n);
  writeSized(join(dir, 'v3_e2e_rnnt_decoder.onnx'), sizes === 'ok' ? 200 << 10 : 10);
  writeSized(join(dir, 'v3_e2e_rnnt_joint.onnx'), sizes === 'ok' ? 200 << 10 : 10);
  writeSized(join(dir, 'v3_e2e_rnnt_tokenizer.model'), sizes === 'ok' ? 20 << 10 : 10);
  writeSized(join(dir, 'v3_e2e_rnnt.yaml'), sizes === 'ok' ? 200 : 10);
}

describe('SpeechModelStore', () => {
  it('LooksComplete rejects stubs under size thresholds', () => {
    const dir = join(root, 'stub');
    plantV3(dir, 'tiny');
    expect(looksComplete(dir, 'v3_e2e_rnnt')).toBe(false);

    const ctc = join(root, 'ctc-stub');
    mkdirSync(ctc, { recursive: true });
    writeSized(join(ctc, 'multilingual_large_ctc.onnx'), 1000);
    writeSized(join(ctc, 'multilingual_large_ctc.onnx.data'), 1000);
    writeSized(join(ctc, 'multilingual_large_ctc.yaml'), 10);
    writeSized(join(ctc, 'multilingual_vocab.txt'), 10);
    expect(looksComplete(ctc, 'multilingual_large_ctc')).toBe(false);
  });

  it('LooksComplete accepts files at the size gates', () => {
    const dir = join(root, 'ok');
    plantV3(dir, 'ok');
    expect(looksComplete(dir, 'v3_e2e_rnnt')).toBe(true);
  });

  it('FindComplete prefers canonical local models folder', () => {
    const canonical = modelDirectory('v3_e2e_rnnt');
    const other = join(localDataDir(), 'model');
    plantV3(other, 'ok');
    plantV3(canonical, 'ok');
    expect(findComplete('v3_e2e_rnnt')).toBe(canonical);
  });

  it('FindComplete uses CHAWO_MODEL_DIR override when canonical is empty', () => {
    const override = join(root, 'override-model');
    process.env.CHAWO_MODEL_DIR = override;
    plantV3(override, 'ok');
    const found = findComplete('v3_e2e_rnnt');
    expect(found).toBe(override);
  });

  it('candidate order lists canonical first', () => {
    const list = [...candidateDirectories('v3_e2e_rnnt')];
    expect(list[0]).toBe(modelDirectory('v3_e2e_rnnt'));
  });

  it('DeleteButtonLabel is Russian', () => {
    expect(deleteButtonLabel('v3_e2e_rnnt')).toContain('v3');
    expect(deleteButtonLabel('multilingual_large_ctc')).toContain('2,4');
  });

  it('DeletableTargets stays under LocalDataDir and deleteInstalled removes them', () => {
    const dir = modelDirectory('v3_e2e_rnnt');
    plantV3(dir, 'ok');
    const targets = deletableTargets('v3_e2e_rnnt');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t.startsWith(localDataDir()))).toBe(true);
    deleteInstalled('v3_e2e_rnnt');
    expect(existsSync(dir)).toBe(false);
  });
});
