import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disableOrtTelemetry, isOrtTelemetryDisabled } from '../src/core/ortPrivacy';

const MODEL = '/workspace/vad/silero_v512.onnx';

afterEach(() => {
  // Keep this process opted out for other tests that may load ORT in-process.
  disableOrtTelemetry();
});

describe('ortPrivacy', () => {
  it('treats 1/true/yes/on/y as disabled (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'Yes', 'on', 'Y', ' yes ']) {
      expect(isOrtTelemetryDisabled(v), v).toBe(true);
    }
    for (const v of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(isOrtTelemetryDisabled(v), String(v)).toBe(false);
    }
  });

  it('sets ORT_DISABLE_TELEMETRY=1 and does not overwrite an existing disable', () => {
    const prev = process.env.ORT_DISABLE_TELEMETRY;
    try {
      delete process.env.ORT_DISABLE_TELEMETRY;
      disableOrtTelemetry();
      expect(process.env.ORT_DISABLE_TELEMETRY).toBe('1');

      process.env.ORT_DISABLE_TELEMETRY = 'yes';
      disableOrtTelemetry();
      expect(process.env.ORT_DISABLE_TELEMETRY).toBe('yes');

      process.env.ORT_DISABLE_TELEMETRY = 'true';
      disableOrtTelemetry();
      expect(process.env.ORT_DISABLE_TELEMETRY).toBe('true');
    } finally {
      if (prev === undefined) delete process.env.ORT_DISABLE_TELEMETRY;
      else process.env.ORT_DISABLE_TELEMETRY = prev;
      disableOrtTelemetry();
    }
  });

  it('child process: privacy shim then onnxruntime-node creates no deviceid under XDG_CACHE_HOME', () => {
    expect(existsSync(MODEL), `need Silero fixture at ${MODEL}`).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'ort-privacy-'));
    const cache = join(root, 'cache');
    const home = join(root, 'home');
    const script = join(root, 'run.cjs');
    const distShim = join(__dirname, '../dist/core/ortPrivacy.js');
    writeFileSync(
      script,
      `
const fs = require('fs');
const path = require('path');
const cache = process.env.XDG_CACHE_HOME;
const deviceid = path.join(cache, 'Microsoft', 'DeveloperTools', '.onnxruntime', 'deviceid');

function loadShim() {
  const dist = ${JSON.stringify(distShim)};
  if (fs.existsSync(dist)) {
    require(dist);
    return 'dist';
  }
  // Fallback before first build: same logic as ortPrivacy.ts.
  const cur = process.env.ORT_DISABLE_TELEMETRY;
  const ok = cur && ['1', 'true', 'yes', 'on', 'y'].includes(String(cur).trim().toLowerCase());
  if (!ok) process.env.ORT_DISABLE_TELEMETRY = '1';
  return 'inline';
}

(async () => {
  const how = loadShim();
  const ort = require('onnxruntime-node');
  await ort.InferenceSession.create(${JSON.stringify(MODEL)}, {
    executionProviders: ['cpu'],
    logSeverityLevel: 3,
  });
  await new Promise((r) => setTimeout(r, 400));
  if (fs.existsSync(deviceid)) {
    console.error('deviceid was created at', deviceid, 'shim=', how);
    process.exit(1);
  }
  console.log('ok no deviceid; shim=', how, 'ORT_DISABLE_TELEMETRY=', process.env.ORT_DISABLE_TELEMETRY);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
`,
      'utf8',
    );

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        XDG_CACHE_HOME: cache,
        HOME: home,
        NODE_PATH: join(__dirname, '..', 'node_modules'),
      };
      delete env.ORT_DISABLE_TELEMETRY;
      const r = spawnSync(process.execPath, [script], {
        env,
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/ok no deviceid/);
      expect(existsSync(join(cache, 'Microsoft', 'DeveloperTools', '.onnxruntime', 'deviceid'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
