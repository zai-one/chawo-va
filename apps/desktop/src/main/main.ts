// Electron main process. Dark theme only, no telemetry, nothing leaves the PC unless the user
// turns on a network feature. This is the shell the WPF features get ported into, piece by piece.

import '@chawo/core/ortPrivacy';
import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, safeStorage, session } from 'electron';
import { handleMediaProtocol } from './localMediaProtocol';
import { handleAppProtocol, registerSchemes } from './appProtocol';
import * as AppPaths from './appPaths';
import { registerFileIpc } from './fileIpc';
import { registerSpeechIpc } from './speechIpc';
import { registerCleanupIpc } from './cleanupIpc';
import { registerDictionaryIpc } from './dictionaryIpc';
import { registerCrmIpc } from './crmIpc';
import { registerBrainIpc } from './brainIpc';
import type { LastApp } from '@chawo/engine/brain/brainPage';
import * as LocalBrain from '@chawo/engine/brain/localBrain';
import { registerDictationIpc } from './dictationIpc';
import { registerMcpIpc } from './mcpIpc';
import { registerNetworkIpc } from './networkIpc';
import { registerMeetingIpc } from './meetingIpc';
import { registerHistoryIpc } from './historyIpc';
import { registerSalesIpc } from './salesIpc';
import { registerVoiceIpc } from './voiceIpc';
import { makeHermesTranscribe } from '@chawo/engine/network/hermesTranscribe';
import * as KeepAwake from './network/keepAwake';
import { OverlayWindow } from './overlay/overlayWindow';
import { chromiumDecode, disposeChromiumDecoder } from './chromiumDecoder';
import { setPlatformDecoder } from '@chawo/engine/file/index';
import { filePauses, getVadRuntime } from '@chawo/engine/vad/vadModel';
import * as Settings from '@chawo/engine/settings';
import * as Log from '@chawo/engine/log';
import { helperExePath, NativeHelper } from '@chawo/engine/native/nativeHelper';
import { applyLanguage } from '@chawo/core/strings';
import { trayStateFor, trayTooltip, type CuePhase, type TrayState } from '@chawo/core/cues';
import { DOT_RECOGNIZING, DOT_RECORDING, paintDot } from '@chawo/core/trayDot';
import { emit } from './ipc';

// Entry of the build (out/main/main.js): the only module that knows where the app root is.
AppPaths.init(__dirname);

const APP_NAME = 'Chawo Voice Assistant';
const BG = '#14161a';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: Settings.SettingsData = Settings.defaults();
let releaseDictation: (() => Promise<void>) | null = null;
let destroyOverlay: (() => void) | null = null;
let destroySalesCard: (() => void) | null = null;
let disposeNetwork: (() => Promise<void>) | null = null;
let disposeMeeting: (() => void) | null = null;
let nativeHelper: NativeHelper | null = null;
let disposeVoice: (() => void) | null = null;

function iconPath(set: 'app' | 'tray-dark' | 'tray-light', size: number): string {
  return AppPaths.resource('iconset', set, `icon_${size}.png`);
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
      preload: AppPaths.preload('preload'),
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
  void AppPaths.loadPage(w, 'index');
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

/** Shows the window on a page (once the page has loaded, if the window was just made). */
function showPage(page: string): void {
  showWindow();
  const w = win;
  if (!w) return;
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => emit(w, 'app:page', page));
  else emit(w, 'app:page', page);
}

let quitting = false;
function quit(): void {
  quitting = true;
  app.quit();
}

registerSchemes();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    handleAppProtocol(AppPaths.rendererDir());
    handleMediaProtocol();
    // Local by default: block any renderer request that is not a bundled page or an allowed local audio.
    // `electron-vite dev` serves the pages from localhost; the built app never sets that.
    const dev = AppPaths.devOrigin();
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const local = details.url.startsWith(`${AppPaths.APP_SCHEME}://`) || details.url.startsWith('devtools://') || details.url.startsWith('chawo-media://');
      cb({ cancel: !local && !(dev !== null && (details.url.startsWith(dev + '/') || details.url.startsWith(dev.replace(/^http/, 'ws') + '/'))) });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
    // Secrets in settings.json are sealed with the OS store (DPAPI / Keychain / libsecret) via safeStorage.
    Settings.setProtectHooks(
      (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : ''),
      (stored) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
        return safeStorage.decryptString(Buffer.from(stored, 'base64'));
      },
    );
    settings = Settings.load();
    applyLanguage(settings.Language, app.getLocale());
    // MP3/M4A/FLAC/… decode in a hidden sandboxed renderer; ffmpeg stays an optional fallback.
    setPlatformDecoder(chromiumDecode);
    const files = registerFileIpc(() => win, { get: () => settings });
    // «Запись встречи»: mic + computer sound into a WAV that then goes through the file queue.
    const meeting = registerMeetingIpc(() => win, { get: () => settings }, files, { showWindow });
    disposeMeeting = () => meeting.dispose();
    // The floating pill: created lazily on the first take with «Показывать плашку» on.
    const overlay = new OverlayWindow({ get: () => settings, save: Settings.save });
    destroyOverlay = () => overlay.destroy();
    // Per-app modes: the «Мозг» page shows which program the last take saw (memory only, never saved).
    let lastApp: LastApp | null = null;
    // «История»: finished takes (text only) in a local file, as long as the user chose to keep them.
    const history = registerHistoryIpc(() => win, { get: () => settings });
    // «Продажи»: catalog page + the always-on-top card fed by live drafts (only in Sales mode).
    const sales = registerSalesIpc(() => win, { get: () => settings });
    destroySalesCard = () => sales.card.destroy();
    const dictation = registerDictationIpc(() => win, { get: () => settings }, {
      overlay,
      onApp: (app, ruleIndex) => {
        lastApp = { app, ruleIndex };
        emit(win, 'brain:state', brain.state());
      },
      phase: showTrayPhase,
      record: (take) => history.record(take),
      keys: () => nativeHelper,
      sales: (text) => sales.session.show(text),
      // Leaving Sales mode closes the stand-in call and hides the card (App.ApplySettings).
      changed: () => sales.session.settingsChanged(),
      // A Hermes request on this PC's recognizer keeps it loaded.
      idleBusy: () => hermesTranscribe.inFlight() > 0,
    });
    // The local Brain follows the same «Выгружать модели при простое» delay.
    LocalBrain.setIdleSource(() => settings.IdleUnloadMinutes * 60_000);
    // «Голос»: reading text aloud through the speech service the user picked (off until then).
    const voice = registerVoiceIpc(() => win, { get: () => settings }, { helper: () => nativeHelper, showPage });
    disposeVoice = () => voice.dispose();
    // Windows: the global hold key and inserting into other apps (KeyboardHook / TextInserter) live in a
    // small helper exe. Elsewhere the in-window hold button is the way to dictate for now.
    if (process.platform === 'win32') {
      const exe = helperExePath(AppPaths.root(), process.resourcesPath);
      if (exe) {
        nativeHelper = new NativeHelper({
          file: exe,
          hotkey: () => settings.HotkeyVk,
          onDown: () => dictation.hotDown(),
          onUp: () => dictation.hotUp(),
          onEscape: () => dictation.hotEscape(),
          onState: () => dictation.keysChanged(),
          onTts: () => voice.speakSelection(),
          onMouseUp: () => voice.mouseUp(),
          log: (line) => Log.write(line),
        });
        voice.applyHelper();
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
      used: () => dictation.session.touchIdle(),
    });
    const network = registerNetworkIpc(() => win, { get: () => settings }, {
      transcribe: hermesTranscribe,
      changed: () => dictation.session.speechChanged(),
    });
    disposeNetwork = () => network.dispose();
    const speech = registerSpeechIpc(() => win, { get: () => settings }, {
      busy: () => files.busy() || dictation.session.isBusy || hermesTranscribe.inFlight() > 0,
      changed: () => dictation.session.speechChanged(),
      session: () => dictation.session.sessionLine(),
      beforeDelete: () => dictation.session.release(),
      idleChanged: () => {
        dictation.session.touchIdle();
        LocalBrain.idleChanged();
      },
    });
    registerCleanupIpc(() => win, { get: () => settings }, {
      busy: () => files.busy() || dictation.session.isBusy || hermesTranscribe.inFlight() > 0 || speech.state().download?.running === true,
      beforeRemove: async () => {
        await dictation.session.release();
        LocalBrain.stop();
      },
      changed: () => dictation.session.speechChanged(),
    });
    registerDictionaryIpc({ get: () => settings });
    registerMcpIpc({ get: () => settings });
    registerCrmIpc(() => win);
    const brain = registerBrainIpc(() => win, { get: () => settings }, { lastApp: () => lastApp });
    win = createWindow();
    tray = createTray();
    nativeTheme.on('updated', () => {
      trayImages.clear();
      tray?.setImage(trayImage(trayState));
    });
    void network.start();
  }).catch((e: unknown) => {
    // A startup failure must not vanish as an unhandled rejection: it goes to the log the user can send.
    Log.write(`startup failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  });
  app.on('window-all-closed', () => {
    /* stay in tray */
  });
  app.on('before-quit', () => {
    quitting = true;
    disposeMeeting?.();
    LocalBrain.stop();
    void disposeNetwork?.();
    KeepAwake.allowSleep();
    disposeChromiumDecoder();
    nativeHelper?.dispose();
    void releaseDictation?.();
    void getVadRuntime().release();
    destroyOverlay?.();
    destroySalesCard?.();
    disposeVoice?.();
    tray?.destroy();
  });
}
