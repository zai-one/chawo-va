// «Распознавание» page logic: which speech models are on disk, download with progress and cancel,
// delete, device and CPU threads. Port of the SpeechPage parts of SettingsWindow.xaml.cs plus
// DownloadWindow.xaml.cs and App.SpeechStatusText / DownloadSpeechAsync. No Electron imports, so
// the controller is unit-tested with fake download/delete hooks. Nothing is fetched until the user
// presses Download on a model row.

import { cpus } from 'node:os';
import type { SpeechModelKind } from '../../core/speechModels';
import { isRussian, t } from '../../core/strings';
import * as Log from '../log';
import { tryEndpoint } from '../network/remoteSpeech';
import {
  ModelDownloadException,
  deletableTargets,
  deleteButtonLabel,
  deleteInstalled,
  downloadAsync,
  findComplete,
  hasDeletable,
  type DownloadFailure,
  type DownloadProgress,
} from '../models';
import { modelDirectory } from '../paths';
import {
  fromSpeechModelKind,
  toSpeechModelKind,
  type SettingsData,
  type SettingsSpeechDevice,
} from '../settings';

export const SPEECH_KINDS: readonly SpeechModelKind[] = ['v3_e2e_rnnt', 'multilingual_large_ctc'];

export interface SpeechModelRow {
  kind: SpeechModelKind;
  label: string;
  selected: boolean;
  onDisk: boolean;
  path: string | null;
  canDelete: boolean;
  deleteTip: string;
}

export interface SpeechDownloadDto {
  kind: SpeechModelKind;
  /** 0..100, or null while the size is unknown (connecting, unpacking, checking). */
  percent: number | null;
  text: string;
  running: boolean;
  failed: boolean;
}

/** «Обрезать тишину (VAD)»: one checkbox and, when the 2 MB Silero file is missing, one button. */
export interface SpeechVadDto {
  enabled: boolean;
  onDisk: boolean;
  downloading: boolean;
  /** Show «Скачать Silero VAD (2 МБ)». */
  canDownload: boolean;
  note: string;
}

/** The part of VadRuntime the page needs. */
export interface VadModelLike {
  readonly onDisk: boolean;
  readonly isDownloading: boolean;
  readonly error: string;
  download(): Promise<string>;
}

export interface SpeechStateDto {
  ru: boolean;
  client: boolean;
  intro: string;
  models: SpeechModelRow[];
  note: string;
  device: SettingsSpeechDevice;
  deviceChoices: { value: SettingsSpeechDevice; label: string }[];
  cpuThreads: number;
  cores: number;
  threadsHint: string;
  status: string;
  download: SpeechDownloadDto | null;
  /** Null when the app runs without a VAD runtime (tests of other parts). */
  vad: SpeechVadDto | null;
}

export interface SpeechHooks {
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  /** Called after a model, device or thread change, a finished download or a delete. */
  changed?: () => void;
  /** Push a fresh state to the window. */
  push?: () => void;
  /** True while file transcription is using a model, so it is not deleted underneath. */
  busy?: () => boolean;
  /** Recognizer session line once dictation is ported; null means no session is loaded. */
  session?: () => string | null;
  download?: (kind: SpeechModelKind, dir: string, progress: (p: DownloadProgress) => void, signal: AbortSignal) => Promise<void>;
  remove?: (kind: SpeechModelKind) => void;
  find?: (kind: SpeechModelKind) => string | null;
  deletable?: (kind: SpeechModelKind) => boolean;
  targets?: (kind: SpeechModelKind) => string[];
  platform?: NodeJS.Platform;
  cores?: number;
  /** Silero VAD model (getVadRuntime() in the app). */
  vad?: VadModelLike;
}

export function modelLabel(kind: SpeechModelKind): string {
  return kind === 'v3_e2e_rnnt'
    ? t('Русская v3: запятые и заглавные, около 220 МБ', 'Russian v3: commas and capitals, about 220 MB')
    : t('Большая: русский и английский без знаков, около 2,4 ГБ', 'Large: Russian and English, no punctuation, about 2.4 GB');
}

export function deleteTip(kind: SpeechModelKind): string {
  return t(deleteButtonLabel(kind), kind === 'v3_e2e_rnnt' ? 'Delete the Russian v3 model' : 'Delete the large model, 2.4 GB');
}

/** Disk space the WPF download window asks for: archive plus unpacked files with headroom. */
export function spaceNeeded(kind: SpeechModelKind): string {
  return kind === 'v3_e2e_rnnt' ? t('1 ГБ', '1 GB') : t('4 ГБ', '4 GB');
}

/** GPU label per platform: onnxruntime-node uses DirectML on Windows and CUDA elsewhere. */
export function gpuLabel(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? t('Видеокарта (DirectML)', 'Video card (DirectML)')
    : t('Видеокарта (CUDA, если есть)', 'Video card (CUDA, if present)');
}

const MB = 1048576;

export function progressText(p: DownloadProgress): { percent: number | null; text: string } {
  switch (p.stage) {
    case 'download':
      if (p.total > 0) {
        const r = Math.floor(p.received / MB);
        const tot = Math.floor(p.total / MB);
        return {
          percent: Math.min(100, (100 * p.received) / p.total),
          text: t(`Скачано ${r} из ${tot} МБ`, `Downloaded ${r} of ${tot} MB`),
        };
      }
      return { percent: null, text: t(`Скачано ${Math.floor(p.received / MB)} МБ`, `Downloaded ${Math.floor(p.received / MB)} MB`) };
    case 'unpack':
      return { percent: null, text: t('Распаковываю…', 'Unpacking…') };
    case 'verify':
      return { percent: null, text: t('Проверяю файл…', 'Checking the file…') };
    case 'done':
      return { percent: 100, text: t('Готово.', 'Done.') };
    default:
      return { percent: null, text: t('Соединяюсь…', 'Connecting…') };
  }
}

export function failureText(kind: DownloadFailure, message: string, need: string): string {
  switch (kind) {
    case 'noSpace':
      return t(`Мало места на диске: нужно около ${need} свободных. Освободите место и повторите.`,
        `Not enough disk space: about ${need} is needed. Free some space and retry.`);
    case 'corrupt':
      return t('Скачанный архив повреждён или подменён. Попробуйте ещё раз позже.',
        'The downloaded archive is damaged or does not match. Try again later.');
    case 'rejected':
      return message;
    default:
      return t('Не получилось скачать. Проверьте интернет и попробуйте ещё раз.',
        'Download failed. Check your connection and try again.');
  }
}

const isAbort = (e: unknown) =>
  (e instanceof Error && e.name === 'AbortError') ||
  (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ABORT_ERR');

export class SpeechController {
  private abort: AbortController | null = null;
  private dl: SpeechDownloadDto | null = null;
  private readonly h: Required<Omit<SpeechHooks, 'changed' | 'push' | 'busy' | 'session' | 'vad'>> & SpeechHooks;

  constructor(hooks: SpeechHooks) {
    this.h = {
      download: (kind, dir, progress, signal) => downloadAsync(kind, dir, progress, signal),
      remove: deleteInstalled,
      find: findComplete,
      deletable: hasDeletable,
      targets: deletableTargets,
      platform: process.platform,
      cores: Math.max(1, cpus().length),
      ...hooks,
    };
  }

  get downloading(): boolean {
    return this.dl?.running === true;
  }

  state(): SpeechStateDto {
    const s = this.h.settings();
    const client = s.NetworkRole === 'Client';
    const selected = toSpeechModelKind(s.SpeechModel);
    const models = SPEECH_KINDS.map((kind): SpeechModelRow => {
      const path = this.h.find(kind);
      return {
        kind,
        label: modelLabel(kind),
        selected: kind === selected,
        onDisk: path !== null,
        path,
        canDelete: this.h.deletable(kind),
        deleteTip: deleteTip(kind),
      };
    });
    const cores = this.h.cores;
    return {
      ru: isRussian(),
      client,
      intro: client
        ? t('Сейчас этот ПК — клиент. Речевая модель здесь не скачивается и не запускается. Адрес хоста — в разделе «Сеть».',
          'This PC is a client. The speech model is not downloaded or started here. The host address is under Network.')
        : t('Модель, которая слушает микрофон. Сама ничего не скачивает: кнопка в строке модели.',
          'The model that listens to the microphone. Nothing downloads until you press the button on that model\'s row.'),
      models,
      note: t('Русская v3 ставит запятые и заглавные. Большая пишет слова без знаков.',
        'Russian v3 adds commas and capitals. The large model writes words without punctuation.'),
      device: s.SpeechDevice,
      deviceChoices: [
        { value: 'Gpu', label: gpuLabel(this.h.platform) },
        { value: 'Cpu', label: t('Процессор (CPU)', 'Processor (CPU)') },
      ],
      cpuThreads: s.CpuThreads <= 0 || s.CpuThreads > cores ? 0 : s.CpuThreads,
      cores,
      threadsHint: t(`Виден только на процессоре. «Все ядра» — это ${cores}. Расшифровку файлов настраивает «Скорость длинных записей» в разделе «Расшифровка файла».`,
        `Shown only for the processor. All cores means ${cores}. File transcription uses Speed for long recordings on the File transcription page.`),
      status: this.statusText(s, models.find((m) => m.selected) ?? null),
      download: this.dl,
      vad: this.vadState(s),
    };
  }

  private vadState(s: SettingsData): SpeechVadDto | null {
    const v = this.h.vad;
    if (!v) return null;
    const onDisk = v.onDisk;
    const downloading = v.isDownloading;
    let note: string;
    if (!s.VadEnabled) {
      note = t('Выключено: фраза распознаётся целиком, длинные файлы режутся по громкости.',
        'Off: the whole take is recognized, long files are cut by loudness.');
    } else if (onDisk) {
      note = t('Silero VAD на диске: тишина до и после фразы отрезается, длинные файлы режутся по паузам в речи. Всё локально.',
        'Silero VAD is on disk: silence before and after a take is cut, long files are split at pauses in speech. All local.');
    } else if (downloading) {
      note = t('Скачиваю Silero VAD (2 МБ)…', 'Downloading Silero VAD (2 MB)…');
    } else if (v.error) {
      note = t(`Silero VAD не скачался: ${v.error}. Пока всё работает как раньше, по громкости.`,
        `Silero VAD did not download: ${v.error}. Until then everything works as before, by loudness.`);
    } else {
      note = t('Нужна модель Silero VAD, 2 МБ. Без неё запись и файлы обрабатываются как раньше, по громкости.',
        'Needs the Silero VAD model, 2 MB. Without it takes and files are handled as before, by loudness.');
    }
    return { enabled: s.VadEnabled, onDisk, downloading, canDownload: s.VadEnabled && !onDisk && !downloading, note };
  }

  setVad(on: boolean): void {
    const s = this.h.settings();
    if (s.VadEnabled === on) return;
    s.VadEnabled = on;
    this.h.save(s);
    this.update();
  }

  /** Fetches the 2 MB Silero file (user pressed the button). Errors end up in the note. */
  async downloadVad(): Promise<void> {
    const v = this.h.vad;
    if (!v || v.onDisk || v.isDownloading) return;
    const run = v.download();
    this.update();
    try {
      await run;
    } catch {
      /* the note shows v.error */
    } finally {
      this.update();
    }
  }

  private statusText(s: SettingsData, row: SpeechModelRow | null): string {
    if (s.NetworkRole === 'Client') {
      const ep = tryEndpoint(s);
      if (!ep.ok) return t(ep.russian, ep.english);
      return t(`Клиент. Звук уходит на ${ep.url}. Местная речевая модель не запускается и не скачивается.`,
        `Client. Audio goes to ${ep.url}. The local speech model is not started and is not downloaded.`);
    }
    if (!row?.path) {
      return t('Эта модель на диске не найдена. Нажмите «Скачать» в её строке, сама она не скачивается. Ищу в папках программы (и в папке прежней версии) и рядом с программой.',
        'This model was not found on disk. Press Download on its row. It does not download by itself. The app\'s data folders (including the previous version\'s) and the folder next to the program are checked.');
    }
    const where = t(`Уже на диске: ${row.path}. `, `Already on disk: ${row.path}. `);
    const session = this.h.session?.() ?? null;
    return where + (session ?? t('Файлы на месте, но сессия не загружена.', 'The files are there, but the session is not loaded.'));
  }

  private update(): void {
    this.h.push?.();
  }

  select(kind: SpeechModelKind): void {
    const s = this.h.settings();
    const want = fromSpeechModelKind(kind);
    if (s.SpeechModel === want || !SPEECH_KINDS.includes(kind)) return;
    s.SpeechModel = want;
    this.h.save(s);
    this.h.changed?.();
  }

  setDevice(device: SettingsSpeechDevice): void {
    const s = this.h.settings();
    if ((device !== 'Gpu' && device !== 'Cpu') || s.SpeechDevice === device) return;
    s.SpeechDevice = device;
    this.h.save(s);
    this.h.changed?.();
  }

  setThreads(n: number): void {
    const s = this.h.settings();
    if (!Number.isInteger(n) || n < 0 || n > this.h.cores || s.CpuThreads === n) return;
    s.CpuThreads = n;
    this.h.save(s);
    this.h.changed?.();
  }

  /** Starts the download of one model and selects it (WPF does the same). Resolves when it ends. */
  async download(kind: SpeechModelKind): Promise<void> {
    if (!SPEECH_KINDS.includes(kind) || this.downloading) return;
    const s = this.h.settings();
    if (s.NetworkRole === 'Client') {
      this.dl = { kind, percent: null, running: false, failed: true, text: t('Этот компьютер — клиент. Речевая модель не скачивается. Адрес хоста задаётся в разделе «Сеть».', 'This PC is a client. The speech model is not downloaded. Set the host under Network.') };
      this.update();
      return;
    }
    this.select(kind);
    const existing = this.h.find(kind);
    if (existing) {
      this.dl = { kind, percent: 100, running: false, failed: false, text: t(`Эта модель уже на диске. Скачивать её снова не нужно. ${existing}`, `This model is already on disk. It will not be downloaded again. ${existing}`) };
      this.update();
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.dl = { kind, percent: null, running: true, failed: false, text: t('Соединяюсь…', 'Connecting…') };
    this.update();
    try {
      await this.h.download(kind, modelDirectory(kind), (p) => {
        if (abort.signal.aborted) return;
        this.dl = { kind, running: true, failed: false, ...progressText(p) };
        this.update();
      }, abort.signal);
      this.dl = null;
      Log.write(`speech model downloaded: ${kind}`);
      this.h.changed?.();
      // The user asked for a model download: the 2 MB Silero VAD comes along when VAD is on.
      if (this.h.settings().VadEnabled && this.h.vad && !this.h.vad.onDisk) void this.downloadVad();
    } catch (e) {
      if (abort.signal.aborted || isAbort(e)) {
        this.dl = null;
      } else {
        Log.write(`download failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        const fk: DownloadFailure = e instanceof ModelDownloadException ? e.kind : 'network';
        this.dl = { kind, percent: null, running: false, failed: true, text: failureText(fk, e instanceof Error ? e.message : String(e), spaceNeeded(kind)) };
      }
    } finally {
      if (this.abort === abort) this.abort = null;
      this.update();
    }
  }

  cancelDownload(): void {
    this.abort?.abort();
  }

  dismissDownload(): void {
    if (!this.downloading) {
      this.dl = null;
      this.update();
    }
  }

  /** Text for the confirmation box shown before a delete. */
  confirmText(kind: SpeechModelKind): string {
    const paths = this.h.targets(kind).join('\n');
    return t(`Удалить эту модель с диска?\n\n${deleteButtonLabel(kind)}\n\n${paths}\n\nСама программа не удаляется.`,
      `Delete this model from disk?\n\n${paths}\n\nThe program itself stays.`);
  }

  /** Deletes after the caller confirmed. Returns an error line, or null on success. */
  delete(kind: SpeechModelKind): string | null {
    if (!SPEECH_KINDS.includes(kind)) return null;
    if (this.h.busy?.() || (this.downloading && this.dl?.kind === kind)) {
      return t('Модель сейчас занята. Дождитесь конца расшифровки или скачивания.', 'The model is busy. Wait until the transcription or download ends.');
    }
    try {
      this.h.remove(kind);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      this.h.changed?.();
      this.update();
    }
  }
}
