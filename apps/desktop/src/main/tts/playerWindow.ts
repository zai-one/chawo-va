// The TTS player as an Electron window: frameless, dark, always on top, never focused (the app the
// user reads in stays in front), movable by its head. Placed near the pointer the first time, then
// where the user left it. State and audio go to the page over IPC; the page cannot reach the network.
import { BrowserWindow, ipcMain, screen } from 'electron';
import * as AppPaths from '../appPaths';
import { playerPosition, type PlayerState } from '@chawo/engine/tts/playerModel';

const MIN_W = 240;
const MIN_H = 70;
const MAX_W = 420;
const MAX_H = 260;
export class PlayerWindow {
  private win: BrowserWindow | null = null;
  private ready = false;
  private size = { w: 368, h: 130 };
  private state: PlayerState | null = null;
  private audio: { bytes: Uint8Array; mime: string } | null = null;
  /** Placed once per showing; afterwards the user may have moved it. */
  private placed = false;
  onRate: ((rate: number) => void) | null = null;
  onSettings: (() => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    const mine = (e: Electron.IpcMainEvent) => !!this.win && e.sender === this.win.webContents;
    ipcMain.on('player:size', (e, w: unknown, h: unknown) => {
      if (!mine(e) || typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return;
      this.size = { w: clamp(Math.ceil(w), MIN_W, MAX_W), h: clamp(Math.ceil(h), MIN_H, MAX_H) };
      this.fit();
    });
    ipcMain.on('player:rate', (e, v: unknown) => {
      if (mine(e) && typeof v === 'number' && Number.isFinite(v)) this.onRate?.(v);
    });
    ipcMain.on('player:close', (e) => {
      if (!mine(e)) return;
      this.hide();
      this.onClose?.();
    });
    ipcMain.on('player:settings', (e) => {
      if (mine(e)) this.onSettings?.();
    });
  }

  /** Shows a state (loading / error / ready). A new reading starts placed near the pointer. */
  show(state: PlayerState, fresh = false): void {
    this.state = state;
    if (state.phase !== 'ready') this.audio = null;
    if (fresh) this.placed = false;
    const w = this.ensure();
    if (!this.ready) return; // sent on did-finish-load
    w.webContents.send('player:state', state);
    this.place();
    if (!w.isVisible()) w.showInactive();
  }

  /** The audio of the reading in the ready state. */
  play(bytes: Uint8Array, mime: string): void {
    this.audio = { bytes, mime };
    if (this.ready && this.win && !this.win.isDestroyed()) this.win.webContents.send('player:audio', bytes, mime);
  }

  hide(): void {
    this.state = null;
    this.audio = null;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
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
      title: 'Chawo — озвучка',
      webPreferences: {
        preload: AppPaths.preload('playerPreload'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // The window is never focused, so there is no click before the first play.
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    w.setAlwaysOnTop(true, 'floating');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.once('did-finish-load', () => {
      this.ready = true;
      if (this.state) {
        const audio = this.audio;
        this.show(this.state);
        if (audio) this.play(audio.bytes, audio.mime);
      }
    });
    w.on('closed', () => {
      if (this.win === w) this.win = null;
      this.ready = false;
    });
    void AppPaths.loadPage(w, 'player');
    this.win = w;
    return w;
  }

  private place(): void {
    const w = this.win;
    if (!w || w.isDestroyed() || this.placed) return;
    const pointer = screen.getCursorScreenPoint();
    const pos = playerPosition(screen.getDisplayNearestPoint(pointer).workArea, pointer, this.size.w, this.size.h);
    w.setBounds({ x: pos.x, y: pos.y, width: this.size.w, height: this.size.h });
    this.placed = true;
  }

  /** New size from the page: keep the top-left corner where it is. */
  private fit(): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    w.setBounds({ x: b.x, y: b.y, width: this.size.w, height: this.size.h });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
