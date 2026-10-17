import { describe, expect, it } from 'vitest';
import { isWav, joinSounds, pcmToWav, synthesize, TtsException, ttsUrl, wavParts, type TtsTarget } from '../src/tts/ttsClient';
import { Custom, Gemini, OpenAI, Xiaomi } from '../src/tts/ttsProviders';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(answer: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const pcm = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('TTS client', () => {
  it('builds the request address and ignores an endpoint pasted into the base', () => {
    expect(ttsUrl({ provider: OpenAI, baseUrl: 'https://api.openai.com/v1/', model: 'tts-1' })).toBe('https://api.openai.com/v1/audio/speech');
    expect(ttsUrl({ provider: Custom, baseUrl: 'http://127.0.0.1:5050/v1/audio/speech', model: 'tts-1' })).toBe(
      'http://127.0.0.1:5050/v1/audio/speech',
    );
    expect(ttsUrl({ provider: Xiaomi, baseUrl: Xiaomi.baseUrl, model: 'mimo-v2.5-tts' })).toBe(
      'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
    );
    expect(ttsUrl({ provider: Gemini, baseUrl: Gemini.baseUrl, model: 'gemini-2.5-flash-preview-tts' })).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
    );
  });

  it('OpenAI-compatible: sends model, text, voice and format; returns the bytes', async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
    const f = fakeFetch(() => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }));
    const target: TtsTarget = { provider: OpenAI, baseUrl: OpenAI.baseUrl, key: 'sk-1', model: 'tts-1', voice: 'nova' };
    const speech = await synthesize(target, ' Привет ', { fetch: f.fetch });
    expect(f.calls[0].headers.Authorization).toBe('Bearer sk-1');
    expect(f.calls[0].body).toEqual({ model: 'tts-1', input: 'Привет', voice: 'nova', response_format: 'mp3' });
    expect(speech).toEqual({ audio: mp3, mime: 'audio/mpeg', pieces: 1 });
  });

  it('MiMo: reads the assistant message with the voice; decodes base64 WAV', async () => {
    const wav = pcmToWav(pcm(8, 7), 24000);
    const f = fakeFetch(() => Response.json({ choices: [{ message: { audio: { data: b64(wav) } } }] }));
    const target: TtsTarget = { provider: Xiaomi, baseUrl: Xiaomi.baseUrl, key: 'tp-1', model: 'mimo-v2.5-tts', voice: 'Mia' };
    const speech = await synthesize(target, 'Hello', { fetch: f.fetch });
    expect(f.calls[0].headers['api-key']).toBe('tp-1');
    expect(f.calls[0].body).toEqual({ model: 'mimo-v2.5-tts', messages: [{ role: 'assistant', content: 'Hello' }], audio: { format: 'wav', voice: 'Mia' } });
    expect(speech.mime).toBe('audio/wav');
    expect(speech.audio).toEqual(wav);
  });

  it('Gemini: asks for AUDIO with the voice and wraps the PCM into WAV at its rate', async () => {
    const f = fakeFetch(() =>
      Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: b64(pcm(10, 3)) } }] } }] }),
    );
    const target: TtsTarget = { provider: Gemini, baseUrl: Gemini.baseUrl, key: 'AIza1', model: 'gemini-2.5-flash-preview-tts', voice: 'Kore' };
    const speech = await synthesize(target, 'Привет', { fetch: f.fetch });
    expect(f.calls[0].headers['x-goog-api-key']).toBe('AIza1');
    expect(f.calls[0].body).toEqual({
      contents: [{ parts: [{ text: 'Привет' }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    });
    const parts = wavParts(speech.audio);
    expect(parts?.data).toEqual(pcm(10, 3));
    expect(new DataView(parts!.fmt.buffer, parts!.fmt.byteOffset).getUint32(4, true)).toBe(24000);
  });

  it('a long text goes in pieces and comes back as one WAV', async () => {
    let n = 0;
    const f = fakeFetch(() => Response.json({ choices: [{ message: { audio: { data: b64(pcmToWav(pcm(4, ++n), 24000)) } } }] }));
    const target: TtsTarget = { provider: Xiaomi, baseUrl: Xiaomi.baseUrl, key: 'tp-1', model: 'mimo-v2.5-tts', voice: '' };
    const progress: string[] = [];
    const text = 'Sentence for the test. '.repeat(150);
    const speech = await synthesize(target, text, { fetch: f.fetch, onProgress: (d, total) => progress.push(`${d}/${total}`) });
    expect(speech.pieces).toBeGreaterThan(1);
    expect(f.calls).toHaveLength(speech.pieces);
    expect(progress.at(-1)).toBe(`${speech.pieces}/${speech.pieces}`);
    expect(wavParts(speech.audio)?.data).toHaveLength(4 * speech.pieces);
    expect((f.calls[0].body.audio as Record<string, unknown>).voice).toBeUndefined();
  });

  it('Russian and English parts are read by separate requests and joined', async () => {
    const f = fakeFetch(() => new Response(new Uint8Array([0xff, 0xfb, 1])));
    const target: TtsTarget = { provider: OpenAI, baseUrl: OpenAI.baseUrl, key: 'sk-1', model: 'tts-1', voice: '' };
    const speech = await synthesize(target, 'Hello team, the build is green now. Привет, всё работает.', { fetch: f.fetch });
    expect(f.calls.map((c) => c.body.input)).toEqual(['Hello team, the build is green now.', 'Привет, всё работает.']);
    expect(speech).toEqual({ audio: new Uint8Array([0xff, 0xfb, 1, 0xff, 0xfb, 1]), mime: 'audio/mpeg', pieces: 2 });
  });

  it('joins MP3 pieces byte after byte and merges streamed WAVs', () => {
    expect(joinSounds([new Uint8Array([0xff, 0xfb, 1]), new Uint8Array([0xff, 0xfb, 2])])).toEqual({
      audio: new Uint8Array([0xff, 0xfb, 1, 0xff, 0xfb, 2]),
      mime: 'audio/mpeg',
    });
    const streamed = pcmToWav(pcm(6, 9), 22050);
    new DataView(streamed.buffer).setUint32(40, 0xffffffff, true); // data size unknown while streaming
    const joined = joinSounds([streamed, pcmToWav(pcm(2, 1), 22050)]);
    expect(isWav(joined.audio)).toBe(true);
    expect(wavParts(joined.audio)?.data).toEqual(new Uint8Array([9, 9, 9, 9, 9, 9, 1, 1]));
  });

  it('says what went wrong in words: key, missing fields, no audio, no connection', async () => {
    const target: TtsTarget = { provider: OpenAI, baseUrl: OpenAI.baseUrl, key: 'sk-1', model: 'tts-1', voice: 'alloy' };
    const rejected = fakeFetch(() => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    await expect(synthesize(target, 'x', { fetch: rejected.fetch })).rejects.toThrow(/ключ|key/);
    const asText = fakeFetch(() => Response.json({ ok: true }));
    await expect(synthesize(target, 'x', { fetch: asText.fetch })).rejects.toThrow(TtsException);
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(synthesize(target, 'x', { fetch: offline })).rejects.toThrow(TtsException);
    await expect(synthesize({ ...target, key: '' }, 'x', { fetch: rejected.fetch })).rejects.toThrow(TtsException);
    await expect(synthesize(target, '   ', { fetch: rejected.fetch })).rejects.toThrow(TtsException);
    expect(rejected.calls).toHaveLength(1);
  });

  it('a local server without a key is fine; a stop ends it', async () => {
    const f = fakeFetch(() => new Response(pcmToWav(pcm(2, 0), 16000)));
    const target: TtsTarget = { provider: Custom, baseUrl: 'http://127.0.0.1:5050/v1', key: '', model: 'tts-1', voice: 'ru-RU-SvetlanaNeural' };
    expect((await synthesize(target, 'тест', { fetch: f.fetch })).mime).toBe('audio/wav');
    expect(f.calls[0].headers.Authorization).toBeUndefined();
    const stop = new AbortController();
    stop.abort();
    await expect(synthesize(target, 'тест', { fetch: f.fetch, signal: stop.signal })).rejects.toThrow(TtsException);
  });
});
