// CTC token list for multilingual_large_ctc. Nested class in the WPF Recognizer; separate module here.

import { readFileSync } from 'node:fs';
import { classify, type TokenKind } from './ctcScriptDecoder';

export class CtcVocab {
  private readonly tokens: string[];
  readonly blankId: number;
  readonly kinds: TokenKind[];

  private constructor(tokens: string[], blank: number) {
    this.tokens = tokens;
    this.blankId = blank;
    this.kinds = tokens.map((t) => classify(t));
  }

  get count(): number {
    return this.tokens.length;
  }

  /** Loads "token id" lines (token may contain spaces; id is the last field). */
  static load(path: string): CtcVocab {
    return CtcVocab.fromText(readFileSync(path, 'utf8'), path);
  }

  static fromText(text: string, label = 'vocab'): CtcVocab {
    const lines = text.split(/\n/);
    let tokens: (string | undefined)[] = new Array(Math.max(1, lines.length));
    let blank = -1;
    let n = 0;
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (line.length === 0) continue;
      const sp = line.lastIndexOf(' ');
      if (sp <= 0) continue;
      const id = Number(line.slice(sp + 1));
      if (!Number.isInteger(id) || id < 0) continue;
      const token = line.slice(0, sp);
      if (id >= tokens.length) {
        const bigger = new Array(id + 1);
        for (let i = 0; i < tokens.length; i++) bigger[i] = tokens[i];
        tokens = bigger;
      }
      tokens[id] = token;
      if (token === '<blk>') blank = id;
      n = Math.max(n, id + 1);
    }
    if (n === 0) throw new Error(`empty CTC vocab: ${label}`);
    if (blank < 0) blank = n - 1;
    const fixed: string[] = new Array(n);
    for (let i = 0; i < n; i++) fixed[i] = tokens[i] ?? '';
    return new CtcVocab(fixed, blank);
  }

  decode(ids: Iterable<number>): string {
    let out = '';
    for (const id of ids) {
      if (id < 0 || id >= this.tokens.length || id === this.blankId) continue;
      const token = this.tokens[id];
      if (token.startsWith('<')) continue;
      out += token;
    }
    return out.replace(/▁/g, ' ').trim();
  }
}
