// Worker threads of the built app (out/main/<name>.js, extra entries in electron.vite.config.ts) are
// started by path. They sit beside the entry script; Electron starts workers from inside app.asar and
// their native modules from app.asar.unpacked, as for the main thread.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

let workerDir: string | null = null;

/**
 * The app's entry calls this with its own folder (out/main): in Electron require.main is not main.js.
 * Without it, the folder of the entry script (cli.js for `chawo-va`).
 */
export function setWorkerDir(dir: string): void {
  workerDir = dir;
}

/** The built worker file, or null (tests, a dev run without a build): the caller works in this thread. */
export function builtWorkerFile(name: string): string | null {
  try {
    const entry = typeof require === 'undefined' ? undefined : require.main?.filename;
    const dir = workerDir ?? (entry ? dirname(entry) : null);
    if (!dir) return null;
    const file = join(dir, name);
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}
