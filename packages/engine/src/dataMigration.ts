// First start after 1.17.0: GigaPisar → ChawoVoiceAssistant folders.
// Port of src/App/DataMigration.cs.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { write as logWrite } from './log';
import {
  appDataDir,
  env,
  legacyLocalDir,
  legacyRoamingDir,
  localDataDir,
} from './paths';

export const PROGRAM_EXE_NAMES = ['ChawoVoiceAssistant.exe', 'GigaPisar.exe'] as const;

const pending: string[] = [];

export { env };

export function run(): void {
  try {
    migrate(legacyLocalDir(), localDataDir(), true);
  } catch (e) {
    pending.push(`migrate local failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    migrate(legacyRoamingDir(), appDataDir(), false);
  } catch (e) {
    pending.push(`migrate roaming failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function flushLog(): void {
  for (const line of pending) logWrite(line);
  pending.length = 0;
}

function migrate(oldDir: string, newDir: string, move: boolean): void {
  if (existsSync(newDir) || !existsSync(oldDir)) return;
  if (resolve(oldDir).toLowerCase() === resolve(newDir).toLowerCase()) return;
  const staging = newDir + '.migrating';
  mkdirSync(staging, { recursive: true });
  let failed = 0;
  copyTree(oldDir, staging, move, (n) => {
    failed += n;
  });
  rewriteOldPaths(join(staging, 'settings.json'));
  renameSync(staging, newDir);
  if (move) tryRemoveEmpty(oldDir);
  pending.push(
    `migrated ${oldDir} -> ${newDir} (${move ? 'move' : 'copy'}, ${failed} item(s) left behind)`,
  );
}

function copyTree(
  from: string,
  to: string,
  move: boolean,
  onFail: (n: number) => void,
): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    let st;
    try {
      st = statSync(src);
    } catch {
      continue;
    }
    if (st.isFile()) {
      const dest = join(to, name);
      if (existsSync(dest)) continue;
      try {
        if (move) {
          try {
            renameSync(src, dest);
            continue;
          } catch {
            /* fall through to copy */
          }
        }
        copyFileSync(src, dest);
      } catch (e) {
        onFail(1);
        try {
          if (existsSync(dest)) rmSync(dest);
        } catch {
          /* ignore */
        }
        pending.push(`migrate: ${src}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (st.isDirectory()) {
      if (
        !move &&
        (name.toLowerCase() === 'model' || name.toLowerCase() === 'models')
      ) {
        continue;
      }
      const dest = join(to, name);
      if (move && !existsSync(dest)) {
        try {
          renameSync(src, dest);
          continue;
        } catch {
          /* fall through */
        }
      }
      copyTree(src, dest, move, onFail);
      if (move) tryRemoveEmpty(src);
    }
  }
}

function rewriteOldPaths(settingsFile: string): void {
  try {
    if (!existsSync(settingsFile)) return;
    const text = readFileSync(settingsFile, 'utf8');
    const jsonEscape = (p: string) => p.replace(/\\/g, '\\\\');
    const legLocal = jsonEscape(legacyLocalDir()) + '\\\\';
    const newLocal = jsonEscape(localDataDir()) + '\\\\';
    const legRoam = jsonEscape(legacyRoamingDir()) + '\\\\';
    const newRoam = jsonEscape(appDataDir()) + '\\\\';
    // Case-insensitive replace like C#.
    const reLocal = new RegExp(escapeRe(legLocal), 'gi');
    const reRoam = new RegExp(escapeRe(legRoam), 'gi');
    const updated = text.replace(reLocal, () => newLocal).replace(reRoam, () => newRoam);
    if (updated !== text) writeFileSync(settingsFile, updated, 'utf8');
  } catch (e) {
    pending.push(`migrate: settings paths: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tryRemoveEmpty(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: false });
    }
  } catch {
    /* ignore */
  }
}

/** Exported for SpeechModelStore safety checks. */
export function basenameOf(path: string): string {
  return basename(path);
}
