// Dev-only smoke for «Выгружать модели при простое» (IDEAS №13): picks «Через 5 мин» on «Распознавание»
// with a real <select> change, dictates one take with the fake mic (real model), prints the session line
// and the main-process RSS, waits past the delay, prints them again, then dictates once more (lazy reload).
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-idle.cjs <speech.wav> [wait-ms]
const { app, BrowserWindow } = require('electron');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-idle.cjs')) + 1);
const [wav, waitMs = String(5 * 60_000 + 20_000)] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
require('../dist/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = () => `${Math.round(process.memoryUsage().rss / 1048576)} MB`;
app.whenReady().then(async () => {
  await sleep(1500);
  try {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
    const js = (code) => w.webContents.executeJavaScript(code);
    const speechLine = async () => {
      await js(`document.querySelector('.nav button[data-page="speech"]').click(); true`);
      await sleep(400);
      return js(`document.querySelector('.page p.muted.line')?.textContent ?? document.querySelector('p.muted.line')?.textContent ?? ''`);
    };
    await js(`document.querySelector('.nav button[data-page="speech"]').click(); true`);
    await sleep(400);
    const opts = await js(`(() => { const l = Array.from(document.querySelectorAll('label.block')).find(x => /простое|idle/i.test(x.textContent)); const s = l.nextElementSibling; return JSON.stringify({ label: l.textContent, options: Array.from(s.options).map(o => o.textContent + (o.selected ? ' *' : '')), hint: s.nextElementSibling.textContent }); })()`);
    console.log('[smoke] idle select:', opts);
    await js(`(() => { const l = Array.from(document.querySelectorAll('label.block')).find(x => /простое|idle/i.test(x.textContent)); const s = l.nextElementSibling; s.value = '5'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(500);
    const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.CHAWO_APPDATA, 'ChawoVoiceAssistant', 'settings.json'), 'utf8'));
    console.log('[smoke] saved IdleUnloadMinutes =', saved.IdleUnloadMinutes, '| rss before load', mb());

    const take = async (label) => {
      await js(`document.querySelector('.nav button[data-page="dictation"]').click(); true`);
      await sleep(500);
      const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + r.height / 2);
      const t0 = Date.now();
      w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await sleep(7000);
      w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      for (let i = 0; i < 240; i++) {
        await sleep(250);
        const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
        if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
      }
      console.log(`[smoke] ${label}: ${(Date.now() - t0) / 1000}s press→text |`, await js(`document.querySelector('[data-d="last"] .last-text').textContent`));
    };
    await take('take 1');
    console.log('[smoke] after take 1:', await speechLine(), '| rss', mb());
    await sleep(Number(waitMs));
    if (global.gc) global.gc();
    console.log(`[smoke] after ${Math.round(Number(waitMs) / 1000)}s idle:`, JSON.stringify(await speechLine()), '| rss', mb());
    await take('take 2 (reload)');
    console.log('[smoke] after take 2:', await speechLine(), '| rss', mb());
  } catch (e) {
    console.log('[smoke]', e.stack || e.message);
  }
  app.exit(0);
});
