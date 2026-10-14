import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dismiss, emptyLearned, findPair, forget, learn, learnEdit, loadLearned, MAX_PAIRS, saveLearned, suggestions, SUGGEST_AT, withRule, wordCorrections,
} from '../src/core/selfDictionary';
import { applyRules, formatRules } from '../src/core/wordReplace';

describe('wordCorrections', () => {
  it('finds replaced words and short phrases', () => {
    expect(wordCorrections('Отправь отчёт в таптейн до пятницы', 'Отправь отчёт в Taptain до пятницы')).toEqual([{ from: 'таптейн', to: 'Taptain' }]);
    expect(wordCorrections('открой джи пи ти и чаво', 'открой GPT и Chawo')).toEqual([{ from: 'джи пи ти', to: 'GPT' }, { from: 'чаво', to: 'Chawo' }]);
    expect(wordCorrections('это сипиу нагрузка', 'это CPU нагрузка')).toEqual([{ from: 'сипиу', to: 'CPU' }]);
  });
  it('keeps hyphens and inner punctuation of the written form', () => {
    expect(wordCorrections('поставь гпт четыре сегодня', 'поставь GPT-4 сегодня')).toEqual([{ from: 'гпт четыре', to: 'GPT-4' }]);
  });
  it('ignores capital first letters, insertions, deletions, numbers and rewrites', () => {
    expect(wordCorrections('привет как дела', 'Привет, как дела?')).toEqual([]);
    expect(wordCorrections('цпу загружен', 'CPU загружен')).toEqual([{ from: 'цпу', to: 'CPU' }]);
    expect(wordCorrections('cpu загружен', 'CPU загружен')).toEqual([{ from: 'cpu', to: 'CPU' }]);
    expect(wordCorrections('купи хлеб', 'купи хлеб и молоко')).toEqual([]);
    expect(wordCorrections('купи хлеб и молоко', 'купи хлеб')).toEqual([]);
    expect(wordCorrections('встреча в 10 утра', 'встреча в 11 утра')).toEqual([]);
    expect(wordCorrections('один два три четыре', 'совсем другой текст тут')).toEqual([]);
    expect(wordCorrections('', 'x')).toEqual([]);
  });
  it('spans longer than three words are not taken', () => {
    expect(wordCorrections('а б в г д е ж з и к л м', 'а б X Y Z W ж з и к л м')).toEqual([]);
  });
});

describe('learn / suggestions', () => {
  it('a fix seen twice becomes a suggestion, once is not enough', () => {
    let d = emptyLearned();
    let r = learn(d, [{ from: 'таптейн', to: 'Taptain' }], 1);
    expect(r.ready).toEqual([]);
    expect(suggestions(r.data, [])).toEqual([]);
    r = learn(r.data, [{ from: 'Таптейн', to: 'Taptain' }], 2);
    expect(r.ready.map((p) => p.count)).toEqual([SUGGEST_AT]);
    d = r.data;
    expect(suggestions(d, []).map(({ from, to, count }) => ({ from, to, count }))).toEqual([{ from: 'таптейн', to: 'Taptain', count: 2 }]);
    // Already in the rules → not offered.
    expect(suggestions(d, [{ from: 'ТАПТЕЙН', to: 'X' }])).toEqual([]);
    expect(suggestions(dismiss(d, 'таптейн', 'Taptain'), [])).toEqual([]);
    expect(findPair(d, 'ТАПТЕЙН')?.to).toBe('Taptain');
    expect(forget(d, 'таптейн').pairs).toEqual([]);
  });
  it('keeps at most MAX_PAIRS', () => {
    const fixes = Array.from({ length: MAX_PAIRS + 20 }, (_, i) => ({ from: `w${i}`, to: `W${i}x` }));
    expect(learn(emptyLearned(), fixes, 1).data.pairs.length).toBe(MAX_PAIRS);
  });
  it('withRule replaces a row for the same heard form', () => {
    expect(withRule([{ from: 'чаво', to: 'Чаво' }, { from: 'цпу', to: 'CPU' }], 'Чаво', 'Chawo')).toEqual([{ from: 'цпу', to: 'CPU' }, { from: 'Чаво', to: 'Chawo' }]);
  });
});

describe('learnEdit', () => {
  it('suggests by default; with autoAdd the rule goes in and the dictionary then fixes the text', () => {
    const before = 'созвон с таптейн завтра';
    const after = 'созвон с Taptain завтра';
    let r = learnEdit(emptyLearned(), [], before, after, 1);
    expect(r.suggested).toEqual([]);
    r = learnEdit(r.data, [], before, after, 2);
    expect(r.suggested).toEqual([{ from: 'таптейн', to: 'Taptain' }]);
    expect(r.rules).toBeNull();

    const auto = { autoAdd: true, pairs: [] };
    let a = learnEdit(auto, [], before, after, 1);
    a = learnEdit(a.data, [{ from: 'цпу', to: 'CPU' }], before, after, 2);
    expect(a.added).toEqual([{ from: 'таптейн', to: 'Taptain' }]);
    expect(a.rules).toEqual([{ from: 'цпу', to: 'CPU' }, { from: 'таптейн', to: 'Taptain' }]);
    expect(a.data.pairs).toEqual([]);
    expect(applyRules('позвони таптейн', formatRules(a.rules!))).toBe('позвони Taptain');
  });
});

describe('learned-words.json', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chawo-learned-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('round-trips, tolerates junk and a missing file', () => {
    const p = join(dir, 'sub', 'learned-words.json');
    expect(loadLearned(p)).toEqual(emptyLearned());
    saveLearned(p, { autoAdd: true, pairs: [{ from: 'а', to: 'Б', count: 2, last: 5 }] });
    expect(existsSync(p)).toBe(true);
    expect(loadLearned(p)).toEqual({ autoAdd: true, pairs: [{ from: 'а', to: 'Б', count: 2, last: 5 }] });
    expect(readFileSync(p, 'utf8')).not.toContain('http');
    writeFileSync(p, '{bad');
    expect(loadLearned(p)).toEqual(emptyLearned());
    writeFileSync(p, JSON.stringify({ pairs: [{ from: '', to: 'x' }, { from: 'a\nb', to: 'c' }, { from: 'ok', to: 'OK', count: 'x' }] }));
    expect(loadLearned(p)).toEqual({ autoAdd: false, pairs: [{ from: 'ok', to: 'OK', count: 1, last: 0 }] });
  });
});

describe('hostile-review guards', () => {
  it('no rules from common words, short words or inflections', async () => {
    const { riskyFix } = await import('../src/core/selfDictionary');
    expect(wordCorrections('пошли в офис', 'пошли во офис')).toEqual([]);
    expect(wordCorrections('это и есть план', 'это а есть план')).toEqual([]);
    expect(wordCorrections('скинь ок завтра', 'скинь OK завтра')).toEqual([]);
    expect(wordCorrections('встреча в пятницу утром', 'встреча в пятница утром')).toEqual([]);
    expect(wordCorrections('позвони мне завтра', 'позвони ему завтра')).toEqual([]);
    expect(wordCorrections('Отправил the отчёт', 'Отправил a отчёт')).toEqual([]);
    expect(riskyFix('гигачад', 'GigaChad')).toBe(false);
    expect(riskyFix('сбер', 'Сбер')).toBe(false);
    expect(riskyFix('клиента', 'клиенту')).toBe(true);
    // A real brand fix still goes through, even a lowercase Latin one.
    expect(wordCorrections('открой гитхаб сейчас', 'открой github сейчас')).toEqual([{ from: 'гитхаб', to: 'github' }]);
  });
  it('a corrupt learned-words.json is kept as .bad before being replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chawo-learned-bad-'));
    try {
      const p = join(dir, 'learned-words.json');
      writeFileSync(p, '{"pairs": [oops');
      expect(loadLearned(p)).toEqual(emptyLearned());
      expect(readFileSync(p + '.bad', 'utf8')).toBe('{"pairs": [oops');
      writeFileSync(p, 'null');
      expect(loadLearned(p)).toEqual(emptyLearned());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('dropPending keeps rows the CLI queued after the app read the file', async () => {
    const { dropPending, addPending } = await import('../src/core/selfDictionary');
    let d = addPending(emptyLearned(), 'гигачад', 'GigaChad');
    const seenByApp = d.pending!;
    d = addPending(d, 'кромка', 'Kromka'); // CLI, meanwhile
    expect(dropPending(d, seenByApp).pending).toEqual([{ from: 'кромка', to: 'Kromka' }]);
    expect(dropPending(d, d.pending!).pending).toBeUndefined();
  });
});
