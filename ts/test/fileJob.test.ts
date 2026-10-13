import { cpus } from 'node:os';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { FileJob } from '../src/core/fileJob';
import { Recognizer } from '../src/core/recognizer';

function fakeRecognizer(overrides: Partial<Recognizer> & { deviceActual?: string; encoderAcceptsBatch?: boolean; intraOpThreads?: number } = {}): Recognizer {
  const rec = {
    deviceActual: overrides.deviceActual ?? 'cpu',
    provider: 'cpu',
    encoderAcceptsBatch: overrides.encoderAcceptsBatch ?? false,
    intraOpThreads: overrides.intraOpThreads ?? 4,
    sampleRate: 16000,
    script: 'auto' as const,
    dispose: vi.fn(async () => undefined),
    cancelRun: vi.fn(),
    transcribePiece: vi.fn(async (wave: Float32Array) => `len:${wave.length}`),
    transcribeBatch: vi.fn(async (waves: Float32Array[]) => waves.map((w) => `len:${w.length}`)),
  };
  return rec as unknown as Recognizer;
}

describe('FileJob.open plan wiring', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openSpy = vi.spyOn(Recognizer, 'open');
  });
  afterEach(() => {
    openSpy.mockRestore();
  });

  it('keeps one CPU worker when Auto RAM budget allows only one session', async () => {
    const cores = Math.max(1, cpus().length);
    // Match plan.intraOpThreads so Open does not re-open the probe session.
    const first = fakeRecognizer({ deviceActual: 'cpu', intraOpThreads: cores });
    openSpy.mockResolvedValueOnce(first);
    // 1 GB available → resolvePlan for multilingual CTC forces 1 worker.
    const job = await FileJob.open('/fake/model', 'multilingual_large_ctc', 'cpu', 'auto', 'auto', 1 * 1024 ** 3);
    expect(job.plan.workers).toBe(1);
    expect(job.deviceActual).toBe('cpu');
    expect(openSpy).toHaveBeenCalledTimes(1);
    await job.dispose();
    expect(first.dispose).toHaveBeenCalled();
  });

  it('opens multiple CPU workers when plan asks for them', async () => {
    const probe = fakeRecognizer({ deviceActual: 'cpu', intraOpThreads: 4 });
    const w0 = fakeRecognizer({ deviceActual: 'cpu', intraOpThreads: 2 });
    const w1 = fakeRecognizer({ deviceActual: 'cpu', intraOpThreads: 2 });
    openSpy
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce(w0)
      .mockResolvedValueOnce(w1);
    // Plenty of RAM + v3 model + force 2 workers.
    const job = await FileJob.open('/fake/model', 'v3_e2e_rnnt', 'cpu', 2, 'russian', 16 * 1024 ** 3);
    expect(job.plan.workers).toBe(2);
    expect(probe.dispose).toHaveBeenCalled(); // probe discarded when workers > 1
    expect(openSpy).toHaveBeenCalledTimes(3);
    await job.dispose();
  });

  it('runs pieces on a single worker and reports progress', async () => {
    const cores = Math.max(1, cpus().length);
    const first = fakeRecognizer({ deviceActual: 'cpu', intraOpThreads: cores });
    openSpy.mockResolvedValue(first);
    const job = await FileJob.open('/fake/model', 'v3_e2e_rnnt', 'cpu', 1, 'auto', 16 * 1024 ** 3);
    const samples = new Float32Array(16000);
    samples.fill(0.1);
    const ranges = [
      { from: 0, to: 4000 },
      { from: 4000, to: 8000 },
    ];
    const progress: number[] = [];
    const texts = await job.run(samples, ranges, (done, total) => progress.push(done / total));
    expect(texts).toEqual(['len:4000', 'len:4000']);
    expect(progress).toEqual([0.5, 1]);
    expect(first.transcribePiece).toHaveBeenCalledTimes(2);
    await job.dispose();
  });
});
