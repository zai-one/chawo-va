import { beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import {
  RELEASES_API,
  RELEASES_PAGE,
  checkLatest,
  isNewer,
  parseVersion,
  type FetchLike,
} from '../src/system/updater';

beforeAll(() => applyLanguage('Russian'));

function fakeFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLike {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    return reply(String(input), init);
  });
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

describe('parseVersion / isNewer', () => {
  it('parses v-prefixed semver', () => {
    expect(parseVersion('v2.0.0')).toEqual([2, 0, 0]);
    expect(parseVersion('1.19.0')).toEqual([1, 19, 0]);
    expect(parseVersion('  V3.1  ')).toEqual([3, 1, 0]);
    expect(parseVersion('not-a-version')).toBeNull();
  });
  it('compares like System.Version', () => {
    expect(isNewer('2.0.0', '1.19.0')).toBe(true);
    expect(isNewer('1.19.0', '2.0.0')).toBe(false);
    expect(isNewer('2.0.0', '2.0.0')).toBe(false);
    expect(isNewer('2.0.1', '2.0.0')).toBe(true);
    expect(isNewer('v2.1.0', '2.0.9')).toBe(true);
  });
});

describe('checkLatest', () => {
  it('returns current on 404 (no release yet)', async () => {
    const r = await checkLatest({
      localVersion: '2.0.0',
      fetch: fakeFetch(() => new Response('', { status: 404 })),
    });
    expect(r).toEqual({ kind: 'current' });
  });

  it('skips drafts and prereleases', async () => {
    const draft = await checkLatest({
      localVersion: '1.0.0',
      fetch: fakeFetch(() => json({ draft: true, tag_name: 'v9.0.0', html_url: 'https://github.com/zai-one/chawo-va/releases/tag/v9.0.0' })),
    });
    expect(draft).toEqual({ kind: 'current' });
    const pre = await checkLatest({
      localVersion: '1.0.0',
      fetch: fakeFetch(() => json({ prerelease: true, tag_name: 'v9.0.0', html_url: 'https://github.com/zai-one/chawo-va/releases/tag/v9.0.0' })),
    });
    expect(pre).toEqual({ kind: 'current' });
  });

  it('returns null-equivalent when remote is not newer', async () => {
    const r = await checkLatest({
      localVersion: '2.0.0',
      fetch: fakeFetch(() => json({
        tag_name: 'v2.0.0',
        html_url: 'https://github.com/zai-one/chawo-va/releases/tag/v2.0.0',
        body: 'notes',
      })),
    });
    expect(r).toEqual({ kind: 'current' });
  });

  it('returns the newer release html_url (this repo only)', async () => {
    const calls: { url: string; ua?: string; accept?: string }[] = [];
    const r = await checkLatest({
      localVersion: '1.19.0',
      userAgent: 'ChawoVoiceAssistant/1.19.0',
      fetch: fakeFetch((url, init) => {
        const h = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url, ua: h['User-Agent'], accept: h.Accept });
        return json({
          tag_name: 'v2.0.0',
          html_url: 'https://github.com/zai-one/chawo-va/releases/tag/v2.0.0',
          body: 'Electron port',
          draft: false,
          prerelease: false,
        });
      }),
    });
    expect(calls[0].url).toBe(RELEASES_API);
    expect(calls[0].ua).toBe('ChawoVoiceAssistant/1.19.0');
    expect(calls[0].accept).toBe('application/vnd.github+json');
    expect(r.kind).toBe('newer');
    if (r.kind === 'newer') {
      expect(r.info.version).toBe('2.0.0');
      expect(r.info.url).toBe('https://github.com/zai-one/chawo-va/releases/tag/v2.0.0');
      expect(r.info.notes).toBe('Electron port');
    }
  });

  it('rewrites a foreign html_url to this repo\'s tag page', async () => {
    const r = await checkLatest({
      localVersion: '1.0.0',
      fetch: fakeFetch(() => json({
        tag_name: 'v2.0.0',
        html_url: 'https://evil.example/releases/tag/v2.0.0',
      })),
    });
    expect(r.kind).toBe('newer');
    if (r.kind === 'newer') {
      expect(r.info.url).toBe(`${RELEASES_PAGE}/tag/v2.0.0`);
    }
  });

  it('surfaces a non-OK status as an error', async () => {
    const r = await checkLatest({
      localVersion: '2.0.0',
      fetch: fakeFetch(() => new Response('nope', { status: 503 })),
    });
    expect(r).toEqual({ kind: 'error', message: 'GitHub answered 503' });
  });

  it('rejects a non-numeric local version', async () => {
    const r = await checkLatest({
      localVersion: 'dev',
      fetch: fakeFetch(() => json({})),
    });
    expect(r.kind).toBe('error');
  });
});
