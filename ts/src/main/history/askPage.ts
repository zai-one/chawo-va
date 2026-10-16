// «Спросить историю» block on the «История» page: a question over dictation phrases and meeting /
// file transcripts. The search is local (core/askHistory); only the question and the found
// excerpts go to the Brain, and a cloud Brain asks first. No Electron imports: folders dialog,
// confirm, clipboard, file opening and the Brain come in as hooks, so it is unit-tested.

import { t, isRussian } from '../../core/strings';
import * as Ask from '../../core/askHistory';
import { keepMs, type HistoryStore } from './historyStore';
import { loadSources, parseFolders } from './askSources';
import type { SettingsData } from '../settings';
import { BrainException } from '../brain/speechCleanup';
import * as Log from '../log';

export interface AskExcerptDto {
  n: number;
  title: string;
  when: string;
  path: string | null;
  text: string;
  cited: boolean;
}

export interface AskStateDto {
  ru: boolean;
  title: string;
  placeholder: string;
  question: string;
  busy: boolean;
  status: string;
  answer: string | null;
  excerpts: AskExcerptDto[];
  useHistory: boolean;
  /** Always searched (read-only line). */
  meetingFolders: string[];
  /** Settings.AskFolders. */
  folders: string[];
  /** Where the answer is made: «Мозг на этом компьютере (…)», «облако …», or no Brain. */
  brainLine: string;
  labels: { ask: string; cancel: string; history: string; meetings: string; addFolder: string; remove: string; copy: string; open: string; sources: string; where: string };
}

export interface AskBrainInfo {
  target: 'None' | 'Local' | 'Cloud';
  /** Cloud service name when the text leaves this PC, else null. */
  cloud: string | null;
  /** One line: where the answer is made. */
  describe: string;
  ask: Ask.AskFn;
}

export interface AskHooks {
  store: HistoryStore;
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  meetingFolders: () => string[];
  brain: (s: SettingsData) => AskBrainInfo;
  pickFolder?: () => Promise<string | null>;
  confirm?: (message: string) => Promise<boolean>;
  copy?: (text: string) => void | Promise<void>;
  open?: (path: string) => void;
  push?: () => void;
  now?: () => number;
}

export class AskController {
  private question = '';
  private busy: AbortController | null = null;
  private status = '';
  private result: Ask.AskResult | null = null;
  private useHistory = true;

  constructor(private readonly h: AskHooks) {}

  private push(): void {
    this.h.push?.();
  }

  state(): AskStateDto {
    const s = this.h.settings();
    const b = this.h.brain(s);
    const r = this.result;
    return {
      ru: isRussian(),
      title: t('Спросить историю', 'Ask history'),
      placeholder: t('Например: что обещали клиенту Иванову?', 'E.g.: what did we promise client Ivanov?'),
      question: this.question,
      busy: this.busy !== null,
      status: this.status,
      answer: r?.answer ?? null,
      excerpts: (r?.excerpts ?? []).map((e) => ({
        n: e.n,
        title: e.title,
        when: Ask.dateText(e.when),
        path: e.path,
        text: e.text,
        cited: r?.cited.includes(e.n) ?? false,
      })),
      useHistory: this.useHistory,
      meetingFolders: this.h.meetingFolders(),
      folders: parseFolders(s.AskFolders),
      brainLine: b.target === 'None'
        ? t('Мозг не настроен: покажу найденные отрывки без ответа.', 'The Brain is not set up: the found excerpts are shown without an answer.')
        : t(`Ответ: ${b.describe}. Уходят только вопрос и найденные отрывки.`, `Answer: ${b.describe}. Only the question and the found excerpts are sent.`),
      labels: {
        ask: t('Спросить', 'Ask'),
        cancel: t('Отмена', 'Cancel'),
        history: t('Фразы диктовки', 'Dictation phrases'),
        meetings: t('Встречи', 'Meetings'),
        addFolder: t('+ папка', '+ folder'),
        remove: t('убрать', 'remove'),
        copy: t('Копировать ответ', 'Copy the answer'),
        open: t('Открыть', 'Open'),
        sources: t('Источники', 'Sources'),
        where: t('Где искать:', 'Search in:'),
      },
    };
  }

  setHistory(on: boolean): AskStateDto {
    this.useHistory = on;
    return this.state();
  }

  async addFolder(): Promise<AskStateDto> {
    const p = await this.h.pickFolder?.();
    if (p) {
      const s = this.h.settings();
      const list = parseFolders(s.AskFolders);
      if (!list.includes(p)) {
        s.AskFolders = [...list, p].join('\n');
        this.h.save(s);
      }
    }
    return this.state();
  }

  removeFolder(path: string): AskStateDto {
    const s = this.h.settings();
    const list = parseFolders(s.AskFolders);
    if (list.includes(path)) {
      s.AskFolders = list.filter((x) => x !== path).join('\n');
      this.h.save(s);
    }
    return this.state();
  }

  async copyAnswer(): Promise<AskStateDto> {
    const a = this.result?.answer;
    if (a) {
      try {
        await this.h.copy?.(a);
        this.status = t('Ответ скопирован.', 'The answer is copied.');
      } catch {
        this.status = t('В буфер обмена скопировать не получилось.', 'Could not copy to the clipboard.');
      }
    }
    return this.state();
  }

  /** Opens a transcript the excerpt came from (only paths from the last result). */
  openSource(path: string): AskStateDto {
    if (this.result?.excerpts.some((e) => e.path === path)) this.h.open?.(path);
    return this.state();
  }

  cancel(): AskStateDto {
    this.busy?.abort();
    return this.state();
  }

  async ask(question: string): Promise<AskStateDto> {
    const q = question.trim().slice(0, Ask.MAX_QUESTION);
    this.question = q;
    if (!q || this.busy) return this.state();
    const s = this.h.settings();
    const now = (this.h.now ?? Date.now)();
    const keep = s.HistoryKeep;
    const history = this.useHistory && keep !== 'Off' ? this.h.store.list('').filter((e) => e.ts >= now - keepMs(keep)) : [];
    const sources = loadSources({ history, inputs: [...this.h.meetingFolders(), ...parseFolders(s.AskFolders)] }, t);
    if (sources.length === 0) {
      this.result = null;
      this.status = t('Искать негде: нет фраз диктовки и расшифровок. Добавьте папку с расшифровками.', 'Nothing to search: no dictation phrases and no transcripts. Add a folder with transcripts.');
      return this.state();
    }
    const b = this.h.brain(s);
    let useBrain = b.target !== 'None';
    if (useBrain && b.cloud && this.h.confirm) {
      const ok = await this.h.confirm(t(`Вопрос и найденные отрывки уйдут в ${b.cloud}. Спросить?`, `The question and the found excerpts will go to ${b.cloud}. Ask?`));
      if (!ok) useBrain = false;
    }
    const abort = new AbortController();
    this.busy = abort;
    this.status = useBrain ? t('Ищу и спрашиваю Мозг…', 'Searching and asking the Brain…') : t('Ищу…', 'Searching…');
    this.push();
    try {
      const r = await Ask.runAsk({
        question: q,
        sources,
        ask: useBrain ? b.ask : null,
        budget: b.target === 'Cloud' ? Ask.CLOUD_CONTEXT_CHARS : Ask.LOCAL_CONTEXT_CHARS,
        status: (line) => {
          this.status = line;
          this.push();
        },
        signal: abort.signal,
      });
      this.result = r;
      this.status = r.excerpts.length === 0
        ? t(`Ничего не нашлось (источников: ${r.sources}).`, `Nothing found (${r.sources} sources).`)
        : t(`Отрывков: ${r.excerpts.length} из ${r.passages} (источников: ${r.sources}).`, `${r.excerpts.length} excerpts of ${r.passages} (${r.sources} sources).`);
      Log.write(`ask sources=${r.sources} excerpts=${r.excerpts.length} brain=${r.answer ? 'yes' : 'no'}`);
    } catch (e) {
      if (abort.signal.aborted) this.status = t('Отменено.', 'Cancelled.');
      else {
        const msg = e instanceof BrainException || e instanceof Error ? e.message : String(e);
        Log.write(`ask failed: ${msg}`);
        this.status = t(`Мозг не ответил: ${msg}`, `The Brain did not answer: ${msg}`);
      }
    } finally {
      if (this.busy === abort) this.busy = null;
      this.push();
    }
    return this.state();
  }
}
