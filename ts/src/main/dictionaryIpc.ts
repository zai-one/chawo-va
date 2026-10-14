// IPC for the «Словарь» page. The renderer only asks; the main process owns the rows, the settings
// write and the materials folder scan.

import { ipcMain } from 'electron';
import * as Settings from './settings';
import type { SettingsData } from './settings';
import { DictionaryController } from './dictionary/dictionaryPage';

export function registerDictionaryIpc(
  settings: { get: () => SettingsData },
  opts: { changed?: () => void } = {},
): DictionaryController {
  const ctl = new DictionaryController({ settings: settings.get, save: Settings.save, changed: opts.changed });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : -1);

  ipcMain.handle('dict:state', () => ctl.state());
  ipcMain.handle('dict:setRow', (_e, id: unknown, from: unknown, to: unknown) => ctl.setRow(num(id), str(from), str(to)));
  ipcMain.handle('dict:add', () => {
    const id = ctl.addRow();
    return { id, state: ctl.state() };
  });
  ipcMain.handle('dict:remove', (_e, id: unknown) => ctl.removeRow(num(id)));
  ipcMain.handle('dict:suggest', () => ctl.suggest());
  ipcMain.handle('dict:addSuggestion', (_e, heard: unknown, written: unknown) => ctl.addSuggestion(str(heard), str(written)));
  ipcMain.handle('dict:setSpoken', (_e, kind: unknown, on: unknown) =>
    ctl.setSpoken(kind === 'numbers' ? 'numbers' : kind === 'punctuation' ? 'punctuation' : ('' as never), on === true));
  ipcMain.handle('dict:setScript', (_e, command: unknown) => ctl.setScript(str(command)));
  ipcMain.handle('dict:setScriptFiles', (_e, on: unknown) => ctl.setScriptFiles(on === true));
  ipcMain.handle('dict:setSnippet', (_e, id: unknown, trigger: unknown, text: unknown) => ctl.setSnippet(num(id), str(trigger), str(text)));
  ipcMain.handle('dict:addSnippet', () => {
    const id = ctl.addSnippet();
    return { id, state: ctl.state() };
  });
  ipcMain.handle('dict:removeSnippet', (_e, id: unknown) => ctl.removeSnippet(num(id)));
  ipcMain.handle('dict:testScript', () => ctl.testScript());
  return ctl;
}
