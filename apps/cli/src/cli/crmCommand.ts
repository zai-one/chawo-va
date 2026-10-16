// `chawo-va crm send <brief.txt> --to … [--id …] [--score] [--dry-run] [--yes] [--force] [--json]`
// and `chawo-va crm config [--to … settings]`. Same files and the same request as «В CRM» on the
// File page. Tokens come only from stdin («--token -»), never as an argument, so they do not land
// in the shell history or the process list; nothing secret is printed or logged.

import { CRM_TARGETS, maskedConfig, type CrmConfig, type CrmTarget } from '@chawo/core/crm';
import { deliver, nodeFetch, prepareSend } from '@chawo/engine/crm/crmFlow';
import { loadCrmConfig, loadSent, recordSent, saveCrmConfig } from '@chawo/engine/crm/crmStore';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliDeps } from './run';

const NAMES: Record<CrmTarget, string> = { amocrm: 'amoCRM', bitrix: 'Bitrix24', hubspot: 'HubSpot', webhook: 'webhook' };

interface Parsed { action: 'send' | 'config'; file: string; flags: Map<string, string>; bools: Set<string> }

const VALUE_FLAGS = new Set(['--to', '--id', '--base', '--entity', '--mode', '--responsible', '--object', '--url', '--token', '--webhook', '--secret']);
const BOOL_FLAGS = new Set(['--score', '--dry-run', '--yes', '-y', '--force', '--json', '--clear', '-q', '--quiet']);

function parse(args: readonly string[]): Parsed | string {
  const action = args[0];
  if (action !== 'send' && action !== 'config') return 'crm takes send <brief.txt> --to … or config';
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const files: string[] = [];
  for (let i = 1; i < args.length; i++) {
    let a = args[i];
    let v: string | undefined;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === '--lang') { i++; continue; }
    if (a.startsWith('--lang=')) continue;
    if (VALUE_FLAGS.has(a)) {
      if (v === undefined) { v = args[++i]; if (v === undefined) return `${a} needs a value`; }
      flags.set(a, v);
    } else if (BOOL_FLAGS.has(a)) bools.add(a === '-y' ? '--yes' : a === '-q' ? '--quiet' : a);
    else if (a.startsWith('-') && a !== '-') return `unknown option: ${a}`;
    else files.push(a);
  }
  const to = flags.get('--to');
  if (to !== undefined && !(CRM_TARGETS as readonly string[]).includes(to)) return `--to must be ${CRM_TARGETS.join(', ')}`;
  if (action === 'send') {
    if (files.length !== 1) return 'crm send needs one .brief.txt file';
    if (!to) return 'crm send needs --to amocrm|bitrix|hubspot|webhook';
  } else if (files.length > 0) return 'crm config takes no files';
  for (const k of ['--token', '--secret'] as const) if (flags.has(k) && flags.get(k) !== '-') return `${k} is read from stdin only: ${k} - (so it does not stay in the shell history)`;
  return { action, file: files[0] ?? '', flags, bools };
}

export async function crmCommand(args: readonly string[], d: CliDeps): Promise<number> {
  const t = d.t;
  const p = parse(args);
  if (typeof p === 'string') {
    d.err(t(`chawo-va: ${p}\nСправка: chawo-va --help\n`, `chawo-va: ${p}\nSee: chawo-va --help\n`));
    return EXIT_USAGE;
  }
  if (!d.crmConfigPath || !d.crmSentPath) {
    d.err(t('Ошибка: CRM недоступна.', 'Error: CRM is not available.') + '\n');
    return EXIT_FAILED;
  }
  const cfgPath = d.crmConfigPath();
  const cfg = loadCrmConfig(cfgPath);
  const quiet = p.bools.has('--quiet');
  if (p.action === 'config') return config(p, cfg, cfgPath, d, quiet);

  const target = p.flags.get('--to') as CrmTarget;
  const sentPath = d.crmSentPath();
  let prep;
  try {
    prep = prepareSend({
      briefPath: p.file,
      target,
      id: p.flags.get('--id') ?? '',
      withScore: p.bools.has('--score'),
      cfg,
      read: (f) => (d.exists(f) ? d.readFile(f) : null),
      sent: loadSent(sentPath),
      version: d.version,
      now: (d.clock ?? Date.now)(),
    });
  } catch (e) {
    d.err(t('Ошибка: ', 'Error: ') + (e instanceof Error ? e.message : String(e)) + '\n');
    return /id must|bad --id/.test(String(e)) ? EXIT_USAGE : EXIT_FAILED;
  }
  const json = p.bools.has('--json');
  if (p.bools.has('--dry-run')) {
    if (json) d.out(JSON.stringify({ target, id: prep.id, preview: prep.preview, duplicate: !!prep.duplicate }, null, 2) + '\n');
    else d.out(prep.preview + '\n');
    d.log(`cli crm dry-run ${target}`);
    return EXIT_OK;
  }
  if (!quiet || !p.bools.has('--yes')) d.err(t(`Будет отправлено в ${NAMES[target]}:\n`, `This goes to ${NAMES[target]}:\n`) + prep.preview + '\n\n');
  if (prep.duplicate && !p.bools.has('--force')) {
    d.err(t(`Ошибка: эта карточка ${prep.duplicate.uncertain ? 'возможно, уже' : 'уже'} отправлена сюда ${new Date(prep.duplicate.ts).toLocaleString()}. Повторить: --force.`, `Error: this brief was already sent here on ${new Date(prep.duplicate.ts).toLocaleString()}. To send again: --force.`) + '\n');
    return EXIT_FAILED;
  }
  if (!p.bools.has('--yes')) {
    if (!d.stdinIsTTY || !d.ask) {
      d.err(t('Ошибка: подтвердите отправку флагом --yes (или посмотрите заранее с --dry-run).', 'Error: confirm with --yes (or look first with --dry-run).') + '\n');
      return EXIT_USAGE;
    }
    if (!(await d.ask(t('Отправить? [y/N] ', 'Send? [y/N] ')))) {
      d.err(t('Не отправлено.', 'Not sent.') + '\n');
      return EXIT_FAILED;
    }
  }
  const r = await deliver(prep, d.crmFetch ?? nodeFetch, (e) => recordSent(sentPath, e), d.clock ?? Date.now, d.signal, d.crmCheckHost);
  d.log(`cli crm send ${target} ${r.ok ? 'ok' : 'failed'} ${r.status} attempts ${r.attempts}`);
  if (json) d.out(JSON.stringify({ ok: r.ok, status: r.status, createdId: r.createdId, uncertain: r.uncertain, message: r.message }, null, 2) + '\n');
  if (r.ok) {
    if (!quiet) d.err(t(`Отправлено в ${NAMES[target]}${r.createdId ? ` (id ${r.createdId})` : ''}.`, `Sent to ${NAMES[target]}${r.createdId ? ` (id ${r.createdId})` : ''}.`) + '\n');
    return EXIT_OK;
  }
  d.err(t(`Ошибка: ${NAMES[target]} не принял: ${r.message}`, `Error: ${NAMES[target]} refused: ${r.message}`) + '\n');
  return EXIT_FAILED;
}

async function config(p: Parsed, cfg: CrmConfig, path: string, d: CliDeps, quiet: boolean): Promise<number> {
  const t = d.t;
  const to = p.flags.get('--to') as CrmTarget | undefined;
  const changes = [...p.flags.keys()].filter((k) => k !== '--to');
  if (!to) {
    if (changes.length > 0 || p.bools.has('--clear')) {
      d.err(t('chawo-va: crm config: укажите --to amocrm|bitrix|hubspot|webhook\n', 'chawo-va: crm config: give --to amocrm|bitrix|hubspot|webhook\n'));
      return EXIT_USAGE;
    }
    const m = maskedConfig(cfg);
    if (p.bools.has('--json')) d.out(JSON.stringify(m, null, 2) + '\n');
    else for (const k of CRM_TARGETS) d.out(`${k}\t${m[k].ready ? t('настроен', 'ready') : t('не настроен', 'not set up')}\t${Object.entries(m[k]).filter(([n]) => n !== 'ready').map(([n, v]) => `${n}=${typeof v === 'boolean' ? (v ? t('задан', 'set') : '—') : v || '—'}`).join(' ')}\n`);
    return EXIT_OK;
  }
  const allowed: Record<CrmTarget, string[]> = {
    amocrm: ['--base', '--entity', '--token'],
    bitrix: ['--webhook', '--entity', '--mode', '--responsible'],
    hubspot: ['--token', '--object'],
    webhook: ['--url', '--secret'],
  };
  const extra = changes.filter((k) => !allowed[to].includes(k));
  if (extra.length) {
    d.err(t(`chawo-va: для ${to} нет ${extra.join(', ')} (есть: ${allowed[to].join(', ')})\n`, `chawo-va: ${to} has no ${extra.join(', ')} (it has: ${allowed[to].join(', ')})\n`));
    return EXIT_USAGE;
  }
  let stdin: string | null = null;
  const fromStdin = async () => {
    if (stdin === null) stdin = d.readStdin ? (await d.readStdin()).trim() : '';
    return stdin;
  };
  if (changes.filter((k) => p.flags.get(k) === '-').length > 1) {
    d.err('chawo-va: only one value can come from stdin\n');
    return EXIT_USAGE;
  }
  const val = async (k: string) => (p.flags.get(k) === '-' ? await fromStdin() : (p.flags.get(k) ?? '').trim());
  const next: CrmConfig = JSON.parse(JSON.stringify(cfg)) as CrmConfig;
  if (p.bools.has('--clear')) next[to] = (await import('@chawo/core/crm')).emptyCrmConfig()[to] as never;
  const set = async (k: string, apply: (v: string) => string | null) => {
    if (!p.flags.has(k)) return null;
    return apply(await val(k));
  };
  const { checkUrl, crmRulesLocal } = { checkUrl: (await import('@chawo/core/crm')).checkUrl, crmRulesLocal: (await import('@chawo/engine/crm/crmFlow')).crmRules() };
  const errs = (await Promise.all(to === 'amocrm' ? [
    set('--base', (v) => { const e = checkUrl('amocrm', v, crmRulesLocal); if (e) return e; next.amocrm.base = v; return null; }),
    set('--entity', (v) => { if (!['leads', 'contacts', 'companies'].includes(v)) return '--entity: leads, contacts or companies'; next.amocrm.entity = v as never; return null; }),
    set('--token', (v) => { if (!v) return 'empty token'; next.amocrm.token = v; return null; }),
  ] : to === 'bitrix' ? [
    set('--webhook', (v) => { const e = checkUrl('bitrix', v, crmRulesLocal); if (e) return e; next.bitrix.webhook = v; return null; }),
    set('--entity', (v) => { if (!['lead', 'deal', 'contact', 'company'].includes(v)) return '--entity: lead, deal, contact or company'; next.bitrix.entity = v as never; return null; }),
    set('--mode', (v) => { if (v !== 'comment' && v !== 'task') return '--mode: comment or task'; next.bitrix.mode = v; return null; }),
    set('--responsible', (v) => { if (!/^\d{1,12}$/.test(v)) return '--responsible: a user id (number)'; next.bitrix.responsibleId = v; return null; }),
  ] : to === 'hubspot' ? [
    set('--token', (v) => { if (!v) return 'empty token'; next.hubspot.token = v; return null; }),
    set('--object', (v) => { if (!['contacts', 'deals', 'companies'].includes(v)) return '--object: contacts, deals or companies'; next.hubspot.object = v as never; return null; }),
  ] : [
    set('--url', (v) => { const e = checkUrl('webhook', v, crmRulesLocal); if (e) return e; next.webhook.url = v; return null; }),
    set('--secret', (v) => { next.webhook.secret = v; return null; }),
  ])).filter((x): x is string => !!x);
  if (errs.length) {
    d.err(t('Ошибка: ', 'Error: ') + errs.join('; ') + '\n');
    return EXIT_USAGE;
  }
  if (p.flags.get('--webhook') && p.flags.get('--webhook') !== '-' && !quiet)
    d.err(t('Внимание: адрес вебхука Bitrix24 — это пароль; лучше передавать его через stdin: --webhook -\n', 'Note: the Bitrix24 webhook address is a password; better pass it via stdin: --webhook -\n'));
  try {
    saveCrmConfig(path, next);
  } catch (e) {
    d.err(t('Ошибка: не удалось сохранить настройки CRM: ', 'Error: could not save the CRM settings: ') + (e instanceof Error ? e.message : String(e)) + '\n');
    return EXIT_FAILED;
  }
  d.log(`cli crm config ${to}`);
  if (!quiet) d.err(t(`Сохранено: ${NAMES[to]}${maskedConfig(next)[to].ready ? ' — готов к отправке' : ' — ещё не всё задано'}.`, `Saved: ${NAMES[to]}${maskedConfig(next)[to].ready ? ' — ready' : ' — not complete yet'}.`) + '\n');
  return EXIT_OK;
}
