// Reads text aloud through a speech service (ttsProviders). Runs in main: the renderer has no network.
// A long or mixed Russian/English text goes in pieces (splitByScript, splitForSpeech; with no voice
// chosen only by length, see synthesize), up to PARALLEL requests at a time; the pieces come back as one
// sound in their order: WAV pieces are merged into one WAV, MP3 pieces are joined (MP3 frames play one
// after another). Speed is not sent: the player changes it while playing, so one request serves every speed.
import { t } from '@chawo/core/strings';
import * as Log from '../log';
import { describeFailure, serverMessage, withTimeout, type FetchLike } from '../brain/speechCleanup';
import { speechInput, splitByScript, splitForSpeech } from './speechText';
import { voiceFor, type TtsProvider } from './ttsProviders';

export class TtsException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsException';
  }
}

export interface TtsTarget {
  provider: TtsProvider;
  baseUrl: string;
  key: string;
  model: string;
  voice: string;
}

export interface Speech {
  audio: Uint8Array;
  mime: string;
  pieces: number;
}

export interface SynthOptions {
  signal?: AbortSignal;
  fetch?: FetchLike;
  /** Per request (one piece). */
  timeoutMs?: number;
  /** Called after each piece: done of total. */
  onProgress?: (done: number, total: number) => void;
}

/** Gemini returns raw 16-bit mono PCM at this rate unless its mime type says otherwise. */
const GEMINI_RATE = 24_000;

/** The request address for `kind`: the base without a trailing slash or an endpoint the user pasted. */
export function ttsUrl(target: Pick<TtsTarget, 'provider' | 'baseUrl' | 'model'>): string {
  const base = target.baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(audio\/speech|chat\/completions)$/, '')
    .replace(/\/models\/[^/]+:generateContent$/, '');
  switch (target.provider.kind) {
    case 'speech':
      return `${base}/audio/speech`;
    case 'mimo':
      return `${base}/chat/completions`;
    case 'gemini':
      return `${base}/models/${encodeURIComponent(target.model.trim())}:generateContent`;
  }
}

/** Pieces asked at once: a long or mixed text is ready sooner, and three stay under a free tier's rate limit. */
const PARALLEL = 3;

export async function synthesize(target: TtsTarget, text: string, options: SynthOptions = {}): Promise<Speech> {
  const input = speechInput(text);
  if (!input) throw new TtsException(t('нечего читать: текст пустой', 'nothing to read: the text is empty'));
  if (!target.baseUrl.trim()) throw new TtsException(t('не указан адрес сервера', 'the server address is not set'));
  if (!target.model.trim()) throw new TtsException(t('не выбрана модель', 'no model is chosen'));
  if (target.provider.needsKey && !target.key.trim()) throw new TtsException(t('нет ключа сервиса', 'the service key is missing'));
  const voice = voiceFor(target.model, target.voice);
  // With no voice the service picks one and may pick anew for each request: the text then goes in as few
  // requests as it can (not cut where the language changes), so it is read in one voice.
  const parts = voice ? splitByScript(input) : [input];
  const pieces = parts.flatMap((part) => splitForSpeech(part, target.provider.maxChars));
  const steady: TtsTarget = { ...target, voice };
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 90_000;
  // Pieces go PARALLEL at a time and come back in order; the first failure stops the rest.
  const failed = new AbortController();
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, failed.signal]);
  const sounds: Uint8Array[] = new Array<Uint8Array>(pieces.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < pieces.length) {
      if (signal.aborted) throw new TtsException(t('остановлено', 'stopped'));
      const i = next++;
      sounds[i] = await requestPiece(steady, pieces[i], signal, fetchImpl, timeoutMs);
      options.onProgress?.(++done, pieces.length);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, pieces.length) }, worker));
  } catch (e) {
    failed.abort();
    throw e;
  }
  return { ...joinSounds(sounds), pieces: pieces.length };
}


async function requestPiece(target: TtsTarget, text: string, outer: AbortSignal, fetchImpl: FetchLike, timeoutMs: number): Promise<Uint8Array> {
  const deadline = withTimeout(outer, timeoutMs);
  try {
    const { headers, body } = request(target, text);
    const response = await fetchImpl(ttsUrl(target), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      Log.write(`tts server ${response.status}: ${serverMessage(errorBody)}`);
      throw new TtsException(describeFailure(response.status, errorBody));
    }
    return await readSound(target.provider, response);
  } catch (e) {
    if (e instanceof TtsException) throw e;
    if (deadline.timedOut()) {
      throw new TtsException(
        t(`сервер не ответил за ${Math.floor(timeoutMs / 1000)} секунд`, `the server did not answer within ${Math.floor(timeoutMs / 1000)} seconds`),
      );
    }
    if (outer.aborted) throw new TtsException(t('остановлено', 'stopped'));
    if (e instanceof TypeError) {
      Log.write(`tts server connection: ${e.message}`);
      throw new TtsException(t('нет связи с сервером, проверьте интернет или адрес', 'cannot reach the server, check the connection or the address'));
    }
    throw e;
  } finally {
    deadline.clear();
  }
}

function request(target: TtsTarget, text: string): { headers: Record<string, string>; body: unknown } {
  const key = target.key.trim();
  const model = target.model.trim();
  const voice = target.voice.trim();
  switch (target.provider.kind) {
    case 'speech':
      return {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        body: { model, input: text, ...(voice ? { voice } : {}), response_format: target.provider.format },
      };
    case 'mimo':
      // MiMo reads the assistant message aloud; a user message would be a style hint, none is sent.
      return {
        headers: key ? { 'api-key': key, Authorization: `Bearer ${key}` } : {},
        body: { model, messages: [{ role: 'assistant', content: text }], audio: { format: 'wav', ...(voice ? { voice } : {}) } },
      };
    case 'gemini':
      return {
        headers: key ? { 'x-goog-api-key': key } : {},
        body: {
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
          },
        },
      };
  }
}

async function readSound(provider: TtsProvider, response: Response): Promise<Uint8Array> {
  const noAudio = () => new TtsException(t('сервис не вернул звук', 'the service returned no audio'));
  if (provider.kind === 'speech') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw noAudio();
    if ((response.headers.get('content-type') ?? '').includes('json') || bytes[0] === 0x7b) {
      Log.write(`tts server answered text: ${serverMessage(new TextDecoder().decode(bytes))}`);
      throw noAudio();
    }
    return bytes;
  }
  const document = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (provider.kind === 'mimo') {
    const choices = document?.choices as { message?: { audio?: { data?: unknown } } }[] | undefined;
    const data = choices?.[0]?.message?.audio?.data;
    if (typeof data !== 'string' || !data) throw noAudio();
    return fromBase64(data);
  }
  const candidates = document?.candidates as { content?: { parts?: { inlineData?: { data?: unknown; mimeType?: unknown } }[] } }[] | undefined;
  const inline = candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (typeof inline?.data !== 'string' || !inline.data) throw noAudio();
  const bytes = fromBase64(inline.data);
  if (isWav(bytes)) return bytes;
  const rate = /rate=(\d+)/.exec(typeof inline.mimeType === 'string' ? inline.mimeType : '');
  return pcmToWav(bytes, rate ? Number(rate[1]) : GEMINI_RATE);
}

function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

// ---- sound joining ---------------------------------------------------------------------------

function ascii(bytes: Uint8Array, at: number, length = 4): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

export function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0) === 'RIFF' && ascii(bytes, 8) === 'WAVE';
}

/** The mime type the bytes look like (the player needs it for the Blob). */
export function soundMime(bytes: Uint8Array): string {
  if (isWav(bytes)) return 'audio/wav';
  if (bytes.length >= 4 && ascii(bytes, 0) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 4 && ascii(bytes, 0) === 'fLaC') return 'audio/flac';
  return 'audio/mpeg';
}

/** A WAV header over 16-bit little-endian PCM. */
export function pcmToWav(pcm: Uint8Array, rate: number, channels = 1, bits = 16): Uint8Array {
  return wavFile(pcmFormat(rate, channels, bits), pcm);
}

function pcmFormat(rate: number, channels: number, bits: number): Uint8Array {
  const fmt = new Uint8Array(16);
  const v = new DataView(fmt.buffer);
  v.setUint16(0, 1, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, rate, true);
  v.setUint32(8, (rate * channels * bits) / 8, true);
  v.setUint16(12, (channels * bits) / 8, true);
  v.setUint16(14, bits, true);
  return fmt;
}

function wavFile(fmt: Uint8Array, data: Uint8Array): Uint8Array {
  const fmtSize = fmt.length + (fmt.length % 2);
  const out = new Uint8Array(12 + 8 + fmtSize + 8 + data.length);
  const v = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  v.setUint32(4, out.length - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); // WAVEfmt␠
  v.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  const at = 20 + fmtSize;
  out.set([0x64, 0x61, 0x74, 0x61], at); // data
  v.setUint32(at + 4, data.length, true);
  out.set(data, at + 8);
  return out;
}

/** The fmt and data chunks of a WAV; a data size past the end (a streamed WAV) means "to the end". */
export function wavParts(bytes: Uint8Array): { fmt: Uint8Array; data: Uint8Array } | null {
  if (!isWav(bytes)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Uint8Array | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at);
    const size = v.getUint32(at + 4, true);
    const start = at + 8;
    if (id === 'data') {
      if (!fmt) return null;
      return { fmt, data: bytes.subarray(start, Math.min(bytes.length, start + size)) };
    }
    if (id === 'fmt ') fmt = bytes.subarray(start, Math.min(bytes.length, start + size));
    at = start + size + (size % 2);
  }
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** One sound out of the pieces: WAV pieces of one format → one WAV, anything else → bytes in a row. */
export function joinSounds(sounds: Uint8Array[]): { audio: Uint8Array; mime: string } {
  if (sounds.length === 1) return { audio: sounds[0], mime: soundMime(sounds[0]) };
  const parts = sounds.map(wavParts);
  const first = parts[0];
  if (first && parts.every((p) => p && sameBytes(p.fmt, first.fmt))) {
    const total = parts.reduce((n, p) => n + (p?.data.length ?? 0), 0);
    const data = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      if (!p) continue;
      data.set(p.data, at);
      at += p.data.length;
    }
    return { audio: wavFile(first.fmt, data), mime: 'audio/wav' };
  }
  const total = sounds.reduce((n, s) => n + s.length, 0);
  const audio = new Uint8Array(total);
  let at = 0;
  for (const s of sounds) {
    audio.set(s, at);
    at += s.length;
  }
  return { audio, mime: soundMime(sounds[0]) };
}
