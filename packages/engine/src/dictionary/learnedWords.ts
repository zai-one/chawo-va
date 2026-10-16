// Glue between a fixed text and «Словарь»: counts the fixes in learned-words.json and, when
// «Добавлять сами» is on, writes ready pairs into the dictionary rules in settings.

import { statSync } from 'node:fs';
import { dropPending, learnEdit, loadLearned, saveLearned, withPending } from '@chawo/core/selfDictionary';
import type { ReplacePair } from '@chawo/core/wordReplace';
import * as Log from '../log';
import { learnedWordsPath } from '../paths';
import { dictionaryRows, saveDictionary, type SettingsData } from '../settings';

export interface LearnResult {
  added: ReplacePair[];
  suggested: ReplacePair[];
}

export function learnFromEdit(
  settings: SettingsData,
  save: (s: SettingsData) => void,
  before: string,
  after: string,
  path: string = learnedWordsPath(),
  now: number = Date.now(),
): LearnResult {
  try {
    applyPendingRules(settings, save, path, true);
    const r = learnEdit(loadLearned(path), dictionaryRows(settings), before, after, now);
    if (r.fixes.length === 0) return { added: [], suggested: [] };
    saveLearned(path, r.data);
    if (r.rules) {
      saveDictionary(settings, r.rules);
      save(settings);
    }
    Log.write(`learned words: ${r.fixes.length} fixes, ${r.added.length} added, ${r.suggested.length} suggested`);
    return { added: r.added, suggested: r.suggested };
  } catch (e) {
    Log.write(`learned words failed: ${e instanceof Error ? e.message : String(e)}`);
    return { added: [], suggested: [] };
  }
}

const seenMtime = new Map<string, number>();

/**
 * Moves rules the CLI queued in learned-words.json (`chawo-va dictionary accept`) into the settings
 * rules and clears the queue. Cheap: re-reads only when the file changed. True if settings changed.
 */
export function applyPendingRules(settings: SettingsData, save: (s: SettingsData) => void, path: string = learnedWordsPath(), force = false): boolean {
  try {
    let mtime = -1;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return false;
    }
    if (!force && seenMtime.get(path) === mtime) return false;
    seenMtime.set(path, mtime);
    const d = loadLearned(path);
    if (!d.pending || d.pending.length === 0) return false;
    saveDictionary(settings, withPending(dictionaryRows(settings), d));
    save(settings);
    // Re-read: the CLI may have queued more rows meanwhile; only the applied ones leave the queue.
    saveLearned(path, dropPending(loadLearned(path), d.pending));
    seenMtime.set(path, statSync(path).mtimeMs);
    Log.write(`learned words: ${d.pending.length} rules from the command line`);
    return true;
  } catch (e) {
    Log.write(`learned words pending failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
