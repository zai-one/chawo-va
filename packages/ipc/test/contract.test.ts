import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from '../src/contract';

const MAIN = join(__dirname, '..', '..', '..', 'apps', 'desktop', 'src', 'main');

/** Main-process modules of the main window. The overlay, sales card and decoder windows have their own channels. */
const OWN_WINDOWS = /(overlayWindow|salesCardWindow|chromiumDecoder)\.ts$/;

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((n) => {
    const path = join(dir, n);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !OWN_WINDOWS.test(path) ? [{ path, text: readFileSync(path, 'utf8') }] : [];
  });
}

/** Channels registered or pushed for the main window, found by the typed helpers' call sites. */
function used(pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const { text } of sources(MAIN)) for (const m of text.matchAll(pattern)) out.add(m[1]);
  return out;
}

describe('IPC contract', () => {
  it('names each channel once and keeps the three kinds apart', () => {
    for (const list of [INVOKE_CHANNELS, SEND_CHANNELS, EVENT_CHANNELS]) expect(new Set(list).size).toBe(list.length);
    for (const ch of SEND_CHANNELS) expect(INVOKE_CHANNELS).not.toContain(ch);
    for (const ch of [...INVOKE_CHANNELS, ...SEND_CHANNELS, ...EVENT_CHANNELS]) expect(ch).toMatch(/^[a-z]+:[a-zA-Z]+$/);
  });

  it('every invoke channel has exactly the handler main registers, and no handler is outside the contract', () => {
    const handled = used(/\bhandle\('([\w:]+)'/g);
    expect([...handled].sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('every send channel is received in main', () => {
    expect([...used(/\bonSend\('([\w:]+)'/g)].sort()).toEqual([...SEND_CHANNELS].sort());
  });

  it('every pushed event is in the contract (the window may ignore some)', () => {
    const pushed = used(/\b(?:emit\([^,]+, |send\()'([\w:]+)'/g);
    expect(pushed.size).toBeGreaterThan(5);
    for (const ch of pushed) expect(EVENT_CHANNELS, ch).toContain(ch);
  });

  it('main never talks to the main window around the typed helpers', () => {
    for (const { path, text } of sources(MAIN)) {
      // Raw ipcMain / webContents.send stay in ipc.ts itself and in the other windows' modules.
      if (path.endsWith('ipc.ts') && !path.endsWith('Ipc.ts')) continue;
      expect(text, path).not.toMatch(/ipcMain\.(handle|on)\(|webContents\.send\(/);
    }
  });
});
