// IPC for the «История» page. The main process owns the history file, the clipboard and the
// confirm box; the renderer only asks and redraws.

import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { t } from '../core/strings';
import * as Settings from './settings';
import type { SettingsData } from './settings';
import { localDataDir } from './paths';
import { HistoryController } from './history/historyPage';
import { HistoryStore, type HistoryKeep } from './history/historyStore';

export function historyPath(): string {
  return join(localDataDir(), 'history.jsonl');
}

export function registerHistoryIpc(getWindow: () => BrowserWindow | null, settings: { get: () => SettingsData }): HistoryController {
  const send = (channel: string, payload: unknown) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  let pushTimer: NodeJS.Timeout | null = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      send('history:state', ctl.state());
    }, 60);
  };
  const ctl: HistoryController = new HistoryController({
    store: new HistoryStore(historyPath()),
    settings: settings.get,
    save: Settings.save,
    copy: (text) => clipboard.writeText(text),
    push,
    confirm: async (message) => {
      const w = getWindow();
      const opts = {
        type: 'question' as const,
        buttons: [t('Удалить', 'Delete'), t('Отмена', 'Cancel')],
        defaultId: 1,
        cancelId: 1,
        message,
        noLink: true,
      };
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      return r.response === 0;
    },
  });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  ipcMain.handle('history:state', () => ctl.state());
  ipcMain.handle('history:query', (_e, q: unknown) => ctl.setQuery(str(q)));
  ipcMain.handle('history:keep', (_e, k: unknown) => ctl.setKeep(str(k) as HistoryKeep));
  ipcMain.handle('history:copy', (_e, id: unknown, which: unknown) => ctl.copy(str(id), which === 'raw' ? 'raw' : 'final'));
  ipcMain.handle('history:remove', (_e, id: unknown) => ctl.remove(str(id)));
  ipcMain.handle('history:clear', () => ctl.clearAll());
  ipcMain.handle('history:rerun', (_e, id: unknown) => ctl.rerun(str(id)));
  return ctl;
}
