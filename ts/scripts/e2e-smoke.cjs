#!/usr/bin/env node
// End-to-end smoke: every `chawo-va` command and the GUI (under xvfb on Linux), on the built app.
//   npm run e2e                       (build + this script)
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
const cli = join(root, 'dist', 'cli.js');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : '');
const results = [];
const pass = (name, detail = '') => results.push({ name, status: 'PASS', detail });
const failc = (name, detail = '') => results.push({ name, status: 'FAIL', detail });
const skip = (name, detail = '') => results.push({ name, status: 'SKIP', detail });
const check = (name, ok, detail = '') => (ok ? pass(name, detail) : failc(name, detail));

if (!existsSync(cli)) {
  console.error('e2e: dist/cli.js is missing — run `npm run build` first');
  process.exit(1);
}

// ---- where the model lives (resolved before the env is redirected to the temp profile) ----
function realModelDir() {
  if (process.env.CHAWO_SMOKE_MODEL_DIR) return process.env.CHAWO_SMOKE_MODEL_DIR;
  try {
    const store = require(join(root, 'dist/main/models/speechModelStore.js'));
    return store.findComplete('v3_e2e_rnnt') || '';
  } catch {
    return '';
  }
}
const modelSrc = realModelDir();
const audioSrc = process.env.CHAWO_SMOKE_AUDIO || '';
const fixtures = join(root, 'test', 'fixtures', 'transcript-editor');

// ---- temp profile ----
const tmp = mkdtempSync(join(tmpdir(), 'chawo-e2e-'));
const prof = { roaming: join(tmp, 'roaming'), local: join(tmp, 'local'), home: join(tmp, 'home'), cache: join(tmp, 'home', '.cache') };
for (const d of Object.values(prof)) mkdirSync(d, { recursive: true });
const baseEnv = {
  ...process.env,
  CHAWO_APPDATA: prof.roaming,
  CHAWO_LOCALAPPDATA: prof.local,
  HOME: prof.home,
  USERPROFILE: prof.home,
  XDG_CACHE_HOME: prof.cache,
  XDG_CONFIG_HOME: join(prof.home, '.config'),
  XDG_DATA_HOME: join(prof.home, '.local', 'share'),
  ELECTRON_ENABLE_LOGGING: '',
};
delete baseEnv.PISAR_APPDATA;
delete baseEnv.PISAR_LOCALAPPDATA;
delete baseEnv.ORT_DISABLE_TELEMETRY; // the app must set it itself
for (const [k, v] of Object.entries(baseEnv)) if (k.startsWith('CHAWO_') || k.startsWith('XDG_') || k === 'HOME') process.env[k] = v;

const Settings = require(join(root, 'dist/main/settings.js'));
const Paths = require(join(root, 'dist/main/paths.js'));

// ---- fake Brain: OpenAI-compatible, deterministic, records what it was asked ----
const asked = [];
function answer(system, user) {
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
      } catch {}
      const msgs = j.messages ?? [];
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      const user = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      asked.push({ system: system.slice(0, 120), auth: req.headers.authorization ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer(system, user) } }] }));
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
  mkdirSync(dirname(Paths.settingsPath()), { recursive: true });
  writeFileSync(Paths.settingsPath(), JSON.stringify(Settings.toJsonObject(s), null, 2));
}

function seedHistory() {
  const { HistoryStore } = require(join(root, 'dist/main/history/historyStore.js'));
  const store = new HistoryStore(Paths.historyFilePath());
  const now = Date.now();
  store.add({ raw: 'ну Совещание в пятницу', final: 'Совещание в пятницу.', command: null, brain: true, brainFailed: false, seconds: 2.3, ts: now - 60_000 }, 'Week');
  store.add({ raw: 'Ёжик в тумане', final: 'Ёжик в тумане.', command: null, brain: false, brainFailed: false, seconds: 1.1, ts: now - 30_000 }, 'Week');
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
function run(args, { env = baseEnv, timeout = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function cliCases(brainPort) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const settingsHash = sha(Paths.settingsPath());

  // ---- general ----
  let r = await run(['--version']);
  check('cli --version', r.code === 0 && r.out.includes(pkg.version), brief(r));
  r = await run(['--help']);
  const cmds = ['transcribe', 'brain', 'brief', 'translate', 'history', 'segments', 'snippets'];
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
    let rows = [];
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

  r = await run(['history']);
  check('cli history lists the takes', r.code === 0 && r.out.includes('Ёжик') && r.out.includes('Совещание'), brief(r));
  r = await run(['history', 'еж']);
  check('cli history search (ё = е)', r.code === 0 && r.out.includes('Ёжик') && !r.out.includes('Совещание'), brief(r));
  r = await run(['history', '-n', '1', '--json']);
  let hj = [];
  try {
    hj = r.out.trim().split('\n').map((l) => JSON.parse(l));
  } catch {}
  check('cli history -n 1 --json', r.code === 0 && hj.length === 1 && hj[0].final === 'Ёжик в тумане.', brief(r));
  r = await run(['history', '--raw', '-n', 'all']);
  check('cli history --raw', r.code === 0 && r.out.includes('ну Совещание'), brief(r));

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
  r = await run(['brief', meet]);
  check('cli brief → .brief.txt', r.code === 0 && read(join(bd, 'meet.brief.txt')).includes('Задачи'), brief(r));
  r = await run(['brief', meet, '--instruction', 'Только задачи', '--stdout']);
  check('cli brief --instruction --stdout', r.code === 0 && r.out.includes('Задачи') && asked.some((a) => a.system.length > 0), brief(r));
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

  const haveModel = installModel();
  if (!haveModel) {
    const why = 'no speech model (set CHAWO_SMOKE_MODEL_DIR)';
    for (const n of ['transcribe → txt', 'transcribe every format', 'transcribe --stdout', 'transcribe --skip-existing', 'transcribe a folder', 'transcribe --post-script', 'transcribe --brain --brief', 'transcribe --diarize without speaker models', 'transcribe a link']) {
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
    } catch {}
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
    r = await run(['transcribe', speech, '-o', bdir, '--brain', '--brief']);
    const st = join(bdir, basename(speech).replace(/\.[^.]+$/, ''));
    check('cli transcribe --brain --brief', r.code === 0 && existsSync(st + '.txt') && existsSync(st + '.brain.txt') && read(st + '.brief.txt').includes('Задачи'), brief(r));

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
    return require(join(root, 'node_modules', 'electron'));
  } catch {
    return '';
  }
}

async function guiCase(haveModel) {
  if (flag('--no-gui')) return skip('gui', '--no-gui');
  const bin = electronBin();
  if (!bin || !existsSync(bin)) return failc('gui: electron binary', 'node_modules/electron is missing');
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
  const env = { ...baseEnv, CHAWO_E2E_MODEL: haveModel ? '1' : '0' };
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
  writeSettings(brain.address().port);
  seedHistory();
  let haveModel = false;
  try {
    if (flag('--no-cli')) {
      haveModel = installModel();
      skip('cli', '--no-cli');
    } else haveModel = await cliCases(brain.address().port);
    await guiCase(haveModel);
  } catch (e) {
    failc('e2e driver', e?.stack ?? String(e));
  }
  brain.close();
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
