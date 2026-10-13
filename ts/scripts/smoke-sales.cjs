// Dev-only smoke for «Продажи»: boots the built app, fills the catalog on the page through the real
// inputs, picks a materials folder (the native dialog is stubbed), switches to Sales mode on the
// Dictation page, holds the in-window button with Chromium's fake mic and reads the sales card
// window; then opens the call stand-in and dictates again; then leaves Sales mode (card hides).
// Usage: CHAWO_LOCALAPPDATA=<dir with models> CHAWO_APPDATA=<tmp> \
//   electron --no-sandbox scripts/smoke-sales.cjs <speech.wav> <materials-dir> [shot-prefix]
const { app, BrowserWindow, dialog } = require('electron');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-sales.cjs')) + 1);
const [wav, materials, shot = ''] = args;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (wav) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [materials] });
require('../dist/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);
app.on('web-contents-created', (_e, wc) => wc.on('console-message', (e) => e.level !== 'info' && console.log('[renderer]', e.level, e.message)));

app.whenReady().then(async () => {
  await sleep(1500);
  try {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html'));
    const js = (code) => w.webContents.executeJavaScript(code);
    const card = () => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('salesCard.html'));
    const readCard = async () => {
      const c = card();
      if (!c || !c.isVisible()) return 'hidden';
      return c.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#card > div')).filter(d => !d.hidden).map(d => d.id + '=' + d.textContent).join(' | ')`);
    };
    const nav = (p) => js(`document.querySelector('.nav button[data-page="${p}"]').click(); true`);
    const type = (sel, value) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); return true; })()`);
    const clickText = (text) => js(`(() => { const b = Array.from(document.querySelectorAll('#page button')).find(b => b.textContent === ${JSON.stringify(text)}); b.click(); return !!b; })()`);

    await nav('sales');
    await sleep(300);
    log('page:', await js(`document.querySelector('#page h1').textContent + ' / ' + document.querySelectorAll('.dict.sales .dict-row:not(.head)').length + ' rows / ' + document.querySelector('.hint').textContent`));
    for (const [code, name, line, similar] of [['RU-1', 'русский язык', 'Курс русского, 12 занятий, 9 900 ₽', 'RU-0'], ['EN-2', 'английский', 'Курс английского', '']]) {
      await clickText('Добавить');
      await sleep(200);
      const n = await js(`document.querySelectorAll('.dict.sales .dict-row:not(.head)').length`);
      const row = `.dict.sales .dict-row:nth-child(${n + 1}) input`;
      await type(`${row}:nth-of-type(1)`, code);
      await type(`${row}:nth-of-type(2)`, name);
      await type(`${row}:nth-of-type(3)`, line);
      await type(`${row}:nth-of-type(4)`, similar);
      await sleep(150);
    }
    await clickText('Выбрать папку');
    await sleep(400);
    log('rag:', await js(`Array.from(document.querySelectorAll('#page fieldset')[0].querySelectorAll('input, .hint')).map(n => n.value ?? n.textContent).join(' | ')`));
    const saved = require('../dist/main/settings.js').load();
    log('saved catalog:', JSON.stringify(saved.SalesCatalog), 'folder:', saved.RagFolder);
    if (shot) writeFileSync(shot + '-page.png', (await w.webContents.capturePage()).toPNG());

    // Dictation mode first: a take does not open the card.
    const hold = async (ms) => {
      await nav('dictation');
      for (let i = 0; i < 80; i++) {
        const st = await js(`document.querySelector('[data-d="status"]')?.textContent ?? ''`);
        if (!/Загружаю|Loading/.test(st)) break;
        await sleep(250);
      }
      const r = JSON.parse(await js(`JSON.stringify(document.querySelector('[data-d="hold"]').getBoundingClientRect())`));
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + r.height / 2);
      w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      let midCard = 'hidden';
      for (let t = 0; t < ms; t += 250) {
        await sleep(250);
        const c = await readCard();
        if (c !== 'hidden' && midCard === 'hidden') midCard = `${t} ms: ${c}`;
      }
      w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      for (let i = 0; i < 240; i++) {
        await sleep(250);
        const phase = await js(`document.querySelector('[data-d="phase"]').textContent`);
        if (!/слушаю|распознаю|listening|recognizing/i.test(phase)) break;
      }
      return { midCard, last: await js(`document.querySelector('[data-d="last"] .last-text')?.textContent ?? ''`) };
    };

    // Pill off, so only the Sales mode can turn the live drafts on.
    await nav('dictation');
    await sleep(300);
    await w.webContents.executeJavaScript(`window.chawo.dictation.setOverlay(false)`);
    let r = await hold(5000);
    log('Dictation mode take:', JSON.stringify(r), 'card:', await readCard());

    await w.webContents.executeJavaScript(`window.chawo.dictation.setMode('Sales')`);
    r = await hold(5000);
    log('Sales mode take:', JSON.stringify(r));
    log('card after take:', await readCard());
    const c = card();
    if (c) log('card bounds:', JSON.stringify(c.getBounds()), 'focusable:', c.isFocusable(), 'onTop:', c.isAlwaysOnTop());
    if (shot && c) writeFileSync(shot + '-card.png', (await c.webContents.capturePage()).toPNG());

    // Call stand-in: empty manager first, then a full binding.
    await nav('sales');
    await sleep(300);
    const fields = `#page fieldset:nth-of-type(2) .call-row input`;
    await type(`#page fieldset:nth-of-type(2) .call-row label:nth-child(1) input`, '101');
    await clickText('Показать карточку');
    await sleep(300);
    log('stand-in no manager:', await js(`document.querySelectorAll('#page fieldset')[1].querySelector('.hint:last-child').textContent`), '| card:', await readCard());
    await type(`#page fieldset:nth-of-type(2) .call-row label:nth-child(1) input`, '101');
    await type(`#page fieldset:nth-of-type(2) .call-row label:nth-child(2) input`, '+7 900 000-00-00');
    await type(`#page fieldset:nth-of-type(2) .call-row label:nth-child(3) input`, 'Анна');
    await clickText('Показать карточку');
    await sleep(500);
    log('stand-in:', await js(`document.querySelectorAll('#page fieldset')[1].querySelector('.hint:last-child').textContent`), '| card:', await readCard());
    void fields;
    r = await hold(5000);
    log('take during call:', JSON.stringify(r));
    log('card during call:', await readCard());
    if (shot && card()) writeFileSync(shot + '-call.png', (await card().webContents.capturePage()).toPNG());

    // The × on the card hides it and ends the call.
    await card().webContents.executeJavaScript(`document.getElementById('close').click(); true`);
    await sleep(300);
    log('after ×:', await readCard());

    // Leaving Sales mode hides the card.
    r = await hold(4000);
    log('card shown again by a take:', await readCard());
    await w.webContents.executeJavaScript(`window.chawo.dictation.setMode('Dictation')`);
    await sleep(300);
    log('after Dictation mode:', await readCard());
    await nav('sales');
    await sleep(300);
    log('mode note:', await js(`document.querySelectorAll('#page .hint')[0].textContent`));
  } catch (e) {
    log(e.stack || e.message);
  }
  app.exit(0);
});
