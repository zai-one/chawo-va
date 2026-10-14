// crm.json (settings + tokens) and crm-sent.json (journal) on disk. Owner-only file mode, atomic
// writes, a corrupt file is kept as .bad instead of being silently replaced. No Electron here: the
// app and `chawo-va crm` read the same files.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cleanCrmConfig, cleanSent, emptyCrmConfig, type CrmConfig, type SentEntry } from '../../core/crm';

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
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
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

export function recordSent(path: string, e: SentEntry): void {
  writeJson(path, [...loadSent(path), e].slice(-500));
}
