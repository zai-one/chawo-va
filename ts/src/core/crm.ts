// «В CRM»: the brief («Кратко и задачи», optionally the checklist score) goes to amoCRM, Bitrix24,
// HubSpot or your own webhook — only by an explicit button / command, never by itself. Pure request
// building, URL checks, preview (secrets masked) and one careful sender. No Electron, no fs here.
//
// Secrets (tokens, the Bitrix webhook path, the webhook signing secret) never reach the preview, the
// log or error texts: everything shown to a human goes through redact().

import { createHash, createHmac } from 'node:crypto';

export const CRM_TARGETS = ['amocrm', 'bitrix', 'hubspot', 'webhook'] as const;
export type CrmTarget = (typeof CRM_TARGETS)[number];

export interface AmoConfig { base: string; entity: 'leads' | 'contacts' | 'companies'; token: string }
export interface BitrixConfig { webhook: string; entity: 'lead' | 'deal' | 'contact' | 'company'; mode: 'comment' | 'task'; responsibleId: string }
export interface HubspotConfig { token: string; object: 'contacts' | 'deals' | 'companies' }
export interface WebhookConfig { url: string; secret: string }

export interface CrmConfig {
  amocrm: AmoConfig;
  bitrix: BitrixConfig;
  hubspot: HubspotConfig;
  webhook: WebhookConfig;
}

export function emptyCrmConfig(): CrmConfig {
  return {
    amocrm: { base: '', entity: 'leads', token: '' },
    bitrix: { webhook: '', entity: 'deal', mode: 'comment', responsibleId: '' },
    hubspot: { token: '', object: 'contacts' },
    webhook: { url: '', secret: '' },
  };
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Lenient read of crm.json: unknown keys dropped, bad values back to defaults. */
export function cleanCrmConfig(raw: unknown): CrmConfig {
  const d = emptyCrmConfig();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const a = r.amocrm ?? {};
  const b = r.bitrix ?? {};
  const h = r.hubspot ?? {};
  const w = r.webhook ?? {};
  return {
    amocrm: { base: str(a.base), entity: pick(a.entity, ['leads', 'contacts', 'companies'] as const, d.amocrm.entity), token: str(a.token) },
    bitrix: { webhook: str(b.webhook), entity: pick(b.entity, ['lead', 'deal', 'contact', 'company'] as const, d.bitrix.entity), mode: pick(b.mode, ['comment', 'task'] as const, d.bitrix.mode), responsibleId: /^\d{1,12}$/.test(str(b.responsibleId)) ? str(b.responsibleId) : '' },
    hubspot: { token: str(h.token), object: pick(h.object, ['contacts', 'deals', 'companies'] as const, d.hubspot.object) },
    webhook: { url: str(w.url), secret: str(w.secret) },
  };
}

// ---------- URL checks (SSRF) ----------

export interface UrlRules {
  /** Tests / a local mock: http://127.0.0.1 and localhost allowed for every target. */
  allowLocal?: boolean;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i;
/** Private, link-local, CGNAT, metadata and other non-public literal hosts. */
export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) return h === '::' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  // Bare numbers / hex («2130706433», «0x7f000001») resolve to IPs too.
  return /^(0x[0-9a-f]+|\d+)$/.test(h);
}

/** Checks a URL the user typed for a target. Returns an error text (English, for logs) or ''. */
export function checkUrl(target: CrmTarget, url: string, rules: UrlRules = {}): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a valid URL';
  }
  if (u.username || u.password) return 'the URL must not contain a user name or password';
  const local = LOOPBACK.test(u.hostname);
  if (rules.allowLocal && local) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http(s)';
  } else {
    if (u.protocol !== 'https:') return 'only https:// is allowed';
    if (privateHost(u.hostname)) return 'local and private addresses are not allowed';
  }
  if (target === 'amocrm' && !(rules.allowLocal && local) && !/\.(amocrm\.(ru|com)|kommo\.com)$/i.test(u.hostname)) return 'amoCRM address must be https://<subdomain>.amocrm.ru (or .amocrm.com / .kommo.com)';
  if (target === 'bitrix' && !/\/rest\/\d+\/[^/]+\/?$/.test(u.pathname)) return 'Bitrix24 webhook must look like https://<portal>/rest/<user>/<code>/';
  return '';
}

// ---------- the brief ----------

export interface BriefPayload {
  summary: string[];
  tasks: string[];
  /** The brief as written (.brief.txt). */
  text: string;
  /** .score.txt text when asked for, else null. */
  score: string | null;
  /** File name only (no folders): «meeting.brief.txt». */
  source: string;
}

const SUMMARY_RE = /^(кратко|итоги?|summary|brief)[:.]?\s*$/iu;
const TASKS_RE = /^(задачи|поручения|tasks|action items|todo)[:.]?\s*$/iu;

/** «Кратко» / «Задачи» sections as written by the Brain; anything else goes to the summary. */
export function parseBrief(text: string): { summary: string[]; tasks: string[] } {
  const summary: string[] = [];
  const tasks: string[] = [];
  let into = summary;
  for (const raw of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.replace(/^#+\s*|\*\*/g, '').trim();
    if (SUMMARY_RE.test(head)) { into = summary; continue; }
    if (TASKS_RE.test(head)) { into = tasks; continue; }
    const item = line.replace(/^([-*•]|\d+[.)])\s+/, '').trim();
    if (item && !/^\((нет|none)\)$/i.test(item)) into.push(item);
  }
  return { summary, tasks };
}

export const MAX_TEXT = 60_000;

export function makePayload(briefText: string, source: string, score: string | null): BriefPayload {
  const text = briefText.replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT);
  const { summary, tasks } = parseBrief(text);
  return { summary, tasks, text, score: score ? score.replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT) : null, source: source.split(/[\\/]/).pop() ?? source };
}

/** Plain text of the note: what a person reads in the CRM. */
export function noteText(p: BriefPayload): string {
  let s = p.text;
  if (p.score) s += '\n\n' + p.score;
  return `${s}\n\n— Chawo, ${p.source}`;
}

// ---------- requests ----------

export interface CrmRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Strings that must never be shown: tokens, webhook paths, secrets. */
  secrets: string[];
}

/** Same brief to the same place = same key (a repeat is caught before anything is sent). */
export function idempotencyKey(target: CrmTarget, entityId: string, p: BriefPayload): string {
  return createHash('sha256').update(`${target}\u0000${entityId}\u0000${p.text}\u0000${p.score ?? ''}`).digest('hex').slice(0, 32);
}

export function entityIdOk(target: CrmTarget, id: string): boolean {
  if (target === 'webhook') return id === '' || /^[\w.:-]{1,64}$/.test(id);
  return /^\d{1,19}$/.test(id);
}

const BITRIX_TYPE = { lead: 'L', deal: 'D', contact: 'C', company: 'CO' } as const;
/** HubSpot «note → object» association type ids (HUBSPOT_DEFINED). */
export const HUBSPOT_ASSOC = { contacts: 202, companies: 190, deals: 214 } as const;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface BuildOptions { now?: number; version?: string; rules?: UrlRules }

/** The exact request for one send. Throws Error(message) with a human-readable reason. */
export function buildRequest(target: CrmTarget, cfg: CrmConfig, p: BriefPayload, entityId: string, o: BuildOptions = {}): CrmRequest {
  const id = entityId.trim();
  if (!entityIdOk(target, id)) throw new Error(target === 'webhook' ? 'bad --id' : 'the record id must be a number');
  const key = idempotencyKey(target, id, p);
  const json = { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' };
  const note = noteText(p);
  switch (target) {
    case 'amocrm': {
      const c = cfg.amocrm;
      if (!c.base || !c.token) throw new Error('amoCRM is not set up: address and token');
      const bad = checkUrl('amocrm', c.base, o.rules);
      if (bad) throw new Error(`amoCRM address: ${bad}`);
      const base = c.base.replace(/\/+$/, '');
      return {
        method: 'POST',
        url: `${base}/api/v4/${c.entity}/${id}/notes`,
        headers: { ...json, authorization: `Bearer ${c.token}` },
        body: JSON.stringify([{ note_type: 'common', params: { text: note } }]),
        secrets: [c.token],
      };
    }
    case 'bitrix': {
      const c = cfg.bitrix;
      if (!c.webhook) throw new Error('Bitrix24 is not set up: webhook URL');
      const bad = checkUrl('bitrix', c.webhook, o.rules);
      if (bad) throw new Error(`Bitrix24 webhook: ${bad}`);
      const base = c.webhook.replace(/\/+$/, '') + '/';
      const secretPath = new URL(base).pathname.replace(/\/+$/, '');
      if (c.mode === 'task') {
        if (!c.responsibleId) throw new Error('Bitrix24 task needs the responsible user id');
        const title = (p.tasks[0] ?? p.summary[0] ?? 'Итоги встречи').slice(0, 250);
        return {
          method: 'POST',
          url: base + 'tasks.task.add.json',
          headers: json,
          body: JSON.stringify({ fields: { TITLE: `Chawo: ${title}`, DESCRIPTION: note, RESPONSIBLE_ID: Number(c.responsibleId), UF_CRM_TASK: [`${BITRIX_TYPE[c.entity]}_${id}`] } }),
          secrets: [secretPath],
        };
      }
      return {
        method: 'POST',
        url: base + 'crm.timeline.comment.add.json',
        headers: json,
        body: JSON.stringify({ fields: { ENTITY_ID: Number(id), ENTITY_TYPE: c.entity, COMMENT: note } }),
        secrets: [secretPath],
      };
    }
    case 'hubspot': {
      const c = cfg.hubspot;
      if (!c.token) throw new Error('HubSpot is not set up: private app token');
      // Test-only override (a local mock), honoured only together with allowLocal and only for loopback.
      const over = process.env.CHAWO_CRM_HUBSPOT_BASE ?? '';
      const base = o.rules?.allowLocal && over && (() => { try { return LOOPBACK.test(new URL(over).hostname); } catch { return false; } })() ? over.replace(/\/+$/, '') : 'https://api.hubapi.com';
      return {
        method: 'POST',
        url: `${base}/crm/v3/objects/notes`,
        headers: { ...json, authorization: `Bearer ${c.token}` },
        body: JSON.stringify({
          properties: { hs_timestamp: new Date(o.now ?? Date.now()).toISOString(), hs_note_body: escapeHtml(note).replace(/\n/g, '<br>') },
          associations: [{ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: HUBSPOT_ASSOC[c.object] }] }],
        }),
        secrets: [c.token],
      };
    }
    case 'webhook': {
      const c = cfg.webhook;
      if (!c.url) throw new Error('webhook is not set up: URL');
      const bad = checkUrl('webhook', c.url, o.rules);
      if (bad) throw new Error(`webhook URL: ${bad}`);
      const body = JSON.stringify({
        source: 'chawo-va',
        version: o.version ?? '',
        kind: 'brief',
        id: id || null,
        idempotencyKey: key,
        file: p.source,
        summary: p.summary,
        tasks: p.tasks,
        text: p.text,
        score: p.score,
      });
      const headers: Record<string, string> = { ...json, 'idempotency-key': key };
      if (c.secret) headers['x-chawo-signature'] = 'sha256=' + createHmac('sha256', c.secret).update(body).digest('hex');
      const q = (() => { try { return [...new URL(c.url).searchParams.values()].filter((v) => v.length >= 4); } catch { return []; } })();
      return { method: 'POST', url: c.url, headers, body, secrets: [...(c.secret ? [c.secret] : []), ...q] };
    }
  }
}

/** «?token=abc» → «?token=•••»: a webhook address may carry its own key in the query. */
export function maskQuery(url: string): string {
  try {
    const u = new URL(url);
    if (!u.search) return url;
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, 'MASKED');
    return u.toString().replace(/MASKED/g, '•••');
  } catch {
    return url;
  }
}

/** Replaces every secret (and Bearer values) with «•••». */
export function redact(text: string, secrets: readonly string[]): string {
  let s = text;
  for (const x of [...secrets].filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length)) s = s.split(x).join('•••');
  return s.replace(/(bearer\s+)[^\s"']+/gi, '$1•••');
}

/** What the user sees before sending: the address (secret parts masked), headers, the body. */
export function previewText(r: CrmRequest): string {
  const headers = Object.entries(r.headers).map(([k, v]) => `${k}: ${k === 'authorization' ? 'Bearer •••' : k === 'x-chawo-signature' ? 'sha256=•••' : v}`);
  let body = r.body;
  try {
    body = JSON.stringify(JSON.parse(r.body), null, 2);
  } catch { /* as is */ }
  return redact(`${r.method} ${r.url}\n${headers.join('\n')}\n\n${body}`, r.secrets);
}

// ---------- sending ----------

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual'; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface SendResult {
  ok: boolean;
  status: number;
  /** Short reason for a human, secrets masked. */
  message: string;
  /** Created object id when the CRM returned one. */
  createdId: string | null;
  /** The outcome is unknown (timeout after the request left): do not blindly repeat. */
  uncertain: boolean;
  attempts: number;
}

export interface SendOptions {
  fetch: Fetch;
  timeoutMs?: number;
  /** Extra attempts after the first, only for safe-to-repeat failures. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Before each attempt: '' = the host may be called, else why not (DNS → private address). */
  checkHost?: (url: string) => Promise<string>;
}

function createdIdOf(target: CrmTarget, body: string): string | null {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    if (target === 'amocrm') {
      const notes = (j._embedded as { notes?: { id?: unknown }[] } | undefined)?.notes;
      return notes?.[0]?.id != null ? String(notes[0].id) : null;
    }
    if (target === 'bitrix') {
      const r = j.result as unknown;
      if (typeof r === 'number' || typeof r === 'string') return String(r);
      const task = (r as { task?: { id?: unknown } } | undefined)?.task;
      return task?.id != null ? String(task.id) : null;
    }
    if (target === 'hubspot') return j.id != null ? String(j.id) : null;
    return j.id != null ? String(j.id) : null;
  } catch {
    return null;
  }
}

/** Bitrix24 answers 200 with {"error": …} for some failures. */
function bodyError(target: CrmTarget, body: string): string | null {
  if (target !== 'bitrix') return null;
  try {
    const j = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    return j.error ? `${String(j.error)}${j.error_description ? ': ' + String(j.error_description) : ''}` : null;
  } catch {
    return null;
  }
}

/** «Not done, try later»: safe to repeat everywhere. */
const RETRY_STATUS = new Set([429, 503]);
/** A gateway gave up — the CRM may have acted. Repeated only for the webhook (it carries Idempotency-Key). */
const GATEWAY_STATUS = new Set([502, 504]);

/**
 * Sends once, repeating only when the CRM surely did not act: connection refused / DNS (nothing
 * left), 429, 502, 503, 504. A timeout is not repeated (the note may already exist) and is reported
 * as uncertain. Redirects are refused, so a token never follows a 3xx to another host.
 */
export async function sendRequest(target: CrmTarget, r: CrmRequest, o: SendOptions): Promise<SendResult> {
  const retries = Math.max(0, Math.min(3, o.retries ?? 2));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  let attempts = 0;
  for (;;) {
    attempts++;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    o.signal?.addEventListener('abort', onAbort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, o.timeoutMs ?? 20_000);
    try {
      const blocked = o.checkHost ? await o.checkHost(r.url) : '';
      if (blocked) return { ok: false, status: 0, message: blocked, createdId: null, uncertain: false, attempts };
      const res = await o.fetch(r.url, { method: r.method, headers: r.headers, body: r.body, redirect: 'manual', signal: ac.signal });
      const body = (await res.text()).slice(0, 4000);
      if (res.status >= 200 && res.status < 300) {
        const be = bodyError(target, body);
        if (be) return { ok: false, status: res.status, message: redact(be, r.secrets).slice(0, 300), createdId: null, uncertain: false, attempts };
        return { ok: true, status: res.status, message: 'ok', createdId: createdIdOf(target, body), uncertain: false, attempts };
      }
      if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, message: `redirect refused (HTTP ${res.status}); check the address`, createdId: null, uncertain: false, attempts };
      const repeatable = RETRY_STATUS.has(res.status) || (target === 'webhook' && GATEWAY_STATUS.has(res.status));
      if (repeatable && attempts <= retries && !o.signal?.aborted) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 500 * 2 ** (attempts - 1));
        continue;
      }
      const why = res.status === 401 || res.status === 403 ? 'access denied: check the token / webhook' : res.status === 404 ? 'not found: check the record id and the address' : `HTTP ${res.status}`;
      const detail = redact(body.replace(/\s+/g, ' '), r.secrets).slice(0, 200);
      const unsure = GATEWAY_STATUS.has(res.status);
      const msg = (detail ? `${why} — ${detail}` : why) + (unsure ? '; the note may already be there — check the CRM before sending again' : '');
      return { ok: false, status: res.status, message: msg, createdId: null, uncertain: unsure, attempts };
    } catch (e) {
      if (o.signal?.aborted) return { ok: false, status: 0, message: 'cancelled', createdId: null, uncertain: true, attempts };
      if (timedOut) return { ok: false, status: 0, message: 'no answer in time; the note may already be there — check the CRM before sending again', createdId: null, uncertain: true, attempts };
      const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? '';
      const nothingLeft = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'BLOCKED_ADDRESS'].includes(code);
      if (nothingLeft && attempts <= retries) {
        await sleep(500 * 2 ** (attempts - 1));
        continue;
      }
      const msg = redact(e instanceof Error ? e.message : String(e), r.secrets);
      return { ok: false, status: 0, message: `${code || 'network error'}: ${msg}`.slice(0, 300), createdId: null, uncertain: !nothingLeft, attempts };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
  }
}

// ---------- the local «already sent» journal (no text, no tokens) ----------

export interface SentEntry { key: string; target: CrmTarget; id: string; ts: number; createdId: string | null; uncertain?: boolean }

export function cleanSent(raw: unknown): SentEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is SentEntry => !!x && typeof x.key === 'string' && typeof x.target === 'string' && (CRM_TARGETS as readonly string[]).includes(x.target) && typeof x.id === 'string' && typeof x.ts === 'number')
    .map((x) => ({ key: x.key, target: x.target, id: x.id, ts: x.ts, createdId: typeof x.createdId === 'string' ? x.createdId : null, ...(x.uncertain ? { uncertain: true } : {}) }))
    .slice(-500);
}

/** Masked view of the config for screens and `crm config`: «задан» instead of a token. */
export function maskedConfig(c: CrmConfig): Record<CrmTarget, Record<string, string | boolean>> {
  const bitrixHost = (() => { try { return c.bitrix.webhook ? new URL(c.bitrix.webhook).host : ''; } catch { return '?'; } })();
  return {
    amocrm: { base: c.amocrm.base, entity: c.amocrm.entity, token: !!c.amocrm.token, ready: !!(c.amocrm.base && c.amocrm.token) },
    bitrix: { webhook: bitrixHost ? `https://${bitrixHost}/rest/•••/` : '', entity: c.bitrix.entity, mode: c.bitrix.mode, responsibleId: c.bitrix.responsibleId, ready: !!c.bitrix.webhook && (c.bitrix.mode !== 'task' || !!c.bitrix.responsibleId) },
    hubspot: { object: c.hubspot.object, token: !!c.hubspot.token, ready: !!c.hubspot.token },
    webhook: { url: maskQuery(c.webhook.url), secret: !!c.webhook.secret, ready: !!c.webhook.url },
  };
}

/** .brief.txt → .score.txt beside it (null when the name is not a brief). */
export function scorePathFor(briefPath: string): string | null {
  return /\.brief\.txt$/i.test(briefPath) ? briefPath.replace(/\.brief\.txt$/i, '.score.txt') : null;
}
