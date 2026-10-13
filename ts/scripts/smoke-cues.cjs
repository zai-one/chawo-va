// Dev-only smoke for sound cues and the tray dot: boots the built app with Chromium's fake mic fed
// from a WAV file, ticks «Звуковые сигналы…» on «Диктовка», holds the in-window button, releases,
// then presses and Escapes a second take. Prints the cues the page played, the AudioContext state,
// the tray tooltips/images it was given (dot pixel checked) and settings.json's SoundCues.
// Usage: CHAWO_MODEL_DIR=<models> CHAWO_LOCALAPPDATA=<tmp> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-cues.cjs <speech.wav> [hold-ms]
const electron = require('electron');
const { app, BrowserWindow, Tray } = electron;
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-cues.cjs')) + 1);
const [wav, holdMs = '3000'] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
const tips = [];
const dots = [];
const origTip = Tray.prototype.setToolTip;
Tray.prototype.setToolTip = function (t) { tips.push(t); return origTip.call(this, t); };
const origImg = Tray.prototype.setImage;
Tray.prototype.setImage = function (img) {
  const { width, height } = img.getSize();
  const b = img.toBitmap();
  const i = (Math.round(height * 0.74) * width + Math.round(width * 0.74)) * 4;
  dots.push(`${width}x${height} px@dot=${Array.from(b.subarray(i, i + 4)).join(',')}`);
  return origImg.call(this, img);
};
require('../dist/main/main.js');
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
    for (let i = 0; i < 60; i++) {
      const st = await js(`document.querySelector('[data-d="status"]')?.textContent ?? ''`);
      if (!/Загружаю|Loading/.test(st)) break;
      await sleep(250);
    }
    console.log('[smoke] checkbox:', await js(`(() => { const c = document.querySelector('[data-d="cues"]'); return c.parentElement.textContent.trim() + ' | checked=' + c.checked + ' | tip=' + c.parentElement.title; })()`));
    await js(`document.querySelector('[data-d="cues"]').click(); true`);
    await sleep(300);
    const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    const cues = () => js(`document.documentElement.dataset.cues ?? ''`);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(Number(holdMs));
    console.log('[smoke] while holding: cues', await cues());
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    console.log('[smoke] after release: cues', await cues());
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
      if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
    }
    console.log('[smoke] last:', await js(`document.querySelector('[data-d="last"] .last-text').textContent`));
    // second take: press, then Escape
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(1200);
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(400);
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(600);
    console.log('[smoke] after escape: cues', await cues());
    console.log('[smoke] tray tooltips:', JSON.stringify(tips));
    console.log('[smoke] tray images:', JSON.stringify(dots));
    const sj = JSON.parse(readFileSync(join(process.env.CHAWO_APPDATA, 'ChawoVoiceAssistant', 'settings.json'), 'utf8'));
    console.log('[smoke] settings.json SoundCues =', sj.SoundCues);
  } catch (e) {
    console.log('[smoke]', e.stack || e.message);
  }
  app.exit(0);
});
