import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import { readWav } from '@chawo/core/audio';
import { HermesServer } from '../src/network/hermesServer';
import { makeHermesTranscribe, type HermesRecognizer } from '../src/network/hermesTranscribe';
import * as RemoteSpeech from '../src/network/remoteSpeech';
import { RemoteHostException } from '../src/network/remoteSpeech';

beforeAll(() => applyLanguage('Russian'));

const S = (host: string, port = 17831) => ({ RemoteHost: host, RemotePort: port });

describe('RemoteSpeech.tryEndpoint', () => {
  const url = (host: string, port?: number) => {
    const r = RemoteSpeech.tryEndpoint(S(host, port));
    return r.ok ? r.url : `ERR ${r.russian}`;
  };
  it('builds http://host:port/v1/transcribe', () => {
    expect(url('192.168.1.20')).toBe('http://192.168.1.20:17831/v1/transcribe');
    expect(url('  host.lan/  ', 9000)).toBe('http://host.lan:9000/v1/transcribe');
    expect(url('::1')).toBe('http://[::1]:17831/v1/transcribe');
    expect(url('[fe80::1]')).toBe('http://[fe80::1]:17831/v1/transcribe');
  });
  it('a bad saved port falls back to 17831', () => {
    expect(url('h', 0)).toBe('http://h:17831/v1/transcribe');
    expect(url('h', 70000)).toBe('http://h:17831/v1/transcribe');
  });
  it('a full http URL: its port wins; no port means 80 like .NET Uri', () => {
    expect(url('http://10.0.0.5:18000/whatever')).toBe('http://10.0.0.5:18000/v1/transcribe');
    expect(url('HTTP://10.0.0.5')).toBe('http://10.0.0.5/v1/transcribe');
    expect(url('http://[::1]:5000')).toBe('http://[::1]:5000/v1/transcribe');
  });
  it('the WPF messages for each failure', () => {
    expect(url('')).toBe('ERR Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.');
    expect(url('my host')).toBe('ERR Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.');
    expect(url('a/b')).toBe('ERR Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.');
    expect(url('https://host')).toBe('ERR Нужен адрес http. Хост Chawo Voice Assistant слушает http, не https.');
    expect(url('http://')).toBe('ERR Адрес хоста не разобрать. Нужен IP или имя.');
    expect(url('192.168.1.5:17831')).toBe('ERR Адрес хоста или порт неверные. Модель здесь не скачивается.');
    const r = RemoteSpeech.tryEndpoint(S(''));
    expect(r.ok === false && r.english).toBe('Set the host address under Network. This PC does not download a model.');
  });
});

type Call = { url: string; method: string; type?: string; body?: Uint8Array; signal?: AbortSignal };

function fakeFetch(reply: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const c: Call = { url: String(input), method: init?.method ?? 'GET', type: headers['Content-Type'], body: init?.body as Uint8Array | undefined, signal: init?.signal ?? undefined };
    calls.push(c);
    return reply(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe('RemoteSpeech.transcribe / transcribeBytes', () => {
  it('posts a 16 kHz WAV (resampled) and returns the text', async () => {
    const { f, calls } = fakeFetch(() => json({ text: 'привет' }));
    const text = await RemoteSpeech.transcribe(S('host.lan'), new Float32Array(48000).fill(0.25), 48000, undefined, f);
    expect(text).toBe('привет');
    expect(calls[0].url).toBe('http://host.lan:17831/v1/transcribe');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].type).toBe('audio/wav');
    const wav = readWav(calls[0].body!);
    expect(wav.rate).toBe(16000);
    expect(wav.samples.length).toBe(16000);
  });

  it('maps host answers to RemoteHostException with the WPF texts', async () => {
    const cases: [Response | (() => never), string, string][] = [
      [json({ error: 'model_not_loaded' }, 503), 'Хост на связи, но модель там не загружена. Здесь ничего не скачиваю.', 'The host answered, but its model is not loaded. Nothing is downloaded here.'],
      [json({ error: 'bad_audio' }, 400), 'Хост не принял файл. Нужен WAV 16 бит или Ogg/Opus. Модель здесь не скачивается.', 'The host rejected the file. It needs 16-bit WAV or Ogg/Opus. This PC does not download a model.'],
      [json({ error: 'x' }, 500), 'Хост ответил ошибкой 500. Модель здесь не скачивается.', 'The host returned 500. This PC does not download a model.'],
      [new Response('<html>', { status: 200 }), 'Хост ответил не текстом. Модель здесь не скачивается.', 'The host answer was not text. This PC does not download a model.'],
      [json({ text: 5 }), 'Хост ответил не текстом. Модель здесь не скачивается.', 'The host answer was not text. This PC does not download a model.'],
      [() => { throw new TypeError('fetch failed'); }, 'Хост не отвечает. Проверьте адрес и порт. Модель на этом компьютере не скачивается.', 'The host did not answer. Check the address and port. This PC does not download a model.'],
    ];
    for (const [reply, ru, en] of cases) {
      const { f } = fakeFetch(() => (typeof reply === 'function' ? reply() : reply));
      const e = await RemoteSpeech.transcribe(S('h'), new Float32Array(100), 16000, undefined, f).catch((x) => x);
      expect(e).toBeInstanceOf(RemoteHostException);
      expect(e.russian).toBe(ru);
      expect(e.english).toBe(en);
      expect(e.message).toBe(ru);
    }
  });

  it('a bad address throws before any request', async () => {
    const { f, calls } = fakeFetch(() => json({ text: 'x' }));
    const e = await RemoteSpeech.transcribe(S(''), new Float32Array(10), 16000, undefined, f).catch((x) => x);
    expect(e).toBeInstanceOf(RemoteHostException);
    expect(calls).toHaveLength(0);
  });

  it('cancel: the caller abort is an AbortError, not a dead host', async () => {
    const { f } = fakeFetch((c) => new Promise<Response>((_r, reject) => {
      c.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const ctl = new AbortController();
    const p = RemoteSpeech.transcribe(S('h'), new Float32Array(10), 16000, ctl.signal, f);
    ctl.abort();
    const e = await p.catch((x) => x);
    expect(e.name).toBe('AbortError');
    expect(e).not.toBeInstanceOf(RemoteHostException);
    const pre = await RemoteSpeech.transcribeBytes(S('h'), new Uint8Array(4), 'audio/wav', ctl.signal, f).catch((x) => x);
    expect(pre.name).toBe('AbortError');
  });

  it('transcribeBytes posts the bytes as-is with the given content type', async () => {
    const { f, calls } = fakeFetch(() => json({ text: 'файл' }));
    const body = new Uint8Array([79, 103, 103, 83, 1, 2]);
    expect(await RemoteSpeech.transcribeBytes(S('h', 9999), body, 'audio/ogg', undefined, f)).toBe('файл');
    expect(calls[0]).toMatchObject({ url: 'http://h:9999/v1/transcribe', type: 'audio/ogg' });
    expect(calls[0].body).toBe(body);
  });
});

describe('RemoteSpeech.check', () => {
  it('loaded / not loaded / error status / down / bad address', async () => {
    let reply: () => Response = () => json({ ok: true, model_loaded: true });
    const { f, calls } = fakeFetch(() => reply());
    expect(await RemoteSpeech.check(S('h'), f)).toBe('Хост отвечает, модель загружена.');
    expect(calls[0]).toMatchObject({ url: 'http://h:17831/v1/health', method: 'GET' });
    reply = () => json({ ok: true, model_loaded: false });
    expect(await RemoteSpeech.check(S('h'), f)).toBe('Хост отвечает, но модель там не загружена. Здесь ничего не скачиваю.');
    reply = () => new Response('nope', { status: 200 });
    expect(await RemoteSpeech.check(S('h'), f)).toBe('Хост отвечает, но модель там не загружена. Здесь ничего не скачиваю.');
    reply = () => json({ error: 'localhost_only' }, 403);
    expect(await RemoteSpeech.check(S('h'), f)).toBe('Хост ответил 403. Модель здесь не скачивается.');
    reply = () => { throw new TypeError('fetch failed'); };
    expect(await RemoteSpeech.check(S('h'), f)).toBe('Хост не отвечает. Проверьте адрес и порт. Модель здесь не скачивается.');
    expect(await RemoteSpeech.check(S(''), f)).toBe('Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.');
  });

  it('gives up after the timeout', async () => {
    const { f } = fakeFetch((c) => new Promise<Response>((_r, reject) => {
      c.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    expect(await RemoteSpeech.check(S('h'), f, 30)).toBe('Хост не отвечает. Проверьте адрес и порт. Модель здесь не скачивается.');
  });
});

describe('RemoteSpeech against a real Hermes (loopback)', () => {
  let server: HermesServer | null = null;
  afterEach(async () => {
    await server?.dispose();
    server = null;
  });

  class Rec implements HermesRecognizer {
    readonly modelId = 'v3_e2e_rnnt';
    deviceActual = 'cpu';
    provider = 'cpu';
    pieces: number[] = [];
    pieceRanges(s: Float32Array) {
      const half = Math.floor(s.length / 2);
      return [{ from: 0, to: half }, { from: half, to: s.length }];
    }
    async transcribePiece(s: Float32Array) {
      this.pieces.push(s.length);
      return `кусок ${this.pieces.length}`;
    }
    async transcribeCancelable(): Promise<string> {
      throw new Error('not used');
    }
  }

  it('check and transcribe end to end; no model → 503 → RemoteHostException', async () => {
    let rec: Rec | null = null;
    const transcribe = makeHermesTranscribe({ current: () => rec, modelName: () => 'V3E2eRnnt' });
    server = new HermesServer(0, transcribe, false);
    await server.start();
    const s = S('127.0.0.1', server.port);
    expect(await RemoteSpeech.check(s)).toBe('Хост отвечает, но модель там не загружена. Здесь ничего не скачиваю.');
    const none = await RemoteSpeech.transcribe(s, new Float32Array(8000), 16000).catch((x) => x);
    expect(none).toBeInstanceOf(RemoteHostException);
    expect(none.russian).toMatch(/^Хост на связи, но модель там не загружена/);

    rec = new Rec();
    expect(await RemoteSpeech.check(s)).toBe('Хост отвечает, модель загружена.');
    expect(await RemoteSpeech.transcribe(s, new Float32Array(44100).fill(0.1), 44100)).toBe('кусок 1\nкусок 2');
    expect(rec.pieces).toEqual([8000, 8000]);
    // Garbage is bad_audio (400) → the WPF "host rejected the file" text.
    const bad = await RemoteSpeech.transcribeBytes(s, new Uint8Array([1, 2, 3, 4]), 'application/octet-stream').catch((x) => x);
    expect(bad).toBeInstanceOf(RemoteHostException);
    expect(bad.russian).toMatch(/^Хост не принял файл/);
  });

  it('a host that is down is a short RemoteHostException', async () => {
    const tmp = new HermesServer(0, () => ({ modelLoaded: false, text: null, model: '', device: '', provider: '', seconds: 0, error: null }));
    await tmp.start();
    const port = tmp.port;
    await tmp.dispose();
    const e = await RemoteSpeech.transcribe(S('127.0.0.1', port), new Float32Array(10), 16000).catch((x) => x);
    expect(e).toBeInstanceOf(RemoteHostException);
    expect(e.russian).toMatch(/^Хост не отвечает/);
  });
});
