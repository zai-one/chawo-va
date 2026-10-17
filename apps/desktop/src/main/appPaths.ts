// Where the built app keeps its parts (electron-vite layout). The app root is the folder with
// package.json: apps/desktop in development, resources/app.asar in the package.
//   out/main/main.js      entry (also out/main/cli.js)      out/preload/<name>.js
//   out/renderer/<page>.html (served as chawo-app://bundle/<page>.html)  resources/iconset/...
// Modules are emitted one file per source module, so only the entry knows its own place: main.ts
// calls init(__dirname) first thing.
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

/** The scheme the built app serves its pages from (appProtocol.ts). */
export const APP_SCHEME = 'chawo-app';
const APP_ORIGIN = `${APP_SCHEME}://bundle`;

let appRoot = '';

export function init(entryDir: string): void {
  appRoot = join(entryDir, '..', '..');
}

export function root(): string {
  if (!appRoot) throw new Error('appPaths.init() was not called');
  return appRoot;
}

export const preload = (name: 'preload' | 'overlayPreload' | 'salesCardPreload' | 'decoderPreload' | 'playerPreload' | 'pillPreload'): string => join(root(), 'out', 'preload', `${name}.js`);
export const rendererDir = (): string => join(root(), 'out', 'renderer');
export const resource = (...parts: string[]): string => join(root(), 'resources', ...parts);

export type Page = 'index' | 'overlay' | 'salesCard' | 'decoder' | 'player' | 'pill';

/** `electron-vite dev` serves the pages with hot reload; the built app loads them from its own scheme. */
export function loadPage(w: BrowserWindow, page: Page): Promise<void> {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev && isDevServer(dev)) return w.loadURL(`${dev}/${page}.html`);
  return w.loadURL(`${APP_ORIGIN}/${page}.html`);
}

/** The dev server is only ever on this machine. */
function isDevServer(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Origin the renderer may load from besides bundled files (dev only). */
export function devOrigin(): string | null {
  const dev = process.env.ELECTRON_RENDERER_URL;
  return dev && isDevServer(dev) ? new URL(dev).origin : null;
}
