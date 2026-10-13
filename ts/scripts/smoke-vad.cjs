// Dev-only smoke for the VAD checkbox: boots the built app on «Распознавание», screenshots it, then
// presses «Скачать (2 МБ)» (real download from the pinned snakers4 URL + SHA-256 check), waits and
// screenshots again; finally unticks the checkbox and prints the saved setting.
// Usage: CHAWO_LOCALAPPDATA=… CHAWO_APPDATA=… electron --no-sandbox scripts/smoke-vad.cjs <shot-prefix>
const { app, BrowserWindow } = require('electron');
const { writeFileSync, readFileSync, existsSync } = require('node:fs');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-vad.cjs')) + 1);
const [prefix = 'vad'] = args;
require('../dist/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(() => {
  setTimeout(async () => {
    try {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
      const h = require('electron').ipcMain._invokeHandlers;
      const js = (code) => w.webContents.executeJavaScript(code);
      await js(`document.querySelector('.nav button[data-page="speech"]').click(); true`);
      await wait(800);
      console.log('[smoke] before', JSON.stringify((await h.get('speech:state')({})).vad));
      writeFileSync(`${prefix}-1.png`, (await w.webContents.capturePage()).toPNG());
      const clicked = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('2 МБ') || x.textContent.includes('2 MB')); if (b) b.click(); return !!b; })()`);
      console.log('[smoke] download button', clicked);
      for (let i = 0; i < 60 && !(await h.get('speech:state')({})).vad.onDisk; i++) await wait(500);
      await wait(400);
      console.log('[smoke] after', JSON.stringify((await h.get('speech:state')({})).vad));
      writeFileSync(`${prefix}-2.png`, (await w.webContents.capturePage()).toPNG());
      await js(`(() => { const l = [...document.querySelectorAll('label')].find((x) => x.textContent.includes('VAD')); l.querySelector('input').click(); return true; })()`);
      await wait(400);
      const p = require('node:path').join(process.env.CHAWO_APPDATA, 'ChawoVoiceAssistant', 'settings.json');
      console.log('[smoke] saved VadEnabled', existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).VadEnabled : 'no file');
      writeFileSync(`${prefix}-3.png`, (await w.webContents.capturePage()).toPNG());
    } catch (e) {
      console.log('[smoke]', e.message);
    }
    app.exit(0);
  }, 1500);
});
