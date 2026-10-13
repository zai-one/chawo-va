// «История» page logic: the last dictation takes, newest first, with search, copy, «Мозг заново» and
// delete. Nothing leaves the PC; the Brain re-run uses whatever Brain is set up (local or the
// user's own server), exactly like a take. No Electron imports: the clipboard, the confirm box and
// the Brain come in as hooks, so the controller is unit-tested with a temp store and a fake Brain.

import { isRussian, t } from '../../core/strings';
import { parseCommand, transformAsync } from '../brain/brain';
import { BrainException } from '../brain/speechCleanup';
import { defaultBrainUsable } from '../dictation/dictationSession';
import * as Log from '../log';
import type { SettingsData } from '../settings';
import { HISTORY_KEEPS, type HistoryEntry, type HistoryKeep, type HistoryStore } from './historyStore';

/** Rows drawn at once; search reaches the rest. */
export const SHOWN_ROWS = 200;

export interface HistoryRowDto {
  id: string;
  when: string;
  seconds: string;
  final: string;
  /** The text before the Brain, only when it differs from `final`. */
  raw: string | null;
  command: string | null;
  /** Short tag: «Мозг», «Мозг не справился» or ''. */
  tag: string;
  failed: boolean;
}

export interface HistoryStateDto {
  ru: boolean;
  intro: string;
  keepLabel: string;
  keep: HistoryKeep;
  keepChoices: { value: HistoryKeep; label: string }[];
  keepHint: string;
  query: string;
  searchPlaceholder: string;
  rows: HistoryRowDto[];
  countLine: string;
  empty: string;
  status: string;
  canRerun: boolean;
  rerunTip: string;
  rerunningId: string | null;
  labels: { copy: string; copyRaw: string; rerun: string; remove: string; clearAll: string; rawHeader: string };
}

export interface HistoryHooks {
  store: HistoryStore;
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  copy: (text: string) => void;
  /** Yes/no box before «Очистить всё». */
  confirm?: (message: string) => Promise<boolean>;
  push?: () => void;
  now?: () => number;
  brainUsable?: (s: SettingsData) => boolean;
  transform?: (s: SettingsData, body: string, command: string | null, status: (line: string) => void, signal: AbortSignal) => Promise<string>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** «сегодня 14:05», «вчера 09:30», «12.10 18:02», «31.12.2025 23:59» in local time. */
export function whenText(ts: number, now: number, tr: (ru: string, en: string) => string = t): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(n) - day(d)) / 86400000);
  if (diffDays === 0) return tr(`сегодня ${hm}`, `today ${hm}`);
  if (diffDays === 1) return tr(`вчера ${hm}`, `yesterday ${hm}`);
  const dm = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === n.getFullYear() ? `${dm} ${hm}` : `${dm}.${d.getFullYear()} ${hm}`;
}

function keepLabel(k: HistoryKeep): string {
  switch (k) {
    case 'Off': return t('Не хранить', 'Do not keep');
    case 'Day': return t('Сутки', 'A day');
    case 'Week': return t('Неделю', 'A week');
    case 'Month': return t('Месяц', 'A month');
    default: return t('Пока не удалю сам', 'Until I delete it');
  }
}

export class HistoryController {
  private query = '';
  private status = '';
  private rerunning: { id: string; abort: AbortController } | null = null;
  private readonly now: () => number;
  private readonly brainUsable: (s: SettingsData) => boolean;
  private readonly transform: NonNullable<HistoryHooks['transform']>;

  constructor(private readonly h: HistoryHooks) {
    this.now = h.now ?? Date.now;
    this.brainUsable = h.brainUsable ?? defaultBrainUsable;
    this.transform = h.transform
      ?? ((s, body, command, status, signal) => transformAsync(s, body, command, status, signal, false, globalThis.fetch));
  }

  private push(): void {
    this.h.push?.();
  }

  /** A take finished: store it under the current period (the dictation session calls this). */
  record(e: Omit<HistoryEntry, 'id' | 'ts'>): void {
    const keep = this.h.settings().HistoryKeep;
    if (keep === 'Off') return;
    this.h.store.add(e, keep);
    this.push();
  }

  state(): HistoryStateDto {
    const s = this.h.settings();
    const keep = s.HistoryKeep;
    // Old entries go when the page is looked at too, not only when a new take arrives.
    if (keep !== 'Off') this.h.store.prune(keep);
    const now = this.now();
    const total = this.h.store.count();
    const found = this.query.trim() ? this.h.store.count(this.query) : total;
    const rows = this.h.store.list(this.query, SHOWN_ROWS).map((e) => this.row(e, now));
    const usable = this.brainUsable(s);
    let countLine = '';
    if (this.query.trim()) countLine = t(`Найдено ${found} из ${total}.`, `Found ${found} of ${total}.`);
    else if (total > rows.length) countLine = t(`Показаны последние ${rows.length} из ${total}. Поиск ищет по всем.`, `Showing the last ${rows.length} of ${total}. Search covers all of them.`);
    return {
      ru: isRussian(),
      intro: t('Последние фразы диктовки: что распознано и что получилось после мозга. Хранится только текст и только на этом компьютере, звук не сохраняется.',
        'Recent dictation phrases: what was recognized and what came out after the Brain. Only the text is kept, on this computer only; no audio is saved.'),
      keepLabel: t('Хранить', 'Keep'),
      keep,
      keepChoices: HISTORY_KEEPS.map((k) => ({ value: k, label: keepLabel(k) })),
      keepHint: keep === 'Off'
        ? t('История не ведётся. Новые фразы не запоминаются.', 'History is off. New phrases are not kept.')
        : t('Старше выбранного срока удаляется само. «Не хранить» сразу стирает всё.', 'Anything older than the period is deleted by itself. «Do not keep» wipes everything at once.'),
      query: this.query,
      searchPlaceholder: t('Поиск по тексту', 'Search the text'),
      rows,
      countLine,
      empty: this.query.trim()
        ? t('Ничего не нашлось.', 'Nothing found.')
        : keep === 'Off'
          ? t('Истории нет: хранение выключено.', 'No history: keeping is off.')
          : t('Пока пусто. Продиктуйте фразу — она появится здесь.', 'Empty so far. Dictate a phrase and it shows up here.'),
      status: this.status,
      canRerun: usable && this.rerunning === null,
      rerunTip: usable ? '' : t('Мозг не настроен: включите его на вкладке «Мозг».', 'The Brain is not set up: turn it on on the Brain tab.'),
      rerunningId: this.rerunning?.id ?? null,
      labels: {
        copy: t('Копировать', 'Copy'),
        copyRaw: t('Копировать без мозга', 'Copy as recognized'),
        rerun: t('Мозг заново', 'Brain again'),
        remove: t('Удалить', 'Delete'),
        clearAll: t('Очистить всё', 'Clear all'),
        rawHeader: t('Распознано:', 'Recognized:'),
      },
    };
  }

  private row(e: HistoryEntry, now: number): HistoryRowDto {
    const raw = e.raw.trim() && e.raw !== e.final ? e.raw : null;
    return {
      id: e.id,
      when: whenText(e.ts, now),
      seconds: t(`${e.seconds.toFixed(1).replace('.', ',')} с`, `${e.seconds.toFixed(1)} s`),
      final: e.final,
      raw,
      command: e.command,
      tag: e.brainFailed ? t('Мозг не справился', 'Brain failed') : e.brain ? t('Мозг', 'Brain') : '',
      failed: e.brainFailed,
    };
  }

  setQuery(q: string): HistoryStateDto {
    this.query = q.slice(0, 200);
    return this.state();
  }

  setKeep(k: HistoryKeep): HistoryStateDto {
    if (!HISTORY_KEEPS.includes(k)) return this.state();
    const s = this.h.settings();
    if (s.HistoryKeep !== k) {
      s.HistoryKeep = k;
      this.h.save(s);
      const dropped = this.h.store.prune(k);
      this.status = k === 'Off'
        ? t(`История выключена${dropped ? `, удалено записей: ${dropped}` : ''}.`, `History is off${dropped ? `, ${dropped} entries deleted` : ''}.`)
        : dropped
          ? t(`Удалено старых записей: ${dropped}.`, `${dropped} old entries deleted.`)
          : '';
    }
    return this.state();
  }

  copy(id: string, which: 'final' | 'raw'): HistoryStateDto {
    const e = this.h.store.get(id);
    if (e) {
      const text = which === 'raw' && e.raw.trim() ? e.raw : e.final;
      try {
        this.h.copy(text);
        this.status = t('Скопировано в буфер обмена.', 'Copied to the clipboard.');
      } catch (err) {
        Log.write(`history copy: ${err instanceof Error ? err.message : String(err)}`);
        this.status = t('В буфер обмена скопировать не получилось.', 'Could not copy to the clipboard.');
      }
    }
    return this.state();
  }

  remove(id: string): HistoryStateDto {
    if (this.rerunning?.id === id) this.rerunning.abort.abort();
    if (this.h.store.remove(id)) this.status = '';
    return this.state();
  }

  async clearAll(): Promise<HistoryStateDto> {
    const n = this.h.store.count();
    if (n === 0) return this.state();
    const ok = this.h.confirm
      ? await this.h.confirm(t(`Удалить всю историю (${n})? Это не отменить.`, `Delete the whole history (${n})? This cannot be undone.`))
      : true;
    if (ok) {
      this.rerunning?.abort.abort();
      this.h.store.clear();
      this.status = t('История очищена.', 'History cleared.');
    }
    return this.state();
  }

  /**
   * «Мозг заново»: the recognized text through the Brain again, like a take (a «Чаво, …» command in
   * it is the command, otherwise the usual cleanup). The answer replaces the entry's text and goes to
   * the clipboard. A failure leaves the entry as it was.
   */
  async rerun(id: string): Promise<HistoryStateDto> {
    const e = this.h.store.get(id);
    const s = this.h.settings();
    if (!e || this.rerunning || !this.brainUsable(s)) return this.state();
    const source = e.raw.trim() ? e.raw : e.final;
    const cmd = parseCommand(source);
    const abort = new AbortController();
    this.rerunning = { id, abort };
    this.status = t('Мозг думает…', 'The Brain is thinking…');
    this.push();
    try {
      const answer = await this.transform(s, cmd?.body ?? source, cmd?.command ?? null, (line) => {
        this.status = line;
        this.push();
      }, abort.signal);
      if (abort.signal.aborted) {
        this.status = '';
      } else if (!answer.trim()) {
        this.status = t('Мозг не справился: нейросеть вернула пустой ответ.', 'The Brain failed: the model returned an empty answer.');
      } else if (this.h.store.get(id)) {
        this.h.store.setFinal(id, answer, false);
        try {
          this.h.copy(answer);
          this.status = t('Готово. Новый текст в буфере обмена.', 'Done. The new text is on the clipboard.');
        } catch {
          this.status = t('Готово. В буфер обмена скопировать не получилось.', 'Done. Could not copy to the clipboard.');
        }
      }
    } catch (err) {
      Log.write(`history rerun: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      if (abort.signal.aborted) this.status = '';
      else {
        const why = err instanceof BrainException ? err.message
          : s.Brain === 'Server' ? t('сервер не ответил', 'the server did not answer')
          : t('нейронка не ответила', 'the Brain did not answer');
        this.status = t(`Мозг не справился: ${why}.`, `The Brain failed: ${why}.`);
      }
    } finally {
      if (this.rerunning?.abort === abort) this.rerunning = null;
    }
    return this.state();
  }
}
