// «Место на диске» on the «Распознавание» page: «Найти лишнее» lists what can go, grouped, with sizes;
// «Удалить выбранное» removes the ticked items (main asks first). Nothing is scanned until the button.
import { t } from '@chawo/core/strings';
import * as Log from '../log';
import { remove, scan, sizeText, type CleanupGroup, type CleanupItem, type CleanupOptions } from './diskCleanup';

export interface CleanupItemDto {
  id: string;
  label: string;
  detail: string;
  size: string;
  bytes: number;
  preselected: boolean;
}

export interface CleanupStateDto {
  scanned: boolean;
  busy: boolean;
  groups: { group: CleanupGroup; title: string; items: CleanupItemDto[] }[];
  /** «Найдено 3,1 ГБ», or the result of the last removal. */
  status: string;
  hint: string;
  labels: { find: string; again: string; remove: string; nothing: string; heading: string };
}

const ORDER: readonly CleanupGroup[] = ['legacy', 'partial', 'unused', 'privacy', 'temp', 'recordings', 'downloads'];

function groupTitle(g: CleanupGroup): string {
  switch (g) {
    case 'legacy':
      return t('Старые версии', 'Older versions');
    case 'partial':
      return t('Недокачанное', 'Unfinished downloads');
    case 'unused':
      return t('Не используется', 'Not in use');
    case 'privacy':
      return t('Копии данных', 'Data copies');
    case 'temp':
      return t('Временные файлы', 'Temporary files');
    case 'recordings':
      return t('Записи встреч', 'Meeting recordings');
    case 'downloads':
      return t('Скачанное по ссылкам', 'Downloaded from links');
  }
}

export interface CleanupHooks {
  options: () => CleanupOptions;
  /** Free what is open before deleting (Windows keeps open files locked): models, the Brain server. */
  beforeRemove?: () => Promise<void>;
  /** Something was removed: other pages may show a model as gone now. */
  changed?: () => void;
}

export class CleanupController {
  private items: CleanupItem[] | null = null;
  private busy = false;
  private status = '';

  constructor(private readonly hooks: CleanupHooks) {}

  state(): CleanupStateDto {
    const items = this.items ?? [];
    return {
      scanned: this.items !== null,
      busy: this.busy,
      groups: ORDER.map((group) => ({
        group,
        title: groupTitle(group),
        items: items
          .filter((i) => i.group === group)
          .map((i) => ({ id: i.id, label: i.label, detail: i.detail, size: sizeText(i.bytes), bytes: i.bytes, preselected: i.preselected })),
      })).filter((g) => g.items.length > 0),
      status: this.status,
      hint: t(
        'Ищет только в папках приложения: модели и файлы старых версий, недокачанное, временное. Модель, которая сейчас выбрана, и записи без расшифровки не трогаются.',
        'Looks only in the app’s folders: models and files of older versions, unfinished downloads, temporary files. The selected model and recordings without a transcript are never touched.',
      ),
      labels: {
        heading: t('Место на диске', 'Disk space'),
        find: t('Найти лишнее', 'Find what is not needed'),
        again: t('Искать снова', 'Search again'),
        remove: t('Удалить выбранное', 'Delete selected'),
        nothing: t('Лишнего не найдено.', 'Nothing to clean up.'),
      },
    };
  }

  scan(): CleanupStateDto {
    this.items = scan(this.hooks.options());
    const total = this.items.reduce((n, i) => n + i.bytes, 0);
    this.status = this.items.length ? t(`Найдено: ${sizeText(total)}.`, `Found: ${sizeText(total)}.`) : '';
    return this.state();
  }

  /** Total size of these ids in the last scan (for the confirmation). */
  sizeOf(ids: readonly string[]): { count: number; size: string } {
    const chosen = (this.items ?? []).filter((i) => ids.includes(i.id));
    return { count: chosen.length, size: sizeText(chosen.reduce((n, i) => n + i.bytes, 0)) };
  }

  async remove(ids: readonly string[]): Promise<CleanupStateDto> {
    if (this.busy || ids.length === 0) return this.state();
    this.busy = true;
    try {
      await this.hooks.beforeRemove?.();
      const r = remove(ids, this.hooks.options());
      this.status = r.failed.length
        ? t(`Освобождено ${sizeText(r.freedBytes)}. Не удалось удалить: ${r.failed.length} (файл занят?).`, `Freed ${sizeText(r.freedBytes)}. Could not delete: ${r.failed.length} (file in use?).`)
        : t(`Освобождено ${sizeText(r.freedBytes)}.`, `Freed ${sizeText(r.freedBytes)}.`);
      if (r.removed.length) this.hooks.changed?.();
    } catch (e) {
      this.status = t('Не удалось удалить: ', 'Could not delete: ') + (e instanceof Error ? e.message : String(e));
      Log.write(`cleanup failed: ${this.status}`);
    } finally {
      this.busy = false;
    }
    const status = this.status;
    this.scan();
    this.status = status;
    return this.state();
  }
}
