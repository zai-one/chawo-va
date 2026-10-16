import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { pinnedFetch, pinnedLookup } from '../src/crm/crmFlow';
import { loadSent, recordSent, withFileLock } from '../src/crm/crmStore';
import { buildRequest, sendRequest } from '@chawo/core/crm';

const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}', redirect: 'manual' as const, signal: new AbortController().signal };

describe('DNS pinning', () => {
  it('lookup refuses a name whose answer contains a private address (all or single form)', async () => {
    const lk = pinnedLookup({}, async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => (lk as any)('evil.example', { all: true }, (e: any) => r(e)));
    expect(err?.code).toBe('BLOCKED_ADDRESS');
    const ok = pinnedLookup({}, async () => [{ address: '93.184.216.34', family: 4 }]);
    const got = await new Promise<string>((r) => (ok as any)('ok.example', {}, (_e: any, a: string) => r(a)));
    expect(got).toBe('93.184.216.34');
  });
  it('the request connects to the checked address, not to a second (rebound) DNS answer', async () => {
    const srv = createServer((req, res) => { res.end(JSON.stringify({ host: req.headers.host })); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    let calls = 0;
    // First answer is loopback (allowed in test mode); any later answer would be 10.x.
    const f = pinnedFetch({ allowLocal: true }, async () => (calls++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]));
    const r = await f(`http://rebind.test:${port}/x`, init);
    expect(r.status).toBe(200);
    expect(JSON.parse(await r.text()).host).toBe(`rebind.test:${port}`);
    expect(calls).toBe(1);
    // Without allowLocal the same loopback answer is refused and never connected.
    await expect(pinnedFetch({}, async () => [{ address: '127.0.0.1', family: 4 }])(`https://rebind.test:${port}/x`, init)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(pinnedFetch({})(`http://example.com/`, init)).rejects.toThrow(/https/);
    srv.close();
  });
  it('a blocked address is a clear, non-retried, certain failure', async () => {
    let n = 0;
    const cfg = { amocrm: { base: '', entity: 'leads', token: '' }, bitrix: { webhook: '', entity: 'deal', mode: 'comment', responsibleId: '' }, hubspot: { token: '', object: 'contacts' }, webhook: { url: 'https://hooks.example.com/in', secret: '' } } as any;
    const req = buildRequest('webhook', cfg, { file: 'a.brief.txt', summary: ['x'], tasks: [], score: null } as any, '');
    const r = await sendRequest('webhook', req, { fetch: async () => { n++; throw Object.assign(new Error('the address resolves to a private network (10.0.0.1); refused'), { code: 'BLOCKED_ADDRESS' }); }, sleep: async () => undefined });
    expect([n, r.ok, r.uncertain]).toEqual([1, false, false]);
    expect(r.message).toMatch(/private/);
  });
  it('a redirect is returned as-is, never followed', async () => {
    let hits = 0;
    const srv = createServer((req, res) => { hits++; res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const r = await pinnedFetch({ allowLocal: true }, async () => [{ address: '127.0.0.1', family: 4 }])(`http://x.test:${port}/`, init);
    expect([r.status, hits]).toEqual([302, 1]);
    srv.close();
  });
});

describe('journal under concurrent writers', () => {
  it('a fresh foreign lock makes the writer wait; a stale one is taken over; own lock is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-lock-'));
    const p = join(dir, 'crm-sent.json');
    writeFileSync(p + '.lock', '');
    let t0 = Date.now();
    withFileLock(p, () => undefined, 300);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(existsSync(p + '.lock')).toBe(true); // not ours: left alone
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(p + '.lock', old, old);
    t0 = Date.now();
    recordSent(p, { key: 'k1', target: 'webhook', id: '', ts: 1, createdId: null });
    expect(Date.now() - t0).toBeLessThan(250);
    expect(loadSent(p).map((e) => e.key)).toEqual(['k1']);
    expect(existsSync(p + '.lock')).toBe(false);
    expect(withFileLock(p, () => existsSync(p + '.lock'))).toBe(true);
  }, 10_000);
  it('two processes appending at once lose nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-race-'));
    const p = join(dir, 'crm-sent.json');
    const store = join(dir, 'store.cjs');
    buildSync({ entryPoints: [join(__dirname, '../src/crm/crmStore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: store, logLevel: 'silent' });
    const script = (tag: string) => `const s=require(${JSON.stringify(store)});for(let i=0;i<40;i++)s.recordSent(${JSON.stringify(p)},{key:'${tag}'+i,target:'webhook',id:'',ts:i,createdId:null});`;
    const run = (tag: string) => new Promise<number>((r) => spawn(process.execPath, ['-e', script(tag)], { stdio: 'inherit' }).on('exit', (c) => r(c ?? 1)));
    expect(await Promise.all([run('a'), run('b'), run('c')])).toEqual([0, 0, 0]);
    const keys = JSON.parse(readFileSync(p, 'utf8')).map((e: { key: string }) => e.key);
    expect(keys.length).toBe(120);
    expect(new Set(keys).size).toBe(120);
  }, 60_000);
});
