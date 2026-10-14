import { describe, expect, it } from 'vitest';
import { Tokenizer } from '../src/core/tokenizer';

/** Minimal ModelProto: repeated SentencePiece { piece = 1, score = 2 (fixed32) }. */
function model(pieces: string[]): Uint8Array {
  const out: number[] = [];
  const enc = new TextEncoder();
  for (const p of pieces) {
    const s = Array.from(enc.encode(p));
    const inner = [0x0a, s.length, ...s, 0x15, 0, 0, 0x80, 0x3f];
    out.push(0x0a, inner.length, ...inner);
  }
  out.push(0x10, 0x01); // unrelated varint field is skipped
  return Uint8Array.from(out);
}

describe('Tokenizer', () => {
  it('reads pieces and decodes ids', () => {
    const tok = new Tokenizer(model(['<unk>', '▁при', 'вет', '▁мир']));
    expect(tok.pieces.length).toBe(4);
    expect(tok.blankId).toBe(4);
    expect(tok.decode([1, 2, 0, 3, 4, 99])).toBe('привет мир');
  });

  it('rejects garbage', () => {
    expect(() => new Tokenizer(new Uint8Array([0xff]))).toThrow();
  });
});
