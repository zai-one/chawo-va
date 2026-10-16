// Dev-only smoke for the extra transcript files (.vtt/.json/.md/.docx). Boots the built app, opens
// «Расшифровка файла», ticks the four new boxes with real clicks, checks settings.json, runs a
// speech WAV through the queue with the real local model and prints what was written.
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-export.cjs <speech.wav> [shot.png]
const { app, BrowserWindow } = require('electron');
const { copyFileSync, existsSync, readFileSync, writeFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-export.cjs')) + 1);
const [wav, shot = ''] = args;
require('../out/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);
app.on('web-contents-created', (_e, wc) => wc.on('console-message', (e) => e.level !== 'info' && console.log('[renderer]', e.level, e.message)));

app.whenReady().then(async () => {
  await sleep(1500);
  let code = 0;
  try {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
    const js = (c) => w.webContents.executeJavaScript(c);
    const h = require('electron').ipcMain._invokeHandlers;
    await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
    await sleep(600);
    await h.get('file:options')({}, { timestamps: true, srt: true, extra: [] });
    await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
    await sleep(400);
    for (const ext of ['vtt', 'json', 'md', 'docx']) {
      await js(`[...document.querySelectorAll('.formats label')].find((l) => l.textContent.trim() === '.${ext}').querySelector('input').click(); true`);
      await sleep(250);
    }
    log('row', await js(`document.querySelector('.formats').parentElement.innerText`));
    log('checked', await js(`[...document.querySelectorAll('.formats input')].map((i) => i.checked).join(',')`));
    const settingsFile = join(process.env.CHAWO_APPDATA, 'ChawoVoiceAssistant', 'settings.json');
    const saved = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
    log('settings.json FileExtraFormats', JSON.stringify(saved.FileExtraFormats), 'FileSrt', saved.FileSrt);
    if (shot) writeFileSync(shot, (await w.webContents.capturePage()).toPNG());

    const copy = join(app.getPath('temp'), 'chawo-smoke-export.wav');
    copyFileSync(wav, copy);
    await h.get('file:add')({}, [copy], false);
    const t0 = Date.now();
    await h.get('file:run')({});
    for (let i = 0; i < 480 && (await h.get('file:state')({})).busy; i++) await sleep(250);
    const st = await h.get('file:state')({});
    log('row note', JSON.stringify(st.items.at(-1)), `${Date.now() - t0} ms`);
    for (const ext of ['txt', 'srt', 'vtt', 'json', 'md', 'docx']) {
      const p = copy.replace(/\.wav$/, '.' + ext);
      log(ext, existsSync(p) ? `${statSync(p).size} B ${p}` : 'MISSING');
      if (!existsSync(p)) code = 1;
      else if (ext !== 'docx') log(readFileSync(p, 'utf8').slice(0, 400));
    }
  } catch (e) {
    console.error('[smoke] FAIL', e);
    code = 1;
  }
  app.exit(code);
});
