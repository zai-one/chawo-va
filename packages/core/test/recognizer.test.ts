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

describe('Recognizer: a cancelled live draft does not empty the next long take', () => {
  // The live draft of a long take is still running when the key is released; dictation cancels it
  // (cancelOwned) and recognizes the whole take. A take over 25 s goes in pieces, which used to stop
  // at the first one whenever any cancel had ever happened: the result was empty («Не разобрал»).
  function fake(): { rec: Recognizer; pieces: number[] } {
    const pieces: number[] = [];
    const Ctor = Recognizer as unknown as new (...a: unknown[]) => Recognizer;
    const rec = new Ctor('/m', 'v3_e2e_rnnt', { features: { sampleRate: 16000, winLength: 400 } }, {}, false);
    (rec as unknown as { transcribeChunk: (w: Float32Array) => Promise<string> }).transcribeChunk = async (w) => {
      pieces.push(w.length);
      await new Promise((r) => setTimeout(r, 1));
      return `кусок${pieces.length}`;
    };
    return { rec, pieces };
  }
  const long = () => new Float32Array(16000 * 60).fill(0.1);

  it('recognizes every piece of a 60 s take after a draft was cancelled', async () => {
    const { rec, pieces } = fake();
    (rec as unknown as { ownedRun: number }).ownedRun = 1;
    rec.cancelOwned();
    (rec as unknown as { ownedRun: number }).ownedRun = 0;
    const text = await rec.transcribeCancelable(long(), 16000, () => true);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(text.split(' ')).toHaveLength(pieces.length);
  });

  it('a cancel during the pass still stops it between pieces', async () => {
    const { rec, pieces } = fake();
    const run = rec.transcribeCancelable(long(), 16000, () => true);
    await new Promise((r) => setTimeout(r, 0));
    rec.cancelOwned();
    const text = await run;
    expect(pieces.length).toBe(1);
    expect(text).toBe('кусок1');
  });
});
