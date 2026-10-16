// The global hold key wiring in dictationIpc: key down starts the take on the main side and asks the
// window to open the mic, key up asks it to stop (with a fallback if it never does), Escape cancels,
// Escape arming follows the take, and a hotkey change reaches the helper.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  },
  clipboard: { writeText: () => undefined },
  BrowserWindow: class {},
}));

import { applyLanguage } from '@chawo/core/strings';
import * as Settings from '@chawo/engine/settings';
import { registerDictationIpc, type GlobalKeys } from '../src/main/dictationIpc';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-hot-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});
beforeEach(() => handlers.clear());

function setup(keysOn = true) {
  const s = Settings.defaults();
  // Client role: a take starts without a model on disk (only the host address must make sense).
  s.NetworkRole = 'Client';
  s.RemoteHost = '127.0.0.1';
  s.StartHintDismissed = true;
  const sent: { channel: string; payload: unknown }[] = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } };
  const arms: boolean[] = [];
  const hotkeys: number[] = [];
  const keys: GlobalKeys = {
    keyWorks: keysOn,
    state: keysOn ? 'ready' : 'failed',
    hookFailure: keysOn ? '' : 'SetWindowsHookEx failed: 5',
    readSelection: async () => null,
    setHotkey: (vk) => void hotkeys.push(vk),
    armCancel: (on) => void (arms[arms.length - 1] === on || arms.push(on)),
    insert: async () => 'Done',
  };
  const ipc = registerDictationIpc(() => win as never, { get: () => s }, { keys: () => keys });
  const hot = () => sent.filter((x) => x.channel === 'dictation:hot').map((x) => x.payload);
  return { s, ipc, sent, hot, arms, hotkeys };
}

describe('global hold key wiring', () => {
  it('down → take on the main side + "open the mic"; up → "stop"; Escape is armed only during the take', async () => {
    const { ipc, hot, arms } = setup();
    ipc.hotDown();
    expect(ipc.session.phase).toBe('Listening');
    expect(hot()).toEqual([{ kind: 'start', micId: '' }]);
    ipc.hotDown(); // auto-repeat while held: ignored
    expect(hot()).toHaveLength(1);
    expect(arms).toEqual([true]);
    ipc.hotUp();
    expect(hot()[1]).toEqual({ kind: 'stop' });
    // The window answers by stopping the mic and calling dictation:stop.
    await handlers.get('dictation:stop')!();
    expect(ipc.session.phase).toBe('Idle');
    expect(ipc.session.view().status).toBe('Слишком коротко. Держите клавишу, пока говорите.');
    expect(arms).toEqual([true, false]);
  });

  it('a window that never stops the mic: the take is recognized after 3 s anyway', async () => {
    vi.useFakeTimers();
    try {
      const { ipc } = setup();
      ipc.hotDown();
      ipc.hotUp();
      await vi.advanceTimersByTimeAsync(2900);
      expect(ipc.session.phase).toBe('Listening');
      await vi.advanceTimersByTimeAsync(200);
      expect(ipc.session.phase).toBe('Idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new press inside those 3 s is not cut short by the fallback', async () => {
    vi.useFakeTimers();
    try {
      const { ipc } = setup();
      ipc.hotDown();
      ipc.hotUp();
      await handlers.get('dictation:stop')!();
      ipc.hotDown();
      await vi.advanceTimersByTimeAsync(3500);
      expect(ipc.session.phase).toBe('Listening');
      ipc.hotEscape();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape cancels the take and tells the window to drop the mic', () => {
    const { ipc, hot } = setup();
    ipc.hotDown();
    ipc.hotEscape();
    expect(ipc.session.phase).toBe('Idle');
    expect(hot()).toEqual([{ kind: 'start', micId: '' }, { kind: 'end' }]);
    ipc.hotUp(); // the key-up after Escape: nothing more
    expect(hot()).toHaveLength(2);
  });

  it('a press that cannot start (bad host address) does not ask for the mic', () => {
    const { s, ipc, hot } = setup();
    s.RemoteHost = '';
    ipc.hotDown();
    expect(hot()).toEqual([]);
    expect(ipc.session.view().status).toMatch(/адрес хоста/i);
  });

  it('a hotkey change on the page reaches the helper; the page shows the key state', () => {
    const { s, hotkeys } = setup();
    const st = handlers.get('dictation:hotkey')!({}, 0x2d) as { keyNote: string; intro: string };
    expect(s.HotkeyVk).toBe(0x2d);
    expect(hotkeys).toEqual([0x2d]);
    expect(st.keyNote).toBe('');
    expect(st.intro).toMatch(/^Курсор в любой текст/);
  });

  it('a hook that failed: the page says so', () => {
    setup(false);
    const st = handlers.get('dictation:state')!() as { keyNote: string };
    expect(st.keyNote).toContain('SetWindowsHookEx failed: 5');
  });
});
