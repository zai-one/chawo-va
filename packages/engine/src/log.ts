// Append-only log with 1 MB rotation. Never throws. Port of Settings.cs Log.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { localDataDir, logPath } from './paths';

const MAX_BYTES = 1_000_000;
let gate: Promise<void> = Promise.resolve();

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function write(message: string): void {
  // Serialize writes without blocking callers on a mutex primitive.
  gate = gate.then(() => {
    try {
      const dir = localDataDir();
      mkdirSync(dir, { recursive: true });
      const path = logPath();
      try {
        if (existsSync(path) && statSync(path).size > MAX_BYTES) {
          renameSync(path, path + '.1');
        }
      } catch {
        /* rotate best-effort */
      }
      appendFileSync(path, `${stamp()} ${message}\n`, 'utf8');
    } catch {
      /* logging must never break the app */
    }
  });
  void gate;
}

/** Await pending log writes (tests). */
export async function flush(): Promise<void> {
  await gate;
}

/** Ensure the log directory exists so callers can reason about dirname(logPath()). */
export function ensureLogDir(): string {
  const dir = dirname(logPath());
  mkdirSync(dir, { recursive: true });
  return dir;
}
