import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CtcVocab } from '../src/ctcVocab';
import { Recognizer } from '../src/recognizer';

describe('CtcVocab', () => {
  it('loads tokens, blank, kinds and decodes ids', () => {
    const text = ['<unk> 0', 'a 1', 'б 2', '▁ 3', '<blk> 4', ''].join('\n');
    const v = CtcVocab.fromText(text);
    expect(v.count).toBe(5);
    expect(v.blankId).toBe(4);
    expect(v.kinds).toEqual(['neutral', 'latin', 'cyrillic', 'neutral', 'neutral']);
    expect(v.decode([1, 3, 2, 4, 0, 99])).toBe('a б');
  });

  it('defaults blank to last id when <blk> is missing', () => {
    const v = CtcVocab.fromText('x 0\ny 1\n');
    expect(v.blankId).toBe(1);
  });

  it('rejects an empty vocab', () => {
    expect(() => CtcVocab.fromText('# nothing\n')).toThrow(/empty CTC vocab/);
  });
});

describe('Recognizer.modelExists', () => {
  it('checks CTC and RNN-T file sets', () => {
    const root = mkdtempSync(join(tmpdir(), 'chawo-model-'));
    try {
      expect(Recognizer.modelExists(root, 'multilingual_large_ctc')).toBe(false);
      expect(Recognizer.modelExists(root, 'v3_e2e_rnnt')).toBe(false);

      for (const name of [
        'multilingual_large_ctc.onnx',
        'multilingual_large_ctc.onnx.data',
        'multilingual_large_ctc.yaml',
        'multilingual_vocab.txt',
      ]) {
        writeFileSync(join(root, name), 'x');
      }
      expect(Recognizer.modelExists(root, 'multilingual_large_ctc')).toBe(true);
      expect(Recognizer.modelExists(root, 'v3_e2e_rnnt')).toBe(false);

      const rnnt = join(root, 'rnnt');
      mkdirSync(rnnt);
      for (const name of [
        'v3_e2e_rnnt.yaml',
        'v3_e2e_rnnt_encoder.onnx',
        'v3_e2e_rnnt_decoder.onnx',
        'v3_e2e_rnnt_joint.onnx',
        'v3_e2e_rnnt_tokenizer.model',
      ]) {
        writeFileSync(join(rnnt, name), 'x');
      }
      expect(Recognizer.modelExists(rnnt, 'v3_e2e_rnnt')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Recognizer.splitRanges / pieceRanges', () => {
  it('returns one range for short audio', () => {
    const rate = 16000;
    const samples = new Float32Array(rate * 10); // 10 s < 24+1
    expect(Recognizer.splitRanges(samples, rate)).toEqual([{ from: 0, to: samples.length }]);
  });

  it('splits long audio near pauses', () => {
    const rate = 1000;
    // 60 s of speech with a pause around 20–21 s so the first 24 s chunk can cut there.
    const samples = new Float32Array(60 * rate).fill(0.5);
    samples.fill(0, 20 * rate, 21 * rate);
    const ranges = Recognizer.splitRanges(samples, rate);
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0].from).toBe(0);
    expect(ranges[ranges.length - 1].to).toBe(samples.length);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBe(ranges[i - 1].to);
    // First cut should land inside the pause window (~20.5 s).
    expect(ranges[0].to).toBeGreaterThan(20 * rate);
    expect(ranges[0].to).toBeLessThanOrEqual(24 * rate);
  });
});
