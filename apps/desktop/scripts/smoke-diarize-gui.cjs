// Dev-only smoke for speakers + VAD on the «Расшифровка файла» page after the CLI-parity refactor
// (shared fileRanges / applyDiarization / diarizeHook). Boots the built app, turns on «Разделять
// спикеров» and .vtt/.json/.md through the page IPC, queues the WAVs and prints notes and outputs.
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> CHAWO_DIAR_DIR=<diar models> \
//   CHAWO_VAD_MODEL=<silero_vad.onnx> electron --no-sandbox scripts/smoke-diarize-gui.cjs <a.wav> [b.wav…]
const { appEvent } = require('./lib/appEvent.cjs');
const { app, BrowserWindow } = require('electron');
const { copyFileSync, existsSync, readFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-diarize-gui.cjs')) + 1);
require('../out/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

app.whenReady().then(async () => {
  await sleep(1500);
  let code = 0;
  try {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
    const js = (c) => w.webContents.executeJavaScript(c);
    const h = require('electron').ipcMain._invokeHandlers;
    await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
    await sleep(600);
    await h.get('file:options')(appEvent(), { timestamps: true, srt: false, extra: ['vtt', 'json', 'md'], diarize: true });
    const st0 = await h.get('file:state')(appEvent());
    log('diarize status', JSON.stringify(st0.diarize ?? st0.diarizeStatus ?? null));
    const copies = args.map((wav) => {
      const c = join(app.getPath('temp'), 'chawo-smoke-diar-' + basename(wav));
      copyFileSync(wav, c);
      return c;
    });
    await h.get('file:add')(appEvent(), copies, false);
    const t0 = Date.now();
    await h.get('file:run')(appEvent());
    for (let i = 0; i < 2400 && (await h.get('file:state')(appEvent())).busy; i++) await sleep(250);
    const st = await h.get('file:state')(appEvent());
    for (const it of st.items) log('row', JSON.stringify({ name: it.name ?? it.path, state: it.state, note: it.note }));
    log(`${Date.now() - t0} ms`);
    for (const c of copies) {
      for (const ext of ['txt', 'vtt', 'json', 'md']) {
        const p = c.replace(/\.wav$/, '.' + ext);
        if (!existsSync(p)) {
          log(ext, 'MISSING');
          code = 1;
          continue;
        }
        log(`--- ${basename(p)}\n` + readFileSync(p, 'utf8').slice(0, 500));
      }
    }
  } catch (e) {
    console.error('[smoke] FAIL', e);
    code = 1;
  }
  app.exit(code);
});
