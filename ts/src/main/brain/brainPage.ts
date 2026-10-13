// «Мозг» page logic. Port of the Brain parts of SettingsWindow.xaml.cs (Localize / UpdateBrainTexts /
// Brain_Changed / EveryTake / Instruction / Selection / BrainDevice / FillBrainModelRows) plus the whole
// BrainServerPanel and App.SelectBrainAsync. No Electron imports, so it is unit-tested with a fake fetch
// and a fake timer. The saved API key never goes to the renderer: the page only learns whether one is
// saved. Nothing goes over the network until the user picks a service and pastes a key (or an address).

import { basename } from 'node:path';
import { isRussian, t } from '../../core/strings';
import * as Log from '../log';
import {
  emptyRule,
  exeKey,
  isActive,
  MAX_APP_RULES,
  suggestedMatch,
  type AppRule,
  type AppRuleEdit,
  type AppRuleToggle,
  type ForegroundApp,
} from '../../core/appRules';
import type { BrainDeviceKind, BrainSource, LocalBrainKind, SettingsData } from '../settings';
import * as Providers from './brainProviders';
import type { BrainProvider } from './brainProviders';
import { serverConfigured } from './brain';
import * as LocalBrain from './localBrain';
import { ModelDownloadException, type DownloadFailure } from '../models/modelDownloader';
import { failureText, progressText } from '../speech/speechPage';
import { getModelsAsync, hostOf, isInsecureRemote, probeAsync, tryGetCompletionsUrl, type FetchLike } from './speechCleanup';

export const LOCAL_KINDS: readonly LocalBrainKind[] = ['Qwen3', 'Qwen35', 'Custom'];

export interface BrainModelRowDto {
  /** Built-in or custom choice; null for a stray .gguf in the brain folder. */
  kind: LocalBrainKind | null;
  label: string;
  selected: boolean;
  onDisk: boolean;
  path: string | null;
  /** «Скачать» on the row: the file is missing, or it is selected and the engine for the device is not. */
  canDownload: boolean;
  downloadLabel: string;
}

/** The in-page download card (WPF DownloadWindow folded into the page). */
export interface BrainDownloadDto {
  kind: LocalBrainKind;
  title: string;
  intro: string;
  percent: number | null;
  text: string;
  running: boolean;
  failed: boolean;
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
  download: BrainDownloadDto | null;
  appRules: AppRulesDto;
}

export interface AppRuleDto {
  match: string;
  edit: AppRuleEdit;
  instruction: string;
  /** The instruction box is shown only for «Своя инструкция». */
  instructionVisible: boolean;
  simple: AppRuleToggle;
  /** Empty Match: the row never fires. */
  active: boolean;
  /** This rule fired for the last take. */
  hit: boolean;
}

export interface AppRulesDto {
  heading: string;
  hint: string;
  rules: AppRuleDto[];
  /** The rewrite choice needs a Brain; with the Brain off only simple syntax can be overridden. */
  editVisible: boolean;
  editChoices: { value: AppRuleEdit; label: string }[];
  simpleChoices: { value: AppRuleToggle; label: string }[];
  matchPlaceholder: string;
  instructionPlaceholder: string;
  /** «Последняя программа при диктовке: telegram» or empty before the first take with rules. */
  last: string;
  /** Program name to prefill: «Добавить для telegram». */
  lastMatch: string;
  canAdd: boolean;
}

export interface AppRulePatch {
  match?: string;
  edit?: AppRuleEdit;
  instruction?: string;
  simple?: AppRuleToggle;
}

export interface LastApp {
  app: ForegroundApp | null;
  ruleIndex: number | null;
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
  /** LocalBrain.Stop. */
  stopLocal?: () => void;
  /** LocalBrain.downloadAsync; tests pass a fake. Runs only when the user presses «Скачать». */
  download?: (s: SettingsData, progress: (p: LocalBrain.BrainProgress) => void, signal: AbortSignal) => Promise<void>;
  /** LocalBrain.DeviceNote: set after a Vulkan → CPU fallback. */
  deviceNote?: () => string | null;
  fetch?: FetchLike;
  timer?: TimerLike;
  /** The selection is read by the Windows helper only: the checkbox is hidden elsewhere. */
  platform?: NodeJS.Platform;
  installed?: () => LocalBrain.InstalledGguf[];
  isReady?: (s: SettingsData) => boolean;
  /** Key debounce, WPF 600 ms. */
  keyPauseMs?: number;
  /** The program seen at the last take with per-app rules (DictationSession.onApp). */
  lastApp?: () => LastApp | null;
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

export function notOnDiskNote(): string {
  return t('Файла ещё нет. Нажмите кнопку, сама модель не скачивается.', 'Not on disk yet. Press the button. It does not download by itself.');
}

const isAbort = (e: unknown) =>
  (e instanceof Error && e.name === 'AbortError') ||
  (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ABORT_ERR');

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
  private dlAbort: AbortController | null = null;
  private dl: BrainDownloadDto | null = null;
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

  // ── per-app modes ──────────────────────────────────────

  /** Adds a rule at the end; match prefilled with the last program when the user asks for it. */
  addRule(match = ''): void {
    const s = this.s();
    if (s.AppRules.length >= MAX_APP_RULES) return;
    s.AppRules = [...s.AppRules, emptyRule(match.trim().slice(0, 500))];
    this.persist();
  }

  updateRule(index: number, patch: AppRulePatch): void {
    const s = this.s();
    const old = s.AppRules[index];
    if (!old) return;
    const next: AppRule = { ...old };
    if (typeof patch.match === 'string') next.Match = patch.match.slice(0, 500);
    if (patch.edit === 'Default' || patch.edit === 'Off' || patch.edit === 'Custom') next.Edit = patch.edit;
    if (typeof patch.instruction === 'string') next.Instruction = patch.instruction.slice(0, 4000);
    if (patch.simple === 'Default' || patch.simple === 'On' || patch.simple === 'Off') next.SimpleSyntax = patch.simple;
    if (JSON.stringify(next) === JSON.stringify(old)) return;
    s.AppRules = s.AppRules.map((r, i) => (i === index ? next : r));
    this.persist();
  }

  removeRule(index: number): void {
    const s = this.s();
    if (!s.AppRules[index]) return;
    s.AppRules = s.AppRules.filter((_, i) => i !== index);
    this.persist();
  }

  /** Moves a rule one place up: the first matching rule wins. */
  raiseRule(index: number): void {
    const s = this.s();
    if (index <= 0 || index >= s.AppRules.length) return;
    const list = [...s.AppRules];
    [list[index - 1], list[index]] = [list[index]!, list[index - 1]!];
    s.AppRules = list;
    this.persist();
  }

  private appRulesState(s: SettingsData): AppRulesDto {
    const last = this.h.lastApp?.() ?? null;
    const lastMatch = suggestedMatch(last?.app ?? null);
    let lastLine = '';
    if (last?.app) {
      const name = exeKey(last.app.exe);
      lastLine = last.ruleIndex !== null
        ? t(`Последняя программа при диктовке: ${name}. Сработало правило ${last.ruleIndex + 1}.`, `Program at the last take: ${name}. Rule ${last.ruleIndex + 1} applied.`)
        : t(`Последняя программа при диктовке: ${name}. Ни одно правило не подошло.`, `Program at the last take: ${name}. No rule matched.`);
    } else if (last && s.AppRules.length > 0) {
      lastLine = t('При последней диктовке в фокусе было окно Chawo, или программу определить не удалось.', 'At the last take the Chawo window had the focus, or the program could not be told.');
    }
    const brainOn = s.Brain !== 'Off';
    return {
      heading: t('Для отдельных программ', 'For particular programs'),
      hint: t(
        'Правило меняет правку, пока при нажатии клавиши в фокусе эта программа. Подходит первое сверху. Имя программы (telegram, winword) или часть заголовка окна, несколько через запятую. Программа определяется только на этом компьютере и никуда не уходит.',
        'A rule changes the editing while that program has the focus at key press. The first one from the top applies. A program name (telegram, winword) or part of the window title, several separated by commas. The program is detected on this computer only and goes nowhere.',
      ),
      rules: s.AppRules.map((r, i) => ({
        match: r.Match,
        edit: r.Edit,
        instruction: r.Instruction,
        instructionVisible: brainOn && r.Edit === 'Custom',
        simple: r.SimpleSyntax,
        active: isActive(r),
        hit: last?.ruleIndex === i,
      })),
      editVisible: brainOn,
      editChoices: [
        { value: 'Default', label: t('Правка как обычно', 'Usual editing') },
        { value: 'Off', label: t('Не переписывать', 'Do not rewrite') },
        { value: 'Custom', label: t('Переписывать по своей инструкции', 'Rewrite by own instruction') },
      ],
      simpleChoices: [
        { value: 'Default', label: t('Точка и заглавная как обычно', 'Period and capital as usual') },
        { value: 'On', label: t('Как в чате: без точки, со строчной', 'Chat style: no period, lowercase') },
        { value: 'Off', label: t('С точкой и заглавной', 'With period and capital') },
      ],
      matchPlaceholder: t('telegram, winword, «Почта»', 'telegram, winword, "Inbox"'),
      instructionPlaceholder: t('Пусто: убрать повторы и слова-паразиты', 'Empty: drop repeats and filler'),
      last: lastLine,
      lastMatch: lastMatch && !s.AppRules.some((r) => r.Match.trim().toLowerCase() === lastMatch) ? lastMatch : '',
      canAdd: s.AppRules.length < MAX_APP_RULES,
    };
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

  get downloading(): boolean {
    return this.dl?.running === true;
  }

  private card(kind: LocalBrainKind, s: SettingsData, over: Partial<BrainDownloadDto>): BrainDownloadDto {
    // WPF says «Нейросеть Своя модель»; the file name reads better for a custom link.
    const custom = s.BrainModel === 'Custom' ? LocalBrain.tryParseCustomUrl(s.BrainCustomUrl) : null;
    const name = custom?.ok ? custom.fileName : LocalBrain.title(s);
    return {
      kind,
      title: t('Скачиваю Мозг', 'Downloading the Brain'),
      intro: t(
        `Нейросеть ${name} и движок llama.cpp. Если связь оборвётся, скачивание продолжится с того же места. Файл не запускается как программа.`,
        `The ${name} model and the llama.cpp engine. If the connection drops, the download resumes. The file is not run as a program.`,
      ),
      percent: null,
      text: '',
      running: false,
      failed: false,
      ...over,
    };
  }

  /**
   * SettingsWindow.BrainRowDownload_Click + DownloadBrainAsync: selects the row's model, then fetches the engine
   * and the GGUF with progress on the page. Resolves when it ends (done, failed or cancelled).
   */
  async download(kind: LocalBrainKind): Promise<void> {
    if (!LOCAL_KINDS.includes(kind) || this.downloading) return;
    this.selectLocalModel(kind);
    const s = this.s();
    if (kind === 'Custom') {
      const parsed = LocalBrain.tryParseCustomUrl(s.BrainCustomUrl);
      if (!parsed.ok) {
        this.dl = this.card(kind, s, { failed: true, text: parsed.error });
        this.h.push?.();
        return;
      }
    }
    if (this.isReady(s)) {
      this.dl = this.card(kind, s, {
        percent: 100,
        text: t(`Эта модель уже на диске. ${LocalBrain.modelPath(s)}`, `This model is already on disk. ${LocalBrain.modelPath(s)}`),
      });
      this.h.push?.();
      return;
    }
    const abort = new AbortController();
    this.dlAbort = abort;
    this.dl = this.card(kind, s, { running: true, text: t('Соединяюсь…', 'Connecting…') });
    this.h.push?.();
    const run = this.h.download ?? ((st, p, sig) => LocalBrain.downloadAsync(st, p, sig));
    try {
      await run(s, (p) => {
        if (abort.signal.aborted) return;
        this.dl = this.card(kind, s, { running: true, ...progressText({ received: p.received, total: p.total, stage: p.phase }) });
        this.h.push?.();
      }, abort.signal);
      this.dl = null;
      Log.write(`brain downloaded: ${LocalBrain.title(s)}`);
      this.h.changed?.();
    } catch (e) {
      if (abort.signal.aborted || isAbort(e)) this.dl = null;
      else {
        Log.write(`brain download failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        const fk: DownloadFailure = e instanceof ModelDownloadException ? e.kind : 'network';
        const gb = LocalBrain.gb(LocalBrain.memoryNeeded(s));
        const need = t(gb.replace('.', ',') + ' ГБ', gb + ' GB');
        this.dl = this.card(kind, s, { failed: true, text: failureText(fk, e instanceof Error ? e.message : String(e), need) });
      }
    } finally {
      if (this.dlAbort === abort) this.dlAbort = null;
      this.h.push?.();
    }
  }

  cancelDownload(): void {
    this.dlAbort?.abort();
  }

  dismissDownload(): void {
    if (this.downloading) return;
    this.dl = null;
    this.h.push?.();
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

  private localRows(s: SettingsData, ready: boolean): BrainModelRowDto[] {
    const files = (this.h.installed ?? LocalBrain.installedGgufs)();
    const claimed = new Set<string>();
    const rows: BrainModelRowDto[] = [];
    for (const kind of LOCAL_KINDS) {
      const path = brainFileFor(kind, s.BrainCustomUrl, files);
      if (path) claimed.add(path);
      const selected = s.BrainModel === kind;
      const onDisk = path != null;
      // Model on disk but the engine for this device is not (e.g. Vulkan picked later): the button fetches only that.
      const engineOnly = onDisk && selected && !ready;
      rows.push({
        kind,
        label: LocalBrain.choiceLabel(kind),
        selected,
        onDisk,
        path,
        canDownload: !onDisk || engineOnly,
        downloadLabel: engineOnly ? t('Скачать движок', 'Download engine') : t('Скачать', 'Download'),
      });
    }
    for (const f of files) {
      if (claimed.has(f.path)) continue;
      rows.push({ kind: null, label: f.label, selected: false, onDisk: true, path: f.path, canDownload: false, downloadLabel: '' });
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
      else if (ready) {
        const note = (this.h.deviceNote ?? LocalBrain.deviceNote)();
        fileStatus = t('Уже на диске: ', 'Already on disk: ') + LocalBrain.modelPath(s) + (note ? ' ' + note : '');
      } else fileStatus = notOnDiskNote();
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
        rows: local ? this.localRows(s, ready) : [],
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
        visible: b !== 'Off' && (this.h.platform ?? process.platform) === 'win32',
        on: s.BrainOnSelection,
        hint: t(
          'Выделите текст, зажмите клавишу и скажите, что сделать. Выключите, если хотите диктовать поверх выделения.',
          'Select text, hold the key, and say what to do. Turn off to dictate over a selection.',
        ),
      },
      download: this.dl,
      appRules: this.appRulesState(s),
    };
  }
}
