// IPC for the «Распознавание» page. The renderer only asks; the main process owns downloads,
// deletes (after a native confirmation box) and settings writes.

import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { SpeechModelKind } from '../core/speechModels';
import { t } from '../core/strings';
import * as Settings from './settings';
import type { SettingsData } from './settings';
import { SPEECH_KINDS, SpeechController } from './speech/speechPage';

export function registerSpeechIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  opts: { busy?: () => boolean; changed?: () => void } = {},
): SpeechController {
  let pushTimer: NodeJS.Timeout | null = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const w = getWindow();
      if (w && !w.isDestroyed()) w.webContents.send('speech:state', ctl.state());
    }, 120);
  };
  const ctl: SpeechController = new SpeechController({
    settings: settings.get,
    save: Settings.save,
    push,
    busy: opts.busy,
    changed: opts.changed,
  });
  const kindOf = (k: unknown): SpeechModelKind | null =>
    typeof k === 'string' && (SPEECH_KINDS as readonly string[]).includes(k) ? (k as SpeechModelKind) : null;

  ipcMain.handle('speech:state', () => ctl.state());
  ipcMain.handle('speech:select', (_e, k: unknown) => {
    const kind = kindOf(k);
    if (kind) ctl.select(kind);
    return ctl.state();
  });
  ipcMain.handle('speech:device', (_e, d: unknown) => {
    if (d === 'Gpu' || d === 'Cpu') ctl.setDevice(d);
    return ctl.state();
  });
  ipcMain.handle('speech:threads', (_e, n: unknown) => {
    if (typeof n === 'number') ctl.setThreads(n);
    return ctl.state();
  });
  ipcMain.handle('speech:download', (_e, k: unknown) => {
    const kind = kindOf(k);
    if (kind) void ctl.download(kind);
    return ctl.state();
  });
  ipcMain.handle('speech:cancel', () => {
    ctl.cancelDownload();
    return ctl.state();
  });
  ipcMain.handle('speech:dismiss', () => {
    ctl.dismissDownload();
    return ctl.state();
  });
  ipcMain.handle('speech:delete', async (_e, k: unknown) => {
    const kind = kindOf(k);
    if (!kind) return ctl.state();
    const w = getWindow();
    const title = t('Удалить модель', 'Delete model');
    const box = {
      type: 'warning' as const,
      title,
      message: ctl.confirmText(kind),
      buttons: [t('Удалить', 'Delete'), t('Отмена', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const r = w ? await dialog.showMessageBox(w, box) : await dialog.showMessageBox(box);
    if (r.response !== 0) return ctl.state();
    const err = ctl.delete(kind);
    if (err) {
      const msg = { type: 'warning' as const, title, message: err };
      if (w) await dialog.showMessageBox(w, msg);
      else await dialog.showMessageBox(msg);
    }
    return ctl.state();
  });
  return ctl;
}
