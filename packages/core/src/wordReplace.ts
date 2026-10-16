// Spoken brand words the neural vocab will not spell. Port of src/App/WordReplace.cs.
// Applied to the finished phrase only, after recognition and before the Brain.
// Matching is whole-word and ignores case, so "Цпу" and "цпу" both become CPU.

export interface ReplacePair {
  from: string;
  to: string;
}

export const DEFAULT_RULES =
  'цпу -> CPU\n' +
  'сипиу -> CPU\n' +
  'гпу -> GPU\n' +
  'джипию -> GPU\n' +
  'таптейн -> Taptain\n' +
  'таптэйн -> Taptain\n' +
  'чаво -> Chawo\n';

export function parseRules(rules: string | null | undefined): ReplacePair[] {
  const list: ReplacePair[] = [];
  if (!rules || !rules.trim() || rules.trim() === '#') return list;
  for (const raw of rules.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let cut = line.indexOf('->');
    let width = 2;
    if (cut < 0) cut = line.indexOf('=>');
    if (cut < 0) {
      cut = line.indexOf('=');
      width = 1;
    }
    if (cut < 0) continue;
    const from = line.slice(0, cut).trim();
    const to = line.slice(cut + width).trim();
    if (!from && !to) continue;
    list.push({ from, to });
  }
  return list;
}

export function formatRules(rows: Iterable<ReplacePair>): string {
  let out = '';
  for (const row of rows) {
    const from = row.from.trim();
    const to = row.to.trim();
    if (!from && !to) continue;
    if (from.includes('\n') || to.includes('\n')) continue;
    out += `${from} -> ${to}\n`;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

let cachedRules: string | null = null;
let cached: { re: RegExp; to: string }[] = [];

function compiled(rules: string): { re: RegExp; to: string }[] {
  if (rules === cachedRules) return cached;
  cached = parseRules(rules)
    .filter((p) => p.from && p.to)
    .sort((a, b) => b.from.length - a.from.length)
    .map((p) => ({
      re: new RegExp(`(?<![\\p{L}\\p{N}_\\-])${escapeRe(p.from)}(?![\\p{L}\\p{N}_\\-])`, 'giu'),
      to: p.to,
    }));
  cachedRules = rules;
  return cached;
}

export function applyRules(text: string, rules: string | null | undefined): string {
  if (!text || !rules || !rules.trim() || rules.trim() === '#') return text;
  for (const { re, to } of compiled(rules)) text = text.replace(re, () => to);
  return text;
}
