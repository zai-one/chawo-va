// «Озвучить» next to a selection in another app: a tiny non-focusable button shown at the point where
// the mouse let go of the selection. It goes away by itself after a few seconds, on a click, or when the
// pointer leaves it. Clicking it never takes the focus from the app, so its selection stays readable.
import { BrowserWindow, ipcMain, screen } from 'electron';
import * as AppPaths from '../appPaths';

const SHOW_MS = 4000;
const OFFSET = { x: 10, y: 14 };

export class PillWindow {
  private win: BrowserWindow | null = null;
  private ready = false;
  private size = { w: 128, h: 40 };
  private label = '';
  private at: { x: number; y: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  onSpeak: (() => void) | null = null;

  constructor() {
    const mine = (e: Electron.IpcMainEvent) => !!this.win && e.sender === this.win.webContents;
    ipcMain.on('pill:size', (e, w: unknown, h: unknown) => {
      if (!mine(e) || typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return;
      this.size = { w: Math.min(Math.max(Math.ceil(w), 60), 260), h: Math.min(Math.max(Math.ceil(h), 24), 80) };
      this.place();
    });
    ipcMain.on('pill:speak', (e) => {
      if (!mine(e)) return;
      this.hide();
      this.onSpeak?.();
    });
    ipcMain.on('pill:leave', (e) => {
      if (mine(e)) this.armTimer(800);
    });
  }

  /** Shows the button near a point in DIP screen coordinates. */
  showAt(point: { x: number; y: number }, label: string): void {
    this.at = point;
    this.label = label;
    const w = this.ensure();
    if (!this.ready) return;
    w.webContents.send('pill:state', { label });
    this.place();
    if (!w.isVisible()) w.showInactive();
    this.armTimer(SHOW_MS);
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.at = null;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  destroy(): void {
    this.hide();
    this.win?.destroy();
    this.win = null;
  }

  private armTimer(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), ms);
    this.timer.unref?.();
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
      title: 'Chawo — озвучить',
      webPreferences: {
        preload: AppPaths.preload('pillPreload'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    w.setAlwaysOnTop(true, 'pop-up-menu');
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.once('did-finish-load', () => {
      this.ready = true;
      if (this.at) this.showAt(this.at, this.label);
    });
    w.on('closed', () => {
      if (this.win === w) this.win = null;
      this.ready = false;
    });
    void AppPaths.loadPage(w, 'pill');
    this.win = w;
    return w;
  }

  private place(): void {
    const w = this.win;
    if (!w || w.isDestroyed() || !this.at) return;
    const area = screen.getDisplayNearestPoint(this.at).workArea;
    let x = this.at.x + OFFSET.x;
    let y = this.at.y + OFFSET.y;
    if (x + this.size.w > area.x + area.width) x = this.at.x - OFFSET.x - this.size.w;
    if (y + this.size.h > area.y + area.height) y = this.at.y - OFFSET.y - this.size.h;
    w.setBounds({ x: Math.round(x), y: Math.round(y), width: this.size.w, height: this.size.h });
  }
}
