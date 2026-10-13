// The floating pill as an Electron window: port of the window side of src/App/OverlayWindow.xaml(.cs).
// Frameless, transparent, always on top, never focused (showInactive + focusable:false keep the user's
// app in front), not in the taskbar. Dark only. Drag it and it stays where you left it (OverlayX/Y).
// Without a caret position (Windows-only GetGUIThreadInfo, not ported) it sits at the bottom centre of
// the screen under the mouse. State comes from OverlayModel; the renderer (overlay.html) draws the
// bars, the ripple and the live line and reports its size back.

import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import type { SettingsData } from '../settings';
import { OverlayModel, overlayPosition, type OverlaySink, type OverlayState } from './overlayModel';

const MIN_W = 120;
const MIN_H = 58;
const MAX_W = 440;
const MAX_H = 240;

export interface OverlaySettings {
  get: () => SettingsData;
  save: (s: SettingsData) => void;
}

export class OverlayWindow implements OverlaySink {
  private win: BrowserWindow | null = null;
  private ready = false;
  private size = { w: MIN_W, h: MIN_H };
  private placedAt = 0;
  private last: OverlayState | null = null;
  readonly model: OverlayModel;

  constructor(private readonly settings: OverlaySettings) {
    this.model = new OverlayModel((s) => this.render(s));
    ipcMain.on('overlay:size', (e, w: unknown, h: unknown) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return;
      this.size = { w: clamp(Math.ceil(w), MIN_W, MAX_W), h: clamp(Math.ceil(h), MIN_H, MAX_H) };
      this.place();
    });
  }

  showListening(): void { this.model.showListening(); }
  showRecognizing(): void { this.model.showRecognizing(); }
  showPartial(text: string): void { this.model.showPartial(text); }
  showStatus(text: string): void { this.model.showStatus(text); }
  showHint(text: string): void { this.model.showHint(text); }
  showCaption(text: string, ms?: number): void { this.model.showCaption(text, ms); }
  hideNow(): void { this.model.hideNow(); }

  /** Recorder.Level for the bars, 0..1 (the dictation IPC reads it once and shares it with the page). */
  level(v: number): void {
    if (this.win && this.ready && this.last?.visible) this.win.webContents.send('overlay:level', v);
  }

  /** Forget the dragged position: the pill goes back to its default place (OverlayWindow.Unpin). */
  unpin(): void {
    const s = this.settings.get();
    s.OverlayX = null;
    s.OverlayY = null;
    this.settings.save(s);
    this.place();
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }

  private render(state: OverlayState): void {
    this.last = state;
    if (!state.visible) {
      if (this.win && !this.win.isDestroyed()) {
        if (this.ready) this.win.webContents.send('overlay:state', state);
        this.win.hide();
      }
      return;
    }
    const w = this.ensure();
    if (!this.ready) return; // sent on did-finish-load
    w.webContents.send('overlay:state', state);
    this.place();
    if (!w.isVisible()) w.showInactive();
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.ready = false;
    const w = new BrowserWindow({
      width: this.size.w,
      height: this.size.h,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: 'Chawo',
      webPreferences: {
        preload: join(__dirname, '..', 'overlayPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    w.setAlwaysOnTop(true, 'floating');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.once('did-finish-load', () => {
      this.ready = true;
      if (this.last) this.render(this.last);
    });
    w.on('moved', () => {
      if (Date.now() - this.placedAt < 300) return; // our own setBounds, not a drag
      // Remember the window's top-left; a differently sized pill (a hint) starts from the same edge.
      const [x, y] = w.getPosition();
      const s = this.settings.get();
      s.OverlayX = x;
      s.OverlayY = y;
      this.settings.save(s);
    });
    w.on('closed', () => {
      if (this.win === w) this.win = null;
      this.ready = false;
    });
    void w.loadFile(join(__dirname, '..', '..', 'renderer', 'overlay.html'));
    this.win = w;
    return w;
  }

  /** Pinned position, else the bottom centre of the work area under the mouse; kept on that screen. */
  private place(): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    const s = this.settings.get();
    const { w: width, h: height } = this.size;
    const pinned = s.OverlayX !== null && s.OverlayY !== null;
    const anchor = pinned ? { x: s.OverlayX! + width / 2, y: s.OverlayY! + height / 2 } : screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea;
    const pos = overlayPosition(area, width, height, pinned ? { x: s.OverlayX!, y: s.OverlayY! } : null);
    this.placedAt = Date.now();
    w.setBounds({ x: pos.x, y: pos.y, width, height });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
