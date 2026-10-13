// IPC for the «Мозг» page. The renderer only asks; the main process owns the key, the network calls,
// the settings writes and .gguf deletes (after a native confirmation box). The saved key is never sent
// back to the renderer.

import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { rmSync } from 'node:fs';
import { t } from '../core/strings';
import * as Settings from './settings';
import type { SettingsData } from './settings';
import { BrainController, LOCAL_KINDS } from './brain/brainPage';

export function registerBrainIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  opts: { changed?: () => void } = {},
): BrainController {
  let pushTimer: NodeJS.Timeout | null = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const w = getWindow();
      if (w && !w.isDestroyed()) w.webContents.send('brain:state', ctl.state());
    }, 80);
  };
  const ctl: BrainController = new BrainController({ settings: settings.get, save: Settings.save, push, changed: opts.changed });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  ipcMain.handle('brain:state', (_e, rebind: unknown) => {
    if (rebind === true) ctl.bind();
    return ctl.state();
  });
  ipcMain.handle('brain:source', (_e, v: unknown) => {
    if (v === 'Off' || v === 'Local' || v === 'Server') ctl.setSource(v);
    return ctl.state();
  });
  ipcMain.handle('brain:everyTake', (_e, v: unknown) => {
    if (typeof v === 'boolean') ctl.setEveryTake(v);
    return ctl.state();
  });
  ipcMain.handle('brain:instruction', (_e, v: unknown) => {
    ctl.setInstruction(str(v));
    return ctl.state();
  });
  ipcMain.handle('brain:selection', (_e, v: unknown) => {
    if (typeof v === 'boolean') ctl.setSelection(v);
    return ctl.state();
  });
  ipcMain.handle('brain:device', (_e, v: unknown) => {
    if (v === 'Cpu' || v === 'Gpu') ctl.setDevice(v);
    return ctl.state();
  });
  ipcMain.handle('brain:localModel', (_e, v: unknown) => {
    if (typeof v === 'string' && (LOCAL_KINDS as readonly string[]).includes(v)) ctl.selectLocalModel(v as (typeof LOCAL_KINDS)[number]);
    return ctl.state();
  });
  ipcMain.handle('brain:customUrl', (_e, v: unknown) => {
    ctl.setCustomUrl(str(v));
    return ctl.state();
  });
  ipcMain.handle('brain:provider', (_e, v: unknown) => {
    ctl.setProvider(str(v));
    return ctl.state();
  });
  ipcMain.handle('brain:key', (_e, v: unknown) => {
    ctl.setKey(str(v));
    return ctl.state();
  });
  ipcMain.handle('brain:url', (_e, v: unknown) => {
    ctl.setUrl(str(v));
    return ctl.state();
  });
  ipcMain.handle('brain:model', (_e, v: unknown) => {
    void ctl.setModel(str(v));
    return ctl.state();
  });
  ipcMain.handle('brain:refresh', () => {
    void ctl.refresh();
    return ctl.state();
  });
  ipcMain.handle('brain:keysLink', () => {
    const url = ctl.keysUrl();
    // Only the fixed https pages from the provider list, opened in the user's browser.
    if (url.startsWith('https://')) void shell.openExternal(url);
    return true;
  });
  ipcMain.handle('brain:deleteGguf', async (_e, v: unknown) => {
    const path = ctl.deletablePath(str(v));
    if (!path) return ctl.state();
    const w = getWindow();
    const box = {
      type: 'warning' as const,
      title: t('Удалить модель', 'Delete model'),
      message: t(`Удалить файл модели мозга?\n\n${path}`, `Delete the Brain model file?\n\n${path}`),
      buttons: [t('Удалить', 'Delete'), t('Отмена', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const r = w ? await dialog.showMessageBox(w, box) : await dialog.showMessageBox(box);
    if (r.response !== 0) return ctl.state();
    try {
      rmSync(path, { force: true });
    } catch (e) {
      const msg = { type: 'warning' as const, title: box.title, message: e instanceof Error ? e.message : String(e) };
      if (w) await dialog.showMessageBox(w, msg);
      else await dialog.showMessageBox(msg);
    }
    return ctl.state();
  });
  ipcMain.handle('brain:close', () => {
    ctl.cancel();
    return true;
  });
  return ctl;
}
