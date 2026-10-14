// Dev-only smoke for «Начинать запись по слову «Чаво»»: boots the built app with Chromium's fake
// microphone looping a WAV, ticks the checkbox on «Диктовка» (nothing is held or pressed), then watches
// the take phase, the status, the last phrase and the clipboard for a while. Optional screenshot.
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-wake.cjs <speech.wav> [watch-ms] [shot.png]
const { app, BrowserWindow, clipboard } = require('electron');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-wake.cjs')) + 1);
const [wav, watchMs = '20000', shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
require('../dist/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    clipboard.writeText('');
    console.log('[smoke] wake before:', await js(`document.documentElement.dataset.wake ?? 'unset'`));
    await js(`document.querySelector('[data-d="wake"]').click(); true`);
    await sleep(800);
    console.log('[smoke] wake after tick:', await js(`document.documentElement.dataset.wake + ' | ' + (document.querySelector('[data-d="wake-note"]')?.textContent ?? '')`));
    if (shot) {
      await js(`document.querySelector('[data-d="wake"]').scrollIntoView({ block: 'center' }); true`);
      await sleep(200);
      writeFileSync(shot.replace(/\.png$/, '') + '-setting.png', (await w.webContents.capturePage()).toPNG());
    }
    const t0 = Date.now();
    let last = '';
    const clips = [];
    while (Date.now() - t0 < Number(watchMs)) {
      await sleep(100);
      const line = await js(`document.querySelector('[data-d="phase"]').textContent + ' | ' + document.querySelector('[data-d="status"]').textContent`);
      if (line !== last) {
        console.log(`[smoke] ${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`);
        last = line;
      }
      const c = clipboard.readText();
      if (c && clips[clips.length - 1] !== c) {
        clips.push(c);
        console.log(`[smoke] ${((Date.now() - t0) / 1000).toFixed(1)}s clipboard: ${c}`);
        if (shot && clips.length === 1) writeFileSync(shot, (await w.webContents.capturePage()).toPNG());
      }
    }
    await js(`document.querySelector('[data-d="wake"]').click(); true`);
    await sleep(800);
    console.log('[smoke] wake after untick:', await js(`document.documentElement.dataset.wake`));
    console.log('[smoke] takes inserted/copied:', clips.length);
  } catch (e) {
    console.log('[smoke]', e.stack || e.message);
  }
  app.exit(0);
});
