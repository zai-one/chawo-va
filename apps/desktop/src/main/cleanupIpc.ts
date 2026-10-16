// IPC for «Место на диске» (on the «Распознавание» page): scan, then delete the ticked items after a
// native confirmation. The renderer sends only ids of the last scan; main scans again before deleting.
import { join } from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { t } from '@chawo/core/strings';
import { CleanupController } from '@chawo/engine/cleanup/cleanupPage';
import { env } from '@chawo/engine/paths';
import type { SettingsData } from '@chawo/engine/settings';
import { handle } from './ipc';

/** Both names of the meetings folder (it follows the UI language), or the override. */
function meetingFolders(): string[] {
  const own = env('MEETINGS_DIR');
  if (own) return [own];
  const base = join(app.getPath('documents'), 'Chawo VA');
  return [join(base, 'Встречи'), join(base, 'Meetings')];
}

export function registerCleanupIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  opts: {
    /** A transcription or a download is running: nothing is deleted until it ends. */
    busy?: () => boolean;
    /** Close the open speech session and the Brain server (Windows keeps open files locked). */
    beforeRemove?: () => Promise<void>;
    changed?: () => void;
  } = {},
): CleanupController {
  const ctl = new CleanupController({
    options: () => ({ settings: settings.get(), meetings: meetingFolders(), downloads: join(app.getPath('downloads'), 'Chawo') }),
    beforeRemove: opts.beforeRemove,
    changed: opts.changed,
  });
  const ask = async (message: string, buttons: string[]) => {
    const w = getWindow();
    const box = { type: 'warning' as const, title: t('Место на диске', 'Disk space'), message, buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true };
    return (w ? await dialog.showMessageBox(w, box) : await dialog.showMessageBox(box)).response;
  };

  handle('cleanup:state', () => ctl.state());
  handle('cleanup:scan', () => ctl.scan());
  handle('cleanup:remove', async (_e, raw: unknown) => {
    const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
    if (ids.length === 0) return ctl.state();
    if (opts.busy?.()) {
      await ask(t('Сейчас идёт расшифровка или скачивание. Удалите после того, как они закончатся.', 'A transcription or a download is running. Delete after it ends.'), [t('Понятно', 'OK')]);
      return ctl.state();
    }
    const { count, size } = ctl.sizeOf(ids);
    const yes = await ask(
      t(`Удалить выбранное (${count}), ${size}? Это нельзя отменить.`, `Delete the selected items (${count}), ${size}? This cannot be undone.`),
      [t('Удалить', 'Delete'), t('Отмена', 'Cancel')],
    );
    return yes === 0 ? ctl.remove(ids) : ctl.state();
  });
  return ctl;
}
