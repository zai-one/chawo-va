// Dev-only smoke for voice punctuation and spoken numbers: boots the built app with Chromium's fake
// microphone fed from a WAV file (e.g. espeak-ng «Встреча в пять запятая в офисе точка …»), holds
// the in-window button for one take with both switches off, turns both on with the «Словарь»
// checkboxes, takes again and prints the clipboard each time, the settings on disk and the log line.
// Usage: CHAWO_MODEL_DIR=<models> CHAWO_LOCALAPPDATA=<tmp> CHAWO_APPDATA=<tmp> \
//   xvfb-run electron --no-sandbox scripts/smoke-spoken.cjs <speech.wav> [hold-ms] [shot-prefix]
const { app, BrowserWindow, clipboard } = require('electron');
const { writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-spoken.cjs')) + 1);
const [wav, holdMs = '9500', shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

const Settings = require('../out/main/packages/engine/src/settings.js');
const s = Settings.load();
s.Brain = 'Off';
s.BrainEveryTake = false;
s.SimpleSyntax = false;
s.ShowOverlay = false;
s.Language = 'Russian';
s.SpokenPunctuation = false;
s.SpokenNumbers = false;
Settings.save(s);
require('../out/main/main.js');

app.whenReady().then(async () => {
  await sleep(2000);
  try {
    const main = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder' && x.getTitle() !== 'Chawo');
    const js = (code) => main.webContents.executeJavaScript(code);
    const nav = async (page) => { await js(`document.querySelector('.nav button[data-page="${page}"]').click(); true`); await sleep(500); };
    const take = async () => {
      await nav('dictation');
      for (let i = 0; i < 120; i++) {
        const st = await js(`document.querySelector('[data-d="status"]')?.textContent ?? ''`);
        if (!/Загружаю|Loading/.test(st)) break;
        await sleep(250);
      }
      await clipboard.writeText('(empty)');
      const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      main.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      main.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await sleep(Number(holdMs));
      main.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      for (let i = 0; i < 240; i++) {
        await sleep(250);
        const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
        if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
      }
      return await clipboard.readText();
    };

    log('take 1 (both off):', JSON.stringify(await take()));

    await nav('dictionary');
    await js(`document.querySelector('[data-dict="punctuation"]').click(); true`);
    await sleep(300);
    await js(`document.querySelector('[data-dict="numbers"]').click(); true`);
    await sleep(400);
    const disk = Settings.load();
    log('settings on disk:', JSON.stringify({ SpokenPunctuation: disk.SpokenPunctuation, SpokenNumbers: disk.SpokenNumbers }));
    log('dictionary page:', await js(`[...document.querySelectorAll('main label.check, main .hint.indent')].map((e) => e.textContent.trim()).join(' | ')`));
    await js(`document.querySelector('[data-dict="numbers"]').scrollIntoView(); true`);
    await sleep(200);
    if (shot) writeFileSync(shot + '-dictionary.png', (await main.webContents.capturePage()).toPNG());

    log('take 2 (both on):', JSON.stringify(await take()));
    const logFile = join(process.env.CHAWO_LOCALAPPDATA || '', 'ChawoVoiceAssistant', 'chawo-va.log');
    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => /spoken marks|word replace/.test(l));
      log('log:', lines.join(' || '));
    }
  } catch (e) {
    log(e.stack || e.message);
  }
  app.exit(0);
});
