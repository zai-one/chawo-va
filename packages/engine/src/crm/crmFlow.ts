// One «В CRM» send, shared by the File page and `chawo-va crm send`: read the brief (+ score),
// build the exact request, show the masked preview, catch a repeat, send, record the journal.

import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { basename } from 'node:path';
import {
  buildRequest, idempotencyKey, makePayload, previewText, privateHost, scorePathFor, sendRequest,
  type CrmConfig, type CrmRequest, type CrmTarget, type Fetch, type SendResult, type SentEntry, type UrlRules,
} from '@chawo/core/crm';

export interface Prepared {
  target: CrmTarget;
  id: string;
  key: string;
  request: CrmRequest;
  preview: string;
  /** This brief already went to this record (from crm-sent.json). */
  duplicate: SentEntry | null;
  withScore: boolean;
}

export function crmRules(): UrlRules {
  return { allowLocal: process.env.CHAWO_CRM_ALLOW_LOCAL === '1' };
}

/** Throws Error with a human reason (no secrets in it). */
export function prepareSend(o: {
  briefPath: string;
  target: CrmTarget;
  id: string;
  withScore: boolean;
  cfg: CrmConfig;
  read: (path: string) => string | null;
  sent: SentEntry[];
  version: string;
  now?: number;
  rules?: UrlRules;
}): Prepared {
  const text = o.read(o.briefPath);
  if (text == null) throw new Error(`no brief file ${basename(o.briefPath)}`);
  if (!text.trim()) throw new Error('the brief is empty');
  let score: string | null = null;
  if (o.withScore) {
    const sp = scorePathFor(o.briefPath);
    score = sp ? o.read(sp) : null;
    if (!score?.trim()) throw new Error('no .score.txt beside the brief (run «Проверка по чек-листу» first)');
  }
  const payload = makePayload(text, basename(o.briefPath), score);
  const id = o.id.trim();
  const request = buildRequest(o.target, o.cfg, payload, id, { now: o.now, version: o.version, rules: o.rules ?? crmRules() });
  const key = idempotencyKey(o.target, id, payload);
  return { target: o.target, id, key, request, preview: previewText(request), duplicate: o.sent.find((x) => x.key === key) ?? null, withScore: o.withScore };
}

/**
 * SSRF guard at send time: the name must not resolve to a private / loopback address (a public-looking
 * name like «127.0.0.1.nip.io» passes the URL check). Loopback is allowed only with the test switch.
 */
export async function dnsCheck(url: string, rules: UrlRules = crmRules(), resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<string> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return 'not a valid URL';
  }
  let addrs: string[];
  try {
    addrs = /^[\d.]+$|:/.test(host) ? [host] : await resolve(host);
  } catch {
    return '';  // DNS failure: fetch reports it (ENOTFOUND)
  }
  const bad = addrs.find((a) => !addressAllowed(a, rules));
  return bad ? `the address resolves to a private network (${bad}); refused` : '';
}

const isLoop = (a: string) => /^127\./.test(a) || a === '::1';
function addressAllowed(a: string, rules: UrlRules): boolean {
  return !privateHost(a) || (!!rules.allowLocal && isLoop(a));
}

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const resolveAll: Resolve = (h) => lookup(h, { all: true });

/**
 * DNS-rebinding guard: the socket connects only to an address that was checked in the same
 * lookup. The name is resolved once, every address is checked, and the connection is handed
 * exactly those addresses, so a second answer from DNS cannot point the request somewhere else.
 */
export function pinnedLookup(rules: UrlRules = crmRules(), resolve: Resolve = resolveAll): LookupFunction {
  return (hostname: string, options: { all?: boolean }, cb: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void) => {
    resolve(hostname).then(
      (addrs) => {
        const bad = addrs.find((a) => !addressAllowed(a.address, rules));
        if (bad || addrs.length === 0) {
          const err: NodeJS.ErrnoException = new Error(bad ? `the address resolves to a private network (${bad.address}); refused` : `no address for ${hostname}`);
          err.code = bad ? 'BLOCKED_ADDRESS' : 'ENOTFOUND';
          return cb(err, '', 0);
        }
        if (options?.all) cb(null, addrs);
        else cb(null, addrs[0].address, addrs[0].family);
      },
      (e: NodeJS.ErrnoException) => cb(e, '', 0),
    );
  };
}

/** Up to 64 KB of the answer is kept: only the status, a created id and an error text are used. */
export function pinnedFetch(rules: UrlRules = crmRules(), resolve: Resolve = resolveAll): Fetch {
  const lookupFn = pinnedLookup(rules, resolve);
  return (url, init) =>
    new Promise((ok, fail) => {
      const u = new URL(url);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && rules.allowLocal)) return fail(Object.assign(new Error('only https is allowed'), { code: 'BLOCKED_ADDRESS' }));
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, { method: init.method, headers: { ...init.headers, 'content-length': String(Buffer.byteLength(init.body)) }, signal: init.signal, lookup: lookupFn }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < 65536) chunks.push(c);
          size += c.length;
        });
        res.on('error', fail);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          ok({
            status: res.statusCode ?? 0,
            headers: { get: (k: string) => { const v = res.headers[k.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v); } },
            text: async () => text,
          });
        });
      });
      req.on('error', fail);
      req.end(init.body);
    });
}

export async function deliver(p: Prepared, fetch: Fetch, record: (e: SentEntry) => void, now: () => number = Date.now, signal?: AbortSignal, checkHost: (url: string) => Promise<string> = (u) => dnsCheck(u)): Promise<SendResult> {
  const r = await sendRequest(p.target, p.request, { fetch, signal, checkHost });
  // An unclear outcome (timeout, 502/504) is recorded too, so the next send warns about a repeat.
  if (r.ok || r.uncertain) record({ key: p.key, target: p.target, id: p.id, ts: now(), createdId: r.createdId, ...(r.ok ? {} : { uncertain: true }) });
  return r;
}

/** Default transport: no redirects (http.request never follows them) and a pinned, checked address. */
export const nodeFetch: Fetch = (url, init) => pinnedFetch()(url, init);
