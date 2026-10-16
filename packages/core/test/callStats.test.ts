import { describe, expect, it } from 'vitest';
import { computeCallStats, DEFAULT_TRACKERS_TEXT, formatCallStats, formatTrackers, parseTrackers, wordsOf } from '../src/callStats';
import type { TranscriptSegment } from '../src/transcriptFormat';

const t = (_ru: string, en: string) => en;
const ru = (r: string) => r;

const CALL: TranscriptSegment[] = [
  { start: 0, end: 10, text: 'Здравствуйте, это Иван из компании.', speaker: 0 },
  { start: 10, end: 14, text: 'Добрый день. Сколько это стоит?', speaker: 1 },
  { start: 14, end: 44, text: 'Цена зависит от объёма, но у нас есть скидка.', speaker: 0 },
  { start: 46, end: 90, text: 'Сейчас расскажу про доставку и сроки, а скидку можно обсудить.', speaker: 0 },
  { start: 90, end: 100, text: 'Дорого. У конкурентов дешевле. Давайте созвонимся в понедельник?', speaker: 1 },
];

describe('callStats', () => {
  it('words: lower case, ё = е, punctuation dropped', () => {
    expect(wordsOf('Ёлка, «привет» — по-русски!')).toEqual(['елка', 'привет', 'по-русски']);
  });

  it('parses trackers; empty text = built-in; round trip', () => {
    expect(parseTrackers('')).toEqual(parseTrackers(DEFAULT_TRACKERS_TEXT));
    const list = parseTrackers('# комментарий\nЦена: цен*, дорого\n\nскидка\nПусто: ,  ,');
    expect(list).toEqual([
      { name: 'Цена', terms: ['цен*', 'дорого'] },
      { name: 'скидка', terms: ['скидка'] },
    ]);
    expect(parseTrackers(formatTrackers(list))).toEqual(list);
  });

  it('talk ratio, wpm, questions, monologues, turns with diarization', () => {
    const st = computeCallStats(CALL, parseTrackers('Цена: цен*, дорог*, стоит\nСкидка: скидк*\nШаг: созвон*\nКонкуренты: конкурент*\nНет: бюджет*'));
    expect(st.diarized).toBe(true);
    expect(st.speakers.map((s) => s.speaker)).toEqual([0, 1]);
    const [a, b] = st.speakers;
    // 10 + 30 + 30 (capped) = 70 s vs 4 + 10 = 14 s.
    expect(a.talkSeconds).toBe(70);
    expect(b.talkSeconds).toBe(14);
    expect(Math.round(a.share * 100)).toBe(83);
    expect(b.questions).toBe(2);
    expect(a.questions).toBe(0);
    expect(st.turns).toBe(3);
    // Speaker 1: phrases at 14–44 and 46–76 (gap 2 s ≤ 5) → one monologue 14..76 = 62 s.
    expect(st.longestMonologue).toMatchObject({ speaker: 0, start: 14, seconds: 62 });
    expect(st.longMonologues).toBe(1);
    expect(a.longestMonologueSeconds).toBe(62);
    const byName = Object.fromEntries(st.trackers.map((r) => [r.name, r]));
    expect(byName['Цена'].count).toBe(3); // стоит, цена, дорого
    expect(byName['Скидка'].count).toBe(2);
    expect(byName['Скидка'].hits.map((h) => h.start)).toEqual([14, 46]);
    expect(byName['Шаг'].hits[0]).toMatchObject({ speaker: 1, term: 'созвон*' });
    expect(byName['Конкуренты'].count).toBe(1);
    expect(byName['Нет'].count).toBe(0);
    expect(st.durationSeconds).toBe(100);
    expect(st.turnsPerMinute).toBe(1.8);
  });

  it('phrase terms match words in a row; exact terms do not match other forms', () => {
    const segs: TranscriptSegment[] = [
      { start: 0, end: 5, text: 'Какой следующий шаг? Следующий раз — шаг вперёд.' },
      { start: 5, end: 9, text: 'Скидку дадим, скидки тоже.' },
    ];
    const st = computeCallStats(segs, parseTrackers('Шаг: следующий шаг\nТочно: скидка\nНачало: скидк*'));
    expect(st.trackers.map((r) => r.count)).toEqual([1, 0, 2]);
    // Several terms in one phrase: counted each time, listed once.
    const both = computeCallStats([{ start: 0, end: 3, text: 'Дорого, нужна скидка и цена ниже.' }], parseTrackers('Цена: дорог*, скидк*, цен*'));
    expect(both.trackers[0]).toMatchObject({ count: 3 });
    expect(both.trackers[0].hits).toHaveLength(1);
    expect(both.trackers[0].hits[0].term).toBe('дорог*');
  });

  it('without speaker labels: one «speech» row at 100 %, no turns', () => {
    const segs = CALL.map(({ speaker: _s, ...rest }) => rest);
    const st = computeCallStats(segs);
    expect(st.diarized).toBe(false);
    expect(st.speakers).toHaveLength(1);
    expect(st.speakers[0]).toMatchObject({ speaker: -1, share: 1 });
    expect(st.turns).toBe(0);
    expect(st.trackers.length).toBeGreaterThan(0);
    const text = formatCallStats(st, t);
    expect(text).toContain('No speaker labels');
    expect(text).toContain('Speech: 100%');
  });

  it('empty and blank input', () => {
    const st = computeCallStats([{ start: 0, end: 1, text: '  ' }]);
    expect(st.phrases).toBe(0);
    expect(st.speakers).toEqual([]);
    expect(st.longestMonologue).toBeNull();
  });

  it('text report in Russian with hits', () => {
    const st = computeCallStats(CALL, parseTrackers('Скидка: скидк*'));
    const text = formatCallStats(st, ru, { hits: true });
    expect(text).toContain('Доля речи:');
    expect(text).toContain('Спикер 1: 83%');
    expect(text).toContain('Скидка: 2');
    expect(text).toContain('[0:14] Спикер 1: Цена зависит');
    expect(text).toContain('Самый длинный монолог: Спикер 1, 1:02');
  });
});
