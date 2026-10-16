// Dev-only GUI smoke for «Перевод» on «Расшифровке файла» (IDEAS №15). Boots the built app with a
// temp settings.json whose Brain is a fake OpenAI-compatible server on 127.0.0.1 (started here, so
// nothing leaves the machine), transcribes <audio> with the real speech model, types the target
// language into the field, clicks «Перевести последнюю расшифровку», then prints the card, the
// request's system prompt and name.translate.txt. Usage:
//   CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   xvfb-run electron --no-sandbox scripts/smoke-translate-gui.cjs <audio.wav> [shot.png]
const { appEvent } = require('./lib/appEvent.cjs');
const http = require('node:http');
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { dirname } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-translate-gui.cjs')) + 1);
const [audio, shot = ''] = args;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      return res.end();
    }
    const j = JSON.parse(body);
    seen.push(j);
    const user = j.messages[j.messages.length - 1].content;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[DE] ' + user.split('\n')[0].slice(0, 80) } }] }));
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const Settings = require('../out/main/packages/engine/src/settings.js');
  const { settingsPath } = require('../out/main/packages/engine/src/paths.js');
  const s = Settings.defaults();
  s.Brain = 'Server';
  s.CleanupEndpointUrl = `http://127.0.0.1:${port}/v1`;
  s.CleanupModel = 'fake-local';
  s.StartHintDismissed = true;
  s.Language = 'Russian';
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(Settings.toJsonObject(s), null, 2));

  const { app, BrowserWindow, ipcMain, dialog } = require('electron');
  // A loopback server with a port still counts as «own server» for the confirm (same as WPF
  // HostOf = Authority), so answer «Да» here and log the question instead of a modal under xvfb.
  const questions = [];
  dialog.showMessageBox = async (...a) => {
    const box = a[a.length - 1];
    questions.push(box.message);
    return { response: 0, checkboxChecked: false };
  };
  require('../out/main/main.js');
  app.on('web-contents-created', (_e, wc) => wc.on('console-message', (e) => console.log('[renderer]', e.level, e.message)));
  app.whenReady().then(async () => {
    await sleep(1500);
    try {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
      const js = (code) => w.webContents.executeJavaScript(code);
      const h = ipcMain._invokeHandlers;
      await h.get('file:add')(appEvent(), [audio], false);
      await h.get('file:run')(appEvent());
      for (let i = 0; i < 360 && (await h.get('file:state')(appEvent())).busy; i++) await sleep(500);
      const st = await h.get('file:state')(appEvent());
      console.log('[smoke] transcript:', st.lastOutput, JSON.stringify(st.items.map((x) => x.state)));
      await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
      await sleep(600);
      console.log('[smoke] box before:', JSON.stringify(await js(`document.querySelector('fieldset.translate-box')?.innerText`)));
      console.log('[smoke] datalist options:', await js(`document.querySelectorAll('#translate-langs option').length`));
      await js(`(() => { const i = document.getElementById('translate-to'); i.value = 'немецкий'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true; })()`);
      await sleep(400);
      const clicked = await js(`(() => { const b = Array.from(document.querySelectorAll('fieldset.translate-box button')).find(b => b.textContent === 'Перевести последнюю расшифровку'); if (!b || b.disabled) return false; b.click(); return true; })()`);
      console.log('[smoke] clicked:', clicked);
      for (let i = 0; i < 60; i++) {
        await sleep(250);
        if (!(await h.get('file:state')(appEvent())).translate.busy && seen.length > 0) break;
      }
      await sleep(500);
      const after = await h.get('file:state')(appEvent());
      console.log('[smoke] status:', after.status);
      console.log('[smoke] confirm asked:', JSON.stringify(questions));
      console.log('[smoke] saved TranslateTarget:', JSON.parse(readFileSync(settingsPath(), 'utf8')).TranslateTarget);
      console.log('[smoke] system prompt:', JSON.stringify(seen[0]?.messages?.[0]?.content));
      console.log('[smoke] card:', JSON.stringify(await js(`document.querySelector('.translate-card')?.innerText`)));
      const out = after.translate.path;
      console.log('[smoke] file:', out, existsSync(out) ? JSON.stringify(readFileSync(out, 'utf8')) : 'MISSING');
      if (shot) {
        await js(`document.querySelector('fieldset.translate-box').scrollIntoView({ block: 'center' }); true`);
        await sleep(300);
        writeFileSync(shot, (await w.webContents.capturePage()).toPNG());
      }
      const ok = clicked && out && existsSync(out) && String(seen[0]?.messages?.[0]?.content).includes('into German');
      console.log(ok ? '[smoke] OK' : '[smoke] FAIL');
      server.close();
      app.exit(ok ? 0 : 1);
    } catch (e) {
      console.log('[smoke] error', e.message);
      app.exit(1);
    }
  });
});
