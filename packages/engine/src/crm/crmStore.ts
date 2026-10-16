// crm.json (settings) on disk and the journal of sends in chawo.db (table crm_sent). Tokens are not in crm.json: they live in the
// vault (OS credential store, else secrets.json) — only if the vault refuses a write does a token stay
// in crm.json as before. Owner-only file mode, atomic writes, a corrupt file is kept as .bad instead of
// being silently replaced. No Electron here: the app and `chawo-va crm` read the same files and vault.

import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cleanCrmConfig, cleanSent, emptyCrmConfig, type CrmConfig, type SentEntry } from '@chawo/core/crm';
import { readSecret, SECRET, writeSecret } from '../secrets';
import { database, retireLegacyFile, transaction } from '../storage/database';

function readJson(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    if (!existsSync(path)) return { ok: true, value: null };
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    try {
      copyFileSync(path, path + '.bad');
    } catch { /* nothing to keep */ }
    return { ok: false };
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch { /* Windows: the profile ACL protects it */ }
}

/** The secret fields of each target. */
const SECRET_FIELDS = [['amocrm', 'token'], ['bitrix', 'webhook'], ['hubspot', 'token'], ['webhook', 'secret']] as const;

type Fields = Record<string, string>;
const fieldsOf = (c: CrmConfig, target: string): Fields => (c as unknown as Record<string, Fields>)[target];

export function loadCrmConfig(path: string): CrmConfig {
  const r = readJson(path);
  const c = r.ok ? cleanCrmConfig(r.value) : emptyCrmConfig();
  let tokenOnDisk = false;
  for (const [target, field] of SECRET_FIELDS) {
    const fromVault = readSecret(SECRET.crm(target, field));
    if (fromVault) fieldsOf(c, target)[field] = fromVault;
    else if (fieldsOf(c, target)[field]) tokenOnDisk = true;
  }
  // An older version kept tokens in crm.json: move them into the vault once.
  if (tokenOnDisk) saveCrmConfig(path, c);
  return c;
}

export function saveCrmConfig(path: string, c: CrmConfig): void {
  const disk = cleanCrmConfig(c);
  for (const [target, field] of SECRET_FIELDS) {
    if (writeSecret(SECRET.crm(target, field), fieldsOf(disk, target)[field] ?? '')) fieldsOf(disk, target)[field] = '';
  }
  writeJson(path, disk);
}

interface SentRow { key: string; target: string; entity_id: string; ts: number; created_id: string | null; uncertain: number }

const importedJournals = new Set<string>();

/** The journal table; a crm-sent.json of an older version beside the database is imported once. */
function journal(dbPath: string): DatabaseSync {
  const db = database(dbPath);
  if (!importedJournals.has(dbPath)) {
    importedJournals.add(dbPath);
    const legacy = join(dirname(dbPath), 'crm-sent.json');
    const r = legacy === dbPath ? ({ ok: true, value: null } as const) : readJson(legacy);
    if (r.ok && r.value !== null) {
      const rows = cleanSent(r.value);
      transaction(db, () => {
        for (const e of rows) insertSent(db, e);
      });
      retireLegacyFile(legacy);
    }
  }
  return db;
}

function insertSent(db: DatabaseSync, e: SentEntry): void {
  db.prepare('INSERT INTO crm_sent (key, target, entity_id, ts, created_id, uncertain) VALUES (?, ?, ?, ?, ?, ?)')
    .run(e.key, e.target, e.id, e.ts, e.createdId, e.uncertain ? 1 : 0);
}

/** What was sent (keys, ids, times; no text, no tokens), oldest first, the last 500. */
export function loadSent(dbPath: string): SentEntry[] {
  const rows = journal(dbPath).prepare('SELECT * FROM (SELECT * FROM crm_sent ORDER BY seq DESC LIMIT 500) ORDER BY seq').all() as unknown as SentRow[];
  return cleanSent(rows.map((r) => ({ key: r.key, target: r.target, id: r.entity_id, ts: r.ts, createdId: r.created_id, ...(r.uncertain ? { uncertain: true } : {}) })));
}

/**
 * Appends a send result. The GUI and `chawo-va crm` may record at the same moment: the SQLite write
 * transaction serialises them (a second writer waits), so neither entry is lost.
 */
export function recordSent(dbPath: string, e: SentEntry): void {
  const db = journal(dbPath);
  transaction(db, () => {
    insertSent(db, e);
    db.prepare('DELETE FROM crm_sent WHERE seq NOT IN (SELECT seq FROM crm_sent ORDER BY seq DESC LIMIT 500)').run();
  });
}
