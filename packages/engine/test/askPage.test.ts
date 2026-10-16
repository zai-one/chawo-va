import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AskController, type AskHooks } from '../src/history/askPage';
import { HistoryStore } from '../src/history/historyStore';
import { defaults, type SettingsData } from '../src/settings';
import { applyLanguage } from '@chawo/core/strings';

let dir = '';
beforeEach(() => {
  applyLanguage('Russian');
  dir = mkdtempSync(join(tmpdir(), 'chawo-askpage-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(over: Partial<AskHooks> = {}, target: 'None' | 'Local' | 'Cloud' = 'Local', cloud: string | null = null) {
  const s: SettingsData = { ...defaults(), HistoryKeep: 'Forever' };
  const store = new HistoryStore(join(dir, 'history.jsonl'));
  const meet = join(dir, 'meet');
  require('node:fs').mkdirSync(meet);
  const asked: string[] = [];
  const saved: SettingsData[] = [];
  const opened: string[] = [];
  const ctl = new AskController({
    store,
    settings: () => s,
    save: (x) => saved.push({ ...x }),
    meetingFolders: () => [meet],
    brain: () => ({
      target,
      cloud,
      describe: 'на этом компьютере (тест)',
      ask: async (_p, text) => {
        asked.push(text);
        return 'Обещали скидку 10% [1].';
      },
    }),
    open: (p) => opened.push(p),
    ...over,
  });
  return { ctl, s, store, meet, asked, saved, opened };
}

describe('AskController', () => {
  it('answers from a meeting transcript and dictation, cites sources, opens only listed files', async () => {
    const { ctl, store, meet, asked, opened } = setup();
    writeFileSync(join(meet, 'встреча.txt'), '[00:01:00] Иванову обещали скидку 10% до пятницы.\n[00:02:00] Потом о погоде.');
    store.add({ raw: 'позвонить Петрову', final: 'Позвонить Петрову завтра.', command: null, brain: false, brainFailed: false, seconds: 2 }, 'Forever');
    const st = await ctl.ask('Что обещали Иванову?');
    expect(st.answer).toBe('Обещали скидку 10% [1].');
    expect(st.excerpts[0]!.title).toBe('встреча.txt');
    expect(st.excerpts[0]!.cited).toBe(true);
    expect(asked[0]).toContain('Иванову обещали');
    expect(asked[0]).not.toContain('Петрову');
    expect(st.brainLine).toContain('на этом компьютере');
    ctl.openSource(join(meet, 'встреча.txt'));
    ctl.openSource('/etc/passwd');
    expect(opened).toEqual([join(meet, 'встреча.txt')]);
  });

  it('dictation can be left out; nothing to search gives a hint', async () => {
    const { ctl, store } = setup();
    store.add({ raw: 'x', final: 'Иванову скидка.', command: null, brain: false, brainFailed: false, seconds: 1 }, 'Forever');
    expect((await ctl.ask('Иванову')).excerpts).toHaveLength(1);
    ctl.setHistory(false);
    const st = await ctl.ask('Иванову');
    expect(st.useHistory).toBe(false);
    expect(st.status).toMatch(/Искать негде/);
  });

  it('cloud Brain asks first; «no» means search only', async () => {
    let asked = '';
    const { ctl, meet, asked: calls } = setup({ confirm: async (m) => ((asked = m), false) }, 'Cloud', 'Xiaomi');
    writeFileSync(join(meet, 'a.txt'), 'Иванову обещали скидку.');
    const st = await ctl.ask('Иванову');
    expect(asked).toContain('Xiaomi');
    expect(calls).toHaveLength(0);
    expect(st.answer).toBeNull();
    expect(st.excerpts).toHaveLength(1);
  });

  it('no Brain: excerpts only, with a clear line', async () => {
    const { ctl, meet, asked } = setup({}, 'None');
    writeFileSync(join(meet, 'a.txt'), 'поставка в среду');
    const st = await ctl.ask('поставка');
    expect(asked).toHaveLength(0);
    expect(st.brainLine).toMatch(/не настроен/);
    expect(st.excerpts).toHaveLength(1);
  });

  it('folders are saved in AskFolders and searched', async () => {
    const extra = join(dir, 'extra');
    require('node:fs').mkdirSync(extra);
    writeFileSync(join(extra, 'z.txt'), 'бюджет проекта сорок тысяч');
    const { ctl, s } = setup({ pickFolder: async () => extra });
    await ctl.addFolder();
    await ctl.addFolder();
    expect(s.AskFolders).toBe(extra);
    expect((await ctl.ask('бюджет')).excerpts[0]!.title).toBe('z.txt');
    ctl.removeFolder(extra);
    expect(s.AskFolders).toBe('');
  });

  it('a Brain error is a status, not a throw', async () => {
    const { ctl, meet } = setup({
      brain: () => ({ target: 'Local', cloud: null, describe: '', ask: async () => { throw new Error('таймаут'); } }),
    });
    writeFileSync(join(meet, 'a.txt'), 'поставка');
    const st = await ctl.ask('поставка');
    expect(st.status).toContain('таймаут');
    expect(st.busy).toBe(false);
  });
});
