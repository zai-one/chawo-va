// «В CRM» on the File page: settings block (tokens masked, never sent back to the screen), the
// preview of exactly what goes out, and the send. A send is accepted only for the request that was
// previewed last (same key), so nothing leaves without the user having seen it. No Electron here.

import { CRM_TARGETS, checkUrl, emptyCrmConfig, maskedConfig, type CrmConfig, type CrmTarget, type Fetch, type SentEntry } from '../../core/crm';
import { t } from '../../core/strings';
import * as Log from '../log';
import { crmRules, deliver, prepareSend, type Prepared } from './crmFlow';
import { loadCrmConfig, loadSent, recordSent, saveCrmConfig } from './crmStore';

export const CRM_NAMES: Record<CrmTarget, string> = { amocrm: 'amoCRM', bitrix: 'Bitrix24', hubspot: 'HubSpot', webhook: 'Webhook' };

export interface CrmStateDto {
  targets: { id: CrmTarget; name: string; ready: boolean }[];
  config: ReturnType<typeof maskedConfig>;
  preview: string;
  previewFor: { target: CrmTarget; id: string; score: boolean; path: string } | null;
  duplicate: string;
  status: string;
  ok: boolean | null;
  busy: boolean;
}

export interface CrmHooks {
  configPath: () => string;
  sentPath: () => string;
  read: (path: string) => string | null;
  fetch: Fetch;
  version: string;
  now?: () => number;
  push?: () => void;
  /** SSRF check before sending (tests pass a stub; default resolves DNS). */
  checkHost?: (url: string) => Promise<string>;
}

export class CrmController {
  private prepared: Prepared | null = null;
  private previewFor: CrmStateDto['previewFor'] = null;
  private status = '';
  private ok: boolean | null = null;
  private busy = false;

  constructor(private readonly h: CrmHooks) {}

  private cfg(): CrmConfig {
    return loadCrmConfig(this.h.configPath());
  }

  state(): CrmStateDto {
    const m = maskedConfig(this.cfg());
    return {
      targets: CRM_TARGETS.map((id) => ({ id, name: CRM_NAMES[id], ready: Boolean(m[id].ready) })),
      config: m,
      preview: this.prepared?.preview ?? '',
      previewFor: this.previewFor,
      duplicate: this.prepared?.duplicate ? t(`Эта карточка ${this.prepared.duplicate.uncertain ? 'возможно, уже' : 'уже'} отправлена сюда ${new Date(this.prepared.duplicate.ts).toLocaleString()}. Нажмите «Отправить ещё раз», если это нужно.`, `This brief was already sent here on ${new Date(this.prepared.duplicate.ts).toLocaleString()}. Press «Send again» if you mean it.`) : '',
      status: this.status,
      ok: this.ok,
      busy: this.busy,
    };
  }

  /**
   * Saves one target. Empty token / secret / webhook fields keep the stored value (the screen never
   * gets them back); `clear` drops the target's settings.
   */
  setConfig(target: CrmTarget, fields: Record<string, unknown>): CrmStateDto {
    if (!CRM_TARGETS.includes(target)) return this.state();
    const c = this.cfg();
    const f = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string).trim() : undefined);
    const rules = crmRules();
    let err = '';
    if (fields.clear === true) c[target] = emptyCrmConfig()[target] as never;
    else if (target === 'amocrm') {
      const base = f('base');
      if (base !== undefined) { if (base && (err = checkUrl('amocrm', base, rules))) err = `amoCRM: ${err}`; else c.amocrm.base = base; }
      const e = f('entity'); if (e && ['leads', 'contacts', 'companies'].includes(e)) c.amocrm.entity = e as never;
      const tok = f('token'); if (tok) c.amocrm.token = tok;
    } else if (target === 'bitrix') {
      const w = f('webhook');
      if (w) { if ((err = checkUrl('bitrix', w, rules))) err = `Bitrix24: ${err}`; else c.bitrix.webhook = w; }
      const e = f('entity'); if (e && ['lead', 'deal', 'contact', 'company'].includes(e)) c.bitrix.entity = e as never;
      const mode = f('mode'); if (mode === 'comment' || mode === 'task') c.bitrix.mode = mode;
      const r = f('responsibleId'); if (r !== undefined && (r === '' || /^\d{1,12}$/.test(r))) c.bitrix.responsibleId = r;
    } else if (target === 'hubspot') {
      const tok = f('token'); if (tok) c.hubspot.token = tok;
      const o = f('object'); if (o && ['contacts', 'deals', 'companies'].includes(o)) c.hubspot.object = o as never;
    } else {
      const u = f('url');
      if (u !== undefined) { if (u && (err = checkUrl('webhook', u, rules))) err = `Webhook: ${err}`; else c.webhook.url = u; }
      const s = f('secret'); if (s) c.webhook.secret = s;
    }
    if (err) {
      this.status = t(`Не сохранено: ${err}`, `Not saved: ${err}`);
      this.ok = false;
    } else {
      try {
        saveCrmConfig(this.h.configPath(), c);
        this.status = t(`Настройки ${CRM_NAMES[target]} сохранены.`, `${CRM_NAMES[target]} settings saved.`);
        this.ok = true;
        Log.write(`crm config ${target} saved`);
      } catch (e) {
        this.status = t('Не удалось сохранить настройки CRM.', 'Could not save the CRM settings.');
        this.ok = false;
        Log.write(`crm config save failed: ${e instanceof Error ? e.name : 'error'}`);
      }
    }
    this.prepared = null;
    this.previewFor = null;
    return this.state();
  }

  /** «Показать»: the exact request (secrets masked). Required before «Отправить». */
  preview(path: string, target: CrmTarget, id: string, score: boolean): CrmStateDto {
    this.prepared = null;
    this.previewFor = null;
    this.ok = null;
    this.status = '';
    if (!path || !CRM_TARGETS.includes(target)) return this.state();
    // The page only ever offers a «Кратко и задачи» file: nothing else may be read and sent from here.
    if (!/\.brief\.txt$/i.test(path)) {
      this.status = t('Не готово: отправить можно только карточку .brief.txt.', 'Not ready: only a .brief.txt card can be sent.');
      this.ok = false;
      return this.state();
    }
    try {
      this.prepared = prepareSend({ briefPath: path, target, id, withScore: score, cfg: this.cfg(), read: this.h.read, sent: loadSent(this.h.sentPath()), version: this.h.version, now: (this.h.now ?? Date.now)() });
      this.previewFor = { target, id: id.trim(), score, path };
    } catch (e) {
      this.status = t('Не готово: ', 'Not ready: ') + (e instanceof Error ? e.message : String(e));
      this.ok = false;
    }
    return this.state();
  }

  clearPreview(): CrmStateDto {
    this.prepared = null;
    this.previewFor = null;
    this.status = '';
    this.ok = null;
    return this.state();
  }

  /** «Отправить»: rebuilds the request; it must be the one on screen (same key, same address). */
  async send(force: boolean): Promise<CrmStateDto> {
    const shown = this.prepared;
    const f = this.previewFor;
    if (!shown || !f || this.busy) return this.state();
    let now: Prepared;
    try {
      now = prepareSend({ briefPath: f.path, target: f.target, id: f.id, withScore: f.score, cfg: this.cfg(), read: this.h.read, sent: loadSent(this.h.sentPath()), version: this.h.version, now: (this.h.now ?? Date.now)() });
    } catch (e) {
      this.status = t('Не отправлено: ', 'Not sent: ') + (e instanceof Error ? e.message : String(e));
      this.ok = false;
      return this.state();
    }
    if (now.key !== shown.key || now.request.url !== shown.request.url) {
      this.prepared = now;
      this.status = t('Карточка или настройки изменились — проверьте, что уйдёт, и нажмите «Отправить» ещё раз.', 'The brief or the settings changed — check what goes out and press «Send» again.');
      this.ok = false;
      return this.state();
    }
    if (now.duplicate && !force) {
      this.prepared = now;
      return this.state();
    }
    this.busy = true;
    this.status = t(`Отправляю в ${CRM_NAMES[f.target]}…`, `Sending to ${CRM_NAMES[f.target]}…`);
    this.h.push?.();
    try {
      const r = await deliver(now, this.h.fetch, (e: SentEntry) => recordSent(this.h.sentPath(), e), this.h.now ?? Date.now, undefined, this.h.checkHost);
      Log.write(`crm send ${f.target} ${r.ok ? 'ok' : 'failed'} ${r.status} attempts ${r.attempts}`);
      this.ok = r.ok;
      this.status = r.ok
        ? t(`Отправлено в ${CRM_NAMES[f.target]}${r.createdId ? ` (id ${r.createdId})` : ''}.`, `Sent to ${CRM_NAMES[f.target]}${r.createdId ? ` (id ${r.createdId})` : ''}.`)
        : t(`${CRM_NAMES[f.target]} не принял: ${r.message}`, `${CRM_NAMES[f.target]} refused: ${r.message}`);
      if (r.ok) { this.prepared = null; this.previewFor = null; }
    } finally {
      this.busy = false;
    }
    return this.state();
  }
}
