// IPC for the «Расшифровка файла» page. The renderer never touches the filesystem: it asks the
// main process to pick, add, run, stop and reveal, and receives queue/status pushes.

import { BrowserWindow, Notification, dialog, ipcMain, shell } from 'electron';
import { dirname } from 'node:path';
import { FileQueue, FileRunner, Ffmpeg, OPEN_FILTERS, load16k, localPrepare } from './file';
import * as Settings from './settings';
import type { SettingsData, SettingsFileParallelism } from './settings';
import { isRussian, t } from '../core/strings';
import * as Log from './log';

export interface FileOptionsDto {
  timestamps: boolean;
  srt: boolean;
  parallelism: SettingsFileParallelism;
}

export interface FileStateDto {
  items: { id: number; path: string; state: string; note: string; outputPath?: string }[];
  status: string;
  busy: boolean;
  options: FileOptionsDto;
  ffmpeg: { line: string; canDownload: boolean; installed: boolean };
  lastOutput: string | null;
  /** UI language picked in main (Auto follows the OS locale), so the page matches status lines. */
  ru: boolean;
}

const PARALLELISM: readonly SettingsFileParallelism[] = ['Auto', 'Gentle1', 'Two', 'Four', 'Max'];

export function registerFileIpc(getWindow: () => BrowserWindow | null, settings: { get: () => SettingsData }): { busy: () => boolean } {
  const queue = new FileQueue();
  let ffmpegBusy = false;
  let ffmpegStatus = '';

  const state = (): FileStateDto => {
    const s = settings.get();
    return {
      items: queue.snapshot(),
      status: ffmpegStatus || runner.status,
      busy: runner.busy || ffmpegBusy,
      options: { timestamps: s.FileTimestamps, srt: s.FileSrt, parallelism: s.FileParallelism },
      ffmpeg: { line: Ffmpeg.statusLine(), canDownload: Ffmpeg.canDownload(), installed: Ffmpeg.isInstalled() },
      lastOutput: queue.lastOutput,
      ru: isRussian(),
    };
  };

  // Status pushes during a long file come several times a second; coalesce them.
  let pushTimer: NodeJS.Timeout | null = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      getWindow()?.webContents.send('file:state', state());
    }, 50);
  };

  const runner: FileRunner = new FileRunner({
    queue,
    load16k,
    prepare: localPrepare(settings.get),
    options: () => {
      const s = settings.get();
      return { timestamps: s.FileTimestamps, srt: s.FileSrt, useBrain: s.FileUseBrain };
    },
    status: () => push(),
    notifyDone: (title, body, _ok, last) => {
      const w = getWindow();
      if (w?.isVisible() && w.isFocused()) return;
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, silent: false });
      if (last) n.on('click', () => shell.showItemInFolder(last));
      n.show();
    },
  });
  queue.onChanged(push);

  ipcMain.handle('file:state', () => state());

  ipcMain.handle('file:add', (_e, paths: unknown, onlyAudio: unknown) => {
    if (!Array.isArray(paths)) return state();
    const r = queue.add(paths.filter((p): p is string => typeof p === 'string'), onlyAudio === true);
    if (r.added === 0 && r.skipped > 0) {
      ffmpegStatus = '';
      getWindow()?.webContents.send('file:toast', t('Ничего не добавлено: не аудио или уже в очереди.', 'Nothing added: not audio or already queued.'));
    }
    return state();
  });

  ipcMain.handle('file:pick', async (_e, kind: unknown) => {
    const w = getWindow();
    const folder = kind === 'folder';
    const opts: Electron.OpenDialogOptions = folder
      ? { title: t('Папка с записями', 'Folder with recordings'), properties: ['openDirectory'] }
      : { title: t('Записи для расшифровки', 'Recordings to transcribe'), properties: ['openFile', 'multiSelections'], filters: [...OPEN_FILTERS] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (!r.canceled && r.filePaths.length > 0) queue.add(r.filePaths, false);
    return state();
  });

  ipcMain.handle('file:remove', (_e, id: unknown) => {
    if (typeof id === 'number') queue.remove(id);
    return state();
  });

  ipcMain.handle('file:clearFinished', () => {
    for (const i of queue.snapshot()) if (i.state !== 'Queued' && i.state !== 'Running') queue.remove(i.id);
    return state();
  });

  ipcMain.handle('file:run', () => {
    if (ffmpegBusy) return state();
    ffmpegStatus = '';
    void runner.run().catch((e) => Log.write(`file run: ${e instanceof Error ? e.message : String(e)}`));
    return state();
  });

  ipcMain.handle('file:stop', () => {
    runner.stop();
    ffmpegAbort?.abort();
    return state();
  });

  ipcMain.handle('file:reveal', (_e, path: unknown) => {
    const p = typeof path === 'string' ? path : queue.lastOutput;
    if (p) shell.showItemInFolder(p);
    else if (typeof path === 'string') void shell.openPath(dirname(path));
    return true;
  });

  ipcMain.handle('file:options', (_e, o: Partial<FileOptionsDto>) => {
    const s = settings.get();
    if (typeof o?.timestamps === 'boolean') s.FileTimestamps = o.timestamps;
    if (typeof o?.srt === 'boolean') s.FileSrt = o.srt;
    if (typeof o?.parallelism === 'string' && PARALLELISM.includes(o.parallelism)) s.FileParallelism = o.parallelism;
    Settings.save(s);
    return state();
  });

  let ffmpegAbort: AbortController | null = null;
  ipcMain.handle('file:ffmpegDownload', () => {
    if (runner.busy || ffmpegBusy || !Ffmpeg.canDownload()) return state();
    ffmpegBusy = true;
    ffmpegAbort = new AbortController();
    ffmpegStatus = t('Скачиваю ffmpeg…', 'Downloading ffmpeg…');
    void Ffmpeg.downloadAsync((line) => {
      ffmpegStatus = line;
      push();
    }, ffmpegAbort.signal)
      .then((p) => (ffmpegStatus = t(`ffmpeg готов: ${p}`, `ffmpeg ready: ${p}`)))
      .catch((e) => (ffmpegStatus = t(`ffmpeg не скачался: ${(e as Error).message}`, `ffmpeg download failed: ${(e as Error).message}`)))
      .finally(() => {
        ffmpegBusy = false;
        ffmpegAbort = null;
        push();
      });
    return state();
  });
  return { busy: () => runner.busy };
}
