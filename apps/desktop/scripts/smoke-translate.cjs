#!/usr/bin/env node
// Live smoke for «Перевести» (IDEAS №15): needs `pnpm build` first.
// 1. `chawo-va --help` mentions translate and --to.
// 2. runCli(['translate', sample.txt, '--to', 'en']) with a fake ask → .translate.txt.
// 3. The real binary `node out/main/cli.js translate … --to de` end to end: a temp settings.json points the
//    Brain at a local fake OpenAI-compatible server on 127.0.0.1 (nothing leaves the machine), and
//    the request must carry the dedicated translation prompt.

const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

const root = join(__dirname, '..');
const cli = join(root, 'out', 'main', 'cli.js');
const fail = (...m) => {
  console.error('FAIL', ...m);
  process.exit(1);
};

const general = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
if (!general.stdout.includes('chawo-va translate') || !general.stdout.includes('--to')) fail('help does not mention translate / --to');
console.log('OK help mentions translate and --to');

const dir = mkdtempSync(join(tmpdir(), 'chawo-translate-'));
const sample = join(dir, 'sample.txt');
writeFileSync(sample, '[00:00:01] Добрый день. Анна пришлёт смету до пятницы.\n', 'utf8');

async function viaRunCli() {
  const { runCli } = require(join(root, 'out/main/apps/cli/src/cli/run.js'));
  const { outputPath } = require(join(root, 'out/main/packages/engine/src/file/fileTranscript.js'));
  const Translate = require(join(root, 'out/main/packages/engine/src/brain/translate.js'));
  const files = new Map();
  const err = [];
  const prompts = [];
  const deps = {
    version: 'smoke',
    out: () => {},
    err: (s) => err.push(s),
    isTTY: false,
    defaults: () => ({ model: 'v3_e2e_rnnt', device: 'cpu', threads: 'auto', script: 'auto', timestamps: true, language: 'Russian' }),
    applyLanguage: () => {},
    t: (ru) => ru,
    findModel: () => null,
    openEngine: async () => {
      throw new Error('no');
    },
    load16k: async () => new Float32Array(0),
    outputPath,
    briefOutputPath: (p) => p.replace(/\.txt$/i, '.brief.txt'),
    translateOutputPath: (p) => Translate.outputPath(p),
    isDirectory: () => false,
    exists: (p) => p === sample || files.has(p),
    collectFromFolder: () => [],
    mkdirp: () => {},
    writeFile: (p, t) => files.set(p, t),
    readFile: (p) => readFileSync(p, 'utf8'),
    briefBrain: () => ({ target: 'None', instruction: '', ask: async () => '' }),
    translateBrain: () => ({
      target: 'Local',
      to: '',
      ask: async (prompt) => {
        prompts.push(prompt);
        return '[00:00:01] Good afternoon. Anna will send the estimate by Friday.';
      },
    }),
    log: () => {},
    now: () => Date.now(),
    signal: new AbortController().signal,
  };
  const code = await runCli(['translate', sample, '--to', 'en'], deps);
  const out = files.get(join(dir, 'sample.translate.txt'));
  if (code !== 0 || !out || !out.includes('Anna') || !prompts[0].includes('into English')) fail('runCli', code, out, err.join(''));
  console.log('OK runCli translate → sample.translate.txt:\n' + out);
}

function fakeServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.endsWith('/chat/completions')) {
        const j = JSON.parse(body);
        seen.push(j);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '[00:00:01] Guten Tag. Anna schickt den Kostenvoranschlag bis Freitag.' } }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

async function viaBinary() {
  const { server, seen, port } = await fakeServer();
  const env = { ...process.env, CHAWO_APPDATA: join(dir, 'roaming'), CHAWO_LOCALAPPDATA: join(dir, 'local') };
  process.env.CHAWO_APPDATA = env.CHAWO_APPDATA;
  process.env.CHAWO_LOCALAPPDATA = env.CHAWO_LOCALAPPDATA;
  const Settings = require(join(root, 'out/main/packages/engine/src/settings.js'));
  const { settingsPath } = require(join(root, 'out/main/packages/engine/src/paths.js'));
  const s = Settings.defaults();
  s.Brain = 'Server';
  s.CleanupEndpointUrl = `http://127.0.0.1:${port}/v1`;
  s.CleanupModel = 'fake-local';
  mkdirSync(join(settingsPath(), '..'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(Settings.toJsonObject(s), null, 2));

  const child = spawn(process.execPath, [cli, 'translate', sample, '--to', 'de', '--lang', 'ru'], { env });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise((r) => child.on('close', r));
  server.close();
  const outPath = join(dir, 'sample.translate.txt');
  const out = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  const system = seen[0]?.messages?.[0]?.content ?? '';
  if (code !== 0 || !out.includes('Guten Tag') || !system.includes('into German')) fail('binary', code, stderr, out, system);
  process.stdout.write(stderr);
  console.log('OK node out/main/cli.js translate --to de → ' + outPath + ':\n' + out);
}

viaRunCli()
  .then(viaBinary)
  .then(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log('smoke-translate: OK');
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
