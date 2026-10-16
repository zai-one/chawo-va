#!/usr/bin/env node
// End-to-end smoke: every `chawo-va` command and the GUI (under xvfb on Linux), on the built app.
//   pnpm e2e                          (build + this script)
//   node scripts/e2e-smoke.cjs [--no-gui] [--no-cli] [--keep] [--verbose] [--shots <dir>]
// Env:
//   CHAWO_SMOKE_MODEL_DIR  folder with the GigaAM v3 RNN-T model (else the app's own download, if any);
//                          without a model the transcription cases are SKIPPED (or fail with CHAWO_SMOKE_REQUIRE_MODEL=1)
//   CHAWO_SMOKE_AUDIO      speech recording (Russian) for the real-text checks; else a fixture tone file
// Everything runs in a temp profile (CHAWO_APPDATA / CHAWO_LOCALAPPDATA / HOME / XDG_CACHE_HOME), the Brain
// is a fake OpenAI-compatible server on 127.0.0.1 — nothing leaves the machine, the real profile is untouched.
// Exit 0 only when every check passed (skips are listed).
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const http = require('node:http');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname, basename, resolve } = require('node:path');

const root = join(__dirname, '..');
const cli = join(root, 'out', 'main', 'cli.js');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : '');
const results = [];
const pass = (name, detail = '') => results.push({ name, status: 'PASS', detail });
const failc = (name, detail = '') => results.push({ name, status: 'FAIL', detail });
const skip = (name, detail = '') => results.push({ name, status: 'SKIP', detail });
const check = (name, ok, detail = '') => (ok ? pass(name, detail) : failc(name, detail));

if (!existsSync(cli)) {
  console.error('e2e: out/main/cli.js is missing — run `pnpm build` first');
  process.exit(1);
}

// ---- where the model lives (resolved before the env is redirected to the temp profile) ----
function realModelDir() {
  if (process.env.CHAWO_SMOKE_MODEL_DIR) return process.env.CHAWO_SMOKE_MODEL_DIR;
  try {
    const store = require(join(root, 'out/main/packages/engine/src/models/speechModelStore.js'));
    return store.findComplete('v3_e2e_rnnt') || '';
  } catch {
    return '';
  }
}
const modelSrc = realModelDir();
const audioSrc = process.env.CHAWO_SMOKE_AUDIO || '';
const fixtures = join(root, '..', '..', 'fixtures', 'transcript-editor');

// ---- temp profile ----
const tmp = mkdtempSync(join(tmpdir(), 'chawo-e2e-'));
const prof = { roaming: join(tmp, 'roaming'), local: join(tmp, 'local'), home: join(tmp, 'home'), cache: join(tmp, 'home', '.cache') };
for (const d of Object.values(prof)) mkdirSync(d, { recursive: true });
const baseEnv = {
  ...process.env,
  CHAWO_APPDATA: prof.roaming,
  // Secrets in the temp profile (secrets.json), never in the user's OS credential store.
  CHAWO_SECRETS: 'file',
  CHAWO_LOCALAPPDATA: prof.local,
  HOME: prof.home,
  USERPROFILE: prof.home,
  XDG_CACHE_HOME: prof.cache,
  XDG_CONFIG_HOME: join(prof.home, '.config'),
  XDG_DATA_HOME: join(prof.home, '.local', 'share'),
  CHAWO_MEETINGS_DIR: join(tmp, 'meetings'),
  ELECTRON_ENABLE_LOGGING: '',
};
delete baseEnv.PISAR_APPDATA;
delete baseEnv.PISAR_LOCALAPPDATA;
delete baseEnv.ORT_DISABLE_TELEMETRY; // the app must set it itself
for (const [k, v] of Object.entries(baseEnv)) if (k.startsWith('CHAWO_') || k.startsWith('XDG_') || k === 'HOME') process.env[k] = v;

const Settings = require(join(root, 'out/main/packages/engine/src/settings.js'));
const Paths = require(join(root, 'out/main/packages/engine/src/paths.js'));

// ---- fake Brain: OpenAI-compatible, deterministic, records what it was asked ----
const asked = [];
function answer(system, user) {
  if (/past dictation and meeting transcripts/.test(system)) return /Иванов/.test(user) ? 'Иванову обещали скидку 10% до пятницы [1].' : 'В отрывках ответа нет.';
  if (/Check whether the agent did each checklist item/.test(system)) {
    // Checklist: item 1 yes with a quote from the call, item 2 partial, the rest no; one invented quote.
    const n = (system.split('Checklist:\n')[1] ?? '').split('\n').filter((l) => /^\d+\. /.test(l)).length;
    const firstWords = user.replace(/\[[0-9:]+\]\s*/g, '').split(/[.!?\n]/)[0].trim();
    const items = Array.from({ length: n }, (_, i) =>
      i === 0 ? { n: 1, verdict: 'yes', quote: firstWords, note: 'есть' } : i === 1 ? { n: 2, verdict: 'partial', quote: 'фраза которой не было', note: 'отчасти' } : { n: i + 1, verdict: 'no', quote: '', note: 'не обсуждали' });
    return '```json\n' + JSON.stringify({ items }) + '\n```';
  }
  if (/Remove only filler words/.test(system)) return user.replace(/\b(ну|вот|э+|типа)\b,?\s*/giu, '');
  if (/key points/.test(system)) return '- Анна готовит презентацию\n- Борис проверяет смету';
  if (/format instruction/i.test(system)) return 'Кратко\n- Созвон по статусу\n\nЗадачи\n- Анна: презентация к понедельнику\n- Борис: проверить смету';
  const into = system.match(/into ([A-Z][a-z]+)/);
  if (into) {
    const word = into[1] === 'German' ? 'Guten Tag' : into[1] === 'English' ? 'Good afternoon' : 'Hola';
    return user
      .split('\n')
      .map((l) => (l.trim() ? l.replace(/^(\s*(\[[0-9:]+\]\s*)?)(.*)$/u, `$1${word}. Anna — Freitag.`) : l))
      .join('\n');
  }
  return user;
}
function fakeBrain() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) return res.writeHead(404).end('{}');
      let j = {};
      try {
        j = JSON.parse(body);
      } catch { /* best effort */ }
      const msgs = j.messages ?? [];
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      const user = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      asked.push({ system: system.slice(0, 120), full: system, auth: req.headers.authorization ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer(system, user) } }] }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
// ---- mock CRM (amoCRM / Bitrix24 / HubSpot / webhook on 127.0.0.1): records every request ----
const CRM_TOKENS = { amo: 'amo-E2E-SECRET-7f3a91', hub: 'pat-E2E-SECRET-hub-55aa', hook: 'whsec-E2E-SECRET-0c0c' };
const crmGot = [];
function crmMock() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/__log') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(crmGot));
      crmGot.push({ url: req.url, auth: req.headers.authorization ?? '', sig: req.headers['x-chawo-signature'] ?? '', key: req.headers['idempotency-key'] ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.includes('/api/v4/')) return res.end(JSON.stringify({ _embedded: { notes: [{ id: 1000 + crmGot.length }] } }));
      if (req.url.includes('/rest/')) return res.end(JSON.stringify({ result: 77 }));
      res.end(JSON.stringify({ id: 'n' + crmGot.length }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// A plain file server for the «link» case (127.0.0.1 only).
function fileServer(file) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/talk.wav') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': statSync(file).size });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function writeSettings(port) {
  const s = Settings.defaults();
  s.Brain = 'Server';
  s.CleanupEndpointUrl = `http://127.0.0.1:${port}/v1`;
  s.CleanupModel = 'fake-local';
  s.Language = 'Russian';
  // Meeting auto-detect fixture: an in-progress .ics event (apps stay off — no Zoom in CI).
  const icsDir = join(tmp, 'ics');
  mkdirSync(icsDir, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const end = new Date(now.getTime() + 60 * 60_000);
  writeFileSync(join(icsDir, 'meet.ics'), `BEGIN:VEVENT\nSUMMARY:E2E Meeting\nDTSTART:${stamp(now)}\nDTEND:${stamp(end)}\nEND:VEVENT\n`);
  s.MeetingAutoDetectCalendar = join(icsDir, 'meet.ics');
  // Apps stay on (default); on Linux the process list is unsupported/empty — calendar still hits.
  mkdirSync(dirname(Paths.settingsPath()), { recursive: true });
  writeFileSync(Paths.settingsPath(), JSON.stringify(Settings.toJsonObject(s), null, 2));
}

function seedHistory() {
  const { HistoryStore } = require(join(root, 'out/main/packages/engine/src/history/historyStore.js'));
  const store = new HistoryStore(Paths.databasePath());
  const now = Date.now();
  // Two older takes for «Исправить» → «Словарь из исправлений» in the GUI pass (same fix twice).
  store.add({ raw: 'Лес в тумане', final: 'Лес в тумане.', command: null, brain: false, brainFailed: false, seconds: 1.0, ts: now - 120_000 }, 'Week');
  store.add({ raw: 'Поле в тумане', final: 'Поле в тумане.', command: null, brain: false, brainFailed: false, seconds: 1.0, ts: now - 90_000 }, 'Week');
  store.add({ raw: 'ну Совещание в пятницу', final: 'Совещание в пятницу.', command: null, brain: true, brainFailed: false, seconds: 2.3, ts: now - 60_000 }, 'Week');
  store.add({ raw: 'Ёжик в тумане', final: 'Ёжик в тумане.', command: null, brain: false, brainFailed: false, seconds: 1.1, ts: now - 30_000 }, 'Week');
  // A finished meeting transcript for «Спросить историю» (CLI `ask` and the History page).
  const meetings = process.env.CHAWO_MEETINGS_DIR;
  mkdirSync(meetings, { recursive: true });
  writeFileSync(join(meetings, 'встреча-иванов.txt'), '[00:01:00] Иванову обещали скидку 10% до пятницы.\n[00:02:00] Потом обсудили погоду.\n', 'utf8');
}

function installModel() {
  if (!modelSrc || !existsSync(modelSrc)) return false;
  const dst = Paths.modelDirectory('v3_e2e_rnnt');
  mkdirSync(dirname(dst), { recursive: true });
  try {
    symlinkSync(modelSrc, dst, 'junction');
  } catch {
    mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(modelSrc)) copyFileSync(join(modelSrc, f), join(dst, f));
  }
  return true;
}

// Async on purpose: the fake Brain lives in this process, so a blocking spawnSync would deadlock it.
function run(args, { env = baseEnv, timeout = 300_000, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd: tmp, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input != null) child.stdin.end(input);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c) => (err += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, out, err, signal });
    });
  });
}
const brief = (r) => `exit ${r.code}${r.signal ? ' ' + r.signal : ''}; ${(r.err || r.out).trim().split('\n').slice(-2).join(' / ').slice(0, 220)}`;
const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

async function cliCases() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const settingsHash = sha(Paths.settingsPath());

  // ---- general ----
  let r = await run(['--version']);
  check('cli --version', r.code === 0 && r.out.includes(pkg.version), brief(r));
  r = await run(['--help']);
  const cmds = ['transcribe', 'brain', 'brief', 'translate', 'history', 'ask', 'segments', 'stats', 'snippets', 'dictionary', 'meeting'];
  check('cli --help lists every command', r.code === 0 && cmds.every((c) => r.out.includes('chawo-va ' + c)), brief(r));
  r = await run(['--lang', 'en', '--help']);
  check('cli --lang en --help (before the command)', r.code === 0 && r.out.includes('Usage'), brief(r));
  r = await run(['--lang', 'en', 'history', 'еж']);
  check('cli --lang en <command>', r.code === 0 && r.out.includes('Ёжик') && !/[А-Яа-я]/.test(r.err), brief(r));
  r = await run([]);
  check('cli without arguments prints help', r.code === 0 && r.out.includes('chawo-va transcribe'), brief(r));
  r = await run(['frobnicate']);
  check('cli unknown command → exit 2', r.code === 2 && /unknown command/.test(r.err), brief(r));
  r = await run(['transcribe', '--bogus', 'x']);
  check('cli unknown option → exit 2', r.code === 2 && /unknown option/.test(r.err), brief(r));
  r = await run(['transcribe']);
  check('cli transcribe without files → usage error', r.code === 2, brief(r));
  r = await run(['transcribe', join(tmp, 'nope.wav')]);
  check('cli transcribe missing file → exit 1', r.code === 1 && /no such file|такого файла нет/.test(r.err), brief(r));

  // ---- segments / history (no model, no Brain) ----
  const segDir = join(tmp, 'segments');
  mkdirSync(segDir, { recursive: true });
  for (const n of ['sample.txt', 'sample.srt', 'sample.json', 'sample.wav']) copyFileSync(join(fixtures, n), join(segDir, n));
  for (const ext of ['txt', 'srt', 'json']) {
    r = await run(['segments', join(segDir, 'sample.' + ext), '--json']);
    let rows;
    try {
      rows = r.out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (rows.length === 1 && Array.isArray(rows[0])) rows = rows[0];
    } catch {
      rows = [];
    }
    check(`cli segments .${ext} --json`, r.code === 0 && rows.length >= 3 && rows.every((x) => typeof x.start === 'number'), brief(r) + ` rows ${rows.length}`);
  }
  r = await run(['segments', join(segDir, 'sample.srt')]);
  check('cli segments (text)', r.code === 0 && r.out.split('\n').filter(Boolean).length >= 3 && /phrases|фраз/i.test(r.err), brief(r));
  r = await run(['segments', join(tmp, 'nope.srt')]);
  check('cli segments missing file → exit 1', r.code === 1, brief(r));
  // ---- stats («Статистика разговора») on the same fixture ----
  r = await run(['stats', join(segDir, 'sample.srt'), '--track', 'Тест: фраз*', '--hits']);
  check('cli stats (talk ratio + tracker + hits)', r.code === 0 && /Speaker 1|Спикер 1/.test(r.out) && /Тест: 1/.test(r.out) && /Первая фраза/.test(r.out), brief(r));
  r = await run(['stats', join(segDir, 'sample.json'), '--json']);
  {
    let doc = null;
    try { doc = JSON.parse(r.out.trim()); } catch { /* checked below */ }
    check('cli stats --json', r.code === 0 && doc && doc.diarized === true && Array.isArray(doc.speakers) && doc.speakers.length >= 2 && Array.isArray(doc.trackers), brief(r));
  }
  // A diarized .txt alone (the default format) still gives the talk ratio per speaker.
  const diarTxt = join(segDir, 'diarized-only.txt');
  writeFileSync(diarTxt, '[00:00:01] Спикер 1: Здравствуйте, меня зовут Аня.\n[00:00:05] Спикер 2: Нам нужна доставка.\n[00:00:09] Спикер 1: Сколько штук?\n', 'utf8');
  r = await run(['stats', diarTxt, '--json']);
  {
    let doc = null;
    try { doc = JSON.parse(r.out); } catch { /* checked below */ }
    check('cli stats on a diarized .txt (speakers from «Спикер N:»)', r.code === 0 && doc && doc.diarized === true && Array.isArray(doc.speakers) && doc.speakers.length === 2, brief(r));
  }
  r = await run(['stats', join(tmp, 'nope.srt')]);
  check('cli stats missing file → exit 1', r.code === 1, brief(r));

  // ---- meeting detect (calendar .ics from writeSettings; apps off — no Zoom in CI) ----
  r = await run(['meeting', 'detect', '--json']);
  let md = null;
  try { md = JSON.parse(r.out.trim()); } catch { /* below */ }
  check('cli meeting detect --json (calendar fixture)', r.code === 0 && md && md.active === true && Array.isArray(md.calendar) && md.calendar.some((c) => c.summary === 'E2E Meeting'), brief(r));
  r = await run(['meeting', 'detect']);
  check('cli meeting detect (text)', r.code === 0 && /E2E Meeting|встречу|meeting/i.test(r.out), brief(r));
  r = await run(['meeting', 'watch']);
  check('cli meeting unknown action → usage', r.code === 2, brief(r));

  // ---- snippets (snippets.json, separate from settings.json) ----
  r = await run(['snippets', 'add', 'реквизиты', 'ИНН 7700000000, КПП 770001001']);
  check('cli snippets add', r.code === 0, brief(r));
  r = await run(['snippets', 'list', '--json']);
  let sj = [];
  try { sj = JSON.parse(r.out); } catch { /* checked below */ }
  check('cli snippets list --json', r.code === 0 && sj.some((x) => x.trigger === 'реквизиты' && x.text.startsWith('ИНН')), brief(r));
  r = await run(['snippets', 'remove', 'реквизиты']);
  const r2 = await run(['snippets', 'list']);
  check('cli snippets remove', r.code === 0 && r2.code === 0 && !r2.out.includes('реквизиты'), brief(r) + ' / ' + brief(r2));
  r = await run(['snippets', 'remove', 'реквизиты']);
  check('cli snippets remove missing → exit 1', r.code === 1, brief(r));

  // ---- dictionary from fixes (learned-words.json; only WordReplacementRules in settings.json changes) ----
  const ld = join(tmp, 'learn');
  mkdirSync(ld, { recursive: true });
  writeFileSync(join(ld, 'before.txt'), 'Созвон с гигачад в среду, потом гигачад отчёт.');
  writeFileSync(join(ld, 'after.txt'), 'Созвон с GigaChad в среду, потом GigaChad отчёт.');
  r = await run(['dictionary', 'learn', join(ld, 'before.txt'), join(ld, 'after.txt')]);
  check('cli dictionary learn finds the fix', r.code === 0 && r.out.includes('гигачад\tGigaChad'), brief(r));
  r = await run(['dictionary', 'suggest', '--json']);
  check('cli dictionary suggest: one fix is not enough', r.code === 0 && r.out.trim() === '[]', brief(r));
  await run(['dictionary', 'learn', join(ld, 'before.txt'), join(ld, 'after.txt')]);
  r = await run(['dictionary', 'suggest', '--json']);
  let dj = [];
  try { dj = JSON.parse(r.out); } catch { /* checked below */ }
  check('cli dictionary suggest after the second fix', r.code === 0 && dj.some((x) => x.from === 'гигачад' && x.to === 'GigaChad' && x.count === 2), brief(r));
  r = await run(['dictionary', 'accept', 'гигачад']);
  const r3 = await run(['dictionary', 'list']);
  const learnedCli = JSON.parse(readFileSync(Paths.learnedWordsPath(), 'utf8'));
  check('cli dictionary accept → queued for the app, shown by list', r.code === 0 && r3.out.includes('гигачад\tGigaChad') && (learnedCli.pending || []).some((p) => p.from === 'гигачад'), brief(r) + ' / ' + brief(r3));
  r = await run(['dictionary', 'suggest', '--json']);
  check('cli dictionary suggest is empty after accept', r.code === 0 && r.out.trim() === '[]', brief(r));
  r = await run(['dictionary', 'accept', 'нет-такого']);
  check('cli dictionary accept unknown → exit 1', r.code === 1, brief(r));

  // ---- «В CRM»: config (tokens via stdin only), dry-run sends nothing, --yes sends once, repeat needs --force ----
  const crmBase = baseEnv.CHAWO_E2E_CRM;
  const cd = join(tmp, 'crm');
  mkdirSync(cd, { recursive: true });
  const cb = join(cd, 'call.brief.txt');
  writeFileSync(cb, 'Кратко\n- Клиент берёт 20 лицензий\n\nЗадачи\n- Анна: счёт до пятницы\n');
  r = await run(['crm', 'config', '--to', 'amocrm', '--token', CRM_TOKENS.amo]);
  check('cli crm config refuses a token as an argument', r.code === 2, brief(r));
  r = await run(['crm', 'config', '--to', 'amocrm', '--base', crmBase, '--token', '-'], { input: CRM_TOKENS.amo + '\n' });
  const r2c = await run(['crm', 'config', '--to', 'hubspot', '--token', '-'], { input: CRM_TOKENS.hub });
  const rcf = await run(['crm', 'config']);
  check('cli crm config: saved, shown masked', r.code === 0 && r2c.code === 0 && /amocrm\t(ready|настроен)/.test(rcf.out) && /hubspot\t(ready|настроен)/.test(rcf.out) && !rcf.out.includes('SECRET'), brief(r) + ' / ' + brief(rcf));
  r = await run(['crm', 'config', '--to', 'webhook', '--url', 'https://10.0.0.1/hook']);
  check('cli crm config: private address refused', r.code === 2 && /private/.test(r.err), brief(r));
  r = await run(['crm', 'send', cb, '--to', 'amocrm', '--id', '42', '--dry-run']);
  check('cli crm send --dry-run: exact request, nothing sent, token masked', r.code === 0 && r.out.includes('/api/v4/leads/42/notes') && r.out.includes('Анна: счёт до пятницы') && !r.out.includes('SECRET') && crmGot.length === 0, brief(r));
  r = await run(['crm', 'send', cb, '--to', 'amocrm', '--id', '42']);
  check('cli crm send without --yes (no terminal) → exit 2, nothing sent', r.code === 2 && crmGot.length === 0, brief(r));
  r = await run(['crm', 'send', cb, '--to', 'amocrm', '--id', '42', '--yes']);
  const amo = crmGot.find((g) => g.url === '/api/v4/leads/42/notes');
  check('cli crm send amoCRM → mock got the note with the token', r.code === 0 && amo && amo.auth === 'Bearer ' + CRM_TOKENS.amo && JSON.parse(amo.body)[0].params.text.includes('Клиент берёт 20 лицензий') && !r.err.includes('SECRET'), brief(r));
  const before = crmGot.length;
  r = await run(['crm', 'send', cb, '--to', 'amocrm', '--id', '42', '--yes']);
  check('cli crm send repeat → refused without --force', r.code === 1 && /--force/.test(r.err) && crmGot.length === before, brief(r));
  r = await run(['crm', 'send', cb, '--to', 'hubspot', '--id', '9001', '--yes']);
  const hub = crmGot.find((g) => g.url === '/crm/v3/objects/notes');
  check('cli crm send HubSpot → note associated with the record', r.code === 0 && hub && hub.auth === 'Bearer ' + CRM_TOKENS.hub && JSON.parse(hub.body).associations[0].to.id === '9001', brief(r));

  r = await run(['history']);
  check('cli history lists the takes', r.code === 0 && r.out.includes('Ёжик') && r.out.includes('Совещание'), brief(r));
  r = await run(['history', 'еж']);
  check('cli history search (ё = е)', r.code === 0 && r.out.includes('Ёжик') && !r.out.includes('Совещание'), brief(r));
  r = await run(['history', '-n', '1', '--json']);
  let hj = [];
  try {
    hj = r.out.trim().split('\n').map((l) => JSON.parse(l));
  } catch { /* best effort */ }
  check('cli history -n 1 --json', r.code === 0 && hj.length === 1 && hj[0].final === 'Ёжик в тумане.', brief(r));
  r = await run(['history', '--raw', '-n', 'all']);
  check('cli history --raw', r.code === 0 && r.out.includes('ну Совещание'), brief(r));
  // ---- ask («Спросить историю»): meetings folder + dictation, local search, fake Brain answer ----
  r = await run(['ask', 'скидку', 'Иванову', '--search']);
  check('cli ask --search (excerpts, no Brain)', r.code === 0 && r.out.includes('Иванову обещали') && r.out.includes('встреча-иванов.txt'), brief(r));
  const askedBefore = asked.length;
  r = await run(['ask', 'что', 'обещали', 'Иванову?']);
  const askSent = asked.slice(askedBefore).find((a) => /past dictation/.test(a.full));
  check('cli ask (Brain answer + cited source)', r.code === 0 && r.out.includes('скидку 10% до пятницы [1]') && r.out.includes('[1] встреча-иванов.txt') && Boolean(askSent), brief(r));
  r = await run(['ask', 'совещание', 'пятницу', '--no-history', '--json']);
  {
    let doc = null;
    try { doc = JSON.parse(r.out); } catch { /* checked below */ }
    check('cli ask --no-history --json', r.code === 0 && doc && doc.excerpts.every((e) => e.kind === 'transcript') && doc.searched.sources === 1, brief(r));
  }
  r = await run(['ask', 'Ёжик', '--in', join(tmp, 'nope-folder'), '--search']);
  check('cli ask --in (dictation still searched)', r.code === 0 && r.out.includes('Ёжик'), brief(r));

  // ---- mcp: opt-in stdio MCP server, driven by the official SDK client + a raw JSON-lines check ----
  r = await run(['mcp']);
  check('cli mcp is off by default → exit 3', r.code === 3 && r.out === '' && /MCP/.test(r.err), brief(r));
  {
    const sp = Paths.settingsPath();
    const before = readFileSync(sp, 'utf8');
    writeFileSync(sp, JSON.stringify({ ...JSON.parse(before), McpEnabled: true }, null, 2));
    const secret = join(tmp, 'secret.txt');
    writeFileSync(secret, 'секретный пароль', 'utf8');
    try {
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
      const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: baseEnv, cwd: tmp, stderr: 'pipe' });
      const client = new Client({ name: 'chawo-e2e', version: '1.0.0' });
      await client.connect(transport);
      const info = client.getServerVersion();
      const tools = (await client.listTools()).tools.map((x) => x.name).sort();
      check('mcp (SDK client): initialize + tools/list', info?.name === 'chawo-va' && tools.join(',') === 'get_brief,get_score,get_stats,get_transcript,list_meetings,search', JSON.stringify({ info, tools }));
      const found = await client.callTool({ name: 'search', arguments: { query: 'скидку Иванову' } });
      const hit = (found.structuredContent?.results || []).find((x) => x.kind === 'transcript');
      check('mcp tools/call search finds the meeting', !found.isError && hit && hit.path.endsWith('встреча-иванов.txt'), JSON.stringify(found).slice(0, 220));
      const list = await client.callTool({ name: 'list_meetings', arguments: {} });
      check('mcp tools/call list_meetings', (list.structuredContent?.meetings || []).some((m) => m.name === 'встреча-иванов.txt'), JSON.stringify(list).slice(0, 220));
      const tr = hit ? await client.callTool({ name: 'get_transcript', arguments: { path: hit.path } }) : { isError: true, content: [] };
      check('mcp tools/call get_transcript', !tr.isError && tr.content[0].text.includes('скидку 10%'), JSON.stringify(tr).slice(0, 220));
      const out = await client.callTool({ name: 'get_transcript', arguments: { path: secret } });
      const out2 = await client.callTool({ name: 'get_transcript', arguments: { path: join(process.env.CHAWO_MEETINGS_DIR, '..', 'secret.txt') } });
      check('mcp refuses files outside the meetings folder', out.isError && out2.isError && !JSON.stringify([out, out2]).includes('секретный'), JSON.stringify(out).slice(0, 220));
      await client.close();
    } catch (e) {
      failc('mcp (SDK client)', String(e && e.stack || e).slice(0, 300));
    }
    // Raw: every stdout line must be one JSON-RPC message, even around bad input.
    const raw = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, 'mcp', '--lang', 'en'], { env: baseEnv, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] });
      let o = '';
      child.stdout.setEncoding('utf8').on('data', (c) => (o += c));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: o }); });
      child.stdin.end([
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"raw","version":"1"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        'garbage',
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_stats","arguments":{"path":"встреча-иванов.txt"}}}',
        '{"jsonrpc":"2.0","id":3,"method":"tools/list"}',
        '',
      ].join('\n'));
    });
    let msgs = null;
    try { msgs = raw.out.trim().split('\n').map((l) => JSON.parse(l)); } catch { /* checked below */ }
    check('mcp raw stdio: only JSON-RPC lines on stdout, exits 0 at EOF', raw.code === 0 && msgs && msgs.length === 4 && msgs.every((m) => m.jsonrpc === '2.0') && msgs.some((m) => m.id === 2 && m.result.isError) && msgs.some((m) => m.error && m.error.code === -32700), `exit ${raw.code}; ${raw.out.slice(0, 220)}`);
    writeFileSync(sp, before);
  }

  // ---- Brain commands on a text transcript (fake 127.0.0.1 server) ----
  const bd = join(tmp, 'brain');
  mkdirSync(bd, { recursive: true });
  const meet = join(bd, 'meet.txt');
  writeFileSync(meet, '[00:00:01] Ну Анна подготовит презентацию к понедельнику.\n[00:00:05] Борис вот проверит смету.\n', 'utf8');
  r = await run(['brain', meet]);
  const brainTxt = read(join(bd, 'meet.brain.txt'));
  check('cli brain → .brain.txt', r.code === 0 && brainTxt.includes('Анна подготовит') && /Кратко|Summary/.test(brainTxt), brief(r));
  r = await run(['brain', meet, '--stdout', '-q']);
  check('cli brain --stdout', r.code === 0 && r.out.includes('Анна'), brief(r));
  // «Контекст для Мозга»: off unless asked; --context / --context-file land fenced in the prompt, never in the text.
  const plainAsk = asked.length;
  r = await run(['brain', meet, '--stdout', '-q']);
  check('cli brain: no context by default', r.code === 0 && asked.slice(plainAsk).every((a) => !a.full.includes('<context>')), brief(r));
  const ctxAsk = asked.length;
  r = await run(['brain', meet, '--stdout', '-q', '--context', 'Клиент: ООО «Зюйд-Вест», Анна Карпенко']);
  check('cli brain --context', r.code === 0 && !r.out.includes('Зюйд') && asked.slice(ctxAsk).length > 0 && asked.slice(ctxAsk).every((a) => a.full.includes('<context>') && a.full.includes('Зюйд-Вест')), brief(r));
  const ctxFile = join(bd, 'ctx.txt');
  writeFileSync(ctxFile, 'Проект «Чаво», термин RAG\n', 'utf8');
  const fileAsk = asked.length;
  r = await run(['brain', meet, '--stdout', '-q', '--context-file', ctxFile]);
  check('cli brain --context-file', r.code === 0 && asked.slice(fileAsk).length > 0 && asked.slice(fileAsk).every((a) => a.full.includes('термин RAG')), brief(r));
  r = await run(['brain', meet, '--stdout', '-q', '--context-file', join(bd, 'missing.txt')]);
  check('cli brain --context-file missing → error', r.code !== 0 && /context-file/.test(r.err) && !/at .*\.js:\d+/.test(r.err), brief(r));
  r = await run(['brief', meet, '--context', 'x']);
  check('cli --context is only for brain', r.code !== 0 && /--context/.test(r.err), brief(r));
  r = await run(['brief', meet]);
  check('cli brief → .brief.txt', r.code === 0 && read(join(bd, 'meet.brief.txt')).includes('Задачи'), brief(r));
  r = await run(['brief', meet, '--instruction', 'Только задачи', '--stdout']);
  check('cli brief --instruction --stdout', r.code === 0 && r.out.includes('Задачи') && asked.some((a) => a.system.length > 0), brief(r));
  r = await run(['brief', '--template', 'list']);
  check('cli brief --template list', r.code === 0 && ['standard', 'sales-call', 'minutes', 'summary'].every((x) => r.out.includes(x)), brief(r));
  r = await run(['brief', meet, '--template', 'sales-call', '--stdout']);
  check('cli brief --template sales-call (prompt has the template)', r.code === 0 && r.out.includes('Задачи') && /Возражения/.test(asked[asked.length - 1]?.full ?? ''), brief(r));
  writeFileSync(Paths.briefTemplatesPath(), JSON.stringify({ version: 1, templates: [{ name: 'E2E шаблон', instruction: 'Только задачи E2E-маркер.' }] }));
  r = await run(['brief', meet, '--template', 'e2e шаблон', '--stdout']);
  check('cli brief --template <custom>', r.code === 0 && /E2E-маркер/.test(asked[asked.length - 1]?.full ?? ''), brief(r));
  r = await run(['brief', meet, '--template', 'nope']);
  check('cli brief --template unknown → exit 2', r.code === 2 && /sales-call/.test(r.err), brief(r));
  rmSync(Paths.briefTemplatesPath(), { force: true });
  // «Проверка по чек-листу»: built-in sales checklist, custom one, list, JSON, unknown.
  r = await run(['score', meet]);
  let scj = null;
  try {
    scj = JSON.parse(read(join(bd, 'meet.score.json')));
  } catch { /* best effort */ }
  const stxt = read(join(bd, 'meet.score.txt'));
  check('cli score → .score.json + .score.txt (sales: 1.5 of 6, quote checked)',
    r.code === 0 && scj && scj.checklist.id === 'sales' && scj.max === 6 && scj.score === 1.5 && scj.percent === 25 && scj.items[0].quote.includes('Анна') && scj.items[1].quote === '' && /Итог: 1,5 из 6/.test(stxt) && stxt.includes('✓'), brief(r) + ' | ' + stxt.slice(0, 200));
  r = await run(['score', '--checklist', 'list']);
  check('cli score --checklist list', r.code === 0 && /^sales\t/m.test(r.out), brief(r));
  writeFileSync(Paths.checklistsPath(), JSON.stringify({ version: 1, checklists: [{ name: 'E2E чек-лист', items: ['Назвал срок', 'Попрощался'] }] }));
  r = await run(['score', meet, '--checklist', 'e2e чек-лист', '--stdout', '--json']);
  let cj = null;
  try {
    cj = JSON.parse(r.out);
  } catch { /* best effort */ }
  check('cli score --checklist <custom> --stdout --json', r.code === 0 && cj && cj.max === 2 && cj.checklist.name === 'E2E чек-лист' && /Назвал срок/.test(asked[asked.length - 1]?.full ?? ''), brief(r));
  r = await run(['score', meet, '--checklist', 'nope']);
  check('cli score --checklist unknown → exit 2', r.code === 2 && /sales/.test(r.err), brief(r));
  rmSync(Paths.checklistsPath(), { force: true });
  r = await run(['translate', meet, '--to', 'de']);
  check('cli translate --to de → .translate.txt', r.code === 0 && read(join(bd, 'meet.translate.txt')).includes('Guten Tag'), brief(r));
  const outDir = join(tmp, 'brain-out');
  r = await run(['translate', meet, '--to', 'English', '-o', outDir]);
  check('cli translate --to English -o', r.code === 0 && read(join(outDir, 'meet.translate.txt')).includes('Good afternoon'), brief(r));
  r = await run(['translate', join(bd, 'nope.txt')]);
  check('cli translate missing file → exit 1', r.code === 1, brief(r));

  // ---- transcribe without a model → exit 3 (the temp profile has none yet) ----
  const tdir = join(tmp, 'transcribe');
  mkdirSync(tdir, { recursive: true });
  const speech = join(tdir, 'talk' + (audioSrc.match(/\.[^.]+$/)?.[0] ?? '.wav'));
  copyFileSync(audioSrc && existsSync(audioSrc) ? audioSrc : join(fixtures, 'sample.wav'), speech);
  r = await run(['transcribe', speech]);
  check('cli transcribe without a model → exit 3', r.code === 3, brief(r));
  r = await run(['transcribe', speech, '--model', 'ctc']);
  check('cli transcribe --model ctc without it → exit 3', r.code === 3, brief(r));

  // «Контекст для Мозга» on transcribe: usage errors need no model.
  r = await run(['transcribe', speech, '--no-brain', '--context', 'x']);
  check('cli transcribe --no-brain --context → usage error', r.code === 2 && /--context/.test(r.err), brief(r));
  r = await run(['transcribe', speech, '--server', 'http://127.0.0.1:9', '--context', 'x']);
  check('cli transcribe --server --context → usage error', r.code === 2 && /--server/.test(r.err), brief(r));

  const haveModel = installModel();
  if (!haveModel) {
    const why = 'no speech model (set CHAWO_SMOKE_MODEL_DIR)';
    for (const n of ['transcribe --brain --context', 'transcribe → txt', 'transcribe every format', 'transcribe --stdout', 'transcribe --skip-existing', 'transcribe a folder', 'transcribe --post-script', 'transcribe --brain --brief --score', 'transcribe --diarize without speaker models', 'transcribe a link']) {
      if (process.env.CHAWO_SMOKE_REQUIRE_MODEL === '1') failc('cli ' + n, why);
      else skip('cli ' + n, why);
    }
  } else {
    const realSpeech = Boolean(audioSrc && existsSync(audioSrc));
    const hasText = (s) => (realSpeech ? /[А-Яа-яЁё]{3,}/.test(s) : true);
    r = await run(['transcribe', speech, '--no-vad', '-q']);
    const txt = read(speech.replace(/\.[^.]+$/, '.txt'));
    check('cli transcribe → txt', r.code === 0 && existsSync(speech.replace(/\.[^.]+$/, '.txt')) && hasText(txt), brief(r) + ' | ' + txt.slice(0, 120));

    const fmtDir = join(tmp, 'formats');
    r = await run(['transcribe', speech, '-f', 'txt,srt,vtt,json,md,docx', '-o', fmtDir, '-j', '2', '--model-dir', modelSrc]);
    const stem = join(fmtDir, basename(speech).replace(/\.[^.]+$/, ''));
    const missing = ['txt', 'srt', 'vtt', 'json', 'md', 'docx'].filter((e) => !existsSync(stem + '.' + e));
    let jsonOk = false;
    try {
      jsonOk = Boolean(JSON.parse(read(stem + '.json')));
    } catch { /* best effort */ }
    const docxOk = existsSync(stem + '.docx') && readFileSync(stem + '.docx').subarray(0, 2).toString() === 'PK';
    const vttOk = read(stem + '.vtt').startsWith('WEBVTT');
    check('cli transcribe every format', r.code === 0 && missing.length === 0 && jsonOk && docxOk && vttOk, brief(r) + ` missing [${missing}] json ${jsonOk} docx ${docxOk} vtt ${vttOk}`);

    const before = readdirSync(tdir).length;
    r = await run(['transcribe', speech, '--stdout', '--no-timestamps']);
    check('cli transcribe --stdout', r.code === 0 && hasText(r.out) && readdirSync(tdir).length === before && !/^\[\d/.test(r.out), brief(r) + ' | ' + r.out.slice(0, 100));

    r = await run(['transcribe', speech, '--skip-existing']);
    check('cli transcribe --skip-existing', r.code === 0 && /skip|пропуск|already|уже/i.test(r.err), brief(r));

    const folder = join(tmp, 'folder');
    mkdirSync(join(folder, 'nested'), { recursive: true });
    copyFileSync(speech, join(folder, 'a' + basename(speech).slice(4)));
    copyFileSync(join(fixtures, 'sample.wav'), join(folder, 'b.wav'));
    copyFileSync(join(fixtures, 'sample.wav'), join(folder, 'nested', 'c.wav'));
    writeFileSync(join(folder, 'notes.md'), '# not audio');
    r = await run(['transcribe', folder, '-q']);
    const made = readdirSync(folder).filter((f) => f.endsWith('.txt'));
    check('cli transcribe a folder (not recursive)', r.code === 0 && made.length === 2 && !existsSync(join(folder, 'nested', 'c.txt')), brief(r) + ` txt: ${made}`);

    const up = join(tmp, 'upper.cjs');
    writeFileSync(up, "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>process.stdout.write('[POST] '+s.toUpperCase()));");
    const psDir = join(tmp, 'post');
    r = await run(['transcribe', speech, '-o', psDir, '--post-script', `"${process.execPath}" "${up}"`]);
    const ps = read(join(psDir, basename(speech).replace(/\.[^.]+$/, '.txt')));
    check('cli transcribe --post-script', r.code === 0 && ps.startsWith('[POST]'), brief(r) + ' | ' + ps.slice(0, 80));

    const bdir = join(tmp, 'tbrain');
    r = await run(['transcribe', speech, '-o', bdir, '--brain', '--brief', '--score']);
    const st = join(bdir, basename(speech).replace(/\.[^.]+$/, ''));
    check('cli transcribe --brain --brief --score', r.code === 0 && existsSync(st + '.txt') && existsSync(st + '.brain.txt') && read(st + '.brief.txt').includes('Задачи') && /Итог|Score/.test(read(st + '.score.txt')) && existsSync(st + '.score.json'), brief(r));
    const tcAsk = asked.length;
    const tcDir = join(tmp, 'tbrain-ctx');
    r = await run(['transcribe', speech, '-o', tcDir, '--brain', '--context', 'Клиент Зюйд-Вест', '-q']);
    const tcPrompts = asked.slice(tcAsk).filter((a) => /Remove only filler words/.test(a.full));
    check('cli transcribe --brain --context', r.code === 0 && tcPrompts.length > 0 && tcPrompts.every((a) => a.full.includes('Зюйд-Вест')) && !read(join(tcDir, basename(speech).replace(/\.[^.]+$/, '.brain.txt'))).includes('Зюйд'), brief(r));

    r = await run(['transcribe', speech, '--diarize', '--stdout']);
    check('cli transcribe --diarize without speaker models', r.code === 0 && /speaker|спикер/i.test(r.err), brief(r));

    const fs = await fileServer(speech);
    const dl = join(prof.home, 'Downloads');
    mkdirSync(dl, { recursive: true });
    r = await run(['transcribe', `http://127.0.0.1:${fs.address().port}/talk.wav`, '-q', '-o', join(tmp, 'link')], { timeout: 120_000 });
    fs.close();
    // yt-dlp is not downloaded by the CLI: without it the run must say so (no crash); with it, a .txt appears.
    const linkTxt = existsSync(join(tmp, 'link')) ? readdirSync(join(tmp, 'link')).filter((f) => f.endsWith('.txt')) : [];
    check('cli transcribe a link', (r.code === 0 && linkTxt.length === 1) || (r.code !== 0 && /yt-dlp/i.test(r.err) && !/at .*\.js:\d+/.test(r.err)), brief(r));
  }

  r = await run(['transcribe', 'file:///etc/hostname']);
  check('cli transcribe file:// is not fetched', r.code !== 0 && !/hostname\.txt/.test(r.err), brief(r));

  check('cli never rewrites settings.json', sha(Paths.settingsPath()) === settingsHash, '');
  return haveModel;
}

function electronBin() {
  try {
    // Electron 44 downloads its binary on first use: require() returns the path after fetching it.
    return require('electron');
  } catch {
    return '';
  }
}

async function guiCase(haveModel) {
  if (flag('--no-gui')) return skip('gui', '--no-gui');
  const bin = electronBin();
  if (!bin || !existsSync(bin)) return failc('gui: electron binary', 'the electron package is missing');
  const report = join(tmp, 'gui-report.json');
  const work = join(tmp, 'gui');
  mkdirSync(work, { recursive: true });
  const shots = opt('--shots');
  const eargs = ['--no-sandbox', join(__dirname, 'e2e-gui.cjs'), report, work, audioSrc && existsSync(audioSrc) ? audioSrc : '', shots ? resolve(shots) : ''];
  let cmd = bin;
  let full = eargs;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    cmd = 'xvfb-run';
    full = ['-a', '-s', '-screen 0 1280x800x24', bin, ...eargs];
  }
  const env = { ...baseEnv, CHAWO_E2E_MODEL: haveModel ? '1' : '0', CHAWO_E2E_CLI_RAN: flag('--no-cli') ? '0' : '1' };
  const t0 = Date.now();
  const child = spawn(cmd, full, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  let reportAt = 0;
  const poll = setInterval(() => {
    if (!reportAt && existsSync(report)) reportAt = Date.now();
  }, 200);
  const killer = setTimeout(() => child.kill('SIGKILL'), 8 * 60_000);
  const code = await new Promise((r) => child.on('close', (c) => r(c)));
  clearInterval(poll);
  clearTimeout(killer);
  if (!reportAt && existsSync(report)) reportAt = Date.now();
  if (!existsSync(report)) return failc('gui: driver report', `exit ${code}; ${log.trim().split('\n').slice(-6).join(' / ')}`);
  if (flag('--verbose') || code !== 0) console.log(log.trim().split('\n').filter((l) => !/^\s*$/.test(l)).slice(-25).join('\n'));
  const rep = JSON.parse(readFileSync(report, 'utf8'));
  for (const c of rep.checks) (c.skip ? skip : c.ok ? pass : failc)(c.name, c.detail);
  const quitMs = Date.now() - reportAt;
  check('gui: quits cleanly', code === 0 && quitMs < 20_000, `exit ${code}, ${Math.round(quitMs / 100) / 10} s after the last check; total ${Math.round((Date.now() - t0) / 1000)} s`);
}

(async () => {
  const brain = await fakeBrain();
  const crm = await crmMock();
  baseEnv.CHAWO_CRM_ALLOW_LOCAL = '1';
  baseEnv.CHAWO_E2E_CRM = `http://127.0.0.1:${crm.address().port}`;
  baseEnv.CHAWO_CRM_HUBSPOT_BASE = baseEnv.CHAWO_E2E_CRM;
  writeSettings(brain.address().port);
  seedHistory();
  let haveModel = false;
  try {
    if (flag('--no-cli')) {
      haveModel = installModel();
      skip('cli', '--no-cli');
    } else haveModel = await cliCases();
    await guiCase(haveModel);
  } catch (e) {
    failc('e2e driver', e?.stack ?? String(e));
  }
  brain.close();
  crm.close();
  // Secrets: no CRM token in the log, the journal, history or settings.json; crm.json owner-only.
  const leakIn = [Paths.logPath(), Paths.databasePath(), Paths.settingsPath(), Paths.crmConfigPath()].filter((p) => Object.values(CRM_TOKENS).some((tk) => read(p).includes(tk)));
  check('privacy: CRM tokens are not in the log, journal, history or settings', leakIn.length === 0, leakIn.join(', '));
  const crmMode = existsSync(Paths.crmConfigPath()) ? statSync(Paths.crmConfigPath()).mode & 0o077 : -1;
  check('privacy: crm.json is owner-only', process.platform === 'win32' || crmMode === 0, `mode ${crmMode.toString(8)}`);
  // Tokens are in the vault (CHAWO_SECRETS=file here: secrets.json in the temp profile), owner-only.
  const vaultFile = join(prof.roaming, 'ChawoVoiceAssistant', 'secrets.json');
  const vaultMode = existsSync(vaultFile) ? statSync(vaultFile).mode & 0o077 : -1;
  check('secrets: CRM tokens live in the vault, owner-only', Object.values(CRM_TOKENS).some((tk) => read(vaultFile).includes(tk)) && (process.platform === 'win32' || vaultMode === 0), `mode ${vaultMode.toString(8)}`);
  check('storage: history and the CRM journal are in chawo.db, no JSONL/JSON beside it', existsSync(Paths.databasePath()) && !existsSync(join(dirname(Paths.databasePath()), 'history.jsonl')) && !existsSync(join(dirname(Paths.databasePath()), 'crm-sent.json')), Paths.databasePath());
  // Privacy: neither the CLI nor the GUI may leave an onnxruntime device id in the (temp) home cache.
  const deviceid = join(prof.cache, 'Microsoft', 'DeveloperTools', '.onnxruntime', 'deviceid');
  const homeDeviceid = join(prof.home, '.cache', 'Microsoft', 'DeveloperTools', '.onnxruntime', 'deviceid');
  check('privacy: no onnxruntime deviceid', !existsSync(deviceid) && !existsSync(homeDeviceid), haveModel ? '' : '(no model ran — weak check)');
  check('privacy: the Brain only saw 127.0.0.1 traffic, no key leaked', asked.every((a) => !/Bearer\s+\S{20,}/.test(a.auth)), `${asked.length} requests`);

  const w = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.status === 'PASS' ? '' : r.detail}`);
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`\ne2e: ${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped (profile ${tmp}${flag('--keep') ? ', kept' : ''})`);
  if (!flag('--keep')) rmSync(tmp, { recursive: true, force: true });
  process.exit(n('FAIL') ? 1 : 0);
})();
