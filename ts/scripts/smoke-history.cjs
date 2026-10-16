// Dev-only smoke for «История»: a fake OpenAI-compatible Brain on 127.0.0.1 (Brain=Server, every take
// off), the built app with Chromium's fake mic fed from a WAV, one hold-to-talk take, then the
// «История» page: the entry, a search, «Копировать», «Мозг заново», a second take with a «Чаво, …»
// command when the WAV has none (via the dictionary), «Не хранить» wiping the file. Prints what it sees.
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   xvfb-run -a electron --no-sandbox scripts/smoke-history.cjs <speech.wav> [hold-ms] [shot-prefix]
const { app, BrowserWindow, clipboard } = require('electron');
const http = require('node:http');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-history.cjs')) + 1);
const [wav, holdMs = '5000', shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

const got = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const j = JSON.parse(body || '{}');
    got.push(j);
    await sleep(400);
    const text = String(j.messages?.[1]?.content ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Мозг: ' + text.slice(0, 60) } }] }));
  });
});

let historyFile = '';
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  const Settings = require('../dist/main/settings.js');
  historyFile = require('../dist/main/historyIpc.js').historyPath();
  const s = Settings.load();
  s.Brain = 'Server';
  s.CleanupEndpointUrl = `http://127.0.0.1:${port}/v1`;
  s.CleanupModel = 'fake';
  s.CleanupApiKey = '';
  s.BrainEveryTake = false;
  s.ShowOverlay = false;
  s.HistoryKeep = 'Week';
  s.Language = 'Russian';
  Settings.save(s);
  require('../dist/main/main.js');
});

app.whenReady().then(async () => {
  await sleep(1500);
  try {
    const main = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder' && x.getTitle() !== 'Chawo');
    const js = (code) => main.webContents.executeJavaScript(code);
    const nav = async (p) => { await js(`document.querySelector('.nav button[data-page="${p}"]').click(); true`); await sleep(500); };
    const pageText = async () => (await js(`document.querySelector('main').innerText`)).replace(/\n+/g, ' | ');
    const take = async () => {
      await nav('dictation');
      for (let i = 0; i < 80; i++) {
        const st = await js(`document.querySelector('[data-d="status"]')?.textContent ?? ''`);
        if (!/Загружаю|Loading/.test(st)) break;
        await sleep(250);
      }
      const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      main.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      main.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await sleep(Number(holdMs));
      main.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      for (let i = 0; i < 240; i++) {
        await sleep(250);
        const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
        if (!/слушаю|распознаю/i.test(phase)) break;
      }
      log('take status:', await js(`document.querySelector('[data-d="status"]').textContent`));
      log('take clipboard:', await clipboard.readText());
    };
    const clickIn = async (label, nth = 0) => {
      const ok = await js(`(() => { const b = [...document.querySelectorAll('.hist-item button')].filter((x) => x.textContent === ${JSON.stringify(label)})[${nth}]; if (!b || b.disabled) return false; b.click(); return true; })()`);
      await sleep(300);
      return ok;
    };

    await take();
    await nav('history');
    log('history page:', await pageText());
    log('file lines:', existsSync(historyFile) ? readFileSync(historyFile, 'utf8').trim().split('\n').length : 0);
    if (shot) writeFileSync(shot + '-1.png', (await main.webContents.capturePage()).toPNG());

    await clipboard.writeText('-');
    log('copy:', await clickIn('Копировать'), JSON.stringify(await clipboard.readText().slice(0, 80)));

    // Search: type a word from the entry, then a word that is not there.
    const word = (await js(`document.querySelector('.hist-text')?.textContent ?? ''`)).split(/\s+/).find((w) => w.length > 4) ?? 'язык';
    const type = async (q) => {
      await js(`(() => { const i = document.querySelector('[data-history="search"]'); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return true; })()`);
      await sleep(500);
      return js(`[document.querySelectorAll('.hist-item').length, document.querySelector('[data-history="count"]').textContent, document.activeElement === document.querySelector('[data-history="search"]')].join(' / ')`);
    };
    log(`search "${word.toUpperCase()}":`, await type(word.toUpperCase()));
    log('search "абракадабра":', await type('абракадабра'), '|', await js(`document.querySelector('.hist .empty')?.textContent ?? ''`));
    await type('');

    await js(`document.activeElement.blur(); true`);
    log('rerun clicked:', await clickIn('Мозг заново'));
    for (let i = 0; i < 40 && got.length === 0; i++) await sleep(100);
    await sleep(900);
    log('brain got:', JSON.stringify(got.map((g) => g.messages?.[1]?.content?.slice(0, 80))));
    log('after rerun:', await pageText());
    log('clipboard:', await clipboard.readText().slice(0, 100));
    if (shot) writeFileSync(shot + '-2.png', (await main.webContents.capturePage()).toPNG());

    await take();
    await nav('history');
    log('entries now:', await js(`document.querySelectorAll('.hist-item').length`));

    // CHAWO_SMOKE_HISTORY_COPY=<path>: keep a copy of the file before the wipe (for `chawo-va history`).
    if (process.env.CHAWO_SMOKE_HISTORY_COPY && existsSync(historyFile)) {
      writeFileSync(process.env.CHAWO_SMOKE_HISTORY_COPY, readFileSync(historyFile));
      log('history copied to', process.env.CHAWO_SMOKE_HISTORY_COPY);
    }
    // «Не хранить»: wipes the file.
    await js(`(() => { const s = document.querySelector('main select'); s.value = 'Off'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(500);
    log('after Off:', await pageText());
    log('file exists:', existsSync(historyFile));
    if (shot) writeFileSync(shot + '-3.png', (await main.webContents.capturePage()).toPNG());
    await take();
    log('file after a take with Off:', existsSync(historyFile));
  } catch (e) {
    log(e.stack || e.message);
  }
  srv.close();
  app.exit(0);
});
