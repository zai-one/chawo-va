import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wavBytes } from '@chawo/core/audio';
import { ServeServer } from '../src/network/serveServer';
import type { HermesResult } from '../src/network/hermesServer';
import { resolveBind } from '../src/network/serveAuth';

const servers: ServeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.dispose();
});

function fakeHermes(loaded = true) {
  return (audio: Uint8Array): HermesResult => {
    if (audio.length === 0) {
      return { modelLoaded: loaded, text: null, model: 'v3_e2e_rnnt', device: 'cpu', provider: 'cpu', seconds: 0, error: null };
    }
    return { modelLoaded: loaded, text: `got ${audio.length}`, model: 'v3_e2e_rnnt', device: 'cpu', provider: 'cpu', seconds: 0.5, error: null };
  };
}

async function start(opts: {
  token?: string | null;
  remote?: string;
  host?: string;
  jobText?: string;
  jobDelayMs?: number;
}): Promise<{ base: string; server: ServeServer; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'chawo-serve-'));
  const token = opts.token === undefined ? null : opts.token;
  const bind = resolveBind(opts.host, token);
  if (!bind.ok) throw new Error(bind.error);
  const delay = opts.jobDelayMs ?? 0;
  const server = new ServeServer({
    host: bind.host,
    port: 0,
    token,
    dataDir,
    transcribe: fakeHermes(true),
    jobTranscribe: async () => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return { text: opts.jobText ?? 'job-ok', seconds: 2, model: 'v3_e2e_rnnt', device: 'cpu' };
    },
    workers: 2,
    sweepEveryMs: 60_000,
    remoteAddress: opts.remote ? () => opts.remote! : undefined,
  });
  servers.push(server);
  await server.start();
  return { base: `http://127.0.0.1:${server.port}`, server, dataDir };
}

function waitUntil(pred: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(() => void tick(), 30);
    };
    void tick();
  });
}

describe('ServeServer', () => {
  it('health + sync transcribe on localhost without token', async () => {
    const { base, server } = await start({});
    expect(server.bindAddress).toBe('127.0.0.1');
    const h = (await (await fetch(base + '/v1/health')).json()) as { jobs: unknown };
    expect(h).toMatchObject({ ok: true, model_loaded: true, listen: '127.0.0.1' });
    expect(h.jobs).toMatchObject({ workers: 2 });
    const wav = wavBytes(new Float32Array(800).fill(0.1), 16000);
    const r = await fetch(base + '/v1/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ text: `got ${wav.length}`, sample_rate: 16000 });
  });

  it('non-loopback without token → 403; with token requires Bearer', async () => {
    const noTok = await start({ remote: '192.168.1.9' });
    expect((await fetch(noTok.base + '/v1/health')).status).toBe(403);

    const withTok = await start({ token: 's3cret', host: '127.0.0.1', remote: '192.168.1.9' });
    expect((await fetch(withTok.base + '/v1/health')).status).toBe(401);
    expect((await fetch(withTok.base + '/v1/health', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(withTok.base + '/v1/health', { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(200);
    // loopback may skip token even when configured
    const local = await start({ token: 's3cret', host: '127.0.0.1', remote: '127.0.0.1' });
    expect((await fetch(local.base + '/health')).status).toBe(200);
  });

  it('job lifecycle: POST → poll → DELETE', async () => {
    const { base } = await start({ jobText: 'hello job' });
    const wav = wavBytes(new Float32Array(400).fill(0.05), 16000);
    const created = await fetch(base + '/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'Content-Disposition': 'attachment; filename="t.wav"' },
      body: wav,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; status: string };
    expect(['queued', 'running']).toContain(body.status);
    await waitUntil(async () => {
      const j = (await (await fetch(base + `/v1/jobs/${body.id}`)).json()) as { status: string };
      return j.status === 'done';
    });
    const done = await (await fetch(base + `/v1/jobs/${body.id}`)).json();
    expect(done).toMatchObject({ text: 'hello job', status: 'done' });
    expect((await fetch(base + `/v1/jobs/${body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(base + `/v1/jobs/${body.id}`)).status).toBe(404);
  });

  it('refuses non-loopback bind without token at resolveBind', () => {
    expect(resolveBind('0.0.0.0', null).ok).toBe(false);
  });
});
