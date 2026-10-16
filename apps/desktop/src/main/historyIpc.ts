// IPC for the «История» page. The main process owns the history file, the clipboard and the
// confirm box; the renderer only asks and redraws.

import { BrowserWindow, clipboard, dialog, shell } from 'electron';
import { t } from '@chawo/core/strings';
import * as Settings from '@chawo/engine/settings';
import type { SettingsData } from '@chawo/engine/settings';
import { databasePath, env } from '@chawo/engine/paths';
import { HistoryController } from '@chawo/engine/history/historyPage';
import { HistoryStore, type HistoryKeep } from '@chawo/engine/history/historyStore';
import { AskController } from '@chawo/engine/history/askPage';
import * as FileBrain from '@chawo/engine/brain/fileBrain';
import { meetingsDir } from './meetingIpc';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { learnFromEdit } from '@chawo/engine/dictionary/learnedWords';
import { emit, handle } from './ipc';
import type { EventChannel, EventMap } from '@chawo/ipc/contract';

/** @public Also read by scripts/smoke-history.cjs from the built app. */
export function historyPath(): string {
  return databasePath();
}

export function registerHistoryIpc(getWindow: () => BrowserWindow | null, settings: { get: () => SettingsData }): HistoryController {
  const send = <C extends EventChannel>(channel: C, payload: EventMap[C]) => emit(getWindow(), channel, payload);
  let pushTimer: NodeJS.Timeout | null = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      send('history:state', ctl.state());
    }, 60);
  };
  const store = new HistoryStore(historyPath());
  const ctl: HistoryController = new HistoryController({
    store,
    settings: settings.get,
    save: Settings.save,
    copy: (text) => clipboard.writeText(text),
    learn: (before, after) => learnFromEdit(settings.get(), Settings.save, before, after),
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

  handle('history:state', () => ctl.state());
  handle('history:query', (_e, q: unknown) => ctl.setQuery(str(q)));
  handle('history:keep', (_e, k: unknown) => ctl.setKeep(str(k) as HistoryKeep));
  handle('history:copy', (_e, id: unknown, which: unknown) => ctl.copy(str(id), which === 'raw' ? 'raw' : 'final'));
  handle('history:remove', (_e, id: unknown) => ctl.remove(str(id)));
  handle('history:clear', () => ctl.clearAll());
  handle('history:edit', (_e, id: unknown, text: unknown) => ctl.edit(str(id), str(text)));
  handle('history:rerun', (_e, id: unknown) => ctl.rerun(str(id)));

  // «Спросить историю»
  let askTimer: NodeJS.Timeout | null = null;
  const askPush = () => {
    if (askTimer) return;
    askTimer = setTimeout(() => {
      askTimer = null;
      send('ask:state', ask.state());
    }, 60);
  };
  const ask = new AskController({
    store,
    settings: settings.get,
    save: Settings.save,
    meetingFolders: () => {
      // The folder is named by the UI language at recording time: look at both spellings
      // (CHAWO_MEETINGS_DIR, when set, is the only one).
      const dir = meetingsDir();
      if (env('MEETINGS_DIR')) return existsSync(dir) ? [dir] : [];
      const parent = dirname(dir);
      return [...new Set([dir, join(parent, 'Встречи'), join(parent, 'Meetings')])].filter((p) => existsSync(p));
    },
    brain: (s) => {
      const target = FileBrain.target(s);
      return { target, cloud: FileBrain.cloudName(s), describe: FileBrain.describe(s), ask: FileBrain.createAsk(s, target === 'None' ? 'Local' : target) };
    },
    pickFolder: async () => {
      const w = getWindow();
      const opts = { properties: ['openDirectory' as const], title: t('Папка с расшифровками', 'Folder with transcripts') };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    confirm: async (message) => {
      const w = getWindow();
      const opts = { type: 'question' as const, buttons: [t('Да', 'Yes'), t('Нет, только поиск', 'No, search only')], defaultId: 0, cancelId: 1, message, noLink: true };
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      return r.response === 0;
    },
    copy: (text) => clipboard.writeText(text),
    open: (p) => void shell.openPath(p),
    push: askPush,
  });
  handle('ask:state', () => ask.state());
  handle('ask:run', (_e, q: unknown) => ask.ask(str(q)));
  handle('ask:cancel', () => ask.cancel());
  handle('ask:history', (_e, on: unknown) => ask.setHistory(on === true));
  handle('ask:addFolder', () => ask.addFolder());
  handle('ask:removeFolder', (_e, p: unknown) => ask.removeFolder(str(p)));
  handle('ask:copy', () => ask.copyAnswer());
  handle('ask:open', (_e, p: unknown) => ask.openSource(str(p)));
  return ctl;
}
