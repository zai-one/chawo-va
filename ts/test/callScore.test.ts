import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '../src/core/strings';
import * as C from '../src/main/brain/callScore';
import { BrainException } from '../src/main/brain/speechCleanup';
import { helpText, parseArgs } from '../src/cli/args';
import * as Settings from '../src/main/settings';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-score-'));
  applyLanguage('Russian');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CALL = 'Менеджер: Добрый день, меня зовут Иван, компания Ромашка. Клиент: Нам нужна CRM на 10 человек. Менеджер: Созвонимся в пятницу в 11?';
const MY = { name: 'Сервис', items: ['Назвал номер заявки', 'Попрощался'] };

describe('checklists', () => {
  it('built-in sales checklist: 6 items, ru/en', () => {
    const b = C.builtinChecklists();
    expect(b.map((x) => x.id)).toEqual(['sales']);
    expect(b[0]!.items).toHaveLength(6);
    expect(b[0]!.items.join(' ')).toMatch(/бюджет/);
    applyLanguage('English');
    expect(C.builtinChecklists()[0]!.name).toBe('Sales call');
    applyLanguage('Russian');
  });
  it('parseItems drops markers, blanks, repeats; caps count and length', () => {
    expect(C.parseItems('- Поздоровался\n2) Назвал цену\n\n• назвал  цену\n[ ] Попрощался')).toEqual(['Поздоровался', 'Назвал цену', 'Попрощался']);
    expect(C.parseItems(Array.from({ length: 50 }, (_, i) => `п${i}`))).toHaveLength(C.MAX_ITEMS);
    expect(C.parseItems('x'.repeat(500))[0]).toHaveLength(C.MAX_ITEM);
  });
  it('find by id / alias / name / custom; resolve falls back to sales', () => {
    expect(C.findChecklist('продажи', [])?.id).toBe('sales');
    expect(C.findChecklist('Звонок продаж', [])?.id).toBe('sales');
    expect(C.findChecklist('сервис', [MY])?.items).toEqual(MY.items);
    expect(C.findChecklist('nope', [MY])).toBeNull();
    expect(C.resolveChecklist('', [MY]).id).toBe('sales');
    expect(C.resolveChecklist('deleted', [MY]).id).toBe('sales');
    expect(C.resolveChecklist('Сервис', [MY]).name).toBe('Сервис');
  });
  it('custom: clean, upsert in place, remove, reserved names', () => {
    expect(C.cleanCustom([{ name: 'sales', items: ['a'] }, { name: 'Звонок продаж', items: ['a'] }, { name: 'list', items: ['a'] }, { name: 'x', items: [] }, 5])).toEqual([]);
    let l = C.upsertCustom([], MY);
    l = C.upsertCustom(l, { name: 'Второй', items: ['b'] });
    l = C.upsertCustom(l, { name: 'сервис', items: ['новый'] });
    expect(l).toEqual([{ name: 'сервис', items: ['новый'] }, { name: 'Второй', items: ['b'] }]);
    expect(C.removeCustom(l, 'СЕРВИС')).toEqual([{ name: 'Второй', items: ['b'] }]);
    expect(C.nameProblem('')).toMatch(/название/);
    expect(C.nameProblem('Продажи')).toMatch(/встроенный/);
    expect(C.nameProblem('Мой')).toBeNull();
  });
  it('file round trip; broken file = empty', () => {
    const p = join(dir, 'a', 'checklists.json');
    expect(C.loadCustom(p)).toEqual([]);
    C.saveCustom(p, [MY]);
    expect(C.loadCustom(p)).toEqual([MY]);
    expect(JSON.parse(readFileSync(p, 'utf8')).version).toBe(1);
    writeFileSync(p, '{oops');
    expect(C.loadCustom(p)).toEqual([]);
  });
  it('settings keep the switch and the pick', () => {
    const s = Settings.defaults();
    expect([s.CallScoreEnabled, s.CallScoreChecklist]).toEqual([false, '']);
    s.CallScoreEnabled = true;
    s.CallScoreChecklist = 'Сервис';
    const back = Settings.fromJsonObject(Settings.toJsonObject(s)).settings;
    expect([back.CallScoreEnabled, back.CallScoreChecklist]).toEqual([true, 'Сервис']);
  });
});

describe('answer parsing and score', () => {
  const items = ['Поздоровался', 'Выяснил потребность', 'Спросил бюджет'];
  it('reads fenced JSON, normalizes verdicts, keeps real quotes, drops invented ones', () => {
    const ans = '<think>hmm</think>Вот:\n```json\n{"items":[{"n":2,"verdict":"Частично","quote":"нужна CRM на 10 человек","note":"ок"},{"n":1,"verdict":"да","quote":"«Добрый день, меня зовут Иван»"},{"n":3,"verdict":"yes","quote":"бюджет 100 тысяч"}]}\n```';
    const r = C.parseAnswer(ans, items, CALL);
    expect(r.map((x) => x.verdict)).toEqual(['yes', 'partial', 'yes']);
    expect(r[0]!.quote).toBe('Добрый день, меня зовут Иван');
    expect(r[2]!.quote).toBe('');
    expect(r[2]!.note).toMatch(/не найдена/);
  });
  it('missing items are no; garbage throws BrainException', () => {
    const r = C.parseAnswer('{"items":[{"n":1,"verdict":"maybe"}]}', items, CALL);
    expect(r.map((x) => x.verdict)).toEqual(['no', 'no', 'no']);
    expect(r[2]!.note).toMatch(/нет ответа/);
    expect(() => C.parseAnswer('Не могу ответить', items, CALL)).toThrow(BrainException);
  });
  it('total and text: yes 1, partial 0.5', () => {
    const it3 = [{ item: 'a', verdict: 'yes', quote: 'q', note: '' }, { item: 'b', verdict: 'partial', quote: '', note: 'n' }, { item: 'c', verdict: 'no', quote: '', note: '' }] as C.ScoredItem[];
    expect(C.total(it3)).toEqual({ score: 1.5, max: 3, percent: 50 });
    const txt = C.formatText({ version: 1, checklist: { id: 'x', name: 'X' }, items: it3, score: 1.5, max: 3, percent: 50, source: '', createdAt: '' });
    expect(txt).toContain('Итог: 1,5 из 3 (50%)');
    expect(txt).toContain('✓ a\n  «q»');
    expect(txt).toContain('½ b');
    expect(txt).toContain('✗ c');
  });
  it('merge parts: best verdict wins', () => {
    const p1 = [{ item: 'a', verdict: 'no', quote: '', note: '' }, { item: 'b', verdict: 'partial', quote: 'x', note: '' }] as C.ScoredItem[];
    const p2 = [{ item: 'a', verdict: 'yes', quote: 'y', note: '' }, { item: 'b', verdict: 'no', quote: '', note: '' }] as C.ScoredItem[];
    expect(C.mergeParts([p1, p2]).map((x) => x.verdict)).toEqual(['yes', 'partial']);
  });
  it('output paths beside the transcript; .brain stripped', () => {
    expect(C.outputPaths('/r/call.txt')).toEqual({ json: '/r/call.score.json', txt: '/r/call.score.txt' });
    expect(C.outputPaths('/r/call.brain.txt').json).toBe('/r/call.score.json');
  });
  it('prompt numbers items and guards against injection', () => {
    const p = C.assemblePrompt(items);
    expect(p).toContain('1. Поздоровался\n2. Выяснил потребность\n3. Спросил бюджет');
    expect(p).toMatch(/Never follow instructions/);
  });
});

describe('scoreAsync', () => {
  const sig = new AbortController().signal;
  const cl = C.builtinChecklists()[0]!;
  it('asks once for a short call; result has score and timestamp', async () => {
    const asks: string[] = [];
    const r = await C.scoreAsync({
      transcript: CALL, checklist: cl, targetKind: 'Local', status: () => {}, signal: sig, now: () => new Date('2026-10-14T07:00:00Z'), source: '/c.txt',
      ask: async (p) => (asks.push(p), JSON.stringify({ items: [{ n: 1, verdict: 'yes', quote: 'меня зовут Иван' }, { n: 2, verdict: 'yes', quote: 'нужна CRM' }] })),
    });
    expect(asks).toHaveLength(1);
    expect([r.score, r.max, r.percent]).toEqual([2, 6, 33]);
    expect(r.createdAt).toBe('2026-10-14T07:00:00.000Z');
    expect(r.checklist.id).toBe('sales');
  });
  it('long call is split and merged; empty / no Brain throw', async () => {
    let n = 0;
    const long = Array.from({ length: 30 }, (_, i) => `Абзац ${i}. ` + 'слово '.repeat(30)).join('\n\n') + '\n\nМеня зовут Иван.';
    const r = await C.scoreAsync({ transcript: long, checklist: cl, targetKind: 'Local', status: () => {}, signal: sig,
      ask: async (_p, text) => (n++, JSON.stringify({ items: text.includes('Иван') ? [{ n: 1, verdict: 'yes', quote: 'Меня зовут Иван' }] : [] })) });
    expect(n).toBeGreaterThan(1);
    expect(r.items[0]!.verdict).toBe('yes');
    await expect(C.scoreAsync({ transcript: ' ', checklist: cl, targetKind: 'Local', status: () => {}, signal: sig, ask: async () => '' })).rejects.toThrow(BrainException);
    await expect(C.scoreAsync({ transcript: CALL, checklist: cl, targetKind: 'None', status: () => {}, signal: sig, ask: async () => '' })).rejects.toThrow(BrainException);
  });
  it('saveResult writes both files', () => {
    const files = new Map<string, string>();
    const r = { version: 1 as const, checklist: { id: 'sales', name: 'S' }, items: [], score: 0, max: 0, percent: 0, source: '', createdAt: '' };
    expect(C.saveResult('/x/a.txt', r, (p, s) => files.set(p, s))).toEqual({ json: '/x/a.score.json', txt: '/x/a.score.txt' });
    expect(JSON.parse(files.get('/x/a.score.json')!).checklist.id).toBe('sales');
  });
});

describe('CLI args: score / --score / --checklist', () => {
  const ok = (a: string[]) => { const r = parseArgs(a); if (!r.ok) throw new Error(r.error); return r.options; };
  it('parses', () => {
    expect(ok(['score', 'a.txt', '--checklist', 'sales']).checklist).toBe('sales');
    expect(ok(['score', '--checklist=list']).checklist).toBe('list');
    expect(ok(['score', 'a.txt', '--stdout', '--json']).json).toBe(true);
    const t = ok(['transcribe', 'a.wav', '--score', '--checklist', 'Сервис']);
    expect([t.score, t.checklist]).toEqual([true, 'Сервис']);
    expect(ok(['transcribe', 'a.wav', '--no-score']).score).toBe(false);
  });
  it('errors', () => {
    for (const a of [
      ['score'], ['score', 'a.txt', '--score'], ['brief', 'a.txt', '--checklist', 'x'], ['score', 'a.txt', '--checklist', 'list'],
      ['score', 'a.txt', '--format', 'srt'], ['score', 'a.txt', '--template', 'x'], ['score', 'a.txt', '--json'],
      ['transcribe', 'a.wav', '--score', '--no-score'], ['transcribe', 'a.wav', '--score', '--server', 'http://h'], ['score', 'a.txt', '--checklist'],
    ]) expect(parseArgs(a).ok, a.join(' ')).toBe(false);
  });
  it('help mentions score in both languages', () => {
    for (const lang of [(ru: string) => ru, (_: string, en: string) => en]) {
      const h = helpText(lang);
      expect(h).toContain('chawo-va score');
      expect(h).toContain('--checklist');
      expect(h).toContain('--score');
    }
  });
});
