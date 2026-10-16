// IPC for the «Словарь» page. The renderer only asks; the main process owns the rows, the settings
// write and the materials folder scan.

import * as Settings from '@chawo/engine/settings';
import type { SettingsData } from '@chawo/engine/settings';
import { DictionaryController } from '@chawo/engine/dictionary/dictionaryPage';
import { handle } from './ipc';

export function registerDictionaryIpc(
  settings: { get: () => SettingsData },
  opts: { changed?: () => void } = {},
): DictionaryController {
  const ctl = new DictionaryController({ settings: settings.get, save: Settings.save, changed: opts.changed });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : -1);

  handle('dict:state', () => ctl.state());
  handle('dict:setRow', (_e, id: unknown, from: unknown, to: unknown) => ctl.setRow(num(id), str(from), str(to)));
  handle('dict:add', () => {
    const id = ctl.addRow();
    return { id, state: ctl.state() };
  });
  handle('dict:remove', (_e, id: unknown) => ctl.removeRow(num(id)));
  handle('dict:suggest', () => ctl.suggest());
  handle('dict:addSuggestion', (_e, heard: unknown, written: unknown) => ctl.addSuggestion(str(heard), str(written)));
  handle('dict:setSpoken', (_e, kind: unknown, on: unknown) =>
    ctl.setSpoken(kind === 'numbers' ? 'numbers' : kind === 'punctuation' ? 'punctuation' : ('' as never), on === true));
  handle('dict:setScript', (_e, command: unknown) => ctl.setScript(str(command)));
  handle('dict:setScriptFiles', (_e, on: unknown) => ctl.setScriptFiles(on === true));
  handle('dict:setSnippet', (_e, id: unknown, trigger: unknown, text: unknown) => ctl.setSnippet(num(id), str(trigger), str(text)));
  handle('dict:addSnippet', () => {
    const id = ctl.addSnippet();
    return { id, state: ctl.state() };
  });
  handle('dict:removeSnippet', (_e, id: unknown) => ctl.removeSnippet(num(id)));
  handle('dict:acceptLearned', (_e, from: unknown, to: unknown) => ctl.acceptLearned(str(from), str(to)));
  handle('dict:dismissLearned', (_e, from: unknown, to: unknown) => ctl.dismissLearned(str(from), str(to)));
  handle('dict:setLearnAuto', (_e, on: unknown) => ctl.setLearnAuto(on === true));
  handle('dict:testScript', () => ctl.testScript());
  return ctl;
}
