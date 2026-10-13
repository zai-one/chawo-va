import { beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '../src/core/strings';
import * as Settings from '../src/main/settings';
import { SalesPageController, keptCatalog, sameCatalog } from '../src/main/sales';

beforeAll(() => applyLanguage('Russian'));

function make(edit?: (s: Settings.SettingsData) => void, over: Partial<ConstructorParameters<typeof SalesPageController>[0]> = {}) {
  const s = Settings.defaults();
  edit?.(s);
  let saves = 0;
  let changes = 0;
  const calls: string[][] = [];
  const ctl = new SalesPageController({
    settings: () => s,
    save: () => void saves++,
    changed: () => void changes++,
    countFiles: (f) => (f === '/mat' ? 3 : -1),
    presentCall: (a, b, c) => {
      calls.push([a, b, c]);
      return 'стенд-статус';
    },
    ...over,
  });
  return { s, ctl, calls, saves: () => saves, changes: () => changes };
}

describe('«Продажи» page', () => {
  it('rows from settings; an empty new row is not stored until it has text; edits trim and save', () => {
    const { s, ctl, saves, changes } = make((x) => { x.SalesCatalog = [{ Code: 'A1', Name: 'Альфа', Line: 'строка', SimilarCode: '' }]; });
    const st = ctl.state();
    expect(st.rows).toEqual([{ id: 1, Code: 'A1', Name: 'Альфа', Line: 'строка', SimilarCode: '' }]);
    expect(st.codeHeader).toBe('Код');
    const id = ctl.addRow();
    expect(saves()).toBe(0);
    expect(ctl.state().rows).toHaveLength(2);
    ctl.setRow(id, ' B2 ', 'Бета\n', '', '');
    expect(s.SalesCatalog).toEqual([
      { Code: 'A1', Name: 'Альфа', Line: 'строка', SimilarCode: '' },
      { Code: 'B2', Name: 'Бета', Line: '', SimilarCode: '' },
    ]);
    expect(saves()).toBe(1);
    expect(changes()).toBe(1);
    // Same content again: nothing written.
    ctl.setRow(id, 'B2', 'Бета', '', '');
    expect(saves()).toBe(1);
    ctl.removeRow(1);
    expect(s.SalesCatalog).toEqual([{ Code: 'B2', Name: 'Бета', Line: '', SimilarCode: '' }]);
    expect(saves()).toBe(2);
  });

  it('a catalog changed outside reloads the rows', () => {
    const { s, ctl } = make();
    ctl.addRow();
    s.SalesCatalog = [{ Code: 'Z', Name: '', Line: '', SimilarCode: '' }];
    expect(ctl.state().rows.map((r) => r.Code)).toEqual(['Z']);
  });

  it('materials folder: status lines, pick and clear save and notify', async () => {
    const { s, ctl, changes } = make(undefined, { pickFolder: async () => ' /mat ' });
    let st = ctl.state();
    expect(st.ragFolderText).toBe('Папка не выбрана');
    expect(st.canClear).toBe(false);
    expect(st.ragStatus).toBe('Без папки карточка показывает только каталог.');
    st = await ctl.pickFolder();
    expect(s.RagFolder).toBe('/mat');
    expect(st.ragStatus).toBe('Файлов .txt/.md: 3.');
    expect(st.canClear).toBe(true);
    expect(changes()).toBe(1);
    s.RagFolder = '/gone';
    expect(ctl.state().ragStatus).toBe('Папка не найдена на диске.');
    st = ctl.clearFolder();
    expect(s.RagFolder).toBe('');
    expect(changes()).toBe(2);
    ctl.clearFolder();
    expect(changes()).toBe(2);
  });

  it('a cancelled folder dialog changes nothing', async () => {
    const { s, ctl, changes } = make((x) => { x.RagFolder = '/mat'; }, { pickFolder: async () => null });
    await ctl.pickFolder();
    expect(s.RagFolder).toBe('/mat');
    expect(changes()).toBe(0);
  });

  it('the call stand-in keeps the typed fields and shows the status', () => {
    const { ctl, calls } = make();
    const st = ctl.showCall('101', '+7 900', 'Анна');
    expect(calls).toEqual([['101', '+7 900', 'Анна']]);
    expect(st.call).toEqual({ extension: '101', number: '+7 900', manager: 'Анна', status: 'стенд-статус' });
    const none = make(undefined, { presentCall: undefined });
    expect(none.ctl.showCall('1', '', 'x').call.status).toBe('Карточка из этого окна недоступна.');
  });

  it('mode note says when the card is hidden; no mode switch on this page', () => {
    const { s, ctl } = make();
    expect(ctl.state().salesMode).toBe(false);
    expect(ctl.state().modeNote).toMatch(/карточка не показывается/);
    s.Mode = 'Sales';
    expect(ctl.state().modeNote).toMatch(/включён/);
  });

  it('English labels', () => {
    applyLanguage('English');
    try {
      const st = make().ctl.state();
      expect(st.showCallLabel).toBe('Show card');
      expect(st.ru).toBe(false);
    } finally {
      applyLanguage('Russian');
    }
  });

  it('keptCatalog / sameCatalog', () => {
    expect(keptCatalog([{ Code: ' ', Name: '', Line: ' ', SimilarCode: '' }, { Code: ' a ', Name: '', Line: '', SimilarCode: '' }]))
      .toEqual([{ Code: 'a', Name: '', Line: '', SimilarCode: '' }]);
    expect(sameCatalog([], [])).toBe(true);
    expect(sameCatalog([{ Code: 'a', Name: '', Line: '', SimilarCode: '' }], [{ Code: 'b', Name: '', Line: '', SimilarCode: '' }])).toBe(false);
  });
});
