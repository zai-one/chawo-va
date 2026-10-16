import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type Handler = (req: { url: string }) => Promise<Response>;
const handlers = new Map<string, Handler>();
const registered: { scheme: string }[][] = [];
vi.mock('electron', () => ({
  protocol: {
    handle: (scheme: string, fn: Handler) => handlers.set(scheme, fn),
    registerSchemesAsPrivileged: (list: { scheme: string }[]) => registered.push(list),
  },
}));

const { bundleFile, handleAppProtocol, registerSchemes } = await import('../src/main/appProtocol');

const dir = mkdtempSync(join(tmpdir(), 'chawo-bundle-'));
const renderer = join(dir, 'out', 'renderer');
mkdirSync(join(renderer, 'assets'), { recursive: true });
writeFileSync(join(renderer, 'index.html'), '<!doctype html>');
writeFileSync(join(renderer, 'assets', 'index-1.js'), 'console.log(1)');
writeFileSync(join(renderer, 'notes.txt'), 'x');
writeFileSync(join(dir, 'secret.json'), '{}');

describe('chawo-app:// serves the bundle and nothing else', () => {
  it('maps URLs inside out/renderer only', () => {
    expect(bundleFile('chawo-app://bundle/index.html', renderer)).toBe(join(renderer, 'index.html'));
    expect(bundleFile('chawo-app://bundle/assets/index-1.js?v=1#x', renderer)).toBe(join(renderer, 'assets', 'index-1.js'));
    // The URL parser itself resolves dot segments (also %2e%2e), so they stay inside the bundle.
    expect(bundleFile('chawo-app://bundle/../secret.json', renderer)).toBe(join(renderer, 'secret.json'));
    expect(bundleFile('chawo-app://bundle/%2e%2e/secret.json', renderer)).toBe(join(renderer, 'secret.json'));
    for (const u of [
      'chawo-app://bundle/assets/..%2f..%2fsecret.json',
      'chawo-app://bundle/%00index.html',
      'chawo-app://bundle/%E0%A4%A',
      'chawo-app://other/index.html',
      'chawo-app://bundle/',
      'file:///etc/passwd',
      'nonsense',
    ]) {
      expect(bundleFile(u, renderer), u).toBeNull();
    }
  });

  it('answers with the file and its type, 404 for the rest', async () => {
    handleAppProtocol(renderer);
    const get = (url: string) => handlers.get('chawo-app')!({ url });
    const page = await get('chawo-app://bundle/index.html');
    expect([page.status, page.headers.get('content-type'), await page.text()]).toEqual([200, 'text/html; charset=utf-8', '<!doctype html>']);
    expect((await get('chawo-app://bundle/assets/index-1.js')).headers.get('content-type')).toMatch(/^text\/javascript/);
    for (const u of ['chawo-app://bundle/missing.js', 'chawo-app://bundle/notes.txt', 'chawo-app://bundle/%2e%2e/%2e%2e/secret.json']) {
      expect((await get(u)).status, u).toBe(404);
    }
  });

  it('registers both privileged schemes in one call', () => {
    registerSchemes();
    expect(registered).toHaveLength(1);
    expect(registered[0].map((s) => s.scheme)).toEqual(['chawo-app', 'chawo-media']);
  });
});
