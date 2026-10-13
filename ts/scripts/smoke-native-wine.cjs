// Real-run of the Windows helper (ChawoNative.exe) on Linux under Wine + Xvfb, through the same
// NativeHelper client the app uses. Needs: wine with wine-mono in $WINEPREFIX, Xvfb, the helper built
// (npm run build:native) and the target built (dotnet build native/win/test/InsertTarget -o native/win/bin/test).
// Checks: ready with the hook installed, Type and Paste into a focused text box (Cyrillic, emoji, newline),
// the previous clipboard comes back after Paste, Ctrl+C selection read with the clipboard restored,
// the foreground process name, keep-phrase mode leaves the phrase when history is off.
// The hold key itself needs a real keyboard (the hook ignores injected keys): see PORTING.md.
const { spawn, execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { NativeHelper } = require('../dist/main/native/nativeHelper.js');
const { DictationSession } = require('../dist/main/dictation/dictationSession.js');
const Settings = require('../dist/main/settings.js');

const root = join(__dirname, '..');
const helperExe = join(root, 'native/win/bin/out/ChawoNative.exe');
const targetExe = join(root, 'native/win/bin/test/InsertTarget.exe');
const display = ':97';
const env = { ...process.env, DISPLAY: display, WINEDEBUG: '-all', WINEPREFIX: process.env.WINEPREFIX || '/workspace/wine/prefix' };
const work = mkdtempSync(join(tmpdir(), 'chawo-wine-'));
const report = join(work, 'report.txt');
const commands = join(work, 'cmd.txt');
const winPath = (p) => 'Z:' + p.replace(/\//g, '\\');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const read = () => {
  try {
    const [text, clip, active] = readFileSync(report, 'utf8').split('\t');
    return { text: b64(text).replace(/\r\n/g, '\n'), clip: b64(clip), active };
  } catch { return null; }
};
async function until(what, cond, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const r = read();
    if (r && cond(r)) return r;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}; last ${JSON.stringify(r)}`);
    await sleep(100);
  }
}
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

(async () => {
  for (const f of [helperExe, targetExe]) if (!existsSync(f)) throw new Error('missing ' + f);
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await sleep(800);
  const target = spawn('wine', [targetExe, winPath(report), winPath(commands)], { env, stdio: 'ignore' });
  const logs = [];
  let helper;
  try {
    let r = await until('target window active', (x) => x.active === 'active' && x.clip === 'OLD clipboard', 60000);
    check('target window up, clipboard = "OLD clipboard"', true);

    helper = new NativeHelper({
      file: 'wine',
      args: [helperExe],
      spawn: (f, a) => spawn(f, [...a], { env, stdio: ['pipe', 'pipe', 'ignore'] }),
      hotkey: () => 0xa3,
      log: (l) => logs.push(l),
      readyTimeoutMs: 60000,
    });
    const t0 = Date.now();
    check('helper ready', await helper.start(), `${Date.now() - t0} ms`);
    check('keyboard hook installed', helper.keyWorks, helper.hookFailure);
    check('ping', await helper.ping());

    const typed = 'Привет, мир 👋\nвторая строка';
    check('insert Type → Done', (await helper.insert(typed, 'Type', { keep: false, restore: true })) === 'Done');
    r = await until('typed text', (x) => x.text === typed).catch((e) => (check('typed text in the box', false, e.message), null));
    if (r) check('typed text in the box', true, JSON.stringify(r.text));
    check('Type leaves the clipboard alone', read().clip === 'OLD clipboard');

    const pasted = ' + вставка через буфер';
    check('insert Paste → Done', (await helper.insert(pasted, 'Paste', { keep: false, restore: true })) === 'Done');
    r = await until('pasted text', (x) => x.text === typed + pasted).catch((e) => (check('pasted text in the box', false, e.message), null));
    if (r) check('pasted text in the box', true);
    r = await until('clipboard restored', (x) => x.clip === 'OLD clipboard', 5000).catch((e) => (check('previous clipboard restored after Paste', false, e.message), null));
    if (r) check('previous clipboard restored after Paste', true);

    check('foreground process', (await helper.foreground()).toLowerCase().includes('inserttarget'), await helper.foreground());

    writeFileSync(commands, 'selectall');
    await sleep(500);
    const sel = await helper.copySelection();
    check('copySelection reads the selected text', (sel || '').replace(/\r\n/g, '\n') === typed + pasted, JSON.stringify(sel));
    await sleep(300);
    check('clipboard back to "OLD clipboard" after the selection read', read().clip === 'OLD clipboard', read().clip);

    // Brain on a selection: SelectionReader (UI Automation, then Ctrl+C for apps that do not say),
    // then the Brain's answer pasted over the selection, the clipboard back as it was.
    writeFileSync(commands, 'selectfirst 6');
    await sleep(500);
    const part = await helper.readSelection();
    check('readSelection: the selected part only', part === 'Привет', JSON.stringify(part));
    await sleep(300);
    check('clipboard back to "OLD clipboard" after readSelection', read().clip === 'OLD clipboard', read().clip);
    const before = read().text;
    check('insert over the selection → Done', (await helper.insert('Здравствуйте', 'Paste', { keep: false, restore: true })) === 'Done');
    r = await until('selection replaced', (x) => x.text === 'Здравствуйте' + before.slice(6)).catch((e) => (check('the answer replaced the selection', false, e.message), null));
    if (r) check('the answer replaced the selection', true, JSON.stringify(r.text.slice(0, 24)));
    r = await until('clipboard restored', (x) => x.clip === 'OLD clipboard', 5000).catch((e) => (check('clipboard restored after replacing', false, e.message), null));
    if (r) check('clipboard restored after replacing', true);
    writeFileSync(commands, 'deselect');
    await sleep(500);
    const none = await helper.readSelection();
    check('readSelection: nothing selected → null', none === null, JSON.stringify(none));
    check('clipboard untouched with nothing selected', read().clip === 'OLD clipboard', read().clip);
    const textBeforeReads = read().text;
    check('reading the selection never changed the text', textBeforeReads === 'Здравствуйте' + before.slice(6));

    // The whole take through DictationSession: global-key take with text selected in the target,
    // recognized command «Чаво, сделай заглавными» → (fake) Brain on the selection → pasted over it.
    {
      const st = Settings.defaults();
      st.Brain = 'Server';
      st.ShowOverlay = false;
      const brainCalls = [];
      const sess = new DictationSession({
        settings: () => st,
        find: (k) => '/m/' + k,
        open: async () => ({
          kind: 'v3_e2e_rnnt', modelId: 'v3_e2e_rnnt', deviceActual: 'cpu', deviceNote: null, intraOpThreads: 1,
          transcribeCancelable: async () => 'Чаво, сделай заглавными.', cancelOwned() {}, async dispose() {},
        }),
        platform: 'win32',
        partialMs: 0,
        inserter: () => helper,
        selection: () => helper,
        brainUsable: () => true,
        transform: async (_s, body, command, _st, _sig, selection) => {
          brainCalls.push({ body, command, selection });
          return body.toUpperCase();
        },
      });
      writeFileSync(commands, 'selectfirst 12');
      await sleep(500);
      const rest = read().text.slice(12);
      check('session: hotkey take starts', sess.startTake('hotkey').ok);
      const n = 16000;
      for (let i = 0; i < n; i += 640) {
        const c = new Float32Array(640);
        for (let j = 0; j < 640; j++) { const k = i + j; c[j] = (k > n * 0.3 && k < n * 0.7 ? 0.3 : 0) * Math.sin(k * 0.2) + 0.001 * Math.sin(k * 1.3); }
        sess.appendPcm(c);
      }
      await sleep(300);
      const out = await sess.stopTake();
      check('session: Brain got the selection and the command', JSON.stringify(brainCalls) === JSON.stringify([{ body: 'Здравствуйте', command: 'сделай заглавными', selection: true }]), JSON.stringify(brainCalls));
      check('session: result', out === 'ЗДРАВСТВУЙТЕ', JSON.stringify(out));
      r = await until('session replaced the selection', (x) => x.text === 'ЗДРАВСТВУЙТЕ' + rest).catch((e) => (check('session: the answer replaced the selection in the app', false, e.message), null));
      if (r) check('session: the answer replaced the selection in the app', true, JSON.stringify(r.text.slice(0, 24)));
      check('session: Ctrl+Z hint', sess.view().status === 'Готово. Вернуть как было: Ctrl+Z', sess.view().status);
      r = await until('clipboard restored', (x) => x.clip === 'OLD clipboard', 5000).catch((e) => (check('session: clipboard back after the take', false, e.message), null));
      if (r) check('session: clipboard back after the take', true);
    }

    // Keep the phrase (CopyPhraseToClipboard) with history off (no registry value in a fresh prefix):
    // the phrase stays the current clipboard.
    writeFileSync(commands, 'selectall'); // typing replaces the selection
    await sleep(400);
    check('insert Type keep → Done', (await helper.insert('фраза в буфере', 'Type', { keep: true, restore: true })) === 'Done');
    r = await until('kept phrase', (x) => x.text === 'фраза в буфере' && x.clip === 'фраза в буфере', 5000).catch((e) => (check('keep: typed and left on the clipboard', false, e.message), null));
    if (r) check('keep: typed and left on the clipboard', true);
  } finally {
    helper?.dispose();
    await sleep(500);
    target.kill();
    try { execFileSync('wineserver', ['-k'], { env }); } catch { /* already down */ }
    xvfb.kill();
    rmSync(work, { recursive: true, force: true });
    console.log('helper log:\n  ' + logs.join('\n  '));
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
