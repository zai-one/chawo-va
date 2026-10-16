import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServeJobStore } from '../src/network/serveJobs';

const stores: ServeJobStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.dispose();
});

function waitUntil(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('ServeJobStore', () => {
  it('create → run → done with result.txt; DELETE removes files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-jobs-'));
    let now = 1_000_000;
    const store = new ServeJobStore(
      async (path) => {
        const bytes = readFileSync(path);
        return { text: `ok:${bytes.length}`, seconds: 1.5, model: 'v3_e2e_rnnt', device: 'cpu' };
      },
      { dataDir: dir, workers: 1, ttlMs: 60_000, now: () => now, sweepEveryMs: 60_000 },
    );
    stores.push(store);
    const rec = store.create(new Uint8Array([1, 2, 3, 4]), 'a.wav');
    expect(['queued', 'running']).toContain(rec.status);
    await waitUntil(() => store.get(rec.id)?.status === 'done');
    const done = store.get(rec.id)!;
    expect(done.text).toBe('ok:4');
    expect(done.resultPath).toBe('result.txt');
    expect(existsSync(join(dir, 'jobs', rec.id, 'result.txt'))).toBe(true);
    expect(store.toPublic(done).status).toBe('done');
    expect(store.delete(rec.id)).toBe(true);
    expect(store.get(rec.id)).toBeNull();
    expect(existsSync(join(dir, 'jobs', rec.id))).toBe(false);
  });

  it('TTL sweeper deletes old jobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-ttl-'));
    let now = 1_000;
    const store = new ServeJobStore(async () => ({ text: 'x', seconds: 0, model: 'm', device: 'cpu' }), {
      dataDir: dir,
      workers: 1,
      ttlMs: 100,
      now: () => now,
      sweepEveryMs: 60_000,
    });
    stores.push(store);
    const rec = store.create(new Uint8Array([9]), 'b.wav');
    await waitUntil(() => store.get(rec.id)?.status === 'done');
    now = 1_000 + 200;
    expect(store.sweep()).toBe(1);
    expect(store.get(rec.id)).toBeNull();
  });

  it('error status when transcribe throws; empty body rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-err-'));
    const store = new ServeJobStore(async () => {
      throw new Error('boom');
    }, { dataDir: dir, workers: 1, sweepEveryMs: 60_000 });
    stores.push(store);
    expect(() => store.create(new Uint8Array(0), null)).toThrow(/empty/);
    const rec = store.create(new Uint8Array([1]), null);
    await waitUntil(() => store.get(rec.id)?.status === 'error');
    expect(store.get(rec.id)!.error).toBe('boom');
  });
});
