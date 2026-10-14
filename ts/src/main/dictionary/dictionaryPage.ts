// «Словарь» page logic: word rules applied to the finished phrase after recognition and before the
// Brain. Port of the Dictionary parts of SettingsWindow.xaml.cs (FillDictionaryRows /
// PersistDictionary / SuggestDictionary_Click / AddSuggestion_Click). No Electron imports, so the
// controller is unit-tested with a plain settings object. Suggestions from the materials folder
// are only shown; a row is written only when the user presses «В словарь».

import { existsSync, statSync } from 'node:fs';
import { isRussian, t } from '../../core/strings';
import { failureText, logLine, runPostScript, scriptCommand, type PostScriptResult, type PostScriptRun } from '../../core/postScript';
import * as Log from '../log';
import { DEFAULT_RULES, formatRules, type ReplacePair } from '../../core/wordReplace';
import { suggestDictionary, type DictSuggestion } from '../sales';
import { cleanSnippets, loadSnippets, saveSnippets, type Snippet } from '../../core/snippets';
import { snippetsPath } from '../paths';
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
  spoken: SpokenStateDto;
  script: ScriptStateDto;
  snippets: SnippetsStateDto;
}

export interface SnippetRow {
  id: number;
  trigger: string;
  text: string;
}

/** «Сниппеты»: trigger + text rows; «вставь <фраза>» during dictation puts the text in. */
export interface SnippetsStateDto {
  heading: string;
  hint: string;
  triggerHeader: string;
  textHeader: string;
  triggerPlaceholder: string;
  textPlaceholder: string;
  addLabel: string;
  rows: SnippetRow[];
}

/** «Свой скрипт»: one command field, «also for files», a check button. */
export interface ScriptStateDto {
  heading: string;
  command: string;
  placeholder: string;
  hint: string;
  files: boolean;
  filesLabel: string;
  testLabel: string;
  /** Result of the last «Проверить»: one line, empty before the first check. */
  testLine: string;
  testOk: boolean | null;
  busy: boolean;
}

/** Sample the check button sends: Russian, punctuation, a digit. */
export const SCRIPT_SAMPLE = 'Проверка скрипта: привет, Чаво, 25 тысяч.';

/** Voice punctuation and numbers: two switches under the table, nothing else to set. */
export interface SpokenStateDto {
  punctuation: boolean;
  numbers: boolean;
  punctuationLabel: string;
  punctuationHint: string;
  numbersLabel: string;
  numbersHint: string;
}

export type SpokenKind = 'punctuation' | 'numbers';

export interface DictionaryHooks {
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  /** Called after the rules were written (the WPF `_apply`). */
  changed?: () => void;
  /** Override for tests; defaults to SalesRag.suggestDictionary. */
  suggest?: (folder: string, existing: ReplacePair[]) => DictSuggestion[];
  /** Override for tests; defaults to core runPostScript. */
  runScript?: (r: PostScriptRun) => Promise<PostScriptResult>;
  /** snippets.json; defaults to the app data folder (tests pass a temp file). */
  snippetsPath?: () => string;
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
  private scriptTest: { line: string; ok: boolean } | null = null;
  private scriptBusy = false;
  private snippetRows: SnippetRow[] = [];
  /** JSON of the list last read or written; a different file content reloads the rows. */
  private seenSnippets = '';

  constructor(private readonly h: DictionaryHooks) {
    this.seenFolder = (h.settings().RagFolder ?? '').trim();
    this.load();
  }

  /** Reloads rows from settings, assigning fresh ids. */
  private load(): void {
    const s = this.h.settings();
    this.rows = dictionaryRows(s).map((p) => ({ id: this.nextId++, from: p.from, to: p.to }));
    this.seenRules = s.WordReplacementRules;
    this.loadSnippetRows();
  }

  private snipPath(): string {
    return (this.h.snippetsPath ?? snippetsPath)();
  }

  private loadSnippetRows(): void {
    const list = loadSnippets(this.snipPath());
    this.snippetRows = list.map((x) => ({ id: this.nextId++, trigger: x.trigger, text: x.text }));
    this.seenSnippets = JSON.stringify(list);
  }

  private persistSnippets(): void {
    const list: Snippet[] = cleanSnippets(this.snippetRows.map((r) => ({ trigger: r.trigger, text: r.text })));
    const json = JSON.stringify(list);
    if (json === this.seenSnippets) return;
    try {
      saveSnippets(this.snipPath(), list);
      this.seenSnippets = json;
    } catch (e) {
      Log.write(`snippets save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private snippetsState(): SnippetsStateDto {
    return {
      heading: t('Сниппеты', 'Snippets'),
      hint: t('Скажите при диктовке «вставь подпись» (или «вставить …») — вместо этих слов вставится сохранённый текст. Можно и одной фразой «подпись». Мозг и простой синтаксис текст сниппета не меняют. Хранится только на этом компьютере (snippets.json).',
        'Say «вставь <trigger>» while dictating and the saved text goes in place of those words. The trigger alone as the whole phrase works too. The Brain and simple syntax leave the snippet text alone. Stored on this computer only (snippets.json).'),
      triggerHeader: t('Фраза', 'Trigger'),
      textHeader: t('Текст', 'Text'),
      triggerPlaceholder: t('подпись', 'signature'),
      textPlaceholder: t('С уважением,\nИмя Фамилия', 'Best regards,\nName'),
      addLabel: t('Добавить сниппет', 'Add snippet'),
      rows: this.snippetRows.map((r) => ({ ...r })),
    };
  }

  setSnippet(id: number, trigger: string, text: string): DictionaryStateDto {
    this.sync();
    const row = this.snippetRows.find((r) => r.id === id);
    if (row && typeof trigger === 'string' && typeof text === 'string' && !trigger.includes('\n')) {
      row.trigger = trigger;
      row.text = text;
      this.persistSnippets();
    }
    return this.state();
  }

  addSnippet(): number {
    this.sync();
    const id = this.nextId++;
    this.snippetRows.push({ id, trigger: '', text: '' });
    return id;
  }

  removeSnippet(id: number): DictionaryStateDto {
    this.sync();
    const at = this.snippetRows.findIndex((r) => r.id === id);
    if (at >= 0) {
      this.snippetRows.splice(at, 1);
      this.persistSnippets();
    }
    return this.state();
  }

  /** Picks up outside changes: rules edited elsewhere reload rows; a new folder clears suggestions. */
  private sync(): void {
    const s = this.h.settings();
    if (s.WordReplacementRules !== this.seenRules) this.load();
    else if (JSON.stringify(loadSnippets(this.snipPath())) !== this.seenSnippets) this.loadSnippetRows();
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
      spoken: this.spokenState(),
      script: this.scriptState(),
      snippets: this.snippetsState(),
    };
  }

  private scriptState(): ScriptStateDto {
    const s = this.h.settings();
    return {
      heading: t('Свой скрипт', 'Your script'),
      command: s.PostScript ?? '',
      placeholder: t('например: python C:\\scripts\\fix.py', 'e.g. python ~/scripts/fix.py'),
      hint: t('Для тех, кто пишет код. Готовая фраза уходит скрипту на вход (stdin, UTF-8), что он напечатает — то и вставится. Последний шаг: после словаря, Мозга и простого синтаксиса. Запускается только на этом компьютере; есть переменная CHAWO_SOURCE (dictation, command, selection, file). Ошибка, пустой ответ или больше 5 с — вставляется текст без скрипта. Пустое поле — выключено.',
        'For people who write code. The finished phrase goes to the script\'s stdin (UTF-8); whatever it prints is inserted. Last step: after the dictionary, the Brain and simple syntax. Runs only on this computer; CHAWO_SOURCE is set (dictation, command, selection, file). On an error, an empty answer or more than 5 s the text goes in without the script. Empty field: off.'),
      files: s.PostScriptFiles === true,
      filesLabel: t('И для расшифровки файлов (весь .txt, до 60 с; .srt и другие форматы не меняются)',
        'Also for file transcripts (the whole .txt, up to 60 s; .srt and other formats stay as they are)'),
      testLabel: t('Проверить', 'Check'),
      testLine: this.scriptTest?.line ?? '',
      testOk: this.scriptTest?.ok ?? null,
      busy: this.scriptBusy,
    };
  }

  /** Saves the command (trimmed of line breaks; blank = off). A new command forgets the old check. */
  setScript(command: string): DictionaryStateDto {
    if (typeof command === 'string') {
      const next = command.replace(/[\r\n]+/g, ' ');
      const s = this.h.settings();
      if ((s.PostScript ?? '') !== next) {
        s.PostScript = next;
        this.h.save(s);
        this.h.changed?.();
        this.scriptTest = null;
      }
    }
    return this.state();
  }

  setScriptFiles(on: boolean): DictionaryStateDto {
    if (typeof on === 'boolean') {
      const s = this.h.settings();
      if (s.PostScriptFiles !== on) {
        s.PostScriptFiles = on;
        this.h.save(s);
        this.h.changed?.();
      }
    }
    return this.state();
  }

  /** «Проверить»: runs the saved command on a sample phrase and shows what came back. */
  async testScript(): Promise<DictionaryStateDto> {
    const cmd = scriptCommand(this.h.settings().PostScript);
    if (!cmd) {
      this.scriptTest = { line: t('Сначала впишите команду.', 'Type a command first.'), ok: false };
      return this.state();
    }
    if (this.scriptBusy) return this.state();
    this.scriptBusy = true;
    try {
      const res = await (this.h.runScript ?? runPostScript)({ command: cmd, text: SCRIPT_SAMPLE, source: 'dictation' });
      Log.write(logLine(res, 'dictation', SCRIPT_SAMPLE.length) + ' (check)');
      this.scriptTest = res.ok
        ? { line: t(`Работает (${res.ms} мс): ${res.text}`, `Works (${res.ms} ms): ${res.text}`), ok: true }
        : { line: t(`Не сработал: ${failureText(res, t)}. Фраза пошла бы без скрипта.`, `Failed: ${failureText(res, t)}. The phrase would go in without the script.`), ok: false };
    } finally {
      this.scriptBusy = false;
    }
    return this.state();
  }

  private spokenState(): SpokenStateDto {
    const s = this.h.settings();
    return {
      punctuation: s.SpokenPunctuation === true,
      numbers: s.SpokenNumbers === true,
      punctuationLabel: t('Знаки препинания голосом', 'Punctuation by voice'),
      punctuationHint: t('«запятая», «точка», «вопросительный знак», «двоеточие», «тире», «открыть/закрыть скобку», «открыть/закрыть кавычки», «новая строка», «новый абзац». «Точка зрения» и «торговая точка» остаются словами.',
        'Say «запятая», «точка», «вопросительный знак», «двоеточие», «тире», «открыть/закрыть скобку», «открыть/закрыть кавычки», «новая строка», «новый абзац». «Точка зрения» stays a word.'),
      numbersLabel: t('Числа цифрами', 'Numbers as digits'),
      numbersHint: t('«двадцать пять» → 25, «две тысячи двадцать шестого» → 2026-го. Одиночное «один» и «тысячи» без числа остаются словами. Модель v3 с пунктуацией обычно пишет цифры сама.',
        '«двадцать пять» → 25, «две тысячи двадцать шестого» → 2026-го. A lone «один» and «тысячи» without a number stay words. The v3 model with punctuation usually writes digits itself.'),
    };
  }

  /** Turns voice punctuation or numbers on or off. Saved at once; the next take uses it. */
  setSpoken(kind: SpokenKind, on: boolean): DictionaryStateDto {
    if ((kind === 'punctuation' || kind === 'numbers') && typeof on === 'boolean') {
      const s = this.h.settings();
      const key = kind === 'punctuation' ? 'SpokenPunctuation' : 'SpokenNumbers';
      if (s[key] !== on) {
        s[key] = on;
        this.h.save(s);
        this.h.changed?.();
      }
    }
    return this.state();
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
