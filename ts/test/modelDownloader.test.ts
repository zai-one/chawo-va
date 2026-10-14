import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGzip } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import {
  approxBytes,
  LARGE_FILES,
  sha256Hex,
  verifySha,
  verifyShaBuffer,
  ModelDownloadException,
} from '../src/main/models/modelDownloader';
import { buildUstar, unpackTarGzFlat } from '../src/main/models/tarGz';

const ENV_KEYS = ['CHAWO_APPDATA', 'CHAWO_LOCALAPPDATA'] as const;
let saved: Record<string, string | undefined> = {};
let root: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = mkdtempSync(join(tmpdir(), 'chawo-dl-'));
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

async function writeGzipFile(path: string, data: Buffer): Promise<void> {
  await pipeline(Readable.from(data), createGzip(), createWriteStream(path));
}

describe('ModelDownloader helpers', () => {
  it('ApproxBytes matches WPF constants', () => {
    expect(approxBytes('v3_e2e_rnnt')).toBe(220 << 20);
    const large = LARGE_FILES.reduce((s, f) => s + f.size, 0);
    expect(approxBytes('multilingual_large_ctc')).toBe(large);
    expect(large).toBe(909828 + 2343837696 + 1180 + 393);
  });

  it('VerifySha accepts matching and rejects wrong checksum', () => {
    const dir = join(root, 'sha');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'a.bin');
    const data = Buffer.from('hello-chawo');
    writeFileSync(path, data);
    const hex = sha256Hex(data);
    verifySha(path, hex);
    verifyShaBuffer(data, hex);
    expect(() => verifySha(path, '00'.repeat(32))).toThrow(/checksum mismatch/);
  });

  it('unpackTarGzFlat extracts basenames and skips ._*', async () => {
    const tar = buildUstar([
      { name: 'subdir/v3_e2e_rnnt.yaml', data: Buffer.from('sample: 1\n') },
      { name: '._ignored', data: Buffer.from('mac') },
      { name: 'v3_e2e_rnnt_decoder.onnx', data: Buffer.from('dec') },
    ]);
    const archive = join(root, 'tiny.tar.gz');
    await writeGzipFile(archive, tar);
    const dest = join(root, 'out');
    const names = await unpackTarGzFlat(archive, dest);
    expect(names).toContain('v3_e2e_rnnt.yaml');
    expect(names).toContain('v3_e2e_rnnt_decoder.onnx');
    expect(names).not.toContain('._ignored');
    expect(readFileSync(join(dest, 'v3_e2e_rnnt.yaml'), 'utf8')).toBe('sample: 1\n');
    expect(existsSync(join(dest, '._ignored'))).toBe(false);
  });

  it('ModelDownloadException carries kind', () => {
    const e = new ModelDownloadException('corrupt', 'bad');
    expect(e.kind).toBe('corrupt');
    expect(e.message).toBe('bad');
  });
});
