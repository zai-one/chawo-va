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
import { DictationSession } from './dictation/dictationSession';
import type { OverlayWindow } from './overlay/overlayWindow';
import { CueTracker, cueTones, type CuePhase } from '../core/cues';

/** One chunk is ~640 samples; anything far bigger is not from our worklet. */
const MAX_CHUNK = 16000;
const LEVEL_MS = 50;

export interface DictationIpc {
  controller: DictationController;
  session: DictationSession;
}

export function registerDictationIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  opts: { changed?: () => void; overlay?: OverlayWindow; phase?: (phase: CuePhase) => void } = {},
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
  const push = () => {
    observePhase();
    syncLevelTimer();
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
  });
  const ctl: DictationController = new DictationController({
    settings: settings.get,
    save: Settings.save,
    push,
    take: () => session.view(),
    changed: opts.changed,
  });

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
  return { controller: ctl, session };
}
