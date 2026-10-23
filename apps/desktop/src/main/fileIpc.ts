// IPC for the «Расшифровка файла» page. The renderer never touches the filesystem: it asks the
// main process to pick, add, run, stop and reveal, and receives queue/status pushes.

import { BrowserWindow, Notification, app, clipboard, dialog, shell } from 'electron';
import { withContext } from '@chawo/core/brainContext';
import { dirname, join } from 'node:path';
import { FileQueue, FileRunner, Ffmpeg, UrlImport, YtDlp, OPEN_FILTERS, load16k, localPrepare, remoteFatal, remotePrepare } from '@chawo/engine/file/index';
import { diarizeHook, getDiarizeRuntime } from '@chawo/engine/diarize/index';
import * as FileBrain from '@chawo/engine/brain/fileBrain';
import * as MeetingBrief from '@chawo/engine/brain/meetingBrief';
import * as BriefTemplates from '@chawo/engine/brain/briefTemplates';
import { briefTemplatesPath as BriefTemplates_path, checklistsPath } from '@chawo/engine/paths';
import * as CallScore from '@chawo/engine/brain/callScore';
import * as Translate from '@chawo/engine/brain/translate';
import { BrainException } from '@chawo/engine/brain/speechCleanup';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadTimedTranscript, toTxt, type TranscriptSegment } from '@chawo/core/transcriptFormat';
import { siblingAudioCandidates } from '@chawo/core/localMedia';
import { computeCallStats, DEFAULT_TRACKERS_TEXT, parseTrackers, type CallStats } from '@chawo/core/callStats';
import { allowMediaPath, isMediaAllowed, mediaUrlFor } from './localMediaProtocol';
import { scriptCommand } from '@chawo/core/postScript';
import * as Settings from '@chawo/engine/settings';
import { asExtraFormats, type SettingsData, type SettingsFileParallelism } from '@chawo/engine/settings';
import { isRussian, t } from '@chawo/core/strings';
import * as Log from '@chawo/engine/log';
import { editTranscriptPhrase } from '@chawo/core/transcriptEdit';
import { learnFromEdit } from '@chawo/engine/dictionary/learnedWords';
import type { FileEditorDto, FileEditorSegmentDto, FileStateDto } from '@chawo/ipc/contract';
import { emit, handle } from './ipc';

const PARALLELISM: readonly SettingsFileParallelism[] = ['Auto', 'Gentle1', 'Two', 'Four', 'Max'];

export function registerFileIpc(getWindow: () => BrowserWindow | null, settings: { get: () => SettingsData }): { busy: () => boolean; enqueue: (path: string) => void } {
  const queue = new FileQueue();
  let ffmpegBusy = false;
  /** The page's line for the link, the Brain cards and errors; the run's own line wins while it runs. */
  let ffmpegStatus = '';
  /** ffmpeg download progress/result, shown in the ffmpeg box (downloads run alongside each other). */
  let ffmpegLine = '';
  let diarBusy = false;
  let ffmpegAbort: AbortController | null = null;
  let diarAbort: AbortController | null = null;
  let lastBriefText = '';
  let lastBriefPath: string | null = null;
  let briefBusy = false;
  let briefTemplateNote = '';
  const customTemplates = () => BriefTemplates.loadCustom(BriefTemplates_path());
  /** Instruction for the Brain: the selected template, else the own instruction, else the default. */
  const briefInstructionFor = (s: SettingsData) => BriefTemplates.resolveInstruction(s.MeetingBriefTemplate, s.MeetingBriefInstruction, customTemplates()).instruction;
  let briefAbort: AbortController | null = null;
  /** Cloud confirm for this queue run: null = not asked yet, true/false = answer. */
  let briefCloudOk: boolean | null = null;
  let lastScore: CallScore.ScoreResult | null = null;
  let lastScorePath: string | null = null;
  let scoreBusy = false;
  let scoreNote = '';
  let scoreAbort: AbortController | null = null;
  /** Cloud consent for this queue run, tied to the service it was given for (a provider switch asks again). */
  let scoreCloudOk: { cloud: string; ok: boolean } | null = null;
  const customChecklists = () => CallScore.loadCustom(checklistsPath());
  const checklistFor = (s: SettingsData) => CallScore.resolveChecklist(s.CallScoreChecklist, customChecklists());
  /** One scoring pass; writes .score.json/.txt beside rawTxt. Throws on Brain failure. */
  const scoreOne = async (s: SettingsData, kind: 'Local' | 'Cloud', transcript: string, rawTxt: string, status: (l: string) => void, signal: AbortSignal) => {
    const r = await CallScore.scoreAsync({ transcript, checklist: checklistFor(s), targetKind: kind, ask: FileBrain.createAsk(s, kind), status, signal, source: rawTxt });
    const p = CallScore.saveResult(rawTxt, r);
    lastScore = r;
    lastScorePath = p.txt;
    return r;
  };
  const askCloud = async (cloud: string) => {
    const w = getWindow();
    const box = { type: 'question' as const, buttons: [t('Да', 'Yes'), t('Нет', 'No')], defaultId: 0, cancelId: 1, title: t('Проверка по чек-листу', 'Checklist score'), message: t(`Текст уйдёт в ${cloud}. Проверить звонок по чек-листу?`, `The text will be sent to ${cloud}. Score the call against the checklist?`) };
    const r = w ? await dialog.showMessageBox(w, box) : await dialog.showMessageBox(box);
    return r.response === 0;
  };
  let lastTranslateText = '';
  let lastTranslatePath: string | null = null;
  let translateBusy = false;
  let translateAbort: AbortController | null = null;

  /** Transcript the editor card shows; null = follow queue.lastOutput. */
  let editorFocus: string | null = null;
  /** Line under the editor after a phrase fix. */
  let editorNote = '';
  let editorCache: FileEditorDto = emptyEditor();

  // Stats are recomputed only when the editor's phrases or the trackers text change.
  let statsFor: { editor: FileEditorDto; trackers: string; stats: CallStats | null } | null = null;
  function callStatsDto(trackers: string): FileStateDto['callStats'] {
    if (!statsFor || statsFor.editor !== editorCache || statsFor.trackers !== trackers) {
      const segs = editorCache.segments;
      statsFor = { editor: editorCache, trackers, stats: segs.length > 0 ? computeCallStats(segs, parseTrackers(trackers)) : null };
    }
    return { stats: statsFor.stats, trackers: trackers.trim() ? trackers : DEFAULT_TRACKERS_TEXT, defaultTrackers: DEFAULT_TRACKERS_TEXT };
  }

  /** Bumped on every rebuild: the window keeps its phrase list while the number stays the same. */
  let editorRev = 0;
  function emptyEditor(): FileEditorDto {
    return { available: false, reason: 'missing', audioPath: null, txtPath: null, segments: [], mediaUrl: null };
  }

  function readText(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  function findAudioFor(txtPath: string): string | null {
    const item = queue.snapshot().find((i) => i.outputPath && (i.outputPath === txtPath));
    if (item?.path && existsSync(item.path)) return item.path;
    for (const c of siblingAudioCandidates(txtPath)) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  function reasonMessage(reason: string | undefined, hasAudio: boolean): string | undefined {
    if (!hasAudio && reason !== 'missing') return 'no-audio';
    return reason;
  }

  function buildEditor(txtPath: string | null): FileEditorDto {
    if (!txtPath) {
      allowMediaPath(null);
      return emptyEditor();
    }
    const loaded = loadTimedTranscript(txtPath, readText);
    const audioPath = findAudioFor(txtPath);
    if (!loaded.available) {
      allowMediaPath(audioPath);
      return {
        available: false,
        reason: reasonMessage(loaded.reason, Boolean(audioPath)),
        audioPath,
        txtPath,
        segments: [],
        mediaUrl: audioPath ? mediaUrlFor(audioPath) : null,
        sourceHint: loaded.sourceHint,
      };
    }
    if (!audioPath) {
      allowMediaPath(null);
      return {
        available: false,
        reason: 'no-audio',
        audioPath: null,
        txtPath,
        segments: loaded.segments.map(segDto),
        mediaUrl: null,
        sourceHint: loaded.sourceHint,
      };
    }
    allowMediaPath(audioPath);
    return {
      available: true,
      audioPath,
      txtPath,
      segments: loaded.segments.map(segDto),
      mediaUrl: mediaUrlFor(audioPath),
      sourceHint: loaded.sourceHint,
    };
  }

  function segDto(s: TranscriptSegment): FileEditorSegmentDto {
    return typeof s.speaker === 'number'
      ? { start: s.start, end: s.end, text: s.text, speaker: s.speaker }
      : { start: s.start, end: s.end, text: s.text };
  }

  let editorLoadedFor: string | null | undefined = undefined;

  function refreshEditor(force = false): FileEditorDto {
    const focus = editorFocus || queue.lastOutput;
    if (!force && focus === editorLoadedFor) return editorCache;
    editorLoadedFor = focus;
    editorCache = { ...buildEditor(focus ?? null), rev: ++editorRev };
    return editorCache;
  }

  const state = (): FileStateDto => {
    const s = settings.get();
    const diar = getDiarizeRuntime();
    const ruLang = isRussian();
    // Read once per state: these come from files on disk, and a long run pushes state several times a second.
    const templates = customTemplates();
    const checklists = customChecklists();
    const target = MeetingBrief.target(s);
    return {
      items: queue.snapshot(),
      // While the queue runs its line (piece N of M, speakers…) is what the page shows; a download's
      // line stays in its own box and never hides it.
      status: runner.busy ? runner.status || ffmpegStatus : ffmpegStatus || runner.status,
      progress: runner.progress,
      // «Остановить» stops the transcription and the Brain jobs; downloads have their own «Отменить».
      busy: runner.busy || urlImport.busy || briefBusy || translateBusy || scoreBusy,
      options: { timestamps: s.FileTimestamps, srt: s.FileSrt, extra: [...s.FileExtraFormats], parallelism: s.FileParallelism, diarize: s.FileDiarize, brief: s.MeetingBriefEnabled, score: s.CallScoreEnabled },
      ffmpeg: { line: ffmpegLine || Ffmpeg.statusLine(), canDownload: Ffmpeg.canDownload(), installed: Ffmpeg.isInstalled(), busy: ffmpegBusy },
      url: {
        line: YtDlp.statusLine(),
        canDownload: YtDlp.canDownload(),
        installed: YtDlp.find() !== null,
        managed: YtDlp.isManaged(),
        busy: urlImport.busy || ytdlpBusy,
        downloading: ytdlpBusy,
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
        template: BriefTemplates.resolveInstruction(s.MeetingBriefTemplate, s.MeetingBriefInstruction, templates).id,
        templates: BriefTemplates.allTemplates(templates).map((x) => ({ id: x.id, name: x.name, builtin: x.builtin, instruction: x.instruction })),
        templateNote: briefTemplateNote,
        where: target === 'None' ? '' : MeetingBrief.describe(s),
        available: target !== 'None',
        text: lastBriefText,
        path: lastBriefPath,
        busy: briefBusy,
      },
      score: {
        enabled: s.CallScoreEnabled,
        checklist: CallScore.resolveChecklist(s.CallScoreChecklist, checklists).id,
        checklists: CallScore.allChecklists(checklists).map((x) => ({ id: x.id, name: x.name, builtin: x.builtin, items: x.items })),
        note: scoreNote,
        where: target === 'None' ? '' : MeetingBrief.describe(s),
        available: target !== 'None',
        result: lastScore,
        path: lastScorePath,
        busy: scoreBusy,
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
      editor: { ...refreshEditor(), note: editorNote },
      callStats: callStatsDto(s.CallTrackers),
    };
  };

  // Status pushes during a long file come many times a second; the window gets at most four a second,
  // each one a full page state (it re-renders the page), so the run does not make the window lag.
  let pushTimer: NodeJS.Timeout | null = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      emit(getWindow(), 'file:state', state());
    }, 250);
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
        timestamps: s.FileTimestamps, srt: s.FileSrt, extra: [...s.FileExtraFormats], useBrain: s.FileUseBrain, diarize: s.FileDiarize, brief: s.MeetingBriefEnabled, score: s.CallScoreEnabled,
        postScript: s.PostScriptFiles ? scriptCommand(s.PostScript) : null,
      };
    },
    status: () => {
      // The queue speaks again: its line replaces the last link/Brain line.
      if (!urlImport.busy && !ytdlpBusy) ffmpegStatus = '';
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
        // «Контекст для Мозга»: on the file page only the clipboard, and only when that switch is on.
        const ctx = await FileBrain.fileBrainContext(s, () => clipboard.readText());
        if (ctx) Log.write(`file brain context: ${ctx.length} chars`);
        const result = await FileBrain.runAsync(s, kind, segments, opts.timestamps, status, signal, ctx ? withContext(FileBrain.createAsk(s, kind), ctx) : undefined);
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
      const kind = MeetingBrief.target(s);
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
          instruction: briefInstructionFor(s),
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
    runScore: async (segments, opts, status, signal) => {
      const s = settings.get();
      const kind = MeetingBrief.target(s);
      if (kind === 'None') return { note: t('чек-лист: мозг не настроен', 'checklist: the Brain is not set up') };
      if (kind === 'Cloud') {
        const cloud = MeetingBrief.cloudName(s);
        if (cloud) {
          if (scoreCloudOk?.cloud !== cloud) scoreCloudOk = { cloud, ok: await askCloud(cloud) };
          if (!scoreCloudOk.ok) return { note: t('чек-лист пропущен', 'checklist skipped') };
        }
      }
      try {
        const r = await scoreOne(s, kind, toTxt(segments, opts.timestamps), opts.rawTxtPath, status, signal);
        return { note: t(`чек-лист ${r.percent}%`, `checklist ${r.percent}%`) };
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        const msg = e instanceof Error ? e.message : String(e);
        return { note: t(`чек-лист: ${msg}`, `checklist: ${msg}`) };
      }
    },
    runDiarize: diarizeHook(getDiarizeRuntime, () => t('Разделяю спикеров…', 'Separating speakers…')),
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
      // A new run from «По ссылке»: consent from an earlier run does not carry over.
      briefCloudOk = null;
      scoreCloudOk = null;
      void runner.run().catch((e) => Log.write(`file run: ${e instanceof Error ? e.message : String(e)}`));
    },
    changed: () => {
      ffmpegStatus = urlImport.status;
      push();
    },
  });

  handle('file:url', (_e, url: unknown) => {
    if (ffmpegBusy || ytdlpBusy || typeof url !== 'string') return state();
    void urlImport.start(url).then((p) => p && Log.write(`url → ${p}`));
    return state();
  });

  handle('file:ytdlpDownload', () => {
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

  handle('file:state', () => state());

  handle('file:add', (_e, paths: unknown, onlyAudio: unknown) => {
    if (!Array.isArray(paths)) return state();
    const r = queue.add(paths.filter((p): p is string => typeof p === 'string'), onlyAudio === true);
    if (r.added === 0 && r.skipped > 0) {
      ffmpegStatus = '';
      emit(getWindow(), 'file:toast', t('Ничего не добавлено: не аудио или уже в очереди.', 'Nothing added: not audio or already queued.'));
    }
    return state();
  });

  handle('file:pick', async (_e, kind: unknown) => {
    const w = getWindow();
    const folder = kind === 'folder';
    const opts: Electron.OpenDialogOptions = folder
      ? { title: t('Папка с записями', 'Folder with recordings'), properties: ['openDirectory'] }
      : { title: t('Записи для расшифровки', 'Recordings to transcribe'), properties: ['openFile', 'multiSelections'], filters: [...OPEN_FILTERS] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (!r.canceled && r.filePaths.length > 0) queue.add(r.filePaths, false);
    return state();
  });

  handle('file:remove', (_e, id: unknown) => {
    if (typeof id === 'number') queue.remove(id);
    return state();
  });

  handle('file:clearFinished', () => {
    for (const i of queue.snapshot()) if (i.state !== 'Queued' && i.state !== 'Running') queue.remove(i.id);
    return state();
  });

  handle('file:run', () => {
    if (ffmpegBusy) {
      // ffmpeg is being replaced: decoding could pick a half-written file.
      ffmpegStatus = t('Сейчас скачивается ffmpeg — нажмите «Расшифровать», когда он будет готов.', 'ffmpeg is downloading — press Transcribe when it is ready.');
      return state();
    }
    ffmpegStatus = '';
    briefCloudOk = null;
    scoreCloudOk = null;
    void runner.run().catch((e) => Log.write(`file run: ${e instanceof Error ? e.message : String(e)}`));
    return state();
  });

  handle('file:stop', () => {
    runner.stop();
    urlImport.stop();
    briefAbort?.abort();
    translateAbort?.abort();
    scoreAbort?.abort();
    return state();
  });

  handle('file:reveal', (_e, path: unknown) => {
    const p = typeof path === 'string' ? path : queue.lastOutput;
    if (p) shell.showItemInFolder(p);
    else if (typeof path === 'string') void shell.openPath(dirname(path));
    return true;
  });

  handle('file:options', (_e, raw: unknown) => {
    const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const s = settings.get();
    if (typeof o.timestamps === 'boolean') s.FileTimestamps = o.timestamps;
    if (typeof o.srt === 'boolean') s.FileSrt = o.srt;
    if (typeof o.diarize === 'boolean') s.FileDiarize = o.diarize;
    if (typeof o.brief === 'boolean') s.MeetingBriefEnabled = o.brief;
    if (typeof o.score === 'boolean') s.CallScoreEnabled = o.score;
    if (Array.isArray(o.extra)) s.FileExtraFormats = asExtraFormats(o.extra);
    const parallelism = PARALLELISM.find((p) => p === o.parallelism);
    if (parallelism) s.FileParallelism = parallelism;
    Settings.save(s);
    return state();
  });

  // Downloads (ffmpeg, speaker models, yt-dlp) run side by side, each with its line in its own box.
  handle('file:ffmpegDownload', () => {
    // A running decode may hold the old ffmpeg open; the page disables the button meanwhile.
    if (ffmpegBusy || runner.busy || urlImport.busy || !Ffmpeg.canDownload()) return state();
    ffmpegBusy = true;
    ffmpegAbort = new AbortController();
    const signal = ffmpegAbort.signal;
    ffmpegLine = t('Скачиваю ffmpeg…', 'Downloading ffmpeg…');
    void Ffmpeg.downloadAsync((line) => {
      ffmpegLine = line;
      push();
    }, signal)
      .then((p) => (ffmpegLine = t(`ffmpeg готов: ${p}`, `ffmpeg ready: ${p}`)))
      .catch((e) => (ffmpegLine = signal.aborted ? t('Скачивание ffmpeg отменено.', 'ffmpeg download cancelled.') : t(`ffmpeg не скачался: ${(e as Error).message}`, `ffmpeg download failed: ${(e as Error).message}`)))
      .finally(() => {
        ffmpegBusy = false;
        ffmpegAbort = null;
        push();
      });
    return state();
  });
  // The models land in place only when complete (diarizeModels renames the folder), so a run going on
  // meanwhile just does without speakers until they are there. Progress and errors: the Speakers box.
  handle('file:diarizeDownload', () => {
    const diar = getDiarizeRuntime();
    if (diarBusy || diar.onDisk || diar.isDownloading) return state();
    diarBusy = true;
    diarAbort = new AbortController();
    void diar
      .download(diarAbort.signal, () => push())
      .catch(() => undefined)
      .finally(() => {
        diarBusy = false;
        diarAbort = null;
        push();
      });
    return state();
  });

  handle('file:cancelDownload', (_e, kind: unknown) => {
    if (kind === 'ffmpeg') ffmpegAbort?.abort();
    else if (kind === 'diarize') diarAbort?.abort();
    else if (kind === 'ytdlp') ytdlpAbort?.abort();
    return state();
  });


  handle('file:briefTemplate', (_e, id: unknown) => {
    const s = settings.get();
    briefTemplateNote = '';
    if (typeof id === 'string' && (id === BriefTemplates.OWN || BriefTemplates.findTemplate(id, customTemplates()))) {
      s.MeetingBriefTemplate = id;
      Settings.save(s);
    }
    return state();
  });

  handle('file:saveBriefTemplate', (_e, name: unknown, instruction: unknown) => {
    const s = settings.get();
    const n = typeof name === 'string' ? name.trim() : '';
    const body = typeof instruction === 'string' ? instruction.trim() : '';
    const list = customTemplates();
    // Updates reuse an existing custom name; new names go through nameProblem (empty / builtin / too long).
    const exists = list.some((x) => x.name.toLowerCase().replace(/ё/g, 'е') === n.toLowerCase().replace(/ё/g, 'е'));
    const nameErr = exists ? null : BriefTemplates.nameProblem(n);
    const bodyErr = body ? null : t('Инструкция пустая.', 'The instruction is empty.');
    briefTemplateNote = nameErr ?? bodyErr ?? '';
    if (!briefTemplateNote) {
      try {
        BriefTemplates.saveCustom(BriefTemplates_path(), BriefTemplates.upsertCustom(list, { name: n, instruction: body }));
        s.MeetingBriefTemplate = BriefTemplates.findTemplate(n, customTemplates())?.id ?? n;
        Settings.save(s);
      } catch (e) {
        briefTemplateNote = t('Не удалось сохранить шаблон: ', 'Could not save the template: ') + (e instanceof Error ? e.message : String(e));
      }
    }
    return state();
  });

  handle('file:deleteBriefTemplate', (_e, name: unknown) => {
    const s = settings.get();
    briefTemplateNote = '';
    if (typeof name === 'string') {
      const tpl = BriefTemplates.findTemplate(name, customTemplates());
      if (tpl && !tpl.builtin) {
        BriefTemplates.saveCustom(BriefTemplates_path(), BriefTemplates.removeCustom(customTemplates(), tpl.name));
        if (BriefTemplates.findTemplate(s.MeetingBriefTemplate, customTemplates()) === null) {
          s.MeetingBriefTemplate = BriefTemplates.OWN;
          Settings.save(s);
        }
      }
    }
    return state();
  });

  handle('file:briefInstruction', (_e, text: unknown) => {
    const s = settings.get();
    if (typeof text === 'string') {
      s.MeetingBriefInstruction = text;
      // Free-text wins: clear any template selection so resolveInstruction uses this body.
      s.MeetingBriefTemplate = BriefTemplates.OWN;
      briefTemplateNote = '';
      Settings.save(s);
    }
    return state();
  });

  handle('file:runBrief', async (_e, path: unknown) => {
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
        instruction: briefInstructionFor(s),
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

  handle('file:scoreChecklist', (_e, id: unknown) => {
    const s = settings.get();
    scoreNote = '';
    const c = typeof id === 'string' ? CallScore.findChecklist(id, customChecklists()) : null;
    if (c) {
      s.CallScoreChecklist = c.builtin ? c.id : c.name;
      Settings.save(s);
    }
    return state();
  });

  handle('file:saveChecklist', (_e, name: unknown, items: unknown) => {
    const s = settings.get();
    const n = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    const list = customChecklists();
    const parsed = CallScore.parseItems(typeof items === 'string' || Array.isArray(items) ? (items as string | string[]) : '');
    const existing = CallScore.findChecklist(n, list);
    const nameErr = existing && !existing.builtin ? null : CallScore.nameProblem(n);
    scoreNote = nameErr ?? (parsed.length === 0 ? t('Добавьте хотя бы один пункт.', 'Add at least one item.') : '');
    if (!scoreNote) {
      try {
        CallScore.saveCustom(checklistsPath(), CallScore.upsertCustom(list, { name: existing?.name ?? n, items: parsed }));
        s.CallScoreChecklist = existing?.name ?? n;
        Settings.save(s);
      } catch (e) {
        scoreNote = t('Не удалось сохранить чек-лист: ', 'Could not save the checklist: ') + (e instanceof Error ? e.message : String(e));
      }
    }
    return state();
  });

  handle('file:deleteChecklist', (_e, name: unknown) => {
    const s = settings.get();
    scoreNote = '';
    const c = typeof name === 'string' ? CallScore.findChecklist(name, customChecklists()) : null;
    if (c && !c.builtin) {
      CallScore.saveCustom(checklistsPath(), CallScore.removeCustom(customChecklists(), c.name));
      if (!CallScore.findChecklist(s.CallScoreChecklist, customChecklists())) {
        s.CallScoreChecklist = '';
        Settings.save(s);
      }
    }
    return state();
  });

  handle('file:runScore', async (_e, path: unknown) => {
    if (scoreBusy || runner.busy) return state();
    scoreNote = '';
    const s = settings.get();
    const kind = MeetingBrief.target(s);
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
      const cloud = MeetingBrief.cloudName(s);
      if (cloud && !(await askCloud(cloud))) {
        ffmpegStatus = t('Проверка пропущена.', 'Scoring skipped.');
        return state();
      }
    }
    scoreBusy = true;
    scoreAbort = new AbortController();
    ffmpegStatus = t('Мозг: проверяю по чек-листу…', 'Brain: checking against the checklist…');
    push();
    try {
      const r = await scoreOne(s, kind, readFileSync(src, 'utf8'), src, (line) => { ffmpegStatus = line; push(); }, scoreAbort.signal);
      ffmpegStatus = t(`Чек-лист: ${String(r.score).replace('.', ',')} из ${r.max} (${r.percent}%) — ${lastScorePath}`, `Checklist: ${r.score} of ${r.max} (${r.percent}%) — ${lastScorePath}`);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') ffmpegStatus = t('Проверка отменена.', 'Scoring cancelled.');
      else {
        const msg = e instanceof Error ? e.message : String(e);
        ffmpegStatus = t(`Проверка не получилась: ${msg}`, `Scoring failed: ${msg}`);
        Log.write(`file runScore: ${msg}`);
      }
    } finally {
      scoreBusy = false;
      scoreAbort = null;
      push();
    }
    return state();
  });

  handle('file:translateTarget', (_e, text: unknown) => {
    const s = settings.get();
    if (typeof text === 'string') {
      s.TranslateTarget = text.trim();
      Settings.save(s);
    }
    return state();
  });

  handle('file:runTranslate', async (_e, to: unknown, path: unknown) => {
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


  handle('file:openEditor', (_e, path: unknown) => {
    const p = typeof path === 'string' && path.length > 0 ? path : queue.lastOutput;
    editorFocus = p;
    editorNote = '';
    refreshEditor(true);
    return state();
  });

  // A phrase fixed in the editor: the same text in .txt/.srt/.vtt/.md/.json beside it, then the fix
  // goes to «Словарь из исправлений» like «История» → «Исправить».
  handle('file:editPhrase', (_e, index: unknown, text: unknown) => {
    const ed = refreshEditor();
    const i = typeof index === 'number' && Number.isInteger(index) ? index : -1;
    const seg = ed.segments[i];
    const next = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (!ed.txtPath || !seg || !next || next === seg.text.trim()) return state();
    const changed = editTranscriptPhrase(ed.txtPath, seg.text, next, readText, (p, d) => writeFileSync(p, d, 'utf8'));
    if (changed.length === 0) {
      editorNote = t('Не исправлено: фраза встречается в файле не один раз или файла нет.', 'Not fixed: the phrase is not found exactly once in the files.');
    } else {
      const r = learnFromEdit(settings.get(), Settings.save, seg.text, next);
      const pairs = (l: { from: string; to: string }[]) => l.map((p) => `${p.from} → ${p.to}`).join(', ');
      editorNote = t(`Исправлено в ${changed.length} файл(ах).`, `Fixed in ${changed.length} file(s).`)
        + (r.added.length ? t(` В словарь добавлено: ${pairs(r.added)}.`, ` Added to the dictionary: ${pairs(r.added)}.`)
          : r.suggested.length ? t(` На «Словаре» предложено: ${pairs(r.suggested)}.`, ` Suggested on Dictionary: ${pairs(r.suggested)}.`) : '');
      Log.write(`editor phrase fixed in ${changed.length} files`);
    }
    refreshEditor(true);
    return state();
  });

  handle('file:callTrackers', (_e, text: unknown) => {
    const s = settings.get();
    if (typeof text === 'string') {
      // The built-in text saved back unchanged stays '' so future defaults still apply.
      const v = text.replace(/\r/g, '').trim();
      s.CallTrackers = v === DEFAULT_TRACKERS_TEXT.trim() ? '' : v.slice(0, 8000);
      Settings.save(s);
    }
    return state();
  });

  handle('file:mediaUrl', (_e, path: unknown) => {
    if (typeof path !== 'string' || !path) return null;
    if (!isMediaAllowed(path) && existsSync(path)) {
      // Only queue / editor audio: allow if it matches the current editor audio or a queue item.
      const snap = queue.snapshot();
      const known = snap.some((i) => i.path === path) || editorCache.audioPath === path;
      if (known) allowMediaPath(path);
    }
    return mediaUrlFor(path);
  });

  return {
    busy: () => runner.busy || urlImport.busy || diarBusy || briefBusy || translateBusy || scoreBusy,
    /** A finished meeting recording: queue it and start (or join) the run. */
    enqueue: (path: string) => {
      queue.add([path], false);
      if (!runner.busy && !ffmpegBusy) {
        ffmpegStatus = '';
        briefCloudOk = null;
        scoreCloudOk = null;
        void runner.run().catch((e) => Log.write(`file run: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  };
}
