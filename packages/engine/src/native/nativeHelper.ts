// The Windows native helper process (ChawoNative.exe, sources in ts/native/win): the global hold key,
// Escape while a take runs, inserting the phrase into the focused app, copying a selection and the
// foreground app name. Electron has no low-level keyboard hook or key-up events for global shortcuts,
// so this small .NET Framework 4.8 exe (built into Windows 10/11, nothing to install) does what
// KeyboardHook / TextInserter did in the WPF app, and talks to us over stdin/stdout.
//
// The helper exits when our stdin closes, so it never outlives the app. If it crashes it is restarted
// (at most 3 times a minute); a key held at that moment counts as released so a take never hangs.
// No Electron imports: tests run a Node script that speaks the same protocol.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { encode, LineSplitter, parse, PROTOCOL, type HelperCommand, type HelperEvent, type InsertMode, type InsertResult } from './helperProtocol';

export type { InsertMode, InsertResult } from './helperProtocol';

export interface PhraseClipboard {
  /** Settings.CopyPhraseToClipboard: keep the phrase in the clipboard (and Win+V). */
  keep: boolean;
  /** Settings.RestoreClipboardAfterCopy: then put the previous clipboard back once history has it. */
  restore: boolean;
}

/** The part of NativeHelper the dictation session needs; tests pass fakes. */
export interface TextInserterLike {
  insert(text: string, mode: InsertMode, clip: PhraseClipboard): Promise<InsertResult>;
}

/** SelectionReader.TryGetAsync: the text selected in the focused app, or null. Never rejects. */
export interface SelectionReaderLike {
  readSelection(): Promise<string | null>;
}

/** WPF SelectionReader.Timeout: a hung app must not hold up the take. */
export const SELECTION_TIMEOUT_MS = 1800;

export type SpawnLike = (file: string, args: readonly string[]) => ChildProcess;

export interface NativeHelperOptions {
  /** The exe (or, in tests, `process.execPath`). */
  file: string;
  /** Extra leading args (tests: the fake helper script). */
  args?: string[];
  spawn?: SpawnLike;
  hotkey: () => number;
  onDown?: () => void;
  onUp?: () => void;
  onEscape?: () => void;
  /** Ready or failed changed (the page says whether the key works). */
  onState?: () => void;
  log?: (line: string) => void;
  /** Milliseconds before a restart after a crash (tests: small). */
  restartDelayMs?: number;
  maxRestartsPerMinute?: number;
  readyTimeoutMs?: number;
}

export type HelperState = 'off' | 'starting' | 'ready' | 'failed';

interface Pending {
  resolve: (e: HelperEvent) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class HelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperError';
  }
}

/** Where the built exe lives: in the packaged resources, or the native build output next to the app (development). */
export function helperExePath(appRoot: string, resourcesPath?: string): string | null {
  const candidates = [
    resourcesPath ? join(resourcesPath, 'native', 'ChawoNative.exe') : '',
    join(appRoot, 'native', 'win', 'bin', 'out', 'ChawoNative.exe'),
  ].filter((p) => p.length > 0);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export class NativeHelper implements TextInserterLike, SelectionReaderLike {
  private readonly o: NativeHelperOptions;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private _state: HelperState = 'off';
  private _hookOk = false;
  private hookError = '';
  private held = false;
  private armed = false;
  private sentVk = -1;
  private disposed = false;
  private restarts: number[] = [];
  private readyWaiters: Array<(ok: boolean) => void> = [];
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(o: NativeHelperOptions) {
    this.o = o;
  }

  get state(): HelperState {
    return this._state;
  }

  /** The hold key works: helper up and the keyboard hook installed. */
  get keyWorks(): boolean {
    return this._state === 'ready' && this._hookOk;
  }

  get hookFailure(): string {
    return this.hookError;
  }

  /** Starts the helper; resolves true once it said ready. */
  start(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this._state === 'ready') return Promise.resolve(true);
    const wait = new Promise<boolean>((resolve) => this.readyWaiters.push(resolve));
    if (this._state !== 'starting') this.launch();
    return wait;
  }

  private setState(s: HelperState): void {
    if (this._state === s) return;
    this._state = s;
    this.o.onState?.();
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private launch(): void {
    this.setState('starting');
    this._hookOk = false;
    const vk = this.o.hotkey();
    const args = [...(this.o.args ?? []), '--hotkey', String(vk)];
    let proc: ChildProcess;
    try {
      proc = (this.o.spawn ?? ((f, a) => nodeSpawn(f, [...a], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })))(this.o.file, args);
    } catch (e) {
      this.log(`native helper spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      this.fail();
      return;
    }
    this.proc = proc;
    this.sentVk = vk;
    const readyTimer = setTimeout(() => {
      if (this.proc === proc && this._state === 'starting') {
        this.log('native helper did not say ready');
        proc.kill();
      }
    }, this.o.readyTimeoutMs ?? 15000);
    readyTimer.unref?.();
    const split = new LineSplitter();
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      for (const line of split.push(chunk)) {
        const ev = parse(line);
        if (ev) this.onEvent(ev, proc, readyTimer);
      }
    });
    proc.stdin?.on('error', () => undefined); // EPIPE after a crash: the exit handler deals with it
    proc.on('error', (e) => this.log(`native helper: ${e.message}`));
    proc.on('exit', (code, signal) => {
      clearTimeout(readyTimer);
      if (this.proc !== proc) return;
      this.proc = null;
      this.onExit(code, signal);
    });
  }

  private onEvent(ev: HelperEvent, proc: ChildProcess, readyTimer: NodeJS.Timeout): void {
    if (this.proc !== proc) return;
    switch (ev.kind) {
      case 'ready': {
        clearTimeout(readyTimer);
        if (ev.protocol !== PROTOCOL) this.log(`native helper protocol ${ev.protocol}, expected ${PROTOCOL}`);
        if (!this.hookError) this._hookOk = true;
        // Re-send what the app set while the helper was (re)starting.
        const vk = this.o.hotkey();
        if (vk !== this.sentVk) this.send({ kind: 'hotkey', vk });
        if (this.armed) this.send({ kind: 'arm', on: true });
        this.setState('ready');
        this.log(`native helper ready, hook ${this._hookOk ? 'on' : 'off'}`);
        const w = this.readyWaiters.splice(0);
        w.forEach((r) => r(true));
        break;
      }
      case 'hookfail':
        this.hookError = ev.reason;
        this._hookOk = false;
        this.log(`native helper hook failed: ${ev.reason}`);
        break;
      case 'down':
        this.held = true;
        this.o.onDown?.();
        break;
      case 'up':
        if (!this.held) break;
        this.held = false;
        this.o.onUp?.();
        break;
      case 'esc':
        this.o.onEscape?.();
        break;
      case 'log':
        this.log(`native helper: ${ev.text}`);
        break;
      default: {
        const p = this.pending.get(ev.id);
        if (!p) break;
        this.pending.delete(ev.id);
        clearTimeout(p.timer);
        if (ev.kind === 'err') p.reject(new HelperError(`native helper: ${ev.reason}`));
        else p.resolve(ev);
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this._hookOk = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HelperError('native helper exited'));
      this.pending.delete(id);
    }
    // A key held when the helper died will never send its key-up: end the take now.
    if (this.held) {
      this.held = false;
      this.o.onUp?.();
    }
    if (this.disposed) {
      this.setState('off');
      return;
    }
    this.log(`native helper exited (code ${code ?? '-'}, ${signal ?? 'no signal'})`);
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    if (this.restarts.length >= (this.o.maxRestartsPerMinute ?? 3)) {
      this.log('native helper keeps exiting; the hold key is off until the app restarts');
      this.fail();
      return;
    }
    this.restarts.push(now);
    this.setState('starting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.disposed) this.launch();
    }, this.o.restartDelayMs ?? 1000);
    this.restartTimer.unref?.();
  }

  private fail(): void {
    this.setState('failed');
    const w = this.readyWaiters.splice(0);
    w.forEach((r) => r(false));
  }

  private send(c: HelperCommand): boolean {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(encode(c));
    return true;
  }

  private request(make: (id: number) => HelperCommand, timeoutMs: number): Promise<HelperEvent> {
    if (this._state !== 'ready') return Promise.reject(new HelperError('native helper is not running'));
    const id = this.nextId++;
    return new Promise<HelperEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError('native helper did not answer'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send(make(id))) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HelperError('native helper is not running'));
      }
    });
  }

  setHotkey(vk: number): void {
    if (vk === this.sentVk) return;
    if (this.send({ kind: 'hotkey', vk })) this.sentVk = vk;
  }

  /** While a take listens or recognizes, Escape is swallowed and cancels it (KeyboardHook.ArmCancel). */
  armCancel(on: boolean): void {
    if (on === this.armed) return;
    this.armed = on;
    this.send({ kind: 'arm', on });
  }

  /** TextInserter.Insert. Rejects with HelperError when the helper is gone. */
  async insert(text: string, mode: InsertMode, clip: PhraseClipboard): Promise<InsertResult> {
    if (text.length === 0) return 'Done';
    // Typing goes in batches of 8 characters with an 8 ms pause; a restore before us can take 1.2 s.
    const ev = await this.request((id) => ({ kind: 'insert', id, mode, keep: clip.keep, restore: clip.restore, text }), 5000 + text.length * 3);
    return ev.kind === 'ok' ? ev.result : 'Blocked';
  }

  /** TextInserter.CopySelection: Ctrl+C, read, previous clipboard back. Null when nothing is selected. */
  async copySelection(): Promise<string | null> {
    const ev = await this.request((id) => ({ kind: 'copysel', id }), 4000);
    return ev.kind === 'sel' ? ev.text : null;
  }

  private selectionInFlight: Promise<HelperEvent> | null = null;

  /**
   * SelectionReader.TryGetAsync: UI Automation in the helper, Ctrl+C (clipboard put back) only for apps
   * that do not expose their text; terminals and spreadsheets are skipped. Null when nothing is selected,
   * the helper is gone, a previous read still hangs, or it takes longer than SELECTION_TIMEOUT_MS.
   */
  async readSelection(timeoutMs = SELECTION_TIMEOUT_MS): Promise<string | null> {
    if (this.selectionInFlight) return null;
    let req: Promise<HelperEvent>;
    try {
      req = this.request((id) => ({ kind: 'selread', id }), 5000);
    } catch {
      return null;
    }
    this.selectionInFlight = req;
    void req.catch(() => undefined).finally(() => {
      if (this.selectionInFlight === req) this.selectionInFlight = null;
    });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        this.o.log?.('selection: timed out');
        resolve(null);
      }, timeoutMs);
    });
    try {
      const ev = await Promise.race([req, late]);
      return ev && ev.kind === 'sel' && ev.text !== null && ev.text.trim().length > 0 ? ev.text : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Process name of the foreground window (for per-app modes), '' when unknown. */
  async foreground(): Promise<string> {
    const ev = await this.request((id) => ({ kind: 'fg', id }), 3000);
    return ev.kind === 'fg' ? ev.process : '';
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.request((id) => ({ kind: 'ping', id }), 3000)).kind === 'pong';
    } catch {
      return false;
    }
  }

  /** Closes stdin (the helper exits on EOF) and kills it if it lingers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.proc;
    if (!proc) {
      this.setState('off');
      return;
    }
    try {
      proc.stdin?.end(encode({ kind: 'quit' }));
    } catch {
      /* already gone */
    }
    const killer = setTimeout(() => proc.kill(), 1500);
    killer.unref?.();
    proc.once('exit', () => clearTimeout(killer));
  }
}
