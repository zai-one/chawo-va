import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

const { isAppPage } = await import('../src/main/ipc');

const root = join('/opt', 'Chawo', 'resources', 'app.asar');
const page = (p: string) => pathToFileURL(join(root, p)).href;

describe('isAppPage: who may call the main process', () => {
  it('accepts the bundled main window page only', () => {
    expect(isAppPage(page('out/renderer/index.html'), root, null)).toBe(true);
    expect(isAppPage(page('out/renderer/index.html') + '#x', root, null)).toBe(true);
    expect(isAppPage(page('out/renderer/overlay.html'), root, null)).toBe(false);
    expect(isAppPage(page('../evil/out/renderer/index.html'), root, null)).toBe(false);
    expect(isAppPage(pathToFileURL('/tmp/index.html').href, root, null)).toBe(false);
  });

  it('accepts the dev server only when it is the one this app started', () => {
    expect(isAppPage('http://localhost:5173/index.html', root, 'http://localhost:5173')).toBe(true);
    expect(isAppPage('http://localhost:5173/', root, 'http://localhost:5173')).toBe(true);
    expect(isAppPage('http://localhost:5173/index.html', root, null)).toBe(false);
    expect(isAppPage('http://localhost:5174/index.html', root, 'http://localhost:5173')).toBe(false);
    expect(isAppPage('https://example.com/index.html', root, 'http://localhost:5173')).toBe(false);
  });

  it('refuses empty, broken and other-scheme URLs', () => {
    for (const u of ['', 'not a url', 'devtools://devtools/bundled/index.html', 'chawo-media://x/index.html']) {
      expect(isAppPage(u, root, null)).toBe(false);
    }
  });
});
