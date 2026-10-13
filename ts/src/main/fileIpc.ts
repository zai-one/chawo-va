// IPC for the «Расшифровка файла» page. The renderer never touches the filesystem: it asks the
// main process to pick, add, run, stop and reveal, and receives queue/status pushes.

import { BrowserWindow, Notification, app, dialog, ipcMain, shell } from 'electron';
import { dirname, join } from 'node:path';
import { FileQueue, FileRunner, Ffmpeg, UrlImport, YtDlp, OPEN_FILTERS, load16k, localPrepare, remoteFatal, remotePrepare } from './file';
import { getDiarizeRuntime } from './diarize';
import * as FileBrain from './brain/fileBrain';
import * as MeetingBrief from './brain/meetingBrief';
import * as Translate from './brain/translate';
import { BrainException } from './brain/speechCleanup';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { toTxt } from '../core/transcriptFormat';
import { scriptCommand } from '../core/postScript';
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
  /** «Кратко и задачи» after transcription (MeetingBriefEnabled). */
  brief: boolean;
}

export interface FileStateDto {
  items: { id: number; path: string; state: string; note: string; outputPath?: string }[];
  status: string;
  busy: boolean;
  options: FileOptionsDto;
  ffmpeg: { line: string; canDownload: boolean; installed: boolean };
  /** «По ссылке»: yt-dlp state, where the audio is saved, whether a link is downloading. */
  url: { line: string; canDownload: boolean; installed: boolean; managed: boolean; busy: boolean; folder: string };
  diarization: { onDisk: boolean; ready: boolean; downloading: boolean; line: string; canDownload: boolean };
  lastOutput: string | null;
  /** «Кратко и задачи» card on the File page. */
  brief: {
    enabled: boolean;
    instruction: string;
    /** Built-in default shown when the saved instruction is empty. */
    defaultInstruction: string;
    /** Where the Brain would run (empty when unavailable). */
    where: string;
    available: boolean;
    /** Last brief text shown in the card (from auto-run or «Составить»). */
    text: string;
    path: string | null;
    busy: boolean;
  };
  /** «Перевести» block on the File page (Brain-based, local by default). */
  translate: {
    /** Saved TranslateTarget (code, name or free text); empty = auto. */
    target: string;
    /** Common languages for the picker; free text is allowed too. */
    languages: { code: string; label: string }[];
    where: string;
    available: boolean;
    /** Last translation shown in the card. */
    text: string;
    path: string | null;
    busy: boolean;
  };
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
  let lastBriefText = '';
  let lastBriefPath: string | null = null;
  let briefBusy = false;
  let briefAbort: AbortController | null = null;
  /** Cloud confirm for this queue run: null = not asked yet, true/false = answer. */
  let briefCloudOk: boolean | null = null;
  let lastTranslateText = '';
  let lastTranslatePath: string | null = null;
  let translateBusy = false;
  let translateAbort: AbortController | null = null;

  const state = (): FileStateDto => {
    const s = settings.get();
    const diar = getDiarizeRuntime();
    const ruLang = isRussian();
    return {
      items: queue.snapshot(),
      status: ffmpegStatus || diarStatus || runner.status,
      busy: runner.busy || ffmpegBusy || urlImport.busy || diarBusy || briefBusy || translateBusy,
      options: { timestamps: s.FileTimestamps, srt: s.FileSrt, extra: [...s.FileExtraFormats], parallelism: s.FileParallelism, diarize: s.FileDiarize, brief: s.MeetingBriefEnabled },
      ffmpeg: { line: Ffmpeg.statusLine(), canDownload: Ffmpeg.canDownload(), installed: Ffmpeg.isInstalled() },
      url: {
        line: YtDlp.statusLine(),
        canDownload: YtDlp.canDownload(),
        installed: YtDlp.find() !== null,
        managed: YtDlp.isManaged(),
        busy: urlImport.busy || ytdlpBusy,
        folder: urlFolder(),
      },
      diarization: {
        onDisk: diar.onDisk,
        ready: diar.ready,
        downloading: diar.isDownloading,
        line: ruLang ? diar.statusRu() : diar.statusEn(),
        canDownload: !diar.onDisk && !diar.isDownloading,
      },
      lastOutput: queue.lastOutput,
      brief: {
        enabled: s.MeetingBriefEnabled,
        instruction: s.MeetingBriefInstruction,
        defaultInstruction: MeetingBrief.defaultInstruction(),
        where: MeetingBrief.target(s) === 'None' ? '' : MeetingBrief.describe(s),
        available: MeetingBrief.target(s) !== 'None',
        text: lastBriefText,
        path: lastBriefPath,
        busy: briefBusy,
      },
      translate: {
        target: s.TranslateTarget,
        languages: Translate.commonLanguages().map((l) => ({ code: l.code, label: ruLang ? l.ru : l.name })),
        where: Translate.target(s) === 'None' ? '' : Translate.describe(s),
        available: Translate.target(s) !== 'None',
        text: lastTranslateText,
        path: lastTranslatePath,
        busy: translateBusy,
      },
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
      return {
        timestamps: s.FileTimestamps, srt: s.FileSrt, extra: [...s.FileExtraFormats], useBrain: s.FileUseBrain, diarize: s.FileDiarize, brief: s.MeetingBriefEnabled,
        postScript: s.PostScriptFiles ? scriptCommand(s.PostScript) : null,
      };
    },
    status: () => {
      // The queue speaks again: its line replaces the last download/ffmpeg line.
      if (!urlImport.busy && !ffmpegBusy && !ytdlpBusy) ffmpegStatus = '';
      push();
    },
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
    runBrief: async (segments, opts, status, signal) => {
      const s = settings.get();
      let kind = MeetingBrief.target(s);
      if (kind === 'None') {
        return { note: t('краткое: мозг не настроен', 'brief: the Brain is not set up') };
      }
      if (kind === 'Cloud') {
        const cloud = MeetingBrief.cloudName(s);
        if (cloud) {
          if (briefCloudOk === null) {
            const w = getWindow();
            const question = t(`Текст уйдёт в ${cloud}. Составить «Кратко и задачи»?`, `The text will be sent to ${cloud}. Build the brief and tasks?`);
            const box = { type: 'question' as const, buttons: [t('Да', 'Yes'), t('Нет', 'No')], defaultId: 0, cancelId: 1, title: t('Кратко и задачи', 'Brief and tasks'), message: question };
            const r = w ? await dialog.showMessageBox(w, box) : await dialog.showMessageBox(box);
            briefCloudOk = r.response === 0;
          }
          if (!briefCloudOk) return { note: t('краткое пропущено', 'brief skipped') };
        }
      }
      try {
        const transcript = toTxt(segments, opts.timestamps);
        const result = await MeetingBrief.runBriefAsync({
          settings: s,
          targetKind: kind,
          transcript,
          instruction: s.MeetingBriefInstruction,
          status,
          signal,
        });
        lastBriefText = result.text;
        lastBriefPath = MeetingBrief.outputPath(opts.rawTxtPath);
        const note = result.warning
          ? t(`краткое · ${result.warning}`, `brief · ${result.warning}`)
          : t('краткое и задачи', 'brief and tasks');
        return { note, text: result.text };
      } catch (e) {
        const msg = e instanceof BrainException || e instanceof Error ? e.message : String(e);
        return { note: t(`краткое: ${msg}`, `brief: ${msg}`) };
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

  const urlFolder = () => join(app.getPath('downloads'), 'Chawo');
  let ytdlpBusy = false;
  const urlImport: UrlImport = new UrlImport({
    findYtDlp: () => YtDlp.find(),
    fetchAudio: (url, outDir, progress, signal) => YtDlp.fetchAudio(url, outDir, { progress, signal }),
    outDir: urlFolder,
    enqueue: (path) => void queue.add([path], false),
    runQueue: () => {
      if (runner.busy) return;
      void runner.run().catch((e) => Log.write(`file run: ${e instanceof Error ? e.message : String(e)}`));
    },
    changed: () => {
      ffmpegStatus = urlImport.status;
      push();
    },
  });

  ipcMain.handle('file:url', (_e, url: unknown) => {
    if (ffmpegBusy || ytdlpBusy || typeof url !== 'string') return state();
    void urlImport.start(url).then((p) => p && Log.write(`url → ${p}`));
    return state();
  });

  ipcMain.handle('file:ytdlpDownload', () => {
    if (urlImport.busy || ytdlpBusy || !YtDlp.canDownload()) return state();
    ytdlpBusy = true;
    ytdlpAbort = new AbortController();
    ffmpegStatus = t('Скачиваю yt-dlp…', 'Downloading yt-dlp…');
    push();
    void YtDlp.downloadAsync((line) => {
      ffmpegStatus = line;
      push();
    }, ytdlpAbort.signal)
      .catch((e) => (ffmpegStatus = t(`yt-dlp не скачался: ${(e as Error).message}`, `yt-dlp download failed: ${(e as Error).message}`)))
      .finally(() => {
        ytdlpBusy = false;
        ytdlpAbort = null;
        push();
      });
    return state();
  });
  let ytdlpAbort: AbortController | null = null;

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
    briefCloudOk = null;
    void runner.run().catch((e) => Log.write(`file run: ${e instanceof Error ? e.message : String(e)}`));
    return state();
  });

  ipcMain.handle('file:stop', () => {
    runner.stop();
    urlImport.stop();
    ffmpegAbort?.abort();
    ytdlpAbort?.abort();
    diarAbort?.abort();
    briefAbort?.abort();
    translateAbort?.abort();
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
    if (typeof o?.brief === 'boolean') s.MeetingBriefEnabled = o.brief;
    if (Array.isArray(o?.extra)) s.FileExtraFormats = asExtraFormats(o.extra);
    if (typeof o?.parallelism === 'string' && PARALLELISM.includes(o.parallelism)) s.FileParallelism = o.parallelism;
    Settings.save(s);
    return state();
  });

  ipcMain.handle('file:ffmpegDownload', () => {
    if (runner.busy || ffmpegBusy || urlImport.busy || ytdlpBusy || !Ffmpeg.canDownload()) return state();
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
    if (runner.busy || ffmpegBusy || urlImport.busy || ytdlpBusy || diarBusy || diar.onDisk) return state();
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


  ipcMain.handle('file:briefInstruction', (_e, text: unknown) => {
    const s = settings.get();
    if (typeof text === 'string') {
      s.MeetingBriefInstruction = text;
      Settings.save(s);
    }
    return state();
  });

  ipcMain.handle('file:runBrief', async (_e, path: unknown) => {
    if (briefBusy || runner.busy) return state();
    const s = settings.get();
    const kind = MeetingBrief.target(s);
    if (kind === 'None') {
      ffmpegStatus = t('Мозг не настроен — откройте «Мозг».', 'The Brain is not set up — open Brain.');
      return state();
    }
    const src =
      typeof path === 'string' && path.length > 0
        ? path
        : queue.lastOutput;
    if (!src || !existsSync(src)) {
      ffmpegStatus = t('Нет готовой расшифровки. Сначала расшифруйте файл или встречу.', 'No finished transcript. Transcribe a file or a meeting first.');
      return state();
    }
    if (kind === 'Cloud') {
      const cloud = MeetingBrief.cloudName(s);
      if (cloud) {
        const w = getWindow();
        const question = t(`Текст уйдёт в ${cloud}. Составить «Кратко и задачи»?`, `The text will be sent to ${cloud}. Build the brief and tasks?`);
        const box = { type: 'question' as const, buttons: [t('Да', 'Yes'), t('Нет', 'No')], defaultId: 0, cancelId: 1, title: t('Кратко и задачи', 'Brief and tasks'), message: question };
        const r = w ? await dialog.showMessageBox(w, box) : await dialog.showMessageBox(box);
        if (r.response !== 0) {
          ffmpegStatus = t('Краткое пропущено.', 'Brief skipped.');
          return state();
        }
      }
    }
    briefBusy = true;
    briefAbort = new AbortController();
    ffmpegStatus = t('Мозг: «Кратко и задачи»…', 'Brain: brief and tasks…');
    push();
    try {
      const transcript = readFileSync(src, 'utf8');
      const result = await MeetingBrief.runBriefAsync({
        settings: s,
        targetKind: kind,
        transcript,
        instruction: s.MeetingBriefInstruction,
        status: (line) => {
          ffmpegStatus = line;
          push();
        },
        signal: briefAbort.signal,
      });
      const out = MeetingBrief.outputPath(src);
      writeFileSync(out, result.text, 'utf8');
      lastBriefText = result.text;
      lastBriefPath = out;
      ffmpegStatus = result.warning
        ? t(`Краткое готово с замечанием: ${result.warning}`, `Brief ready with a note: ${result.warning}`)
        : t(`Краткое и задачи: ${out}`, `Brief and tasks: ${out}`);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') ffmpegStatus = t('Краткое отменено.', 'Brief cancelled.');
      else {
        const msg = e instanceof BrainException || e instanceof Error ? e.message : String(e);
        ffmpegStatus = t(`Краткое не получилось: ${msg}`, `Brief failed: ${msg}`);
        Log.write(`file runBrief: ${msg}`);
      }
    } finally {
      briefBusy = false;
      briefAbort = null;
      push();
    }
    return state();
  });

  ipcMain.handle('file:translateTarget', (_e, text: unknown) => {
    const s = settings.get();
    if (typeof text === 'string') {
      s.TranslateTarget = text.trim();
      Settings.save(s);
    }
    return state();
  });

  ipcMain.handle('file:runTranslate', async (_e, to: unknown, path: unknown) => {
    if (translateBusy || briefBusy || runner.busy) return state();
    const s = settings.get();
    if (typeof to === 'string') {
      s.TranslateTarget = to.trim();
      Settings.save(s);
    }
    const kind = Translate.target(s);
    if (kind === 'None') {
      ffmpegStatus = t('Мозг не настроен — откройте «Мозг».', 'The Brain is not set up — open Brain.');
      return state();
    }
    const src = typeof path === 'string' && path.length > 0 ? path : queue.lastOutput;
    if (!src || !existsSync(src)) {
      ffmpegStatus = t('Нет готовой расшифровки. Сначала расшифруйте файл или встречу.', 'No finished transcript. Transcribe a file or a meeting first.');
      return state();
    }
    if (kind === 'Cloud') {
      const cloud = Translate.cloudName(s);
      if (cloud) {
        const w = getWindow();
        const question = t(`Текст уйдёт в ${cloud}. Перевести?`, `The text will be sent to ${cloud}. Translate?`);
        const box = { type: 'question' as const, buttons: [t('Да', 'Yes'), t('Нет', 'No')], defaultId: 0, cancelId: 1, title: t('Перевод', 'Translation'), message: question };
        const r = w ? await dialog.showMessageBox(w, box) : await dialog.showMessageBox(box);
        if (r.response !== 0) {
          ffmpegStatus = t('Перевод пропущен.', 'Translation skipped.');
          return state();
        }
      }
    }
    translateBusy = true;
    translateAbort = new AbortController();
    ffmpegStatus = t('Мозг: перевожу…', 'Brain: translating…');
    push();
    try {
      const result = await Translate.translateFileAsync(
        src,
        {
          settings: s,
          targetKind: kind,
          saved: s.TranslateTarget,
          status: (line) => {
            ffmpegStatus = line;
            push();
          },
          signal: translateAbort.signal,
        },
        { readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, text) => writeFileSync(p, text, 'utf8') },
      );
      lastTranslateText = result.text;
      lastTranslatePath = result.path;
      ffmpegStatus = t(`Перевод: ${result.path}`, `Translation: ${result.path}`);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') ffmpegStatus = t('Перевод отменён.', 'Translation cancelled.');
      else {
        const msg = e instanceof BrainException || e instanceof Error ? e.message : String(e);
        ffmpegStatus = t(`Перевод не получился: ${msg}`, `Translation failed: ${msg}`);
        Log.write(`file runTranslate: ${msg}`);
      }
    } finally {
      translateBusy = false;
      translateAbort = null;
      push();
    }
    return state();
  });

  return {
    busy: () => runner.busy || urlImport.busy || diarBusy || briefBusy || translateBusy,
    /** A finished meeting recording: queue it and start (or join) the run. */
    enqueue: (path: string) => {
      queue.add([path], false);
      if (!runner.busy && !ffmpegBusy) {
        ffmpegStatus = '';
        briefCloudOk = null;
        void runner.run().catch((e) => Log.write(`file run: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  };
}
