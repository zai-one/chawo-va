// Electron main process. Dark theme only, no telemetry, nothing leaves the PC unless the user
// turns on a network feature. This is the shell the WPF features get ported into, piece by piece.

import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, session } from 'electron';
import { join } from 'node:path';
import { registerFileIpc } from './fileIpc';
import { registerSpeechIpc } from './speechIpc';
import { registerDictionaryIpc } from './dictionaryIpc';
import { chromiumDecode, disposeChromiumDecoder } from './chromiumDecoder';
import { setPlatformDecoder } from './file';
import * as Settings from './settings';
import { applyLanguage } from '../core/strings';

const APP_NAME = 'Chawo Voice Assistant';
const BG = '#14161a';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: Settings.SettingsData = Settings.defaults();

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

function createTray(): Tray {
  // Tray glyph follows the OS taskbar shade (as in WPF 1.17.1); the app UI itself is always dark.
  const set = nativeTheme.shouldUseDarkColors ? 'tray-dark' : 'tray-light';
  const t = new Tray(nativeImage.createFromPath(iconPath(set, 32)));
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
    registerSpeechIpc(() => win, { get: () => settings }, { busy: files.busy });
    registerDictionaryIpc({ get: () => settings });
    win = createWindow();
    tray = createTray();
  });
  app.on('window-all-closed', () => {
    /* stay in tray */
  });
  app.on('before-quit', () => {
    quitting = true;
    disposeChromiumDecoder();
    tray?.destroy();
  });
}
