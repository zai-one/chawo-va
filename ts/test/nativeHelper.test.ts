import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { helperExePath, HelperError, NativeHelper, type NativeHelperOptions } from '../src/main/native/nativeHelper';

const FAKE = join(__dirname, 'fixtures', 'fakeNativeHelper.cjs');
const helpers: NativeHelper[] = [];
afterEach(() => {
  helpers.splice(0).forEach((h) => h.dispose());
});

function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) resolve();
      else if (Date.now() - t0 > ms) reject(new Error('timeout'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

function make(env: Record<string, string> = {}, over: Partial<NativeHelperOptions> = {}) {
  const procs: ChildProcess[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  let vk = 0xa3;
  const h = new NativeHelper({
    file: process.execPath,
    args: [FAKE],
    spawn: (f, a) => {
      const p = spawn(f, [...a], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
      procs.push(p);
      return p;
    },
    hotkey: () => vk,
    onDown: () => events.push('down'),
    onUp: () => events.push('up'),
    onEscape: () => events.push('esc'),
    onState: () => events.push('state:' + h.state),
    log: (l) => logs.push(l),
    restartDelayMs: 20,
    ...over,
  });
  helpers.push(h);
  const raw = (line: string) => procs[procs.length - 1].stdin!.write(line + '\n');
  return { h, procs, logs, events, raw, setVk: (v: number) => { vk = v; } };
}

describe('NativeHelper', () => {
  it('starts, reports ready with the hook on and passes the hotkey on the command line', async () => {
    const { h, logs, events } = make();
    expect(h.state).toBe('off');
    expect(await h.start()).toBe(true);
    expect(h.state).toBe('ready');
    expect(h.keyWorks).toBe(true);
    expect(events).toEqual(['state:starting', 'state:ready']);
    await until(() => logs.some((l) => l.includes('started hotkey=163')));
  });

  it('a hook that failed to install: helper ready, key not working, reason kept', async () => {
    const { h } = make({ FAKE_HELPER_MODE: 'hookfail' });
    expect(await h.start()).toBe(true);
    expect(h.keyWorks).toBe(false);
    expect(h.hookFailure).toBe('SetWindowsHookEx failed: 5');
  });

  it('inserts text (Cyrillic, emoji, newlines survive) and reports Blocked', async () => {
    const { h, logs } = make();
    await h.start();
    expect(await h.insert('Привет,\nмир 👋', 'Paste', { keep: false, restore: true })).toBe('Done');
    await until(() => logs.some((l) => l.includes('text Привет,\nмир 👋')));
    expect(logs.some((l) => l.includes('got insert 1 Paste 0 1'))).toBe(true);
    expect(await h.insert('BLOCK', 'Type', { keep: true, restore: false })).toBe('Blocked');
    expect(logs.some((l) => l.includes('got insert 2 Type 1 0'))).toBe(true);
    expect(await h.insert('', 'Type', { keep: false, restore: false })).toBe('Done'); // nothing sent
  });

  it('an err line rejects that request; selection, foreground and ping answer', async () => {
    const { h } = make({ FAKE_SEL: 'выделенный текст' });
    await h.start();
    await expect(h.insert('ERR', 'Paste', { keep: false, restore: false })).rejects.toBeInstanceOf(HelperError);
    expect(await h.copySelection()).toBe('выделенный текст');
    expect(await h.foreground()).toBe('notepad');
    expect(await h.ping()).toBe(true);
  });

  it('no selection → null', async () => {
    const { h } = make();
    await h.start();
    expect(await h.copySelection()).toBeNull();
  });

  it('readSelection: the selected text through selread; nothing selected or blank → null', async () => {
    const a = make({ FAKE_SEL: 'выделено в Word' });
    await a.h.start();
    expect(await a.h.readSelection()).toBe('выделено в Word');
    expect(a.logs.some((l) => l.includes('got selread'))).toBe(true);
    const b = make();
    await b.h.start();
    expect(await b.h.readSelection()).toBeNull();
    const c = make({ FAKE_SEL: '   ' });
    await c.h.start();
    expect(await c.h.readSelection()).toBeNull();
  });

  it('readSelection: a hung app → null after the timeout, and no second read piles up behind it', async () => {
    const { h, logs } = make({ FAKE_SEL: 'HANG' });
    await h.start();
    const t0 = Date.now();
    expect(await h.readSelection(150)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await h.readSelection(150)).toBeNull(); // still in flight: not even sent
    expect(logs.filter((l) => l.includes('got selread')).length).toBe(1);
    expect(await h.ping()).toBe(true); // the helper still answers other requests
  });

  it('readSelection: a slow but in-time answer is used; the helper not running → null, never throws', async () => {
    const a = make({ FAKE_SEL: 'медленно', FAKE_SEL_DELAY: '80' });
    await a.h.start();
    expect(await a.h.readSelection(1000)).toBe('медленно');
    const b = make();
    expect(await b.h.readSelection()).toBeNull(); // not started
  });

  it('key down / up / Escape events reach the app; a stray up without down is ignored', async () => {
    const { h, raw, events } = make();
    await h.start();
    raw('emit up');
    raw('emit down');
    raw('emit esc');
    raw('emit up');
    await until(() => events.includes('up'));
    expect(events.filter((e) => !e.startsWith('state:'))).toEqual(['down', 'esc', 'up']);
  });

  it('hotkey and Escape arming are sent once per change and re-sent after a restart', async () => {
    const { h, logs, raw, setVk } = make();
    await h.start();
    h.setHotkey(0xa3); // same as the command line: nothing sent
    setVk(0x2d);
    h.setHotkey(0x2d);
    h.armCancel(true);
    h.armCancel(true);
    await until(() => logs.some((l) => l.includes('got arm 1')));
    expect(logs.filter((l) => l.includes('got hotkey'))).toEqual(['native helper: got hotkey 45']);
    expect(logs.filter((l) => l.includes('got arm'))).toHaveLength(1);
    logs.length = 0;
    raw('die');
    await until(() => logs.some((l) => l.includes('started hotkey=45')));
    await until(() => logs.some((l) => l.includes('got arm 1')));
    expect(h.state).toBe('ready');
  });

  it('a crash while the key is held counts as a release, pending requests fail, then it restarts', async () => {
    const { h, raw, events } = make();
    await h.start();
    raw('emit down');
    await until(() => events.includes('down'));
    const slow = h.insert('SLOW', 'Paste', { keep: false, restore: false });
    raw('die');
    await expect(slow).rejects.toThrow('native helper exited');
    expect(events.filter((e) => e === 'up')).toHaveLength(1);
    await until(() => h.state === 'ready');
    expect(await h.ping()).toBe(true);
  });

  it('keeps crashing → gives up after the restart limit and says failed', async () => {
    const { h, events } = make({ FAKE_HELPER_MODE: 'crash' }, { maxRestartsPerMinute: 2 });
    expect(await h.start()).toBe(false);
    expect(h.state).toBe('failed');
    expect(events[events.length - 1]).toBe('state:failed');
    await expect(h.insert('x', 'Paste', { keep: false, restore: false })).rejects.toThrow('not running');
  });

  it('never says ready → killed after the ready timeout and restarted until the limit', async () => {
    const { h, procs } = make({ FAKE_HELPER_MODE: 'silent' }, { readyTimeoutMs: 100, maxRestartsPerMinute: 1 });
    expect(await h.start()).toBe(false);
    expect(procs).toHaveLength(2);
  });

  it('a request that is never answered times out', async () => {
    const { h } = make();
    await h.start();
    const t0 = Date.now();
    await expect(h.insert('SLOW', 'Paste', { keep: false, restore: false })).rejects.toThrow('did not answer');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5000);
  }, 10000);

  it('dispose closes stdin and the helper exits; no restart', async () => {
    const { h, procs } = make();
    await h.start();
    const exited = new Promise<number | null>((r) => procs[0].once('exit', (c) => r(c)));
    h.dispose();
    expect(await exited).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(procs).toHaveLength(1);
    expect(h.state).toBe('off');
  });

  it('finds the exe in dist/native, the packaged resources or the native build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'chawo-native-'));
    try {
      const dist = join(root, 'dist');
      expect(helperExePath(dist)).toBeNull();
      mkdirSync(join(root, 'native', 'win', 'bin', 'out'), { recursive: true });
      writeFileSync(join(root, 'native', 'win', 'bin', 'out', 'ChawoNative.exe'), 'x');
      expect(helperExePath(dist)).toBe(join(root, 'native', 'win', 'bin', 'out', 'ChawoNative.exe'));
      mkdirSync(join(dist, 'native'), { recursive: true });
      writeFileSync(join(dist, 'native', 'ChawoNative.exe'), 'x');
      expect(helperExePath(dist)).toBe(join(dist, 'native', 'ChawoNative.exe'));
      mkdirSync(join(root, 'res', 'native'), { recursive: true });
      writeFileSync(join(root, 'res', 'native', 'ChawoNative.exe'), 'x');
      expect(helperExePath(dist, join(root, 'res'))).toBe(join(root, 'res', 'native', 'ChawoNative.exe'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
