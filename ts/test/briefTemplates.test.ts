import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '../src/core/strings';
import {
  OWN, allTemplates, builtinTemplates, cleanCustom, findTemplate, loadCustom, nameProblem, removeCustom, resolveInstruction, saveCustom, upsertCustom,
} from '../src/main/brain/briefTemplates';
import { defaultInstruction } from '../src/main/brain/meetingBrief';
import { helpText, parseArgs } from '../src/cli/args';
import * as Settings from '../src/main/settings';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-tpl-'));
  applyLanguage('Russian');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MY = { name: 'BANT', instruction: 'Budget, Authority, Need, Timing — по пунктам.' };

describe('built-in templates', () => {
  it('standard, sales call, minutes, summary; standard = the old default', () => {
    const b = builtinTemplates();
    expect(b.map((x) => x.id)).toEqual(['standard', 'sales-call', 'minutes', 'summary']);
    expect(b.map((x) => x.name)).toEqual(['Кратко и задачи (стандарт)', 'Разбор звонка продаж', 'Протокол встречи', 'Краткое резюме']);
    expect(b[0]!.instruction).toBe(defaultInstruction());
    expect(b[1]!.instruction).toContain('Возражения');
    expect(b[2]!.instruction).toContain('Поручения');
    applyLanguage('English');
    expect(builtinTemplates()[1]!.name).toBe('Sales call review');
    applyLanguage('Russian');
  });
  it('find by id, alias (ru/en), shown name, custom name; ё = е', () => {
    expect(findTemplate('sales', [])?.id).toBe('sales-call');
    expect(findTemplate('протокол', [])?.id).toBe('minutes');
    expect(findTemplate('Краткое резюме', [])?.id).toBe('summary');
    expect(findTemplate('bant', [MY])?.instruction).toBe(MY.instruction);
    expect(findTemplate('nope', [MY])).toBeNull();
  });
});

describe('selection → instruction', () => {
  it('template wins; blank or gone → own instruction → default', () => {
    expect(resolveInstruction('minutes', 'my', []).instruction).toContain('протокол');
    expect(resolveInstruction('BANT', '', [MY])).toEqual({ id: 'BANT', instruction: MY.instruction });
    expect(resolveInstruction('', 'Своя', [])).toEqual({ id: OWN, instruction: 'Своя' });
    expect(resolveInstruction('deleted one', '', [])).toEqual({ id: OWN, instruction: defaultInstruction() });
  });
});

describe('custom templates', () => {
  it('clean, upsert keeps place, remove, built-in names refused', () => {
    expect(cleanCustom([{ name: ' ', instruction: 'x' }, { name: 'a', instruction: '' }, { name: 'Протокол встречи', instruction: 'x' }, { name: 'sales', instruction: 'x' }, 3])).toEqual([]);
    let l = upsertCustom([], MY);
    l = upsertCustom(l, { name: 'Второй', instruction: '2' });
    l = upsertCustom(l, { name: 'bant', instruction: 'new' });
    expect(l).toEqual([{ name: 'bant', instruction: 'new' }, { name: 'Второй', instruction: '2' }]);
    expect(removeCustom(l, 'BANT')).toEqual([{ name: 'Второй', instruction: '2' }]);
    expect(nameProblem('')).toMatch(/название/);
    expect(nameProblem('протокол')).toMatch(/встроенный/);
    expect(nameProblem('Мой')).toBeNull();
    expect(allTemplates([MY]).at(-1)).toEqual({ id: 'BANT', name: 'BANT', instruction: MY.instruction, builtin: false });
  });
  it('file round trip; broken file = empty', () => {
    const p = join(dir, 'x', 'brief-templates.json');
    expect(loadCustom(p)).toEqual([]);
    saveCustom(p, [MY]);
    expect(loadCustom(p)).toEqual([MY]);
    writeFileSync(p, 'nope');
    expect(loadCustom(p)).toEqual([]);
  });
  it('settings keep the selection', () => {
    const s = Settings.defaults();
    expect(s.MeetingBriefTemplate).toBe('');
    s.MeetingBriefTemplate = 'sales-call';
    expect(Settings.fromJsonObject(Settings.toJsonObject(s)).settings.MeetingBriefTemplate).toBe('sales-call');
  });
});

describe('CLI args: --template', () => {
  const ok = (a: string[]) => { const r = parseArgs(a); if (!r.ok) throw new Error(r.error); return r.options; };
  it('brief and transcribe take it; list needs no files', () => {
    expect(ok(['brief', 'a.txt', '--template', 'sales']).template).toBe('sales');
    expect(ok(['brief', '--template=list']).template).toBe('list');
    expect(ok(['transcribe', 'a.wav', '--brief', '--template', 'minutes']).template).toBe('minutes');
  });
  it('errors', () => {
    expect(parseArgs(['brief', 'a.txt', '--template', 'x', '--instruction', 'y']).ok).toBe(false);
    expect(parseArgs(['translate', 'a.txt', '--template', 'x']).ok).toBe(false);
    expect(parseArgs(['brief', '--template']).ok).toBe(false);
    expect(parseArgs(['brief', 'a.txt', '--template', 'list']).ok).toBe(false);
  });
});

describe('CLI help: --template', () => {
  it('help mentions --template in both languages', () => {
    for (const lang of [(ru: string) => ru, (_: string, en: string) => en]) {
      const h = helpText(lang);
      expect(h).toContain('--template');
      expect(h).toMatch(/sales-call|разбор звонка/);
    }
  });
});

