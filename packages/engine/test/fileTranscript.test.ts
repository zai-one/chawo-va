import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { wavBytes } from '@chawo/core/audio';
import {
  collectFromFolder,
  downmixTo16k,
  hasSupportedExtension,
  isOgg,
  isWav,
  load16k,
  outputPath,
  setPlatformDecoder,
} from '../src/file/fileTranscript';
import { FileQueue, samePath } from '../src/file/fileQueue';
import * as Ffmpeg from '../src/file/ffmpegTool';
import { buildZip, listZip, readEntry } from '../src/file/zip';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-file-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
});
afterAll(() => {
  setPlatformDecoder(null);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
});

const tone = (n: number, rate: number) => {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return x;
};

describe('FileTranscript', () => {
  it('outputPath puts .txt beside the source', () => {
    expect(outputPath('/a/b/talk.wav')).toBe(resolve('/a/b/talk.txt'));
    expect(outputPath('/a/b/.wav')).toBe(resolve('/a/b/.wav.txt'));
  });

  it('extensions and folder collection', () => {
    expect(hasSupportedExtension('x.MP3')).toBe(true);
    expect(hasSupportedExtension('x.txt')).toBe(false);
    const f = join(dir, 'folder');
    mkdirSync(join(f, 'sub'), { recursive: true });
    for (const n of ['b.ogg', 'A.wav', 'c.txt', 'sub/d.wav']) writeFileSync(join(f, n), 'x');
    expect(collectFromFolder(f).map((p) => p.slice(f.length + 1))).toEqual(['A.wav', 'b.ogg']);
    expect(collectFromFolder(join(dir, 'missing'))).toEqual([]);
  });

  it('magic checks', () => {
    expect(isWav(wavBytes(new Float32Array(10), 16000))).toBe(true);
    expect(isOgg(Buffer.from('OggS....'))).toBe(true);
    expect(isOgg(Buffer.from('RIFF'))).toBe(false);
  });

  it('loads a 44.1 kHz WAV natively and resamples', async () => {
    const p = join(dir, 'tone.wav');
    writeFileSync(p, wavBytes(tone(44100, 44100), 44100));
    const s = await load16k(p);
    expect(Math.abs(s.length - 16000)).toBeLessThanOrEqual(2);
  });

  it('falls back to the platform decoder for unknown containers', async () => {
    const p = join(dir, 'x.mp3');
    writeFileSync(p, Buffer.alloc(100, 1));
    setPlatformDecoder(async () => new Float32Array(123));
    expect((await load16k(p)).length).toBe(123);
    setPlatformDecoder(null);
  });

  it('downmix averages channels and resamples', () => {
    const out = downmixTo16k([new Float32Array([1, 1]), new Float32Array([0, 0])], 16000);
    expect(Array.from(out)).toEqual([0.5, 0.5]);
  });
});

describe('FileQueue', () => {
  it('adds, dedups pending, replaces finished, takes in order', () => {
    const q = new FileQueue();
    let changes = 0;
    q.onChanged(() => changes++);
    const a = join(dir, 'folder', 'A.wav');
    expect(q.add([a, `"${a}"`, join(dir, 'folder')], true)).toEqual({ added: 2, skipped: 2 });
    expect(q.add(['note.txt'], true)).toEqual({ added: 0, skipped: 1 });
    expect(q.queuedCount).toBe(2);
    const first = q.takeNext()!;
    expect(first.path).toBe(a);
    expect(q.remove(first.id)).toBe(false);
    expect(q.peekNext()!.path.endsWith('b.ogg')).toBe(true);
    q.finish(first.id, 'Done', '1 s', '/out.txt');
    expect(q.lastOutput).toBe('/out.txt');
    expect(q.add([a], true).added).toBe(1);
    expect(q.snapshot().filter((i) => i.path === a)).toHaveLength(1);
    const second = q.takeNext()!;
    q.markRunningStopped('stopped');
    expect(q.snapshot().find((i) => i.id === second.id)!.state).toBe('Stopped');
    expect(changes).toBeGreaterThan(5);
  });

  it('samePath is case-sensitive only on linux', () => {
    expect(samePath('/A', '/a', 'linux')).toBe(false);
    expect(samePath('C:\\A', 'c:\\a', 'win32')).toBe(true);
  });
});

describe('zip', () => {
  it('lists and reads stored and deflated entries', () => {
    const big = Buffer.alloc(5000, 7);
    const z = join(dir, 't.zip');
    writeFileSync(z, buildZip([
      { name: 'ffmpeg-x/bin/ffmpeg.exe', data: big, deflate: true },
      { name: 'ffmpeg-x/bin/a.dll', data: Buffer.from('dll') },
    ]));
    const e = listZip(z);
    expect(e.map((x) => x.name)).toEqual(['ffmpeg-x/bin/ffmpeg.exe', 'ffmpeg-x/bin/a.dll']);
    expect(readEntry(z, e[0]).equals(big)).toBe(true);
    expect(readEntry(z, e[1]).toString()).toBe('dll');
  });
});

const sysFfmpeg = Ffmpeg.find();
describe.skipIf(!sysFfmpeg)('ffmpeg (system)', () => {
  it('decodes an mp3 to 16 kHz mono via stdout pipe', async () => {
    const mp3 = join(dir, 'tone.mp3');
    execFileSync(sysFfmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'sine=frequency=440:duration=2:sample_rate=44100', '-ac', '2', '-y', mp3]);
    const s = await load16k(mp3);
    expect(Math.abs(s.length - 32000)).toBeLessThan(2000);
    expect(Math.max(...s.subarray(1000, 2000))).toBeGreaterThan(0.05);
  });

  it('reports ffmpeg errors briefly', async () => {
    const junk = join(dir, 'junk.mkv');
    writeFileSync(junk, Buffer.alloc(200, 3));
    await expect(Ffmpeg.decodeTo16k(junk)).rejects.toThrow(/ffmpeg failed/);
  });

  it('statusLine mentions PATH', () => {
    expect(Ffmpeg.statusLine()).toContain(sysFfmpeg!);
  });
});
