import { afterEach, describe, expect, it } from 'vitest';
import {
  BrainException,
  DefaultPromptEn,
  DefaultPromptRu,
  LegacyPromptStart,
  answerAfterThink,
  cleanAsync,
  describeFailure,
  hostOf,
  isDefaultPrompt,
  isInsecureRemote,
  resetReasoningEffortFlag,
  tryGetCompletionsUrl,
} from '../src/main/brain/speechCleanup';

afterEach(() => resetReasoningEffortFlag());

describe('SpeechCleanup helpers', () => {
  it('TryGetCompletionsUrl', () => {
    expect(tryGetCompletionsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(tryGetCompletionsUrl('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(tryGetCompletionsUrl('https://x.test/v1?q=1')).toBeNull();
    expect(tryGetCompletionsUrl('ftp://x/v1')).toBeNull();
    expect(tryGetCompletionsUrl('not a url')).toBeNull();
  });

  it('IsInsecureRemote: http beyond LAN', () => {
    expect(isInsecureRemote('https://api.openai.com/v1')).toBe(false);
    expect(isInsecureRemote('http://127.0.0.1:8080/v1')).toBe(false);
    expect(isInsecureRemote('http://192.168.1.5/v1')).toBe(false);
    expect(isInsecureRemote('http://10.0.0.2/v1')).toBe(false);
    expect(isInsecureRemote('http://api.example.com/v1')).toBe(true);
    expect(isInsecureRemote('http://8.8.8.8/v1')).toBe(true);
  });

  it('HostOf and IsDefaultPrompt', () => {
    expect(hostOf('https://api.openai.com/v1')).toBe('api.openai.com');
    expect(hostOf('http://127.0.0.1:12345/v1')).toBe('127.0.0.1:12345');
    expect(isDefaultPrompt(DefaultPromptRu)).toBe(true);
    expect(isDefaultPrompt(DefaultPromptEn)).toBe(true);
    expect(isDefaultPrompt(LegacyPromptStart + ' rest')).toBe(true);
    expect(isDefaultPrompt('my own rules')).toBe(false);
  });

  it('DescribeFailure maps status and body keywords', () => {
    expect(describeFailure(401, '{}')).toMatch(/ключ|key/i);
    expect(describeFailure(429, '{}')).toMatch(/много|too many/i);
    expect(describeFailure(402, '{}')).toMatch(/денег|money|billing/i);
    expect(describeFailure(500, '{}')).toMatch(/сбой|failing/i);
    expect(describeFailure(404, '{"error":{"message":"model not found"}}')).toMatch(/модель|model/i);
  });

  it('AnswerAfterThink', () => {
    expect(answerAfterThink('hello')).toBe('hello');
    expect(answerAfterThink('<think>secret</think>answer')).toBe('answer');
    expect(answerAfterThink('<think>unclosed')).toBeNull();
    expect(answerAfterThink('')).toBe('');
  });
});

describe('SpeechCleanup.CleanAsync', () => {
  it('returns trimmed content via mock fetch', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '  cleaned  ' } }] }), { status: 200 });
    const out = await cleanAsync('raw', 'http://127.0.0.1:9/v1', 'k', 'm', 'p', new AbortController().signal, null, 5000, fetchImpl);
    expect(out).toBe('cleaned');
  });

  it('retries without reasoning_effort when the server rejects it', async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body ?? ''));
      n++;
      if (n === 1) {
        return new Response(JSON.stringify({ error: { message: 'unknown parameter reasoning_effort' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    };
    const out = await cleanAsync('t', 'http://127.0.0.1:9/v1', '', 'm', 'p', new AbortController().signal, null, 5000, fetchImpl);
    expect(out).toBe('ok');
    expect(bodies[0]).toContain('reasoning_effort');
    expect(bodies[1]).not.toContain('reasoning_effort');
  });

  it('disables Xiaomi thinking and sends api-key', async () => {
    let body = '';
    let headers: Headers | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = String(init?.body ?? '');
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 });
    };
    await cleanAsync(
      't',
      'https://token-plan-sgp.xiaomimimo.com/v1',
      'tp-key',
      'mimo',
      'p',
      new AbortController().signal,
      null,
      5000,
      fetchImpl,
    );
    expect(body).toContain('"thinking"');
    expect(body).toContain('disabled');
    expect(body).not.toContain('reasoning_effort');
    expect(headers?.get('api-key')).toBe('tp-key');
  });

  it('empty content is allowed; null content throws', async () => {
    const empty: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });
    expect(await cleanAsync('t', 'http://127.0.0.1:9/v1', '', 'm', 'p', new AbortController().signal, null, 5000, empty)).toBe('');

    const missing: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 });
    await expect(
      cleanAsync('t', 'http://127.0.0.1:9/v1', '', 'm', 'p', new AbortController().signal, null, 5000, missing),
    ).rejects.toThrow(/no text/i);
  });

  it('maps HTTP errors to BrainException', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{"error":{"message":"nope"}}', { status: 401 });
    await expect(
      cleanAsync('t', 'http://127.0.0.1:9/v1', 'bad', 'm', 'p', new AbortController().signal, null, 5000, fetchImpl),
    ).rejects.toBeInstanceOf(BrainException);
  });
});
