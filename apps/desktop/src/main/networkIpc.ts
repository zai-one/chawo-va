// IPC for the «Сеть» page. Hermes lives here in the main process only; the renderer just asks.
// The yes/no box before listening on the LAN is a native dialog.

import { BrowserWindow, dialog, ipcMain } from 'electron';
import * as Settings from '@chawo/engine/settings';
import type { SettingsData } from '@chawo/engine/settings';
import { t } from '@chawo/core/strings';
import { HermesServer, type HermesTranscribe } from '@chawo/engine/network/hermesServer';
import * as Firewall from '@chawo/engine/network/hermesFirewall';
import * as KeepAwake from './network/keepAwake';
import * as RemoteSpeech from '@chawo/engine/network/remoteSpeech';
import { NetworkController } from '@chawo/engine/network/networkPage';

export function registerNetworkIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  opts: { transcribe: HermesTranscribe; changed?: () => void },
): NetworkController {
  let pushTimer: NodeJS.Timeout | null = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const w = getWindow();
      if (w && !w.isDestroyed()) w.webContents.send('network:state', ctl.state());
    }, 60);
  };
  const box = async (options: Electron.MessageBoxOptions) => {
    const w = getWindow();
    return w && !w.isDestroyed() ? dialog.showMessageBox(w, options) : dialog.showMessageBox(options);
  };
  const ctl: NetworkController = new NetworkController({
    settings: settings.get,
    save: Settings.save,
    push,
    changed: opts.changed,
    createServer: (port, transcribe, lan) => new HermesServer(port, transcribe, lan),
    transcribe: opts.transcribe,
    check: (s) => RemoteSpeech.check(s),
    firewall: { tryOpenPort: (port) => Firewall.tryOpenPort(port), openConsole: () => Firewall.openConsole() },
    confirm: async (title, message) => {
      const r = await box({
        type: 'warning', title, message,
        buttons: [t('Да', 'Yes'), t('Нет', 'No')], defaultId: 1, cancelId: 1, noLink: true,
      });
      return r.response === 0;
    },
    alert: async (title, message) => {
      await box({ type: 'warning', title, message, buttons: ['OK'], noLink: true });
    },
    keepAwake: { prevent: KeepAwake.preventSleep, allow: KeepAwake.allowSleep },
  });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  ipcMain.handle('network:state', () => ctl.state());
  ipcMain.handle('network:role', async (_e, v: unknown) => {
    if (v === 'Host' || v === 'Client') await ctl.setRole(v);
    return ctl.state();
  });
  ipcMain.handle('network:remote', (_e, host: unknown, port: unknown) => {
    ctl.setRemote(str(host).slice(0, 512), typeof port === 'number' ? port : str(port).slice(0, 16));
    return ctl.state();
  });
  ipcMain.handle('network:check', async () => {
    await ctl.checkHost();
    return ctl.state();
  });
  ipcMain.handle('network:lan', async () => {
    await ctl.toggleLan();
    return ctl.state();
  });
  ipcMain.handle('network:keepAwake', (_e, v: unknown) => {
    if (typeof v === 'boolean') ctl.setKeepAwake(v);
    return ctl.state();
  });
  return ctl;
}
