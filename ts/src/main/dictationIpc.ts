// IPC for the «Диктовка» page and the in-window hold-to-talk take. The renderer captures the mic
// (getUserMedia → AudioWorklet, 16 kHz mono float) and streams ~40 ms chunks here; the main process
// owns the take buffer, the recognizer, the settings writes and the clipboard. Chunks use
// ipcRenderer.send on one channel, so they arrive before the stop that follows them.

import { BrowserWindow, clipboard, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { wavBytes } from '../core/audio';
import { HOTKEY_CHOICES } from './settings';
import * as Settings from './settings';
import type { SettingsData } from './settings';
import { lastTakePath } from './paths';
import { DictationController, type MicDevice } from './dictation/dictationPage';
import { DictationSession, type TakeRecord } from './dictation/dictationSession';
import type { OverlayWindow } from './overlay/overlayWindow';
import type { ForegroundApp } from '../core/appRules';
import { detectForeground } from './foreground/foregroundApp';
import { CueTracker, cueTones, type CuePhase } from '../core/cues';
import type { GlobalKeyState } from './dictation/dictationPage';
import type { SelectionReaderLike, TextInserterLike } from './native/nativeHelper';
import * as Log from './log';
import { WakeListener, finishWakeTake } from './dictation/wakeListener';

/** The part of NativeHelper the dictation IPC uses (tests: a fake). */
export interface GlobalKeys extends TextInserterLike, SelectionReaderLike {
  readonly keyWorks: boolean;
  readonly state: 'off' | 'starting' | 'ready' | 'failed';
  readonly hookFailure: string;
  setHotkey(vk: number): void;
  armCancel(on: boolean): void;
}

/** If the window never stops the mic after a key-up (reloaded, hung), recognize what we have. */
const HOT_STOP_FALLBACK_MS = 3000;

/** One chunk is ~640 samples; anything far bigger is not from our worklet. */
const MAX_CHUNK = 16000;
const LEVEL_MS = 50;

export interface DictationIpc {
  controller: DictationController;
  session: DictationSession;
  /** Global hold key events from the Windows helper. */
  hotDown: () => void;
  hotUp: () => void;
  hotEscape: () => void;
  /** The helper's state changed: redraw the page. */
  keysChanged: () => void;
  /** «Начинать запись по слову «Чаво»». */
  wake: WakeListener;
}

export function registerDictationIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  opts: { changed?: () => void; overlay?: OverlayWindow; sales?: (transcript: string) => void; keys?: () => GlobalKeys | null; record?: (take: TakeRecord) => void; phase?: (phase: CuePhase) => void; onApp?: (app: ForegroundApp | null, ruleIndex: number | null) => void; idleBusy?: () => boolean } = {},
): DictationIpc {
  const send = (channel: string, payload: unknown) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  // Sound cues go to the main window's page (Web Audio there); the tray follows the same phase.
  const cues = new CueTracker(() => settings.get().SoundCues, (kind) => send('dictation:cue', { kind, tones: cueTones(kind) }));
  let lastPhase: CuePhase | null = null;
  const observePhase = () => {
    const p = session.phase;
    cues.observe(p);
    if (p !== lastPhase) {
      lastPhase = p;
      opts.phase?.(p);
    }
  };
  let pushTimer: NodeJS.Timeout | null = null;
  // The word's microphone lives in the window: tell it whether to keep one open, and on which device.
  let wakeSent = '';
  const wakeWant = () => ({ on: wake.wanted(), micId: ctl.micDeviceId() });
  const syncWake = () => {
    const want = wakeWant();
    const key = JSON.stringify(want);
    if (key === wakeSent) return;
    wakeSent = key;
    if (!want.on) finishWakeTake(wake, session);
    send('wake:listen', want);
  };
  const push = () => {
    observePhase();
    syncWake();
    syncLevelTimer();
    // Escape belongs to us only while a take listens or recognizes (KeyboardHook.ArmCancel).
    opts.keys?.()?.armCancel(session.isBusy);
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      send('dictation:state', ctl.state());
    }, 40);
  };

  // The VU meter: the page reads the take's level like the WPF pill polls Recorder.Level.
  let levelTimer: NodeJS.Timeout | null = null;
  const syncLevelTimer = () => {
    const listening = session.phase === 'Listening';
    if (listening && !levelTimer) {
      levelTimer = setInterval(() => {
        // Recorder.Level is "since the last read": read once, share with the page meter and the pill.
        const v = session.level();
        send('dictation:level', v);
        opts.overlay?.level(v);
      }, LEVEL_MS);
    }
    else if (!listening && levelTimer) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
  };

  const session: DictationSession = new DictationSession({
    settings: settings.get,
    push,
    copy: (text) => clipboard.writeText(text),
    writeWav: (samples, rate) => {
      const path = lastTakePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, wavBytes(samples, rate));
    },
    micName: () => ctl.micName(),
    overlay: opts.overlay,
    foreground: () => detectForeground(),
    onApp: opts.onApp,
    record: opts.record,
    sales: opts.sales,
    idleBusy: opts.idleBusy,
    inserter: () => {
      const k = opts.keys?.() ?? null;
      return k && k.state === 'ready' ? k : null;
    },
    selection: () => {
      const k = opts.keys?.() ?? null;
      return k && k.state === 'ready' ? k : null;
    },
  });
  const ctl: DictationController = new DictationController({
    settings: settings.get,
    save: Settings.save,
    push,
    take: () => session.view(),
    changed: opts.changed,
    globalKey: (): GlobalKeyState => {
      const k = opts.keys?.() ?? null;
      if (!k) return { kind: 'none' };
      if (k.keyWorks) return { kind: 'on' };
      if (k.state === 'failed' || (k.state === 'ready' && k.hookFailure)) {
        return { kind: 'failed', reason: k.hookFailure || 'ChawoNative.exe' };
      }
      return { kind: 'starting' };
    },
  });

  const wake: WakeListener = new WakeListener(session, settings.get);

  const state = () => ctl.state();
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  ipcMain.handle('dictation:state', () => {
    // Page shown: open the recognizer in the background so the first take is quick.
    void session.ensureLoaded();
    return state();
  });
  ipcMain.handle('dictation:mode', (_e, v: unknown) => {
    if (v === 'Dictation' || v === 'Sales') ctl.setMode(v);
    return state();
  });
  ipcMain.handle('dictation:hotkey', (_e, v: unknown) => {
    if (typeof v === 'number' && HOTKEY_CHOICES.some((c) => c.vk === v)) ctl.setHotkey(v);
    opts.keys?.()?.setHotkey(settings.get().HotkeyVk);
    return state();
  });
  ipcMain.handle('dictation:insert', (_e, v: unknown) => {
    if (v === 'Type' || v === 'Paste') ctl.setInsertMode(v);
    return state();
  });
  ipcMain.handle('dictation:overlay', (_e, v: unknown) => {
    if (typeof v === 'boolean') ctl.setShowOverlay(v);
    if (!settings.get().ShowOverlay) opts.overlay?.hideNow();
    return state();
  });
  ipcMain.handle('dictation:cues', (_e, v: unknown) => {
    if (typeof v === 'boolean') ctl.setSoundCues(v);
    return state();
  });
  ipcMain.handle('dictation:wake', (_e, v: unknown) => {
    if (typeof v === 'boolean') ctl.setWakeWord(v);
    // The word needs the model at hand: open it now so the first «Чаво» is answered quickly.
    if (wake.wanted()) void session.ensureLoaded();
    push();
    return state();
  });
  ipcMain.handle('wake:want', () => {
    wakeSent = JSON.stringify(wakeWant());
    if (wake.wanted()) void session.ensureLoaded();
    return wakeWant();
  });
  ipcMain.on('wake:pcm', (_e, chunk: unknown) => wake.push(chunk));
  ipcMain.handle('wake:micFailed', (_e, name: unknown, message: unknown) => {
    Log.write(`wake mic failed: ${str(name).slice(0, 64)}: ${str(message).slice(0, 300)}`);
    return state();
  });
  ipcMain.handle('dictation:mic', (_e, v: unknown) => {
    ctl.setMicrophone(str(v));
    return state();
  });
  ipcMain.handle('dictation:devices', (_e, list: unknown, defaultName: unknown) => {
    const devices: MicDevice[] = Array.isArray(list)
      ? list.slice(0, 64).map((d) => ({ id: str((d as MicDevice)?.id).slice(0, 512), label: str((d as MicDevice)?.label).slice(0, 256) }))
      : [];
    ctl.setDevices(devices, str(defaultName).slice(0, 256));
    return state();
  });
  ipcMain.handle('dictation:dismissStart', () => {
    ctl.dismissStartCard();
    return state();
  });
  ipcMain.handle('dictation:start', () => {
    const r = session.startTake();
    return { ok: r.ok, micId: ctl.micDeviceId(), state: state() };
  });
  ipcMain.on('dictation:pcm', (_e, chunk: unknown) => {
    if (chunk instanceof Float32Array && chunk.length <= MAX_CHUNK) session.appendPcm(chunk);
  });
  ipcMain.handle('dictation:stop', async () => {
    await session.stopTake();
    return state();
  });
  ipcMain.handle('dictation:cancel', () => {
    session.cancelTake();
    return state();
  });
  ipcMain.handle('dictation:micFailed', (_e, name: unknown, message: unknown) => {
    session.micFailed(str(name).slice(0, 64), str(message).slice(0, 300));
    return state();
  });

  // ── the global hold key (HandlePressAsync / HandleReleaseAsync / RequestStop from KeyboardHook) ──
  let hotTake = false;
  let hotTimer: NodeJS.Timeout | null = null;
  const hotDown = () => {
    if (hotTake) return;
    if (hotTimer) {
      clearTimeout(hotTimer);
      hotTimer = null;
    }
    const w = getWindow();
    if (!w || w.isDestroyed()) return;
    const r = session.startTake('hotkey');
    if (!r.ok) return; // the pill / page already say why (no model, busy, bad host address)
    hotTake = true;
    send('dictation:hot', { kind: 'start', micId: ctl.micDeviceId() });
  };
  const hotUp = () => {
    if (!hotTake) return;
    hotTake = false;
    send('dictation:hot', { kind: 'stop' });
    if (hotTimer) clearTimeout(hotTimer);
    hotTimer = setTimeout(() => {
      hotTimer = null;
      if (!hotTake && session.phase === 'Listening') {
        Log.write('hot take: the window did not stop the mic, recognizing what arrived');
        void session.stopTake();
      }
    }, HOT_STOP_FALLBACK_MS);
    hotTimer.unref?.();
  };
  const hotEscape = () => {
    hotTake = false;
    session.cancelTake();
    send('dictation:hot', { kind: 'end' });
  };
  return { controller: ctl, session, hotDown, hotUp, hotEscape, keysChanged: push, wake };
}
