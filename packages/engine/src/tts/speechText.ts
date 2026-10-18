// Text for reading aloud: tidied and cut into pieces a speech service accepts (services cap one request,
// OpenAI at 4096 characters). Cuts fall where the text switches between Russian and English, then on
// sentence ends, then on commas or spaces, never inside a word.

/** Longest text read at once (a selection is capped at 20 000 characters by the helper anyway). */
export const MAX_SPEECH_CHARS = 20_000;

/** An address: its host is read, the rest is noise to the ear (a sentence end after it stays). */
const URL_RE = /\bhttps?:\/\/(?:www\.)?([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)(?::\d+)?(?:[/?#](?:[^\s<>"«»]*[^\s<>"«».,;:!?)\]'])?)?/giu;

/**
 * What a selection or an answer holds, as it reads aloud: invisible characters and the placeholders of
 * pictures dropped (U+FFFC), Markdown marks dropped (a link reads as its text, a picture as its caption,
 * no backticks, stars or heading hashes), an address as its host («github.com»), whitespace folded.
 * '' when nothing readable is left.
 */
export function speechInput(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF\uFFFC]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1')
    .replace(URL_RE, (_url, host: string) => host)
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/^[ \t]*(?:#{1,6}|[-*•>])[ \t]+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_SPEECH_CHARS);
}

/** A foreign stretch shorter than this many words stays in its sentence: a name or a command reads fine in place. */
const MIN_SCRIPT_RUN_WORDS = 4;

type Script = 'cyr' | 'lat' | null;

interface ScriptRun {
  script: Script;
  words: string[];
}

/** The script with more letters in `s` (a tie goes to Cyrillic); null without letters. */
function scriptOf(s: string): Script {
  const cyr = (s.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (s.match(/[A-Za-z]/g) ?? []).length;
  if (cyr === 0 && lat === 0) return null;
  return cyr >= lat ? 'cyr' : 'lat';
}

/** Adds `run` after the last run: same script (or no letters on either side) → one run. */
function append(runs: ScriptRun[], run: ScriptRun): void {
  const last = runs.at(-1);
  if (last && (last.script === run.script || run.script === null || last.script === null)) {
    last.words.push(...run.words);
    last.script ??= run.script;
  } else {
    runs.push({ script: run.script, words: [...run.words] });
  }
}

/** One sentence in runs of one script; a short stretch of the sentence's minor script stays in it. */
function sentenceRuns(sentence: string): ScriptRun[] {
  const main = scriptOf(sentence);
  const runs: ScriptRun[] = [];
  for (const token of sentence.match(/\S+\s*/g) ?? []) append(runs, { script: scriptOf(token), words: [token] });
  const out: ScriptRun[] = [];
  for (const run of runs) append(out, run.words.length < MIN_SCRIPT_RUN_WORDS ? { ...run, script: main } : run);
  return out;
}

/**
 * Text cut where it switches between Russian (Cyrillic) and English (Latin). Some services (Fish)
 * stumble on a mix of languages in one request; each part then goes alone and the sounds are joined.
 * Each sentence keeps the language most of its letters are in: a few foreign words inside it
 * («запусти npm run build») stay in place, a longer foreign stretch or a foreign sentence goes alone.
 * Nothing is lost: the parts are the text in order; text in one script comes back whole.
 */
export function splitByScript(text: string): string[] {
  const runs: ScriptRun[] = [];
  for (const sentence of text.split(/(?<=[.!?…][»"')\]]*\s+|\n)/)) {
    for (const run of sentenceRuns(sentence)) append(runs, run);
  }
  return runs.map((r) => r.words.join('').trim()).filter((p) => p.length > 0);
}

/** Pieces of at most `max` characters, split at the best boundary before the limit. */
export function splitForSpeech(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const re of [/[.!?…][»"')\]]?\s/g, /\n/g, /[,;:—–]\s/g, /\s/g]) {
      let m: RegExpExecArray | null;
      let last = -1;
      while ((m = re.exec(window)) !== null) last = m.index + m[0].length;
      if (last > max * 0.4) {
        cut = last;
        break;
      }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out.filter((p) => p.length > 0);
}
