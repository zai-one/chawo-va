// The page recognizes each file in a worker thread (localTranscriber.transcribeInWorker): progress lines
// come back, Stop answers at once, a worker that cannot start lets the caller fall back to its own thread.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transcribeInWorker } from '../src/file/localTranscriber';
import type { LocalJobRequest } from '../src/file/localJob';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-filejob-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const req: LocalJobRequest = { modelDir: '/m', kind: 'v3_e2e_rnnt', device: 'cpu', parallelism: 'auto', script: 'auto', vadEnabled: true };

/** A stand-in for out/main/fileJobWorker.js speaking its protocol. */
function fakeWorker(onRun: string): string {
  const f = join(dir, `w-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(
    f,
    `const { parentPort } = require('node:worker_threads');
let cancelled = false;
parentPort.on('message', (m) => {
  if (m.type === 'cancel') { cancelled = true; return; }
  ${onRun}
});`,
  );
  return f;
}

describe('transcribeInWorker', () => {
  it('relays progress lines with their share and returns the segments; the caller keeps its samples', async () => {
    const file = fakeWorker(`
      parentPort.postMessage({ type: 'status', line: 'Кусок 0 из 2', fraction: 0 });
      parentPort.postMessage({ type: 'status', line: 'Кусок 1 из 2', fraction: 0.5 });
      parentPort.postMessage({ type: 'done', segments: [{ start: 0, end: m.samples.length / 16000, text: m.req.modelDir + ' ' + m.path + ' ' + m.ru }] });`);
    const said: [string, number | undefined][] = [];
    const samples = new Float32Array(32000);
    const segs = await transcribeInWorker(file, req, 'a.wav', samples, (l, f) => said.push([l, f]), new AbortController().signal);
    expect(segs).toEqual([{ start: 0, end: 2, text: '/m a.wav true' }]);
    expect(said).toEqual([['Кусок 0 из 2', 0], ['Кусок 1 из 2', 0.5]]);
    expect(samples.length).toBe(32000);
  });

  it('an error in the job comes back with its name (a missing model, an abort)', async () => {
    const file = fakeWorker(`parentPort.postMessage({ type: 'error', name: 'Error', message: 'model broken' });`);
    await expect(transcribeInWorker(file, req, 'a.wav', new Float32Array(16), () => {}, new AbortController().signal)).rejects.toThrow('model broken');
  });

  it('Stop rejects at once with AbortError and asks the worker to cancel', async () => {
    const flag = join(dir, 'cancelled.txt');
    const file = fakeWorker(`
      parentPort.postMessage({ type: 'status', line: 'Кусок 0 из 99', fraction: 0 });
      const iv = setInterval(() => { if (cancelled) { require('node:fs').writeFileSync(${JSON.stringify(flag)}, 'yes'); clearInterval(iv); parentPort.postMessage({ type: 'error', name: 'AbortError', message: 'Operation canceled' }); } }, 10);`);
    const ctrl = new AbortController();
    const run = transcribeInWorker(file, req, 'a.wav', new Float32Array(16), () => ctrl.abort(), ctrl.signal);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(flag)).toBe(true);
  });

  it('a worker that cannot start is reported as unavailable (the caller recognizes in its own thread)', async () => {
    await expect(transcribeInWorker(join(dir, 'missing.js'), req, 'a.wav', new Float32Array(16), () => {}, new AbortController().signal)).rejects.toMatchObject({ name: 'WorkerUnavailable' });
    const crash = fakeWorker(`throw new Error('cannot load onnxruntime here');`);
    await expect(transcribeInWorker(crash, req, 'a.wav', new Float32Array(16), () => {}, new AbortController().signal)).rejects.toMatchObject({ name: 'WorkerUnavailable' });
  });

  it('a worker that dies after it started is a real failure, not a fallback', async () => {
    const file = fakeWorker(`parentPort.postMessage({ type: 'status', line: 'go' }); setTimeout(() => process.exit(3), 20);`);
    await expect(transcribeInWorker(file, req, 'a.wav', new Float32Array(16), () => {}, new AbortController().signal)).rejects.toThrow(/код 3|code 3/);
  });
});
