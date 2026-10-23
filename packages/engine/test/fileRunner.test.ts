import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileQueue } from '../src/file/fileQueue';
import { FileRunner, type FileRunProgress, type FileRunnerDeps, type FileTranscriber } from '../src/file/fileRunner';

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
    options: () => ({ timestamps: true, srt: true, useBrain: false, diarize: false, brief: false }),
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

  it('notifies after a long run and notes when Brain is not set up', async () => {
    let clock = 0;
    const notes: string[] = [];
    const s = setup({
      now: () => (clock += 70_000),
      options: () => ({ timestamps: false, srt: false, useBrain: true, diarize: false, brief: false }),
      notifyDone: (title, body) => notes.push(`${title}|${body}`),
    });
    s.queue.add([audio('long.wav')], false);
    await s.runner.run();
    expect(s.queue.snapshot()[0].note).toMatch(/мозг не настроен|Brain is not set up/);
    expect(readFileSync(join(dir, 'long.txt'), 'utf8')).toBe('first long.wav\nsecond');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('long.txt');
  });

  it('useBrain with injected runBrain writes .brain.txt', async () => {
    const s = setup({
      options: () => ({ timestamps: false, srt: false, useBrain: true, diarize: false, brief: false }),
      runBrain: async (segments) => ({
        note: 'мозг ок',
        text: segments.map((x) => x.text).join('\n') + '\n\nКратко\n- x\n',
      }),
    });
    s.queue.add([audio('brainy.wav')], false);
    await s.runner.run();
    expect(existsSync(join(dir, 'brainy.brain.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'brainy.brain.txt'), 'utf8')).toContain('Кратко');
    expect(s.queue.snapshot()[0].note).toMatch(/мозг ок/);
  });

  it('brief with injected runBrief writes .brief.txt; failure is only a note', async () => {
    const s = setup({
      options: () => ({ timestamps: false, srt: false, useBrain: false, diarize: false, brief: true }),
      runBrief: async () => ({
        note: 'краткое и задачи',
        text: 'Кратко\n- ok\n\nЗадачи\n- one\n',
      }),
    });
    s.queue.add([audio('meet.wav')], false);
    await s.runner.run();
    expect(existsSync(join(dir, 'meet.brief.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'meet.brief.txt'), 'utf8')).toContain('Задачи');
    expect(s.queue.snapshot()[0].state).toBe('Done');
    expect(s.queue.snapshot()[0].note).toMatch(/краткое|brief/);

    const s2 = setup({
      options: () => ({ timestamps: false, srt: false, useBrain: false, diarize: false, brief: true }),
      runBrief: async () => {
        throw new Error('brain down');
      },
    });
    s2.queue.add([audio('meet2.wav')], false);
    await s2.runner.run();
    expect(s2.queue.snapshot()[0].state).toBe('Done');
    expect(s2.queue.snapshot()[0].note).toContain('brain down');
    expect(existsSync(join(dir, 'meet2.txt'))).toBe(true);
  });

  it('diarize with fake spans writes Спикер labels', async () => {
    const s = setup({
      options: () => ({ timestamps: false, srt: true, useBrain: false, diarize: true, brief: false }),
      runDiarize: async () => [
        { start: 0, end: 30, speaker: 5 },
        { start: 30, end: 120, speaker: 9 },
      ],
    });
    s.queue.add([audio('duo.wav')], false);
    await s.runner.run();
    const txt = readFileSync(join(dir, 'duo.txt'), 'utf8');
    expect(txt).toContain('Спикер 1: first duo.wav');
    expect(txt).toContain('Спикер 2: second');
    expect(s.queue.snapshot()[0].note).toMatch(/спикеры|speakers/);
    expect(readFileSync(join(dir, 'duo.srt'), 'utf8')).toContain('Спикер 1:');
  });

  it('diarize without models notes and still writes txt', async () => {
    const s = setup({
      options: () => ({ timestamps: false, srt: false, useBrain: false, diarize: true, brief: false }),
      // no runDiarize
    });
    s.queue.add([audio('solo.wav')], false);
    await s.runner.run();
    expect(readFileSync(join(dir, 'solo.txt'), 'utf8')).toBe('first solo.wav\nsecond');
    expect(s.queue.snapshot()[0].note).toMatch(/модели не скачаны|models not downloaded/);
  });

  it('the recognized text is on disk before speakers start, so a stopped speaker step loses nothing', async () => {
    let seen = '';
    const s = setup({
      options: () => ({ timestamps: false, srt: false, useBrain: false, diarize: true, brief: false }),
      runDiarize: async (_pcm, _status, signal) => {
        seen = readFileSync(join(dir, 'long.txt'), 'utf8');
        // Speakers on an hour-long file: the user presses «Остановить» here.
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(Object.assign(new Error('Operation canceled'), { name: 'AbortError' }))),
        );
      },
    });
    s.queue.add([audio('long.wav')], false);
    const run = s.runner.run();
    await vi.waitFor(() => expect(seen).not.toBe(''));
    s.runner.stop();
    await run;
    expect(seen).toBe('first long.wav\nsecond');
    expect(readFileSync(join(dir, 'long.txt'), 'utf8')).toBe('first long.wav\nsecond');
    expect(s.queue.snapshot()[0]).toMatchObject({ state: 'Stopped', note: expect.stringMatching(/без спикеров|without speakers/), outputPath: join(dir, 'long.txt') });
    expect(s.queue.lastOutput).toBe(join(dir, 'long.txt'));
  });

  it('progress: percent of the current step from the transcriber, null while unknown, cleared at the end', async () => {
    const seen: (FileRunProgress | null)[] = [];
    let runner: FileRunner | null = null;
    const steps: FileTranscriber = async (_p, samples, status) => {
      status('Piece 0 of 4', 0);
      seen.push(runner!.progress);
      status('Piece 3 of 4', 0.75);
      seen.push(runner!.progress);
      status('Finding pauses');
      seen.push(runner!.progress);
      return [{ start: 0, end: samples.length / 16000, text: 'x' }];
    };
    const s = setup({ prepare: async () => ({ ok: true, transcriber: steps }), now: () => 1234 });
    runner = s.runner;
    s.queue.add([audio('p1.wav'), audio('p2.wav')], false);
    expect(s.runner.progress).toBeNull();
    await s.runner.run();
    expect(seen.slice(0, 3)).toEqual([
      { index: 1, total: 2, percent: 0, startedAt: 1234 },
      { index: 1, total: 2, percent: 75, startedAt: 1234 },
      { index: 1, total: 2, percent: null, startedAt: 1234 },
    ]);
    expect(seen[3]).toMatchObject({ index: 2, total: 2, percent: 0 });
    expect(s.runner.progress).toBeNull();
  });

  it('diarize hook returning null notes missing models', async () => {
    const s = setup({
      options: () => ({ timestamps: false, srt: false, useBrain: false, diarize: true, brief: false }),
      runDiarize: async () => null,
    });
    s.queue.add([audio('miss.wav')], false);
    await s.runner.run();
    expect(s.queue.snapshot()[0].note).toMatch(/модели не скачаны|models not downloaded/);
    expect(existsSync(join(dir, 'miss.txt'))).toBe(true);
  });
});
