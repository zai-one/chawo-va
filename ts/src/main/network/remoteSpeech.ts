// Client of another Chawo Voice Assistant. Posts a WAV to http://host:port/v1/transcribe.
// Never downloads weights. A dead host is an error, not a reason to fetch a model.
// Port of src/App/RemoteSpeech.cs; fetch is injectable so tests run against a fake host.

import { resample, wavBytes } from '../../core/audio';
import { HERMES_PORT } from '../../core/speechModels';
import { MAX_BYTES } from '../file/fileTranscript';
import type { SettingsData } from '../settings';

export type FetchLike = typeof fetch;
export type RemoteSettings = Pick<SettingsData, 'RemoteHost' | 'RemotePort'>;

export class RemoteHostException extends Error {
  readonly russian: string;
  readonly english: string;
  constructor(russian: string, english: string) {
    super(russian);
    this.name = 'RemoteHostException';
    this.russian = russian;
    this.english = english;
  }
}

/** Dictation posts: 90 s (WPF HttpClient.Timeout). File posts wait as long as the host needs. */
export const TAKE_TIMEOUT_MS = 90_000;
export const CHECK_TIMEOUT_MS = 5_000;

export type Endpoint = { ok: true; url: string } | { ok: false; russian: string; english: string };

const fail = (russian: string, english: string): Endpoint => ({ ok: false, russian, english });

export function tryEndpoint(settings: RemoteSettings): Endpoint {
  let host = (settings.RemoteHost ?? '').trim();
  let port = Number.isInteger(settings.RemotePort) && settings.RemotePort >= 1 && settings.RemotePort <= 65535
    ? settings.RemotePort
    : HERMES_PORT;

  const lower = host.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(host);
    } catch {
      return fail('Адрес хоста не разобрать. Нужен IP или имя.', 'Could not read the host address. Use an IP or a name.');
    }
    if (!parsed.hostname) return fail('Адрес хоста не разобрать. Нужен IP или имя.', 'Could not read the host address. Use an IP or a name.');
    if (parsed.protocol !== 'http:') {
      return fail('Нужен адрес http. Хост Chawo Voice Assistant слушает http, не https.',
        'Use http. The Chawo Voice Assistant host listens on http, not https.');
    }
    // .NET Uri.Port is 80 for "http://host" without a port; the WPF client posts there too.
    port = parsed.port ? Number(parsed.port) : 80;
    host = parsed.hostname; // punycode for IDN, [..] kept for IPv6 (Uri.IdnHost)
  }

  host = host.trim().replace(/\/+$/, '');
  if (host.length === 0 || /[ /\\?]/.test(host)) {
    return fail('Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.',
      'Set the host address under Network. This PC does not download a model.');
  }
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    const u = new URL(`http://${hostPart}:${port}/v1/transcribe`);
    if (!u.hostname) throw new Error('no host');
    return { ok: true, url: u.toString() };
  } catch {
    return fail('Адрес хоста или порт неверные. Модель здесь не скачивается.',
      'The host address or port is not valid. This PC does not download a model.');
  }
}

const down = () => new RemoteHostException(
  'Хост не отвечает. Проверьте адрес и порт. Модель на этом компьютере не скачивается.',
  'The host did not answer. Check the address and port. This PC does not download a model.',
);

function abortError(): Error {
  const e = new Error('Operation canceled');
  e.name = 'AbortError';
  return e;
}

/** The caller's signal plus an optional timeout; a timeout is a dead host, the caller's abort is a cancel. */
function deadline(signal: AbortSignal | undefined, ms: number | null): { signal: AbortSignal | undefined; done: () => void } {
  if (ms === null) return { signal, done: () => undefined };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  timer.unref?.();
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function post(
  url: string,
  body: Uint8Array,
  contentType: string,
  signal: AbortSignal | undefined,
  timeoutMs: number | null,
  fetchImpl: FetchLike,
): Promise<string> {
  if (signal?.aborted) throw abortError();
  const d = deadline(signal, timeoutMs);
  try {
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: body as unknown as BodyInit,
        redirect: 'manual',
        signal: d.signal,
      });
    } catch {
      // A timeout or a refused connection is a dead host; the caller's own abort is a cancel.
      if (signal?.aborted) throw abortError();
      throw down();
    }
    return await readText(resp, signal);
  } finally {
    d.done();
  }
}

async function readText(resp: Response, signal: AbortSignal | undefined): Promise<string> {
  let body: string;
  try {
    body = await resp.text();
  } catch {
    if (signal?.aborted) throw abortError();
    throw down();
  }
  if (resp.status === 503) {
    throw new RemoteHostException('Хост на связи, но модель там не загружена. Здесь ничего не скачиваю.',
      'The host answered, but its model is not loaded. Nothing is downloaded here.');
  }
  if (resp.status === 400) {
    throw new RemoteHostException('Хост не принял файл. Нужен WAV 16 бит или Ogg/Opus. Модель здесь не скачивается.',
      'The host rejected the file. It needs 16-bit WAV or Ogg/Opus. This PC does not download a model.');
  }
  if (resp.status < 200 || resp.status > 299) {
    throw new RemoteHostException(`Хост ответил ошибкой ${resp.status}. Модель здесь не скачивается.`,
      `The host returned ${resp.status}. This PC does not download a model.`);
  }
  try {
    const doc = JSON.parse(body) as unknown;
    if (doc && typeof doc === 'object' && typeof (doc as { text?: unknown }).text === 'string') return (doc as { text: string }).text;
  } catch {
    /* not JSON */
  }
  throw new RemoteHostException('Хост ответил не текстом. Модель здесь не скачивается.',
    'The host answer was not text. This PC does not download a model.');
}

/** Sends 16 kHz audio. Throws RemoteHostException when the host is down or has no model. Does not download. */
export async function transcribe(
  settings: RemoteSettings,
  samples: Float32Array,
  rate: number,
  signal?: AbortSignal,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string> {
  const ep = tryEndpoint(settings);
  if (!ep.ok) throw new RemoteHostException(ep.russian, ep.english);
  if (rate !== 16000) samples = resample(samples, rate, 16000);
  return post(ep.url, wavBytes(samples, 16000), 'audio/wav', signal, TAKE_TIMEOUT_MS, fetchImpl);
}

/**
 * Posts the file bytes as-is (wav or ogg). The host splits and recognizes.
 * Does not download a model. Cancel with the signal; no timeout (a long file takes long).
 */
export async function transcribeBytes(
  settings: RemoteSettings,
  body: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string> {
  const ep = tryEndpoint(settings);
  if (!ep.ok) throw new RemoteHostException(ep.russian, ep.english);
  if (body.length > MAX_BYTES) {
    throw new RemoteHostException('Файл слишком большой. Модель здесь не скачивается.',
      'The file is too large. This PC does not download a model.');
  }
  return post(ep.url, body, contentType, signal, null, fetchImpl);
}

/** Short Russian line for the Network page. Never downloads. */
export async function check(settings: RemoteSettings, fetchImpl: FetchLike = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS): Promise<string> {
  const ep = tryEndpoint(settings);
  if (!ep.ok) return ep.russian;
  const health = new URL(ep.url);
  health.pathname = '/v1/health';
  health.search = '';
  const d = deadline(undefined, timeoutMs);
  try {
    const resp = await fetchImpl(health.toString(), { method: 'GET', redirect: 'manual', signal: d.signal });
    const body = await resp.text();
    if (resp.status < 200 || resp.status > 299) return `Хост ответил ${resp.status}. Модель здесь не скачивается.`;
    let loaded = false;
    try {
      const doc = JSON.parse(body) as { model_loaded?: unknown };
      if (typeof doc?.model_loaded === 'boolean') loaded = doc.model_loaded;
    } catch {
      /* not JSON */
    }
    return loaded
      ? 'Хост отвечает, модель загружена.'
      : 'Хост отвечает, но модель там не загружена. Здесь ничего не скачиваю.';
  } catch {
    return 'Хост не отвечает. Проверьте адрес и порт. Модель здесь не скачивается.';
  } finally {
    d.done();
  }
}
