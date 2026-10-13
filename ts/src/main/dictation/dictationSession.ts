// One dictation take on the main side: start → 16 kHz chunks from the renderer → stop → local
// recognition → dictionary → final text. Port of App.HandlePressAsync / HandleReleaseAsync /
// RequestStop / ReloadSpeechAsync / SpeechStatusText minus the parts that are not ported yet
// (remote host, live drafts on the pill, Brain, simple syntax, sales card, inserting into other apps).
// No Electron imports: the clipboard and the WAV writer come in as hooks, and tests pass a fake
// recognizer. The recognizer is opened on demand (page shown or first take) and kept until the speech
// settings change. Nothing is downloaded from here.

import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../../core/speechModels';
import { Recognizer } from '../../core/recognizer';
import { t } from '../../core/strings';
import {
  MIN_TAKE_SAMPLES,
  SAMPLE_RATE,
  TakeBuffer,
  isSilentTake,
  normalizeQuietTake,
} from '../../core/takeBuffer';
import { applyRules } from '../../core/wordReplace';
import * as Log from '../log';
import { findComplete } from '../models';
import {
  effectiveWordReplacementRules,
  toCtcScript,
  toSpeechDeviceKind,
  toSpeechModelKind,
  type SettingsData,
} from '../settings';
import { flatText, micErrorText, noModelText, type DictatePhase, type TakeView } from './dictationPage';

/** The part of Recognizer a take needs. */
export interface RecognizerLike {
  readonly kind: SpeechModelKind;
  readonly modelId: string;
  deviceActual: string;
  deviceNote: string | null;
  intraOpThreads: number;
  transcribeCancelable(samples: Float32Array, rate: number, stillWanted: (() => boolean) | null): Promise<string>;
  cancelOwned(): void;
  dispose(): Promise<void>;
}

export interface SessionHooks {
  settings: () => SettingsData;
  push?: () => void;
  /** Final text goes here (Electron clipboard in the IPC layer). */
  copy?: (text: string) => void;
  /** KeepLastRecording: write the take as WAV. */
  writeWav?: (samples: Float32Array, rate: number) => void;
  /** Name of the microphone in use, for the "silence on input" hint. */
  micName?: () => string;
  find?: (kind: SpeechModelKind) => string | null;
  open?: (dir: string, kind: SpeechModelKind, device: SpeechDeviceKind, threads: number, script: CtcScript) => Promise<RecognizerLike>;
  platform?: NodeJS.Platform;
}

export interface StartResult {
  ok: boolean;
}

async function openRecognizer(dir: string, kind: SpeechModelKind, device: SpeechDeviceKind, threads: number, script: CtcScript): Promise<RecognizerLike> {
  const rec = await Recognizer.open(dir, kind, device, threads);
  rec.script = script;
  return rec;
}

export class DictationSession {
  private readonly buf = new TakeBuffer();
  private readonly h: SessionHooks & Required<Pick<SessionHooks, 'find' | 'open' | 'platform'>>;
  private rec: RecognizerLike | null = null;
  private recKey = '';
  private loading: Promise<RecognizerLike | null> | null = null;
  private loadingKey = '';
  private loadError = '';
  private loadNote = '';
  private retired: RecognizerLike[] = [];
  private busy = false;
  private abandon = false;
  private status = '';
  private lastText = '';

  constructor(hooks: SessionHooks) {
    this.h = { find: findComplete, open: openRecognizer, platform: process.platform, ...hooks };
    this.buf.onTakeTooLong = () => {
      Log.write('take too long, stopping');
      void this.stopTake().then(() => {
        this.status = t('Запись длиннее 5 минут остановлена сама. ', 'A take longer than 5 minutes stopped by itself. ') + this.status;
        this.push();
      });
    };
  }

  private push(): void {
    this.h.push?.();
  }

  private get client(): boolean {
    return this.h.settings().NetworkRole === 'Client';
  }

  /** App.ReadyPhase: a client or a usable model on disk is Idle, else NoModel. */
  private readyPhase(): DictatePhase {
    if (this.client) return 'Idle';
    if (this.loadError && !this.loading) return 'NoModel';
    return this.h.find(toSpeechModelKind(this.h.settings().SpeechModel)) !== null ? 'Idle' : 'NoModel';
  }

  get phase(): DictatePhase {
    if (this.buf.isRecording) return 'Listening';
    if (this.busy) return 'Recognizing';
    return this.readyPhase();
  }

  get isBusy(): boolean {
    return this.buf.isRecording || this.busy;
  }

  view(): TakeView {
    return { phase: this.phase, status: this.status, lastText: this.lastText, loading: this.loading !== null };
  }

  /** Loudness since the last read, 0..1 (Recorder.Level). */
  level(): number {
    return this.buf.level;
  }

  /** Key press / hold button down (HandlePressAsync). The renderer opens the mic only when ok. */
  startTake(): StartResult {
    if (this.isBusy) return { ok: false };
    if (this.client) {
      this.status = t('Этот ПК — клиент. Отправка звука на хост в эту версию ещё не перенесена: диктуйте в WPF-приложении или переключите его на хост.',
        'This PC is a client. Sending audio to the host is not ported to this version yet: dictate in the WPF app or switch it to host.');
      this.push();
      return { ok: false };
    }
    const kind = toSpeechModelKind(this.h.settings().SpeechModel);
    if (this.h.find(kind) === null) {
      this.status = flatText(noModelText());
      this.push();
      return { ok: false };
    }
    void this.ensureLoaded();
    this.abandon = false;
    this.status = '';
    this.buf.start();
    this.push();
    return { ok: true };
  }

  appendPcm(chunk: ArrayLike<number>): void {
    this.buf.append(chunk);
  }

  /** getUserMedia failed in the renderer: drop the take and say why. */
  micFailed(name: string, message: string): void {
    Log.write(`mic failed: ${name}: ${message}`);
    this.buf.clear();
    this.status = micErrorText(name, message, this.h.platform);
    this.push();
  }

  /** Escape / Stop: drops the take, nothing is shown or copied (RequestStop). */
  cancelTake(): void {
    if (!this.isBusy) return;
    this.abandon = true;
    this.rec?.cancelOwned();
    if (this.buf.isRecording) {
      this.buf.clear();
      Log.write('take cancelled');
    }
    this.status = '';
    this.push();
  }

  /** Key release / hold button up (HandleReleaseAsync). Resolves with the final text or null. */
  async stopTake(): Promise<string | null> {
    if (!this.buf.isRecording || this.busy) return null;
    this.busy = true;
    const samples = this.buf.stop();
    const peak = this.buf.takePeak;
    this.push();
    let result: string | null = null;
    try {
      if (this.abandon) {
        Log.write('take cancelled');
        return null;
      }
      const silent = isSilentTake(samples, peak);
      Log.write(`take ${(samples.length / SAMPLE_RATE).toFixed(1)}s peak ${(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(0)} dBFS silent=${silent}`);
      let text = '';
      if (!silent && samples.length > MIN_TAKE_SAMPLES) {
        const s = this.h.settings();
        if (s.KeepLastRecording) {
          try {
            this.h.writeWav?.(samples, SAMPLE_RATE);
          } catch (e) {
            Log.write(`last take wav: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        normalizeQuietTake(samples, peak);
        const rec = await this.ensureLoaded();
        if (this.abandon) return null;
        if (!rec) {
          this.status = this.loadError
            ? t(`Модель не загрузилась: ${this.loadError}`, `The model did not load: ${this.loadError}`)
            : flatText(noModelText());
          return null;
        }
        text = await rec.transcribeCancelable(samples, SAMPLE_RATE, () => !this.abandon);
        if (this.abandon) {
          Log.write('recognize cancelled');
          return null;
        }
        // Dictionary on the finished recognition only, before the Brain sees the phrase.
        if (text.length > 0) {
          const replaced = applyRules(text, effectiveWordReplacementRules(this.h.settings()));
          if (replaced !== text) Log.write(`word replace: ${text.length} -> ${replaced.length} chars`);
          text = replaced;
        }
      }
      if (text.length > 0) {
        this.lastText = text;
        result = text;
        try {
          this.h.copy?.(text);
          this.status = t('Готово. Фраза в буфере обмена: вставьте её Ctrl+V. Вставка прямо в другие программы появится позже.',
            'Done. The phrase is on the clipboard: paste it with Ctrl+V. Inserting straight into other apps comes later.');
        } catch (e) {
          Log.write(`clipboard: ${e instanceof Error ? e.message : String(e)}`);
          this.status = t('Готово. В буфер обмена скопировать не получилось.', 'Done. Could not copy to the clipboard.');
        }
      } else if (samples.length <= MIN_TAKE_SAMPLES) {
        // WPF just hides the pill on an accidental tap; the page says what happened.
        this.status = t('Слишком коротко. Держите кнопку, пока говорите.', 'Too short. Keep holding the button while you speak.');
      } else {
        const mic = this.h.micName?.() ?? '';
        this.status = silent
          ? t('Тишина на входе. Проверьте микрофон и его громкость: ' + mic, 'Silence on input. Check the microphone and its level: ' + mic)
          : t('Не разобрал. Попробуйте ещё раз ближе к микрофону.', 'Could not make it out. Try again closer to the microphone.');
      }
    } catch (e) {
      Log.write(`take failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      this.status = t(`Не удалось распознать: ${e instanceof Error ? e.message : String(e)}`, `Recognition failed: ${e instanceof Error ? e.message : String(e)}`);
      result = null;
    } finally {
      this.busy = false;
      this.abandon = false;
      this.disposeRetired();
      this.push();
    }
    return result;
  }

  private key(s: SettingsData, dir: string): string {
    return [dir, s.SpeechModel, s.SpeechDevice, s.CpuThreads, s.CtcScript].join('|');
  }

  /** Opens the recognizer for the current settings, or reuses the open one. Null when there is no model. */
  ensureLoaded(): Promise<RecognizerLike | null> {
    const s = this.h.settings();
    if (s.NetworkRole === 'Client') return Promise.resolve(null);
    const kind = toSpeechModelKind(s.SpeechModel);
    const dir = this.h.find(kind);
    if (!dir) return Promise.resolve(null);
    const key = this.key(s, dir);
    if (this.rec && this.recKey === key) return Promise.resolve(this.rec);
    if (this.loading && this.loadingKey === key) return this.loading;
    this.retire();
    this.loadError = '';
    this.loadingKey = key;
    const device = toSpeechDeviceKind(s.SpeechDevice);
    const p = (async (): Promise<RecognizerLike | null> => {
      try {
        const r = await this.h.open(dir, kind, device, s.CpuThreads, toCtcScript(s.CtcScript));
        if (this.loadingKey !== key) {
          // Settings changed while loading: this one is stale.
          await r.dispose();
          return this.loading ?? this.ensureLoaded();
        }
        this.rec = r;
        this.recKey = key;
        this.loadNote = r.deviceNote && r.deviceActual === 'cpu'
          ? t('Видеокарта не поднялась, считаю на процессоре.', 'The video card did not start, running on the processor.')
          : '';
        Log.write(`dictation model ${r.modelId} on ${r.deviceActual} intra=${r.intraOpThreads}${r.deviceNote ? ` note=${r.deviceNote}` : ''}`);
        return r;
      } catch (e) {
        if (this.loadingKey === key) this.loadError = e instanceof Error ? e.message : String(e);
        Log.write(`dictation model load failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        return null;
      } finally {
        if (this.loadingKey === key) {
          this.loading = null;
          this.loadingKey = '';
        }
        this.push();
      }
    })();
    this.loading = p;
    this.push();
    return p;
  }

  /** Speech model, device, threads or script changed: drop the open session; the next use reloads it. */
  speechChanged(): void {
    const s = this.h.settings();
    const dir = s.NetworkRole === 'Client' ? null : this.h.find(toSpeechModelKind(s.SpeechModel));
    if (this.rec && dir && this.recKey === this.key(s, dir)) return;
    this.loadError = '';
    this.loadingKey = '';
    this.loading = null;
    this.retire();
    this.push();
  }

  /** Closes the session (before a model delete, or on quit). */
  async release(): Promise<void> {
    this.loadingKey = '';
    this.loading = null;
    this.retire();
    if (!this.busy) await this.disposeRetired();
  }

  private retire(): void {
    if (this.rec) this.retired.push(this.rec);
    this.rec = null;
    this.recKey = '';
    this.loadNote = '';
    if (!this.busy) void this.disposeRetired();
  }

  private async disposeRetired(): Promise<void> {
    const list = this.retired.splice(0);
    for (const r of list) {
      try {
        await r.dispose();
      } catch (e) {
        Log.write(`recognizer dispose: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Session part of the «Распознавание» status (App.SpeechStatusText); null when nothing is loaded. */
  sessionLine(): string | null {
    if (this.loading) return t('Загружаю модель…', 'Loading the model…');
    const s = this.h.settings();
    const rec = this.rec;
    if (!rec || rec.kind !== toSpeechModelKind(s.SpeechModel)) {
      return this.loadError ? t('Файлы на месте, но сессия не загружена. ', 'The files are there, but the session is not loaded. ') + this.loadError : null;
    }
    const gpu = rec.deviceActual === 'gpu';
    const where = gpu
      ? this.h.platform === 'win32' ? t('видеокарте (DirectML)', 'the video card (DirectML)') : t('видеокарте (CUDA)', 'the video card (CUDA)')
      : t('процессоре', 'the processor');
    const threads = gpu
      ? t(' Настройка потоков процессор не трогает, пока считает видеокарта.', ' The processor-thread setting is idle while the video card runs.')
      : t(` Потоков процессора: ${rec.intraOpThreads}.`, ` Processor threads: ${rec.intraOpThreads}.`);
    const note = this.loadNote ? this.loadNote + ' ' : '';
    return t(`Загружена ${rec.modelId}, считает на ${where}. `, `Loaded ${rec.modelId}, running on ${where}. `) + note + threads.trimStart();
  }
}
