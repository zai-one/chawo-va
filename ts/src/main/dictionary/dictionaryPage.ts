// «Словарь» page logic: word rules applied to the finished phrase after recognition and before the
// Brain. Port of the Dictionary parts of SettingsWindow.xaml.cs (FillDictionaryRows /
// PersistDictionary / SuggestDictionary_Click / AddSuggestion_Click). No Electron imports, so the
// controller is unit-tested with a plain settings object. Suggestions from the materials folder
// are only shown; a row is written only when the user presses «В словарь».

import { existsSync, statSync } from 'node:fs';
import { isRussian, t } from '../../core/strings';
import { DEFAULT_RULES, formatRules, type ReplacePair } from '../../core/wordReplace';
import { suggestDictionary, type DictSuggestion } from '../sales';
import { dictionaryRows, saveDictionary, type SettingsData } from '../settings';

export interface DictRow {
  id: number;
  from: string;
  to: string;
}

export interface DictSuggestionRow extends DictSuggestion {
  id: number;
}

export type SuggestHintKind = 'idle' | 'noFolder' | 'none' | 'found';

export interface DictionaryStateDto {
  ru: boolean;
  intro: string;
  heardHeader: string;
  writtenHeader: string;
  addLabel: string;
  deleteLabel: string;
  suggestLabel: string;
  addSuggestionLabel: string;
  suggestHint: string;
  hintKind: SuggestHintKind;
  rows: DictRow[];
  suggestions: DictSuggestionRow[];
}

export interface DictionaryHooks {
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  /** Called after the rules were written (the WPF `_apply`). */
  changed?: () => void;
  /** Override for tests; defaults to SalesRag.suggestDictionary. */
  suggest?: (folder: string, existing: ReplacePair[]) => DictSuggestion[];
}

function folderExists(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** What would be stored for these rows: '#' for an empty list, like WPF PersistDictionary. */
export function formattedRules(rows: readonly ReplacePair[]): string {
  const kept = rows
    .map((r) => ({ from: r.from.trim(), to: r.to.trim() }))
    .filter((r) => r.from.length > 0 || r.to.length > 0);
  return kept.length === 0 ? '#' : formatRules(kept);
}

/** Rules currently in force: a blank settings field means the built-in defaults. */
export function currentRules(s: SettingsData): string {
  return !s.WordReplacementRules || !s.WordReplacementRules.trim() ? DEFAULT_RULES : s.WordReplacementRules;
}

export class DictionaryController {
  private rows: DictRow[] = [];
  private suggestions: DictSuggestionRow[] = [];
  private hint: SuggestHintKind = 'idle';
  /** Count shown in the «Предложено N» line; stays as found while rows are added, like WPF. */
  private foundCount = 0;
  private nextId = 1;
  /** Settings value the rows were loaded from or last written as; a different value reloads. */
  private seenRules: string | null = null;
  private seenFolder: string;

  constructor(private readonly h: DictionaryHooks) {
    this.seenFolder = (h.settings().RagFolder ?? '').trim();
    this.load();
  }

  /** Reloads rows from settings, assigning fresh ids. */
  private load(): void {
    const s = this.h.settings();
    this.rows = dictionaryRows(s).map((p) => ({ id: this.nextId++, from: p.from, to: p.to }));
    this.seenRules = s.WordReplacementRules;
  }

  /** Picks up outside changes: rules edited elsewhere reload rows; a new folder clears suggestions. */
  private sync(): void {
    const s = this.h.settings();
    if (s.WordReplacementRules !== this.seenRules) this.load();
    const folder = (s.RagFolder ?? '').trim();
    if (folder !== this.seenFolder) {
      this.seenFolder = folder;
      this.resetSuggestions();
    }
  }

  state(): DictionaryStateDto {
    this.sync();
    return {
      ru: isRussian(),
      intro: t('Готовая фраза после распознавания и до мозга. Черновик на плашке не меняется. Пустая строка не считается.',
        'The finished phrase, after recognition and before the Brain. The live draft is left alone. An empty row does nothing.'),
      heardHeader: t('Как слышно', 'Heard'),
      writtenHeader: t('Как писать', 'Written'),
      addLabel: t('Добавить', 'Add'),
      deleteLabel: t('Удалить', 'Delete'),
      suggestLabel: t('Подсказать из материалов', 'Suggest from materials'),
      addSuggestionLabel: t('В словарь', 'Add'),
      suggestHint: this.hintText(),
      hintKind: this.hint,
      rows: this.rows.map((r) => ({ ...r })),
      suggestions: this.suggestions.map((r) => ({ ...r })),
    };
  }

  private hintText(): string {
    switch (this.hint) {
      case 'noFolder':
        return t('Сначала выберите папку материалов на вкладке «Продажи».', 'Choose a materials folder on the Sales tab first.');
      case 'none':
        return t('В материалах не нашлось пар «русское рядом с латинским брендом».',
          'No Russian-next-to-Latin-brand pairs were found in the materials.');
      case 'found': {
        const n = this.foundCount;
        return t(`Предложено ${n}. Нажмите «В словарь», чтобы добавить строку. Само ничего не пишется.`,
          `Suggested ${n}. Press Add to dictionary to insert a row. Nothing is written by itself.`);
      }
      default:
        return t('Берёт латинские бренды и соседние русские слова из папки материалов на вкладке «Продажи». В словарь само не пишет — только предлагает строки.',
          'Takes Latin brands and neighboring Russian words from the materials folder on the Sales tab. Nothing is written into the dictionary until you add a row.');
    }
  }

  /** Writes the rows when the formatted rules differ from what is in force. True if it saved. */
  private persist(): boolean {
    const s = this.h.settings();
    const next = formattedRules(this.rows);
    if (next.trim() === currentRules(s).trim()) return false;
    saveDictionary(s, this.rows.map((r) => ({ from: r.from.trim(), to: r.to.trim() })));
    this.seenRules = s.WordReplacementRules;
    this.h.save(s);
    this.h.changed?.();
    return true;
  }

  setRow(id: number, from: string, to: string): DictionaryStateDto {
    this.sync();
    const row = this.rows.find((r) => r.id === id);
    if (row && typeof from === 'string' && typeof to === 'string' && !from.includes('\n') && !to.includes('\n')) {
      row.from = from;
      row.to = to;
      this.persist();
    }
    return this.state();
  }

  /** Adds an empty row (not saved until it has text). Returns its id. */
  addRow(from = '', to = ''): number {
    this.sync();
    const id = this.nextId++;
    this.rows.push({ id, from, to });
    if (from.trim() || to.trim()) this.persist();
    return id;
  }

  removeRow(id: number): DictionaryStateDto {
    this.sync();
    const at = this.rows.findIndex((r) => r.id === id);
    if (at >= 0) {
      this.rows.splice(at, 1);
      this.persist();
    }
    return this.state();
  }

  suggest(): DictionaryStateDto {
    this.sync();
    const folder = (this.h.settings().RagFolder ?? '').trim();
    if (!folder || !folderExists(folder)) {
      this.resetSuggestions();
      this.hint = 'noFolder';
      return this.state();
    }
    const existing = this.rows
      .map((r) => ({ from: r.from.trim(), to: r.to.trim() }))
      .filter((r) => r.from || r.to);
    const found = (this.h.suggest ?? suggestDictionary)(folder, existing);
    this.suggestions = found.map((s) => ({ ...s, id: this.nextId++ }));
    this.foundCount = this.suggestions.length;
    this.hint = this.suggestions.length === 0 ? 'none' : 'found';
    return this.state();
  }

  /** «В словарь»: appends the row, saves, and drops that suggestion from the list. */
  addSuggestion(heard: string, written: string): DictionaryStateDto {
    if (typeof heard !== 'string' || typeof written !== 'string' || (!heard.trim() && !written.trim())) return this.state();
    this.addRow(heard.trim(), written.trim());
    const at = this.suggestions.findIndex((s) => s.heard === heard && s.written === written);
    if (at >= 0) this.suggestions.splice(at, 1);
    return this.state();
  }

  private resetSuggestions(): void {
    this.suggestions = [];
    this.hint = 'idle';
    this.foundCount = 0;
  }

  clearSuggestions(): DictionaryStateDto {
    this.resetSuggestions();
    return this.state();
  }
}
