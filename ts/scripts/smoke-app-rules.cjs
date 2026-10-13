// Dev-only smoke for per-app modes on a real X11 session (Xvfb + xfwm4): a fake OpenAI-compatible
// server on 127.0.0.1, settings with Brain=Server, rewrite OFF globally and one rule «xmessage →
// Custom instruction + chat-style». An xmessage window titled «Telegram — чат» gets the focus via
// xdotool, then the in-window hold button is pressed with synthetic input (the OS focus stays on
// xmessage) and the take must go through the rule's instruction. A second take with the Chawo window
// focused must match nothing. Prints what the server got, the clipboard and the «Мозг» page lines.
// Usage: DISPLAY=:77 CHAWO_MODEL_DIR=<models> CHAWO_LOCALAPPDATA=<tmp> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-app-rules.cjs <speech.wav> [shot-prefix]
const { app, BrowserWindow, clipboard } = require('electron');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-app-rules.cjs')) + 1);
const [wav, shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

const got = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    got.push(j);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'по правилу: ' + String(j.messages?.[1]?.content ?? '') } }] }));
  });
});

srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  const Settings = require('../dist/main/settings.js');
  const s = Settings.load();
  s.Brain = 'Server';
  s.CleanupEndpointUrl = `http://127.0.0.1:${port}/v1`;
  s.CleanupModel = 'fake';
  s.CleanupApiKey = '';
  s.BrainEveryTake = false;
  s.SimpleSyntax = false;
  s.ShowOverlay = false;
  s.Language = 'Russian';
  s.AppRules = [{ Match: 'xmessage', Edit: 'Custom', Instruction: 'APPMODE: пиши как в чате.', SimpleSyntax: 'On' }];
  Settings.save(s);
  require('../dist/main/main.js');
});

const xdo = (...a) => execFileSync('xdotool', a, { encoding: 'utf8' }).trim();
const activeName = () => { try { return xdo('getactivewindow', 'getwindowname'); } catch { return '(none)'; } };

app.whenReady().then(async () => {
  await sleep(2000);
  try {
    const main = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder' && x.getTitle() !== 'Chawo');
    const js = (code) => main.webContents.executeJavaScript(code);
    const nav = async (page) => { await js(`document.querySelector('.nav button[data-page="${page}"]').click(); true`); await sleep(500); };
    const hold = async (ms) => {
      await nav('dictation');
      for (let i = 0; i < 80; i++) {
        const st = await js(`document.querySelector('[data-d="status"]')?.textContent ?? ''`);
        if (!/Загружаю|Loading/.test(st)) break;
        await sleep(250);
      }
      log('page before hold:', await js(`(document.querySelector('[data-d="phase"]')?.textContent ?? '') + ' / ' + (document.querySelector('[data-d="status"]')?.textContent ?? '')`));
      const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      main.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      main.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await sleep(ms);
      main.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      for (let i = 0; i < 240; i++) {
        await sleep(250);
        const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
        if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
      }
      log('page after take:', await js(`(document.querySelector('[data-d="phase"]')?.textContent ?? '') + ' / ' + (document.querySelector('[data-d="status"]')?.textContent ?? '')`));
    };
    const brainLines = async () => {
      await nav('brain');
      return js(`[...document.querySelectorAll('main .app-rule input, main .hint.line, main [data-rule="add-last"]')].map((e) => e.value || e.textContent).join(' | ')`);
    };

    // 1) xmessage has the focus.
    const id = xdo('search', '--name', 'Telegram');
    xdo('windowactivate', '--sync', id);
    await sleep(500);
    log('focused before take 1:', activeName());
    await hold(4000);
    log('focused after take 1:', activeName());
    log('server got:', JSON.stringify(got.map((g) => ({ system: g.messages?.[0]?.content, user: g.messages?.[1]?.content }))));
    log('clipboard 1:', clipboard.readText());
    log('brain page 1:', await brainLines());
    await js(`document.querySelector('.app-rule')?.scrollIntoView(); true`);
    await sleep(200);
    if (shot) writeFileSync(shot + '-brain-hit.png', (await main.webContents.capturePage()).toPNG());

    // 2) Chawo itself focused: no rule, rewrite is off globally → no server call.
    main.focus();
    xdo('windowactivate', '--sync', xdo('search', '--name', '^Chawo Voice'));
    await sleep(500);
    log('focused before take 2:', activeName());
    const before = got.length;
    await hold(4000);
    log('server calls in take 2:', got.length - before);
    log('clipboard 2:', clipboard.readText());
    log('brain page 2:', await brainLines());

    // 3) The page: add a second rule, show the rewrite choice and the instruction box.
    await js(`document.querySelector('[data-rule="add"]').click(); true`);
    await sleep(400);
    log('rules on disk:', JSON.stringify(require('../dist/main/settings.js').load().AppRules));
    await js(`document.querySelectorAll('.app-rule')[0]?.scrollIntoView(); true`);
    await sleep(200);
    if (shot) writeFileSync(shot + '-brain-rules.png', (await main.webContents.capturePage()).toPNG());
  } catch (e) {
    log(e.stack || e.message);
  }
  srv.close();
  app.exit(0);
});
