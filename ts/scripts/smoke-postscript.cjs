// Dev-only GUI smoke for «Свой скрипт» (IDEAS №16, batch 2 п.8): boots the built app with Chromium's
// fake microphone fed from a WAV, takes once with no script, types <command> into «Словарь → Свой
// скрипт», presses «Проверить», takes again (clipboard must show the script's answer), then turns on
// «И для расшифровки файлов» and runs <file.wav> through the file queue. Prints the clipboard, the
// check line, settings on disk, the .txt and the «post script» log lines (never the text itself).
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   xvfb-run electron --no-sandbox scripts/smoke-postscript.cjs <mic.wav> <file.wav> "<command>" [shot-prefix]
const { app, BrowserWindow, clipboard, ipcMain } = require('electron');
const { writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-postscript.cjs')) + 1);
const [wav, fileWav, command, shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

const Settings = require('../dist/main/settings.js');
const s = Settings.load();
Object.assign(s, { Brain: 'Off', BrainEveryTake: false, SimpleSyntax: false, ShowOverlay: false, Language: 'Russian', StartHintDismissed: true, SpeechDevice: 'Cpu', PostScript: '', PostScriptFiles: false, FileTimestamps: false });
Settings.save(s);
require('../dist/main/main.js');

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
      await sleep(5000);
      main.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      for (let i = 0; i < 240; i++) {
        await sleep(250);
        const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
        if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
      }
      await sleep(300);
      return { clip: await clipboard.readText(), status: await js(`document.querySelector('[data-d="status"]')?.textContent ?? ''`) };
    };

    log('take 1 (no script):', JSON.stringify(await take()));

    await nav('dictionary');
    await js(`(() => { const i = document.querySelector('[data-dict="script"]'); i.value = ${JSON.stringify(command)}; i.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(400);
    await js(`document.querySelector('[data-dict="scriptTest"]').click(); true`);
    let line = '';
    for (let i = 0; i < 40 && !line; i++) {
      await sleep(250);
      line = await js(`document.querySelector('[data-dict="scriptResult"]')?.textContent ?? ''`);
    }
    log('check line:', JSON.stringify(line));
    log('fieldset:', JSON.stringify(await js(`document.querySelector('fieldset.post-script')?.innerText`)));
    await js(`document.querySelector('fieldset.post-script').scrollIntoView(); true`);
    await sleep(200);
    if (shot) writeFileSync(shot + '-dictionary.png', (await main.webContents.capturePage()).toPNG());

    log('take 2 (script):', JSON.stringify(await take()));

    await nav('dictionary');
    await js(`document.querySelector('[data-dict="scriptFiles"]').click(); true`);
    await sleep(400);
    const disk = Settings.load();
    log('settings on disk:', JSON.stringify({ PostScript: disk.PostScript, PostScriptFiles: disk.PostScriptFiles }));

    const h = ipcMain._invokeHandlers;
    await h.get('file:add')({}, [fileWav], false);
    await h.get('file:run')({});
    for (let i = 0; i < 360 && (await h.get('file:state')({})).busy; i++) await sleep(500);
    const st = await h.get('file:state')({});
    log('file rows:', JSON.stringify(st.items.map((x) => [x.state, x.note])));
    const txt = fileWav.replace(/\.[^.]+$/, '.txt');
    log('file .txt:', JSON.stringify(existsSync(txt) ? readFileSync(txt, 'utf8').slice(0, 160) : '(none)'));

    const logFile = join(process.env.CHAWO_LOCALAPPDATA || '', 'ChawoVoiceAssistant', 'chawo-va.log');
    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => /post script/.test(l));
      log('log:', lines.join(' || '));
    }
  } catch (e) {
    log(e.stack || e.message);
  }
  app.exit(0);
});
