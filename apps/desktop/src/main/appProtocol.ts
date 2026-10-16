// The app's pages are served from chawo-app://bundle/… (out/renderer), not from file://. A page on
// file:// gets privileges no web page has (it can read other local files); the package turns those
// off with the GrantFileProtocolExtraPrivileges fuse, and a standard, secure scheme of our own gives
// the pages a real origin instead: 'self' in the CSP means exactly the bundle, and only files inside
// out/renderer are served. registerSchemes() must run before app.ready, handleAppProtocol() after it.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { protocol } from 'electron';
import { MEDIA_SCHEME } from '@chawo/core/localMedia';
import { APP_SCHEME } from './appPaths';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** Both privileged schemes in one call: Electron keeps only the last registerSchemesAsPrivileged list. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false, corsEnabled: true },
    },
  ]);
}

/** The file under `rendererDir` that a chawo-app:// URL names, or null (other host, outside the folder). */
export function bundleFile(url: string, rendererDir: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== 'bundle') return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const base = normalize(rendererDir);
  const file = normalize(join(base, rel));
  return file.startsWith(base + sep) && !file.endsWith(sep) ? file : null;
}

export function handleAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = bundleFile(request.url, rendererDir);
    const type = file ? MIME[extname(file).toLowerCase()] : undefined;
    if (!file || !type) return new Response('Not Found', { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
