// chawo.db: local data of the app and the CLI in one SQLite file (built-in node:sqlite, no native
// module to rebuild). WAL lets the app write while `chawo-va` reads; busy_timeout makes a second writer
// wait instead of failing. The schema grows by numbered migrations (PRAGMA user_version).
// Local only, never sent anywhere; the file is owner-only.

import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: readonly string[] = [
  // 1: dictation history and the «В CRM» journal (formerly history.jsonl and crm-sent.json).
  `CREATE TABLE history (
     id TEXT PRIMARY KEY,
     ts INTEGER NOT NULL,
     raw TEXT NOT NULL,
     final TEXT NOT NULL,
     command TEXT,
     brain INTEGER NOT NULL,
     brain_failed INTEGER NOT NULL,
     seconds REAL NOT NULL
   );
   CREATE INDEX history_ts ON history (ts);
   CREATE TABLE crm_sent (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     key TEXT NOT NULL,
     target TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     ts INTEGER NOT NULL,
     created_id TEXT,
     uncertain INTEGER NOT NULL DEFAULT 0
   );`,
];

const open = new Map<string, DatabaseSync>();

/** The database at `path`, created and migrated on first use; one connection per file and process. */
export function database(path: string): DatabaseSync {
  const hit = open.get(path);
  if (hit?.isOpen) return hit;
  mkdirSync(dirname(path), { recursive: true });
  const fresh = !existsSync(path);
  const db = new DatabaseSync(path);
  // secure_delete: a deleted phrase is overwritten in the file, not left in a free page.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
  if (fresh) {
    try {
      chmodSync(path, 0o600);
    } catch { /* Windows: the profile ACL protects it */ }
  }
  migrate(db);
  open.set(path, db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Runs fn in a write transaction (BEGIN IMMEDIATE: a second writer waits up to busy_timeout). */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** After a wipe: old page images leave the WAL file too (it is folded into the database and truncated). */
export function flushDeleted(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/** Closes every connection (tests, app exit). */
export function closeDatabases(): void {
  for (const db of open.values()) if (db.isOpen) db.close();
  open.clear();
}

/** A file of an older version that was imported: kept beside as .bak, never deleted. */
export function retireLegacyFile(path: string): void {
  try {
    renameSync(path, `${path}.bak`);
  } catch { /* gone already */ }
}
