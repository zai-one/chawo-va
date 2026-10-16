import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { wavBytes } from '@chawo/core/audio';
import { HermesServer, boundary, extractAudio, firstFilePart, isLoopback, type HermesResult } from '../src/network/hermesServer';
import { MAX_BYTES } from '../src/file/fileTranscript';

const servers: HermesServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.dispose();
});

type Model = { loaded: boolean; seen: Uint8Array[]; error?: string; throws?: boolean };

function fakeTranscribe(m: Model) {
  return (audio: Uint8Array): HermesResult => {
    if (audio.length === 0) {
      return { modelLoaded: m.loaded, text: null, model: m.loaded ? 'v3_e2e_rnnt' : 'V3E2eRnnt', device: m.loaded ? 'cpu' : '', provider: m.loaded ? 'cpu' : '', seconds: 0, error: null };
    }
    if (m.throws) throw new Error('boom');
    m.seen.push(audio);
    if (!m.loaded) return { modelLoaded: false, text: null, model: '', device: '', provider: '', seconds: 0, error: null };
    if (m.error) return { modelLoaded: true, text: null, model: 'v3_e2e_rnnt', device: 'cpu', provider: 'cpu', seconds: 0, error: m.error };
    return { modelLoaded: true, text: `got ${audio.length}`, model: 'v3_e2e_rnnt', device: 'cpu', provider: 'cpu', seconds: 1.23456, error: null };
  };
}

async function start(m: Model, lan = false, remote?: string): Promise<{ base: string; server: HermesServer }> {
  const server = new HermesServer(0, fakeTranscribe(m), lan, remote ? { remoteAddress: () => remote } : {});
  servers.push(server);
  await server.start();
  return { base: `http://127.0.0.1:${server.port}`, server };
}

/** Raw request over a socket, for what fetch will not send (no Content-Length, huge Content-Length). */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    let out = '';
    sock.on('data', (d) => (out += d.toString('utf8')));
    sock.on('end', () => resolve(out));
    sock.on('close', () => resolve(out));
    sock.on('error', (e) => (out ? resolve(out) : reject(e)));
    sock.write(text);
  });
}

describe('HermesServer', () => {
  it('binds 127.0.0.1 by default and answers /v1/health and /health', async () => {
    const m: Model = { loaded: true, seen: [] };
    const { base, server } = await start(m);
    expect(server.bindAddress).toBe('127.0.0.1');
    expect(server.listening).toBe(true);
    for (const path of ['/v1/health', '/health?x=1']) {
      const r = await fetch(base + path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await r.json()).toEqual({ ok: true, model_loaded: true, model: 'v3_e2e_rnnt', device: 'cpu', provider: 'cpu', port: server.port, listen: '127.0.0.1' });
    }
    m.loaded = false;
    const r = await fetch(base + '/v1/health');
    expect(await r.json()).toMatchObject({ ok: true, model_loaded: false, model: 'V3E2eRnnt' });
    expect(m.seen).toHaveLength(0);
  });

  it('LAN mode binds 0.0.0.0', async () => {
    const { base, server } = await start({ loaded: true, seen: [] }, true);
    expect(server.bindAddress).toBe('0.0.0.0');
    expect(((await (await fetch(base + '/health')).json()) as { listen: string }).listen).toBe('0.0.0.0');
  });

  it('POST raw WAV → text, model, rounded seconds; /transcribe works too', async () => {
    const m: Model = { loaded: true, seen: [] };
    const { base } = await start(m);
    const wav = wavBytes(new Float32Array(1600).fill(0.1), 16000);
    for (const path of ['/v1/transcribe', '/transcribe']) {
      const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ text: `got ${wav.length}`, model: 'v3_e2e_rnnt', device: 'cpu', provider: 'cpu', sample_rate: 16000, seconds: 1.235 });
    }
    expect(Buffer.from(m.seen[0]).equals(Buffer.from(wav))).toBe(true);
  });

  it('multipart/form-data: the first file part is the audio', async () => {
    const m: Model = { loaded: true, seen: [] };
    const { base } = await start(m);
    const wav = wavBytes(new Float32Array(800).fill(-0.2), 16000);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'take.wav');
    const r = await fetch(base + '/v1/transcribe', { method: 'POST', body: form });
    expect(r.status).toBe(200);
    expect(Buffer.from(m.seen[0]).equals(Buffer.from(wav))).toBe(true);
  });

  it('empty body → 400 empty_body; no model → 503; bad audio → 400 bad_audio; throw → 400 bad_request', async () => {
    const m: Model = { loaded: true, seen: [] };
    const { base } = await start(m);
    const post = (body: Uint8Array) => fetch(base + '/v1/transcribe', { method: 'POST', body });
    let r = await post(new Uint8Array(0));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'empty_body' });
    m.loaded = false;
    r = await post(new Uint8Array([1, 2, 3]));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'model_not_loaded' });
    m.loaded = true;
    m.error = 'need a wav or ogg/opus buffer';
    r = await post(new Uint8Array([1, 2, 3]));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad_audio', detail: 'need a wav or ogg/opus buffer' });
    m.throws = true;
    r = await post(new Uint8Array([1, 2, 3]));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad_request', detail: 'boom' });
  });

  it('unknown path or method → 404 not_found', async () => {
    const { base } = await start({ loaded: true, seen: [] });
    expect((await fetch(base + '/v1/models')).status).toBe(404);
    const r = await fetch(base + '/v1/health', { method: 'POST', body: new Uint8Array([1]) });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
  });

  it('POST without Content-Length or over MaxBytes → 400', async () => {
    const { server } = await start({ loaded: true, seen: [] });
    const chunked = await raw(server.port, 'POST /v1/transcribe HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n');
    expect(chunked).toMatch(/^HTTP\/1\.1 400 Bad Request/);
    expect(chunked).toContain('POST needs Content-Length');
    const big = await raw(server.port, `POST /v1/transcribe HTTP/1.1\r\nHost: x\r\nContent-Length: ${MAX_BYTES + 1}\r\n\r\n`);
    expect(big).toMatch(/^HTTP\/1\.1 400 Bad Request/);
    expect(big).toContain('content-length is missing or too large');
    expect(big).toContain('Connection: close');
  });

  it('localhost only: a peer that is not loopback gets 403 localhost_only; LAN mode lets it in', async () => {
    const { base } = await start({ loaded: true, seen: [] }, false, '192.168.1.50');
    const r = await fetch(base + '/v1/health');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'localhost_only' });
    const lan = await start({ loaded: true, seen: [] }, true, '192.168.1.50');
    expect((await fetch(lan.base + '/v1/health')).status).toBe(200);
  });

  it('a taken port rejects start(); dispose frees it', async () => {
    const { server } = await start({ loaded: true, seen: [] });
    const clash = new HermesServer(server.port, fakeTranscribe({ loaded: true, seen: [] }));
    await expect(clash.start()).rejects.toThrow(/EADDRINUSE/);
    const port = server.port;
    await server.dispose();
    const again = new HermesServer(port, fakeTranscribe({ loaded: true, seen: [] }));
    servers.push(again);
    await again.start();
    expect(again.port).toBe(port);
  });
});

describe('Hermes request helpers', () => {
  it('isLoopback', () => {
    for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['192.168.1.2', '::ffff:10.0.0.1', '', undefined, 'fe80::1']) expect(isLoopback(a)).toBe(false);
  });

  it('boundary and the first part, like HermesServer.FirstFilePart', () => {
    expect(boundary('multipart/form-data; boundary="abc"')).toBe('abc');
    expect(boundary('multipart/form-data;boundary=XyZ')).toBe('XyZ');
    expect(boundary('multipart/form-data')).toBe('');
    const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="file"\r\n\r\nAUDIO\r\n--b\r\nsecond\r\n--b--\r\n');
    expect(Buffer.from(firstFilePart(body, 'b')).toString()).toBe('AUDIO');
    expect(() => extractAudio('multipart/form-data', body)).toThrow('multipart without a boundary');
    expect(() => firstFilePart(Buffer.from('nothing'), 'b')).toThrow('multipart boundary not found');
    expect(() => firstFilePart(Buffer.from('--b\r\nno header end'), 'b')).toThrow('multipart part has no header');
    expect(extractAudio('audio/wav', body)).toBe(body);
  });
});
