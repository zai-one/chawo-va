// Sidebar navigation plus the «Расшифровка файла» page. Other pages get real content as the
// WPF SettingsWindow is ported. Plain DOM, no framework; paths are set via textContent only.

interface FileItem { id: number; path: string; state: 'Queued' | 'Running' | 'Done' | 'Failed' | 'Stopped'; note: string; outputPath?: string }
interface FileState {
  items: FileItem[];
  status: string;
  busy: boolean;
  options: { timestamps: boolean; srt: boolean; parallelism: string };
  ffmpeg: { line: string; canDownload: boolean; installed: boolean };
  lastOutput: string | null;
  ru: boolean;
}
interface FileApi {
  state(): Promise<FileState>;
  pick(kind: 'files' | 'folder'): Promise<FileState>;
  addDropped(files: File[]): Promise<FileState>;
  remove(id: number): Promise<FileState>;
  clearFinished(): Promise<FileState>;
  run(): Promise<FileState>;
  stop(): Promise<FileState>;
  reveal(path?: string): Promise<boolean>;
  setOptions(o: Partial<FileState['options']>): Promise<FileState>;
  downloadFfmpeg(): Promise<FileState>;
  onState(fn: (s: FileState) => void): () => void;
  onToast(fn: (s: string) => void): () => void;
}
const bridge = (window as unknown as { chawo: { file: FileApi } }).chawo;

const titlesEn: Record<string, string> = { dictation: 'Dictation', file: 'File transcription', brain: 'Brain', network: 'Network' };
const titles: Record<string, string> = {
  dictation: 'Диктовка',
  file: 'Расшифровка файла',
  brain: 'Мозг',
  network: 'Сеть',
};

const page = document.getElementById('page') as HTMLElement;
let current = 'dictation';
let fileState: FileState | null = null;
let ru = true;
const L = (r: string, e: string) => (ru ? r : e);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { textContent: label, className: cls });
  b.addEventListener('click', onClick);
  return b;
}

const STATE_RU: Record<FileItem['state'], string> = {
  Queued: 'ждёт',
  Running: 'идёт',
  Done: 'готово',
  Failed: 'ошибка',
  Stopped: 'остановлено',
};

const SPEED: [string, string][] = [
  ['Auto', 'Авто'],
  ['Gentle1', '1 поток (бережно)'],
  ['Two', '2'],
  ['Four', '4'],
  ['Max', 'Максимум'],
];

const SPEED_EN: Record<string, string> = { Auto: 'Auto', Gentle1: '1 thread (gentle)', Two: '2', Four: '4', Max: 'Max' };

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const apply = (s: FileState) => {
  fileState = s;
  if (s.ru !== ru) setLanguage(s.ru);
  if (current === 'file') renderFile();
};

const title = (name: string) => (ru ? titles[name] : titlesEn[name]) ?? '';

function setLanguage(r: boolean): void {
  ru = r;
  document.documentElement.lang = r ? 'ru' : 'en';
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav button'))) b.textContent = title(b.dataset.page ?? '');
  if (current !== 'file') show(current);
}

function renderFile(): void {
  const s = fileState;
  page.replaceChildren(el('h1', { textContent: title('file') }));
  if (!s) return;

  const actions = el('div', { className: 'row' },
    button(L('Добавить файлы…', 'Add files…'), () => void bridge.file.pick('files').then(apply)),
    button(L('Добавить папку…', 'Add folder…'), () => void bridge.file.pick('folder').then(apply)),
    s.busy
      ? button(L('Остановить', 'Stop'), () => void bridge.file.stop().then(apply), 'primary')
      : button(L('Расшифровать', 'Transcribe'), () => void bridge.file.run().then(apply), 'primary'),
  );
  if (s.lastOutput) actions.append(button(L('Открыть папку', 'Open folder'), () => void bridge.file.reveal()));
  page.append(actions);

  const list = el('div', { className: 'queue' });
  if (s.items.length === 0) {
    list.append(el('div', { className: 'empty muted', textContent: L('Перетащите сюда записи или папку. Текст сохранится рядом с файлом (.txt).', 'Drop recordings or a folder here. The text is saved next to each file (.txt).') }));
  }
  for (const it of s.items) {
    const row = el('div', { className: `item ${it.state.toLowerCase()}`, title: it.path },
      el('span', { className: 'name', textContent: fileName(it.path) }),
      el('span', { className: 'state', textContent: ru ? STATE_RU[it.state] : it.state.toLowerCase() }),
      el('span', { className: 'note muted', textContent: it.note }),
    );
    if (it.outputPath) row.append(button(L('Показать', 'Show'), () => void bridge.file.reveal(it.outputPath), 'link'));
    if (it.state !== 'Running') row.append(button('×', () => void bridge.file.remove(it.id).then(apply), 'link x'));
    list.append(row);
  }
  page.append(list);
  if (s.items.some((i) => i.state !== 'Queued' && i.state !== 'Running')) {
    page.append(el('div', { className: 'row' }, button(L('Убрать готовые из списка', 'Clear finished'), () => void bridge.file.clearFinished().then(apply), 'link')));
  }

  page.append(el('p', { className: 'status', textContent: s.status }));

  const ts = el('input', { type: 'checkbox', checked: s.options.timestamps });
  ts.addEventListener('change', () => void bridge.file.setOptions({ timestamps: ts.checked }).then(apply));
  const srt = el('input', { type: 'checkbox', checked: s.options.srt });
  srt.addEventListener('change', () => void bridge.file.setOptions({ srt: srt.checked }).then(apply));
  const speed = el('select');
  for (const [v, label] of SPEED.map(([v, r]) => [v, ru ? r : SPEED_EN[v]] as [string, string])) speed.append(el('option', { value: v, textContent: label, selected: v === s.options.parallelism }));
  speed.addEventListener('change', () => void bridge.file.setOptions({ parallelism: speed.value }).then(apply));

  page.append(
    el('fieldset', {},
      el('legend', { textContent: L('Вывод', 'Output') }),
      el('label', {}, ts, L(' Метки времени [чч:мм:сс] в .txt', ' Timestamps [hh:mm:ss] in .txt')),
      el('label', {}, srt, L(' Ещё и субтитры .srt', ' Also .srt subtitles')),
      el('label', {}, L('Скорость длинных записей ', 'Long recording speed '), speed),
    ),
  );

  const ff = el('fieldset', {}, el('legend', { textContent: 'ffmpeg' }), el('p', { className: 'muted', textContent: s.ffmpeg.line }));
  if (!s.ffmpeg.installed && s.ffmpeg.canDownload) ff.append(button(L('Скачать ffmpeg', 'Download ffmpeg'), () => void bridge.file.downloadFfmpeg().then(apply)));
  page.append(ff);
}

function show(name: string): void {
  current = name;
  if (name === 'file') {
    renderFile();
    void bridge.file.state().then(apply);
    return;
  }
  page.replaceChildren(
    el('h1', { textContent: title(name) }),
    el('p', { className: 'muted', textContent: L('TypeScript-версия в разработке. Этот раздел пока работает в WPF-приложении.', 'The TypeScript version is in progress. This section still lives in the WPF app.') }),
  );
}

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav button'))) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    show(btn.dataset.page ?? 'dictation');
  });
}

bridge.file.onState(apply);
bridge.file.onToast((msg) => {
  if (fileState) apply({ ...fileState, status: msg });
});

// Drop anywhere on the window: files and folders go into the file queue and open that page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  void bridge.file.addDropped(files).then((s) => {
    document.querySelector<HTMLButtonElement>('.nav button[data-page="file"]')?.click();
    apply(s);
  });
});
