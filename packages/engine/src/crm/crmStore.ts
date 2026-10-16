// crm.json (settings + tokens) and crm-sent.json (journal) on disk. Owner-only file mode, atomic
// writes, a corrupt file is kept as .bad instead of being silently replaced. No Electron here: the
// app and `chawo-va crm` read the same files.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cleanCrmConfig, cleanSent, emptyCrmConfig, type CrmConfig, type SentEntry } from '@chawo/core/crm';

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

export function loadCrmConfig(path: string): CrmConfig {
  const r = readJson(path);
  return r.ok ? cleanCrmConfig(r.value) : emptyCrmConfig();
}

export function saveCrmConfig(path: string, c: CrmConfig): void {
  writeJson(path, cleanCrmConfig(c));
}

export function loadSent(path: string): SentEntry[] {
  const r = readJson(path);
  return r.ok ? cleanSent(r.value) : [];
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run fn while holding `<path>.lock` (O_EXCL). The GUI and `chawo-va crm` may record at the same
 * moment; without the lock one read-modify-write would drop the other's entry. A lock older than
 * staleMs (a crashed writer) is taken over. If the lock cannot be had, fn still runs: losing the
 * duplicate warning is better than losing the send result.
 */
export function withFileLock<T>(path: string, fn: () => T, waitMs = 3000, staleMs = 10_000): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = path + '.lock';
  const until = Date.now() + waitMs;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) unlinkSync(lock);
      } catch { /* gone already */ }
      if (Date.now() > until) break;
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    if (fd != null) {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch { /* taken over as stale */ }
    }
  }
}

/** Re-reads the journal under the lock, appends, writes a unique tmp file and renames it in place. */
export function recordSent(path: string, e: SentEntry): void {
  withFileLock(path, () => writeJson(path, [...loadSent(path), e].slice(-500)));
}
