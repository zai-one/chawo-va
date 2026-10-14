#!/usr/bin/env node
// Live check: with the privacy shim, InferenceSession must not create
// $XDG_CACHE_HOME/Microsoft/DeveloperTools/.onnxruntime/deviceid.
'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const MODEL = process.env.CHAWO_VAD_MODEL || '/workspace/vad/silero_v512.onnx';
const distShim = join(__dirname, '../dist/core/ortPrivacy.js');
if (!existsSync(MODEL)) {
  console.error('missing model', MODEL);
  process.exit(2);
}
if (!existsSync(distShim)) {
  console.error('build first (dist/core/ortPrivacy.js missing)');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'smoke-ort-privacy-'));
const cache = join(root, 'cache');
const home = join(root, 'home');
const script = join(root, 'run.cjs');
writeFileSync(
  script,
  `
const fs = require('fs');
const path = require('path');
require(${JSON.stringify(distShim)});
const ort = require('onnxruntime-node');
const id = path.join(process.env.XDG_CACHE_HOME, 'Microsoft', 'DeveloperTools', '.onnxruntime', 'deviceid');
(async () => {
  await ort.InferenceSession.create(${JSON.stringify(MODEL)}, { executionProviders: ['cpu'], logSeverityLevel: 3 });
  await new Promise((r) => setTimeout(r, 400));
  const hit = fs.existsSync(id);
  console.log(JSON.stringify({
    ORT_DISABLE_TELEMETRY: process.env.ORT_DISABLE_TELEMETRY,
    deviceid: hit,
    path: id,
  }));
  process.exit(hit ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
`,
  'utf8',
);

const env = {
  ...process.env,
  XDG_CACHE_HOME: cache,
  HOME: home,
  NODE_PATH: join(__dirname, '..', 'node_modules'),
};
delete env.ORT_DISABLE_TELEMETRY;
const r = spawnSync(process.execPath, [script], { env, cwd: join(__dirname, '..'), encoding: 'utf8', timeout: 60_000 });
rmSync(root, { recursive: true, force: true });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status == null ? 2 : r.status);
