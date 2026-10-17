// «Голос» page logic: which service reads text aloud, its key, model, voice and speed, the «Озвучить»
// button at a selection and a key for it. No Electron imports, so it is unit-tested with a fake fetch.
// The saved key never goes to the renderer: the page only learns whether one is saved. Keys are shared
// with the Brain by service (ProviderKeys[id]). Nothing is sent until the user picks a service.
import { isRussian, t } from '@chawo/core/strings';
import { HOTKEY_CHOICES, LEFT_CTRL_WIN_HOTKEY, type SettingsData } from '../settings';
import { hostOf, isInsecureRemote, isLoopbackEndpoint, type FetchLike } from '../brain/speechCleanup';
import { clampSpeed, SPEEDS } from './playerModel';
import * as Providers from './ttsProviders';
import type { TtsProvider } from './ttsProviders';
import { synthesize, type Speech, type TtsTarget } from './ttsClient';

export interface VoiceStateDto {
  ru: boolean;
  heading: string;
  hint: string;
  providers: { id: string; label: string }[];
  /** '' while no service is chosen (the feature is off). */
  providerId: string;
  note: string;
  url: { visible: boolean; value: string; placeholder: string };
  key: { saved: boolean; placeholder: string; link: string; linkEnabled: boolean };
  model: string;
  models: string[];
  voice: string;
  voices: string[];
  speed: number;
  speeds: { value: number; label: string }[];
  /** Windows only: the native helper sees the selection. */
  selection: { visible: boolean; on: boolean; hint: string };
  hotkey: { visible: boolean; vk: number; choices: { value: number; label: string }[]; hint: string };
  test: { running: boolean; status: string; failed: boolean };
  warning: string;
  ready: boolean;
}

export interface TimerLike {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface VoicePageHooks {
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  /** After any saved change (the helper follows the button and key settings). */
  changed?: () => void;
  /** Push a fresh state to the window after async work (the test). */
  push?: () => void;
  /** Hands the test sound to the player. */
  play?: (speech: Speech, text: string) => void;
  fetch?: FetchLike;
  timer?: TimerLike;
  platform?: NodeJS.Platform;
  /** Key save debounce. */
  keyPauseMs?: number;
}

const realTimer: TimerLike = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export function sampleText(): string {
  return t('Привет! Так звучит этот голос в Чаво.', 'Hello! This is how this voice sounds in Chawo.');
}

/** The address of a service: the saved one for editable services, else the preset. A Xiaomi key of
 *  another cluster (set up on «Мозг») lends its address. */
export function addressFor(p: TtsProvider, s: Pick<SettingsData, 'TtsProvider' | 'TtsEndpointUrl' | 'CleanupEndpointUrl'>): string {
  if (p.editableUrl && s.TtsProvider === p.id && s.TtsEndpointUrl.trim()) return s.TtsEndpointUrl.trim();
  if (p.id === Providers.Xiaomi.id) {
    try {
      const brain = new URL(s.CleanupEndpointUrl.trim());
      if (brain.protocol === 'https:' && brain.hostname.toLowerCase().endsWith('.xiaomimimo.com')) {
        return brain.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      }
    } catch {
      /* no Brain address */
    }
  }
  return p.baseUrl;
}

/** What the service needs to read text: null while it is not set up. */
export function voiceTarget(s: SettingsData): TtsTarget | null {
  const provider = Providers.byId(s.TtsProvider);
  if (!provider) return null;
  const target: TtsTarget = {
    provider,
    baseUrl: addressFor(provider, s),
    key: s.ProviderKeys[provider.id] ?? '',
    model: s.TtsModel.trim() || provider.models[0],
    voice: s.TtsVoice.trim(),
  };
  if (!target.baseUrl || (provider.needsKey && !target.key.trim())) return null;
  return target;
}

/** The keys offered for «Озвучить»: single keys only, the dictation key left out. */
export function ttsKeyChoices(dictationVk: number): { vk: number; ru: string; en: string }[] {
  return HOTKEY_CHOICES.filter((c) => c.vk !== LEFT_CTRL_WIN_HOTKEY && c.vk !== dictationVk);
}

export class VoiceController {
  private key = '';
  private keyTimer: unknown = null;
  private testing: AbortController | null = null;
  private testStatus = '';
  private testFailed = false;
  private readonly timer: TimerLike;

  constructor(private readonly h: VoicePageHooks) {
    this.timer = h.timer ?? realTimer;
    const s = this.s();
    this.key = s.TtsProvider ? (s.ProviderKeys[s.TtsProvider] ?? '') : '';
  }

  private s(): SettingsData {
    return this.h.settings();
  }

  private persist(): void {
    this.h.save(this.s());
    this.h.changed?.();
  }

  private get provider(): TtsProvider | null {
    return Providers.byId(this.s().TtsProvider);
  }

  private get windows(): boolean {
    return (this.h.platform ?? process.platform) === 'win32';
  }

  /** '' turns reading off. Every service keeps its own key; the model and voice start from the preset. */
  setProvider(id: string): void {
    const s = this.s();
    if (id === s.TtsProvider) return;
    const next = Providers.byId(id);
    if (id !== '' && !next) return;
    this.flushKey();
    this.stopTest();
    s.TtsProvider = next?.id ?? '';
    s.TtsEndpointUrl = next?.editableUrl ? addressFor(next, { ...s, TtsEndpointUrl: '' }) : '';
    s.TtsModel = next?.models[0] ?? '';
    s.TtsVoice = next?.voices[0] ?? '';
    this.key = next ? (s.ProviderKeys[next.id] ?? '') : '';
    this.testStatus = '';
    this.testFailed = false;
    this.persist();
  }

  setUrl(raw: string): void {
    const p = this.provider;
    if (!p?.editableUrl) return;
    const s = this.s();
    s.TtsEndpointUrl = raw.trim().slice(0, 2048);
    this.persist();
  }

  /** Saved after a short pause, so typing does not write the key on every letter. */
  setKey(raw: string): void {
    this.key = raw;
    if (this.keyTimer != null) this.timer.clear(this.keyTimer);
    this.keyTimer = this.timer.set(() => {
      this.keyTimer = null;
      this.flushKey();
      this.h.push?.();
    }, this.h.keyPauseMs ?? 600);
  }

  private flushKey(): void {
    if (this.keyTimer != null) this.timer.clear(this.keyTimer);
    this.keyTimer = null;
    const p = this.provider;
    const key = this.key.trim();
    if (!p || key.length === 0) return;
    const s = this.s();
    if (s.ProviderKeys[p.id] === key) return;
    s.ProviderKeys[p.id] = key;
    this.persist();
  }

  setModel(model: string): void {
    const s = this.s();
    s.TtsModel = model.trim().slice(0, 200);
    this.persist();
  }

  setVoice(voice: string): void {
    const s = this.s();
    s.TtsVoice = voice.trim().slice(0, 200);
    this.persist();
  }

  setSpeed(value: number): void {
    const s = this.s();
    const speed = clampSpeed(value);
    if (speed === s.TtsSpeed) return;
    s.TtsSpeed = speed;
    this.persist();
  }

  setSelectionButton(on: boolean): void {
    const s = this.s();
    if (on === s.TtsSelectionButton) return;
    s.TtsSelectionButton = on;
    this.persist();
  }

  setHotkey(vk: number): void {
    const s = this.s();
    if (vk !== 0 && !ttsKeyChoices(s.HotkeyVk).some((c) => c.vk === vk)) return;
    if (vk === s.TtsHotkeyVk) return;
    s.TtsHotkeyVk = vk;
    this.persist();
  }

  /** Reads `text` with the saved service (the player and «Озвучить» buttons use this). */
  speak(text: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<Speech> {
    this.flushKey();
    const target = voiceTarget(this.s());
    if (!target) return Promise.reject(new Error(this.notReadyText()));
    return synthesize(target, text, { signal, fetch: this.h.fetch, onProgress });
  }

  notReadyText(): string {
    const p = this.provider;
    if (!p) return t('Озвучка выключена: выберите сервис на странице «Голос».', 'Reading aloud is off: pick a service on the «Voice» page.');
    if (!addressFor(p, this.s())) return t('Впишите адрес сервера на странице «Голос».', 'Enter the server address on the «Voice» page.');
    return t('Вставьте ключ сервиса на странице «Голос».', 'Paste the service key on the «Voice» page.');
  }

  /** «Проверить»: a short sentence through the service, then into the player. */
  async test(): Promise<void> {
    this.stopTest();
    const ac = (this.testing = new AbortController());
    this.testStatus = t('Проверяю…', 'Checking…');
    this.testFailed = false;
    this.h.push?.();
    const text = sampleText();
    try {
      const speech = await this.speak(text, ac.signal);
      if (ac.signal.aborted) return;
      this.testStatus = t('Работает, звук пришёл.', 'Works, the sound came back.');
      this.h.play?.(speech, text);
    } catch (e) {
      if (ac.signal.aborted) return;
      this.testFailed = true;
      this.testStatus = t('Не получилось: ', 'Failed: ') + (e instanceof Error ? e.message : String(e));
    } finally {
      if (this.testing === ac) this.testing = null;
      this.h.push?.();
    }
  }

  private stopTest(): void {
    this.testing?.abort();
    this.testing = null;
  }

  dispose(): void {
    this.flushKey();
    this.stopTest();
  }

  state(): VoiceStateDto {
    const s = this.s();
    const p = this.provider;
    const keySaved = this.key.trim().length > 0;
    const url = p ? (p.editableUrl ? addressFor(p, s) : p.baseUrl) : '';
    const keyChoices = ttsKeyChoices(s.HotkeyVk);
    const remote = p != null && url.length > 0 && !isLoopbackEndpoint(url);
    let warning = '';
    if (p && url && isInsecureRemote(url))
      warning = t(
        'Адрес без https: текст и ключ идут по сети открытыми. Используйте https или сервер в своей сети.',
        'The address is not https: the text and the key travel unencrypted. Use https or a server on your network.',
      );
    const models = p ? [...p.models] : [];
    const model = s.TtsModel || (p?.models[0] ?? '');
    if (model && !models.includes(model)) models.unshift(model);
    const voices = p ? [...p.voices] : [];
    const voice = s.TtsVoice;
    if (voice && !voices.includes(voice)) voices.unshift(voice);
    return {
      ru: isRussian(),
      heading: t('Голос', 'Voice'),
      hint: t(
        'Озвучка выделенного текста. Выделите текст в любой программе — рядом появится кнопка «Озвучить». Текст уходит на выбранный сервис, звук играет в маленьком плеере.',
        'Reads selected text aloud. Select text in any program and a «Read aloud» button appears next to it. The text goes to the chosen service; the sound plays in a small player.',
      ),
      providers: [{ id: '', label: t('Выключено', 'Off') }, ...Providers.ALL.map((x) => ({ id: x.id, label: Providers.title(x) }))],
      providerId: p?.id ?? '',
      note:
        (p?.note() ?? '') +
        (p && remote ? ' ' + t(`Текст для озвучки уходит на ${hostOf(url)}.`, `The text to read goes to ${hostOf(url)}.`) : ''),
      url: {
        visible: p?.editableUrl ?? false,
        value: url,
        placeholder: p?.id === Providers.Custom.id ? 'http://127.0.0.1:5050/v1' : (p?.baseUrl ?? ''),
      },
      key: {
        saved: keySaved,
        placeholder: keySaved
          ? t('Ключ сохранён. Вставьте новый, чтобы заменить.', 'Key saved. Paste a new one to replace it.')
          : p && !p.needsKey
            ? t('Ключ, если сервер его просит', 'A key, if the server asks for one')
            : t('Вставьте ключ', 'Paste the key'),
        link: p?.keysUrl ? t(`Где взять ключ ${p.name}`, `Get a ${p.name} key`) : '',
        linkEnabled: (p?.keysUrl.length ?? 0) > 0,
      },
      model,
      models,
      voice,
      voices,
      speed: s.TtsSpeed,
      speeds: SPEEDS.map((v) => ({ value: v, label: `${v}×` })),
      selection: {
        visible: this.windows,
        on: s.TtsSelectionButton,
        hint: t(
          'После выделения мышью рядом на пару секунд появляется кнопка «Озвучить». В окнах Чаво не появляется.',
          'After selecting with the mouse a «Read aloud» button shows up for a few seconds. Not in Chawo’s own windows.',
        ),
      },
      hotkey: {
        visible: this.windows,
        vk: keyChoices.some((c) => c.vk === s.TtsHotkeyVk) ? s.TtsHotkeyVk : 0,
        choices: [{ value: 0, label: t('Нет', 'None') }, ...keyChoices.map((c) => ({ value: c.vk, label: t(c.ru, c.en) }))],
        hint: t('Нажмите клавишу — Чаво прочитает выделенный текст. Клавиша диктовки здесь не предлагается.', 'Press the key and Chawo reads the selected text. The dictation key is not offered here.'),
      },
      test: { running: this.testing != null, status: this.testStatus, failed: this.testFailed },
      warning,
      ready: voiceTarget(s) != null,
    };
  }
}
