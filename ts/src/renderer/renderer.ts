// Sidebar navigation plus the «Расшифровка файла», «Распознавание», «Словарь» and «Мозг» pages. Other pages get real content as the
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
interface SpeechModelRow { kind: string; label: string; selected: boolean; onDisk: boolean; path: string | null; canDelete: boolean; deleteTip: string }
interface SpeechState {
  ru: boolean;
  client: boolean;
  intro: string;
  models: SpeechModelRow[];
  note: string;
  device: 'Gpu' | 'Cpu';
  deviceChoices: { value: 'Gpu' | 'Cpu'; label: string }[];
  cpuThreads: number;
  cores: number;
  threadsHint: string;
  status: string;
  download: { kind: string; percent: number | null; text: string; running: boolean; failed: boolean } | null;
}
interface SpeechApi {
  state(): Promise<SpeechState>;
  select(kind: string): Promise<SpeechState>;
  setDevice(d: 'Gpu' | 'Cpu'): Promise<SpeechState>;
  setThreads(n: number): Promise<SpeechState>;
  download(kind: string): Promise<SpeechState>;
  cancel(): Promise<SpeechState>;
  dismiss(): Promise<SpeechState>;
  remove(kind: string): Promise<SpeechState>;
  onState(fn: (s: SpeechState) => void): () => void;
}
interface DictRow { id: number; from: string; to: string }
interface DictSuggestionRow { id: number; heard: string; written: string; source: string }
interface DictState {
  ru: boolean;
  intro: string;
  heardHeader: string;
  writtenHeader: string;
  addLabel: string;
  deleteLabel: string;
  suggestLabel: string;
  addSuggestionLabel: string;
  suggestHint: string;
  hintKind: 'idle' | 'noFolder' | 'none' | 'found';
  rows: DictRow[];
  suggestions: DictSuggestionRow[];
}
interface DictApi {
  state(): Promise<DictState>;
  setRow(id: number, from: string, to: string): Promise<DictState>;
  add(): Promise<{ id: number; state: DictState }>;
  remove(id: number): Promise<DictState>;
  suggest(): Promise<DictState>;
  addSuggestion(heard: string, written: string): Promise<DictState>;
}
interface BrainRow { kind: string | null; label: string; selected: boolean; onDisk: boolean; path: string | null }
interface BrainState {
  ru: boolean;
  heading: string;
  hint: string;
  source: string;
  sourceChoices: { value: string; label: string }[];
  status: string;
  server: {
    visible: boolean;
    providers: { id: string; label: string }[];
    providerId: string;
    custom: boolean;
    url: string;
    keySaved: boolean;
    keyPlaceholder: string;
    keysLink: string;
    keysLinkEnabled: boolean;
    model: string;
    models: string[];
    loading: boolean;
    status: string;
  };
  local: {
    visible: boolean;
    rows: BrainRow[];
    device: string;
    deviceChoices: { value: string; label: string }[];
    deviceHint: string;
    customUrlVisible: boolean;
    customUrl: string;
    fileStatus: string;
  };
  everyTake: { visible: boolean; on: boolean; hint: string };
  instruction: { visible: boolean; text: string; hint: string };
  selection: { visible: boolean; on: boolean; hint: string };
}
interface BrainApi {
  state(rebind?: boolean): Promise<BrainState>;
  setSource(v: string): Promise<BrainState>;
  setEveryTake(v: boolean): Promise<BrainState>;
  setInstruction(v: string): Promise<BrainState>;
  setSelection(v: boolean): Promise<BrainState>;
  setDevice(v: string): Promise<BrainState>;
  setLocalModel(v: string): Promise<BrainState>;
  setCustomUrl(v: string): Promise<BrainState>;
  setProvider(id: string): Promise<BrainState>;
  setKey(key: string): Promise<BrainState>;
  setUrl(url: string): Promise<BrainState>;
  setModel(model: string): Promise<BrainState>;
  refresh(): Promise<BrainState>;
  openKeysLink(): Promise<boolean>;
  deleteGguf(path: string): Promise<BrainState>;
  close(): Promise<boolean>;
  onState(fn: (s: BrainState) => void): () => void;
}
const bridge = (window as unknown as { chawo: { file: FileApi; speech: SpeechApi; dict: DictApi; brain: BrainApi } }).chawo;

const titlesEn: Record<string, string> = {
  dictation: 'Dictation',
  file: 'File transcription',
  speech: 'Speech',
  dictionary: 'Dictionary',
  sales: 'Sales',
  brain: 'Brain',
  network: 'Network',
};
const titles: Record<string, string> = {
  dictation: 'Диктовка',
  file: 'Расшифровка файла',
  speech: 'Распознавание',
  dictionary: 'Словарь',
  sales: 'Продажи',
  brain: 'Мозг',
  network: 'Сеть',
};

const page = document.getElementById('page') as HTMLElement;
let current = 'dictation';
let fileState: FileState | null = null;
let speechState: SpeechState | null = null;
let dictState: DictState | null = null;
let brainState: BrainState | null = null;
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

const applySpeech = (s: SpeechState) => {
  speechState = s;
  if (s.ru !== ru) setLanguage(s.ru);
  else if (current === 'speech') renderSpeech();
};

const title = (name: string) => (ru ? titles[name] : titlesEn[name]) ?? '';

const applyDict = (s: DictState, focusId?: number) => {
  dictState = s;
  if (s.ru !== ru) setLanguage(s.ru);
  else if (current === 'dictionary') renderDictionary(focusId);
};

const applyBrain = (st: BrainState) => {
  brainState = st;
  if (st.ru !== ru) setLanguage(st.ru);
  else if (current === 'brain') renderBrain();
};

/** Status lines from async work (model list, probe) update in place so typing is not interrupted. */
const applyBrainPush = (st: BrainState) => {
  const prev = brainState;
  brainState = st;
  if (current !== 'brain') return;
  const active = document.activeElement as HTMLElement | null;
  const typing = active && page.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (typing && prev && prev.source === st.source && prev.server.providerId === st.server.providerId) {
    const line = page.querySelector<HTMLElement>('[data-brain="server-status"]');
    if (line) line.textContent = st.server.status;
    const model = page.querySelector<HTMLInputElement>('[data-brain="model"]');
    if (model && model !== active) model.value = st.server.model;
    const list = page.querySelector<HTMLDataListElement>('#brain-models');
    if (list) list.replaceChildren(...st.server.models.map((m) => el('option', { value: m })));
    const reload = page.querySelector<HTMLButtonElement>('[data-brain="reload"]');
    if (reload) reload.disabled = st.server.loading;
    return;
  }
  renderBrain();
};

function selectOf(choices: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = el('select');
  for (const c of choices) sel.append(el('option', { value: c.value, textContent: c.label, selected: c.value === value }));
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function renderBrain(): void {
  const s = brainState;
  page.replaceChildren(el('h1', { textContent: title('brain') }));
  if (!s) return;
  page.append(el('p', { className: 'muted', textContent: s.hint }));

  page.append(el('div', { className: 'row' },
    el('span', { textContent: L('Где думает', 'Runs on') }),
    selectOf(s.sourceChoices, s.source, (v) => void bridge.brain.setSource(v).then(applyBrain)),
  ));
  if (s.status) page.append(el('p', { className: 'muted hint', textContent: s.status }));

  if (s.server.visible) {
    const v = s.server;
    const grid = el('div', { className: 'form' });
    grid.append(el('span', { textContent: L('Сервис', 'Service') }),
      selectOf(v.providers.map((p) => ({ value: p.id, label: p.label })), v.providerId, (id) => void bridge.brain.setProvider(id).then(applyBrain)));
    const key = el('input', { type: 'password', placeholder: v.keyPlaceholder, spellcheck: false, autocomplete: 'off' });
    key.addEventListener('input', () => void bridge.brain.setKey(key.value).then((st) => {
      // A pasted key may switch the service; redraw only then, so the caret stays put.
      if (brainState && st.server.providerId !== brainState.server.providerId) { key.blur(); applyBrain(st); }
      else applyBrainPush(st);
    }));
    const link = button(v.keysLink, () => void bridge.brain.openKeysLink(), 'link');
    link.disabled = !v.keysLinkEnabled;
    grid.append(el('span', { textContent: L('Ключ API', 'API key') }), el('div', {}, key, link));
    if (v.custom) {
      const url = el('input', { type: 'text', value: v.url, spellcheck: false, placeholder: 'http://localhost:11434/v1' });
      url.title = L('OpenAI-совместимый API, например http://localhost:1234/v1 (LM Studio) или http://localhost:11434/v1 (Ollama)',
        'An OpenAI-compatible API, e.g. http://localhost:1234/v1 (LM Studio) or http://localhost:11434/v1 (Ollama)');
      url.addEventListener('change', () => void bridge.brain.setUrl(url.value).then(applyBrainPush));
      grid.append(el('span', { textContent: L('Адрес', 'Address') }), url);
    }
    const model = el('input', { type: 'text', value: v.model, spellcheck: false });
    const listId = 'brain-models';
    model.setAttribute('list', listId);
    model.dataset.brain = 'model';
    const list = el('datalist', { id: listId });
    for (const m of v.models) list.append(el('option', { value: m }));
    model.addEventListener('change', () => void bridge.brain.setModel(model.value).then(applyBrainPush));
    const refresh = button(L('Обновить', 'Reload'), () => void bridge.brain.refresh().then(applyBrain));
    refresh.disabled = v.loading;
    refresh.dataset.brain = 'reload';
    grid.append(el('span', { textContent: L('Модель', 'Model') }), el('div', { className: 'inline' }, model, list, refresh));
    page.append(grid);
    page.append(el('p', { className: 'muted hint line', textContent: v.status }));
    page.lastElementChild?.setAttribute('data-brain', 'server-status');
  }

  if (s.local.visible) {
    const v = s.local;
    page.append(el('label', { className: 'block', textContent: L('Модель на компьютере', 'Model on this computer') }));
    const rows = el('div', { className: 'models' });
    for (const r of v.rows) {
      const row = el('div', { className: 'model' });
      if (r.kind) {
        const radio = el('input', { type: 'radio', name: 'brain-model', checked: r.selected });
        const kind = r.kind;
        radio.addEventListener('change', () => void bridge.brain.setLocalModel(kind).then(applyBrain));
        row.append(el('label', {}, radio, ' ', r.label));
      } else {
        row.append(el('label', { textContent: r.label }));
      }
      if (r.onDisk) row.append(el('span', { className: 'disk', textContent: L('на диске', 'on disk') }));
      if (r.path) {
        const path = r.path;
        row.append(button(L('Удалить', 'Delete'), () => void bridge.brain.deleteGguf(path).then(applyBrain)));
      }
      rows.append(row);
    }
    page.append(rows);
    if (v.customUrlVisible) {
      page.append(el('label', { className: 'block', textContent: L('Ссылка Hugging Face', 'Hugging Face link') }));
      const url = el('input', { type: 'text', value: v.customUrl, spellcheck: false });
      url.title = L('Страница файла .gguf или прямая ссылка resolve. Скачивается только по кнопке ниже.', 'A .gguf file page or a resolve link. Downloaded only by the button below.');
      url.addEventListener('change', () => void bridge.brain.setCustomUrl(url.value).then(applyBrain));
      page.append(url);
    }
    if (v.fileStatus) page.append(el('p', { className: 'muted hint line', textContent: v.fileStatus }));
    page.append(el('label', { className: 'block', textContent: L('Где считает', 'Where it runs') }),
      selectOf(v.deviceChoices, v.device, (d) => void bridge.brain.setDevice(d).then(applyBrain)),
      el('p', { className: 'muted hint', textContent: v.deviceHint }));
  }

  if (s.everyTake.visible) {
    page.append(el('label', { className: 'block', textContent: L('Переписывать фразу', 'Rewrite the phrase') }),
      selectOf([{ value: 'off', label: L('Выключено', 'Off') }, { value: 'on', label: L('Переписывать каждую фразу', 'Rewrite each phrase') }],
        s.everyTake.on ? 'on' : 'off', (v) => void bridge.brain.setEveryTake(v === 'on').then(applyBrain)),
      el('p', { className: 'muted hint', textContent: s.everyTake.hint }));
  }
  if (s.instruction.visible) {
    const box = el('textarea', { value: s.instruction.text, spellcheck: false, rows: 4 });
    box.addEventListener('change', () => void bridge.brain.setInstruction(box.value).then((st) => { brainState = st; }));
    page.append(el('label', { className: 'block', textContent: L('Как переписывать', 'How to rewrite') }), box,
      el('p', { className: 'muted hint', textContent: s.instruction.hint }));
  }
  if (s.selection.visible) {
    const cb = el('input', { type: 'checkbox', checked: s.selection.on });
    cb.addEventListener('change', () => void bridge.brain.setSelection(cb.checked).then(applyBrain));
    page.append(el('label', { className: 'check' }, cb, ' ', L('Править выделенный текст голосом', 'Edit selected text by voice')),
      el('p', { className: 'muted hint indent', textContent: s.selection.hint }));
  }
}

function setLanguage(r: boolean): void {
  ru = r;
  document.documentElement.lang = r ? 'ru' : 'en';
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav button'))) b.textContent = title(b.dataset.page ?? '');
  if (current === 'speech') renderSpeech();
  else if (current === 'dictionary') renderDictionary();
  else if (current === 'brain') renderBrain();
  else if (current !== 'file') show(current);
}

function renderDictionary(focusId?: number): void {
  const s = dictState;
  page.replaceChildren(el('h1', { textContent: title('dictionary') }));
  if (!s) return;
  page.append(el('p', { className: 'muted', textContent: s.intro }));

  const table = el('div', { className: 'dict' },
    el('div', { className: 'dict-row head muted' },
      el('span', { textContent: s.heardHeader }),
      el('span', { textContent: s.writtenHeader }),
      el('span'),
    ),
  );
  let focusEl: HTMLInputElement | null = null;
  for (const r of s.rows) {
    const heard = el('input', { type: 'text', value: r.from, spellcheck: false });
    const written = el('input', { type: 'text', value: r.to, spellcheck: false });
    heard.setAttribute('aria-label', s.heardHeader);
    written.setAttribute('aria-label', s.writtenHeader);
    // Saved on every edit like WPF; the page is not redrawn so the caret stays put.
    const send = () => void bridge.dict.setRow(r.id, heard.value, written.value).then((st) => { dictState = st; });
    heard.addEventListener('input', send);
    written.addEventListener('input', send);
    const del = button(s.deleteLabel, () => void bridge.dict.remove(r.id).then((st) => applyDict(st)));
    table.append(el('div', { className: 'dict-row' }, heard, written, del));
    if (r.id === focusId) focusEl = heard;
  }
  page.append(table);
  page.append(el('div', { className: 'row' },
    button(s.addLabel, () => void bridge.dict.add().then((res) => applyDict(res.state, res.id))),
  ));

  page.append(el('div', { className: 'row' },
    button(s.suggestLabel, () => void bridge.dict.suggest().then((st) => applyDict(st))),
  ));
  page.append(el('p', { className: 'muted hint', textContent: s.suggestHint }));
  if (s.suggestions.length > 0) {
    const list = el('div', { className: 'dict suggest' });
    for (const g of s.suggestions) {
      list.append(el('div', { className: 'dict-row' },
        el('span', { className: 'cell', textContent: g.heard }),
        el('span', { className: 'cell muted', textContent: g.written + (g.source ? `  (${g.source})` : '') }),
        button(s.addSuggestionLabel, () => void bridge.dict.addSuggestion(g.heard, g.written).then((st) => applyDict(st))),
      ));
    }
    page.append(list);
  }
  if (focusEl) focusEl.focus();
}

function renderSpeech(): void {
  const s = speechState;
  page.replaceChildren(el('h1', { textContent: title('speech') }));
  if (!s) return;
  page.append(el('p', { className: 'muted', textContent: s.intro }));
  page.append(el('label', { className: 'block', textContent: L('Речевые модели', 'Speech models') }));
  const busy = s.download?.running === true;
  const rows = el('div', { className: 'models' });
  for (const m of s.models) {
    const radio = el('input', { type: 'radio', name: 'speech-model', checked: m.selected, disabled: busy });
    radio.addEventListener('change', () => radio.checked && void bridge.speech.select(m.kind).then(applySpeech));
    const label = el('label', { title: m.path ?? '' }, radio, ' ' + m.label);
    const row = el('div', { className: 'model' }, label);
    if (m.onDisk) row.append(el('span', { className: 'disk', textContent: L('на диске', 'on disk') }));
    else {
      const dl = button(L('Скачать', 'Download'), () => void bridge.speech.download(m.kind).then(applySpeech));
      dl.disabled = busy || s.client;
      if (s.client) dl.title = L('Клиент не скачивает модель.', 'A client does not download a model.');
      row.append(dl);
    }
    if (m.canDelete) {
      const del = button(L('Удалить', 'Delete'), () => void bridge.speech.remove(m.kind).then(applySpeech));
      del.title = m.deleteTip;
      del.disabled = busy && s.download?.kind === m.kind;
      row.append(del);
    }
    rows.append(row);
  }
  page.append(rows);
  page.append(el('p', { className: 'muted hint', textContent: s.note }));

  const d = s.download;
  if (d) {
    const card = el('div', { className: `card${d.failed ? ' failed' : ''}` });
    const name = s.models.find((m) => m.kind === d.kind)?.label ?? d.kind;
    card.append(el('div', { textContent: name }));
    if (d.running) {
      const bar = el('div', { className: `progress${d.percent === null ? ' indeterminate' : ''}` }, el('div'));
      if (d.percent !== null) (bar.firstChild as HTMLElement).style.width = `${d.percent.toFixed(1)}%`;
      card.append(bar);
    }
    card.append(el('p', { className: 'status muted', textContent: d.text }));
    const act = el('div', { className: 'row' });
    if (d.running) act.append(button(L('Отмена', 'Cancel'), () => void bridge.speech.cancel().then(applySpeech)));
    else {
      if (d.failed && !s.client) act.append(button(L('Повторить', 'Retry'), () => void bridge.speech.download(d.kind).then(applySpeech), 'primary'));
      act.append(button(L('Скрыть', 'Hide'), () => void bridge.speech.dismiss().then(applySpeech), 'link'));
    }
    card.append(act);
    page.append(card);
  } else if (!s.client && s.models.some((m) => !m.onDisk)) {
    page.append(el('p', { className: 'muted hint', textContent: L('Пока кнопка «Скачать» не нажата, в сеть ничего не уходит.', 'Nothing goes out on the network until you press Download.') }));
  }

  page.append(el('label', { className: 'block', textContent: L('Где считать речь', 'Where speech runs') }));
  const dev = el('select');
  for (const c of s.deviceChoices) dev.append(el('option', { value: c.value, textContent: c.label, selected: c.value === s.device }));
  dev.addEventListener('change', () => void bridge.speech.setDevice(dev.value as 'Gpu' | 'Cpu').then(applySpeech));
  page.append(dev);

  if (s.device === 'Cpu') {
    page.append(el('label', { className: 'block', textContent: L('Потоки процессора для диктовки', 'Processor threads for dictation') }));
    const th = el('select');
    th.append(el('option', { value: '0', textContent: L(`Все ядра (${s.cores})`, `All cores (${s.cores})`), selected: s.cpuThreads === 0 }));
    for (let n = 1; n <= s.cores; n++) th.append(el('option', { value: String(n), textContent: String(n), selected: s.cpuThreads === n }));
    th.addEventListener('change', () => void bridge.speech.setThreads(Number(th.value)).then(applySpeech));
    page.append(th, el('p', { className: 'muted hint', textContent: s.threadsHint }));
  }

  page.append(el('p', { className: 'muted line', textContent: s.status }));
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
  if (current === 'brain' && name !== 'brain') void bridge.brain.close();
  current = name;
  if (name === 'file') {
    renderFile();
    void bridge.file.state().then(apply);
    return;
  }
  if (name === 'speech') {
    renderSpeech();
    void bridge.speech.state().then(applySpeech);
    return;
  }
  if (name === 'dictionary') {
    renderDictionary();
    void bridge.dict.state().then((st) => applyDict(st));
    return;
  }
  if (name === 'brain') {
    renderBrain();
    void bridge.brain.state(true).then(applyBrain);
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
bridge.speech.onState(applySpeech);
bridge.brain.onState(applyBrainPush);
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
