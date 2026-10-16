// «Продажи» page logic: the local catalog rows, the materials folder (local RAG) and the call stand-in.
// Port of the Sales parts of SettingsWindow.xaml.cs (FillSalesRows / PersistSales / RefreshRagFolderUi /
// RagPick_Click / RagClear_Click / ShowCall_Click). No Electron imports: the folder dialog and the call
// come in as hooks, so the controller is unit-tested with a plain settings object.

import { isRussian, t } from '@chawo/core/strings';
import type { SalesCatalogItem, SettingsData } from '../settings';
import { countMaterialFiles } from './salesRag';

export interface SalesRow extends SalesCatalogItem {
  id: number;
}

export interface SalesStateDto {
  ru: boolean;
  intro: string;
  callHeading: string;
  callIntro: string;
  extensionHeader: string;
  numberHeader: string;
  managerHeader: string;
  showCallLabel: string;
  call: { extension: string; number: string; manager: string; status: string };
  codeHeader: string;
  nameHeader: string;
  lineHeader: string;
  similarHeader: string;
  addLabel: string;
  deleteLabel: string;
  rows: SalesRow[];
  ragHeading: string;
  ragIntro: string;
  ragFolder: string;
  ragFolderText: string;
  pickLabel: string;
  clearLabel: string;
  canClear: boolean;
  ragStatus: string;
  /** Short line about the mode, so the page says why no card appears in Dictation mode. */
  modeNote: string;
  salesMode: boolean;
}

export interface SalesPageHooks {
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  /** After the catalog or the folder was written (the WPF `_apply`). */
  changed?: () => void;
  /** Native folder dialog; null when cancelled. */
  pickFolder?: (current: string) => Promise<string | null>;
  /** App.PresentCall; returns the status line. */
  presentCall?: (extension: string, number: string, manager: string) => string;
  /** Override for tests. */
  countFiles?: (folder: string) => number;
}

const FIELD_MAX = 500;

function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, FIELD_MAX) : '';
}

/** Rows that would be stored: trimmed, fully empty rows dropped (PersistSales). */
export function keptCatalog(rows: readonly SalesCatalogItem[]): SalesCatalogItem[] {
  return rows
    .map((r) => ({ Code: r.Code.trim(), Name: r.Name.trim(), Line: r.Line.trim(), SimilarCode: r.SimilarCode.trim() }))
    .filter((r) => r.Code.length > 0 || r.Name.length > 0 || r.Line.length > 0 || r.SimilarCode.length > 0);
}

export function sameCatalog(a: readonly SalesCatalogItem[], b: readonly SalesCatalogItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.Code === b[i].Code && x.Name === b[i].Name && x.Line === b[i].Line && x.SimilarCode === b[i].SimilarCode);
}

export class SalesPageController {
  private rows: SalesRow[] = [];
  private nextId = 1;
  private seen: SalesCatalogItem[] = [];
  private call = { extension: '', number: '', manager: '', status: '' };

  constructor(private readonly h: SalesPageHooks) {
    this.load();
  }

  private load(): void {
    const cat = this.h.settings().SalesCatalog;
    this.rows = cat.map((c) => ({ id: this.nextId++, ...c }));
    this.seen = cat.map((c) => ({ ...c }));
  }

  /** The catalog changed outside this page (another window, a reload): rows are rebuilt. */
  private sync(): void {
    if (!sameCatalog(this.h.settings().SalesCatalog, this.seen)) this.load();
  }

  state(): SalesStateDto {
    this.sync();
    const s = this.h.settings();
    const folder = (s.RagFolder ?? '').trim();
    const salesMode = s.Mode === 'Sales';
    return {
      ru: isRussian(),
      intro: t(
        'Каталог на этом компьютере. Код в живом черновике открывает карточку с короткой строкой. Если кода нет, берётся ближайшее название по буквам и на карточке пишется «похоже». Ниже — папка материалов (.txt / .md): из неё подставляется короткий фрагмент под карточкой, когда точного кода нет. Облака нет. Панель ниже — только стенд: в SaaS добавочный не печатают в момент звонка, компьютер привязан заранее.',
        'A catalog on this PC. A code in the live draft opens a card with the short line. If the code is missing, the nearest name by letters is shown and the card says «похоже». Below is a materials folder (.txt / .md): a short snippet from it appears under the card when the exact code is missing. No cloud. The panel below is only a stand-in: in SaaS nobody types an extension at popup time; the PC is bound beforehand.'),
      callHeading: t('Звонок (стенд)', 'Call (stand-in)'),
      callIntro: t(
        'Стенд, не продукт. В сервисе добавочный берётся из привязки ПК или из события телефонии / softphone / клавиши. Здесь поля заполняют руками, чтобы открыть ту же карточку без сети. Пустой добавочный или пустое имя — привязки нет, карточки нет. Номер можно не заполнять.',
        'A stand-in, not the product. In the service the extension comes from the PC binding or from a telephony / softphone / hotkey event. Here the fields are typed by hand so the same card opens with no network. An empty extension or an empty name means no binding, so no card. The number may be left blank.'),
      extensionHeader: t('Добавочный', 'Extension'),
      numberHeader: t('Номер', 'Number'),
      managerHeader: t('Менеджер', 'Manager'),
      showCallLabel: t('Показать карточку', 'Show card'),
      call: { ...this.call },
      codeHeader: t('Код', 'Code'),
      nameHeader: t('Название', 'Name'),
      lineHeader: t('Строка', 'Line'),
      similarHeader: t('Похожий код', 'Similar code'),
      addLabel: t('Добавить', 'Add'),
      deleteLabel: t('Удалить', 'Delete'),
      rows: this.rows.map((r) => ({ ...r })),
      ragHeading: t('Материалы (локальный RAG)', 'Materials (local RAG)'),
      ragIntro: t(
        'Папка с текстовыми и markdown-файлами на этом компьютере. Никуда не загружается. В режиме «Продажи», если кода нет, на карточке под строкой каталога показывается ближайший фрагмент.',
        'A folder of text and markdown files on this PC. Nothing is uploaded. In Sales mode, when the code is missing, the nearest snippet appears on the card under the catalog line.'),
      ragFolder: folder,
      ragFolderText: folder.length === 0 ? t('Папка не выбрана', 'No folder chosen') : folder,
      pickLabel: t('Выбрать папку', 'Choose folder'),
      clearLabel: t('Убрать', 'Clear'),
      canClear: folder.length > 0,
      ragStatus: this.ragStatus(folder),
      modeNote: salesMode
        ? t('Режим «Продажи» включён: карточка появляется во время диктовки.', 'Sales mode is on: the card appears while you dictate.')
        : t('Сейчас режим «Диктовка»: карточка не показывается. Режим переключается на вкладке «Диктовка».',
          'Dictation mode is on, so the card stays hidden. Switch the mode on the Dictation tab.'),
      salesMode,
    };
  }

  private ragStatus(folder: string): string {
    if (folder.length === 0) return t('Без папки карточка показывает только каталог.', 'Without a folder the card shows only the catalog.');
    const n = (this.h.countFiles ?? countMaterialFiles)(folder);
    if (n < 0) return t('Папка не найдена на диске.', 'The folder is not on disk.');
    return t(`Файлов .txt/.md: ${n}.`, `.txt/.md files: ${n}.`);
  }

  private persist(): void {
    const s = this.h.settings();
    const rows = keptCatalog(this.rows);
    if (sameCatalog(rows, s.SalesCatalog)) return;
    s.SalesCatalog = rows;
    this.seen = rows.map((c) => ({ ...c }));
    this.h.save(s);
    this.h.changed?.();
  }

  /** Saved on every edit like WPF; the page is not redrawn so the caret stays put. */
  setRow(id: number, code: unknown, name: unknown, line: unknown, similar: unknown): SalesStateDto {
    this.sync();
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.Code = clean(code);
      row.Name = clean(name);
      row.Line = clean(line);
      row.SimilarCode = clean(similar);
      this.persist();
    }
    return this.state();
  }

  /** An empty row (stored once it has text). Returns its id for focus. */
  addRow(): number {
    this.sync();
    const id = this.nextId++;
    this.rows.push({ id, Code: '', Name: '', Line: '', SimilarCode: '' });
    return id;
  }

  removeRow(id: number): SalesStateDto {
    this.sync();
    const at = this.rows.findIndex((r) => r.id === id);
    if (at >= 0) {
      this.rows.splice(at, 1);
      this.persist();
    }
    return this.state();
  }

  async pickFolder(): Promise<SalesStateDto> {
    const s = this.h.settings();
    const picked = await this.h.pickFolder?.((s.RagFolder ?? '').trim());
    const path = (picked ?? '').trim();
    if (path.length > 0 && path !== s.RagFolder) {
      s.RagFolder = path;
      this.h.save(s);
      this.h.changed?.();
    }
    return this.state();
  }

  clearFolder(): SalesStateDto {
    const s = this.h.settings();
    if ((s.RagFolder ?? '').trim().length > 0) {
      s.RagFolder = '';
      this.h.save(s);
      this.h.changed?.();
    }
    return this.state();
  }

  /** «Показать карточку». Field values are kept for this run only (WPF does not store them either). */
  showCall(extension: unknown, number: unknown, manager: unknown): SalesStateDto {
    this.call.extension = clean(extension);
    this.call.number = clean(number);
    this.call.manager = clean(manager);
    this.call.status = this.h.presentCall
      ? this.h.presentCall(this.call.extension, this.call.number, this.call.manager)
      : t('Карточка из этого окна недоступна.', 'The card cannot be opened from this window.');
    return this.state();
  }
}
