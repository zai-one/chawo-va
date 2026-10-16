// Dev-only smoke for «Запись встречи» on Linux: needs PulseAudio/PipeWire with a default output
// (its loopback is the «computer sound») and a default input that is not a monitor (Chromium hides
// monitors), e.g. null sinks `speakers` + `micsink` and `module-remap-source master=micsink.monitor`.
// Clicks «Записать встречу», plays <mic.wav> into the mic sink and <system.wav> into the default
// output (paplay), clicks «Остановить и расшифровать», waits for the queue and prints the .txt
// plus per-channel energy of the WAV. Usage:
//   CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> CHAWO_MEETINGS_DIR=<tmp> \
//   electron --no-sandbox scripts/smoke-meeting.cjs <mic.wav> <mic-sink> <system.wav> [shot-prefix]
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-meeting.cjs')) + 1);
const [micWav, micSink, sysWav, shot = ''] = args;
require('../out/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const play = (file, device) => new Promise((r) => spawn('paplay', device ? ['--device=' + device, file] : [file]).on('exit', r));
app.on('web-contents-created', (_e, wc) => wc.on('console-message', (e) => console.log('[renderer]', e.level, e.message)));
app.whenReady().then(async () => {
  await sleep(1500);
  try {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder') ?? BrowserWindow.getAllWindows()[0];
    const js = (code) => w.webContents.executeJavaScript(code);
    const clickText = (t) => js(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(t)}); if (b) b.click(); return !!b; })()`);
    await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
    await sleep(500);
    console.log('[smoke] meeting box:', await js(`document.querySelector('fieldset.meeting')?.innerText`));
    console.log('[smoke] start clicked:', await clickText('Записать встречу'));
    await sleep(1500);
    console.log('[smoke] recording:', await js(`document.querySelector('fieldset.meeting')?.innerText`));
    const live = async (tag) => console.log('[smoke] live ' + tag + ':', await js(`document.querySelector('fieldset.meeting .rec')?.textContent`));
    let p = play(micWav, micSink);
    await sleep(2000);
    await live('mic clip');
    await p;
    await sleep(500);
    p = play(sysWav, '');
    await sleep(2000);
    await live('computer clip');
    if (shot) writeFileSync(shot + '-rec.png', (await w.webContents.capturePage()).toPNG());
    await p;
    await sleep(800);
    console.log('[smoke] stop clicked:', await clickText('Остановить и расшифровать'));
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      const st = await js(`Array.from(document.querySelectorAll('.queue .item')).map(i => i.className).join(',')`);
      if (st && !/queued|running/.test(st)) break;
    }
    console.log('[smoke] queue:', await js(`document.querySelector('.queue').innerText`));
    console.log('[smoke] note:', await js(`document.querySelector('fieldset.meeting')?.innerText`));
    if (shot) writeFileSync(shot + '-done.png', (await w.webContents.capturePage()).toPNG());
    const dir = process.env.CHAWO_MEETINGS_DIR;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (f.endsWith('.txt')) console.log('[smoke] txt', f, '\n' + readFileSync(p, 'utf8'));
      if (f.endsWith('.wav')) {
        const d = readFileSync(p);
        const n = Math.floor((d.length - 44) / 4);
        let el = 0, er = 0;
        for (let i = 0; i < n; i++) {
          const l = d.readInt16LE(44 + 4 * i) / 32768, r = d.readInt16LE(46 + 4 * i) / 32768;
          el += l * l; er += r * r;
        }
        // Which channel is loud per half: the mic clip plays first, the computer clip second.
        const half = (a, b, ch) => { let e = 0; for (let i = a; i < b; i++) { const v = d.readInt16LE(44 + 4 * i + 2 * ch) / 32768; e += v * v; } return Math.sqrt(e / Math.max(1, b - a)).toFixed(4); };
        console.log('[smoke] wav', f, 'ch', d.readUInt16LE(22), 'rate', d.readUInt32LE(24), 'sec', (n / 16000).toFixed(1),
          'rms L', Math.sqrt(el / n).toFixed(4), 'R', Math.sqrt(er / n).toFixed(4),
          '| first half L/R', half(0, n >> 1, 0), half(0, n >> 1, 1), '| second half L/R', half(n >> 1, n, 0), half(n >> 1, n, 1));
      }
    }
  } catch (e) {
    console.log('[smoke]', e.stack || e.message);
  }
  app.exit(0);
});
