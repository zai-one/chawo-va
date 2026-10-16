// Dev-only smoke for «Расшифровать по ссылке». Boots the built app, downloads the real yt-dlp
// (button path: GitHub release + SHA2-256SUMS), serves a Russian MP3 from 127.0.0.1 and pastes its
// link (yt-dlp generic extractor → Downloads/Chawo → local queue → .txt), refuses a file:// link,
// optionally fetches a public video link too. Prints what it sees.
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-url.cjs <speech.mp3> <downloads dir> [public url] [shot.png]
const { app, BrowserWindow } = require('electron');
const { createReadStream, existsSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-url.cjs')) + 1);
const [mp3, downloads, publicUrl = '', shot = ''] = args;
app.setPath('downloads', downloads);
require('../out/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);
app.on('web-contents-created', (_e, wc) => wc.on('console-message', (e) => e.level !== 'info' && console.log('[renderer]', e.level, e.message)));

app.whenReady().then(async () => {
  await sleep(1500);
  const server = http.createServer((req, res) => {
    if (req.url !== '/lecture.mp3') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': statSync(mp3).size });
    createReadStream(mp3).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
    const js = (code) => w.webContents.executeJavaScript(code);
    const h = require('electron').ipcMain._invokeHandlers;
    await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
    await sleep(600);
    let st = await h.get('file:state')({});
    log('before', JSON.stringify(st.url));

    const t0 = Date.now();
    await h.get('file:ytdlpDownload')({});
    for (let i = 0; i < 600 && (await h.get('file:state')({})).url.busy; i++) await sleep(250);
    st = await h.get('file:state')({});
    log('yt-dlp', st.status, `${Date.now() - t0} ms`, JSON.stringify(st.url));

    await h.get('file:url')({}, 'file:///etc/passwd');
    await sleep(100);
    log('file:// →', (await h.get('file:state')({})).status);

    const waitQueue = async () => {
      await sleep(300);
      for (let i = 0; i < 1200 && (await h.get('file:state')({})).busy; i++) await sleep(250);
      return h.get('file:state')({});
    };
    const t1 = Date.now();
    await h.get('file:url')({}, `http://127.0.0.1:${port}/lecture.mp3`);
    st = await waitQueue();
    const item = st.items.at(-1);
    log('local link', `${Date.now() - t1} ms`, item?.state, item?.path, item?.note, '|', st.status);
    if (item?.outputPath && existsSync(item.outputPath)) log('txt', JSON.stringify(readFileSync(item.outputPath, 'utf8').slice(0, 300)));

    if (publicUrl) {
      const t2 = Date.now();
      await js(`(() => { const i = document.getElementById('file-url'); i.value = ${JSON.stringify(publicUrl)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`);
      st = await waitQueue();
      const it = st.items.at(-1);
      log('public link', `${Date.now() - t2} ms`, it?.state, it?.path, it?.note, '|', st.status);
      if (it?.outputPath && existsSync(it.outputPath)) log('txt', JSON.stringify(readFileSync(it.outputPath, 'utf8').slice(0, 200)));
    }
    await sleep(300);
    log('page', await js(`document.querySelector('main').innerText.replace(/\\n+/g, ' | ')`));
    if (shot) writeFileSync(shot, (await w.webContents.capturePage()).toPNG());
  } catch (e) {
    log(e.stack || e.message);
  }
  server.close();
  app.exit(0);
});
