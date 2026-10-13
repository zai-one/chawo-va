// One dictation take on the main side: start → 16 kHz chunks from the renderer → stop → local
// recognition → dictionary → Brain (every take or a «Чаво, …» command) → simple syntax → final text.
// Port of App.HandlePressAsync / HandleReleaseAsync / RunBrainAsync / RequestStop / PartialTickAsync /
// ReloadSpeechAsync / SpeechStatusText minus the parts that are not ported yet (memory check before a
// cold local Brain, sales card). A global-key take with text selected in another app is a Brain command
// on that selection (HintSelectionAsync + the selection branch of HandleReleaseAsync). In the Client role
// the take (and the live drafts) go to the host through RemoteSpeech instead of a local recognizer.
// No Electron imports: the clipboard, the WAV writer, the pill and the Brain come in as hooks, and
// tests pass a fake recognizer and a fake OpenAI-compatible fetch. The recognizer is opened on demand
// (page shown or first take) and kept until the speech settings change. Nothing is downloaded from here.

import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../../core/speechModels';
import { Recognizer } from '../../core/recognizer';
import { applySimpleSyntax } from '../../core/simpleSyntax';
import { t } from '../../core/strings';
import {
  MIN_TAKE_SAMPLES,
  SAMPLE_RATE,
  SILENCE_FLOOR,
  TakeBuffer,
  hasSpeechDynamics,
  isSilentTake,
  normalizeQuietTake,
} from '../../core/takeBuffer';
import { applyRules } from '../../core/wordReplace';
import { parseCommand, serverConfigured, stripAddress, transformAsync } from '../brain/brain';
import * as LocalBrain from '../brain/localBrain';
import { BrainException, type FetchLike } from '../brain/speechCleanup';
import * as RemoteSpeech from '../network/remoteSpeech';
import { RemoteHostException } from '../network/remoteSpeech';
import * as Log from '../log';
import type { OverlaySink } from '../overlay/overlayModel';
import type { SelectionReaderLike, TextInserterLike } from '../native/nativeHelper';
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
  /** ORT provider, for the Hermes health answer. */
  provider?: string;
  /** Pause split and one piece at a time (Hermes); the real Recognizer has both. */
  pieceRanges?(samples16k: Float32Array): Array<{ from: number; to: number }>;
  transcribePiece?(samples16k: Float32Array): Promise<string>;
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
  /** The floating pill (OverlayWindow). Used only while settings.ShowOverlay is on. */
  overlay?: OverlaySink;
  /** App.BrainUsable: Local with the model on disk, or Server with url/model/key filled in. */
  brainUsable?: (s: SettingsData) => boolean;
  /** Brain.TransformAsync; defaults to the real one with `fetch`. */
  transform?: (s: SettingsData, body: string, command: string | null, status: (line: string) => void, signal: AbortSignal, selection?: boolean) => Promise<string>;
  /** fetch for the default transform (tests pass a fake OpenAI-compatible server). */
  fetch?: FetchLike;
  /** Live-draft pass interval while listening (WPF 1000 ms); 0 turns drafts off. */
  partialMs?: number;
  /**
   * The Windows helper for takes started by the global hold key: the phrase goes into the focused app
   * (TextInserter). Null or missing: the phrase goes to the clipboard as for the in-window button.
   */
  inserter?: () => TextInserterLike | null;
  /**
   * SelectionReader (Windows helper) for global-key takes: text selected in the focused app when the key
   * went down turns the take into a Brain command on it. Null or missing: plain dictation.
   */
  selection?: () => SelectionReaderLike | null;
  /** Client role: RemoteSpeech.transcribe (tests pass a fake host). Throws RemoteHostException. */
  remote?: (s: SettingsData, samples: Float32Array, rate: number, signal: AbortSignal) => Promise<string>;
}

export function defaultBrainUsable(s: SettingsData): boolean {
  if (s.Brain === 'Local') return LocalBrain.getRuntime().isReady(s);
  if (s.Brain === 'Server') return serverConfigured(s);
  return false;
}

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');

export interface StartResult {
  ok: boolean;
}

/** Who started the take: the in-window hold button (text to the clipboard) or the global key (inserted). */
export type TakeSource = 'window' | 'hotkey';

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
  private source: TakeSource = 'window';
  private takeAbort: AbortController | null = null;
  private partialTimer: NodeJS.Timeout | null = null;
  private partialEpoch = 0;
  private partialBusy = false;
  private partialTask: Promise<void> | null = null;
  private partialAbort: AbortController | null = null;
  /** Text selected when the key went down (read in the background); a take with a selection is a command on it. */
  private selectionAtPress: Promise<string | null> | null = null;
  private readonly brainUsable: (s: SettingsData) => boolean;
  private readonly transform: NonNullable<SessionHooks['transform']>;
  private readonly remote: NonNullable<SessionHooks['remote']>;

  constructor(hooks: SessionHooks) {
    this.h = { find: findComplete, open: openRecognizer, platform: process.platform, ...hooks };
    this.brainUsable = hooks.brainUsable ?? defaultBrainUsable;
    this.transform = hooks.transform
      ?? ((s, body, command, status, signal, selection) => transformAsync(s, body, command, status, signal, selection ?? false, hooks.fetch ?? globalThis.fetch));
    this.remote = hooks.remote ?? ((s, samples, rate, signal) => RemoteSpeech.transcribe(s, samples, rate, signal));
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

  /** The pill when the user wants it (App: `_settings.ShowOverlay ? _overlay : null`). */
  private get overlay(): OverlaySink | null {
    return this.h.settings().ShowOverlay ? this.h.overlay ?? null : null;
  }

  /** App.Hint: short feedback on the pill when it is on; the page always shows it as the status. */
  private hint(text: string): void {
    this.status = text;
    this.overlay?.showHint(text);
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
  startTake(source: TakeSource = 'window'): StartResult {
    if (this.isBusy) return { ok: false };
    if (this.client) {
      // No local model here: only the host address has to make sense.
      const ep = RemoteSpeech.tryEndpoint(this.h.settings());
      if (!ep.ok) {
        this.hint(t(ep.russian, ep.english));
        this.push();
        return { ok: false };
      }
    } else {
      const kind = toSpeechModelKind(this.h.settings().SpeechModel);
      if (this.h.find(kind) === null) {
        this.hint(flatText(noModelText()));
        this.push();
        return { ok: false };
      }
      void this.ensureLoaded();
    }
    this.abandon = false;
    this.status = '';
    this.source = source;
    this.buf.start();
    this.overlay?.showListening();
    if (this.h.settings().ShowOverlay) this.startPartials();
    this.selectionAtPress = null;
    const s = this.h.settings();
    const reader = source === 'hotkey' && s.BrainOnSelection && this.brainUsable(s) ? this.h.selection?.() ?? null : null;
    if (reader) {
      const read = reader.readSelection().catch(() => null);
      this.selectionAtPress = read;
      void this.hintSelection(read);
    }
    this.push();
    return { ok: true };
  }

  /** HintSelectionAsync: once the selection is read, say how much is selected and what to do. */
  private async hintSelection(read: Promise<string | null>): Promise<void> {
    const selected = await read;
    if (selected === null || read !== this.selectionAtPress || !this.buf.isRecording) return;
    const text = t(`Выделено ${selected.length} знаков. Скажите, что с ними сделать`, `${selected.length} characters selected. Say what to do with them`);
    if (this.h.settings().ShowOverlay && this.h.overlay) this.h.overlay.showCaption(text);
    else {
      this.status = text;
      this.push();
    }
  }

  appendPcm(chunk: ArrayLike<number>): void {
    this.buf.append(chunk);
  }

  /** getUserMedia failed in the renderer: drop the take and say why. */
  micFailed(name: string, message: string): void {
    Log.write(`mic failed: ${name}: ${message}`);
    this.buf.clear();
    this.stopPartials();
    this.overlay?.hideNow();
    this.status = micErrorText(name, message, this.h.platform);
    this.push();
  }

  /** Escape / Stop: drops the take, nothing is shown or copied (RequestStop). */
  cancelTake(): void {
    if (!this.isBusy) return;
    this.abandon = true;
    this.partialEpoch++;
    this.stopPartials();
    this.rec?.cancelOwned();
    this.partialAbort?.abort();
    this.takeAbort?.abort();
    if (this.buf.isRecording) {
      this.buf.clear();
      Log.write('take cancelled');
    }
    this.selectionAtPress = null;
    this.overlay?.hideNow();
    this.status = '';
    this.push();
  }

  /** Key release / hold button up (HandleReleaseAsync). Resolves with the final text or null. */
  async stopTake(): Promise<string | null> {
    if (!this.buf.isRecording || this.busy) return null;
    this.busy = true;
    this.partialEpoch++;
    this.stopPartials();
    // A draft pass still running would hold the recognizer (or the host): stop it, the final pass matters.
    if (this.partialBusy) {
      this.partialAbort?.abort();
      this.rec?.cancelOwned();
    }
    const partialTask = this.partialTask;
    const abort = new AbortController();
    this.takeAbort = abort;
    if (this.abandon) abort.abort();
    const overlay = this.overlay;
    const samples = this.buf.stop();
    const peak = this.buf.takePeak;
    this.push();
    let result: string | null = null;
    try {
      if (partialTask) await partialTask;
      if (this.abandon) {
        overlay?.hideNow();
        Log.write('take cancelled');
        return null;
      }
      overlay?.showRecognizing();
      const silent = isSilentTake(samples, peak);
      Log.write(`take ${(samples.length / SAMPLE_RATE).toFixed(1)}s peak ${(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(0)} dBFS silent=${silent}`);
      let text = '';
      let brainFailure: string | null = null;
      let brainCommand = false;
      let editedSelection = false;
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
        if (s.NetworkRole === 'Client') {
          try {
            text = await this.remote(s, samples, SAMPLE_RATE, abort.signal);
          } catch (e) {
            if (this.abandon || abort.signal.aborted) {
              overlay?.hideNow();
              Log.write('recognize cancelled');
              return null;
            }
            if (!(e instanceof RemoteHostException)) throw e;
            overlay?.hideNow();
            Log.write('remote host: ' + e.english);
            this.hint(t(e.russian, e.english));
            return null;
          }
        } else {
          const rec = await this.ensureLoaded();
          if (this.abandon) {
            overlay?.hideNow();
            return null;
          }
          if (!rec) {
            overlay?.hideNow();
            this.status = this.loadError
              ? t(`Модель не загрузилась: ${this.loadError}`, `The model did not load: ${this.loadError}`)
              : flatText(noModelText());
            return null;
          }
          text = await rec.transcribeCancelable(samples, SAMPLE_RATE, () => !this.abandon);
        }
        if (this.abandon) {
          overlay?.hideNow();
          Log.write('recognize cancelled');
          return null;
        }
        // Dictionary on the finished recognition only, before the Brain sees the phrase. Not the live draft.
        if (text.length > 0) {
          const replaced = applyRules(text, effectiveWordReplacementRules(this.h.settings()));
          if (replaced !== text) Log.write(`word replace before brain: ${text.length} -> ${replaced.length} chars`);
          text = replaced;
        }
        const now = this.h.settings();
        const selected = this.selectionAtPress && text.length > 0 ? await this.selectionAtPress : null;
        this.selectionAtPress = null;
        if (this.abandon) {
          overlay?.hideNow();
          return null;
        }
        if (selected !== null) {
          // Selected text + speech = a command on the selection ("make it shorter", "translate").
          // The answer is pasted over the selection; Ctrl+Z in the app brings the original back.
          Log.write(`brain on selection, ${selected.length} chars`);
          const { answer, failure } = await this.runBrain(now, selected, stripAddress(text), overlay, abort.signal, true);
          if (this.abandon) {
            overlay?.hideNow();
            return null;
          }
          if (answer === null) {
            overlay?.hideNow();
            this.hint(t(`Мозг не справился: ${failure}. Выделенный текст не тронут.`, `The Brain failed: ${failure}. The selection is untouched.`));
            return null; // never paste the spoken command over the user's text
          }
          text = answer;
          editedSelection = true;
        } else if (text.length > 0 && this.brainUsable(now)) {
          const cmd = parseCommand(text);
          if (cmd || now.BrainEveryTake) {
            const body = cmd?.body ?? text;
            if (cmd) Log.write(`brain command, ${body.length} chars`);
            brainCommand = cmd !== null;
            const { answer, failure } = await this.runBrain(now, body, cmd?.command ?? null, overlay, abort.signal);
            if (this.abandon) {
              overlay?.hideNow();
              return null;
            }
            brainFailure = failure;
            text = answer ?? body; // on failure the dictation goes in as recognized, without the command
          }
        }
      }

      // Simple syntax is for dictation only: a Brain answer to a command or an edited selection goes in as is.
      const simpleOn = this.h.settings().SimpleSyntax;
      if (text.length > 0 && simpleOn && !brainCommand && !editedSelection) {
        const simple = applySimpleSyntax(text);
        Log.write(`simple syntax: ${simple === text ? 'unchanged' : 'applied'}, ${text.length} chars`);
        text = simple;
      } else if (text.length > 0) {
        Log.write(`insert as is: simple=${simpleOn} selection=${editedSelection} command=${brainCommand}`);
      }

      if (this.abandon) {
        overlay?.hideNow();
        Log.write('take cancelled before insert');
        return null;
      }
      if (text.length > 0) {
        overlay?.hideNow();
        this.lastText = text;
        result = text;
        const inserter = this.source === 'hotkey' ? this.h.inserter?.() ?? null : null;
        if (inserter) await this.insertInto(inserter, text, brainFailure, editedSelection);
        else this.copyOut(text, brainFailure);
      } else if (samples.length <= MIN_TAKE_SAMPLES) {
        // WPF just hides the pill on an accidental tap; the page says what happened.
        overlay?.hideNow();
        this.status = this.source === 'hotkey'
          ? t('Слишком коротко. Держите клавишу, пока говорите.', 'Too short. Keep holding the key while you speak.')
          : t('Слишком коротко. Держите кнопку, пока говорите.', 'Too short. Keep holding the button while you speak.');
      } else {
        const mic = this.h.micName?.() ?? '';
        this.hint(silent
          ? t('Тишина на входе. Проверьте микрофон и его громкость: ' + mic, 'Silence on input. Check the microphone and its level: ' + mic)
          : t('Не разобрал. Попробуйте ещё раз ближе к микрофону.', 'Could not make it out. Try again closer to the microphone.'));
      }
    } catch (e) {
      Log.write(`take failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      overlay?.hideNow();
      this.status = t(`Не удалось распознать: ${e instanceof Error ? e.message : String(e)}`, `Recognition failed: ${e instanceof Error ? e.message : String(e)}`);
      result = null;
    } finally {
      this.busy = false;
      this.abandon = false;
      this.selectionAtPress = null;
      if (this.takeAbort === abort) this.takeAbort = null;
      this.disposeRetired();
      this.push();
    }
    return result;
  }

  /** In-window take (or no helper): the phrase goes to the clipboard and the page. */
  private copyOut(text: string, brainFailure: string | null): void {
    let copied = true;
    try {
      this.h.copy?.(text);
    } catch (e) {
      copied = false;
      Log.write(`clipboard: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (brainFailure !== null) {
      this.hint(copied
        ? t(`Мозг не справился: ${brainFailure}. В буфере обмена текст без правки.`, `The Brain failed: ${brainFailure}. The clipboard has the text as recognized.`)
        : t(`Мозг не справился: ${brainFailure}. В буфер обмена скопировать не получилось.`, `The Brain failed: ${brainFailure}. Could not copy to the clipboard.`));
    } else {
      this.status = copied
        ? t('Готово. Фраза в буфере обмена: вставьте её Ctrl+V.', 'Done. The phrase is on the clipboard: paste it with Ctrl+V.')
        : t('Готово. В буфер обмена скопировать не получилось.', 'Done. Could not copy to the clipboard.');
    }
  }

  /** Global-key take: TextInserter.Insert into the focused app with the WPF hints. */
  private async insertInto(inserter: TextInserterLike, text: string, brainFailure: string | null, editedSelection = false): Promise<void> {
    const s = this.h.settings();
    let r: 'Done' | 'Blocked';
    try {
      r = await inserter.insert(text, s.InsertMode, { keep: s.CopyPhraseToClipboard, restore: s.RestoreClipboardAfterCopy });
    } catch (e) {
      // The helper is gone: never drop the phrase, put it on the clipboard instead.
      Log.write(`insert failed: ${e instanceof Error ? e.message : String(e)}`);
      let copied = true;
      try {
        this.h.copy?.(text);
      } catch {
        copied = false;
      }
      this.hint(copied
        ? t('Вставить не получилось. Фраза в буфере обмена: вставьте её Ctrl+V.', 'Could not insert. The phrase is on the clipboard: paste it with Ctrl+V.')
        : t('Вставить не получилось. Фраза показана на странице «Диктовка».', 'Could not insert. The phrase is shown on the Dictation page.'));
      return;
    }
    Log.write(`insert ${s.InsertMode}: ${r}, ${text.length} chars`);
    if (r === 'Blocked') {
      this.hint(t('Это окно запущено от администратора, вставить туда нельзя. Текст лежит в буфере обмена.',
        'That window runs as administrator; typing into it is blocked. The text is on the clipboard.'));
      // Typing leaves the clipboard alone (Paste already left the phrase there): make the hint true.
      if (s.InsertMode === 'Type') {
        try {
          this.h.copy?.(text);
        } catch {
          /* the page still shows the phrase */
        }
      }
    } else if (brainFailure !== null) {
      this.hint(t(`Мозг не справился: ${brainFailure}. Вставлен текст без правки.`, `The Brain failed: ${brainFailure}. Inserted the text as recognized.`));
    } else if (editedSelection) {
      this.hint(t('Готово. Вернуть как было: Ctrl+Z', 'Done. Undo with Ctrl+Z'));
    } else {
      this.status = t('Готово. Фраза вставлена.', 'Done. The phrase is inserted.');
    }
  }

  /**
   * App.RunBrainAsync: the Brain on a text with the pill showing progress. Returns the answer, or null and
   * a human reason. An empty answer counts as a failure: the dictation must never silently vanish.
   * Cancelled by the user: null and null.
   */
  private async runBrain(
    s: SettingsData,
    body: string,
    command: string | null,
    overlay: OverlaySink | null,
    signal: AbortSignal,
    selection = false,
  ): Promise<{ answer: string | null; failure: string | null }> {
    try {
      const answer = await this.transform(s, body, command, (line) => {
        overlay?.showStatus(line);
        this.status = line;
        this.push();
      }, signal, selection);
      return answer.trim().length > 0
        ? { answer, failure: null }
        : { answer: null, failure: t('нейросеть вернула пустой ответ', 'the model returned an empty answer') };
    } catch (e) {
      if (this.abandon && (isAbort(e) || signal.aborted)) return { answer: null, failure: null };
      Log.write(`brain failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      return {
        answer: null,
        failure: e instanceof BrainException ? e.message
          : s.Brain === 'Server' ? t('сервер не ответил', 'the server did not answer')
          : t('нейронка не ответила', 'the Brain did not answer'),
      };
    } finally {
      this.status = '';
    }
  }

  // ── live drafts on the pill (StartPartials / PartialTickAsync) ──

  private startPartials(): void {
    this.stopPartials();
    const ms = this.h.partialMs ?? 1000;
    if (ms <= 0) return;
    this.partialTimer = setInterval(() => void this.partialTick(), ms);
    this.partialTimer.unref?.();
  }

  private stopPartials(): void {
    if (!this.partialTimer) return;
    clearInterval(this.partialTimer);
    this.partialTimer = null;
  }

  /**
   * One pass over the audio recorded so far. Skipped when the previous pass is still running, so the
   * final pass is not queued behind a pile of drafts. The result is only shown, never copied.
   */
  async partialTick(): Promise<void> {
    if (!this.buf.isRecording) return;
    if (!this.h.settings().ShowOverlay) return; // Sales (needs drafts without the pill) is not ported
    const settings = this.h.settings();
    const remote = settings.NetworkRole === 'Client';
    const rec = this.rec;
    if ((!remote && !rec) || this.partialBusy) return;
    this.partialBusy = true;
    const epoch = this.partialEpoch;
    const wanted = () => epoch === this.partialEpoch && !this.abandon;
    const remoteAbort = remote ? new AbortController() : null;
    if (remoteAbort) this.partialAbort = remoteAbort;
    const run = (async (): Promise<string> => {
      const samples = this.buf.snapshot();
      if (samples.length < (SAMPLE_RATE * 6) / 10) return '';
      if (!hasSpeechDynamics(samples)) return '';
      let peak = 0;
      for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
      if (peak < SILENCE_FLOOR) return '';
      normalizeQuietTake(samples, peak);
      if (!wanted()) return '';
      if (remoteAbort) return this.remote(settings, samples, SAMPLE_RATE, remoteAbort.signal);
      return rec!.transcribeCancelable(samples, SAMPLE_RATE, wanted);
    })();
    const task = run.then(() => undefined, () => undefined);
    this.partialTask = task;
    try {
      const text = await run;
      if (wanted() && this.buf.isRecording && text.length > 0) this.overlay?.showPartial(text);
      if (text.length > 0) Log.write(`partial ${text.length} chars`);
    } catch (e) {
      if (e instanceof RemoteHostException) Log.write(`partial remote: ${e.english}`);
      else if (!isAbort(e)) Log.write(`partial: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    } finally {
      if (this.partialTask === task) this.partialTask = null;
      if (remoteAbort && this.partialAbort === remoteAbort) this.partialAbort = null;
      this.partialBusy = false;
    }
  }

  private key(s: SettingsData, dir: string): string {
    return [dir, s.SpeechModel, s.SpeechDevice, s.CpuThreads, s.CtcScript].join('|');
  }

  /** The open recognizer for the current settings (Hermes reuses it), or null. Opens nothing. */
  current(): RecognizerLike | null {
    const s = this.h.settings();
    if (s.NetworkRole === 'Client' || !this.rec) return null;
    const dir = this.h.find(toSpeechModelKind(s.SpeechModel));
    return dir && this.recKey === this.key(s, dir) ? this.rec : null;
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
