// Voice punctuation and spoken numbers for dictation (IDEAS №9, approved batch 2 item 1).
// Applied to the finished phrase after the dictionary and before the Brain, only when the user
// turned it on in «Словарь». Pure functions, no Electron: unit-tested with a table of phrases.
//
// The Russian v3 models already put their own commas and periods, so a spoken «запятая» usually
// arrives as «Привет, запятая, как дела.». Each command therefore swallows the model's punctuation
// on both sides and leaves exactly one mark. Sentence ends capitalize the next word; a comma after
// a model-made sentence end lowers the capital the model gave the next word.

type Kind = 'close' | 'open' | 'closer' | 'dash' | 'hyphen' | 'line';

interface Cmd {
  words: string[];
  mark: string;
  kind: Kind;
  /** Starts a new sentence: the next letter becomes a capital. */
  end?: boolean;
}

const CMDS: Cmd[] = [
  { words: ['точка с запятой'], mark: ';', kind: 'close' },
  { words: ['запятая', 'запятую'], mark: ',', kind: 'close' },
  { words: ['точка'], mark: '.', kind: 'close', end: true },
  { words: ['двоеточие'], mark: ':', kind: 'close' },
  { words: ['вопросительный знак', 'знак вопроса'], mark: '?', kind: 'close', end: true },
  { words: ['восклицательный знак', 'знак восклицания'], mark: '!', kind: 'close', end: true },
  { words: ['многоточие'], mark: '…', kind: 'close', end: true },
  { words: ['тире'], mark: '—', kind: 'dash' },
  { words: ['дефис'], mark: '-', kind: 'hyphen' },
  { words: ['открыть скобку', 'открой скобку', 'скобка открывается', 'открывающая скобка'], mark: '(', kind: 'open' },
  { words: ['закрыть скобку', 'закрой скобку', 'скобка закрывается', 'закрывающая скобка'], mark: ')', kind: 'closer' },
  { words: ['открыть кавычки', 'открой кавычки', 'кавычки открываются', 'открыть кавычку'], mark: '«', kind: 'open' },
  { words: ['закрыть кавычки', 'закрой кавычки', 'кавычки закрываются', 'закрыть кавычку'], mark: '»', kind: 'closer' },
  { words: ['новый абзац', 'с нового абзаца'], mark: '\n\n', kind: 'line', end: true },
  { words: ['новая строка', 'новую строку', 'с новой строки'], mark: '\n', kind: 'line', end: true },
];

/** «точка» as a plain noun: «точка зрения», «торговая точка», «на точке». Left as a word. */
const POINT_NEXT = new Set([
  'зрения', 'доступа', 'опоры', 'отсчёта', 'отсчета', 'кипения', 'замерзания', 'продаж', 'роста',
  'входа', 'выхода', 'невозврата', 'останова', 'сборки', 'контакта', 'росы', 'встречи', 'на', 'ру', 'ком',
]);
const POINT_PREV = new Set([
  'в', 'на', 'до', 'от', 'за', 'через', 'эта', 'та', 'одна', 'каждая', 'наша', 'ваша', 'моя', 'твоя',
  'какая', 'такая', 'любая', 'новая', 'та', 'эту', 'ту', 'нашу',
]);

const LETTER = /[\p{L}\p{N}]/u;
const MODEL_MARKS = ',.;:!?…';
const SENTENCE_END = '.!?…';

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

interface Compiled {
  re: RegExp;
  byPhrase: Map<string, Cmd>;
}

let compiled: Compiled | null = null;

function compile(): Compiled {
  if (compiled) return compiled;
  const byPhrase = new Map<string, Cmd>();
  for (const c of CMDS) for (const w of c.words) byPhrase.set(norm(w), c);
  const phrases = [...byPhrase.keys()].sort((a, b) => b.length - a.length)
    // The model may put a comma inside a two-word command: «точка, с запятой».
    .map((p) => p.split(' ').map((w) => w.replace(/е/g, '[её]')).join('[\\s,]+'));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${phrases.join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
  compiled = { re, byPhrase };
  return compiled;
}

function lastWord(s: string): string {
  const m = /([\p{L}\p{N}-]+)[^\p{L}\p{N}]*$/u.exec(s);
  return m ? norm(m[1]!) : '';
}

function nextWord(s: string): string {
  const m = /^[^\p{L}\p{N}]*([\p{L}\p{N}-]+)/u.exec(s);
  return m ? norm(m[1]!) : '';
}

function upperFirstLetter(s: string): string {
  const i = s.search(/\p{L}/u);
  if (i < 0) return s;
  const up = s[i]!.toUpperCase();
  return up.length === 1 ? s.slice(0, i) + up + s.slice(i + 1) : s;
}

/** Lowers the first letter unless the word is an acronym (CPU, ООО). */
function lowerFirstLetter(s: string): string {
  const m = /^(\s*)(\p{L}[\p{L}\p{N}-]*)/u.exec(s);
  if (!m) return s;
  const word = m[2]!;
  if (word.length > 1 && word === word.toUpperCase()) return s;
  const low = word[0]!.toLowerCase();
  if (low.length !== 1) return s;
  return m[1]! + low + word.slice(1) + s.slice(m[0].length);
}

function trimEnd(s: string, chars: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || chars.includes(s[i - 1]!))) i--;
  return s.slice(0, i);
}

/** Replaces spoken punctuation commands with marks. Text without commands comes back unchanged. */
export function applySpokenPunctuation(text: string): string {
  if (!text) return text;
  const { re, byPhrase } = compile();
  re.lastIndex = 0;
  let out = '';
  let at = 0;
  let any = false;
  // What the next piece of text must do with its first letter.
  let pending: 'upper' | 'lower' | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const phrase = norm(m[0]).replace(/[\s,]+/g, ' ');
    const cmd = byPhrase.get(phrase);
    if (!cmd) continue;
    const before = text.slice(at, m.index);
    const after = text.slice(m.index + m[0].length);
    if (cmd.mark === '.') {
      const prev = lastWord(before);
      const next = nextWord(after);
      const prevChunk = before.trimEnd();
      const glued = prevChunk.length > 0 && !MODEL_MARKS.includes(prevChunk[prevChunk.length - 1]!);
      if (POINT_NEXT.has(next) && !/^\s*[.,!?…]/.test(after)) continue;
      if (glued && (POINT_PREV.has(prev) || /(ая|яя)$/.test(prev))) continue;
    }
    any = true;
    out += pending ? fix(before, pending) : before;
    pending = null;
    // The model's own mark right before the command; a sentence end there made it capitalize.
    switch (cmd.kind) {
      case 'close':
        out = trimEnd(out, MODEL_MARKS) + cmd.mark;
        break;
      case 'closer':
        out = trimEnd(out, ',;:') + cmd.mark;
        break;
      case 'open': {
        out = out.replace(/ +$/, '');
        if (out.length > 0 && !/[\s(«]$/.test(out)) out += ' ';
        out += cmd.mark;
        break;
      }
      case 'dash':
        out = trimEnd(out, ',') + (out.length > 0 ? ' ' : '') + cmd.mark;
        break;
      case 'hyphen':
        out = out.replace(/ +$/, '') + cmd.mark;
        break;
      case 'line':
        out = trimEnd(out, ',') + cmd.mark;
        break;
    }
    // Swallow the model's marks after the command (but a closer keeps a meaningful mark after it).
    let rest = text.slice(m.index + m[0].length);
    const skipped = /^[\s,.;:!?…]*/.exec(rest)![0];
    const modelEnded = [...skipped].some((c) => SENTENCE_END.includes(c));
    let cut = skipped.length;
    if (cmd.kind === 'closer') cut = /^\s*/.exec(rest)![0].length;
    rest = rest.slice(cut);
    at = m.index + m[0].length + cut;
    re.lastIndex = at;
    const hasMore = rest.length > 0;
    if (hasMore && cmd.kind !== 'open' && cmd.kind !== 'hyphen' && cmd.kind !== 'line' && LETTER.test(rest[0]!)) out += ' ';
    else if (hasMore && cmd.kind === 'closer' && !/^[\s,.;:!?…)»]/.test(rest)) out += ' ';
    if (cmd.end) pending = 'upper';
    else if (modelEnded && cmd.kind !== 'closer') pending = 'lower';
  }
  if (!any) return text;
  out += pending ? fix(text.slice(at), pending) : text.slice(at);
  // A phrase that starts with a command: no leading space, first letter as the model gave it.
  return out.replace(/^ +/, '').replace(/[ \t]+\n/g, '\n');
}

function fix(s: string, how: 'upper' | 'lower'): string {
  return how === 'upper' ? upperFirstLetter(s) : lowerFirstLetter(s);
}

// ── Spoken numbers → digits ──────────────────────────────────────────

interface NumWord {
  value: number;
  kind: 'unit' | 'teen' | 'ten' | 'hundred' | 'scale';
}

const NUM = new Map<string, NumWord>();
function put(kind: NumWord['kind'], value: number, ...forms: string[]) {
  for (const f of forms) NUM.set(norm(f), { value, kind });
}
put('unit', 0, 'ноль', 'нуль', 'ноля', 'нуля');
put('unit', 1, 'один', 'одна', 'одно', 'одну', 'одного', 'одной', 'одному', 'одним', 'одном');
put('unit', 2, 'два', 'две', 'двух', 'двум', 'двумя');
put('unit', 3, 'три', 'трех', 'трем', 'тремя');
put('unit', 4, 'четыре', 'четырех', 'четырем', 'четырьмя');
put('unit', 5, 'пять', 'пяти', 'пятью');
put('unit', 6, 'шесть', 'шести', 'шестью');
put('unit', 7, 'семь', 'семи');
put('unit', 8, 'восемь', 'восьми', 'восемью');
put('unit', 9, 'девять', 'девяти', 'девятью');
const TEENS = ['десят', 'одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат', 'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат'];
TEENS.forEach((stem, i) => put('teen', 10 + i, stem + 'ь', stem + 'и', stem + 'ью'));
put('ten', 20, 'двадцать', 'двадцати', 'двадцатью');
put('ten', 30, 'тридцать', 'тридцати', 'тридцатью');
put('ten', 40, 'сорок', 'сорока');
put('ten', 50, 'пятьдесят', 'пятидесяти', 'пятьюдесятью');
put('ten', 60, 'шестьдесят', 'шестидесяти', 'шестьюдесятью');
put('ten', 70, 'семьдесят', 'семидесяти', 'семьюдесятью');
put('ten', 80, 'восемьдесят', 'восьмидесяти', 'восемьюдесятью');
put('ten', 90, 'девяносто', 'девяноста');
put('hundred', 100, 'сто', 'ста');
put('hundred', 200, 'двести', 'двухсот', 'двумстам', 'двумястами', 'двухстах');
put('hundred', 300, 'триста', 'трехсот', 'тремстам', 'тремястами', 'трехстах');
put('hundred', 400, 'четыреста', 'четырехсот', 'четырехстам', 'четырьмястами', 'четырехстах');
for (const [n, gen, dat] of [[5, 'пят', 'пяти'], [6, 'шест', 'шести'], [7, 'сем', 'семи'], [8, 'восьм', 'восьми'], [9, 'девят', 'девяти']] as const) {
  const nom = { 5: 'пятьсот', 6: 'шестьсот', 7: 'семьсот', 8: 'восемьсот', 9: 'девятьсот' }[n];
  put('hundred', n * 100, nom, gen + 'исот', dat + 'стам', dat + 'стах');
}
put('scale', 1000, 'тысяча', 'тысячи', 'тысяч', 'тысячу', 'тысячей', 'тысячам', 'тысячами', 'тысячах');
put('scale', 1_000_000, 'миллион', 'миллиона', 'миллионов', 'миллиону', 'миллионом', 'миллионам', 'миллионами', 'миллионах', 'миллионе');
put('scale', 1_000_000_000, 'миллиард', 'миллиарда', 'миллиардов', 'миллиарду', 'миллиардом', 'миллиардам', 'миллиардами', 'миллиардах', 'миллиарде');

/** Ordinal stems that may close a multi-word number: «двадцать пятое» → «25-е». */
const ORD_STEMS: [string, number, NumWord['kind']][] = [
  ['перв', 1, 'unit'], ['втор', 2, 'unit'], ['трет', 3, 'unit'], ['четверт', 4, 'unit'], ['пят', 5, 'unit'],
  ['шест', 6, 'unit'], ['седьм', 7, 'unit'], ['восьм', 8, 'unit'], ['девят', 9, 'unit'],
  ['десят', 10, 'teen'], ['одиннадцат', 11, 'teen'], ['двенадцат', 12, 'teen'], ['тринадцат', 13, 'teen'],
  ['четырнадцат', 14, 'teen'], ['пятнадцат', 15, 'teen'], ['шестнадцат', 16, 'teen'], ['семнадцат', 17, 'teen'],
  ['восемнадцат', 18, 'teen'], ['девятнадцат', 19, 'teen'],
  ['двадцат', 20, 'ten'], ['тридцат', 30, 'ten'], ['сороков', 40, 'ten'], ['пятидесят', 50, 'ten'],
  ['шестидесят', 60, 'ten'], ['семидесят', 70, 'ten'], ['восьмидесят', 80, 'ten'], ['девяност', 90, 'ten'],
  ['сот', 100, 'hundred'], ['двухсот', 200, 'hundred'], ['трехсот', 300, 'hundred'], ['четырехсот', 400, 'hundred'],
  ['пятисот', 500, 'hundred'], ['шестисот', 600, 'hundred'], ['семисот', 700, 'hundred'], ['восьмисот', 800, 'hundred'],
  ['девятисот', 900, 'hundred'], ['тысячн', 1000, 'scale'], ['миллионн', 1_000_000, 'scale'],
];
const ORD_ENDINGS: [string, string][] = [
  ['ого', 'го'], ['его', 'го'], ['ому', 'му'], ['ему', 'му'], ['ыми', 'ми'], ['ими', 'ми'],
  ['ый', 'й'], ['ой', 'й'], ['ий', 'й'], ['ая', 'я'], ['яя', 'я'], ['ое', 'е'], ['ее', 'е'],
  ['ую', 'ю'], ['юю', 'ю'], ['ых', 'х'], ['их', 'х'], ['ым', 'м'], ['им', 'м'], ['ом', 'м'], ['ем', 'м'], ['ые', 'е'], ['ие', 'е'],
];

function ordinal(word: string): { value: number; kind: NumWord['kind']; suffix: string } | null {
  for (const [end, suffix] of ORD_ENDINGS) {
    if (!word.endsWith(end)) continue;
    const stem = word.slice(0, -end.length);
    const hit = ORD_STEMS.find(([s]) => s === stem);
    if (hit) return { value: hit[1], kind: hit[2], suffix };
  }
  return null;
}

/** Builds one number from words, left to right, Russian order (hundreds, tens, units, scale). */
class NumBuilder {
  private total = 0;
  private group = 0; // below 1000, before a scale word
  private lastScale = Infinity;
  private last: NumWord['kind'] | null = null;
  private hundred = false;
  private ten = false;
  private unit = false;

  canTake(w: NumWord): boolean {
    if (this.last === null) return true;
    switch (w.kind) {
      case 'hundred':
        return !this.hundred && !this.ten && !this.unit;
      case 'ten':
      case 'teen':
        return !this.ten && !this.unit;
      case 'unit':
        return !this.unit && w.value !== 0;
      case 'scale':
        return w.value < this.lastScale && (this.hundred || this.ten || this.unit);
    }
  }

  take(w: NumWord): void {
    if (w.kind === 'scale') {
      this.total += (this.group || 1) * w.value;
      this.group = 0;
      this.lastScale = w.value;
      this.hundred = this.ten = this.unit = false;
    } else {
      this.group += w.value;
      if (w.kind === 'hundred') this.hundred = true;
      else if (w.kind === 'ten') this.ten = true;
      else if (w.kind === 'teen') this.ten = this.unit = true;
      else this.unit = true;
      // «ноль» never starts a longer number: «ноль пять» is two numbers.
      if (w.kind === 'unit' && w.value === 0) this.hundred = this.ten = true;
    }
    this.last = w.kind;
  }

  value(): number {
    return this.total + this.group;
  }
}

const TOKEN = /([\p{L}]+)|([^\p{L}]+)/gu;
const LONE_KEEP = new Set(['один', 'одна', 'одно', 'одну', 'одного', 'одной', 'одному', 'одним', 'одном', 'нуль']);

/** Spoken cardinal numbers → digits: «двадцать пять» → «25», «две тысячи двадцать шестого» → «2026-го». */
export function applySpokenNumbers(text: string): string {
  if (!text) return text;
  const toks: { s: string; word: boolean }[] = [];
  for (const m of text.matchAll(TOKEN)) toks.push({ s: m[0], word: m[1] !== undefined });
  let out = '';
  let i = 0;
  let changed = false;
  while (i < toks.length) {
    const tk = toks[i]!;
    const w = tk.word ? NUM.get(norm(tk.s)) : undefined;
    if (!w) {
      out += tk.s;
      i++;
      continue;
    }
    // Collect the longest run: number words separated by plain spaces only.
    const b = new NumBuilder();
    b.take(w);
    let j = i + 1;
    let end = i; // index of the last token in the number
    let suffix = '';
    while (j + 1 < toks.length && /^ +$/.test(toks[j]!.s) && toks[j + 1]!.word) {
      const word = norm(toks[j + 1]!.s);
      const nw = NUM.get(word);
      if (nw && b.canTake(nw)) {
        b.take(nw);
        end = j + 1;
        j += 2;
        continue;
      }
      const ord = ordinal(word);
      if (ord && b.canTake({ value: ord.value, kind: ord.kind })) {
        b.take({ value: ord.value, kind: ord.kind });
        suffix = '-' + ord.suffix;
        end = j + 1;
      }
      break;
    }
    const lone = end === i;
    const first = norm(tk.s);
    if (lone && (LONE_KEEP.has(first) || w.kind === 'scale')) {
      out += tk.s;
      i++;
      continue;
    }
    // A scale word that ends the run without digits before it stays a word: «тысячи людей».
    out += String(b.value()) + suffix;
    changed = true;
    i = end + 1;
  }
  return changed ? out : text;
}

export interface SpokenOptions {
  SpokenPunctuation?: boolean;
  SpokenNumbers?: boolean;
}

/** Both passes in order, each only when switched on. */
export function applySpoken(text: string, s: SpokenOptions): string {
  let t = text;
  if (s.SpokenPunctuation) t = applySpokenPunctuation(t);
  if (s.SpokenNumbers) t = applySpokenNumbers(t);
  return t;
}
