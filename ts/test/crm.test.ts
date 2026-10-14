import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import {
  buildRequest, checkUrl, cleanCrmConfig, emptyCrmConfig, HUBSPOT_ASSOC, makePayload, maskedConfig, parseBrief, previewText, redact, scorePathFor, sendRequest,
  type CrmConfig, type Fetch,
} from '../src/core/crm';
import { loadCrmConfig, loadSent, recordSent, saveCrmConfig } from '../src/main/crm/crmStore';
import { pinnedFetch } from '../src/main/crm/crmFlow';
import { CrmController } from '../src/main/crm/crmPage';
import { applyLanguage } from '../src/core/strings';

const BRIEF = 'Кратко\n- Клиент хочет 20 лицензий\n- Бюджет до 500 тыс.\n\nЗадачи\n- Анна: КП до пятницы\n- (нет)\n';
const TOKEN = 'amo-SECRET-token-123456';
const HS = 'pat-na1-SECRET-hub-0000';
const BX = 'https://acme.bitrix24.ru/rest/7/s3cr3tc0de/';

function cfg(): CrmConfig {
  const c = emptyCrmConfig();
  c.amocrm = { base: 'https://acme.amocrm.ru', entity: 'leads', token: TOKEN };
  c.bitrix = { webhook: BX, entity: 'deal', mode: 'comment', responsibleId: '' };
  c.hubspot = { token: HS, object: 'deals' };
  c.webhook = { url: 'https://hooks.example.com/chawo', secret: 'whsec-SECRET' };
  return c;
}
const payload = makePayload(BRIEF, '/home/u/Звонки/acme.brief.txt', null);

beforeAll(() => applyLanguage('Russian'));

describe('brief parsing', () => {
  it('summary and tasks; «(нет)» dropped; only the file name travels', () => {
    expect(parseBrief(BRIEF)).toEqual({ summary: ['Клиент хочет 20 лицензий', 'Бюджет до 500 тыс.'], tasks: ['Анна: КП до пятницы'] });
    expect(parseBrief('## Summary\n* a\n**Tasks**\n1. b')).toEqual({ summary: ['a'], tasks: ['b'] });
    expect(payload.source).toBe('acme.brief.txt');
    expect(scorePathFor('/x/a.brief.txt')).toBe('/x/a.score.txt');
    expect(scorePathFor('/x/a.txt')).toBeNull();
  });
});

describe('URL checks (SSRF)', () => {
  it('https only, no private / loopback / metadata / credentials; CRM-specific shapes', () => {
    expect(checkUrl('webhook', 'https://hooks.example.com/x')).toBe('');
    expect(checkUrl('webhook', 'http://hooks.example.com/x')).toMatch(/https/);
    for (const u of ['https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.5/', 'https://192.168.1.1/', 'https://172.20.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://2130706433/', 'https://0x7f000001/', 'https://printer.local/', 'https://[fd00::1]/', 'https://100.64.0.1/'])
      expect(checkUrl('webhook', u), u).toMatch(/private|local/);
    expect(checkUrl('webhook', 'https://user:pw@example.com/')).toMatch(/password/);
    expect(checkUrl('webhook', 'file:///etc/passwd')).toMatch(/https/);
    expect(checkUrl('amocrm', 'https://acme.amocrm.ru')).toBe('');
    expect(checkUrl('amocrm', 'https://acme.kommo.com')).toBe('');
    expect(checkUrl('amocrm', 'https://evil.example.com')).toMatch(/amocrm/);
    expect(checkUrl('amocrm', 'https://acme.amocrm.ru.evil.com')).toMatch(/amocrm/);
    expect(checkUrl('bitrix', BX)).toBe('');
    expect(checkUrl('bitrix', 'https://acme.bitrix24.ru/')).toMatch(/rest/);
    // Only with the test switch, and only loopback.
    expect(checkUrl('webhook', 'http://127.0.0.1:9/x', { allowLocal: true })).toBe('');
    expect(checkUrl('webhook', 'http://10.0.0.1/x', { allowLocal: true })).toMatch(/https/);
  });
});

describe('requests', () => {
  it('amoCRM: note on the lead with a Bearer token', () => {
    const r = buildRequest('amocrm', cfg(), payload, '12345');
    expect(r.url).toBe('https://acme.amocrm.ru/api/v4/leads/12345/notes');
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const b = JSON.parse(r.body);
    expect(b[0].note_type).toBe('common');
    expect(b[0].params.text).toContain('Анна: КП до пятницы');
    expect(() => buildRequest('amocrm', cfg(), payload, '12a')).toThrow(/number/);
    expect(() => buildRequest('amocrm', cfg(), payload, '../../x')).toThrow();
  });
  it('Bitrix24: timeline comment or a task bound to the deal', () => {
    let r = buildRequest('bitrix', cfg(), payload, '77');
    expect(r.url).toBe(BX + 'crm.timeline.comment.add.json');
    expect(JSON.parse(r.body).fields).toMatchObject({ ENTITY_ID: 77, ENTITY_TYPE: 'deal' });
    const c = cfg();
    c.bitrix.mode = 'task';
    expect(() => buildRequest('bitrix', c, payload, '77')).toThrow(/responsible/);
    c.bitrix.responsibleId = '5';
    r = buildRequest('bitrix', c, payload, '77');
    expect(r.url).toBe(BX + 'tasks.task.add.json');
    expect(JSON.parse(r.body).fields).toMatchObject({ TITLE: 'Chawo: Анна: КП до пятницы', RESPONSIBLE_ID: 5, UF_CRM_TASK: ['D_77'] });
  });
  it('HubSpot: note associated with the deal, HTML-escaped body', () => {
    const p = makePayload('Кратко\n- <b>x</b> & y', 'a.brief.txt', null);
    const r = buildRequest('hubspot', cfg(), p, '999', { now: Date.UTC(2026, 9, 14) });
    expect(r.url).toBe('https://api.hubapi.com/crm/v3/objects/notes');
    const b = JSON.parse(r.body);
    expect(b.properties.hs_timestamp).toBe('2026-10-14T00:00:00.000Z');
    expect(b.properties.hs_note_body).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(b.associations[0]).toEqual({ to: { id: '999' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: HUBSPOT_ASSOC.deals }] });
  });
  it('webhook: JSON, idempotency key, HMAC signature over the exact body', () => {
    const r = buildRequest('webhook', cfg(), makePayload(BRIEF, 'a.brief.txt', 'Оценка: 7/10'), '', { version: '2.0.0' });
    const b = JSON.parse(r.body);
    expect(b).toMatchObject({ source: 'chawo-va', kind: 'brief', id: null, file: 'a.brief.txt', tasks: ['Анна: КП до пятницы'], score: 'Оценка: 7/10' });
    expect(r.headers['idempotency-key']).toBe(b.idempotencyKey);
    expect(r.headers['x-chawo-signature']).toBe('sha256=' + createHmac('sha256', 'whsec-SECRET').update(r.body).digest('hex'));
    // Same brief → same key; another record → another key.
    expect(buildRequest('webhook', cfg(), makePayload(BRIEF, 'a.brief.txt', 'Оценка: 7/10'), '').headers['idempotency-key']).toBe(b.idempotencyKey);
    expect(buildRequest('webhook', cfg(), makePayload(BRIEF, 'a.brief.txt', 'Оценка: 7/10'), 'x1').headers['idempotency-key']).not.toBe(b.idempotencyKey);
  });
  it('not set up / bad stored address → clear errors', () => {
    expect(() => buildRequest('amocrm', emptyCrmConfig(), payload, '1')).toThrow(/not set up/);
    const c = cfg();
    c.webhook.url = 'https://169.254.169.254/';
    expect(() => buildRequest('webhook', c, payload, '')).toThrow(/private/);
  });
});

describe('no secret ever shown', () => {
  it('preview masks tokens, the Bitrix webhook path and the signature', () => {
    for (const target of ['amocrm', 'bitrix', 'hubspot', 'webhook'] as const) {
      const pv = previewText(buildRequest(target, cfg(), payload, target === 'webhook' ? '' : '42'));
      for (const s of [TOKEN, HS, 's3cr3tc0de', 'whsec-SECRET']) expect(pv, target).not.toContain(s);
      expect(pv).toContain('Анна: КП до пятницы');
    }
    expect(previewText(buildRequest('bitrix', cfg(), payload, '42'))).toContain('https://acme.bitrix24.ru•••/crm.timeline.comment.add.json');
    expect(redact('Authorization: Bearer abc.def', [])).toBe('Authorization: Bearer •••');
    const m = JSON.stringify(maskedConfig(cfg()));
    for (const s of [TOKEN, HS, 's3cr3tc0de', 'whsec-SECRET']) expect(m).not.toContain(s);
  });
});

describe('sendRequest', () => {
  const req = () => buildRequest('amocrm', cfg(), payload, '1');
  const res = (status: number, body = '{}', headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body });
  const noSleep = async () => undefined;

  it('retries 429/503 (Retry-After), not 400; refuses redirects; masks secrets in errors', async () => {
    let n = 0;
    let f: Fetch = async () => (++n < 3 ? res(n === 1 ? 429 : 503, '', { 'retry-after': '1' }) : res(200, '{"_embedded":{"notes":[{"id":55}]}}'));
    let r = await sendRequest('amocrm', req(), { fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ ok: true, createdId: '55', attempts: 3 });
    n = 0;
    f = async () => (n++, res(400, `{"detail":"bad token ${TOKEN}"}`));
    r = await sendRequest('amocrm', req(), { fetch: f, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(n).toBe(1);
    expect(r.message).not.toContain(TOKEN);
    let seen: string | undefined;
    f = async (_u, init) => ((seen = init.redirect), res(302, '', { location: 'https://evil.example.com' }));
    r = await sendRequest('amocrm', req(), { fetch: f, sleep: noSleep });
    expect(seen).toBe('manual');
    expect(r.message).toMatch(/redirect/);
    r = await sendRequest('amocrm', req(), { fetch: async () => res(401), sleep: noSleep });
    expect(r.message).toMatch(/access denied/);
  });
  it('connection refused is retried; a timeout is not (uncertain)', async () => {
    let n = 0;
    const refused: Fetch = async () => { n++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    let r = await sendRequest('amocrm', req(), { fetch: refused, sleep: noSleep, retries: 2 });
    expect(n).toBe(3);
    expect(r).toMatchObject({ ok: false, uncertain: false });
    n = 0;
    const hang: Fetch = (_u, init) => { n++; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); };
    r = await sendRequest('amocrm', req(), { fetch: hang, sleep: noSleep, timeoutMs: 30 });
    expect(n).toBe(1);
    expect(r).toMatchObject({ ok: false, uncertain: true });
    expect(r.message).toMatch(/may already be there/);
  });
  it('Bitrix24 200 with {"error"} is a failure', async () => {
    const r = await sendRequest('bitrix', buildRequest('bitrix', cfg(), payload, '1'), { fetch: async () => res(200, '{"error":"NOT_FOUND","error_description":"deal"}'), sleep: noSleep });
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain('NOT_FOUND');
  });
});

describe('a real local HTTP mock (nodeFetch)', () => {
  let server: http.Server;
  let base = '';
  const got: { url: string; auth: string; body: string; key: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((q, s) => {
      let body = '';
      q.on('data', (c) => (body += c));
      q.on('end', () => {
        got.push({ url: q.url ?? '', auth: String(q.headers.authorization ?? ''), body, key: String(q.headers['idempotency-key'] ?? '') });
        if (q.url === '/redirect') { s.writeHead(307, { location: '/stolen' }).end(); return; }
        s.writeHead(200, { 'content-type': 'application/json' }).end(q.url?.includes('/notes') ? '{"_embedded":{"notes":[{"id":901}]}}' : '{"id":"w1"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('amoCRM note and webhook arrive; a redirect is not followed', async () => {
    const c = cfg();
    c.amocrm.base = base;
    c.webhook.url = base + '/hook';
    const rules = { allowLocal: true };
    let r = await sendRequest('amocrm', buildRequest('amocrm', c, payload, '7', { rules }), { fetch: pinnedFetch(rules) });
    expect(r).toMatchObject({ ok: true, createdId: '901' });
    expect(got.at(-1)).toMatchObject({ url: '/api/v4/leads/7/notes', auth: `Bearer ${TOKEN}` });
    r = await sendRequest('webhook', buildRequest('webhook', c, payload, '', { rules }), { fetch: pinnedFetch(rules) });
    expect(r.ok).toBe(true);
    expect(JSON.parse(got.at(-1)!.body).tasks).toEqual(['Анна: КП до пятницы']);
    c.webhook.url = base + '/redirect';
    r = await sendRequest('webhook', buildRequest('webhook', c, payload, '', { rules }), { fetch: pinnedFetch(rules) });
    expect(r.ok).toBe(false);
    expect(got.some((g) => g.url === '/stolen')).toBe(false);
  });
});

describe('crm.json / crm-sent.json', () => {
  it('owner-only file, junk tolerated, a corrupt file kept as .bad', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-crm-'));
    try {
      const p = join(dir, 'crm.json');
      saveCrmConfig(p, cfg());
      if (process.platform !== 'win32') expect(statSync(p).mode & 0o077).toBe(0);
      expect(loadCrmConfig(p).amocrm.token).toBe(TOKEN);
      writeFileSync(p, '{oops');
      expect(loadCrmConfig(p)).toEqual(emptyCrmConfig());
      expect(readFileSync(p + '.bad', 'utf8')).toBe('{oops');
      expect(cleanCrmConfig({ amocrm: { entity: 'x', token: 5 }, bitrix: { responsibleId: 'abc' } })).toEqual(emptyCrmConfig());
      const sp = join(dir, 'sent.json');
      recordSent(sp, { key: 'k', target: 'amocrm', id: '1', ts: 1, createdId: null });
      expect(loadSent(sp)).toHaveLength(1);
      expect(readFileSync(sp, 'utf8')).not.toContain('Анна');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CrmController (the File page)', () => {
  it('nothing goes without a preview; changed brief → preview again; repeat needs «ещё раз»; tokens stay hidden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-crmpage-'));
    try {
      const files: Record<string, string> = { '/b/a.brief.txt': BRIEF };
      const calls: string[] = [];
      const ctl = new CrmController({
        configPath: () => join(dir, 'crm.json'),
        sentPath: () => join(dir, 'sent.json'),
        read: (p) => files[p] ?? null,
        fetch: async (url) => (calls.push(url), { status: 200, headers: { get: () => null }, text: async () => '{"id":"n1"}' }),
        version: '2.0.0',
        checkHost: async () => '',
      });
      let st = ctl.setConfig('hubspot', { token: HS, object: 'contacts' });
      expect(st.targets.find((x) => x.id === 'hubspot')!.ready).toBe(true);
      expect(JSON.stringify(st)).not.toContain(HS);
      // Empty token keeps the stored one.
      st = ctl.setConfig('hubspot', { token: '', object: 'deals' });
      expect(loadCrmConfig(join(dir, 'crm.json')).hubspot).toEqual({ token: HS, object: 'deals' });
      st = ctl.setConfig('webhook', { url: 'https://10.1.2.3/x' });
      expect(st.status).toMatch(/Не сохранено/);
      st = await ctl.send(false);
      expect(calls).toHaveLength(0);
      st = ctl.preview('/b/a.brief.txt', 'hubspot', '321', false);
      expect(st.preview).toContain('Анна: КП до пятницы');
      expect(st.preview).not.toContain(HS);
      files['/b/a.brief.txt'] = BRIEF + '- новая задача\n';
      st = await ctl.send(false);
      expect(calls).toHaveLength(0);
      expect(st.status).toMatch(/изменились/);
      st = await ctl.send(false);
      expect(st.ok).toBe(true);
      expect(calls).toEqual(['https://api.hubapi.com/crm/v3/objects/notes']);
      st = ctl.preview('/b/a.brief.txt', 'hubspot', '321', false);
      expect(st.duplicate).toMatch(/уже отправлена/);
      st = await ctl.send(false);
      expect(calls).toHaveLength(1);
      st = await ctl.send(true);
      expect(calls).toHaveLength(2);
      expect(ctl.preview('/b/a.brief.txt', 'hubspot', '321', true).status).toMatch(/score/);
      expect(ctl.preview('/b/nope.brief.txt', 'hubspot', '1', false).status).toMatch(/no brief/);
      files['/etc/secret.txt'] = 'x';
      expect(ctl.preview('/etc/secret.txt', 'hubspot', '1', false).status).toMatch(/\.brief\.txt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review fixes', () => {
  const res = (status: number, body = '{}') => ({ status, headers: { get: () => null }, text: async () => body });
  it('502/504: not repeated for a CRM (uncertain), repeated for the webhook with Idempotency-Key', async () => {
    let n = 0;
    const f: Fetch = async () => (n++, res(504));
    const r = await sendRequest('amocrm', buildRequest('amocrm', cfg(), payload, '1'), { fetch: f, sleep: async () => undefined });
    expect(n).toBe(1);
    expect(r).toMatchObject({ ok: false, uncertain: true });
    n = 0;
    const g: Fetch = async () => (++n < 2 ? res(502) : res(200));
    expect((await sendRequest('webhook', buildRequest('webhook', cfg(), payload, ''), { fetch: g, sleep: async () => undefined })).ok).toBe(true);
    expect(n).toBe(2);
  });
  it('DNS check: a public name resolving to a private address is refused', async () => {
    const { dnsCheck } = await import('../src/main/crm/crmFlow');
    expect(await dnsCheck('https://127.0.0.1.nip.io/x', {}, async () => ['127.0.0.1'])).toMatch(/private/);
    expect(await dnsCheck('https://meta.example.com/', {}, async () => ['169.254.169.254'])).toMatch(/private/);
    expect(await dnsCheck('https://ok.example.com/', {}, async () => ['93.184.216.34'])).toBe('');
    expect(await dnsCheck('http://127.0.0.1:9/', { allowLocal: true }, async () => [])).toBe('');
    expect(await dnsCheck('https://x.example.com/', { allowLocal: true }, async () => ['10.0.0.3'])).toMatch(/private/);
    let fetched = 0;
    const r = await sendRequest('webhook', buildRequest('webhook', cfg(), payload, ''), { fetch: async () => (fetched++, res(200)), checkHost: async () => 'refused' });
    expect(fetched).toBe(0);
    expect(r.ok).toBe(false);
  });
  it('a key in the webhook query string is masked in the preview and the settings view', () => {
    const c = cfg();
    c.webhook.url = 'https://hooks.example.com/in?token=QUERYSECRET42';
    expect(previewText(buildRequest('webhook', c, payload, ''))).not.toContain('QUERYSECRET42');
    expect(JSON.stringify(maskedConfig(c))).not.toContain('QUERYSECRET42');
  });
  it('an uncertain send is journalled, so the next one warns', async () => {
    const { deliver, prepareSend } = await import('../src/main/crm/crmFlow');
    const sent: import('../src/core/crm').SentEntry[] = [];
    const p = prepareSend({ briefPath: '/a.brief.txt', target: 'amocrm', id: '5', withScore: false, cfg: cfg(), read: () => BRIEF, sent, version: '' });
    const r = await deliver(p, async () => res(504), (e) => sent.push(e), () => 1, undefined, async () => '');
    expect(r.uncertain).toBe(true);
    expect(sent).toEqual([{ key: p.key, target: 'amocrm', id: '5', ts: 1, createdId: null, uncertain: true }]);
    expect(prepareSend({ briefPath: '/a.brief.txt', target: 'amocrm', id: '5', withScore: false, cfg: cfg(), read: () => BRIEF, sent, version: '' }).duplicate?.uncertain).toBe(true);
  });
});
