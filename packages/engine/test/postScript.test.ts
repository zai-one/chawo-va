// «Свой скрипт» (IDEAS №16, batch 2 п.8): real child processes through the system shell.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { applyLanguage, t } from '@chawo/core/strings';
import { cleanOutput, failureText, logLine, runPostScript, scriptCommand, scriptEnv } from '@chawo/core/postScript';

const node = JSON.stringify(process.execPath);
const upper = `${node} ${JSON.stringify(join(__dirname, '..', '..', '..', 'fixtures', 'postscript', 'upper.cjs'))}`;
const inline = (code: string) => `${node} -e ${JSON.stringify(code)}`;

describe('postScript pure helpers', () => {
  it('scriptCommand: blank is off, the rest is trimmed', () => {
    expect(scriptCommand('')).toBeNull();
    expect(scriptCommand('   ')).toBeNull();
    expect(scriptCommand(undefined)).toBeNull();
    expect(scriptCommand('  python fix.py ')).toBe('python fix.py');
  });

  it('cleanOutput drops a BOM and trailing newlines only', () => {
    expect(cleanOutput('\uFEFFa\nb\r\n\r\n')).toBe('a\nb');
    expect(cleanOutput('  a  ')).toBe('  a  ');
  });

  it('scriptEnv sets CHAWO_* and UTF-8, drops ELECTRON_RUN_AS_NODE and a stale CHAWO_FILE', () => {
    const env = scriptEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', CHAWO_FILE: 'old' }, 'dictation');
    expect(env).toMatchObject({ PATH: '/bin', CHAWO_SOURCE: 'dictation', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.CHAWO_FILE).toBeUndefined();
    expect(scriptEnv({}, 'file', '/a/b.wav').CHAWO_FILE).toBe('/a/b.wav');
  });

  it('failureText and logLine never carry the text', () => {
    applyLanguage('Russian');
    expect(failureText({ ok: false, reason: 'timeout', detail: '5000', ms: 5001 }, t)).toBe('не ответил за 5 с');
    expect(failureText({ ok: false, reason: 'exit', detail: '2: boom', ms: 1 }, t)).toBe('код выхода 2: boom');
    applyLanguage('English');
    expect(failureText({ ok: false, reason: 'empty', detail: '', ms: 1 }, t)).toBe('empty answer');
    expect(logLine({ ok: true, text: 'СЕКРЕТ', ms: 12 }, 'dictation', 6)).toBe('post script (dictation): ok 6 -> 6 chars, 12 ms');
    expect(logLine({ ok: false, reason: 'exit', detail: '1', ms: 3 }, 'file', 9)).not.toContain('СЕКРЕТ');
  });
});

describe('runPostScript (real processes)', () => {
  it('stdin → stdout in UTF-8, trailing newlines dropped, CHAWO_SOURCE/CHAWO_FILE set', async () => {
    const r = await runPostScript({ command: upper + ' --tag', text: 'привет, чаво\nвторая строка', source: 'file', file: '/rec/встреча.wav', timeoutMs: 15000 });
    expect(r).toMatchObject({ ok: true, text: 'ПРИВЕТ, ЧАВО\nВТОРАЯ СТРОКА [file встреча.wav]' });
  });

  it('non-zero exit keeps the text and reports the code with the last stderr line', async () => {
    const r = await runPostScript({ command: inline("console.error('first');console.error('broken rule');process.exit(3)"), text: 'x', source: 'dictation', timeoutMs: 15000 });
    expect(r).toMatchObject({ ok: false, reason: 'exit', detail: '3: broken rule' });
  });

  it('a missing program is a failure, not a throw', async () => {
    const r = await runPostScript({ command: 'chawo-no-such-program-xyz', text: 'x', source: 'dictation', timeoutMs: 15000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['exit', 'start']).toContain(r.reason);
  });

  it('empty answer is a failure (the phrase is never swallowed)', async () => {
    const r = await runPostScript({ command: inline("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('\\n'))"), text: 'x', source: 'dictation', timeoutMs: 15000 });
    expect(r).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('a script that ignores stdin still works', async () => {
    const r = await runPostScript({ command: inline("process.stdout.write('fixed')"), text: 'x'.repeat(200000), source: 'dictation', timeoutMs: 15000 });
    expect(r).toMatchObject({ ok: true, text: 'fixed' });
  });

  it('timeout kills the script and keeps the text', async () => {
    const t0 = Date.now();
    const r = await runPostScript({ command: inline('setTimeout(()=>{},60000)'), text: 'x', source: 'dictation', timeoutMs: 700 });
    expect(r).toMatchObject({ ok: false, reason: 'timeout', detail: '700' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('abort stops it', async () => {
    const ac = new AbortController();
    const p = runPostScript({ command: inline('setTimeout(()=>{},60000)'), text: 'x', source: 'dictation', timeoutMs: 30000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    expect(await p).toMatchObject({ ok: false, reason: 'aborted' });
    const pre = new AbortController();
    pre.abort();
    expect(await runPostScript({ command: upper, text: 'x', source: 'dictation', signal: pre.signal })).toMatchObject({ ok: false, reason: 'aborted' });
  });
});

// ---- Dictation, «Словарь», file queue ----
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll } from 'vitest';
import { SAMPLE_RATE } from '@chawo/core/takeBuffer';
import * as Settings from '../src/settings';
import { DictationSession, type RecognizerLike, type SessionHooks } from '../src/dictation/dictationSession';
import { DictionaryController, SCRIPT_SAMPLE } from '../src/dictionary/dictionaryPage';
import { FileQueue } from '../src/file/fileQueue';
import { FileRunner } from '../src/file/fileRunner';
import type { PostScriptRun } from '@chawo/core/postScript';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-postscript-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});

class FakeRec implements RecognizerLike {
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

function speech(): Float32Array {
  const n = SAMPLE_RATE;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (i > n * 0.3 && i < n * 0.7 ? 0.3 : 0) * Math.sin(i * 0.2) + 0.001 * Math.sin(i * 1.3);
  return out;
}

function session(edit: (s: Settings.SettingsData) => void, over: Partial<SessionHooks> = {}) {
  const s = Settings.defaults();
  edit(s);
  const rec = new FakeRec();
  const copied: string[] = [];
  const records: { raw: string; final: string }[] = [];
  const sess = new DictationSession({
    settings: () => s,
    copy: (x) => void copied.push(x),
    find: (k) => `/m/${k}`,
    open: async () => rec,
    platform: 'win32',
    partialMs: 0,
    record: (r) => void records.push(r),
    ...over,
  });
  const take = async (reply: string, source: 'window' | 'hotkey' = 'window') => {
    rec.reply = reply;
    expect(sess.startTake(source).ok).toBe(true);
    const x = speech();
    for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
    return sess.stopTake();
  };
  return { s, sess, copied, records, take };
}

describe('dictation with «Свой скрипт»', () => {
  it('off by default: nothing runs', async () => {
    const calls: PostScriptRun[] = [];
    const { take } = session(() => undefined, { postScript: async (r) => { calls.push(r); return { ok: true, text: 'X', ms: 1 }; } });
    expect(await take('привет мир')).toBe('привет мир');
    expect(calls).toHaveLength(0);
  });

  it('real script: the last step, after the dictionary and simple syntax; history keeps raw and final', async () => {
    applyLanguage('Russian');
    const { take, copied, records, sess } = session((s) => { s.PostScript = upper + ' --tag'; s.SimpleSyntax = true; });
    const out = await take('Привет, Чаво.');
    expect(out).toBe('ПРИВЕТ, CHAWO [dictation]');
    expect(copied).toEqual(['ПРИВЕТ, CHAWO [dictation]']);
    expect(records[0]).toMatchObject({ raw: 'Привет, Chawo.', final: 'ПРИВЕТ, CHAWO [dictation]' });
    expect(sess.view().status).toMatch(/Готово/);
  });

  it('a failing script: the phrase goes in as it was, the status says why', async () => {
    applyLanguage('Russian');
    const { take, copied, sess } = session((s) => { s.PostScript = 'whatever'; }, {
      postScript: async () => ({ ok: false, reason: 'timeout', detail: '5000', ms: 5000 }),
    });
    expect(await take('привет мир')).toBe('привет мир');
    expect(copied).toEqual(['привет мир']);
    expect(sess.view().status).toBe('Скрипт не сработал: не ответил за 5 с. В буфере обмена текст без скрипта.');
  });

  it('inserted via the helper: source and failure hint', async () => {
    applyLanguage('English');
    const seen: PostScriptRun[] = [];
    const inserted: string[] = [];
    const { sess, take } = session((s) => { s.PostScript = 'fix'; }, {
      postScript: async (r) => { seen.push(r); return { ok: false, reason: 'exit', detail: '1', ms: 2 }; },
      inserter: () => ({ insert: async (x: string) => { inserted.push(x); return 'Done' as const; } }),
    });
    expect(await take('hello', 'hotkey')).toBe('hello');
    expect(inserted).toEqual(['hello']);
    expect(seen[0]).toMatchObject({ command: 'fix', text: 'hello', source: 'dictation', timeoutMs: 5000 });
    expect(sess.view().status).toMatch(/The script failed: exit code 1/);
  });
});

describe('«Словарь»: Свой скрипт', () => {
  function ctl(edit: (s: Settings.SettingsData) => void = () => undefined, runScript?: (r: PostScriptRun) => Promise<import('@chawo/core/postScript').PostScriptResult>) {
    const s = Settings.defaults();
    edit(s);
    let saves = 0;
    const c = new DictionaryController({ settings: () => s, save: () => void saves++, runScript });
    return { s, c, saves: () => saves };
  }

  it('state, save on edit (line breaks flattened), files switch', () => {
    applyLanguage('Russian');
    const { s, c, saves } = ctl();
    const st = c.state().script;
    expect(st).toMatchObject({ heading: 'Свой скрипт', command: '', files: false, testLine: '', testOk: null });
    expect(st.hint).toContain('stdin');
    expect(c.setScript('python fix.py\n').script.command).toBe('python fix.py ');
    expect(s.PostScript).toBe('python fix.py ');
    c.setScript('python fix.py ');
    expect(saves()).toBe(1);
    expect(c.setScriptFiles(true).script.files).toBe(true);
    expect(s.PostScriptFiles).toBe(true);
  });

  it('«Проверить»: blank asks for a command; a real script shows its answer; a failure says so', async () => {
    applyLanguage('Russian');
    const { c } = ctl();
    expect((await c.testScript()).script).toMatchObject({ testLine: 'Сначала впишите команду.', testOk: false });
    c.setScript(upper);
    const ok = (await c.testScript()).script;
    expect(ok.testOk).toBe(true);
    expect(ok.testLine).toContain(SCRIPT_SAMPLE.toUpperCase());
    c.setScript(inline('process.exit(2)'));
    expect(c.state().script.testLine).toBe(''); // a new command forgets the old check
    const bad = (await c.testScript()).script;
    expect(bad).toMatchObject({ testOk: false });
    expect(bad.testLine).toMatch(/^Не сработал: код выхода 2/);
  });
});

describe('FileRunner + «Свой скрипт»', () => {
  function runner(postScript: string | null, runScript?: (r: PostScriptRun) => Promise<import('@chawo/core/postScript').PostScriptResult>) {
    const queue = new FileQueue();
    const r = new FileRunner({
      queue,
      load16k: async () => new Float32Array(16000 * 3),
      prepare: async () => ({ ok: true, transcriber: async () => [{ start: 0, end: 1, text: 'первая фраза' }, { start: 1, end: 3, text: 'вторая' }] }),
      options: () => ({ timestamps: false, srt: true, useBrain: false, diarize: false, brief: false, postScript }),
      status: () => undefined,
      runScript,
    });
    return { queue, r };
  }

  it('real script rewrites the .txt only; .srt stays as recognized; note «скрипт»', async () => {
    applyLanguage('Russian');
    const src = join(dir, 'встреча.wav');
    writeFileSync(src, 'x');
    const { queue, r } = runner(upper + ' --tag');
    queue.add([src], false);
    await r.run();
    expect(readFileSync(join(dir, 'встреча.txt'), 'utf8')).toBe('ПЕРВАЯ ФРАЗА\nВТОРАЯ [file встреча.wav]');
    expect(readFileSync(join(dir, 'встреча.srt'), 'utf8')).toContain('первая фраза');
    expect(queue.snapshot()[0]).toMatchObject({ state: 'Done' });
    expect(queue.snapshot()[0].note).toContain('скрипт');
  });

  it('failure: .txt as recognized, note says why; 60 s timeout for files', async () => {
    applyLanguage('Russian');
    const src = join(dir, 'b.wav');
    writeFileSync(src, 'x');
    const seen: PostScriptRun[] = [];
    const { queue, r } = runner('fix', async (x) => { seen.push(x); return { ok: false, reason: 'empty', detail: '', ms: 1 }; });
    queue.add([src], false);
    await r.run();
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('первая фраза\nвторая');
    expect(queue.snapshot()[0].note).toContain('скрипт: пустой ответ');
    expect(seen[0]).toMatchObject({ source: 'file', file: src, timeoutMs: 60000 });
  });

  it('off (null): the runner never calls it', async () => {
    const src = join(dir, 'c.wav');
    writeFileSync(src, 'x');
    let n = 0;
    const { queue, r } = runner(null, async () => { n++; return { ok: true, text: 'x', ms: 1 }; });
    queue.add([src], false);
    await r.run();
    expect(n).toBe(0);
  });
});
