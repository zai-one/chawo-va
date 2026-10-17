// «Голос»: the page's IPC and reading aloud. A text comes from an «Озвучить» button in the window, the
// button next to a selection in another app (the helper reports where the mouse let go of a selection)
// or the reading key; the speech service runs here, the sound plays in the floating player.
import { BrowserWindow, screen, shell } from 'electron';
import { t } from '@chawo/core/strings';
import * as Log from '@chawo/engine/log';
import * as Settings from '@chawo/engine/settings';
import type { SettingsData } from '@chawo/engine/settings';
import type { NativeHelper } from '@chawo/engine/native/nativeHelper';
import { clampSpeed, errorState, loadingState, readyState } from '@chawo/engine/tts/playerModel';
import type { Speech } from '@chawo/engine/tts/ttsClient';
import * as Providers from '@chawo/engine/tts/ttsProviders';
import { VoiceController } from '@chawo/engine/tts/voicePage';
import { emit, handle } from './ipc';
import { PillWindow } from './tts/pillWindow';
import { PlayerWindow } from './tts/playerWindow';

/** Shortest selection worth a button (a stray click selects a letter or two). */
const MIN_SELECTION = 3;

export interface VoiceIpc {
  controller: VoiceController;
  /** Reads a text in the player (empty → the player says to select text). */
  speak(text: string): void;
  /** The reading key was pressed: reads the selection of the focused app. */
  speakSelection(): void;
  /** The mouse let go of a selection: offers «Озвучить» at the pointer. */
  mouseUp(): void;
  /** Sends the reading key and the selection watch to the helper (after start and on changes). */
  applyHelper(): void;
  dispose(): void;
}

export function registerVoiceIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  opts: { helper: () => NativeHelper | null; showPage: (page: string) => void },
): VoiceIpc {
  const player = new PlayerWindow();
  const pill = new PillWindow();
  let reading: AbortController | null = null;
  let probe = 0;
  let selected = '';

  let pushTimer: NodeJS.Timeout | null = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      emit(getWindow(), 'voice:state', ctl.state());
    }, 120);
  };

  const playSpeech = (speech: Speech, text: string) => {
    player.show(readyState(text, settings.get().TtsSpeed), !player.visible);
    player.play(speech.audio, speech.mime);
  };

  const speak = (raw: string) => {
    reading?.abort();
    pill.hide();
    const text = raw.trim();
    const rate = settings.get().TtsSpeed;
    if (!text) {
      player.show(errorState('', t('Выделите текст, который прочитать.', 'Select the text to read.'), rate), true);
      return;
    }
    const ac = (reading = new AbortController());
    player.show(loadingState(text, rate), true);
    const started = Date.now();
    ctl
      .speak(text, ac.signal, (done, total) => {
        if (total > 1 && !ac.signal.aborted) {
          const state = loadingState(text, rate);
          state.message = t(`Озвучиваю… ${done} из ${total}`, `Making the audio… ${done} of ${total}`);
          player.show(state);
        }
      })
      .then((speech) => {
        if (ac.signal.aborted) return;
        Log.write(`tts: ${text.length} chars, ${speech.pieces} piece(s), ${speech.audio.length} bytes in ${Date.now() - started} ms`);
        playSpeech(speech, text);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        Log.write(`tts failed: ${msg}`);
        player.show(errorState(text, t('Не получилось: ', 'Failed: ') + msg, rate));
      })
      .finally(() => {
        if (reading === ac) reading = null;
      });
  };

  const ctl: VoiceController = new VoiceController({
    settings: settings.get,
    save: Settings.save,
    push,
    changed: () => applyHelper(),
    play: playSpeech,
  });

  player.onRate = (v) => {
    const s = settings.get();
    const speed = clampSpeed(v);
    if (speed === s.TtsSpeed) return;
    s.TtsSpeed = speed;
    Settings.save(s);
    push();
  };
  player.onClose = () => {
    reading?.abort();
    reading = null;
  };
  player.onSettings = () => opts.showPage('voice');
  pill.onSpeak = () => speak(selected);

  const applyHelper = () => {
    const helper = opts.helper();
    if (!helper) return;
    const s = settings.get();
    const on = Providers.byId(s.TtsProvider) != null;
    helper.setTtsKey(on ? s.TtsHotkeyVk : 0);
    helper.watchSelection(on && s.TtsSelectionButton);
    if (!on || !s.TtsSelectionButton) pill.hide();
  };

  const mouseUp = () => {
    const s = settings.get();
    const helper = opts.helper();
    if (!helper || !s.TtsSelectionButton || !Providers.byId(s.TtsProvider)) return;
    // A selection in Chawo's own windows has its own buttons.
    if (BrowserWindow.getFocusedWindow()) return;
    const ticket = ++probe;
    // The DIP point now: the helper reports physical pixels, the pill is placed in DIP.
    const at = screen.getCursorScreenPoint();
    void helper.probeSelection().then((text) => {
      if (ticket !== probe) return;
      const clean = (text ?? '').trim();
      if (clean.length < MIN_SELECTION) {
        pill.hide();
        return;
      }
      selected = clean;
      pill.showAt(at, t('Озвучить', 'Read aloud'));
    });
  };

  const speakSelection = () => {
    const helper = opts.helper();
    if (!helper || !Providers.byId(settings.get().TtsProvider)) return;
    void helper.readSelection().then((text) => speak(text ?? ''));
  };

  handle('voice:state', () => ctl.state());
  handle('voice:provider', (_e, id: unknown) => {
    if (typeof id === 'string') ctl.setProvider(id);
    return ctl.state();
  });
  handle('voice:url', (_e, url: unknown) => {
    if (typeof url === 'string') ctl.setUrl(url);
    return ctl.state();
  });
  handle('voice:key', (_e, key: unknown) => {
    if (typeof key === 'string') ctl.setKey(key.slice(0, 4096));
    return ctl.state();
  });
  handle('voice:model', (_e, model: unknown) => {
    if (typeof model === 'string') ctl.setModel(model);
    return ctl.state();
  });
  handle('voice:voice', (_e, voice: unknown) => {
    if (typeof voice === 'string') ctl.setVoice(voice);
    return ctl.state();
  });
  handle('voice:speed', (_e, v: unknown) => {
    if (typeof v === 'number') ctl.setSpeed(v);
    return ctl.state();
  });
  handle('voice:selection', (_e, on: unknown) => {
    if (typeof on === 'boolean') ctl.setSelectionButton(on);
    return ctl.state();
  });
  handle('voice:hotkey', (_e, vk: unknown) => {
    if (typeof vk === 'number' && Number.isInteger(vk)) ctl.setHotkey(vk);
    return ctl.state();
  });
  handle('voice:test', () => {
    void ctl.test();
    return ctl.state();
  });
  handle('voice:keysLink', () => {
    const url = Providers.byId(settings.get().TtsProvider)?.keysUrl ?? '';
    // Only the fixed https pages from the provider list, opened in the user's browser.
    if (url.startsWith('https://')) void shell.openExternal(url);
    return true;
  });
  handle('voice:speak', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return false;
    speak(text);
    return true;
  });

  return {
    controller: ctl,
    speak,
    speakSelection,
    mouseUp,
    applyHelper,
    dispose: () => {
      reading?.abort();
      ctl.dispose();
      if (pushTimer) clearTimeout(pushTimer);
      pill.destroy();
      player.destroy();
    },
  };
}
