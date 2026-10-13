import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileQueue } from '../src/main/file/fileQueue';
import { FileRunner, type FileRunnerDeps, type FileTranscriber } from '../src/main/file/fileRunner';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-runner-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
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

const echo: FileTranscriber = async (path, samples) => [
  { start: 0, end: 1, text: `first ${path.split(/[\\/]/).pop()}` },
  { start: 61, end: samples.length / 16000, text: 'second' },
];

function setup(over: Partial<FileRunnerDeps> = {}) {
  const queue = new FileQueue();
  const statuses: string[] = [];
  const loads: string[] = [];
  const deps: FileRunnerDeps = {
    queue,
    load16k: async (p) => {
      loads.push(p);
      if (p.includes('bad')) throw new Error('cannot decode');
      return new Float32Array(16000 * 65);
    },
    prepare: async () => ({ ok: true, transcriber: echo }),
    options: () => ({ timestamps: true, srt: true, useBrain: false }),
    status: (l) => statuses.push(l),
    ...over,
  };
  return { queue, statuses, loads, runner: new FileRunner(deps) };
}

describe('FileRunner', () => {
  it('says the queue is empty', async () => {
    const { runner, statuses } = setup();
    await runner.run();
    expect(statuses.at(-1)).toMatch(/пуста|empty/);
  });

  it('writes .txt and .srt beside each file, skips failures, keeps going', async () => {
    const { queue, runner, statuses, loads } = setup();
    const a = audio('a.wav');
    const b = audio('bad.wav');
    const c = audio('c.wav');
    queue.add([a, b, c], false);
    await runner.run();
    const rows = queue.snapshot();
    expect(rows.map((r) => r.state)).toEqual(['Done', 'Failed', 'Done']);
    expect(rows[0].note).toBe('00:01:05 · .srt');
    expect(rows[1].note).toBe('cannot decode');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('[00:00:00] first a.wav\n[00:01:01] second');
    expect(readFileSync(join(dir, 'c.srt'), 'utf8')).toContain('00:01:01,000 --> 00:01:05,000');
    expect(existsSync(join(dir, 'bad.txt'))).toBe(false);
    // Each file decoded exactly once (decode-ahead result reused).
    expect([...loads].sort()).toEqual([a, b, c].sort());
    expect(statuses.at(-1)).toMatch(/(Готово|Done) 2, (пропуск|skipped) 1/);
    expect(runner.busy).toBe(false);
  });

  it('stops: running row becomes Stopped, the rest stays queued', async () => {
    let runner!: FileRunner;
    const slow: FileTranscriber = (_p, _s, _st, signal) =>
      new Promise((_, rej) => {
        signal.addEventListener('abort', () => {
          const e = new Error('x');
          e.name = 'AbortError';
          rej(e);
        });
        setTimeout(() => runner.stop(), 5);
      });
    const s = setup({ prepare: async () => ({ ok: true, transcriber: slow }) });
    runner = s.runner;
    s.queue.add([audio('s1.wav'), audio('s2.wav')], false);
    await runner.run();
    expect(s.queue.snapshot().map((r) => r.state)).toEqual(['Stopped', 'Queued']);
    expect(s.statuses.at(-1)).toMatch(/Остановлено|Stopped/);
  });

  it('reports a missing model and leaves the queue alone', async () => {
    const s = setup({ prepare: async () => ({ ok: false, message: 'no model' }) });
    s.queue.add([audio('m.wav')], false);
    await s.runner.run();
    expect(s.statuses.at(-1)).toBe('no model');
    expect(s.queue.snapshot()[0].state).toBe('Queued');
  });

  it('notifies after a long run and notes the unported Brain', async () => {
    let clock = 0;
    const notes: string[] = [];
    const s = setup({
      now: () => (clock += 70_000),
      options: () => ({ timestamps: false, srt: false, useBrain: true }),
      notifyDone: (title, body) => notes.push(`${title}|${body}`),
    });
    s.queue.add([audio('long.wav')], false);
    await s.runner.run();
    expect(s.queue.snapshot()[0].note).toMatch(/мозг пока не перенесён|Brain not ported yet/);
    expect(readFileSync(join(dir, 'long.txt'), 'utf8')).toBe('first long.wav\nsecond');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('long.txt');
  });
});
