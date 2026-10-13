// IPC for the «Расшифровка файла» page. The renderer never touches the filesystem: it asks the
// main process to pick, add, run, stop and reveal, and receives queue/status pushes.

import { BrowserWindow, Notification, dialog, ipcMain, shell } from 'electron';
import { dirname } from 'node:path';
import { FileQueue, FileRunner, Ffmpeg, OPEN_FILTERS, load16k, localPrepare, remoteFatal, remotePrepare } from './file';
import { getDiarizeRuntime } from './diarize';
import * as FileBrain from './brain/fileBrain';
import { BrainException } from './brain/speechCleanup';
import * as Settings from './settings';
import { asExtraFormats, type FileExtraFormat, type SettingsData, type SettingsFileParallelism } from './settings';
import { isRussian, t } from '../core/strings';
import * as Log from './log';

export interface FileOptionsDto {
  timestamps: boolean;
  srt: boolean;
  /** vtt / json / md / docx */
  extra: FileExtraFormat[];
  parallelism: SettingsFileParallelism;
  diarize: boolean;
}

export interface FileStateDto {
  items: { id: number; path: string; state: string; note: string; outputPath?: string }[];
  status: string;
  busy: boolean;
  options: FileOptionsDto;
  ffmpeg: { line: string; canDownload: boolean; installed: boolean };
  diarization: { onDisk: boolean; ready: boolean; downloading: boolean; line: string; canDownload: boolean };
  lastOutput: string | null;
  /** UI language picked in main (Auto follows the OS locale), so the page matches status lines. */
  ru: boolean;
}

const PARALLELISM: readonly SettingsFileParallelism[] = ['Auto', 'Gentle1', 'Two', 'Four', 'Max'];

export function registerFileIpc(getWindow: () => BrowserWindow | null, settings: { get: () => SettingsData }): { busy: () => boolean; enqueue: (path: string) => void } {
  const queue = new FileQueue();
  let ffmpegBusy = false;
  let ffmpegStatus = '';
  let diarBusy = false;
  let diarStatus = '';
  let ffmpegAbort: AbortController | null = null;
  let diarAbort: AbortController | null = null;

  const state = (): FileStateDto => {
    const s = settings.get();
    const diar = getDiarizeRuntime();
    const ruLang = isRussian();
    return {
      items: queue.snapshot(),
      status: ffmpegStatus || diarStatus || runner.status,
      busy: runner.busy || ffmpegBusy || diarBusy,
      options: { timestamps: s.FileTimestamps, srt: s.FileSrt, extra: [...s.FileExtraFormats], parallelism: s.FileParallelism, diarize: s.FileDiarize },
      ffmpeg: { line: Ffmpeg.statusLine(), canDownload: Ffmpeg.canDownload(), installed: Ffmpeg.isInstalled() },
      diarization: {
        onDisk: diar.onDisk,
        ready: diar.ready,
        downloading: diar.isDownloading,
        line: ruLang ? diar.statusRu() : diar.statusEn(),
        canDownload: !diar.onDisk && !diar.isDownloading,
      },
      lastOutput: queue.lastOutput,
      ru: ruLang,
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

  const local = localPrepare(settings.get);
  const remote = remotePrepare(settings.get);
  const client = () => settings.get().NetworkRole === 'Client';
  const runner: FileRunner = new FileRunner({
    queue,
    load16k,
    // Client role: the decoded audio goes to the host (App.TranscribeRemote); never a local model.
    prepare: () => (client() ? remote() : local()),
    fatal: remoteFatal,
    prefetch: () => !client(),
    options: () => {
      const s = settings.get();
      return { timestamps: s.FileTimestamps, srt: s.FileSrt, extra: [...s.FileExtraFormats], useBrain: s.FileUseBrain, diarize: s.FileDiarize };
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
    runBrain: async (segments, opts, status, signal) => {
      const s = settings.get();
      const kind = FileBrain.target(s);
      if (kind === 'None') {
        return { note: t('мозг не настроен', 'the Brain is not set up') };
      }
      try {
        const result = await FileBrain.runAsync(s, kind, segments, opts.timestamps, status, signal);
        const note =
          result.keptAsIs > 0
            ? t(`мозг · абзацев ${result.paragraphs}, как есть ${result.keptAsIs}`, `brain · ${result.paragraphs} paragraphs, kept as-is ${result.keptAsIs}`)
            : t(`мозг · абзацев ${result.paragraphs}`, `brain · ${result.paragraphs} paragraphs`);
        return { note, text: result.text };
      } catch (e) {
        const msg = e instanceof BrainException || e instanceof Error ? e.message : String(e);
        return { note: msg };
      }
    },
    runDiarize: async (pcm, status, signal) => {
      const diar = getDiarizeRuntime();
      if (!diar.ready) return null;
      status(t('Разделяю спикеров…', 'Separating speakers…'));
      return diar.run(pcm, signal);
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
    diarAbort?.abort();
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
    if (typeof o?.diarize === 'boolean') s.FileDiarize = o.diarize;
    if (Array.isArray(o?.extra)) s.FileExtraFormats = asExtraFormats(o.extra);
    if (typeof o?.parallelism === 'string' && PARALLELISM.includes(o.parallelism)) s.FileParallelism = o.parallelism;
    Settings.save(s);
    return state();
  });

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
  ipcMain.handle('file:diarizeDownload', () => {
    const diar = getDiarizeRuntime();
    if (runner.busy || ffmpegBusy || diarBusy || diar.onDisk) return state();
    diarBusy = true;
    diarAbort = new AbortController();
    diarStatus = t('Скачиваю модели спикеров…', 'Downloading speaker models…');
    void diar
      .download(diarAbort.signal, () => {
        diarStatus = isRussian() ? diar.statusRu() : diar.statusEn();
        push();
      })
      .then(() => (diarStatus = t('Модели спикеров готовы.', 'Speaker models are ready.')))
      .catch((e) => {
        if ((e as Error)?.name === 'AbortError') diarStatus = t('Скачивание спикеров отменено.', 'Speaker download cancelled.');
        else diarStatus = t(`Модели спикеров не скачались: ${(e as Error).message}`, `Speaker models failed: ${(e as Error).message}`);
      })
      .finally(() => {
        diarBusy = false;
        diarAbort = null;
        push();
      });
    return state();
  });

  return {
    busy: () => runner.busy || diarBusy,
    /** A finished meeting recording: queue it and start (or join) the run. */
    enqueue: (path: string) => {
      queue.add([path], false);
      if (!runner.busy && !ffmpegBusy) {
        ffmpegStatus = '';
        void runner.run().catch((e) => Log.write(`file run: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  };
}
