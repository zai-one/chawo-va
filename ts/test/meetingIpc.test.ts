import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  listeners: new Map<string, (...a: unknown[]) => unknown>(),
  display: null as null | ((req: unknown, cb: (r: unknown) => void) => void),
  sources: [{ id: 'screen:0', name: 'Screen' }] as unknown[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-docs' },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => h.listeners.set(ch, fn),
  },
  session: { defaultSession: { setDisplayMediaRequestHandler: (fn: typeof h.display) => (h.display = fn) } },
  desktopCapturer: { getSources: async () => h.sources },
  BrowserWindow: class {},
}));

import { registerMeetingIpc } from '../src/main/meetingIpc';
import * as Settings from '../src/main/settings';
import { applyLanguage } from '../src/core/strings';

let dir: string;
let platform: PropertyDescriptor | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-mipc-'));
  process.env.CHAWO_MEETINGS_DIR = dir;
  process.env.CHAWO_APPDATA = join(dir, 'app');
  applyLanguage('Russian');
  h.handlers.clear();
  h.listeners.clear();
  h.display = null;
  platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  delete process.env.CHAWO_MEETINGS_DIR;
  delete process.env.CHAWO_APPDATA;
  rmSync(dir, { recursive: true, force: true });
});

const ask = (req: unknown = {}) => new Promise<unknown>((r) => h.display!(req, r));

describe('meetingIpc', () => {
  it('answers getDisplayMedia with loopback only for a meeting start, once', async () => {
    const s = Settings.defaults();
    const sent: string[] = [];
    const enqueued: string[] = [];
    registerMeetingIpc(() => ({ webContents: { send: (ch: string) => sent.push(ch) } }) as never, { get: () => s }, { enqueue: (p) => enqueued.push(p) });
    expect(h.display).not.toBeNull();
    expect(await ask()).toEqual({}); // not armed: refused
    const r = (await h.handlers.get('meeting:start')!({})) as { ok: boolean; system: unknown };
    expect(r.ok).toBe(true);
    expect(r.system).toEqual({ kind: 'loopback' });
    expect(await ask()).toEqual({ video: h.sources[0], audio: 'loopback' });
    expect(await ask()).toEqual({}); // used up
    // pcm: Float32Array within the cap only
    const pcm = h.listeners.get('meeting:pcm')!;
    pcm({}, new Float32Array(32000 * 2).fill(0.1));
    pcm({}, new Float32Array(200000));
    pcm({}, 'junk');
    const st = (await h.handlers.get('meeting:stop')!({})) as { note: string };
    expect(st.note).toMatch(/^Записано 00:00:02, файл добавлен в очередь расшифровки: /);
    expect(enqueued).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.wav'))).toHaveLength(1);
    expect(sent).toContain('meeting:state');
  });

  it('no screen to pair the sound with → refused, the page falls back to the mic', async () => {
    const s = Settings.defaults();
    registerMeetingIpc(() => null, { get: () => s }, { enqueue: () => undefined });
    await h.handlers.get('meeting:start')!({});
    h.sources = [];
    expect(await ask()).toEqual({});
    h.sources = [{ id: 'screen:0', name: 'Screen' }];
    const st = (await h.handlers.get('meeting:systemOpened')!({}, false, 'NotAllowedError')) as { capturing: string };
    expect(st.capturing).toBe('mic');
    await h.handlers.get('meeting:cancel')!({});
  });

  it('macOS: no display-media handler, mic only', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const s = Settings.defaults();
    registerMeetingIpc(() => null, { get: () => s }, { enqueue: () => undefined });
    expect(h.display).toBeNull();
    const r = (await h.handlers.get('meeting:start')!({})) as { system: unknown; state: { systemSupported: boolean } };
    expect(r.system).toEqual({ kind: 'none' });
    expect(r.state.systemSupported).toBe(false);
    await h.handlers.get('meeting:cancel')!({});
  });
});
