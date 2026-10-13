// «Мозг» page logic. Port of the Brain parts of SettingsWindow.xaml.cs (Localize / UpdateBrainTexts /
// Brain_Changed / EveryTake / Instruction / Selection / BrainDevice / FillBrainModelRows) plus the whole
// BrainServerPanel and App.SelectBrainAsync. No Electron imports, so it is unit-tested with a fake fetch
// and a fake timer. The saved API key never goes to the renderer: the page only learns whether one is
// saved. Nothing goes over the network until the user picks a service and pastes a key (or an address).

import { basename } from 'node:path';
import { isRussian, t } from '../../core/strings';
import * as Log from '../log';
import type { BrainDeviceKind, BrainSource, LocalBrainKind, SettingsData } from '../settings';
import * as Providers from './brainProviders';
import type { BrainProvider } from './brainProviders';
import { serverConfigured } from './brain';
import * as LocalBrain from './localBrain';
import { getModelsAsync, hostOf, isInsecureRemote, probeAsync, tryGetCompletionsUrl, type FetchLike } from './speechCleanup';

export const LOCAL_KINDS: readonly LocalBrainKind[] = ['Qwen3', 'Qwen35', 'Custom'];

export interface BrainModelRowDto {
  /** Built-in or custom choice; null for a stray .gguf in the brain folder. */
  kind: LocalBrainKind | null;
  label: string;
  selected: boolean;
  onDisk: boolean;
  path: string | null;
}

export interface BrainStateDto {
  ru: boolean;
  heading: string;
  hint: string;
  source: BrainSource;
  sourceChoices: { value: BrainSource; label: string }[];
  status: string;
  server: {
    visible: boolean;
    providers: { id: string; label: string }[];
    providerId: string;
    custom: boolean;
    url: string;
    keySaved: boolean;
    keyPlaceholder: string;
    keysLink: string;
    keysLinkEnabled: boolean;
    model: string;
    models: string[];
    loading: boolean;
    status: string;
  };
  local: {
    visible: boolean;
    rows: BrainModelRowDto[];
    device: BrainDeviceKind;
    deviceChoices: { value: BrainDeviceKind; label: string }[];
    deviceHint: string;
    customUrlVisible: boolean;
    customUrl: string;
    fileStatus: string;
  };
  everyTake: { visible: boolean; on: boolean; hint: string };
  instruction: { visible: boolean; text: string; hint: string };
  selection: { visible: boolean; on: boolean; hint: string };
}

export interface TimerLike {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BrainPageHooks {
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  /** After any saved change (tray, file page and dictation follow the settings). */
  changed?: () => void;
  /** Push a fresh state to the window after async work (model list, probe). */
  push?: () => void;
  /** LocalBrain.Stop once the process port lands. */
  stopLocal?: () => void;
  fetch?: FetchLike;
  timer?: TimerLike;
  installed?: () => LocalBrain.InstalledGguf[];
  isReady?: (s: SettingsData) => boolean;
  /** Key debounce, WPF 600 ms. */
  keyPauseMs?: number;
}

const realTimer: TimerLike = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The .gguf on disk that belongs to a choice (SettingsWindow.BrainFileFor). */
export function brainFileFor(kind: LocalBrainKind, customUrl: string, files: readonly LocalBrain.InstalledGguf[]): string | null {
  const custom = LocalBrain.tryParseCustomUrl(customUrl);
  for (const file of files) {
    const name = basename(file.path);
    if (kind === 'Qwen3' && sameName(name, LocalBrain.ModelFile)) return file.path;
    if (kind === 'Qwen35' && sameName(name, LocalBrain.Qwen35File)) return file.path;
    if (
      kind === 'Custom' &&
      custom.ok &&
      sameName(name, custom.fileName) &&
      !sameName(name, LocalBrain.ModelFile) &&
      !sameName(name, LocalBrain.Qwen35File)
    )
      return file.path;
  }
  if (kind === 'Custom' && custom.ok) {
    for (const file of files) if (sameName(basename(file.path), custom.fileName)) return file.path;
  }
  return null;
}

export function downloadNote(): string {
  return t(
    'Файла ещё нет. Скачивание модели и движка в этой версии ещё не перенесено: пока скачайте в WPF-приложении или положите .gguf в папку мозга.',
    'Not on disk yet. Model and engine download is not ported to this version: download it in the WPF app for now or put a .gguf into the Brain folder.',
  );
}

export function insecureWarning(): string {
  return t(
    'Внимание: адрес с http://, а сервер не на этом компьютере и не в домашней сети. Текст и ключ идут по интернету без шифрования, лучше https://.',
    'Warning: an http:// address outside this computer and your home network. Text and key cross the internet unencrypted; prefer https://.',
  );
}

export class BrainController {
  private provider: BrainProvider;
  private lastProvider: BrainProvider;
  /** Key for the current service, typed or saved. Stays in the main process. */
  private key = '';
  private url = '';
  private model = '';
  private models: string[] = [];
  private loading = false;
  private serverStatus = '';
  private keyTimer: unknown = null;
  private abort: AbortController | null = null;
  private readonly timer: TimerLike;

  constructor(private readonly h: BrainPageHooks) {
    this.timer = h.timer ?? realTimer;
    const s = h.settings();
    this.provider = Providers.DeepSeek;
    this.lastProvider = this.provider;
    this.bind(s);
  }

  /** BrainServerPanel.Bind: the fields come back from settings when the page opens. */
  bind(s: SettingsData = this.h.settings()): void {
    this.cancel();
    const current = s.CleanupEndpointUrl.length > 0 ? Providers.fromUrl(s.CleanupEndpointUrl) : Providers.DeepSeek;
    this.provider = current;
    this.lastProvider = current;
    this.url = current.isCustom ? s.CleanupEndpointUrl : '';
    this.key = s.CleanupApiKey;
    this.model = s.CleanupModel;
    this.models = [];
    this.serverStatus = serverConfigured(s)
      ? t(
          `Текст (не звук) уходит на ${hostOf(s.CleanupEndpointUrl)}, модель ${s.CleanupModel}.`,
          `Text (not audio) goes to ${hostOf(s.CleanupEndpointUrl)}, model ${s.CleanupModel}.`,
        )
      : t('Выберите сервис и вставьте ключ, модель подберётся сама.', 'Pick the service and paste the key; the model is chosen for you.');
  }

  /** Window closed or page re-bound: no key goes anywhere after that. */
  cancel(): void {
    if (this.keyTimer != null) this.timer.clear(this.keyTimer);
    this.keyTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.loading = false;
  }

  private get endpoint(): string {
    return this.provider.isCustom ? this.url.trim() : this.provider.baseUrl;
  }

  private s(): SettingsData {
    return this.h.settings();
  }

  private persist(): void {
    this.h.save(this.s());
    this.h.changed?.();
  }

  private isReady(s: SettingsData): boolean {
    return (this.h.isReady ?? LocalBrain.isReady)(s);
  }

  private providerTitle(p: BrainProvider): string {
    const saved = Object.prototype.hasOwnProperty.call(this.s().ProviderKeys, p.id);
    return saved ? Providers.title(p) + t('  ·  ключ сохранён', '  ·  key saved') : Providers.title(p);
  }

  // ── source ─────────────────────────────────────────────

  /** App.SelectBrainAsync without the window juggling: the page is already open. */
  setSource(source: BrainSource): void {
    const s = this.s();
    if (source === s.Brain) return;
    if (source !== 'Local' && s.Brain === 'Local') this.h.stopLocal?.();
    s.Brain = source;
    this.persist();
  }

  setEveryTake(on: boolean): void {
    const s = this.s();
    if (on === s.BrainEveryTake) return;
    s.BrainEveryTake = on;
    this.persist();
  }

  setInstruction(text: string): void {
    const s = this.s();
    if (text === s.BrainInstruction) return;
    s.BrainInstruction = text;
    this.persist();
  }

  setSelection(on: boolean): void {
    const s = this.s();
    if (on === s.BrainOnSelection) return;
    s.BrainOnSelection = on;
    this.persist();
  }

  // ── local ──────────────────────────────────────────────

  setDevice(device: BrainDeviceKind): void {
    const s = this.s();
    if (device === s.BrainDevice) return;
    s.BrainDevice = device;
    this.h.stopLocal?.();
    this.persist();
  }

  selectLocalModel(kind: LocalBrainKind): void {
    const s = this.s();
    if (kind === s.BrainModel) return;
    s.BrainModel = kind;
    this.h.stopLocal?.();
    this.persist();
  }

  setCustomUrl(url: string): void {
    const s = this.s();
    const v = url.trim();
    if (v === s.BrainCustomUrl) return;
    s.BrainCustomUrl = v;
    if (s.BrainModel === 'Custom') this.h.stopLocal?.();
    this.persist();
  }

  /** A .gguf the page may delete: only files listed in the brain folder. */
  deletablePath(path: string): string | null {
    const files = (this.h.installed ?? LocalBrain.installedGgufs)();
    return files.find((f) => f.path === path)?.path ?? null;
  }

  // ── server ─────────────────────────────────────────────

  /** Every service keeps its own key and model; a key never travels to a service it was not entered for. */
  setProvider(id: string): void {
    const next = Providers.All.find((p) => p.id === id);
    if (!next || next === this.provider) return;
    const s = this.s();
    const typed = this.key.trim();
    if (typed.length > 0) s.ProviderKeys[this.lastProvider.id] = typed;
    if (this.model.trim().length > 0) s.ProviderModels[this.lastProvider.id] = this.model.trim();
    this.cancel();
    this.provider = next;
    this.lastProvider = next;
    this.key = s.ProviderKeys[next.id] ?? '';
    this.models = [];
    const savedModel = s.ProviderModels[next.id] ?? '';
    this.model = savedModel.length > 0 ? savedModel : !next.isCustom && next.preferredModels.length > 0 ? next.preferredModels[0]! : '';
    this.serverStatus = '';
    if (!next.isCustom && this.key.length > 0) void this.loadModels(savedModel.length === 0);
  }

  /** A pasted key tells which service it is from; then the model list loads after a short pause. */
  setKey(raw: string): void {
    this.key = raw;
    const guess = Providers.fromKey(raw);
    if (guess && guess !== this.provider && !(this.provider.isCustom && this.url.trim().length > 0)) {
      this.cancel();
      this.provider = guess;
      this.lastProvider = guess;
      this.models = [];
      this.model = '';
      this.serverStatus = t(`Похоже на ключ ${guess.name}, выбрал его.`, `Looks like a ${guess.name} key, selected it.`);
    }
    if (this.keyTimer != null) this.timer.clear(this.keyTimer);
    this.keyTimer = null;
    if (raw.trim().length > 0) {
      this.keyTimer = this.timer.set(() => {
        this.keyTimer = null;
        void this.loadModels(true);
      }, this.h.keyPauseMs ?? 600);
    } else {
      this.abort?.abort();
    }
  }

  setUrl(raw: string): void {
    this.url = raw;
    if (!tryGetCompletionsUrl(this.endpoint)) return;
    void this.loadModels(this.model.trim().length === 0);
  }

  /** Model typed or picked: save when the set is usable, then ask the model for one word. */
  setModel(model: string): Promise<void> {
    this.model = model;
    if (!this.trySave()) return Promise.resolve();
    this.abort?.abort();
    const ac = (this.abort = new AbortController());
    return this.probe(ac.signal);
  }

  refresh(): Promise<void> {
    return this.loadModels(this.model.trim().length === 0);
  }

  keysUrl(): string {
    return this.provider.keysUrl;
  }

  async loadModels(pickDefault: boolean): Promise<void> {
    const p = this.provider;
    const endpoint = this.endpoint;
    if (!tryGetCompletionsUrl(endpoint)) {
      this.serverStatus = t('Впишите адрес сервера.', 'Enter the server address.');
      this.h.push?.();
      return;
    }
    this.abort?.abort();
    const ac = (this.abort = new AbortController());
    this.loading = true;
    this.serverStatus = t('Проверяю ключ и загружаю модели…', 'Checking the key and loading models…');
    this.h.push?.();
    try {
      const ids = await getModelsAsync(endpoint, this.key, ac.signal, this.h.fetch);
      if (ac.signal.aborted) return;
      const models = [...new Set(Providers.chatModels(ids))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'accent' }),
      );
      const typed = this.model.trim();
      this.models = models;
      this.model = pickDefault || typed.length === 0 ? (Providers.pickDefault(p, models) ?? '') : typed;
      if (this.trySave()) await this.probe(ac.signal);
    } catch (e) {
      if (ac.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      Log.write(`brain models failed: ${msg}`);
      if (/HTTP (401|403)\b/.test(msg)) {
        this.serverStatus = t(
          `${p.name} не принял ключ. Проверьте, что ключ от этого сервиса и скопирован целиком.`,
          `${p.name} rejected the key. Check that it is for this service and copied in full.`,
        );
      } else {
        if (!p.isCustom && this.model.trim().length === 0) this.model = p.preferredModels[0] ?? '';
        this.serverStatus = t('Список моделей не загрузился: ' + msg, 'Could not load the model list: ' + msg);
        this.trySave();
      }
    } finally {
      if (this.abort === ac) {
        this.loading = false;
        this.abort = null;
      }
      this.h.push?.();
    }
  }

  private async probe(signal: AbortSignal): Promise<void> {
    const endpoint = this.endpoint;
    const model = this.model.trim();
    const key = this.key.trim();
    this.serverStatus = t(`Ключ подошёл, проверяю модель ${model}…`, `The key works, checking model ${model}…`);
    this.h.push?.();
    try {
      await probeAsync(endpoint, key, model, signal, this.h.fetch);
      if (signal.aborted) return;
      this.serverStatus = t(
        `Всё работает, сохранено. Модель ${model}, текст (не звук) уходит на ${hostOf(endpoint)}.`,
        `All set and saved. Model ${model}; text (not audio) goes to ${hostOf(endpoint)}.`,
      );
      if (isInsecureRemote(endpoint)) this.serverStatus += ' ' + insecureWarning();
    } catch (e) {
      if (signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.serverStatus = t(`Ключ принят, но нейросеть не отвечает: ${msg}.`, `The key is accepted, but the model does not answer: ${msg}.`);
    } finally {
      this.h.push?.();
    }
  }

  /** Saves address, key and model when they make a usable set. True when saved (or already saved). */
  private trySave(): boolean {
    const s = this.s();
    const endpoint = this.endpoint;
    const model = this.model.trim();
    const key = this.key.trim();
    if (!serverConfigured(endpoint, model, key)) return false;
    if (endpoint === s.CleanupEndpointUrl && key === s.CleanupApiKey && model === s.CleanupModel) return true;
    s.CleanupEndpointUrl = endpoint;
    s.CleanupApiKey = key;
    s.CleanupModel = model;
    if (key.length > 0) s.ProviderKeys[this.provider.id] = key;
    s.ProviderModels[this.provider.id] = model;
    this.persist();
    if (isInsecureRemote(endpoint)) this.serverStatus = insecureWarning();
    return true;
  }

  // ── state ──────────────────────────────────────────────

  private localRows(s: SettingsData): BrainModelRowDto[] {
    const files = (this.h.installed ?? LocalBrain.installedGgufs)();
    const claimed = new Set<string>();
    const rows: BrainModelRowDto[] = [];
    for (const kind of LOCAL_KINDS) {
      const path = brainFileFor(kind, s.BrainCustomUrl, files);
      if (path) claimed.add(path);
      rows.push({ kind, label: LocalBrain.choiceLabel(kind), selected: s.BrainModel === kind, onDisk: path != null, path });
    }
    for (const f of files) {
      if (claimed.has(f.path)) continue;
      rows.push({ kind: null, label: f.label, selected: false, onDisk: true, path: f.path });
    }
    return rows;
  }

  state(): BrainStateDto {
    const s = this.s();
    const b = s.Brain;
    const local = b === 'Local';
    const ready = this.isReady(s);
    const sourceChoices: { value: BrainSource; label: string }[] = [{ value: 'Off', label: t('Выключен', 'Off') }];
    if (LocalBrain.Offered || local)
      sourceChoices.push({
        value: 'Local',
        label: ready
          ? t(`На компьютере (${LocalBrain.title(s)})`, `On this computer (${LocalBrain.title(s)})`)
          : t('На компьютере', 'On this computer'),
      });
    sourceChoices.push({ value: 'Server', label: t('В облаке', 'In the cloud') });

    let fileStatus = '';
    if (local) {
      const parsed = LocalBrain.tryParseCustomUrl(s.BrainCustomUrl);
      if (s.BrainModel === 'Custom' && !parsed.ok) fileStatus = parsed.error;
      else if (ready) fileStatus = t('Уже на диске: ', 'Already on disk: ') + LocalBrain.modelPath(s);
      // WPF says «Нажмите кнопку»; the download button is not ported yet, so say what to do instead.
      else fileStatus = downloadNote();
    }
    const p = this.provider;
    const keySaved = this.key.trim().length > 0;
    return {
      ru: isRussian(),
      heading: t('Мозг', 'Brain'),
      hint: t(
        'Выключен: текст вставляется как распознан. Можно сказать «Чаво, исправь». Чтобы править каждую фразу, включите переписывание ниже.',
        'Off: text is inserted as recognized. You can say "Chawo, fix it". Turn on rewrite below to edit every phrase.',
      ),
      source: b,
      sourceChoices,
      status:
        b === 'Local'
          ? t(
              'Работает без интернета и без ключей. Медленнее облака: фраза правится за несколько секунд, на обычном ноутбуке дольше. Пока нужен, занимает около 2,5 ГБ памяти, через 15 минут без дела выгружается.',
              'Works offline, no keys. Slower than the cloud: a phrase takes a few seconds, longer on an ordinary laptop. Takes about 2.5 GB of memory while needed, unloads after 15 idle minutes.',
            )
          : b === 'Off'
            ? t('Текст вставляется как распознан.', 'Text is inserted as recognized.')
            : '',
      server: {
        visible: b === 'Server',
        providers: Providers.All.map((x) => ({ id: x.id, label: this.providerTitle(x) })),
        providerId: p.id,
        custom: p.isCustom,
        url: this.url,
        keySaved,
        keyPlaceholder: keySaved
          ? t('Ключ сохранён. Вставьте новый, чтобы заменить.', 'Key saved. Paste a new one to replace it.')
          : t('Вставьте ключ', 'Paste the key'),
        keysLink: p.isCustom
          ? t('Для своего сервера ключ обычно не нужен', 'Your own server usually needs no key')
          : t(`Где взять ключ ${p.name}`, `Get a ${p.name} key`),
        keysLinkEnabled: !p.isCustom && p.keysUrl.length > 0,
        model: this.model,
        models: this.models,
        loading: this.loading,
        status: this.serverStatus,
      },
      local: {
        visible: local,
        rows: local ? this.localRows(s) : [],
        device: s.BrainDevice,
        deviceChoices: [
          { value: 'Cpu', label: t('Процессор (CPU)', 'Processor (CPU)') },
          { value: 'Gpu', label: t('Видеокарта (Vulkan)', 'Video card (Vulkan)') },
        ],
        deviceHint: t(
          'Процессор уже в программе. Видеокарта качает сборку Vulkan отдельно, в архив программы она не входит.',
          'The processor engine is the normal one. The video card downloads a Vulkan build; it is not inside the app.',
        ),
        customUrlVisible: local && s.BrainModel === 'Custom',
        customUrl: s.BrainCustomUrl,
        fileStatus,
      },
      everyTake: {
        visible: b !== 'Off',
        on: s.BrainEveryTake,
        hint: t(
          'Включите, и ниже будет, как именно переписывать. Выключено: фраза как распознана, пока не скажете «Чаво, …».',
          'Turn on, and the box below is how to rewrite. Off: the phrase is inserted as recognized until you say "Chawo, …".',
        ),
      },
      instruction: {
        visible: b !== 'Off' && s.BrainEveryTake,
        text: s.BrainInstruction,
        hint: t(
          'Пусто: убрать повторы, слова-паразиты и чужой разговор. Смысл не сокращать и слова не добавлять. Написали своё: выполняется только этот текст.',
          "Empty: drop repeats, filler, and someone else's conversation. Do not cut the meaning or add words. Your text: only that is followed.",
        ),
      },
      selection: {
        visible: b !== 'Off',
        on: s.BrainOnSelection,
        hint: t(
          'Выделите текст, зажмите клавишу и скажите, что сделать. Выключите, если хотите диктовать поверх выделения.',
          'Select text, hold the key, and say what to do. Turn off to dictate over a selection.',
        ),
      },
    };
  }
}
