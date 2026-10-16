import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '@chawo/core/strings';
import { readWav } from '@chawo/core/audio';
import { FileQueue } from '../src/file/fileQueue';
import { FileRunner } from '../src/file/fileRunner';
import { remoteFatal, remotePrepare, remoteTranscriber } from '../src/file/remoteTranscriber';
import { RemoteHostException } from '../src/network/remoteSpeech';
import * as Settings from '../src/settings';
import { VadRuntime, setVadRuntime } from '../src/vad/vadModel';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-remote-file-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
});

function audio(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  return p;
}

/** 60 s with a pause every ~10 s, so the 24 s pause split makes several pieces. */
function long(): Float32Array {
  const x = new Float32Array(16000 * 60);
  for (let i = 0; i < x.length; i++) x[i] = (i / 16000) % 10 < 9 ? 0.3 * Math.sin(i * 0.1) : 0;
  return x;
}

function client(edit?: (s: Settings.SettingsData) => void) {
  const s = Settings.defaults();
  s.NetworkRole = 'Client';
  s.RemoteHost = 'host.lan';
  edit?.(s);
  return s;
}

describe('file transcription in the Client role', () => {
  it('no timestamps/srt: the whole file goes in one WAV post', async () => {
    const s = client((x) => { x.FileTimestamps = false; x.FileSrt = false; });
    const posts: { type: string; samples: number }[] = [];
    const tr = remoteTranscriber(() => s, async (_s, body, type) => {
      posts.push({ type, samples: readWav(body).samples.length });
      return 'весь файл';
    });
    const statuses: string[] = [];
    const segs = await tr('/x/a.wav', long(), (l) => statuses.push(l), new AbortController().signal);
    expect(posts).toEqual([{ type: 'audio/wav', samples: 16000 * 60 }]);
    expect(segs).toEqual([{ start: 0, end: 60, text: 'весь файл' }]);
    expect(statuses).toEqual(['Отправляю на хост…']);
  });

  it('timestamps on: one post per pause-split piece, offsets kept', async () => {
    const s = client((x) => { x.FileTimestamps = true; });
    const sizes: number[] = [];
    const tr = remoteTranscriber(() => s, async (_s, body) => {
      sizes.push(readWav(body).samples.length);
      return `кусок ${sizes.length}`;
    });
    const statuses: string[] = [];
    const segs = await tr('/x/a.wav', long(), (l) => statuses.push(l), new AbortController().signal);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(16000 * 60);
    expect(segs.map((g) => g.text)).toEqual(sizes.map((_, i) => `кусок ${i + 1}`));
    expect(segs[0].start).toBe(0);
    expect(segs.at(-1)!.end).toBe(60);
    expect(statuses[0]).toBe(`Кусок 1 из ${sizes.length} на хосте…`);
  });

  it('a timed extra format (.vtt/.json) also posts piece by piece; .md without timestamps does not', async () => {
    let posts = 0;
    const post = async () => { posts++; return 'x'; };
    const s = client((x) => { x.FileTimestamps = false; x.FileSrt = false; x.FileExtraFormats = ['md', 'docx']; });
    await remoteTranscriber(() => s, post)('/x/a.wav', long(), () => {}, new AbortController().signal);
    expect(posts).toBe(1);
    posts = 0;
    s.FileExtraFormats = ['json'];
    await remoteTranscriber(() => s, post)('/x/a.wav', long(), () => {}, new AbortController().signal);
    expect(posts).toBeGreaterThan(1);
  });

  it('prepare checks only the address; a bad one stops before any file', async () => {
    const s = client((x) => { x.RemoteHost = ''; });
    const prep = await remotePrepare(() => s, async () => 'x')();
    expect(prep).toEqual({ ok: false, message: 'Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.' });
    s.RemoteHost = '10.0.0.2';
    expect((await remotePrepare(() => s, async () => 'x')()).ok).toBe(true);
  });

  it('FileRunner: a host error fails the current file and ends the run; the rest stays queued', async () => {
    const s = client((x) => { x.FileTimestamps = false; });
    const queue = new FileQueue();
    const statuses: string[] = [];
    const loads: string[] = [];
    let n = 0;
    const runner = new FileRunner({
      queue,
      load16k: async (p) => {
        loads.push(p);
        return new Float32Array(16000 * 2);
      },
      prepare: remotePrepare(() => s, async () => {
        n++;
        if (n === 2) throw new RemoteHostException('Хост не отвечает. Проверьте адрес и порт. Модель на этом компьютере не скачивается.', 'The host did not answer.');
        return 'готово';
      }),
      options: () => ({ timestamps: false, srt: false, useBrain: false, diarize: false, brief: false }),
      status: (l) => statuses.push(l),
      fatal: remoteFatal,
      prefetch: () => false,
    });
    const [a, b, c] = [audio('a.wav'), audio('b.wav'), audio('c.wav')];
    queue.add([a, b, c], false);
    await runner.run();
    const items = queue.snapshot();
    expect(items.map((i) => i.state)).toEqual(['Done', 'Failed', 'Queued']);
    expect(items[1].note).toBe('Хост не отвечает. Проверьте адрес и порт. Модель на этом компьютере не скачивается.');
    expect(statuses.at(-1)).toBe('Хост не отвечает. Проверьте адрес и порт. Модель на этом компьютере не скачивается.');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('готово');
    // No prefetch in the Client role: each file is decoded only when its turn comes.
    expect(loads).toEqual([a, b]);
    expect(runner.busy).toBe(false);
  });

  it('remoteFatal only knows host errors', () => {
    expect(remoteFatal(new Error('x'))).toBeNull();
    expect(remoteFatal(new RemoteHostException('ру', 'en'))).toBe('ру');
  });
});

describe('file transcription in the Client role + Silero VAD', () => {
  it('with the VAD model the pieces are cut at speech pauses (status says so); without it the energy split', async () => {
    // Speech 0.5–21.5 s and 22.5–59.5 s over a hiss louder than −35 dBFS: energy finds no pause.
    const x = new Float32Array(16000 * 60);
    let seed = 7;
    for (let i = 0; i < x.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const t = i / 16000;
      x[i] = 0.1 * (seed / 0x7fffffff - 0.5) + ((t > 0.5 && t < 21.5) || (t > 22.5 && t < 59.5) ? 0.3 * Math.sin(i * 0.1) : 0);
    }
    const fake = {
      run: async (feeds: Record<string, { data: unknown; dims: readonly number[] }>) => {
        const batch = Number(feeds.input.dims[0]);
        const input = feeds.input.data as Float32Array;
        const out = new Float32Array(batch);
        for (let b = 0; b < batch; b++) {
          let sum = 0;
          for (let i = 64; i < 576; i++) sum += input[b * 576 + i] ** 2;
          out[b] = Math.sqrt(sum / 512) > 0.12 ? 0.9 : 0.05;
        }
        return { output: { data: out }, stateN: { data: new Float32Array((feeds.state.data as Float32Array).length) } };
      },
    };
    const s = client();
    const run = async () => {
      const cuts: number[] = [];
      const lines: string[] = [];
      let at = 0;
      const tr = remoteTranscriber(() => s, async (_s, body) => {
        at += readWav(body).samples.length;
        cuts.push(at / 16000);
        return 'текст';
      });
      await tr('/a.wav', x, (l) => void lines.push(l), new AbortController().signal);
      return { cuts, lines };
    };
    try {
      setVadRuntime(new VadRuntime(() => '/m/silero_vad.onnx', async () => fake));
      const vad = await run();
      expect(vad.lines[0]).toBe('Ищу паузы в речи…');
      expect(vad.cuts[0]).toBeGreaterThan(21.5);
      expect(vad.cuts[0]).toBeLessThan(22.5);
      setVadRuntime(new VadRuntime(() => null));
      const energy = await run();
      expect(energy.cuts[0]).toBe(24);
      expect(energy.lines[0]).not.toBe('Ищу паузы в речи…');
    } finally {
      setVadRuntime(null);
    }
  });
});
