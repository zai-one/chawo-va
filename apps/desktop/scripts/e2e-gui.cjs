// End-to-end GUI pass for scripts/e2e-smoke.cjs (run under xvfb on Linux CI / the box).
// Boots the built app with the env the orchestrator prepared (temp CHAWO_APPDATA / CHAWO_LOCALAPPDATA,
// settings.json with the Brain on a fake 127.0.0.1 server, seeded history), then:
//   every nav page renders (no «в разработке» stub), the window is dark, every *:state IPC answers,
//   history finds the seeded entry, «Кратко и задачи» / «Перевести» go through the fake Brain,
//   the transcript editor opens a timed transcript, and — when a speech model was provided —
//   a real file transcription through the queue writes a .txt with text.
// Renderer console errors, uncaught exceptions, preload errors and crashed renderers fail the pass.
// Writes a JSON report: { checks: [{ name, ok, skip?, detail }] } and quits.
// Usage: electron --no-sandbox scripts/e2e-gui.cjs <report.json> <work dir> [speech audio] [shots dir]
const { app, BrowserWindow, clipboard, ipcMain } = require('electron');
const { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('e2e-gui.cjs')) + 1);
const [reportPath, work, audio = '', shots = ''] = args;
const checks = [];
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A screenshot is a side artifact, never a check. Electron 44 under xvfb can refuse the first capture
// (UnknownVizError) before the compositor has a frame: ask for a repaint and try again.
async function capture(wc) {
  for (let i = 0; ; i++) {
    try {
      return await wc.capturePage();
    } catch (e) {
      if (i >= 4) throw e;
      wc.invalidate();
      await sleep(400);
    }
  }
}
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 600) });
  console.log(`[e2e-gui] ${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const step = (what) => console.log(`[e2e-gui] … ${what}`);
const skip = (name, detail) => checks.push({ name, ok: true, skip: true, detail });

process.on('uncaughtException', (e) => problems.push('main uncaughtException: ' + (e?.stack ?? e)));
process.on('unhandledRejection', (e) => problems.push('main unhandledRejection: ' + (e?.stack ?? e)));
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (e) => {
    if (e.level === 'error') problems.push(`renderer console error: ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  wc.on('preload-error', (_ev, p, err) => problems.push(`preload error ${p}: ${err.message}`));
  wc.on('render-process-gone', (_ev, d) => problems.push(`renderer gone: ${d.reason}`));
});

require('../out/main/main.js');

async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

function finish(code) {
  writeFileSync(reportPath, JSON.stringify({ checks, problems }, null, 2));
  app.exit(code);
}

app.whenReady().then(async () => {
  const hardStop = setTimeout(() => {
    check('gui: finished within the time limit', false, 'gave up after 6 min; last steps: ' + checks.slice(-2).map((c) => c.name).join(', '));
    finish(1);
  }, 6 * 60_000);
  try {
    const w = await waitFor(() => BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'decoder' && !x.isDestroyed()), 20_000);
    check('gui: main window opens', w, w ? w.getTitle() : 'no window in 20 s');
    if (!w) return finish(1);
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once('did-finish-load', r));
    await sleep(800);
    const js = (c) => w.webContents.executeJavaScript(c);
    const h = ipcMain._invokeHandlers;
    const call = async (ch, ...a) => {
      const fn = h.get(ch);
      if (!fn) throw new Error('no IPC handler ' + ch);
      // A handler that never answers (e.g. a modal dialog nobody can click) fails its check instead of the run.
      let timer;
      const late = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${ch}: no answer in 90 s (a dialog?)`)), 90_000)));
      try {
        return await Promise.race([fn({ sender: w.webContents }, ...a), late]);
      } finally {
        clearTimeout(timer);
      }
    };
    check('gui: title says Chawo', /Chawo/i.test(w.getTitle()), w.getTitle());

    // Dark only: the page background must be dark (relative luminance well below mid-grey).
    const bg = await js(`(() => { const c = getComputedStyle(document.body).backgroundColor; const m = c.match(/\\d+(\\.\\d+)?/g) || []; return { c, rgb: m.slice(0, 3).map(Number) }; })()`);
    const lum = bg.rgb.length === 3 ? (0.2126 * bg.rgb[0] + 0.7152 * bg.rgb[1] + 0.0722 * bg.rgb[2]) / 255 : 1;
    check('gui: dark theme (body background)', lum < 0.25, `${bg.c} luminance ${lum.toFixed(2)}`);

    // Every page in the nav renders real content.
    const pages = await js(`Array.from(document.querySelectorAll('.nav button')).map((b) => b.dataset.page)`);
    check('gui: nav has pages', pages.length >= 8, pages.join(', '));
    if (shots) mkdirSync(shots, { recursive: true });
    for (const p of pages) {
      await js(`document.querySelector('.nav button[data-page="${p}"]').click(); true`);
      await sleep(700);
      const info = await js(`(() => { const pg = document.getElementById('page'); const h1 = pg.querySelector('h1'); return { kids: pg.children.length, h1: h1 ? h1.textContent : '', stub: /в разработке|is in progress/.test(pg.textContent), active: document.querySelector('.nav button.active')?.dataset.page }; })()`);
      check(`gui: page «${p}» renders`, info.kids > 0 && info.h1 && !info.stub && info.active === p, JSON.stringify(info));
      if (shots) writeFileSync(join(shots, `page-${p}.png`), (await capture(w.webContents)).toPNG());
    }

    // Every *:state handler answers with an object.
    for (const ch of ['file:state', 'meeting:state', 'speech:state', 'dict:state', 'dictation:state', 'history:state', 'ask:state', 'sales:state', 'network:state']) {
      try {
        const st = await call(ch);
        check(`gui: IPC ${ch}`, st && typeof st === 'object', Object.keys(st ?? {}).slice(0, 8).join(','));
      } catch (e) {
        check(`gui: IPC ${ch}`, false, e.message);
      }
    }
    try {
      const st = await call('brain:state', true);
      check('gui: IPC brain:state', st && typeof st === 'object', Object.keys(st ?? {}).slice(0, 8).join(','));
    } catch (e) {
      check('gui: IPC brain:state', false, e.message);
    }

    // «Контекст для Мозга»: off by default, two compact checkboxes on the «Мозг» page, a click turns one on.
    try {
      let st = await call('brain:state');
      const off = st.context && st.context.visible && !st.context.clipboard && !st.context.app;
      await js(`document.querySelector('.nav button[data-page="brain"]').click(); true`);
      await sleep(600);
      const ui = await js(`(() => { const c = document.getElementById('brain-context-clipboard'); const a = document.getElementById('brain-context-app'); return c && a ? { c: c.checked, a: a.checked } : null; })()`);
      await js(`document.getElementById('brain-context-clipboard').click(); true`);
      await sleep(600);
      st = await call('brain:state');
      const on = st.context.clipboard && !st.context.app && st.context.warning === '';
      const after = await js(`document.getElementById('brain-context-clipboard')?.checked ?? null`);
      if (shots) writeFileSync(join(shots, 'brain-context.png'), (await capture(w.webContents)).toPNG());
      st = await call('brain:context', { clipboard: false });
      check('gui: «Контекст для Мозга» opt-in checkboxes', off && ui && !ui.c && !ui.a && on && after === true && !st.context.clipboard, JSON.stringify({ off, ui, on, after }));
    } catch (e) {
      check('gui: «Контекст для Мозга» opt-in checkboxes', false, e.message);
    }

    // «Прогнать через мозг» on the file page: the real clipboard goes in only with the switch on.
    try {
      const FileBrain = require('../out/main/packages/engine/src/brain/fileBrain.js');
      const SettingsM = require('../out/main/packages/engine/src/settings.js');
      const saved = await clipboard.readText();
      await clipboard.writeText('E2E Зюйд-Вест');
      await call('brain:context', { clipboard: false });
      const off = await FileBrain.fileBrainContext(SettingsM.load(), () => clipboard.readText());
      await call('brain:context', { clipboard: true });
      const on = await FileBrain.fileBrainContext(SettingsM.load(), () => clipboard.readText());
      await call('brain:context', { clipboard: false });
      await clipboard.writeText(saved);
      check('gui: file-page Brain context = clipboard only when on', off === '' && on.includes('<context>') && on.includes('E2E Зюйд-Вест') && !on.includes('Program:'), JSON.stringify({ off, on: on.slice(-60) }));
    } catch (e) {
      check('gui: file-page Brain context = clipboard only when on', false, e.message);
    }

    // History: the seeded take is found by a search word (ё = е), same as `chawo-va history`.
    try {
      const st = await call('history:query', 'еж');
      const text = JSON.stringify(st);
      check('gui: history finds the seeded take', text.includes('Ёжик') && !text.includes('Совещание в пятницу'), text.slice(0, 300));
      await call('history:query', '');
    } catch (e) {
      check('gui: history finds the seeded take', false, e.message);
    }

    // «Спросить историю» on the History page: type, click «Спросить», the answer and its source show up.
    try {
      await js(`document.querySelector('.nav button[data-page="history"]').click(); true`);
      await sleep(800);
      await js(`(() => { const q = document.querySelector('[data-ask="q"]'); q.value = 'что обещали Иванову?'; q.dispatchEvent(new Event('input')); document.querySelector('[data-ask="run"]').click(); return true; })()`);
      let ui = null;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        ui = await js(`(() => ({ answer: document.querySelector('[data-ask="answer"]')?.textContent ?? '', sources: Array.from(document.querySelectorAll('.ask-ex summary')).map((s) => s.textContent), status: document.querySelector('[data-ask="status"]')?.textContent ?? '' }))()`);
        if (ui.answer) break;
      }
      if (shots) writeFileSync(join(shots, 'history-ask.png'), (await capture(w.webContents)).toPNG());
      check('gui: «Спросить историю» answers with a cited transcript', /скидку 10%/.test(ui.answer) && ui.sources.some((x) => x.includes('встреча-иванов.txt')), JSON.stringify(ui));
      const st = await call('ask:history', false);
      check('gui: ask state (dictation toggle, meetings folder)', st.useHistory === false && st.meetingFolders.length === 1, JSON.stringify({ u: st.useHistory, m: st.meetingFolders }));
      await call('ask:history', true);
    } catch (e) {
      check('gui: «Спросить историю» answers with a cited transcript', false, e.message);
    }

    // «История» → «Исправить» twice with the same word fix → «Словарь» → «Из исправлений» offers it → «В словарь».
    try {
      await js(`document.querySelector('.nav button[data-page="history"]').click(); true`);
      await sleep(600);
      const fixRow = async (orig, next) => {
        const ok = await js(`(() => { const it = Array.from(document.querySelectorAll('.hist-item')).find((x) => x.querySelector('.hist-text')?.textContent === ${JSON.stringify(orig)}); if (!it) return false; it.querySelector('[data-history="fix"]').click(); const a = it.querySelector('[data-history="edit"]'); a.value = ${JSON.stringify(next)}; it.querySelector('[data-history="save"]').click(); return true; })()`);
        await sleep(600);
        return ok;
      };
      const a1 = await fixRow('Лес в тумане.', 'Лес в Tumanne.');
      const a2 = await fixRow('Поле в тумане.', 'Поле в Tumanne.');
      const status = await js(`document.querySelector('[data-history="status"]').textContent`);
      check('gui: «История» → «Исправить» saves and learns the fix', a1 && a2 && /тумане → Tumanne/.test(status), status);
      await js(`document.querySelector('.nav button[data-page="dictionary"]').click(); true`);
      await sleep(600);
      const offered = await js(`document.querySelector('[data-dict="learned"]')?.textContent ?? ''`);
      if (shots) {
        await js(`document.querySelector('[data-dict="learned"]').scrollIntoView({ block: 'center' }); true`);
        await sleep(300);
        writeFileSync(join(shots, 'dictionary-learned.png'), (await capture(w.webContents)).toPNG());
      }
      await js(`document.querySelector('[data-dict="learnAccept"]').click(); true`);
      await sleep(600);
      const st = await call('dict:state');
      const cliName = 'gui: a row accepted in the CLI (`dictionary accept`) reaches «Словарь»';
      if (process.env.CHAWO_E2E_CLI_RAN === '1') check(cliName, st.rows.some((r) => r.from === 'гигачад' && r.to === 'GigaChad'), JSON.stringify(st.rows).slice(0, 300));
      else skip(cliName, '--no-cli');
      check('gui: «Из исправлений» offers the fix and «В словарь» adds the row',
        offered.includes('Tumanne') && st.rows.some((r) => r.from === 'тумане' && r.to === 'Tumanne') && st.learned.rows.length === 0, offered.slice(0, 300));
      await js(`document.querySelector('[data-dict="learnAuto"]').click(); true`);
      await sleep(500);
      const paths = require('../out/main/packages/engine/src/paths.js');
      const learned = JSON.parse(readFileSync(paths.learnedWordsPath(), 'utf8'));
      check('gui: «Добавлять в словарь сами» saves to learned-words.json', learned.autoAdd === true, JSON.stringify(learned).slice(0, 200));
    } catch (e) {
      check('gui: «Словарь из исправлений»', false, e.message);
    }

    // «Словарь» → «Сниппеты»: add a row through the page UI, it lands in snippets.json; dictation matcher uses it.
    try {
      await js(`document.querySelector('.nav button[data-page="dictionary"]').click(); true`);
      await sleep(500);
      await js(`document.querySelector('[data-dict="snippetAdd"]').click(); true`);
      await sleep(500);
      await js(`(() => { const rows = document.querySelectorAll('.snippet-row'); const r = rows[rows.length - 1]; const i = r.querySelector('input'); const t = r.querySelector('textarea'); i.value = 'подпись'; t.value = 'С уважением,\\nE2E'; i.dispatchEvent(new Event('input')); t.dispatchEvent(new Event('input')); return true; })()`);
      await sleep(700);
      const { loadSnippets, applySnippets } = require('../out/main/packages/core/src/snippets.js');
      const paths = require('../out/main/packages/engine/src/paths.js');
      const list = loadSnippets(paths.snippetsPath());
      const ins = applySnippets('Спасибо, вставь подпись.', list).text;
      check('gui: «Сниппеты» on «Словарь» saves to snippets.json', list.some((x) => x.trigger === 'подпись') && ins.includes('E2E'), `${paths.snippetsPath()} ${JSON.stringify(list)} → ${JSON.stringify(ins)}`);
      await js(`document.querySelector('[data-dict="snippets"]').scrollIntoView(); true`);
      if (shots) writeFileSync(join(shots, 'dictionary-snippets.png'), (await capture(w.webContents)).toPNG());
    } catch (e) {
      check('gui: «Сниппеты» on «Словарь» saves to snippets.json', false, e.message);
    }

    // Transcript editor on a timed transcript (fixture).
    const ed = join(work, 'gui-editor');
    mkdirSync(ed, { recursive: true });
    const fix = join(__dirname, '..', '..', '..', 'fixtures', 'transcript-editor');
    for (const n of ['sample.wav', 'sample.srt', 'sample.txt']) copyFileSync(join(fix, n), join(ed, n));
    try {
      await call('file:add', [join(ed, 'sample.wav')], false);
      const st = await call('file:openEditor', join(ed, 'sample.txt'));
      check('gui: transcript editor opens', st.editor?.available && st.editor.segments?.length >= 3, `segments ${st.editor?.segments?.length}`);
      await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
      await sleep(600);
      const rows = await js(`document.querySelectorAll('.transcript-editor .phrase').length`);
      check('gui: transcript editor shows phrases', rows >= 3, `${rows} rows`);
      // Double-click a phrase → fix it → the .txt and .srt beside it change, the note says so.
      await js(`(() => { const r = document.querySelectorAll('.transcript-editor .phrase')[2]; r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); const i = document.querySelector('[data-editor="phraseEdit"]'); i.value = 'Третья без Speakera'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`);
      await sleep(800);
      const note = await js(`document.querySelector('[data-editor="note"]')?.textContent ?? ''`);
      const tTxt = readFileSync(join(ed, 'sample.txt'), 'utf8');
      const tSrt = readFileSync(join(ed, 'sample.srt'), 'utf8');
      check('gui: transcript editor phrase fix writes .txt/.srt and learns', tTxt.includes('Третья без Speakera') && tSrt.includes('Третья без Speakera') && !tTxt.includes('без спикера') && /Исправлено в 2/.test(note), note + ' | ' + tTxt.slice(0, 200));
    } catch (e) {
      check('gui: transcript editor opens', false, e.message);
    }
    // «Статистика разговора» for the same transcript: talk bars, trackers; edit trackers through the page.
    try {
      let st = await call('file:state');
      const okState = st.callStats?.stats?.diarized === true && st.callStats.stats.speakers.length >= 2 && st.callStats.trackers.includes('Цена');
      await js(`(() => { const a = document.querySelector('[data-stats="trackers"]'); a.value = 'Тест: фраз*'; a.dispatchEvent(new Event('change')); return true; })()`);
      await sleep(700);
      st = await call('file:state');
      const tr = st.callStats?.stats?.trackers ?? [];
      const okTrack = tr.length === 1 && tr[0].name === 'Тест' && tr[0].count === 1;
      const ui = await js(`(() => ({ bars: document.querySelectorAll('.call-stats .talk-row').length, tracker: !!document.querySelector('.call-stats [data-tracker="Тест"]'), legend: document.querySelector('.call-stats legend')?.textContent }))()`);
      const Settings = require('../out/main/packages/engine/src/settings.js');
      const saved = Settings.load ? Settings.load().CallTrackers : null;
      if (shots) {
        await js(`(() => { document.querySelectorAll('.call-stats details').forEach((d) => { d.open = true; }); document.querySelector('.call-stats').scrollIntoView(); return true; })()`);
        await sleep(200);
        writeFileSync(join(shots, 'file-call-stats.png'), (await capture(w.webContents)).toPNG());
      }
      st = await call('file:callTrackers', '');
      const okReset = st.callStats.trackers === st.callStats.defaultTrackers;
      check('gui: «Статистика разговора» (talk ratio, trackers, edit, reset)', okState && okTrack && okReset && ui.bars >= 2 && ui.tracker && (saved === null || saved === 'Тест: фраз*'), JSON.stringify({ okState, okTrack, okReset, ui, saved }));
    } catch (e) {
      check('gui: «Статистика разговора» (talk ratio, trackers, edit, reset)', false, e.message);
    }

    // «Автоопределение встречи»: off by default; enabling shows apps/calendar; stub offer via meeting:state fields.
    try {
      let st = await call('meeting:state');
      const off = st.autoDetect === false && st.offer === null;
      await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
      await sleep(500);
      const before = await js(`(() => { const c = document.getElementById('meeting-auto-detect'); return c ? { checked: c.checked, appsShown: !!document.getElementById('meeting-auto-apps'), calShown: !!document.getElementById('meeting-auto-cal') } : null; })()`);
      await js(`document.getElementById('meeting-auto-detect').click(); true`);
      await sleep(600);
      st = await call('meeting:state');
      const on = st.autoDetect === true;
      const after = await js(`(() => ({ checked: document.getElementById('meeting-auto-detect')?.checked, appsShown: !!document.getElementById('meeting-auto-apps'), calShown: !!document.getElementById('meeting-auto-cal') }))()`);
      if (shots) {
        await js(`document.querySelector('fieldset.meeting')?.scrollIntoView(); true`);
        await sleep(200);
        writeFileSync(join(shots, 'file-meeting-detect.png'), (await capture(w.webContents)).toPNG());
      }
      st = await call('meeting:autoDetect', false);
      check('gui: meeting auto-detect opt-in (off by default, shows apps/calendar when on)', off && before && !before.checked && !before.appsShown && on && after && after.checked && after.appsShown && after.calShown && !st.autoDetect, JSON.stringify({ off, before, on, after }));
    } catch (e) {
      check('gui: meeting auto-detect opt-in (off by default, shows apps/calendar when on)', false, e.message);
    }


    // «Кратко и задачи» and «Перевести» through the fake local Brain server (settings by the orchestrator).
    const tx = join(work, 'gui-brain');
    mkdirSync(tx, { recursive: true });
    const txt = join(tx, 'meet.txt');
    writeFileSync(txt, '[00:00:01] Анна подготовит презентацию к понедельнику. Борис проверит смету.\n', 'utf8');
    try {
      step('file:clearFinished');
      await call('file:clearFinished');
      step('file:runBrief');
      const st = await call('file:runBrief', txt);
      const out = join(tx, 'meet.brief.txt');
      check('gui: «Кратко и задачи» via the Brain', existsSync(out) && readFileSync(out, 'utf8').includes('Задачи'), st.status || st.ffmpeg?.line || '');
    } catch (e) {
      check('gui: «Кратко и задачи» via the Brain', false, e.message);
    }
    // «В CRM»: webhook set in «Настройки CRM», «В CRM» on the brief card → preview (no secret) → «Отправить» → mock got it.
    try {
      const crmBase = process.env.CHAWO_E2E_CRM;
      if (!crmBase) throw new Error('no CHAWO_E2E_CRM');
      await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
      await sleep(700);
      await js(`(() => { const d = document.querySelector('[data-crm="settings"]'); d.open = true; d.dispatchEvent(new Event('toggle')); return true; })()`);
      await sleep(300);
      await js(`(() => { const u = document.querySelector('[data-crm="webhook.url"]'); u.value = ${JSON.stringify(crmBase + '/hook')}; const s = document.querySelector('[data-crm="webhook.secret"]'); s.value = 'whsec-E2E-SECRET-0c0c'; document.querySelector('[data-crm="webhook.save"]').click(); return true; })()`);
      await sleep(600);
      const shownSecret = await js(`document.querySelector('[data-crm="webhook.secret"]').value + '|' + document.body.innerText.includes('whsec-E2E')`);
      await js(`document.querySelector('[data-crm="open"]').click(); true`);
      await sleep(600);
      await js(`(() => { const s = document.querySelector('[data-crm="target"]'); s.value = 'webhook'; s.dispatchEvent(new Event('change')); return true; })()`);
      await sleep(500);
      await js(`document.querySelector('[data-crm="preview"]').click(); true`);
      await sleep(600);
      const pv = await js(`document.querySelector('[data-crm="previewText"]')?.textContent ?? ''`);
      check('gui: «В CRM» shows exactly what goes out (no secrets)', pv.includes('/hook') && pv.includes('"tasks"') && !pv.includes('SECRET') && shownSecret === '|false', pv.slice(0, 300));
      if (shots) writeFileSync(join(shots, 'crm-preview.png'), (await capture(w.webContents)).toPNG());
      const before = await (await fetch(crmBase + '/__log')).json();
      await js(`document.querySelector('[data-crm="send"]').click(); true`);
      await sleep(1200);
      const status = await js(`document.querySelector('[data-crm="status"]')?.textContent ?? ''`);
      const after = await (await fetch(crmBase + '/__log')).json();
      const hook = after.slice(before.length).find((g) => g.url === '/hook');
      check('gui: «Отправить» posts the brief to the webhook once, signed', hook && JSON.parse(hook.body).kind === 'brief' && /^sha256=/.test(hook.sig) && after.length === before.length + 1 && /Отправлено|Sent/.test(status), status + ' ' + JSON.stringify(hook ?? {}).slice(0, 200));
    } catch (e) {
      check('gui: «В CRM»', false, e.message);
    }

    // Templates: pick a built-in, save a custom one, the page shows the picker; the Brain gets the template.
    try {
      let st = await call('file:briefTemplate', 'minutes');
      const ok1 = st.brief.template === 'minutes' && st.brief.templates.length >= 4;
      st = await call('file:saveBriefTemplate', 'GUI шаблон', 'Только задачи списком.');
      const ok2 = st.brief.template === 'GUI шаблон' && st.brief.templates.some((x) => x.name === 'GUI шаблон' && !x.builtin);
      await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
      await sleep(600);
      const ui = await js(`(() => { const s = document.querySelector('[data-brief="template"]'); return s ? { value: s.value, n: s.options.length } : null; })()`);
      await call('file:runBrief', txt);
      const okRun = existsSync(join(tx, 'meet.brief.txt'));
      if (shots) {
        await js(`document.querySelector('[data-brief="template"]').scrollIntoView(); true`);
        writeFileSync(join(shots, 'file-brief-templates.png'), (await capture(w.webContents)).toPNG());
      }
      st = await call('file:deleteBriefTemplate', 'GUI шаблон');
      const ok3 = st.brief.template === '' && !st.brief.templates.some((x) => x.name === 'GUI шаблон');
      await call('file:briefTemplate', '');
      check('gui: «Кратко и задачи» templates (pick, save, use, delete)', ok1 && ok2 && ok3 && okRun && ui && ui.value === 'GUI шаблон' && ui.n >= 6, JSON.stringify({ ok1, ok2, ok3, okRun, ui }));
    } catch (e) {
      check('gui: «Кратко и задачи» templates (pick, save, use, delete)', false, e.message);
    }
    // «MCP-сервер» on «Сеть»: off by default, the switch saves McpEnabled, the snippet runs `cli.js mcp`, copy fills the clipboard.
    try {
      const st0 = await call('mcp:state');
      await js(`document.querySelector('.nav button[data-page="network"]').click(); true`);
      await sleep(600);
      const ui0 = await js(`(() => { const c = document.querySelector('[data-mcp="enabled"]'); const box = c && c.closest('fieldset'); return c ? { on: c.checked, boxes: document.querySelectorAll('.mcp-box').length, hidden: !document.querySelector('[data-mcp="snippet"]') } : null; })()`);
      await js(`document.querySelector('[data-mcp="enabled"]').click(); true`);
      await sleep(500);
      const ui1 = await js(`(() => { const p = document.querySelector('[data-mcp="snippet"]'); return p ? { snippet: p.textContent, bg: getComputedStyle(p).backgroundColor, boxes: document.querySelectorAll('.mcp-box').length } : null; })()`);
      const saved = JSON.parse(require('node:fs').readFileSync(require(require('node:path').join(__dirname, '..', 'out/main/packages/engine/src/paths.js')).settingsPath(), 'utf8')).McpEnabled;
      const keep = await clipboard.readText();
      await js(`document.querySelector('[data-mcp="copy"]').click(); true`);
      await sleep(400);
      let snip = null;
      try { snip = JSON.parse(await clipboard.readText()).mcpServers['chawo-va']; } catch { /* checked below */ }
      await clipboard.writeText(keep);
      if (shots) writeFileSync(join(shots, 'network-mcp.png'), (await capture(w.webContents)).toPNG());
      const st1 = await call('mcp:enable', false);
      const dark = ui1 && /rgba?\((\d+), (\d+), (\d+)/.exec(ui1.bg);
      const isDark = dark && Number(dark[1]) + Number(dark[2]) + Number(dark[3]) < 200;
      check('gui: «MCP-сервер» block (opt-in, snippet, copy, dark)', st0.enabled === false && ui0 && !ui0.on && ui0.boxes === 1 && ui0.hidden && ui1 && ui1.boxes === 1 && ui1.snippet.includes('"chawo-va"') && saved === true && snip && snip.args.at(-1) === 'mcp' && snip.env.ELECTRON_RUN_AS_NODE === '1' && isDark && st1.enabled === false, JSON.stringify({ st0: st0.enabled, ui0, ui1, saved, snip, isDark }));
    } catch (e) {
      check('gui: «MCP-сервер» block (opt-in, snippet, copy, dark)', false, e.message);
    }
    // «Проверка по чек-листу»: built-in, save a custom one, the card shows it, score writes .score.json/.txt, delete.
    try {
      let st = await call('file:scoreChecklist', 'sales');
      const ok1 = st.score.checklist === 'sales' && st.score.checklists.length >= 1 && st.score.checklists[0].items.length === 6;
      st = await call('file:saveChecklist', 'GUI чек-лист', '- Поздоровался\n- Назвал цену\n\n- Назвал цену');
      const ok2 = st.score.checklist === 'GUI чек-лист' && st.score.checklists.some((x) => x.name === 'GUI чек-лист' && !x.builtin && x.items.length === 2);
      st = await call('file:saveChecklist', 'sales', 'x');
      const okRefuse = /встроенный|built-in/.test(st.score.note);
      st = await call('file:runScore', txt);
      let sj = null;
      try {
        sj = JSON.parse(readFileSync(join(tx, 'meet.score.json'), 'utf8'));
      } catch {}
      const okRun = sj && sj.max === 2 && sj.score === 1.5 && existsSync(join(tx, 'meet.score.txt')) && st.score.result?.percent === 75;
      await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
      await sleep(600);
      const ui = await js(`(() => { const s = document.querySelector('[data-score="checklist"]'); const box = s && s.closest('fieldset'); return s ? { value: s.value, items: document.querySelector('[data-score="items"]').value, marks: box.querySelectorAll('.score-items li').length, head: box.querySelector('.score-card strong')?.textContent ?? '', bg: getComputedStyle(box.querySelector('textarea')).backgroundColor } : null; })()`);
      if (shots) {
        await js(`(document.querySelector('.call-score .score-card') ?? document.querySelector('.call-score')).scrollIntoView({ block: 'end' }); true`);
        await sleep(400);
        writeFileSync(join(shots, 'file-call-score.png'), (await capture(w.webContents)).toPNG());
      }
      st = await call('file:deleteChecklist', 'GUI чек-лист');
      const ok3 = st.score.checklist === 'sales' && !st.score.checklists.some((x) => x.name === 'GUI чек-лист');
      const dark = ui && /rgb\((\d+), (\d+), (\d+)\)/.exec(ui.bg);
      const okDark = dark && Number(dark[1]) + Number(dark[2]) + Number(dark[3]) < 200;
      check('gui: checklist score (pick, save, refuse built-in name, score, card, delete)', ok1 && ok2 && okRefuse && okRun && ok3 && ui && ui.value === 'GUI чек-лист' && ui.marks === 2 && /75%/.test(ui.head) && okDark, JSON.stringify({ ok1, ok2, okRefuse, okRun, ok3, ui, status: st.ffmpeg?.line }));
    } catch (e) {
      check('gui: checklist score (pick, save, refuse built-in name, score, card, delete)', false, e.message);
    }
    try {
      step('file:runTranslate');
      const st = await call('file:runTranslate', 'de', txt);
      const out = join(tx, 'meet.translate.txt');
      check('gui: «Перевести» via the Brain', existsSync(out) && readFileSync(out, 'utf8').includes('Guten Tag'), st.status || '');
      await call('file:translateTarget', '');
    } catch (e) {
      check('gui: «Перевести» via the Brain', false, e.message);
    }

    // Real transcription through the queue (only with a model + speech audio).
    const hasModel = process.env.CHAWO_E2E_MODEL === '1';
    if (!audio || !existsSync(audio)) skip('gui: transcribe a file in the queue', 'no speech audio given');
    else if (!hasModel) skip('gui: transcribe a file in the queue', 'no speech model on disk');
    else {
      const dir = join(work, 'gui-file');
      mkdirSync(dir, { recursive: true });
      const src = join(dir, 'speech' + (audio.match(/\.[^.]+$/)?.[0] ?? '.wav'));
      copyFileSync(audio, src);
      await call('file:clearFinished');
      await call('file:add', [src], false);
      await call('file:run');
      const done = await waitFor(async () => {
        const st = await call('file:state');
        const it = st.items.find((i) => i.path === src);
        return !st.busy && it && it.state !== 'Queued' && it.state !== 'Running' ? it : null;
      }, 4 * 60_000, 500);
      const out = src.replace(/\.[^.]+$/, '.txt');
      const text = existsSync(out) ? readFileSync(out, 'utf8') : '';
      check('gui: transcribe a file in the queue', done && /[А-Яа-яЁё]{3,}/.test(text), `${done?.state} ${done?.note ?? ''} ${basename(out)}: ${text.slice(0, 160)}`);
      await js(`document.querySelector('.nav button[data-page="file"]').click(); true`);
      await sleep(600);
      // Every queue row keeps its actions (Показать / Слушать / ×) on one line.
      const rows = await js(`Array.from(document.querySelectorAll('.queue .item')).map((r) => { const b = r.getBoundingClientRect(); const acts = Array.from(r.querySelectorAll('button')).map((x) => Math.round(x.getBoundingClientRect().top)); return { h: Math.round(b.height), buttons: acts.length, tops: new Set(acts).size }; })`);
      check('gui: queue rows stay on one line', rows.length > 0 && rows.every((r) => r.h < 48 && r.tops <= 1 && r.buttons >= 1), JSON.stringify(rows));
      if (shots) writeFileSync(join(shots, 'file-done.png'), (await capture(w.webContents)).toPNG());
    }

    check('gui: no renderer / main errors', problems.length === 0, problems.join(' | '));
    clearTimeout(hardStop);
    writeFileSync(reportPath, JSON.stringify({ checks, problems }, null, 2));
    // A normal quit (tray app: app.quit must still end the process — the orchestrator times it).
    app.quit();
  } catch (e) {
    check('gui: driver', false, e?.stack ?? String(e));
    finish(1);
  }
});
