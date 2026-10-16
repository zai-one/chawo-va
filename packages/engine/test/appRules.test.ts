// Per-app modes (IDEAS №4): rule matching, settings, focus detection parsers, the take, the «Мозг» page.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '@chawo/core/strings';
import { SAMPLE_RATE } from '@chawo/core/takeBuffer';
import {
  applyRule,
  emptyRule,
  exeKey,
  findRule,
  hasActiveRules,
  matchTokens,
  MAX_APP_RULES,
  parseAppRules,
  ruleMatches,
  type AppRule,
  type ForegroundApp,
} from '@chawo/core/appRules';
import * as Settings from '../src/settings';
import * as LocalBrain from '../src/brain/localBrain';
import { BrainController, type BrainPageHooks, type LastApp } from '../src/brain/brainPage';
import { DictationSession, type RecognizerLike, type SessionHooks } from '../src/dictation/dictationSession';
import {
  detectForeground,
  parseActiveWindow,
  parseWindowProps,
  parseWindowsOutput,
  type ExecLike,
} from '../src/foreground/foregroundApp';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-apprules-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});
afterEach(() => LocalBrain.resetRuntime());

const rule = (over: Partial<AppRule>): AppRule => ({ ...emptyRule(), ...over });
const tg: ForegroundApp = { exe: 'Telegram.exe', title: 'Telegram (3)' };
const word: ForegroundApp = { exe: 'WINWORD.EXE', title: 'Договор поставки.docx - Word' };

describe('appRules core', () => {
  it('exeKey drops paths, .exe/.app and case', () => {
    expect(exeKey('C:\\Program Files\\Telegram Desktop\\Telegram.exe')).toBe('telegram');
    expect(exeKey('/usr/bin/telegram-desktop')).toBe('telegram-desktop');
    expect(exeKey('Safari.app')).toBe('safari');
    expect(exeKey('  ')).toBe('');
  });

  it('tokens split on , and ; and drop empties', () => {
    expect(matchTokens(' Telegram , ;WhatsApp; ')).toEqual(['telegram', 'whatsapp']);
    expect(hasActiveRules([rule({ Match: ' , ' })])).toBe(false);
    expect(hasActiveRules([rule({ Match: 'code' })])).toBe(true);
    expect(hasActiveRules(undefined)).toBe(false);
  });

  it('program names match exactly, with or without .exe; titles by a piece, ё = е', () => {
    expect(ruleMatches(rule({ Match: 'telegram' }), tg)).toBe(true);
    expect(ruleMatches(rule({ Match: 'telegram.exe' }), tg)).toBe(true);
    expect(ruleMatches(rule({ Match: 'winword' }), word)).toBe(true);
    expect(ruleMatches(rule({ Match: 'tele' }), { exe: 'Telegram.exe', title: '' })).toBe(false);
    expect(ruleMatches(rule({ Match: 'договор' }), word)).toBe(true);
    expect(ruleMatches(rule({ Match: 'Почта' }), { exe: 'chrome.exe', title: 'Входящие — Почта Mail.ru' })).toBe(true);
    expect(ruleMatches(rule({ Match: 'ёлка' }), { exe: 'x.exe', title: 'Новогодняя елка' })).toBe(true);
    expect(ruleMatches(rule({ Match: 'x' }), { exe: 'chrome.exe', title: 'xyz' })).toBe(false); // one letter is not a title piece
    expect(ruleMatches(rule({ Match: 'code' }), { exe: 'vscode-helper', title: '' })).toBe(false);
  });

  it('first active match from the top wins; empty Match never fires', () => {
    const rules = [rule({ Match: '' }), rule({ Match: 'chrome' }), rule({ Match: 'telegram' }), rule({ Match: 'Telegram (3)' })];
    expect(findRule(rules, tg)?.index).toBe(2);
    expect(findRule(rules, null)).toBeNull();
    expect(findRule(rules, { exe: 'notepad.exe', title: 'Без имени' })).toBeNull();
  });

  it('applyRule overrides only what the rule says and leaves the input alone', () => {
    const base = { BrainEveryTake: true, BrainInstruction: 'общая', SimpleSyntax: false, Other: 1 };
    expect(applyRule(base, null)).toBe(base);
    expect(applyRule(base, rule({ Edit: 'Off' }))).toEqual({ ...base, BrainEveryTake: false });
    expect(applyRule(base, rule({ Edit: 'Default', SimpleSyntax: 'On' }))).toEqual({ ...base, SimpleSyntax: true });
    const off = { ...base, BrainEveryTake: false, SimpleSyntax: true };
    expect(applyRule(off, rule({ Edit: 'Custom', Instruction: 'деловой стиль', SimpleSyntax: 'Off' })))
      .toEqual({ ...off, BrainEveryTake: true, BrainInstruction: 'деловой стиль', SimpleSyntax: false });
    expect(base.BrainEveryTake).toBe(true);
  });

  it('parse drops junk, falls back to Default and caps the list', () => {
    const parsed = parseAppRules([
      { Match: 'telegram', Edit: 'Off', Instruction: '', SimpleSyntax: 'On' },
      { Match: 'word', Edit: 'Bogus', SimpleSyntax: 7 },
      null,
      'x',
    ]);
    expect(parsed).toEqual([
      { Match: 'telegram', Edit: 'Off', Instruction: '', SimpleSyntax: 'On' },
      { Match: 'word', Edit: 'Default', Instruction: '', SimpleSyntax: 'Default' },
    ]);
    expect(parseAppRules('nope')).toEqual([]);
    expect(parseAppRules(Array.from({ length: 80 }, () => ({ Match: 'a' })))).toHaveLength(MAX_APP_RULES);
  });

  it('settings.json round trip keeps the rules; defaults have none', () => {
    expect(Settings.defaults().AppRules).toEqual([]);
    const s = Settings.defaults();
    s.AppRules = [rule({ Match: 'telegram', Edit: 'Custom', Instruction: 'коротко' })];
    const back = Settings.fromJsonObject(JSON.parse(JSON.stringify(Settings.toJsonObject(s)))).settings;
    expect(back.AppRules).toEqual(s.AppRules);
  });
});

describe('focus detection', () => {
  it('parses xprop output (active window, pid, class, UTF-8 title)', () => {
    expect(parseActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007\n')).toBe('0x3a00007');
    expect(parseActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n')).toBeNull();
    expect(parseActiveWindow('_NET_ACTIVE_WINDOW:  not found.\n')).toBeNull();
    const info = parseWindowProps([
      '_NET_WM_PID(CARDINAL) = 4242',
      'WM_CLASS(STRING) = "telegram-desktop", "TelegramDesktop"',
      '_NET_WM_NAME(UTF8_STRING) = "\\320\\247\\320\\260\\321\\202 \\"\\320\\242\\320\\265\\321\\201\\321\\202\\""',
    ].join('\n'));
    expect(info).toEqual({ pid: 4242, wmClass: ['telegram-desktop', 'TelegramDesktop'], title: 'Чат "Тест"' });
    expect(parseWindowProps('_NET_WM_PID:  not found.\nWM_NAME(STRING) = "xterm"')).toEqual({ pid: null, wmClass: [], title: 'xterm' });
  });

  it('parses the PowerShell JSON line', () => {
    expect(parseWindowsOutput('{"exe":"Telegram.exe","title":"Telegram"}\r\n')).toEqual({ exe: 'Telegram.exe', title: 'Telegram' });
    expect(parseWindowsOutput('')).toBeNull();
    expect(parseWindowsOutput('{"title":"x"}')).toBeNull();
    expect(parseWindowsOutput('{broken')).toBeNull();
  });

  function fakeExec(answers: Record<string, string | Error>): { exec: ExecLike; calls: string[][] } {
    const calls: string[][] = [];
    const exec: ExecLike = async (file, args) => {
      calls.push([file, ...args]);
      const key = file + ' ' + args.slice(0, 2).join(' ');
      const a = answers[key] ?? answers[file];
      if (a === undefined) throw new Error('ENOENT');
      if (a instanceof Error) throw a;
      return a;
    };
    return { exec, calls };
  }

  it('Linux: active window → pid → /proc exe name, title kept', async () => {
    const { exec, calls } = fakeExec({
      'xprop -root _NET_ACTIVE_WINDOW': '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1e00003',
      'xprop -id 0x1e00003': '_NET_WM_PID(CARDINAL) = 99\nWM_CLASS(STRING) = "Navigator", "firefox"\n_NET_WM_NAME(UTF8_STRING) = "Почта — Mozilla Firefox"',
    });
    const app = await detectForeground({ platform: 'linux', exec, procExe: (pid) => (pid === 99 ? '/usr/lib/firefox/firefox' : null), selfNames: ['electron'] });
    expect(app).toEqual({ exe: 'firefox', title: 'Почта — Mozilla Firefox' });
    expect(calls).toHaveLength(2);
  });

  it('Linux: no pid → WM_CLASS; our own window → null; no X server → null', async () => {
    const noPid = fakeExec({
      'xprop -root _NET_ACTIVE_WINDOW': '# 0x5',
      'xprop -id 0x5': 'WM_CLASS(STRING) = "xterm", "XTerm"\nWM_NAME(STRING) = "bash"',
    });
    expect(await detectForeground({ platform: 'linux', exec: noPid.exec, selfNames: [] })).toEqual({ exe: 'xterm', title: 'bash' });
    const self = fakeExec({
      'xprop -root _NET_ACTIVE_WINDOW': '# 0x7',
      'xprop -id 0x7': '_NET_WM_PID(CARDINAL) = 1\nWM_NAME(STRING) = "Chawo"',
    });
    expect(await detectForeground({ platform: 'linux', exec: self.exec, procExe: () => '/opt/x/electron', selfNames: ['electron'] })).toBeNull();
    const none = fakeExec({ xprop: new Error('Unable to open display') });
    expect(await detectForeground({ platform: 'linux', exec: none.exec })).toBeNull();
  });

  it('Windows: one hidden PowerShell call with the Win32 script', async () => {
    const { exec, calls } = fakeExec({ 'powershell.exe': '{"exe":"WINWORD.exe","title":"Doc - Word"}' });
    expect(await detectForeground({ platform: 'win32', exec, selfNames: ['Chawo Voice Assistant.exe'] })).toEqual({ exe: 'WINWORD.exe', title: 'Doc - Word' });
    expect(calls[0]![0]).toBe('powershell.exe');
    expect(calls[0]).toContain('-NoProfile');
    expect(calls[0]!.join(' ')).toContain('GetForegroundWindow');
    const self = fakeExec({ 'powershell.exe': '{"exe":"Chawo Voice Assistant.exe","title":"Chawo"}' });
    expect(await detectForeground({ platform: 'win32', exec: self.exec, selfNames: ['Chawo Voice Assistant.exe'] })).toBeNull();
  });

  it('macOS: frontmost process name; other platforms: null', async () => {
    const { exec } = fakeExec({ osascript: 'Telegram\n' });
    expect(await detectForeground({ platform: 'darwin', exec, selfNames: [] })).toEqual({ exe: 'Telegram', title: '' });
    expect(await detectForeground({ platform: 'freebsd', exec })).toBeNull();
  });
});

// ── a take with rules ─────────────────────────────────────

class FakeRecognizer implements RecognizerLike {
  readonly kind = 'v3_e2e_rnnt' as const;
  readonly modelId = 'v3_e2e_rnnt';
  deviceActual = 'cpu';
  deviceNote: string | null = null;
  intraOpThreads = 4;
  reply = 'привет мир';
  async transcribeCancelable(): Promise<string> {
    return this.reply;
  }
  cancelOwned(): void {}
  async dispose(): Promise<void> {}
}

function speech(seconds = 1): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (i > n * 0.3 && i < n * 0.7 ? 0.3 : 0) * Math.sin(i * 0.2) + 0.001 * Math.sin(i * 1.3);
  return out;
}

function server(answer: string) {
  const prompts: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    prompts.push(body.messages[0]!.content);
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 });
  };
  return { prompts, fetch };
}

function makeSession(over: Partial<SessionHooks>, edit: (s: Settings.SettingsData) => void) {
  const s = Settings.defaults();
  s.Brain = 'Server';
  s.CleanupEndpointUrl = 'http://127.0.0.1:9/v1';
  s.CleanupModel = 'qwen';
  edit(s);
  const rec = new FakeRecognizer();
  const seen: Array<{ app: ForegroundApp | null; rule: number | null }> = [];
  let asked = 0;
  let focus: ForegroundApp | null = tg;
  const sess = new DictationSession({
    settings: () => s,
    find: (k) => `/m/${k}`,
    open: async () => rec,
    platform: 'win32',
    partialMs: 0,
    foreground: async () => { asked++; return focus; },
    onApp: (app, rule) => void seen.push({ app, rule }),
    ...over,
  });
  const take = async (reply: string) => {
    rec.reply = reply;
    expect(sess.startTake().ok).toBe(true);
    const x = speech(1);
    for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
    return sess.stopTake();
  };
  return { s, sess, take, seen, asked: () => asked, setFocus: (a: ForegroundApp | null) => { focus = a; } };
}

describe('DictationSession with per-app rules', () => {
  it('no rules: the focus is not even asked, the take is unchanged', async () => {
    const srv = server('X');
    const m = makeSession({ fetch: srv.fetch }, () => {});
    expect(await m.take('привет мир')).toBe('привет мир');
    expect(m.asked()).toBe(0);
    expect(m.seen).toEqual([]);
    expect(srv.prompts).toEqual([]);
  });

  it('Custom rule: every take in that program goes through its own instruction', async () => {
    const srv = server('Привет, мир!');
    const m = makeSession({ fetch: srv.fetch }, (s) => { s.AppRules = [rule({ Match: 'telegram', Edit: 'Custom', Instruction: 'Пиши как в мессенджере.' })]; });
    expect(await m.take('привет мир')).toBe('Привет, мир!');
    expect(srv.prompts).toEqual(['Пиши как в мессенджере.']);
    expect(m.seen).toEqual([{ app: tg, rule: 0 }]);
    // Another program: global settings (rewrite off) → as recognized.
    m.setFocus(word);
    expect(await m.take('привет мир')).toBe('привет мир');
    expect(srv.prompts).toHaveLength(1);
    expect(m.seen[1]).toEqual({ app: word, rule: null });
    expect(m.s.BrainEveryTake).toBe(false); // the saved settings are not touched
  });

  it('Off rule: no rewrite there, but «Чаво, …» still works', async () => {
    const srv = server('Готово');
    const m = makeSession({ fetch: srv.fetch }, (s) => { s.BrainEveryTake = true; s.AppRules = [rule({ Match: 'telegram', Edit: 'Off' })]; });
    expect(await m.take('привет мир')).toBe('привет мир');
    expect(srv.prompts).toEqual([]);
    expect(await m.take('привет мир. Чаво, сделай короче')).toBe('Готово');
    expect(srv.prompts).toHaveLength(1);
    expect(srv.prompts[0]).toContain('сделай короче');
  });

  it('simple syntax per program, both ways', async () => {
    const m = makeSession({}, (s) => { s.Brain = 'Off'; s.AppRules = [rule({ Match: 'telegram', SimpleSyntax: 'On' }), rule({ Match: 'winword', SimpleSyntax: 'Off' })]; });
    expect(await m.take('Привет мир.')).toBe('привет мир');
    m.s.SimpleSyntax = true;
    m.setFocus(word);
    expect(await m.take('Привет мир.')).toBe('Привет мир.');
  });

  it('focus unknown or slow detection failing: globals apply, onApp gets null', async () => {
    const m = makeSession({ foreground: async () => { throw new Error('boom'); } }, (s) => { s.Brain = 'Off'; s.SimpleSyntax = true; s.AppRules = [rule({ Match: 'telegram', SimpleSyntax: 'Off' })]; });
    expect(await m.take('Привет мир.')).toBe('привет мир');
    expect(m.seen).toEqual([{ app: null, rule: null }]);
  });

  it('an empty rule row still asks the focus (so the page can offer «Добавить для …»)', async () => {
    const m = makeSession({}, (s) => { s.Brain = 'Off'; s.AppRules = [rule({ Match: '' })]; });
    expect(await m.take('привет')).toBe('привет');
    expect(m.asked()).toBe(1);
    expect(m.seen).toEqual([{ app: tg, rule: null }]);
  });
});

// ── the «Мозг» page ────────────────────────────────────────

function makePage(last: LastApp | null = null, edit?: (s: Settings.SettingsData) => void, over: Partial<BrainPageHooks> = {}) {
  const s = Settings.defaults();
  edit?.(s);
  let saves = 0;
  let current = last;
  const ctl = new BrainController({
    settings: () => s,
    save: () => void saves++,
    installed: () => [],
    isReady: () => false,
    lastApp: () => current,
    ...over,
  });
  return { s, ctl, saves: () => saves, setLast: (l: LastApp | null) => { current = l; } };
}

describe('«Мозг» page: per-app rules', () => {
  it('empty: heading, hint, add button; no rewrite choice while the Brain is off', () => {
    const { ctl } = makePage();
    const v = ctl.state().appRules;
    expect(v.heading).toBe('Для отдельных программ');
    expect(v.hint).toContain('никуда не уходит');
    expect(v.rules).toEqual([]);
    expect(v.editVisible).toBe(false);
    expect(v.canAdd).toBe(true);
    expect(v.last).toBe('');
    expect(v.lastMatch).toBe('');
  });

  it('add, edit, raise, remove — each saved once; no-op edits are not saved', () => {
    const { s, ctl, saves } = makePage(null, (x) => { x.Brain = 'Server'; });
    ctl.addRule('telegram');
    ctl.addRule();
    expect(s.AppRules).toEqual([rule({ Match: 'telegram' }), rule({ Match: '' })]);
    ctl.updateRule(1, { match: 'winword', edit: 'Custom', instruction: 'Деловой стиль', simple: 'Off' });
    ctl.updateRule(1, { match: 'winword' });
    ctl.updateRule(7, { match: 'nope' });
    expect(saves()).toBe(3);
    let v = ctl.state().appRules;
    expect(v.editVisible).toBe(true);
    expect(v.rules.map((r) => [r.match, r.edit, r.instructionVisible, r.simple, r.active]))
      .toEqual([['telegram', 'Off', false, 'Default', true], ['winword', 'Custom', true, 'Off', true]]);
    ctl.raiseRule(1);
    ctl.raiseRule(0);
    expect(s.AppRules.map((r) => r.Match)).toEqual(['winword', 'telegram']);
    ctl.removeRule(0);
    ctl.removeRule(5);
    v = ctl.state().appRules;
    expect(v.rules.map((r) => r.match)).toEqual(['telegram']);
    expect(saves()).toBe(5);
  });

  it('shows the last program, which rule fired, and offers «Добавить для …» only when new', () => {
    const page = makePage({ app: tg, ruleIndex: null }, (x) => { x.AppRules = [rule({ Match: '' })]; });
    let v = page.ctl.state().appRules;
    expect(v.last).toBe('Последняя программа при диктовке: telegram. Ни одно правило не подошло.');
    expect(v.lastMatch).toBe('telegram');
    page.ctl.updateRule(0, { match: 'Telegram' });
    page.setLast({ app: tg, ruleIndex: 0 });
    v = page.ctl.state().appRules;
    expect(v.last).toBe('Последняя программа при диктовке: telegram. Сработало правило 1.');
    expect(v.lastMatch).toBe('');
    expect(v.rules[0]!.hit).toBe(true);
    page.setLast({ app: null, ruleIndex: null });
    expect(page.ctl.state().appRules.last).toBe('При последней диктовке в фокусе было окно Chawo, или программу определить не удалось.');
  });

  it('English texts and the cap', () => {
    applyLanguage('English');
    try {
      const { ctl, s } = makePage({ app: word, ruleIndex: null });
      const v = ctl.state().appRules;
      expect(v.heading).toBe('For particular programs');
      expect(v.last).toBe('Program at the last take: winword. No rule matched.');
      s.AppRules = Array.from({ length: MAX_APP_RULES }, () => rule({ Match: 'a' }));
      expect(ctl.state().appRules.canAdd).toBe(false);
      ctl.addRule('b');
      expect(s.AppRules).toHaveLength(MAX_APP_RULES);
    } finally {
      applyLanguage('Russian');
    }
  });
});
