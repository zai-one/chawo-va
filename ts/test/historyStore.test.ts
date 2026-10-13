import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore, MAX_ENTRIES, fold, keepMs, matches, type NewEntry } from '../src/main/history/historyStore';
import * as Settings from '../src/main/settings';

const DAY = 86400000;
let dir: string;
let path: string;
let now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-hist-'));
  path = join(dir, 'sub', 'history.jsonl');
  now = new Date(2026, 9, 13, 12, 0).getTime();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const take = (final: string, over: Partial<NewEntry> = {}): NewEntry => ({
  raw: final, final, command: null, brain: false, brainFailed: false, seconds: 2.34, ...over,
});
const store = () => new HistoryStore(path, () => now);

describe('HistoryStore', () => {
  it('appends one JSON line per take and reads them back newest first', () => {
    const h = store();
    const a = h.add(take('первая'), 'Week')!;
    now += 1000;
    h.add(take('вторая', { raw: 'вторая. Chawo, короче', command: 'короче', brain: true }), 'Week');
    expect(a.seconds).toBe(2.3);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    const again = store().list();
    expect(again.map((e) => e.final)).toEqual(['вторая', 'первая']);
    expect(again[0]).toMatchObject({ raw: 'вторая. Chawo, короче', command: 'короче', brain: true, brainFailed: false });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('Off stores nothing and creates no file', () => {
    const h = store();
    expect(h.add(take('секрет'), 'Off')).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(h.list()).toEqual([]);
  });

  it('prune drops entries older than the period; Off wipes the file', () => {
    const h = store();
    h.add(take('давно', { ts: now - 8 * DAY }), 'Forever');
    h.add(take('вчера', { ts: now - DAY + 1000 }), 'Forever');
    h.add(take('сейчас'), 'Forever');
    expect(h.prune('Month')).toBe(0);
    expect(h.prune('Week')).toBe(1);
    expect(store().list().map((e) => e.final)).toEqual(['сейчас', 'вчера']);
    expect(h.prune('Day')).toBe(0);
    now += 2000;
    expect(h.prune('Day')).toBe(1);
    expect(h.prune('Off')).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('adding under a period prunes on the way', () => {
    const h = store();
    h.add(take('старое', { ts: now - 2 * DAY }), 'Forever');
    h.add(take('новое'), 'Day');
    expect(store().list().map((e) => e.final)).toEqual(['новое']);
  });

  it(`never keeps more than ${MAX_ENTRIES} entries`, () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      lines.push(JSON.stringify({ id: `i${i}`, ts: now - 1000 + i / 10, raw: `r${i}`, final: `f${i}`, command: null, brain: false, brainFailed: false, seconds: 1 }));
    }
    writeFileSync(path.replace('sub/', ''), lines.join('\n') + '\n');
    const h = new HistoryStore(path.replace('sub/', ''), () => now);
    expect(h.prune('Forever')).toBe(5);
    expect(h.count()).toBe(MAX_ENTRIES);
    expect(h.list('', 1)[0]!.final).toBe(`f${MAX_ENTRIES + 4}`);
  });

  it('search: every word, any case, ё = е, in the final text, the raw text or the command', () => {
    const h = store();
    h.add(take('Ещё один Отчёт для Петрова'), 'Week');
    h.add(take('Report for Ivanov', { raw: 'отчет для иванова. Chawo, переведи', command: 'переведи', brain: true }), 'Week');
    h.add(take('купить молоко'), 'Week');
    expect(h.list('отчет').map((e) => e.final)).toEqual(['Report for Ivanov', 'Ещё один Отчёт для Петрова']);
    expect(h.list('еще ОТЧЁТ').map((e) => e.final)).toEqual(['Ещё один Отчёт для Петрова']);
    expect(h.list('переведи')).toHaveLength(1);
    expect(h.list('молоко хлеб')).toHaveLength(0);
    expect(h.list('   ')).toHaveLength(3);
    expect(h.count('отчет')).toBe(2);
    expect(fold('ЁЖ')).toBe('еж');
    expect(matches(h.list()[0]!, '')).toBe(true);
  });

  it('skips a broken or half-written line instead of failing', () => {
    const h = store();
    h.add(take('целая'), 'Week');
    appendFileSync(path, '{"id":"x","ts":1,"raw":"обор');
    appendFileSync(path, '\nне json\n{"id":5}\n');
    expect(store().list().map((e) => e.final)).toEqual(['целая']);
  });

  it('setFinal, remove and clear rewrite the file', () => {
    const h = store();
    const a = h.add(take('один'), 'Week')!;
    const b = h.add(take('два'), 'Week')!;
    expect(h.setFinal(a.id, 'Один!', false)!.brain).toBe(true);
    expect(store().get(a.id)!.final).toBe('Один!');
    expect(h.remove(b.id)).toBe(true);
    expect(h.remove(b.id)).toBe(false);
    expect(store().list().map((e) => e.final)).toEqual(['Один!']);
    expect(h.setFinal('nope', 'x', false)).toBeNull();
    h.clear();
    expect(existsSync(path)).toBe(false);
    expect(store().count()).toBe(0);
  });

  it('keepMs and the HistoryKeep setting round-trip', () => {
    expect(keepMs('Off')).toBe(0);
    expect(keepMs('Week')).toBe(7 * DAY);
    expect(keepMs('Forever')).toBe(Infinity);
    expect(Settings.defaults().HistoryKeep).toBe('Week');
    const s = Settings.defaults();
    s.HistoryKeep = 'Month';
    expect(Settings.fromJsonObject(Settings.toJsonObject(s)).settings.HistoryKeep).toBe('Month');
    expect(Settings.fromJsonObject({ HistoryKeep: 'Year' }).settings.HistoryKeep).toBe('Week');
    expect(Settings.fromJsonObject({}).settings.HistoryKeep).toBe('Week');
  });
});
