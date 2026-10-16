// Dev-only smoke for Hermes + the «Сеть» page + the Client role. Boots the built app as Host:
// GET /v1/health and POST a WAV to its own Hermes on 127.0.0.1:17831, switches to the whole LAN
// (the yes/no box is auto-answered), then starts a second Hermes on 127.0.0.1:17832 inside this
// process backed by a real Recognizer, flips the app to Client pointing at it, transcribes a file
// through the queue and holds the in-window button with Chromium's fake mic. Prints what it sees.
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-network.cjs <speech.wav> <file.wav> [shot-prefix]
const { app, BrowserWindow, dialog } = require('electron');
const { copyFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-network.cjs')) + 1);
const [micWav, fileWav, shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (micWav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', micWav);
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
require('../dist/main/main.js');
const RemoteSpeech = require('../dist/main/network/remoteSpeech.js');
const { HermesServer } = require('../dist/main/network/hermesServer.js');
const { makeHermesTranscribe } = require('../dist/main/network/hermesTranscribe.js');
const { Recognizer } = require('../dist/core/recognizer.js');
const { findComplete } = require('../dist/main/models/index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);
app.on('web-contents-created', (_e, wc) => wc.on('console-message', (e) => e.level !== 'info' && console.log('[renderer]', e.level, e.message)));

app.whenReady().then(async () => {
  await sleep(1500);
  let peer = null;
  try {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
    const js = (code) => w.webContents.executeJavaScript(code);
    const h = require('electron').ipcMain._invokeHandlers;
    const nav = async (page) => {
      await js(`document.querySelector('.nav button[data-page="${page}"]').click(); true`);
      await sleep(600);
    };

    // 1) Host: our own Hermes on 127.0.0.1.
    const local = { RemoteHost: '127.0.0.1', RemotePort: 17831 };
    log('health', JSON.stringify(await (await fetch('http://127.0.0.1:17831/v1/health')).json()));
    log('check', await RemoteSpeech.check(local));
    const t0 = Date.now();
    log('POST', JSON.stringify(await RemoteSpeech.transcribeBytes(local, readFileSync(fileWav), 'audio/wav')), `${Date.now() - t0} ms`);
    await nav('network');
    log('host page', await js(`document.querySelector('main').innerText.replace(/\\n+/g, ' | ')`));
    if (shot) writeFileSync(shot + '-host.png', (await w.webContents.capturePage()).toPNG());

    // 2) The whole LAN (yes/no auto-answered).
    await h.get('network:lan')({});
    const st = await h.get('network:state')({});
    log('lan status', st.host.status);
    const ip = (st.host.status.match(/http:\/\/(\d+\.\d+\.\d+\.\d+):17831/) || [])[1];
    if (ip) log('health via', ip, JSON.stringify(await (await fetch(`http://${ip}:17831/v1/health`)).json()));
    await sleep(300);
    if (shot) writeFileSync(shot + '-lan.png', (await w.webContents.capturePage()).toPNG());
    await h.get('network:lan')({});
    log('back to', (await h.get('network:state')({})).host.status);

    // 3) A second "machine": Hermes on 17832 with its own real recognizer.
    const dir = findComplete('v3_e2e_rnnt');
    const rec = await Recognizer.open(dir, 'v3_e2e_rnnt', 'cpu', 0);
    peer = new HermesServer(17832, makeHermesTranscribe({ current: () => rec, modelName: () => 'V3E2eRnnt' }), false);
    await peer.start();

    // 4) This app becomes a client of it.
    await h.get('network:role')({}, 'Client');
    await h.get('network:remote')({}, '127.0.0.1', '17832');
    await h.get('network:check')({});
    await sleep(200);
    log('client page', await js(`document.querySelector('main').innerText.replace(/\\n+/g, ' | ')`));
    log('speech status', (await h.get('speech:state')({})).status);
    if (shot) writeFileSync(shot + '-client.png', (await w.webContents.capturePage()).toPNG());

    // File through the queue → the host.
    const copy = join(app.getPath('temp'), 'chawo-smoke-remote.wav');
    copyFileSync(fileWav, copy);
    await h.get('file:options')({}, { timestamps: true, srt: false });
    await h.get('file:add')({}, [copy], false);
    await h.get('file:run')({});
    for (let i = 0; i < 240 && (await h.get('file:state')({})).busy; i++) await sleep(250);
    const fs = await h.get('file:state')({});
    log('file status', fs.status);
    const txt = copy.replace(/\.wav$/, '.txt');
    log('file txt', existsSync(txt) ? JSON.stringify(readFileSync(txt, 'utf8').slice(0, 200)) : '(none)');

    // Dictation take with the fake mic → the host.
    await nav('dictation');
    const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(6000);
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
      if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
    }
    log('dictation status', await js(`document.querySelector('[data-d="status"]').textContent`));
    log('dictation last', await js(`document.querySelector('[data-d="last"] .last-text')?.textContent ?? ''`));
    log('clipboard', await require('electron').clipboard.readText());
    if (shot) writeFileSync(shot + '-take.png', (await w.webContents.capturePage()).toPNG());

    // 5) Host gone → short error on a take.
    await peer.dispose();
    peer = null;
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(2500);
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(1500);
    log('host down status', await js(`document.querySelector('[data-d="status"]').textContent`));
    log('own hermes while client', await fetch('http://127.0.0.1:17831/v1/health').then(() => 'up', () => 'down'));
    await h.get('network:role')({}, 'Host');
    await sleep(300);
    log('own hermes after Host', await fetch('http://127.0.0.1:17831/v1/health').then(() => 'up', () => 'down'));
  } catch (e) {
    log(e.stack || e.message);
  }
  await peer?.dispose();
  app.exit(0);
});
