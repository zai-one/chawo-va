import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, protocol: {} }));

const { isAppPage } = await import('../src/main/ipc');

describe('isAppPage: who may call the main process', () => {
  it('accepts the bundled main window page only', () => {
    expect(isAppPage('chawo-app://bundle/index.html', null)).toBe(true);
    expect(isAppPage('chawo-app://bundle/index.html#x', null)).toBe(true);
    expect(isAppPage('chawo-app://bundle/index.html?q=1', null)).toBe(true);
    expect(isAppPage('chawo-app://bundle/overlay.html', null)).toBe(false);
    expect(isAppPage('chawo-app://bundle/sub/index.html', null)).toBe(false);
    expect(isAppPage('chawo-app://other/index.html', null)).toBe(false);
    expect(isAppPage('chawo-app://x@bundle/index.html', null)).toBe(false);
    expect(isAppPage('chawo-app://bundle:81/index.html', null)).toBe(false);
  });

  it('refuses file:// pages, even the bundled files (pages are served from chawo-app://)', () => {
    expect(isAppPage(pathToFileURL('/opt/Chawo/resources/app.asar/out/renderer/index.html').href, null)).toBe(false);
    expect(isAppPage(pathToFileURL('/tmp/index.html').href, null)).toBe(false);
  });

  it('accepts the dev server only when it is the one this app started', () => {
    expect(isAppPage('http://localhost:5173/index.html', 'http://localhost:5173')).toBe(true);
    expect(isAppPage('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(isAppPage('http://localhost:5173/index.html', null)).toBe(false);
    expect(isAppPage('http://localhost:5174/index.html', 'http://localhost:5173')).toBe(false);
    expect(isAppPage('https://example.com/index.html', 'http://localhost:5173')).toBe(false);
  });

  it('refuses empty, broken and other-scheme URLs', () => {
    for (const u of ['', 'not a url', 'devtools://devtools/bundled/index.html', 'chawo-media://x/index.html']) {
      expect(isAppPage(u, null)).toBe(false);
    }
  });
});
