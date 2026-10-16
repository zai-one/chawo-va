// The sales card as an Electron window: port of the window side of src/App/SalesCardWindow.xaml(.cs).
// Frameless, transparent, always on top, never focused (showInactive + focusable:false keep the
// user's app in front), not in the taskbar, bottom-right of the primary work area like WPF. Dark only.
// The renderer (salesCard.html) draws the state and reports its size; its × hides the card.

import { BrowserWindow, ipcMain, screen } from 'electron';
import * as AppPaths from '../appPaths';
import { SalesCardModel, type SalesCardSink, type SalesCardState } from '@chawo/engine/sales/salesCard';
import type { SalesCardView } from '@chawo/engine/sales/salesFlow';

const MIN_W = 200;
const MIN_H = 60;
const MAX_W = 460;
const MAX_H = 520;
const EDGE = 12;

/** Bottom-right corner of the work area, EDGE px in (SalesCardWindow.Place). */
function cardPosition(area: { x: number; y: number; width: number; height: number }, w: number, h: number): { x: number; y: number } {
  return { x: Math.round(area.x + area.width - w - EDGE), y: Math.round(area.y + area.height - h - EDGE) };
}

export class SalesCardWindow implements SalesCardSink {
  private win: BrowserWindow | null = null;
  private ready = false;
  private size = { w: 400, h: 120 };
  private last: SalesCardState | null = null;
  readonly model: SalesCardModel;
  /** The × on the card. */
  onDismiss: (() => void) | null = null;

  constructor() {
    this.model = new SalesCardModel((s) => this.render(s));
    ipcMain.on('salesCard:size', (e, w: unknown, h: unknown) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return;
      this.size = { w: clamp(Math.ceil(w), MIN_W, MAX_W), h: clamp(Math.ceil(h), MIN_H, MAX_H) };
      this.place();
    });
    ipcMain.on('salesCard:dismiss', (e) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      if (this.onDismiss) this.onDismiss();
      else this.model.hideNow();
    });
  }

  showModel(view: SalesCardView): void { this.model.showModel(view); }
  hideNow(): void { this.model.hideNow(); }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }

  private render(state: SalesCardState): void {
    this.last = state;
    if (!state.visible) {
      if (this.win && !this.win.isDestroyed()) this.win.hide();
      return;
    }
    const w = this.ensure();
    if (!this.ready) return; // sent on did-finish-load
    w.webContents.send('salesCard:state', state);
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
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: 'Chawo Voice Assistant',
      webPreferences: {
        preload: AppPaths.preload('salesCardPreload'),
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
    w.on('closed', () => {
      if (this.win === w) this.win = null;
      this.ready = false;
    });
    void AppPaths.loadPage(w, 'salesCard');
    this.win = w;
    return w;
  }

  private place(): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    const { w: width, h: height } = this.size;
    const pos = cardPosition(screen.getPrimaryDisplay().workArea, width, height);
    w.setBounds({ x: pos.x, y: pos.y, width, height });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
