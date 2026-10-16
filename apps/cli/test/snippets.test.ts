import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '@chawo/core/strings';
import {
  applySnippets, cleanSnippets, expandTokens, loadSnippets, normTrigger, removeSnippet, saveSnippets, snippetToken, upsertSnippet,
} from '@chawo/core/snippets';
import { parseArgs } from '../src/cli/args';
import * as Settings from '@chawo/engine/settings';
import { DictionaryController } from '@chawo/engine/dictionary/dictionaryPage';

const SIG = { trigger: 'подпись', text: 'С уважением,\nАлександр' };
const REQ = { trigger: 'реквизиты компании', text: 'ИНН 7700000000' };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-snip-'));
  applyLanguage('Russian');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('applySnippets', () => {
  it('«вставь подпись» inside a phrase is replaced, punctuation after the trigger goes with it', () => {
    expect(applySnippets('Спасибо за звонок, вставь подпись.', [SIG])).toEqual({ text: 'Спасибо за звонок, С уважением,\nАлександр', used: ['подпись'] });
    expect(applySnippets('Вставить Подпись, и всё', [SIG]).text).toBe('С уважением,\nАлександр и всё');
  });
  it('the trigger alone (or with the verb) as the whole phrase', () => {
    expect(applySnippets('Подпись.', [SIG]).text).toBe(SIG.text);
    expect(applySnippets('вставь подпись', [SIG]).text).toBe(SIG.text);
  });
  it('a word without the verb inside a phrase stays a word', () => {
    expect(applySnippets('поставьте подпись тут', [SIG])).toEqual({ text: 'поставьте подпись тут', used: [] });
  });
  it('multi-word triggers, ё = е, several in one phrase, longest wins', () => {
    const list = [{ trigger: 'реквизиты', text: 'short' }, REQ, SIG];
    const r = applySnippets('вставь реквизиты компании и вставь подпись', list);
    expect(r.text).toBe('ИНН 7700000000 и С уважением,\nАлександр');
    expect(r.used).toEqual(['реквизиты компании', 'подпись']);
    expect(applySnippets('вставь всё', [{ trigger: 'ВСЕ', text: 'x' }]).text).toBe('x');
  });
  it('markers survive another step and expand back; a lost marker is appended', () => {
    const r = applySnippets('Итак, вставь подпись', [SIG], snippetToken);
    expect(r.text).not.toContain('Александр');
    expect(expandTokens(r.text.toUpperCase(), [SIG], r.used)).toBe('ИТАК, ' + SIG.text);
    expect(expandTokens('ИТАК', [SIG], r.used)).toBe('ИТАК\n' + SIG.text);
  });
  it('real-speech forms: «ставь» (GigaAM hears «вставь» so) and word endings', () => {
    expect(applySnippets('Спасибо за звонок. Ставь подпись.', [SIG]).text).toBe('Спасибо за звонок. ' + SIG.text);
    expect(applySnippets('вставь подписи', [SIG]).text).toBe(SIG.text);
    expect(applySnippets('вставь реквизитов компании', [{ trigger: 'реквизиты компании', text: 'x' }]).used).toHaveLength(1);
    expect(applySnippets('вставь подпора', [SIG]).used).toEqual([]);
  });
  it('no snippets or empty text → unchanged', () => {
    expect(applySnippets('вставь подпись', []).used).toEqual([]);
    expect(applySnippets('', [SIG]).text).toBe('');
  });
});

describe('snippet list + file', () => {
  it('clean drops empties and duplicates (last wins)', () => {
    expect(cleanSnippets([{ trigger: ' ', text: 'x' }, { trigger: 'a', text: ' ' }, { trigger: 'Подпись', text: '1' }, { trigger: 'подпись!', text: '2' }, 5]))
      .toEqual([{ trigger: 'подпись!', text: '2' }]);
    expect(normTrigger(' Моя  Ёлка! ')).toBe('моя елка');
  });
  it('upsert / remove by trigger', () => {
    let l = upsertSnippet([], SIG);
    l = upsertSnippet(l, { trigger: 'ПОДПИСЬ', text: 'new' });
    expect(l).toEqual([{ trigger: 'ПОДПИСЬ', text: 'new' }]);
    expect(removeSnippet(l, 'подпись').removed).toBe(true);
    expect(removeSnippet(l, 'нет').removed).toBe(false);
  });
  it('save/load round trip; missing or broken file = empty', () => {
    const p = join(dir, 'a', 'snippets.json');
    expect(loadSnippets(p)).toEqual([]);
    saveSnippets(p, [SIG, REQ]);
    expect(JSON.parse(readFileSync(p, 'utf8')).version).toBe(1);
    expect(loadSnippets(p)).toEqual([SIG, REQ]);
    writeFileSync(p, '{oops');
    expect(loadSnippets(p)).toEqual([]);
  });
});

describe('CLI args: snippets', () => {
  const ok = (a: string[]) => { const r = parseArgs(a); if (!r.ok) throw new Error(r.error); return r.options; };
  it('list / add / remove', () => {
    expect(ok(['snippets']).inputs).toEqual(['list']);
    expect(ok(['snippets', 'list', '--json']).json).toBe(true);
    expect(ok(['snippets', 'add', 'подпись', 'С', 'уважением']).inputs).toEqual(['add', 'подпись', 'С уважением']);
    expect(ok(['snippets', 'add', 'подпись', '-']).inputs).toEqual(['add', 'подпись', '-']);
    expect(ok(['snippets', 'rm', 'моя', 'подпись']).inputs).toEqual(['remove', 'моя подпись']);
  });
  it('errors', () => {
    expect(parseArgs(['snippets', 'add', 'x']).ok).toBe(false);
    expect(parseArgs(['snippets', 'remove']).ok).toBe(false);
    expect(parseArgs(['snippets', 'zap']).ok).toBe(false);
    expect(parseArgs(['snippets', 'list', '--format', 'srt']).ok).toBe(false);
  });
});

describe('«Словарь»: Сниппеты block', () => {
  it('add → edit → saved to the file; remove; outside edits reload', () => {
    const p = join(dir, 'page', 'snippets.json');
    const s = Settings.defaults();
    const ctl = new DictionaryController({ settings: () => s, save: () => {}, snippetsPath: () => p });
    expect(ctl.state().snippets.rows).toEqual([]);
    expect(ctl.state().snippets.heading).toBe('Сниппеты');
    const id = ctl.addSnippet();
    expect(loadSnippets(p)).toEqual([]); // blank row is not saved
    ctl.setSnippet(id, 'подпись', SIG.text);
    expect(loadSnippets(p)).toEqual([SIG]);
    saveSnippets(p, [SIG, REQ]); // e.g. `chawo-va snippets add`
    const rows = ctl.state().snippets.rows;
    expect(rows.map((r) => r.trigger)).toEqual(['подпись', 'реквизиты компании']);
    ctl.removeSnippet(rows[0].id);
    expect(loadSnippets(p)).toEqual([REQ]);
  });
});
