// Opt-in: the real CLI path (settings → model → decode → FileJob → .txt/.srt) on real speech.
// CHAWO_TEST_MODEL_DIR=<dir with v3_e2e_rnnt_*> CHAWO_TEST_SPEECH=<wav> npm test
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Recognizer } from '@chawo/core/recognizer';

const dir = process.env.CHAWO_TEST_MODEL_DIR ?? '';
const wav = process.env.CHAWO_TEST_SPEECH ?? '';
const expectText = (process.env.CHAWO_TEST_EXPECT ?? 'русский язык').toLowerCase();
const ready = dir !== '' && wav !== '' && existsSync(wav) && Recognizer.modelExists(dir, 'v3_e2e_rnnt');

describe.skipIf(!ready)('chawo-va transcribe on real speech (opt-in)', () => {
  it('writes txt and srt into --out', async () => {
    const work = mkdtempSync(join(tmpdir(), 'chawo-cli-real-'));
    const saved = { ...process.env };
    try {
      process.env.CHAWO_APPDATA = work;
      process.env.CHAWO_LOCALAPPDATA = work;
      copyFileSync(wav, join(work, 'talk.wav'));
      const { realDeps } = await import('../src/cli');
      const { runCli } = await import('../src/cli/run');
      const deps = { ...realDeps(new AbortController().signal), err: () => undefined, out: () => undefined };
      const code = await runCli(['transcribe', join(work, 'talk.wav'), '-f', 'txt,srt', '-o', join(work, 'out'), '--model-dir', dir, '--device', 'cpu'], deps);
      expect(code).toBe(0);
      expect(readFileSync(join(work, 'out', 'talk.txt'), 'utf8').toLowerCase()).toContain(expectText);
      expect(readFileSync(join(work, 'out', 'talk.srt'), 'utf8')).toMatch(/^1\r\n00:00:00,000 --> /);
    } finally {
      process.env = saved;
      rmSync(work, { recursive: true, force: true });
    }
  }, 180_000);
});
