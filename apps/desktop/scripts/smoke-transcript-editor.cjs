// Dev-only smoke for the transcript editor (click a phrase → play from that time).
// Boots the built app, opens «Расшифровка файла», injects a finished transcript via
// file:openEditor (fixture .wav + .srt), asserts phrase rows, seeks via click / currentTime,
// and checks the active highlight. No speech model required.
// Usage: CHAWO_APPDATA=<tmp> electron --no-sandbox scripts/smoke-transcript-editor.cjs [shot.png]
const { appEvent } = require('./lib/appEvent.cjs');
const { app, BrowserWindow } = require('electron');
const { copyFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-transcript-editor.cjs')) + 1);
const [shot = ''] = args;
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

    const dir = join(app.getPath('temp'), 'chawo-smoke-editor');
    mkdirSync(dir, { recursive: true });
    const fix = join(__dirname, '..', '..', '..', 'fixtures', 'transcript-editor');
    for (const name of ['sample.wav', 'sample.srt', 'sample.txt', 'sample.json']) {
      copyFileSync(join(fix, name), join(dir, name));
    }
    const wav = join(dir, 'sample.wav');
    const txt = join(dir, 'sample.txt');

    await h.get('file:add')(appEvent(), [wav], false);
    await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
    await sleep(500);

    const st = await h.get('file:openEditor')(appEvent(), txt);
    log('editor available', st.editor?.available, 'segments', st.editor?.segments?.length, 'media', st.editor?.mediaUrl?.slice?.(0, 40), 'hint', st.editor?.sourceHint, 'audioPath', st.editor?.audioPath);
    if (!st.editor?.available || !st.editor?.mediaUrl || !(st.editor.segments?.length >= 3)) {
      throw new Error('editor state incomplete: ' + JSON.stringify(st.editor));
    }

    await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
    await sleep(600);

    const phraseCount = await js(`document.querySelectorAll('.transcript-editor .phrase').length`);
    log('phrase rows', phraseCount);
    if (phraseCount < 3) throw new Error('expected ≥3 phrase rows, got ' + phraseCount);

    const mediaInfo = await js(`(async () => {
      const a = document.querySelector('.transcript-editor audio.transcript-audio');
      if (!a) return { ok: false, reason: 'no-audio' };
      const wait = () => new Promise((resolve) => {
        if (a.readyState >= 1) return resolve('already');
        const done = (how) => { a.removeEventListener('loadedmetadata', onMeta); a.removeEventListener('error', onErr); resolve(how); };
        const onMeta = () => done('meta');
        const onErr = () => done('error');
        a.addEventListener('loadedmetadata', onMeta);
        a.addEventListener('error', onErr);
        setTimeout(() => done('timeout'), 5000);
        try { a.load(); } catch (_) {}
      });
      const how = await wait();
      return {
        ok: how !== 'error' && how !== 'timeout' && a.readyState >= 1,
        how,
        readyState: a.readyState,
        networkState: a.networkState,
        src: a.currentSrc || a.src,
        err: a.error ? (a.error.code + ':' + a.error.message) : null,
        dur: a.duration,
      };
    })()`);
    log('media', mediaInfo);
    if (!mediaInfo.ok) throw new Error('audio failed to load: ' + JSON.stringify(mediaInfo));

    // Direct seek (same as click handler) once metadata is ready
    await js(`(() => {
      const a = document.querySelector('.transcript-editor audio');
      a.currentTime = 1.0;
      a.dispatchEvent(new Event('timeupdate'));
    })()`);
    await sleep(300);
    let afterSeek = await js(`({ t: document.querySelector('.transcript-editor audio').currentTime, active: [...document.querySelectorAll('.transcript-editor .phrase')].map((r) => r.classList.contains('active')) })`);
    log('after set currentTime=1', afterSeek);
    if (!(afterSeek.t >= 0.9 && afterSeek.t < 1.5)) throw new Error('seek expected ~1s, got ' + afterSeek.t);
    if (!afterSeek.active[1]) throw new Error('second phrase should be active at ~1s');

    // Click third phrase
    await js(`document.querySelectorAll('.transcript-editor .phrase')[2].click(); true`);
    await sleep(400);
    afterSeek = await js(`({ t: document.querySelector('.transcript-editor audio').currentTime, active: [...document.querySelectorAll('.transcript-editor .phrase')].map((r) => r.classList.contains('active')), paused: document.querySelector('.transcript-editor audio').paused })`);
    log('after click phrase 2', afterSeek);
    if (!(afterSeek.t >= 1.9 && afterSeek.t < 2.6)) throw new Error('click seek expected ~2s, got ' + afterSeek.t);
    if (!afterSeek.active[2]) throw new Error('third phrase should be active after click');

    if (shot) {
      await js(`document.querySelector('.transcript-editor').scrollIntoView({ block: 'center' }); true`);
      await sleep(200);
      writeFileSync(shot, (await w.webContents.capturePage()).toPNG());
      log('shot', shot);
    }
    log('OK');
  } catch (e) {
    console.error('[smoke] FAIL', e);
    code = 1;
  }
  app.exit(code);
});
