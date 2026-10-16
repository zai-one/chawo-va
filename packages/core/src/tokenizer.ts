// SentencePiece piece list -> text. Port of src/Core/Tokenizer.cs.
// The .model file is a protobuf; we need exactly one field, so it is parsed by hand:
//   ModelProto    { repeated SentencePiece pieces = 1 }
//   SentencePiece { optional string piece = 1 }

const utf8 = new TextDecoder('utf-8');

interface Cursor {
  i: number;
}

function varint(d: Uint8Array, c: Cursor): bigint | null {
  let value = 0n;
  let shift = 0n;
  while (c.i < d.length) {
    const b = d[c.i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return value;
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function skip(d: Uint8Array, c: Cursor, wire: number): boolean {
  switch (wire) {
    case 0:
      return varint(d, c) !== null;
    case 1:
      c.i += 8;
      return c.i <= d.length;
    case 2: {
      const len = varint(d, c);
      if (len === null || len > BigInt(d.length - c.i)) return false;
      c.i += Number(len);
      return true;
    }
    case 5:
      c.i += 4;
      return c.i <= d.length;
    default:
      return false;
  }
}

function piece(d: Uint8Array, from: number, to: number): string {
  const c: Cursor = { i: from };
  while (c.i < to) {
    const tag = varint(d, c);
    if (tag === null) break;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 1 && wire === 2) {
      const len = varint(d, c);
      if (len === null || len > BigInt(to - c.i)) break;
      return utf8.decode(d.subarray(c.i, c.i + Number(len)));
    }
    if (!skip(d, c, wire)) break;
  }
  return '';
}

export class Tokenizer {
  readonly pieces: readonly string[];

  constructor(data: Uint8Array, label = 'tokenizer') {
    const pieces: string[] = [];
    const c: Cursor = { i: 0 };
    while (c.i < data.length) {
      const tag = varint(data, c);
      if (tag === null) break;
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (field === 1 && wire === 2) {
        const len = varint(data, c);
        if (len === null || len > BigInt(data.length - c.i)) break;
        const end = c.i + Number(len);
        pieces.push(piece(data, c.i, end));
        c.i = end;
      } else if (!skip(data, c, wire)) break;
    }
    if (pieces.length === 0) throw new Error(`Could not parse tokenizer: ${label}`);
    this.pieces = pieces;
  }

  /** Id of the "blank" symbol: the model emits it when it has nothing to say. */
  get blankId(): number {
    return this.pieces.length;
  }

  /** Joins pieces; the ▁ marker means "space before this word". Skips <unk> and friends. */
  decode(ids: Iterable<number>): string {
    let out = '';
    for (const id of ids) {
      if (id >= 0 && id < this.pieces.length && !this.pieces[id].startsWith('<')) out += this.pieces[id];
    }
    return out.replace(/▁/g, ' ').trim();
  }
}
