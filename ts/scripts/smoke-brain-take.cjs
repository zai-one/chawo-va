// Dev-only smoke for a dictation take through the Brain and the floating pill: starts a fake
// OpenAI-compatible server on 127.0.0.1, saves settings with Brain=Server (+ every take + simple
// syntax, or a «Чаво, …» command via the WAV), boots the built app with Chromium's fake mic fed from a
// WAV, holds the in-window button, screenshots the pill while listening and while the Brain works,
// then prints the page status, the clipboard and what the server got.
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   xvfb-run -a electron --no-sandbox scripts/smoke-brain-take.cjs <speech.wav> [hold-ms] [shot-prefix]
const { app, BrowserWindow, clipboard } = require('electron');
const http = require('node:http');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-brain-take.cjs')) + 1);
const [wav, holdMs = '6000', shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const got = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const j = JSON.parse(body || '{}');
    got.push(j);
    await sleep(1500); // long enough to see «Причёсываю…» on the pill
    const text = String(j.messages?.[1]?.content ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Мозг: ' + text } }] }));
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
  s.BrainEveryTake = true;
  s.SimpleSyntax = true;
  s.ShowOverlay = true;
  Settings.save(s);
  require('../dist/main/main.js');
});

app.whenReady().then(async () => {
  await sleep(1500);
  try {
    const main = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder' && x.getTitle() !== 'Chawo');
    const js = (code) => main.webContents.executeJavaScript(code);
    await js(`document.querySelector('.nav button[data-page="dictation"]').click(); true`);
    for (let i = 0; i < 60; i++) {
      const st = await js(`document.querySelector('[data-d="status"]')?.textContent ?? ''`);
      if (!/Загружаю|Loading/.test(st)) break;
      await sleep(250);
    }
    const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    main.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    main.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(Number(holdMs) * 0.8);
    const pill = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Chawo');
    const pillText = async () => {
      const p = pill();
      if (!p) return '(no pill)';
      return `${p.isVisible() ? 'visible' : 'hidden'} ${JSON.stringify(p.getBounds())} ` +
        (await p.webContents.executeJavaScript(`[document.getElementById('label').hidden ? '' : document.getElementById('label').textContent, document.getElementById('live').hidden ? '' : document.getElementById('live').textContent].filter(Boolean).join(' | ')`));
    };
    console.log('[smoke] pill while holding:', await pillText());
    if (shot && pill()) writeFileSync(shot + '-pill-hold.png', (await pill().webContents.capturePage()).toPNG());
    await sleep(Number(holdMs) * 0.2);
    main.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    let shotBrain = false;
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      if (!shotBrain && got.length > 0) {
        shotBrain = true;
        await sleep(300);
        console.log('[smoke] pill during brain:', await pillText());
        console.log('[smoke] page status during brain:', await js(`document.querySelector('[data-d="status"]').textContent`));
        if (shot && pill()) writeFileSync(shot + '-pill-brain.png', (await pill().webContents.capturePage()).toPNG());
      }
      const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
      if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
    }
    console.log('[smoke] server got:', JSON.stringify(got.map((g) => ({ model: g.model, user: g.messages?.[1]?.content }))));
    console.log('[smoke] status:', await js(`document.querySelector('[data-d="status"]').textContent`));
    console.log('[smoke] clipboard:', clipboard.readText());
    console.log('[smoke] pill after:', await pillText());
    if (shot) writeFileSync(shot + '-done.png', (await main.webContents.capturePage()).toPNG());
  } catch (e) {
    console.log('[smoke]', e.stack || e.message);
  }
  srv.close();
  app.exit(0);
});
