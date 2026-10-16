// `chawo-va cleanup`: lists without --yes, deletes the ticked items with --yes, the rest only with --all.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyLanguage, t } from '@chawo/core/strings';
import * as Settings from '@chawo/engine/settings';
import { cleanupCommand } from '../src/cli/cleanupCommand';
import type { CliDeps } from '../src/cli/run';

let root = '';
let out = '';
const saved = process.env.CHAWO_LOCALAPPDATA;
const deps = (meetings: string[] = []) =>
  ({ t, out: (s: string) => (out += s), err: (s: string) => (out += s), cleanupOptions: () => ({ settings: Settings.defaults(), meetings }) }) as unknown as CliDeps;

beforeEach(() => {
  applyLanguage('English');
  out = '';
  root = mkdtempSync(join(tmpdir(), 'chawo-cli-cleanup-'));
  process.env.CHAWO_LOCALAPPDATA = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CHAWO_LOCALAPPDATA;
  else process.env.CHAWO_LOCALAPPDATA = saved;
});

it('lists, then deletes only the ticked items; --all takes the rest too', () => {
  const legacy = join(root, 'GigaPisar', 'models', 'm.onnx');
  mkdirSync(join(root, 'GigaPisar', 'models'), { recursive: true });
  writeFileSync(legacy, 'x'.repeat(2048));
  const meetings = join(root, 'Meetings');
  mkdirSync(meetings);
  const wav = join(meetings, 'call.wav');
  writeFileSync(wav, 'x');
  writeFileSync(join(meetings, 'call.txt'), 'text');
  const old = (Date.now() - 60 * 86_400_000) / 1000;
  utimesSync(wav, old, old);

  expect(cleanupCommand([], deps([meetings]))).toBe(0);
  expect(out).toMatch(/\[x\] Old GigaPisar folder/);
  expect(out).toMatch(/\[ \] Meeting recordings/);
  expect(existsSync(legacy)).toBe(true);

  expect(cleanupCommand(['--yes'], deps([meetings]))).toBe(0);
  expect([existsSync(legacy), existsSync(wav)]).toEqual([false, true]);

  expect(cleanupCommand(['--yes', '--all'], deps([meetings]))).toBe(0);
  expect([existsSync(wav), existsSync(join(meetings, 'call.txt'))]).toEqual([false, true]);
});

it('rejects unknown options', () => {
  expect(cleanupCommand(['--nope'], deps())).toBe(2);
  expect(cleanupCommand(['--days', 'x'], deps())).toBe(2);
});
