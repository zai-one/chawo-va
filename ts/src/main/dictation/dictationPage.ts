// «Диктовка» page logic. Port of the Dictation parts of SettingsWindow.xaml.cs (Localize dictation
// block, FillStartCard / StartCardClose_Click, Mode_Changed, Hotkey_Changed, Insert_Changed,
// Overlay_Click, Mic_Changed, SetPhase) and the phase texts of App.SetPhase. No Electron imports, so
// it is unit-tested with fake hooks. The take itself (capture → recognition) lives in
// dictationSession.ts; this controller only reads its phase, status and last text.
//
// Microphones come from the renderer (navigator.mediaDevices.enumerateDevices). Chromium device ids
// are not WASAPI endpoint ids, and settings.json is shared with the WPF app, so ids picked here are
// stored as "web:<deviceId>". A WPF id is left alone (this build records from the default device);
// an unknown "web:" id is cleared to default like WPF does with a vanished endpoint.

import type { SpeechModelKind } from '../../core/speechModels';
import { isRussian, t } from '../../core/strings';
import { findComplete } from '../models';
import {
  HOTKEY_CHOICES,
  toSpeechModelKind,
  type AppMode,
  type InsertMode,
  type SettingsData,
} from '../settings';

export type DictatePhase = 'NoModel' | 'Idle' | 'Listening' | 'Recognizing';

export const WEB_MIC_PREFIX = 'web:';

export interface MicDevice {
  id: string;
  label: string;
}

/** What the take session reports to the page. */
export interface TakeView {
  phase: DictatePhase;
  status: string;
  lastText: string;
  loading: boolean;
}

/** A line of text with page links, e.g. a start-card step. */
export type TextPart = string | { link: string; page: string };

export interface DictationStateDto {
  ru: boolean;
  intro: string;
  startCard: null | { title: string; close: string; steps: TextPart[][] };
  mode: AppMode;
  modeChoices: { value: AppMode; label: string }[];
  modeHint: string;
  hotkey: number;
  hotkeyChoices: { value: number; label: string }[];
  hotkeyTitle: string;
  insertMode: InsertMode;
  insertChoices: { value: InsertMode; label: string }[];
  keyNote: string;
  showOverlay: boolean;
  overlayLabel: string;
  overlayTip: string;
  soundCues: boolean;
  soundCuesLabel: string;
  soundCuesTip: string;
  wakeWord: boolean;
  wakeLabel: string;
  wakeTip: string;
  /** Why the word cannot work right now (client role, no model), or '' . */
  wakeNote: string;
  /** Raw Chromium deviceId for getUserMedia; '' means the system default. */
  micId: string;
  micChoices: { value: string; label: string }[];
  micHint: string;
  phase: DictatePhase;
  phaseLine: string;
  stopEnabled: boolean;
  stopLabel: string;
  stopTip: string;
  holdLabel: string;
  holdEnabled: boolean;
  holdHint: string;
  status: string;
  /** Set when the selected model is not on disk: a hint with a link to «Распознавание». */
  noModel: TextPart[] | null;
  lastText: string;
  lastTextLabel: string;
  client: boolean;
}

export interface DictationHooks {
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  /** After a saved change (tray, take session follow the settings). */
  changed?: () => void;
  /** Push a fresh state to the window. */
  push?: () => void;
  take: () => TakeView;
  find?: (kind: SpeechModelKind) => string | null;
  platform?: NodeJS.Platform;
  /**
   * The global hold key (Windows native helper): on, starting, failed (with a reason), or none (not
   * Windows, or the helper exe is not there). Missing: none.
   */
  globalKey?: () => GlobalKeyState;
}

export type GlobalKeyState = { kind: 'on' } | { kind: 'starting' } | { kind: 'failed'; reason: string } | { kind: 'none' };

/** Settings.HotkeyTitle: the key's name, or "клавиша XX" for an id that is not in the list. */
export function hotkeyTitle(vk: number): string {
  const c = HOTKEY_CHOICES.find((x) => x.vk === vk);
  if (c) return t(c.ru, c.en);
  const hex = (vk >>> 0).toString(16).toUpperCase().padStart(2, '0');
  return t(`клавиша ${hex}`, `key ${hex}`);
}

/** App.SetPhase texts. */
export function phaseText(phase: DictatePhase): string {
  switch (phase) {
    case 'NoModel':
      return t('Сейчас: модель не загружена', 'Now: the model is not loaded');
    case 'Listening':
      return t('Сейчас: слушаю…  отпустите клавишу, черновик на плашке', 'Now: listening…  release the key, draft is on the pill');
    case 'Recognizing':
      return t('Сейчас: распознаю…  вставится окончательный текст', 'Now: recognizing…  the final text will be inserted');
    default:
      return t('Сейчас: готово, жду клавишу. Стоп — кнопка или Escape.', 'Now: ready, waiting for the key. Stop is the button or Escape.');
  }
}

/** Mode hint under the mode box (SettingsWindow.Localize). */
export function modeHint(mode: AppMode): string {
  return mode === 'Sales'
    ? t('Карточка из каталога и, если кода нет, фрагмент из папки материалов. Сеть и модель для неё не нужны. Диктовка вставляет текст как раньше.',
      'The card comes from the catalog and, when the code is missing, a snippet from the materials folder. It needs no network and no model. Dictation still inserts text as before.')
    : t('Обычная диктовка. Карточка продаж не показывается.', 'Ordinary dictation. The sales card stays hidden.');
}

/** getUserMedia failure → the WPF HandlePressAsync wording where it fits. */
export function micErrorText(name: string, message: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return win
      ? t('Windows не даёт доступ к микрофону. Параметры → Конфиденциальность и защита → Микрофон: включите «Доступ к микрофону» и «Разрешить классическим приложениям доступ к микрофону».',
        'Windows denies microphone access. Settings, Privacy and security, Microphone: turn on microphone access and let desktop apps use the microphone.')
      : t('Система не даёт доступ к микрофону. Разрешите его этой программе в настройках конфиденциальности.',
        'The system denies microphone access. Allow it for this app in the privacy settings.');
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return win
      ? t('Windows не видит ни одного устройства записи. Подключите микрофон или включите его в Параметрах звука, раздел «Ввод».',
        'Windows sees no recording device. Connect a microphone or enable one in Sound settings, Input.')
      : t('Система не видит ни одного устройства записи. Подключите микрофон.', 'The system sees no recording device. Connect a microphone.');
  }
  const why = message || name || '?';
  return t(`Не удалось открыть микрофон: ${why}`, `Could not open the microphone: ${why}`);
}

export function noModelText(): TextPart[] {
  return [
    t('Модель не скачана. Откройте ', 'The model is not downloaded. Open '),
    { link: t('«Распознавание»', 'Speech'), page: 'speech' },
    t(' и нажмите «Скачать» в строке модели. Сама она не скачивается.', ' and press Download on the model\'s row. It does not download by itself.'),
  ];
}

/** The parts as plain text (links become their label). */
export function flatText(parts: readonly TextPart[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : p.link)).join('');
}

export class DictationController {
  private devices: MicDevice[] = [];
  private defaultName = '';
  private readonly h: DictationHooks & { find: (kind: SpeechModelKind) => string | null; platform: NodeJS.Platform };

  constructor(hooks: DictationHooks) {
    this.h = { find: findComplete, platform: process.platform, ...hooks };
  }

  private get win(): boolean {
    return this.h.platform === 'win32';
  }

  state(): DictationStateDto {
    const s = this.h.settings();
    const take = this.h.take();
    const client = s.NetworkRole === 'Client';
    const onDisk = client ? false : this.h.find(toSpeechModelKind(s.SpeechModel)) !== null;
    const listening = take.phase === 'Listening';
    const recognizing = take.phase === 'Recognizing';
    const key = hotkeyTitle(s.HotkeyVk);
    const gk = this.h.globalKey?.() ?? { kind: 'none' };
    const keyOn = gk.kind === 'on';
    const noModel = !client && !onDisk ? noModelText() : null;
    let status = take.loading && !take.status ? t('Загружаю модель…', 'Loading the model…') : take.status;
    // A press without a model repeats the hint that is already on the page (with its link): say it once.
    if (noModel && status === flatText(noModel)) status = '';
    return {
      ru: isRussian(),
      intro: keyOn
        ? t('Курсор в любой текст, зажмите клавишу и говорите. Отпустите, и текст появится сам.',
          'Cursor in any text, hold the key and speak. Release and the text appears by itself.')
        : t('Зажмите кнопку ниже и говорите. Отпустите, и появится текст: он показывается здесь и копируется в буфер обмена.',
          'Hold the button below and speak. Release and the text appears: it shows here and goes to the clipboard.'),
      startCard: s.StartHintDismissed ? null : this.startCard(s, onDisk, key, keyOn),
      mode: s.Mode,
      modeChoices: [
        { value: 'Dictation', label: 'Диктовка' },
        { value: 'Sales', label: 'Продажи' },
      ],
      modeHint: modeHint(s.Mode),
      hotkey: HOTKEY_CHOICES.some((c) => c.vk === s.HotkeyVk) ? s.HotkeyVk : HOTKEY_CHOICES[0].vk,
      hotkeyChoices: HOTKEY_CHOICES.map((c) => ({ value: c.vk, label: t(c.ru, c.en) })),
      hotkeyTitle: key,
      insertMode: s.InsertMode,
      insertChoices: [
        { value: 'Type', label: t('Печатать как с клавиатуры', 'Type like a keyboard') },
        { value: 'Paste', label: t('Через буфер обмена (Ctrl+V)', 'Through the clipboard (Ctrl+V)') },
      ],
      keyNote: this.keyNote(gk, key),
      showOverlay: s.ShowOverlay,
      overlayLabel: t('Показывать плашку: волна и черновик текста', 'Show the pill: wave and the draft text'),
      overlayTip: t('Пока клавиша зажата, на плашке волна и черновик. Вставляется не он, а окончательный проход после отпускания. Плашку можно перетащить мышью.',
        'While the key is held the pill shows the wave and a draft. What is inserted is the final pass after release, not the draft. Drag the pill to pin it.'),
      soundCues: s.SoundCues,
      soundCuesLabel: t('Звуковые сигналы начала и конца записи', 'Sound cues when a take starts and ends'),
      soundCuesTip: t('Тихий короткий звук: запись пошла, запись принята, запись отменена. Звуки рождаются в самом приложении, ничего не скачивается.',
        'A soft short tone: recording started, take accepted, take dropped. The tones are made by the app itself; nothing is downloaded.'),
      wakeWord: s.WakeWord,
      wakeLabel: t('Начинать запись по слову «Чаво»', 'Start a take when I say «Чаво»'),
      wakeTip: t('Микрофон слушает всё время, но только на этом компьютере: начало каждой фразы проверяет та же модель, что и диктовку, ничего не записывается и никуда не уходит. «Чаво» и пауза — диктовка до паузы. «Чаво, переведи…» одной фразой — команда Мозгу, как с клавишей.',
        'The microphone listens all the time, but only on this computer: the start of each phrase is checked by the same model as dictation; nothing is saved or sent anywhere. «Чаво» and a pause: dictation until the next pause. «Чаво, translate…» in one breath: a Brain command, as with the key.'),
      wakeNote: s.WakeWord ? this.wakeNote(client, onDisk) : '',
      micId: this.micDeviceId(),
      micChoices: [{ value: '', label: this.defaultLabel() }, ...this.devices.map((d) => ({ value: d.id, label: d.label }))],
      micHint: this.micHint(s),
      phase: take.phase,
      phaseLine: phaseText(take.phase),
      stopEnabled: listening || recognizing,
      stopLabel: t('Стоп', 'Stop'),
      stopTip: t('Остановить запись или распознавание. То же делает Escape. Готовая фраза при этом не вставляется.',
        'Stop recording or recognition. Escape does the same. The phrase is not inserted.'),
      holdLabel: listening
        ? t('Говорите… отпустите, чтобы распознать', 'Speak… release to recognize')
        : recognizing
          ? t('Распознаю…', 'Recognizing…')
          : t('Удерживайте, чтобы говорить', 'Hold to talk'),
      holdEnabled: !recognizing,
      holdHint: client
        ? t('Зажмите кнопку мышью, пальцем или пробелом. Отпустите — запись уйдёт на хост из раздела «Сеть», текст вернётся сюда.',
          'Hold the button with the mouse, a finger or Space. Release and the take goes to the host set under Network; the text comes back here.')
        : t('Зажмите кнопку мышью, пальцем или пробелом. Отпустите — фраза распознается на этом компьютере.',
          'Hold the button with the mouse, a finger or Space. Release and the phrase is recognized on this computer.'),
      status,
      noModel,
      lastText: take.lastText,
      lastTextLabel: t('Последняя фраза', 'Last phrase'),
      client,
    };
  }

  /** One line under the key and insert choices: only when the key does not simply work. */
  private keyNote(gk: GlobalKeyState, key: string): string {
    switch (gk.kind) {
      case 'on':
        return '';
      case 'starting':
        return t(`Включаю клавишу ${key}…`, `Turning on the ${key} key…`);
      case 'failed':
        return t(`Клавиша ${key} не включилась (${gk.reason}). Пока работает кнопка ниже: текст копируется в буфер обмена.`,
          `The ${key} key did not turn on (${gk.reason}). The button below still works: the text goes to the clipboard.`);
      case 'none':
        return this.win
          ? t(`Нет помощника ChawoNative.exe рядом с программой, поэтому клавиша ${key} и вставка в другие программы выключены. Работает кнопка ниже.`,
            `ChawoNative.exe is missing next to the app, so the ${key} key and inserting into other apps are off. The button below works.`)
          : t('Клавиша и вставка в другие программы пока есть только в Windows. Здесь работает кнопка ниже: текст копируется в буфер обмена.',
            'The key and inserting into other apps are Windows-only for now. Here the button below works: the text goes to the clipboard.');
    }
  }

  private startCard(s: SettingsData, onDisk: boolean, key: string, keyOn: boolean): NonNullable<DictationStateDto['startCard']> {
    const step1: TextPart[] = s.NetworkRole === 'Client'
      ? [t('1) Этот ПК — клиент: укажите адрес хоста в разделе ', '1) This PC is a client: set the host address under '),
        { link: t('«Сеть»', 'Network'), page: 'network' }, '.']
      : [t('1) Скачайте речевую модель в разделе ', '1) Download the speech model under '),
        { link: t('«Распознавание»', 'Speech'), page: 'speech' },
        onDisk ? t(' — уже на диске ✓', ' — already on disk ✓') : '.'];
    const step2: TextPart[] = [
      keyOn
        ? t(`2) Поставьте курсор в любое поле, зажмите ${key} и говорите. Отпустите — текст вставится сам.`,
          `2) Put the cursor in any field, hold ${key} and speak. Release, and the text is inserted.`)
        : t('2) Зажмите кнопку «Удерживайте, чтобы говорить» и говорите. Отпустите — текст появится здесь и в буфере обмена.',
          '2) Hold the "Hold to talk" button and speak. Release, and the text shows here and on the clipboard.'),
    ];
    const step3: TextPart[] = [
      t('3) Длинную запись перетащите в это окно — текст ляжет рядом, в ', '3) Drop a long recording onto this window; the text lands beside it, see '),
      { link: t('«Расшифровка файла»', 'File transcription'), page: 'file' }, '.',
    ];
    return { title: t('С чего начать', 'Getting started'), close: t('Больше не показывать', "Don't show again"), steps: [step1, step2, step3] };
  }

  private defaultLabel(): string {
    const base = this.win ? t('По умолчанию Windows', 'Windows default') : t('По умолчанию в системе', 'System default');
    return this.defaultName ? `${base} — ${this.defaultName}` : base;
  }

  private micHint(s: SettingsData): string {
    const hint = this.win
      ? t('По умолчанию — то устройство, которое Windows считает основным. Если входов несколько, они перечислены ниже, можно выбрать свой.',
        'Default is whichever device Windows treats as the main one. If there are more inputs, they are listed and you can pick one.')
      : t('По умолчанию — то устройство, которое система считает основным. Если входов несколько, они перечислены ниже, можно выбрать свой.',
        'Default is whichever device the system treats as the main one. If there are more inputs, they are listed and you can pick one.');
    const id = s.MicrophoneId.trim();
    if (id.length > 0 && !id.startsWith(WEB_MIC_PREFIX)) {
      return hint + t(' Микрофон, выбранный в WPF-приложении, здесь записывается через устройство по умолчанию.',
        ' The microphone picked in the WPF app is recorded through the default device here.');
    }
    return hint;
  }

  /** Raw Chromium deviceId for getUserMedia ('' = default). */
  micDeviceId(): string {
    const id = this.h.settings().MicrophoneId.trim();
    return id.startsWith(WEB_MIC_PREFIX) ? id.slice(WEB_MIC_PREFIX.length) : '';
  }

  /** Name of the microphone a take uses, for the "silence on input" hint. */
  micName(): string {
    const id = this.micDeviceId();
    const d = id ? this.devices.find((x) => x.id === id) : undefined;
    if (d) return d.label;
    return this.defaultName || (this.win ? t('по умолчанию Windows', 'Windows default') : t('по умолчанию в системе', 'system default'));
  }

  /**
   * The renderer's input list (without Chromium's "default"/"communications" aliases) and the
   * default device's name. A saved "web:" id that is not in a non-empty list is cleared, like WPF.
   * An empty list (no permission yet, no devices) changes nothing.
   */
  setDevices(list: readonly MicDevice[], defaultName = ''): void {
    const seen = new Set<string>();
    const clean: MicDevice[] = [];
    list.forEach((d, i) => {
      const id = typeof d?.id === 'string' ? d.id.trim() : '';
      if (!id || id === 'default' || id === 'communications' || seen.has(id)) return;
      seen.add(id);
      const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim() : t(`Микрофон ${i + 1}`, `Microphone ${i + 1}`);
      clean.push({ id, label });
    });
    this.devices = clean;
    this.defaultName = typeof defaultName === 'string' ? defaultName.trim() : '';
    const s = this.h.settings();
    const saved = this.micDeviceId();
    if (saved && clean.length > 0 && !clean.some((d) => d.id === saved)) {
      s.MicrophoneId = '';
      this.h.save(s);
      this.h.changed?.();
    }
  }

  setMicrophone(deviceId: string): void {
    const id = deviceId.trim();
    if (id && !this.devices.some((d) => d.id === id)) return;
    const s = this.h.settings();
    const want = id ? WEB_MIC_PREFIX + id : '';
    if (s.MicrophoneId === want) return;
    s.MicrophoneId = want;
    this.h.save(s);
    this.h.changed?.();
  }

  setMode(mode: AppMode): void {
    const s = this.h.settings();
    if ((mode !== 'Dictation' && mode !== 'Sales') || s.Mode === mode) return;
    s.Mode = mode;
    this.h.save(s);
    this.h.changed?.();
  }

  setHotkey(vk: number): void {
    const s = this.h.settings();
    if (!HOTKEY_CHOICES.some((c) => c.vk === vk) || s.HotkeyVk === vk) return;
    s.HotkeyVk = vk;
    this.h.save(s);
    this.h.changed?.();
  }

  setInsertMode(mode: InsertMode): void {
    const s = this.h.settings();
    if ((mode !== 'Type' && mode !== 'Paste') || s.InsertMode === mode) return;
    s.InsertMode = mode;
    this.h.save(s);
    this.h.changed?.();
  }

  setShowOverlay(on: boolean): void {
    const s = this.h.settings();
    if (s.ShowOverlay === on) return;
    s.ShowOverlay = on;
    this.h.save(s);
    this.h.changed?.();
  }

  setWakeWord(on: boolean): void {
    const s = this.h.settings();
    if (s.WakeWord === on) return;
    s.WakeWord = on;
    this.h.save(s);
    this.h.changed?.();
  }

  private wakeNote(client: boolean, onDisk: boolean): string {
    if (client) return t('Слово «Чаво» слушается только своей моделью, а сейчас распознаёт хост из «Сети»: слово не работает.', '«Чаво» is heard only by a local model, and the host under Network does the recognition now: the word is off.');
    if (!onDisk) return t('Слово «Чаво» заработает, когда модель распознавания будет скачана.', '«Чаво» starts working once the speech model is downloaded.');
    return t('Слушаю «Чаво». Индикатор микрофона в системе будет гореть всё время.', 'Listening for «Чаво». The system microphone indicator stays on.');
  }

  setSoundCues(on: boolean): void {
    const s = this.h.settings();
    if (s.SoundCues === on) return;
    s.SoundCues = on;
    this.h.save(s);
    this.h.changed?.();
  }

  dismissStartCard(): void {
    const s = this.h.settings();
    if (s.StartHintDismissed) return;
    s.StartHintDismissed = true;
    this.h.save(s);
    this.h.changed?.();
  }
}
