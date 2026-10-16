// "Simplify punctuation", as on macOS 3.9: a single dictated sentence goes in like a chat reply,
// lowercase and without the closing period. Off by default: letters and documents need the period.
// Only plain dictation goes through it; Brain answers to commands and edits of a selection are
// inserted exactly as they are. Port of src/App/SimpleSyntax.cs.

const Ends = new Set(['.', '!', '?', '…', ';']);

/** char.IsUpper: Unicode uppercase letter (category Lu). */
function isUpper(c: string): boolean {
  return /^\p{Lu}$/u.test(c);
}

export function applySimpleSyntax(text: string): string {
  const t = text.trim();
  if (t.length === 0 || t.includes('\n')) return text;
  // A sentence end inside the text (not at its very end) means several sentences: leave them be.
  // Abbreviations like "т.д." fall under this too, and that is fine: no guessing for the user.
  for (const c of t.slice(0, -1)) if (Ends.has(c)) return text;

  let result = t;
  // A question or an exclamation carries meaning: only the period goes.
  if (result.endsWith('.')) result = result.slice(0, -1);
  // Leave acronyms and the like alone: lowercase only a capital that just starts the sentence.
  const firstWord = result.split(' ')[0]!;
  const allCaps = firstWord.length > 1 && firstWord === firstWord.toUpperCase();
  if (!allCaps && result.length > 0 && isUpper(result[0]!)) {
    const lower = result[0]!.toLowerCase();
    // ToLowerInvariant maps one UTF-16 char to one; keep the char when JS would expand it (e.g. İ).
    result = (lower.length === 1 ? lower : result[0]!) + result.slice(1);
  }
  return result;
}
