import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '@chawo/core/strings';
import * as Settings from '../src/settings';
import { HistoryController, SHOWN_ROWS, whenText, type HistoryHooks } from '../src/history/historyPage';
import { HistoryStore } from '../src/history/historyStore';
import { BrainException } from '../src/brain/speechCleanup';

const DAY = 86400000;
let dir: string;
let now: number;
beforeAll(() => applyLanguage('Russian'));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-histpage-'));
  now = new Date(2026, 9, 13, 14, 5).getTime();
});
afterEach(() => {
  applyLanguage('Russian');
  rmSync(dir, { recursive: true, force: true });
});

function make(over: Partial<HistoryHooks> = {}, edit?: (s: Settings.SettingsData) => void) {
  const s = Settings.defaults();
  edit?.(s);
  const store = new HistoryStore(join(dir, 'chawo.db'), () => now);
  const copied: string[] = [];
  let saves = 0;
  let pushes = 0;
  const asked: string[] = [];
  const ctl = new HistoryController({
    store,
    settings: () => s,
    save: () => void saves++,
    copy: (t) => void copied.push(t),
    push: () => void pushes++,
    now: () => now,
    confirm: async (m) => { asked.push(m); return true; },
    brainUsable: () => false,
    ...over,
  });
  const rec = (final: string, raw = final, extra: Partial<{ command: string | null; brain: boolean; brainFailed: boolean }> = {}) =>
    ctl.record({ raw, final, command: null, brain: false, brainFailed: false, seconds: 3.04, ...extra });
  return { s, store, ctl, copied, asked, rec, saves: () => saves, pushes: () => pushes };
}

describe('whenText', () => {
  it('today, yesterday, this year, another year (local time)', () => {
    expect(whenText(new Date(2026, 9, 13, 9, 3).getTime(), now)).toBe('сегодня 09:03');
    expect(whenText(new Date(2026, 9, 12, 23, 59).getTime(), now)).toBe('вчера 23:59');
    expect(whenText(new Date(2026, 9, 1, 8, 0).getTime(), now)).toBe('01.10 08:00');
    expect(whenText(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe('31.12.2025 23:59');
    applyLanguage('English');
    expect(whenText(new Date(2026, 9, 13, 9, 3).getTime(), now)).toBe('today 09:03');
  });
});

describe('HistoryController', () => {
  it('records takes and lists them newest first with the raw text only when it differs', () => {
    const { ctl, rec, pushes } = make();
    rec('привет мир');
    now += 60000;
    rec('Привет, мир!', 'привет мир', { brain: true });
    now += 60000;
    rec('Hello world', 'привет мир. Chawo, переведи', { brain: true, brainFailed: false, command: 'переведи' });
    expect(pushes()).toBe(3);
    const st = ctl.state();
    expect(st.rows.map((r) => r.final)).toEqual(['Hello world', 'Привет, мир!', 'привет мир']);
    expect(st.rows[0]).toMatchObject({ when: 'сегодня 14:07', seconds: '3,0 с', command: 'переведи', tag: 'Мозг', raw: 'привет мир. Chawo, переведи' });
    expect(st.rows[2]).toMatchObject({ raw: null, tag: '', command: null });
    expect(st.countLine).toBe('');
    expect(st.keep).toBe('Week');
    expect(st.keepChoices.map((c) => c.label)).toEqual(['Не хранить', 'Сутки', 'Неделю', 'Месяц', 'Пока не удалю сам']);
    expect(st.canRerun).toBe(false);
    expect(st.rerunTip).toContain('«Мозг»');
  });

  it('a failed Brain is tagged', () => {
    const { ctl, rec } = make();
    rec('как есть', 'как есть', { brain: true, brainFailed: true });
    expect(ctl.state().rows[0]).toMatchObject({ tag: 'Мозг не справился', failed: true });
  });

  it('search narrows the list and says how many were found', () => {
    const { ctl, rec } = make();
    rec('купить молоко');
    rec('позвонить Петрову');
    rec('Ещё молоко');
    const st = ctl.setQuery('МОЛОКО');
    expect(st.rows).toHaveLength(2);
    expect(st.countLine).toBe('Найдено 2 из 3.');
    expect(ctl.setQuery('хлеб').empty).toBe('Ничего не нашлось.');
    expect(ctl.setQuery('').rows).toHaveLength(3);
  });

  it(`draws at most ${SHOWN_ROWS} rows and says so`, () => {
    const { ctl, rec } = make();
    for (let i = 0; i < SHOWN_ROWS + 3; i++) rec(`фраза ${i}`);
    const st = ctl.state();
    expect(st.rows).toHaveLength(SHOWN_ROWS);
    expect(st.countLine).toBe(`Показаны последние ${SHOWN_ROWS} из ${SHOWN_ROWS + 3}. Поиск ищет по всем.`);
  });

  it('Off: nothing is recorded; switching to Off wipes the file and says how many went', () => {
    const { ctl, rec, store, s, saves } = make();
    rec('раз');
    rec('два');
    const st = ctl.setKeep('Off');
    expect(saves()).toBe(1);
    expect(s.HistoryKeep).toBe('Off');
    expect(st.status).toBe('История выключена, удалено записей: 2.');
    expect(st.rows).toEqual([]);
    expect(st.empty).toBe('Истории нет: хранение выключено.');
    expect(store.count()).toBe(0);
    rec('три');
    expect(ctl.state().rows).toEqual([]);
    expect(store.count()).toBe(0);
    ctl.setKeep('Off');
    expect(saves()).toBe(1);
    ctl.setKeep('Bogus' as never);
    expect(s.HistoryKeep).toBe('Off');
  });

  it('a shorter period drops old entries at once; looking at the page prunes too', () => {
    const { ctl, rec } = make({}, (x) => { x.HistoryKeep = 'Month'; });
    rec('две недели назад');
    now += 14 * DAY;
    rec('сегодня');
    expect(ctl.state().rows).toHaveLength(2);
    expect(ctl.setKeep('Week').status).toBe('Удалено старых записей: 1.');
    now += 8 * DAY;
    expect(ctl.state().rows).toHaveLength(0);
  });

  it('copy puts the final or the raw text on the clipboard', async () => {
    const { ctl, rec, copied } = make();
    rec('Привет, мир!', 'привет мир', { brain: true });
    const id = ctl.state().rows[0].id;
    expect((await ctl.copy(id, 'final')).status).toBe('Скопировано в буфер обмена.');
    await ctl.copy(id, 'raw');
    expect(copied).toEqual(['Привет, мир!', 'привет мир']);
  });

  it('a clipboard error is a status line, not a crash', async () => {
    const { ctl, rec } = make({ copy: () => { throw new Error('busy'); } });
    rec('x');
    expect((await ctl.copy(ctl.state().rows[0].id, 'final')).status).toBe('В буфер обмена скопировать не получилось.');
  });

  it('an async clipboard (Electron 44) that rejects is a status line too', async () => {
    const { ctl, rec } = make({ copy: async () => { throw new Error('busy'); } });
    rec('x');
    expect((await ctl.copy(ctl.state().rows[0].id, 'final')).status).toBe('В буфер обмена скопировать не получилось.');
  });

  it('remove and clear all (after a yes)', async () => {
    const { ctl, rec, asked, store } = make();
    rec('раз');
    rec('два');
    expect(ctl.remove(ctl.state().rows[0].id).rows.map((r) => r.final)).toEqual(['раз']);
    const st = await ctl.clearAll();
    expect(asked).toEqual(['Удалить всю историю (1)? Это не отменить.']);
    expect(st.status).toBe('История очищена.');
    expect(store.count()).toBe(0);
    await ctl.clearAll();
    expect(asked).toHaveLength(1); // nothing to ask about
  });

  it('clear all answered «no» keeps everything', async () => {
    const { ctl, rec } = make({ confirm: async () => false });
    rec('раз');
    expect((await ctl.clearAll()).rows).toHaveLength(1);
  });

  it('«Мозг заново» re-runs the Brain on the recognized text, with the command if there was one', async () => {
    const seen: { body: string; command: string | null }[] = [];
    const { ctl, rec, copied } = make({
      brainUsable: () => true,
      transform: async (_s, body, command, status) => { seen.push({ body, command }); status('Перевожу…'); return command ? 'Hello world' : 'Привет, мир.'; },
    });
    rec('привет мир');
    rec('привет мир. Chawo, переведи на английский', 'привет мир. Chawo, переведи на английский');
    const [cmdRow, plainRow] = ctl.state().rows;
    expect(ctl.state().canRerun).toBe(true);
    let st = await ctl.rerun(cmdRow.id);
    expect(seen[0]).toEqual({ body: 'привет мир.', command: 'переведи на английский' });
    expect(st.status).toBe('Готово. Новый текст в буфере обмена.');
    expect(st.rows[0]).toMatchObject({ final: 'Hello world', tag: 'Мозг', raw: 'привет мир. Chawo, переведи на английский' });
    st = await ctl.rerun(plainRow.id);
    expect(seen[1]).toEqual({ body: 'привет мир', command: null });
    expect(st.rows[1]).toMatchObject({ final: 'Привет, мир.', raw: 'привет мир' });
    expect(copied).toEqual(['Hello world', 'Привет, мир.']);
  });

  it('a Brain failure or empty answer leaves the entry as it was', async () => {
    let mode: 'throw' | 'empty' | 'server' = 'throw';
    const { ctl, rec, copied } = make({
      brainUsable: () => true,
      transform: async () => {
        if (mode === 'throw') throw new BrainException('ключ не подошёл');
        if (mode === 'server') throw new TypeError('fetch failed');
        return '  ';
      },
    }, (x) => { x.Brain = 'Server'; });
    rec('как есть');
    const id = ctl.state().rows[0].id;
    expect((await ctl.rerun(id)).status).toBe('Мозг не справился: ключ не подошёл.');
    mode = 'empty';
    expect((await ctl.rerun(id)).status).toBe('Мозг не справился: нейросеть вернула пустой ответ.');
    mode = 'server';
    expect((await ctl.rerun(id)).status).toBe('Мозг не справился: сервер не ответил.');
    expect(ctl.state().rows[0].final).toBe('как есть');
    expect(copied).toEqual([]);
  });

  it('one re-run at a time; deleting the entry mid-run aborts it and stores nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let signal!: AbortSignal;
    const { ctl, rec, copied, store } = make({
      brainUsable: () => true,
      transform: async (_s, body, _c, _st, sig) => { signal = sig; await gate; return body + '!'; },
    });
    rec('раз');
    const id = ctl.state().rows[0].id;
    const run = ctl.rerun(id);
    const during = ctl.state();
    expect(during.rerunningId).toBe(id);
    expect(during.canRerun).toBe(false);
    expect(during.status).toBe('Мозг думает…');
    expect((await ctl.rerun(id)).rerunningId).toBe(id); // a second press is ignored
    ctl.remove(id);
    expect(signal.aborted).toBe(true);
    release();
    const st = await run;
    expect(st.rerunningId).toBeNull();
    expect(st.status).toBe('');
    expect(store.count()).toBe(0);
    expect(copied).toEqual([]);
  });
});

describe('«История» → «Исправить»', () => {
  it('saves the user text and passes the fix to the dictionary learner', () => {
    const seen: [string, string][] = [];
    const { ctl, store, rec } = make({
      learn: (b, a) => {
        seen.push([b, a]);
        return seen.length === 1 ? { added: [], suggested: [{ from: 'таптейн', to: 'Taptain' }] } : { added: [{ from: 'таптейн', to: 'Taptain' }], suggested: [] };
      },
    });
    rec('звонок таптейн');
    const id = store.list()[0].id;
    let st = ctl.edit(id, '  звонок Taptain\r\n');
    expect(store.get(id)!.final).toBe('звонок Taptain');
    expect(seen).toEqual([['звонок таптейн', 'звонок Taptain']]);
    expect(st.status).toBe('Исправлено. На «Словаре» предложено: таптейн → Taptain.');
    expect(st.labels.edit).toBe('Исправить');
    ctl.edit(id, 'звонок Taptain');
    expect(seen.length).toBe(1); // unchanged text → nothing
    ctl.edit(id, '');
    expect(store.get(id)!.final).toBe('звонок Taptain');
    st = ctl.edit(id, 'звонок Taptain!');
    expect(st.status).toBe('Исправлено. В словарь добавлено: таптейн → Taptain.');
    expect(ctl.edit('nope', 'x').status).toBe(st.status);
  });
});
