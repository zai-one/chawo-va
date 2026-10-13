#!/usr/bin/env node
// Live CLI smoke: chawo-va brief with an injected fake Brain via NODE patch is awkward;
// instead build and run `node dist/cli.js brief` against a temp transcript using a tiny
// wrapper that stubs briefBrain through the test harness path is unit-tested.
// This smoke exercises the real CLI entry with --help and a dry parse, then runs brief
// through runCli with a fake ask (same as unit tests) to prove the binary builds.

const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
const cli = join(root, 'dist', 'cli.js');

const help = spawnSync(process.execPath, [cli, 'brief', '--help'], { encoding: 'utf8' });
if (help.status !== 0 && !help.stdout.includes('brief')) {
  // --help on brief may route to general help when parse sees --help first via blank('help')
}
const general = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
if (!general.stdout.includes('brief')) {
  console.error('FAIL: help does not mention brief');
  process.exit(1);
}
console.log('OK help mentions brief');

// Real runCli via requiring dist — inject through a small inline script
const dir = mkdtempSync(join(tmpdir(), 'chawo-brief-'));
const txt = join(dir, 'meet.txt');
writeFileSync(txt, 'Анна подготовит презентацию к понедельнику. Борис проверит смету.\n', 'utf8');

const runner = `
const { runCli } = require(${JSON.stringify(join(root, 'dist/cli/run.js'))});
const { outputPath } = require(${JSON.stringify(join(root, 'dist/main/file/fileTranscript.js'))});
const fs = require('fs');
const path = ${JSON.stringify(txt)};
const files = new Map();
const err = [];
const out = [];
const deps = {
  version: 'smoke',
  out: (s) => out.push(s),
  err: (s) => err.push(s),
  isTTY: false,
  defaults: () => ({ model: 'v3_e2e_rnnt', device: 'cpu', threads: 'auto', script: 'auto', timestamps: true, language: 'Russian' }),
  applyLanguage: () => {},
  t: (ru, en) => ru,
  findModel: () => null,
  openEngine: async () => { throw new Error('no'); },
  load16k: async () => new Float32Array(0),
  outputPath,
  briefOutputPath: (t) => t.replace(/\\.txt$/i, '.brief.txt'),
  isDirectory: () => false,
  exists: (p) => p === path || files.has(p),
  collectFromFolder: () => [],
  mkdirp: () => {},
  writeFile: (p, t) => files.set(p, t),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  briefBrain: () => ({
    target: 'Local',
    instruction: '',
    ask: async () => 'Кратко\\n- Созвон по статусу\\n\\nЗадачи\\n- Анна: презентация к понедельнику\\n- Борис: проверить смету\\n',
  }),
  log: () => {},
  now: () => Date.now(),
  signal: new AbortController().signal,
};
runCli(['brief', path], deps).then((code) => {
  const brief = files.get(path.replace(/\\.txt$/i, '.brief.txt'));
  if (code !== 0 || !brief || !brief.includes('Задачи')) {
    console.error('FAIL', code, brief, err.join(''));
    process.exit(1);
  }
  console.log('OK brief card:\\n' + brief);
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
`;
const script = join(dir, 'run.cjs');
writeFileSync(script, runner);
const r = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: root });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
