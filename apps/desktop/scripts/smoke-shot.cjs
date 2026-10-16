// Dev-only UI smoke: boots the built app, opens a page, saves a screenshot, quits.
// Usage: [SMOKE_WAIT=1] electron --no-sandbox scripts/smoke-shot.cjs <page> <out.png> [file-to-queue ...]
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-shot.cjs')) + 1);
const [page = 'file', out = 'smoke.png', ...queued] = args;
require('../out/main/main.js');
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
  wc.on('preload-error', (_ev, p, err) => console.log('[preload-error]', p, err.message));
});
app.whenReady().then(() => {
  setTimeout(async () => {
    try {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
      // Private but stable: invoke the registered IPC handlers directly to queue and run.
      const h = require('electron').ipcMain._invokeHandlers;
      if (queued.length && h) {
        await h.get('file:add')({}, queued, false);
        await h.get('file:run')({});
        await new Promise((r) => setTimeout(r, 500));
        // SMOKE_WAIT=1: wait for the queue to finish (up to 3 min) before the screenshot.
        for (let i = 0; process.env.SMOKE_WAIT && i < 360 && (await h.get('file:state')({})).busy; i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (process.env.SMOKE_WAIT) console.log('[smoke] state', JSON.stringify((await h.get('file:state')({})).items));
      }
      await w.webContents.executeJavaScript(`document.querySelector('.nav button[data-page="${page}"]').click(); true`);
      await new Promise((r) => setTimeout(r, 800));
      writeFileSync(out, (await w.webContents.capturePage()).toPNG());
    } catch (e) {
      console.log('[smoke]', e.message);
    }
    app.exit(0);
  }, 1500);
});
