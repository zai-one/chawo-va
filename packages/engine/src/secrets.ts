// Secrets (Brain API keys, CRM tokens) live in the operating system's credential store: Windows
// Credential Manager, macOS Keychain, the Secret Service on Linux — the same store for the app and
// the CLI. Where there is none (a headless Linux server without D-Bus) they go to secrets.json next to
// the settings, owner-only, and the pages say so instead of losing a key quietly.
// No Electron here; tests use the in-memory vault.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appDataDir } from './paths';
import * as Log from './log';

export type VaultKind = 'keychain' | 'file' | 'memory';

export interface SecretVault {
  readonly kind: VaultKind;
  /** null when nothing is stored under the name. */
  get: (name: string) => string | null;
  /** An empty value removes the secret. Throws when the store refuses the write. */
  set: (name: string, value: string) => void;
}

/** One service name in the OS store; each secret is an account under it. */
export const VAULT_SERVICE = 'Chawo Voice Assistant';

/** Names of the secrets. */
export const SECRET = {
  cleanupKey: 'brain.cleanupKey',
  providerKey: (providerId: string) => `brain.provider.${providerId}`,
  crm: (target: string, field: string) => `crm.${target}.${field}`,
} as const;

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}
type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry };

/** The OS credential store, or null when it cannot be reached on this machine. */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on first use: a native module that may be missing
export function keychainVault(load: () => KeyringModule = () => require('@napi-rs/keyring') as KeyringModule): SecretVault | null {
  let mod: KeyringModule;
  try {
    mod = load();
    // A read of an absent entry answers null when the store works and throws when it does not.
    new mod.Entry(VAULT_SERVICE, 'probe').getPassword();
  } catch (e) {
    Log.write(`secrets: no OS credential store (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
  const entry = (name: string) => new mod.Entry(VAULT_SERVICE, name);
  return {
    kind: 'keychain',
    get: (name) => entry(name).getPassword() ?? null,
    set: (name, value) => {
      if (value) entry(name).setPassword(value);
      else entry(name).deleteCredential();
    },
  };
}

/** secrets.json, owner-only, written atomically. */
export function fileVault(path: string = join(appDataDir(), 'secrets.json')): SecretVault {
  const read = (): Record<string, string> => {
    try {
      if (!existsSync(path)) return {};
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return {};
      return Object.fromEntries(Object.entries(raw).filter((kv): kv is [string, string] => typeof kv[1] === 'string' && kv[1] !== ''));
    } catch {
      return {};
    }
  };
  return {
    kind: 'file',
    get: (name) => read()[name] ?? null,
    set: (name, value) => {
      const all = read();
      if (value) all[name] = value;
      else if (!(name in all)) return;
      else delete all[name];
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);
      try {
        chmodSync(path, 0o600);
      } catch { /* Windows: the profile ACL protects it */ }
    },
  };
}

export function memoryVault(): SecretVault {
  const m = new Map<string, string>();
  return {
    kind: 'memory',
    get: (name) => m.get(name) ?? null,
    set: (name, value) => {
      if (value) m.set(name, value);
      else m.delete(name);
    },
  };
}

let current: SecretVault | null = null;

/**
 * The vault of this process: the OS store when it works, else secrets.json. CHAWO_SECRETS=file keeps
 * secrets in the profile folder (portable installs, test profiles that must not touch the user's store).
 */
export function vault(): SecretVault {
  current ??= (process.env.CHAWO_SECRETS === 'file' ? null : keychainVault()) ?? fileVault();
  return current;
}

/** Tests and the app may pick the vault (null: choose again on the next use). */
export function setVault(v: SecretVault | null): void {
  current = v;
}

/** Reads a secret; a store that fails to answer counts as «nothing stored» (logged). */
export function readSecret(name: string): string {
  try {
    return vault().get(name) ?? '';
  } catch (e) {
    Log.write(`secrets: read ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

/** Stores a secret; false when the store refused (the caller keeps its old way of storing it). */
export function writeSecret(name: string, value: string): boolean {
  try {
    vault().set(name, value);
    return true;
  } catch (e) {
    Log.write(`secrets: write ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
