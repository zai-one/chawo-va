import { describe, expect, it } from 'vitest';
import { authorize, parseBearer, resolveBind, resolveToken } from '../src/main/network/serveAuth';

describe('serveAuth resolveBind', () => {
  it('without token defaults to 127.0.0.1 and refuses 0.0.0.0', () => {
    expect(resolveBind(undefined, null)).toEqual({ ok: true, host: '127.0.0.1', listenOnLan: false });
    expect(resolveBind('127.0.0.1', '')).toMatchObject({ ok: true, host: '127.0.0.1' });
    expect(resolveBind('0.0.0.0', null).ok).toBe(false);
    expect((resolveBind('0.0.0.0', null) as { error: string }).error).toMatch(/token/);
    expect(resolveBind('192.168.1.5', undefined).ok).toBe(false);
  });

  it('with token may bind 0.0.0.0 / custom host; default becomes 0.0.0.0', () => {
    expect(resolveBind(undefined, 'secret')).toEqual({ ok: true, host: '0.0.0.0', listenOnLan: true });
    expect(resolveBind('0.0.0.0', 'secret')).toEqual({ ok: true, host: '0.0.0.0', listenOnLan: true });
    expect(resolveBind('127.0.0.1', 'secret')).toMatchObject({ ok: true, listenOnLan: false });
  });
});

describe('serveAuth authorize', () => {
  it('no token: loopback ok, non-loopback 403', () => {
    expect(authorize(undefined, null, '127.0.0.1')).toEqual({ ok: true });
    expect(authorize(undefined, '', '::1')).toEqual({ ok: true });
    expect(authorize(undefined, null, '10.0.0.2')).toEqual({ ok: false, status: 403, error: 'localhost_only' });
  });

  it('with token: loopback may skip bearer; remote needs exact Bearer', () => {
    expect(authorize(undefined, 'sekrit', '127.0.0.1')).toEqual({ ok: true });
    expect(authorize(undefined, 'sekrit', '10.0.0.2')).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(authorize('Bearer wrong', 'sekrit', '10.0.0.2')).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(authorize('Bearer sekrit', 'sekrit', '10.0.0.2')).toEqual({ ok: true });
    expect(authorize('bearer sekrit', 'sekrit', '::ffff:10.0.0.2')).toEqual({ ok: true });
  });

  it('parseBearer / resolveToken', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('Basic x')).toBeNull();
    expect(resolveToken('cli', {})).toBe('cli');
    expect(resolveToken(null, { CHAWO_SERVE_TOKEN: 'env' })).toBe('env');
    expect(resolveToken('  ', { CHAWO_SERVE_TOKEN: '' })).toBeNull();
  });
});
