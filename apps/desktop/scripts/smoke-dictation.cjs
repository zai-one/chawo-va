// Dev-only smoke for the «Диктовка» page: boots the built app with Chromium's fake microphone fed
// from a WAV file, holds the in-window button with real mouse events for a few seconds, releases,
// waits for recognition and prints the page state; optional screenshots.
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-dictation.cjs <speech.wav> [hold-ms] [shot-prefix]
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-dictation.cjs')) + 1);
const [wav, holdMs = '6000', shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
require('../out/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
});
app.whenReady().then(async () => {
  await sleep(1500);
  try {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
    const js = (code) => w.webContents.executeJavaScript(code);
    await js(`document.querySelector('.nav button[data-page="dictation"]').click(); true`);
    // Let the page load the recognizer in the background.
    for (let i = 0; i < 60; i++) {
      const st = await js(`document.querySelector('[data-d="status"]')?.textContent ?? ''`);
      if (!/Загружаю|Loading/.test(st)) break;
      await sleep(250);
    }
    console.log('[smoke] mic choices', await js(`JSON.stringify(Array.from(document.querySelectorAll('select.wide option')).map(o => o.textContent))`));
    const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(Number(holdMs) / 2);
    console.log('[smoke] while holding:', await js(`document.querySelector('[data-d="phase"]').textContent + ' | ' + document.querySelector('[data-d="hold"]').textContent + ' | bars ' + Array.from(document.querySelectorAll('[data-d="meter"] span')).map(s => parseInt(s.style.height)||0).join(',')`));
    if (shot) writeFileSync(shot + '-hold.png', (await w.webContents.capturePage()).toPNG());
    await sleep(Number(holdMs) / 2);
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
      if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
    }
    console.log('[smoke] status:', await js(`document.querySelector('[data-d="status"]').textContent`));
    console.log('[smoke] last:', await js(`document.querySelector('[data-d="last"] .last-text').textContent`));
    console.log('[smoke] clipboard:', await require('electron').clipboard.readText());
    if (shot) writeFileSync(shot + '-done.png', (await w.webContents.capturePage()).toPNG());
  } catch (e) {
    console.log('[smoke]', e.stack || e.message);
  }
  app.exit(0);
});
