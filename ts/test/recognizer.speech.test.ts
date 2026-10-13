// Opt-in check on real speech with the real model (not in CI: needs ~330 MB of model files).
// CHAWO_TEST_MODEL_DIR=<dir with v3_e2e_rnnt_*> CHAWO_TEST_SPEECH=<16-bit wav> CHAWO_TEST_EXPECT=<phrase> npm test
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readWav, resample } from '../src/core/audio';
import { Recognizer } from '../src/core/recognizer';

const dir = process.env.CHAWO_TEST_MODEL_DIR ?? '';
const wav = process.env.CHAWO_TEST_SPEECH ?? '';
const expectText = (process.env.CHAWO_TEST_EXPECT ?? 'русский язык').toLowerCase();
const ready = dir !== '' && wav !== '' && existsSync(wav) && Recognizer.modelExists(dir, 'v3_e2e_rnnt');

describe.skipIf(!ready)('Recognizer on real speech (opt-in)', () => {
  it('transcribes Russian with punctuation', async () => {
    let { samples, rate } = readWav(new Uint8Array(readFileSync(wav)), wav);
    if (rate !== 16000) samples = resample(samples, rate, 16000);
    const rec = await Recognizer.open(dir, 'v3_e2e_rnnt', 'cpu');
    try {
      const text = await rec.transcribe(samples, 16000);
      expect(text.toLowerCase()).toContain(expectText);
      expect(text).toMatch(/[.,]/);
    } finally {
      await rec.dispose();
    }
  }, 120_000);
});
