import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '../src/core/strings';
import * as Settings from '../src/main/settings';
import {
  DictationController,
  WEB_MIC_PREFIX,
  flatText,
  hotkeyTitle,
  micErrorText,
  noModelText,
  modeHint,
  phaseText,
  type DictationHooks,
  type GlobalKeyState,
  type TakeView,
  type TextPart,
} from '../src/main/dictation/dictationPage';

beforeAll(() => applyLanguage('Russian'));
afterAll(() => applyLanguage('Russian'));

function make(over: Partial<DictationHooks> = {}, edit?: (s: Settings.SettingsData) => void) {
  const s = Settings.defaults();
  edit?.(s);
  let saves = 0;
  let changes = 0;
  let onDisk = true;
  const take: TakeView = { phase: 'Idle', status: '', lastText: '', loading: false };
  const ctl = new DictationController({
    settings: () => s,
    save: () => void saves++,
    changed: () => void changes++,
    take: () => take,
    find: (k) => (onDisk ? `/m/${k}` : null),
    platform: 'win32',
    ...over,
  });
  return { s, ctl, take, saves: () => saves, changes: () => changes, setOnDisk: (v: boolean) => { onDisk = v; } };
}

const flat = (parts: TextPart[]) => parts.map((p) => (typeof p === 'string' ? p : `[${p.link}→${p.page}]`)).join('');

describe('DictationController', () => {
  it('default state: dictation mode, Right Ctrl, paste, overlay on, default mic', () => {
    const { ctl } = make();
    const st = ctl.state();
    expect(st.ru).toBe(true);
    expect(st.mode).toBe('Dictation');
    expect(st.modeChoices.map((c) => c.label)).toEqual(['Диктовка', 'Продажи']);
    expect(st.modeHint).toBe('Обычная диктовка. Карточка продаж не показывается.');
    expect(st.hotkey).toBe(0xa3);
    expect(st.hotkeyTitle).toBe('Правый Ctrl');
    expect(st.hotkeyChoices.map((c) => c.value)).toEqual([0xa3, 0x10000, 0xa5, 0xa1, 0x14, 0x91, 0x2d]);
    expect(st.insertMode).toBe('Paste');
    expect(st.insertChoices.map((c) => c.label)).toEqual(['Печатать как с клавиатуры', 'Через буфер обмена (Ctrl+V)']);
    expect(st.showOverlay).toBe(true);
    expect(st.overlayLabel).toBe('Показывать плашку: волна и черновик текста');
    expect(st.micId).toBe('');
    expect(st.micChoices).toEqual([{ value: '', label: 'По умолчанию Windows' }]);
    expect(st.noModel).toBeNull();
    expect(st.client).toBe(false);
  });

  it('phase line and hold button follow the take (App.SetPhase texts)', () => {
    const { ctl, take } = make();
    expect(ctl.state().phaseLine).toBe('Сейчас: готово, жду клавишу. Стоп — кнопка или Escape.');
    expect(ctl.state().stopEnabled).toBe(false);
    expect(ctl.state().holdLabel).toBe('Удерживайте, чтобы говорить');
    take.phase = 'Listening';
    let st = ctl.state();
    expect(st.phaseLine).toBe('Сейчас: слушаю…  отпустите клавишу, черновик на плашке');
    expect(st.stopEnabled).toBe(true);
    expect(st.holdEnabled).toBe(true);
    take.phase = 'Recognizing';
    st = ctl.state();
    expect(st.phaseLine).toBe('Сейчас: распознаю…  вставится окончательный текст');
    expect(st.stopEnabled).toBe(true);
    expect(st.holdEnabled).toBe(false);
    expect(st.holdLabel).toBe('Распознаю…');
    take.phase = 'NoModel';
    expect(ctl.state().phaseLine).toBe('Сейчас: модель не загружена');
    expect(ctl.state().stopEnabled).toBe(false);
  });

  it('status shows loading until the session says something, and the last phrase', () => {
    const { ctl, take } = make();
    take.loading = true;
    expect(ctl.state().status).toBe('Загружаю модель…');
    take.status = 'Готово.';
    take.lastText = 'Привет, мир.';
    expect(ctl.state().status).toBe('Готово.');
    expect(ctl.state().lastText).toBe('Привет, мир.');
  });

  it('no model on disk points to «Распознавание» and never offers a download here', () => {
    const { ctl, setOnDisk } = make();
    setOnDisk(false);
    const st = ctl.state();
    expect(st.noModel).not.toBeNull();
    expect(flat(st.noModel!)).toBe('Модель не скачана. Откройте [«Распознавание»→speech] и нажмите «Скачать» в строке модели. Сама она не скачивается.');
    expect(JSON.stringify(st)).not.toMatch(/https?:/);
  });

  it('a press without a model does not repeat the on-page hint in the status line', () => {
    const { ctl, take, setOnDisk } = make();
    setOnDisk(false);
    take.status = flatText(noModelText());
    expect(ctl.state().status).toBe('');
    take.status = 'Другое';
    expect(ctl.state().status).toBe('Другое');
  });

  it('start card: three steps with page links, model badge, client variant, dismiss saves once', () => {
    const { ctl, s, saves, setOnDisk } = make();
    let card = ctl.state().startCard!;
    expect(card.title).toBe('С чего начать');
    expect(card.close).toBe('Больше не показывать');
    expect(flat(card.steps[0])).toBe('1) Скачайте речевую модель в разделе [«Распознавание»→speech] — уже на диске ✓');
    expect(flat(card.steps[1])).toBe('2) Зажмите кнопку «Удерживайте, чтобы говорить» и говорите. Отпустите — текст появится здесь и в буфере обмена.');
    expect(flat(card.steps[2])).toBe('3) Длинную запись перетащите в это окно — текст ляжет рядом, в [«Расшифровка файла»→file].');
    setOnDisk(false);
    expect(flat(ctl.state().startCard!.steps[0])).toBe('1) Скачайте речевую модель в разделе [«Распознавание»→speech].');
    s.NetworkRole = 'Client';
    card = ctl.state().startCard!;
    expect(flat(card.steps[0])).toBe('1) Этот ПК — клиент: укажите адрес хоста в разделе [«Сеть»→network].');
    expect(ctl.state().client).toBe(true);
    expect(ctl.state().noModel).toBeNull();
    ctl.dismissStartCard();
    ctl.dismissStartCard();
    expect(s.StartHintDismissed).toBe(true);
    expect(saves()).toBe(1);
    expect(ctl.state().startCard).toBeNull();
  });

  it('mode: Sales shows the WPF sales hint; invalid or unchanged values are not saved', () => {
    const { ctl, s, saves, changes } = make();
    ctl.setMode('Sales');
    expect(s.Mode).toBe('Sales');
    expect(ctl.state().modeHint).toBe(modeHint('Sales'));
    expect(ctl.state().modeHint).toMatch(/^Карточка из каталога/);
    ctl.setMode('Sales');
    ctl.setMode('Bogus' as never);
    expect(saves()).toBe(1);
    expect(changes()).toBe(1);
  });

  it('hotkey: only the seven WPF choices; Left Ctrl + Win is 0x10000', () => {
    const { ctl, s, saves } = make();
    ctl.setHotkey(0x10000);
    expect(s.HotkeyVk).toBe(0x10000);
    expect(ctl.state().hotkeyTitle).toBe('Левый Ctrl + Win');
    ctl.setHotkey(0x41);
    expect(s.HotkeyVk).toBe(0x10000);
    expect(saves()).toBe(1);
    for (const vk of [0xa5, 0xa1, 0x14, 0x91, 0x2d]) ctl.setHotkey(vk);
    expect(s.HotkeyVk).toBe(0x2d);
    expect(ctl.state().keyNote).toContain('Insert');
  });

  it('a saved hotkey outside the list shows the first choice and "клавиша XX" (Settings.HotkeyTitle)', () => {
    const { ctl } = make({}, (s) => { s.HotkeyVk = 0x7b; });
    expect(ctl.state().hotkey).toBe(0xa3);
    expect(hotkeyTitle(0x7b)).toBe('клавиша 7B');
    applyLanguage('English');
    expect(hotkeyTitle(0x7b)).toBe('key 7B');
    expect(hotkeyTitle(0xa5)).toBe('Right Alt');
    applyLanguage('Russian');
  });

  it('insert mode and overlay save only on change', () => {
    const { ctl, s, saves } = make();
    ctl.setInsertMode('Type');
    ctl.setInsertMode('Type');
    ctl.setInsertMode('Nope' as never);
    expect(s.InsertMode).toBe('Type');
    ctl.setShowOverlay(false);
    ctl.setShowOverlay(false);
    expect(s.ShowOverlay).toBe(false);
    expect(saves()).toBe(2);
  });

  it('microphones: default row with the system name, aliases dropped, empty labels numbered', () => {
    const { ctl } = make();
    ctl.setDevices([
      { id: 'default', label: 'Default - USB Mic' },
      { id: 'communications', label: 'Communications - USB Mic' },
      { id: 'aaa', label: 'USB Mic' },
      { id: 'bbb', label: '' },
      { id: 'aaa', label: 'dup' },
      { id: '', label: 'no id' },
    ], 'USB Mic');
    const st = ctl.state();
    expect(st.micChoices).toEqual([
      { value: '', label: 'По умолчанию Windows — USB Mic' },
      { value: 'aaa', label: 'USB Mic' },
      { value: 'bbb', label: 'Микрофон 4' },
    ]);
    expect(ctl.micName()).toBe('USB Mic');
  });

  it('picking a mic stores web:<id>; default stores empty; unknown ids are refused', () => {
    const { ctl, s, saves } = make();
    ctl.setDevices([{ id: 'aaa', label: 'A' }, { id: 'bbb', label: 'B' }], 'A');
    ctl.setMicrophone('bbb');
    expect(s.MicrophoneId).toBe(WEB_MIC_PREFIX + 'bbb');
    expect(ctl.state().micId).toBe('bbb');
    expect(ctl.micDeviceId()).toBe('bbb');
    expect(ctl.micName()).toBe('B');
    ctl.setMicrophone('zzz');
    expect(s.MicrophoneId).toBe('web:bbb');
    ctl.setMicrophone('');
    expect(s.MicrophoneId).toBe('');
    expect(saves()).toBe(2);
  });

  it('a saved web mic that is gone is cleared to default (WPF Mic list), but not on an empty list', () => {
    const { ctl, s, saves } = make({}, (x) => { x.MicrophoneId = 'web:gone'; });
    ctl.setDevices([], '');
    expect(s.MicrophoneId).toBe('web:gone');
    expect(saves()).toBe(0);
    ctl.setDevices([{ id: 'aaa', label: 'A' }], 'A');
    expect(s.MicrophoneId).toBe('');
    expect(saves()).toBe(1);
    expect(ctl.state().micId).toBe('');
  });

  it('a WPF endpoint id is left alone (settings are shared) and the take uses the default device', () => {
    const wpfId = '{0.0.1.00000000}.{5c6b1f0e-1111-2222-3333-444455556666}';
    const { ctl, s, saves } = make({}, (x) => { x.MicrophoneId = wpfId; });
    ctl.setDevices([{ id: 'aaa', label: 'A' }], 'A');
    expect(s.MicrophoneId).toBe(wpfId);
    expect(saves()).toBe(0);
    expect(ctl.micDeviceId()).toBe('');
    expect(ctl.state().micHint).toContain('выбранный в WPF-приложении');
  });

  it('non-Windows wording for the default device and mic hint', () => {
    const { ctl } = make({ platform: 'linux' });
    ctl.setDevices([{ id: 'x', label: 'Built-in' }], 'Built-in');
    expect(ctl.state().micChoices[0].label).toBe('По умолчанию в системе — Built-in');
    expect(ctl.state().micHint).toContain('система считает основным');
  });

  it('English UI', () => {
    applyLanguage('English');
    try {
      const { ctl, take } = make();
      take.phase = 'Listening';
      const st = ctl.state();
      expect(st.ru).toBe(false);
      expect(st.phaseLine).toBe('Now: listening…  release the key, draft is on the pill');
      expect(st.startCard!.title).toBe('Getting started');
      expect(st.hotkeyTitle).toBe('Right Ctrl');
      expect(phaseText('Idle')).toBe('Now: ready, waiting for the key. Stop is the button or Escape.');
    } finally {
      applyLanguage('Russian');
    }
  });
});

describe('micErrorText', () => {
  it('maps getUserMedia errors to the WPF wording on Windows', () => {
    expect(micErrorText('NotAllowedError', '', 'win32')).toMatch(/^Windows не даёт доступ к микрофону/);
    expect(micErrorText('NotFoundError', '', 'win32')).toMatch(/^Windows не видит ни одного устройства записи/);
    expect(micErrorText('NotReadableError', 'Device in use', 'win32')).toBe('Не удалось открыть микрофон: Device in use');
    expect(micErrorText('NotAllowedError', '', 'linux')).toMatch(/^Система не даёт доступ/);
    expect(micErrorText('', '', 'linux')).toBe('Не удалось открыть микрофон: ?');
  });

  it('global hold key: the WPF intro and step 2 when it works, one note line otherwise', () => {
    let gk: GlobalKeyState = { kind: 'on' };
    const { ctl } = make({ globalKey: () => gk });
    let st = ctl.state();
    expect(st.intro).toBe('Курсор в любой текст, зажмите клавишу и говорите. Отпустите, и текст появится сам.');
    expect(flat(st.startCard!.steps[1])).toBe('2) Поставьте курсор в любое поле, зажмите Правый Ctrl и говорите. Отпустите — текст вставится сам.');
    expect(st.keyNote).toBe('');
    gk = { kind: 'starting' };
    expect(ctl.state().keyNote).toBe('Включаю клавишу Правый Ctrl…');
    gk = { kind: 'failed', reason: 'SetWindowsHookEx failed: 5' };
    st = ctl.state();
    expect(st.keyNote).toBe('Клавиша Правый Ctrl не включилась (SetWindowsHookEx failed: 5). Пока работает кнопка ниже: текст копируется в буфер обмена.');
    expect(st.intro).toMatch(/^Зажмите кнопку ниже/);
    gk = { kind: 'none' };
    expect(ctl.state().keyNote).toMatch(/^Нет помощника ChawoNative\.exe/);
  });

  it('global hold key off the Windows path: Windows-only note, button intro', () => {
    const { ctl } = make({ platform: 'linux' });
    const st = ctl.state();
    expect(st.keyNote).toBe('Клавиша и вставка в другие программы пока есть только в Windows. Здесь работает кнопка ниже: текст копируется в буфер обмена.');
    expect(st.intro).toBe('Зажмите кнопку ниже и говорите. Отпустите, и появится текст: он показывается здесь и копируется в буфер обмена.');
  });
});


describe('version and update check labels', () => {
  it('exposes version and «Проверить обновления» on the page state', () => {
    const { ctl } = make({ version: () => '2.0.0' });
    const st = ctl.state();
    expect(st.version).toBe('2.0.0');
    expect(st.versionLabel).toBe('Версия');
    expect(st.checkUpdatesLabel).toBe('Проверить обновления');
    expect(st.checkUpdatesTip).toContain('zai-one/chawo-va');
  });
});
