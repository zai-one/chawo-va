// «Перевести» for dictation and files through the Brain (local llama by default, or the user's own
// server) — IDEAS №15 / batch 2 п.7. Nothing goes to a third-party translation API.
// Pure command parsing and the prompt live in translateCommand.ts (brain.ts uses them too).

import { basename, dirname, join } from 'node:path';
import { t, isRussian } from '@chawo/core/strings';
import type { SettingsData } from '../settings';
import * as Log from '../log';
import type { AskFn, FileBrainTarget } from './fileBrain';
import { createAsk, target as brainTarget, cloudName, describe as brainDescribe } from './fileBrain';
import { splitTranscript } from './meetingBrief';
import { BrainException } from './speechCleanup';
import { defaultTarget, languageLabel, resolveLanguage, translatePrompt, type TranslateLang } from './translateCommand';

export * from './translateCommand';
export { brainTarget as target, cloudName, brainDescribe as describe };

/** One chunk per ask. Local llama-server runs a small context and the answer is as long as the input. */
export const LocalTranslateChars = 1200;
export const CloudTranslateChars = 6000;

/** name.txt / name.brain.txt → name.translate.txt (same pattern as .brief.txt). */
export function outputPath(rawTxt: string): string {
  const d = dirname(rawTxt);
  const base = basename(rawTxt);
  const withoutExt = base.includes('.') ? base.replace(/\.[^.]+$/, '') : base;
  const stem = withoutExt.endsWith('.brain') ? withoutExt.slice(0, -'.brain'.length) : withoutExt;
  return join(d, stem + '.translate.txt');
}

/**
 * The language to use: explicit (--to / UI field / command), else the saved TranslateTarget,
 * else decided from the text (see defaultTarget).
 */
export function pickTarget(explicit: string | TranslateLang | null | undefined, saved: string | null | undefined, text: string): TranslateLang {
  if (explicit && typeof explicit !== 'string') return explicit;
  return resolveLanguage(explicit) ?? resolveLanguage(saved) ?? defaultTarget(text);
}

export interface TranslateResult {
  text: string;
  target: TranslateLang;
  /** Number of Brain requests (chunks). */
  parts: number;
}

export interface TranslateRunOpts {
  text: string;
  /** Explicit language (code, name, free text, or a resolved TranslateLang); null → saved / auto. */
  to?: string | TranslateLang | null;
  /** Saved TranslateTarget; empty → auto by the text. */
  saved?: string;
  targetKind: FileBrainTarget;
  status: (line: string) => void;
  signal: AbortSignal;
  ask?: AskFn;
  /** Required when `ask` is omitted (createAsk needs it). */
  settings?: SettingsData;
  /** Dictated speech: the prompt also drops filler words. */
  spoken?: boolean;
}

function maxTokensFor(text: string, kind: FileBrainTarget): number {
  const cap = kind === 'Local' ? 1536 : 4096;
  return Math.min(cap, Math.max(256, Math.ceil(text.length * 0.9) + 128));
}

/** Drop code fences and quotes the model sometimes wraps the answer in. */
export function cleanAnswer(answer: string): string {
  let s = (answer ?? '').replace(/\r\n/g, '\n').trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  const pairs: [string, string][] = [['"', '"'], ['«', '»'], ['“', '”']];
  for (const [a, b] of pairs) {
    if (s.length > 1 && s.startsWith(a) && s.endsWith(b) && !s.slice(1, -1).includes(a) && !s.slice(1, -1).includes(b)) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

/**
 * Translate a text (file transcript or dictation) through the Brain, chunk by chunk, keeping
 * paragraph breaks. Throws BrainException when the Brain is missing, the input is empty,
 * or the model returns nothing.
 */
export async function runTranslateAsync(opts: TranslateRunOpts): Promise<TranslateResult> {
  const { targetKind, status, signal } = opts;
  if (targetKind === 'None') throw new BrainException(t('мозг не настроен', 'the Brain is not set up'));
  const text = (opts.text ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length === 0) throw new BrainException(t('пустой текст — переводить нечего', 'empty text, nothing to translate'));
  const target = pickTarget(opts.to ?? null, opts.saved, text);

  const askFn =
    opts.ask ??
    (() => {
      if (!opts.settings) throw new BrainException(t('мозг не настроен', 'the Brain is not set up'));
      return createAsk(opts.settings, targetKind);
    })();
  const prompt = translatePrompt(target, { spoken: opts.spoken });
  const pieces = splitTranscript(text, targetKind === 'Local' ? LocalTranslateChars : CloudTranslateChars);
  const label = languageLabel(target, isRussian());

  const out: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (signal.aborted) throw abortError();
    status(
      pieces.length === 1
        ? t(`Мозг: перевожу на ${label}…`, `Brain: translating into ${label}…`)
        : t(`Мозг: перевожу на ${label}, часть ${i + 1} из ${pieces.length}…`, `Brain: translating into ${label}, part ${i + 1} of ${pieces.length}…`),
    );
    let answer: string;
    try {
      answer = cleanAnswer(await askFn(prompt, pieces[i], maxTokensFor(pieces[i], targetKind), status, signal));
    } catch (ex) {
      if (signal.aborted || (ex instanceof Error && ex.name === 'AbortError')) throw ex;
      const msg = ex instanceof Error ? ex.message : String(ex);
      Log.write(`translate part ${i + 1}: ${msg}`);
      throw ex instanceof BrainException ? ex : new BrainException(msg);
    }
    if (answer.length === 0) throw new BrainException(t('нейросеть вернула пустой ответ', 'the model returned an empty answer'));
    out.push(answer);
  }
  const joined = out.join('\n\n');
  return { text: joined + '\n', target, parts: pieces.length };
}

function abortError(): Error {
  const e = new Error('Operation canceled');
  e.name = 'AbortError';
  return e;
}

export interface TranslateFileIo {
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
}

/**
 * The File page action «Перевести последнюю расшифровку»: read the .txt, translate it, write
 * name.translate.txt beside it. Returns the output path with the result.
 */
export async function translateFileAsync(
  src: string,
  opts: Omit<TranslateRunOpts, 'text'>,
  io: TranslateFileIo,
): Promise<TranslateResult & { path: string }> {
  const result = await runTranslateAsync({ ...opts, text: io.readFile(src) });
  const path = outputPath(src);
  io.writeFile(path, result.text);
  return { ...result, path };
}
