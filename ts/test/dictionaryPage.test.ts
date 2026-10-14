import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '../src/core/strings';
import { DEFAULT_RULES, parseRules } from '../src/core/wordReplace';
import * as Settings from '../src/main/settings';
import { DictionaryController, formattedRules, type DictionaryHooks } from '../src/main/dictionary/dictionaryPage';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-dict-'));
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  applyLanguage('Russian');
});

function make(over: Partial<DictionaryHooks> = {}, rules = '') {
  const s = Settings.defaults();
  s.WordReplacementRules = rules;
  let saves = 0;
  let changes = 0;
  const ctl = new DictionaryController({ settings: () => s, save: () => void saves++, changed: () => void changes++, ...over });
  return { s, ctl, saves: () => saves, changes: () => changes };
}

describe('«Словарь» page', () => {
  it('blank settings shows the default rules; texts match WPF', () => {
    const { ctl, saves } = make();
    const st = ctl.state();
    expect(st.rows.map(({ from, to }) => ({ from, to }))).toEqual(parseRules(DEFAULT_RULES));
    expect(new Set(st.rows.map((r) => r.id)).size).toBe(st.rows.length);
    expect(st.intro).toBe('Готовая фраза после распознавания и до мозга. Черновик на плашке не меняется. Пустая строка не считается.');
    expect([st.heardHeader, st.writtenHeader, st.suggestLabel]).toEqual(['Как слышно', 'Как писать', 'Подсказать из материалов']);
    expect(st.hintKind).toBe('idle');
    expect(st.suggestHint).toContain('Берёт латинские бренды');
    expect(saves()).toBe(0);
  });

  it('deleting every row stores "#" and an empty list stays empty', () => {
    const { s, ctl, saves } = make();
    for (const r of ctl.state().rows) ctl.removeRow(r.id);
    expect(s.WordReplacementRules).toBe('#');
    expect(ctl.state().rows).toEqual([]);
    expect(Settings.dictionaryRows(s)).toEqual([]);
    expect(saves()).toBeGreaterThan(0);
  });

  it('add / edit / remove persist only when the formatted rules change', () => {
    const { s, ctl, saves, changes } = make({}, 'цпу -> CPU\n');
    const id = ctl.addRow();
    expect(saves()).toBe(0); // empty row does not count
    ctl.setRow(id, '  ', '');
    expect(saves()).toBe(0);
    ctl.setRow(id, 'чаво', '');
    expect(s.WordReplacementRules).toBe('цпу -> CPU\nчаво -> \n');
    ctl.setRow(id, 'чаво', 'Chawo');
    expect(s.WordReplacementRules).toBe('цпу -> CPU\nчаво -> Chawo\n');
    const n = saves();
    ctl.setRow(id, ' чаво ', 'Chawo '); // same after trim
    expect(saves()).toBe(n);
    expect(changes()).toBe(n);
    // ids stay stable across saves, so the renderer can keep editing the same row
    expect(ctl.state().rows.map((r) => r.id)).toContain(id);
    ctl.removeRow(id);
    expect(s.WordReplacementRules).toBe('цпу -> CPU\n');
    ctl.setRow(9999, 'x', 'y'); // unknown id ignored
    expect(s.WordReplacementRules).toBe('цпу -> CPU\n');
  });

  it('editing the default list writes it out in full', () => {
    const { s, ctl } = make();
    const first = ctl.state().rows[0];
    ctl.setRow(first.id, first.from, 'ЦП');
    expect(s.WordReplacementRules.startsWith('цпу -> ЦП\n')).toBe(true);
    expect(parseRules(s.WordReplacementRules)).toHaveLength(parseRules(DEFAULT_RULES).length);
  });

  it('rules changed elsewhere reload the rows', () => {
    const { s, ctl } = make({}, 'a -> b\n');
    s.WordReplacementRules = 'c -> d\n';
    expect(ctl.state().rows.map((r) => r.from)).toEqual(['c']);
  });

  it('formattedRules: empty list is "#"', () => {
    expect(formattedRules([{ from: ' ', to: '' }])).toBe('#');
    expect(formattedRules([{ from: ' a ', to: 'B' }])).toBe('a -> B\n');
  });

  it('suggest without a folder asks for one and writes nothing', () => {
    let called = 0;
    const { s, ctl, saves } = make({ suggest: () => (called++, []) });
    let st = ctl.suggest();
    expect(st.hintKind).toBe('noFolder');
    expect(st.suggestHint).toBe('Сначала выберите папку материалов на вкладке «Продажи».');
    s.RagFolder = join(dir, 'missing');
    st = ctl.suggest();
    expect(st.hintKind).toBe('noFolder');
    expect(called).toBe(0);
    expect(saves()).toBe(0);
  });

  it('suggest from a folder lists rows; «В словарь» adds one and removes it from the list', () => {
    writeFileSync(join(dir, 'brands.txt'), 'бренд таптайн Taptain\nкарта гипер HyperX\n');
    const { s, ctl } = make({}, 'цпу -> CPU\n');
    s.RagFolder = dir;
    ctl.state(); // folder seen
    let st = ctl.suggest();
    expect(st.hintKind).toBe('found');
    expect(st.suggestions.map((g) => [g.heard, g.written, g.source])).toContainEqual(['таптайн', 'Taptain', 'brands.txt']);
    expect(st.suggestHint).toBe(`Предложено ${st.suggestions.length}. Нажмите «В словарь», чтобы добавить строку. Само ничего не пишется.`);
    expect(s.WordReplacementRules).toBe('цпу -> CPU\n'); // nothing written by itself
    const before = st.suggestions.length;
    st = ctl.addSuggestion('таптайн', 'Taptain');
    expect(s.WordReplacementRules).toBe('цпу -> CPU\nтаптайн -> Taptain\n');
    expect(st.suggestions).toHaveLength(before - 1);
    expect(st.rows.at(-1)).toMatchObject({ from: 'таптайн', to: 'Taptain' });
    // a new folder clears the list
    s.RagFolder = join(dir, 'other');
    expect(ctl.state().suggestions).toEqual([]);
    expect(ctl.state().hintKind).toBe('idle');
  });

  it('empty result says nothing matched', () => {
    const { s, ctl } = make({ suggest: () => [] });
    s.RagFolder = dir;
    const st = ctl.suggest();
    expect(st.hintKind).toBe('none');
    expect(st.suggestHint).toContain('не нашлось');
  });

  it('English texts', () => {
    applyLanguage('English');
    const { ctl } = make();
    const st = ctl.state();
    expect(st.heardHeader).toBe('Heard');
    expect(st.suggestLabel).toBe('Suggest from materials');
    expect(ctl.suggest().suggestHint).toBe('Choose a materials folder on the Sales tab first.');
    applyLanguage('Russian');
  });
});

describe('«Словарь» → «Из исправлений»', () => {
  it('shows learned fixes, adds one as a row, hides another, toggles auto-add', async () => {
    const { saveLearned, loadLearned } = await import('../src/core/selfDictionary');
    const lp = join(dir, 'learned-words.json');
    saveLearned(lp, { autoAdd: false, pairs: [
      { from: 'зайон', to: 'Zaion', count: 3, last: 1 },
      { from: 'гигапис', to: 'GigaPisar', count: 2, last: 1 },
      { from: 'однажды', to: 'Once', count: 1, last: 1 },
      { from: 'цпу', to: 'ЦП', count: 4, last: 1 },
    ] });
    const { ctl, s } = make({ learnedPath: () => lp, snippetsPath: () => join(dir, 'snip-l.json') });
    let st = ctl.state();
    expect(st.learned.heading).toBe('Из исправлений');
    // «цпу» is already a default rule → not offered; count 1 → not yet.
    expect(st.learned.rows.map((r) => r.from)).toEqual(['зайон', 'гигапис']);
    st = ctl.acceptLearned('зайон', 'Zaion');
    expect(st.rows.some((r) => r.from === 'зайон' && r.to === 'Zaion')).toBe(true);
    expect(s.WordReplacementRules).toContain('зайон -> Zaion');
    expect(st.learned.rows.map((r) => r.from)).toEqual(['гигапис']);
    st = ctl.dismissLearned('гигапис', 'GigaPisar');
    expect(st.learned.rows).toEqual([]);
    expect(st.learned.empty).toBe('Пока нечего предложить.');
    st = ctl.setLearnAuto(true);
    expect(st.learned.autoAdd).toBe(true);
    expect(loadLearned(lp).autoAdd).toBe(true);
  });
});

describe('learnFromEdit (history → dictionary glue)', () => {
  it('auto-adds into settings rules on the second identical fix', async () => {
    const { learnFromEdit } = await import('../src/main/dictionary/learnedWords');
    const { saveLearned } = await import('../src/core/selfDictionary');
    const lp = join(dir, 'learned-auto.json');
    saveLearned(lp, { autoAdd: true, pairs: [] });
    const s = Settings.defaults();
    let saves = 0;
    expect(learnFromEdit(s, () => void saves++, 'привет чаво бот', 'привет Чаво-бот', lp, 1).added).toEqual([]);
    const r = learnFromEdit(s, () => void saves++, 'встреча чаво бот', 'встреча Чаво-бот', lp, 2);
    expect(r.added).toEqual([{ from: 'чаво бот', to: 'Чаво-бот' }]);
    expect(saves).toBe(1);
    expect(s.WordReplacementRules).toContain('чаво бот -> Чаво-бот');
    expect(s.WordReplacementRules).toContain('цпу -> CPU');
  });
});

describe('applyPendingRules (rows queued by `chawo-va dictionary accept`)', () => {
  it('moves pending rows into settings once and clears the queue; the page shows them', async () => {
    const { applyPendingRules } = await import('../src/main/dictionary/learnedWords');
    const { saveLearned, loadLearned } = await import('../src/core/selfDictionary');
    const lp = join(dir, 'learned-pending.json');
    saveLearned(lp, { autoAdd: false, pairs: [], pending: [{ from: 'кромка', to: 'Kromka' }] });
    const { ctl, s, saves } = make({ learnedPath: () => lp, snippetsPath: () => join(dir, 'snip-p.json') });
    const st = ctl.state();
    expect(st.rows.some((r) => r.from === 'кромка' && r.to === 'Kromka')).toBe(true);
    expect(s.WordReplacementRules).toContain('кромка -> Kromka');
    expect(s.WordReplacementRules).toContain('цпу -> CPU');
    expect(saves()).toBe(1);
    expect(loadLearned(lp).pending).toBeUndefined();
    expect(applyPendingRules(s, () => undefined, lp)).toBe(false);
    expect(applyPendingRules(s, () => undefined, join(dir, 'none.json'))).toBe(false);
  });
});
