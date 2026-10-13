// Electron main process. Dark theme only, no telemetry, nothing leaves the PC unless the user
// turns on a network feature. This is the shell the WPF features get ported into, piece by piece.

import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, session } from 'electron';
import { join } from 'node:path';
import { registerFileIpc } from './fileIpc';
import { registerSpeechIpc } from './speechIpc';
import { registerDictionaryIpc } from './dictionaryIpc';
import { registerBrainIpc } from './brainIpc';
import * as LocalBrain from './brain/localBrain';
import { registerDictationIpc } from './dictationIpc';
import { registerNetworkIpc } from './networkIpc';
import { registerHistoryIpc } from './historyIpc';
import { registerSalesIpc } from './salesIpc';
import { makeHermesTranscribe } from './network/hermesTranscribe';
import * as KeepAwake from './network/keepAwake';
import { OverlayWindow } from './overlay/overlayWindow';
import { chromiumDecode, disposeChromiumDecoder } from './chromiumDecoder';
import { setPlatformDecoder } from './file';
import { filePauses, getVadRuntime } from './vad/vadModel';
import * as Settings from './settings';
import * as Log from './log';
import { helperExePath, NativeHelper } from './native/nativeHelper';
import { applyLanguage } from '../core/strings';
import { trayStateFor, trayTooltip, type CuePhase, type TrayState } from '../core/cues';
import { DOT_RECOGNIZING, DOT_RECORDING, paintDot } from '../core/trayDot';

const APP_NAME = 'Chawo Voice Assistant';
const BG = '#14161a';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: Settings.SettingsData = Settings.defaults();
let releaseDictation: (() => Promise<void>) | null = null;
let destroyOverlay: (() => void) | null = null;
let destroySalesCard: (() => void) | null = null;
let disposeNetwork: (() => Promise<void>) | null = null;
let nativeHelper: NativeHelper | null = null;

function iconPath(set: 'app' | 'tray-dark' | 'tray-light', size: number): string {
  return join(__dirname, '..', 'assets', 'iconset', set, `icon_${size}.png`);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: BG,
    icon: iconPath('app', 256),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The global hold key records while the window sits hidden in the tray: keep its timers awake.
      backgroundThrottling: false,
    },
  });
  w.removeMenu();
  w.once('ready-to-show', () => w.show());
  w.on('close', (e) => {
    // Like the WPF app: closing the window keeps the tray icon and hotkeys alive.
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  void w.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  return w;
}

function trayBase(): Electron.NativeImage {
  // Tray glyph follows the OS taskbar shade (as in WPF 1.17.1); the app UI itself is always dark.
  const set = nativeTheme.shouldUseDarkColors ? 'tray-dark' : 'tray-light';
  return nativeImage.createFromPath(iconPath(set, 32));
}

const trayImages = new Map<TrayState, Electron.NativeImage>();
function trayImage(state: TrayState): Electron.NativeImage {
  const hit = trayImages.get(state);
  if (hit) return hit;
  const base = trayBase();
  let img = base;
  const { width, height } = base.getSize();
  if (state !== 'idle' && width > 0 && height > 0) {
    const dotted = paintDot(base.toBitmap(), width, height, state === 'recording' ? DOT_RECORDING : DOT_RECOGNIZING);
    img = nativeImage.createFromBitmap(Buffer.from(dotted), { width, height });
  }
  trayImages.set(state, img);
  return img;
}

let trayState: TrayState = 'idle';
/** The take phase on the tray: a red dot while recording, amber while recognizing, plain otherwise. */
function showTrayPhase(phase: CuePhase): void {
  const next = trayStateFor(phase);
  if (!tray || next === trayState) return;
  trayState = next;
  tray.setImage(trayImage(next));
  tray.setToolTip(trayTooltip(next, `${APP_NAME} ${app.getVersion()}`));
}

function createTray(): Tray {
  const t = new Tray(trayImage('idle'));
  t.setToolTip(`${APP_NAME} ${app.getVersion()}`);
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Выход', click: () => quit() },
    ]),
  );
  t.on('click', () => showWindow());
  return t;
}

function showWindow(): void {
  if (!win) win = createWindow();
  win.show();
  win.focus();
}

let quitting = false;
function quit(): void {
  quitting = true;
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    // Local by default: block any renderer request that is not a bundled file.
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      cb({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('devtools://') });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
    settings = Settings.load();
    applyLanguage(settings.Language, app.getLocale());
    // MP3/M4A/FLAC/… decode in a hidden sandboxed renderer; ffmpeg stays an optional fallback.
    setPlatformDecoder(chromiumDecode);
    const files = registerFileIpc(() => win, { get: () => settings });
    // The floating pill: created lazily on the first take with «Показывать плашку» on.
    const overlay = new OverlayWindow({ get: () => settings, save: Settings.save });
    destroyOverlay = () => overlay.destroy();
    // «История»: finished takes (text only) in a local file, as long as the user chose to keep them.
    const history = registerHistoryIpc(() => win, { get: () => settings });
    // «Продажи»: catalog page + the always-on-top card fed by live drafts (only in Sales mode).
    const sales = registerSalesIpc(() => win, { get: () => settings });
    destroySalesCard = () => sales.card.destroy();
    const dictation = registerDictationIpc(() => win, { get: () => settings }, {
      overlay,
      phase: showTrayPhase,
      record: (take) => history.record(take),
      keys: () => nativeHelper,
      sales: (text) => sales.session.show(text),
      // Leaving Sales mode closes the stand-in call and hides the card (App.ApplySettings).
      changed: () => sales.session.settingsChanged(),
    });
    // Windows: the global hold key and inserting into other apps (KeyboardHook / TextInserter) live in a
    // small helper exe. Elsewhere the in-window hold button is the way to dictate for now.
    if (process.platform === 'win32') {
      const exe = helperExePath(join(__dirname, '..'), process.resourcesPath);
      if (exe) {
        nativeHelper = new NativeHelper({
          file: exe,
          hotkey: () => settings.HotkeyVk,
          onDown: () => dictation.hotDown(),
          onUp: () => dictation.hotUp(),
          onEscape: () => dictation.hotEscape(),
          onState: () => dictation.keysChanged(),
          log: (line) => Log.write(line),
        });
        void nativeHelper.start();
      } else Log.write('native helper: ChawoNative.exe not found, hold key off');
    }
    releaseDictation = () => dictation.session.release();
    // Hermes (local HTTP transcription host) reuses the dictation recognizer; opens it from disk if
    // needed, never downloads. Listens only while this PC is the host.
    const hermesTranscribe = makeHermesTranscribe({
      current: () => dictation.session.current(),
      load: () => dictation.session.ensureLoaded(),
      modelName: () => settings.SpeechModel,
      pauses: (x) => filePauses(settings, x, 16000),
    });
    const network = registerNetworkIpc(() => win, { get: () => settings }, {
      transcribe: hermesTranscribe,
      changed: () => dictation.session.speechChanged(),
    });
    disposeNetwork = () => network.dispose();
    registerSpeechIpc(() => win, { get: () => settings }, {
      busy: () => files.busy() || dictation.session.isBusy || hermesTranscribe.inFlight() > 0,
      changed: () => dictation.session.speechChanged(),
      session: () => dictation.session.sessionLine(),
      beforeDelete: () => dictation.session.release(),
    });
    registerDictionaryIpc({ get: () => settings });
    registerBrainIpc(() => win, { get: () => settings });
    win = createWindow();
    tray = createTray();
    nativeTheme.on('updated', () => {
      trayImages.clear();
      tray?.setImage(trayImage(trayState));
    });
    void network.start();
  });
  app.on('window-all-closed', () => {
    /* stay in tray */
  });
  app.on('before-quit', () => {
    quitting = true;
    LocalBrain.stop();
    void disposeNetwork?.();
    KeepAwake.allowSleep();
    disposeChromiumDecoder();
    nativeHelper?.dispose();
    void releaseDictation?.();
    void getVadRuntime().release();
    destroyOverlay?.();
    destroySalesCard?.();
    tray?.destroy();
  });
}
