import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '../src/core/strings';
import * as Settings from '../src/main/settings';
import {
  SalesCardModel, SalesSession, compose, formatScript, formatWho, hitFor, preferSpokenHistory, resolve, standIn,
  type CrmClient, type SalesCardState, type SalesCardView,
} from '../src/main/sales';
import type { SalesCatalogItem } from '../src/main/settings';

const item = (Code: string, Name: string, Line = '', SimilarCode = ''): SalesCatalogItem => ({ Code, Name, Line, SimilarCode });
const catalog = [item('TP-100', 'таптайн про', 'Флагман', 'TP-90'), item('CH5', 'чаво станция', 'Под заказ')];
const client = (over: Partial<CrmClient> = {}): CrmClient => ({
  phone: '+7900', name: '', company: '', openDeal: '', dealStage: '', stageScript: '', lastOrder: '', spokenProducts: [], ...over,
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-flow-'));
  writeFileSync(join(dir, 'st.txt'), 'Чаво станция слушает встречу и подсказывает менеджеру артикул.');
  applyLanguage('Russian');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SalesFlow', () => {
  it('a binding needs both an extension and a manager name', () => {
    expect(resolve(' 101 ', ' Анна ')).toEqual({ trunk: '', extension: '101', managerName: 'Анна', pcId: 'local' });
    expect(resolve('', 'Анна')).toBeNull();
    expect(resolve('101', '  ')).toBeNull();
    const st = standIn('101', ' +7 900 ', 'Анна', 42)!;
    expect(st.event).toEqual({ callId: 'local-42', trunk: '', extension: '101', callerNumber: '+7 900', direction: 'inbound' });
    expect(standIn('', '1', 'x')).toBeNull();
  });

  it('who and script lines without a CRM, and with one', () => {
    const { event, binding } = standIn('101', '', 'Анна')!;
    expect(formatWho(event, binding, null)).toBe('Анна · трубка 101 · номер скрыт\nклиент по номеру не найден');
    expect(formatScript(null)).toBe('скрипт стадии: нет данных');
    expect(formatWho({ ...event, callerNumber: '+7900' }, binding, client({ name: 'Олег', company: 'ООО Ромашка', lastOrder: 'TP-100' })))
      .toBe('Анна · трубка 101 · +7900\nОлег, ООО Ромашка, заказ: TP-100');
    expect(formatWho(event, binding, client())).toMatch(/клиент без имени$/);
    expect(formatScript(client({ dealStage: 'Счёт', stageScript: 'Уточнить реквизиты' }))).toBe('Счёт: Уточнить реквизиты');
    expect(formatScript(client({ stageScript: 'Привет' }))).toBe('Привет');
    expect(formatScript(client({ dealStage: 'Счёт' }))).toBe('Счёт — текст скрипта не задан');
  });

  it('compose: the call card with the hit and a snippet on «похоже»', () => {
    const { event, binding } = standIn('101', '+7900', 'Анна')!;
    const v = compose(event, binding, 'нужна чаво станция', catalog, dir);
    expect(v.hasCall).toBe(true);
    expect(v.whoLine).toBe('Анна · трубка 101 · +7900\nклиент по номеру не найден');
    expect(v.hit).toMatchObject({ kind: 'Similar', code: 'CH5' });
    expect(v.hit!.ragSnippet).toContain('подсказывает менеджеру');
    expect(compose(event, binding, '', catalog, dir).hit).toBeNull();
    // Exact code: no snippet lookup.
    expect(hitFor('TP-100', catalog, dir)!.ragSnippet).toBe('');
  });

  it('spoken history: replaces a weak name hit, never beats an exact or heard similar code', () => {
    const name = hitFor('таптайн', catalog, null);
    expect(name).toMatchObject({ kind: 'Similar', code: 'TP-100' });
    // History says «чаво станция» and the text is close to it.
    expect(preferSpokenHistory('чаво станцию', catalog, null, ['CH5'])).toMatchObject({ kind: 'Similar', code: 'CH5' });
    const exact = hitFor('TP-100 и чаво станция', catalog, null);
    expect(preferSpokenHistory('TP-100 и чаво станция', catalog, exact, ['CH5'])).toBe(exact);
    const heard = hitFor('стоял TP-90, а нужна чаво станция', catalog, null)!;
    expect(heard.code).toBe('TP-100');
    expect(preferSpokenHistory('стоял TP-90, а нужна чаво станция', catalog, heard, ['ch5'])).toBe(heard);
    expect(preferSpokenHistory('погода', catalog, null, [])).toBeNull();
  });
});

describe('SalesCardModel', () => {
  it('renders on change only, hides once', () => {
    const shown: SalesCardState[] = [];
    const m = new SalesCardModel((s) => shown.push(s));
    const view: SalesCardView = { hasCall: false, whoLine: 'x', scriptLine: 'y', hit: { kind: 'Exact', name: 'N', line: 'L', code: 'C', ragSnippet: '' } };
    m.showModel(view);
    m.showModel({ ...view });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ visible: true, hasCall: false, who: '', script: '', hasHit: true, kind: 'Exact', name: 'N', line: 'L', badge: 'похоже' });
    m.showModel({ ...view, hit: { ...view.hit!, kind: 'Similar', ragSnippet: 'R' } });
    expect(shown[1]).toMatchObject({ kind: 'Similar', rag: 'R', ragLabel: 'из материалов' });
    m.hideNow();
    m.hideNow();
    expect(shown).toHaveLength(3);
    expect(shown[2].visible).toBe(false);
    // After hiding, the same view shows again.
    m.showModel({ ...view, hit: { ...view.hit!, kind: 'Similar', ragSnippet: 'R' } });
    expect(shown).toHaveLength(4);
  });
});

describe('SalesSession (App.ShowSales / PresentCall)', () => {
  const make = (mode: 'Dictation' | 'Sales' = 'Sales') => {
    const s = Settings.defaults();
    s.Mode = mode;
    s.SalesCatalog = catalog.map((c) => ({ ...c }));
    s.RagFolder = dir;
    const views: (SalesCardView | null)[] = [];
    const sess = new SalesSession({ settings: () => s, card: { showModel: (v) => void views.push(v), hideNow: () => void views.push(null) }, now: () => 7 });
    return { s, sess, views };
  };

  it('drafts open the catalog card only in Sales mode and only on a hit', () => {
    const { s, sess, views } = make();
    sess.show('добрый день');
    expect(views).toEqual([]);
    sess.show('нужен TP-100');
    expect(views[0]).toMatchObject({ hasCall: false, hit: { kind: 'Exact', code: 'TP-100' } });
    s.Mode = 'Dictation';
    sess.show('нужен CH5');
    expect(views).toHaveLength(1);
  });

  it('the stand-in call: status lines, card with who/script, drafts repaint it, leaving Sales hides it', () => {
    const { s, sess, views } = make();
    expect(sess.presentCall('', '1', 'Анна')).toBe('Стенд: нет привязки трубки к менеджеру. Карточка не показывается.');
    expect(views).toEqual([null]);
    expect(sess.presentCall('101', '+7900', 'Анна')).toBe('Стенд: карточка на этом компьютере. CRM нет, сеть не используется.');
    expect(sess.hasOpenCall).toBe(true);
    expect(views[1]).toMatchObject({ hasCall: true, whoLine: 'Анна · трубка 101 · +7900\nклиент по номеру не найден', scriptLine: 'скрипт стадии: нет данных', hit: null });
    sess.show('хотим чаво станцию');
    expect(views[2]).toMatchObject({ hasCall: true, hit: { code: 'CH5' } });
    // No hit in a draft still repaints the call (the hit goes away).
    sess.show('спасибо');
    expect(views[3]).toMatchObject({ hasCall: true, hit: null });
    s.Mode = 'Dictation';
    sess.settingsChanged();
    expect(views[4]).toBeNull();
    expect(sess.hasOpenCall).toBe(false);
    expect(sess.presentCall('101', '', 'Анна')).toBe('Сначала включите режим «Продажи» на вкладке «Диктовка».');
  });

  it('the × ends the call and hides the card; a catalog edit repaints an open call', () => {
    const { s, sess, views } = make();
    sess.presentCall('101', '', 'Анна');
    sess.show('нужен TP-100');
    s.SalesCatalog[0].Line = 'Новая строка';
    sess.settingsChanged();
    expect(views.at(-1)).toMatchObject({ hit: { line: 'Новая строка' } });
    sess.dismiss();
    expect(views.at(-1)).toBeNull();
    expect(sess.hasOpenCall).toBe(false);
  });
});
