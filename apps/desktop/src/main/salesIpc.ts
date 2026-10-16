// IPC for the «Продажи» page and the sales card. The renderer only asks; the main process owns the
// catalog rows, the settings write, the materials folder (native dialog) and the card window.

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import * as Settings from '@chawo/engine/settings';
import type { SettingsData } from '@chawo/engine/settings';
import { t } from '@chawo/core/strings';
import { SalesPageController } from '@chawo/engine/sales/salesPage';
import { SalesSession } from '@chawo/engine/sales/salesCard';
import { SalesCardWindow } from './sales/salesCardWindow';

export interface SalesIpc {
  page: SalesPageController;
  session: SalesSession;
  card: SalesCardWindow;
}

export function registerSalesIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  opts: { changed?: () => void } = {},
): SalesIpc {
  const card = new SalesCardWindow();
  const session = new SalesSession({ settings: settings.get, card });
  card.onDismiss = () => session.dismiss();
  const page = new SalesPageController({
    settings: settings.get,
    save: Settings.save,
    changed: () => {
      session.settingsChanged();
      opts.changed?.();
    },
    pickFolder: async (current) => {
      const w = getWindow();
      const options: Electron.OpenDialogOptions = {
        title: t('Папка материалов для продаж', 'Sales materials folder'),
        properties: ['openDirectory'],
        defaultPath: current && existsSync(current) ? current : undefined,
      };
      const r = w && !w.isDestroyed() ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    },
    presentCall: (ext, num, mgr) => session.presentCall(ext, num, mgr),
  });
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : -1);

  ipcMain.handle('sales:state', () => page.state());
  ipcMain.handle('sales:setRow', (_e, id: unknown, code: unknown, name: unknown, line: unknown, similar: unknown) =>
    page.setRow(num(id), code, name, line, similar));
  ipcMain.handle('sales:add', () => {
    const id = page.addRow();
    return { id, state: page.state() };
  });
  ipcMain.handle('sales:remove', (_e, id: unknown) => page.removeRow(num(id)));
  ipcMain.handle('sales:pickFolder', () => page.pickFolder());
  ipcMain.handle('sales:clearFolder', () => page.clearFolder());
  ipcMain.handle('sales:showCall', (_e, ext: unknown, number: unknown, manager: unknown) => page.showCall(ext, number, manager));
  return { page, session, card };
}
