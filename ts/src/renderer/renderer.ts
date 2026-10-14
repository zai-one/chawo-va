// Sidebar navigation plus the «Диктовка», «Расшифровка файла», «Распознавание», «Словарь», «Мозг» and «Сеть» pages. Other pages get
// real content as the WPF SettingsWindow is ported. Plain DOM, no framework; paths are set via textContent only.
// «Диктовка» also owns the microphone: getUserMedia → AudioWorklet (mic-processor.js, 16 kHz mono) → main.

interface FileItem { id: number; path: string; state: 'Queued' | 'Running' | 'Done' | 'Failed' | 'Stopped'; note: string; outputPath?: string }
const EXTRA_FORMATS: readonly [string, [string, string]][] = [
  ['vtt', ['Субтитры WebVTT для сайтов и плееров', 'WebVTT subtitles for web players']],
  ['json', ['Фразы со временем для скриптов', 'Timed phrases for scripts']],
  ['md', ['Markdown для заметок', 'Markdown for notes']],
  ['docx', ['Документ Word', 'Word document']],
];
interface FileState {
  items: FileItem[];
  status: string;
  busy: boolean;
  options: { timestamps: boolean; srt: boolean; extra: string[]; parallelism: string; diarize: boolean; brief: boolean };
  ffmpeg: { line: string; canDownload: boolean; installed: boolean };
  url: { line: string; canDownload: boolean; installed: boolean; managed: boolean; busy: boolean; folder: string };
  diarization: { onDisk: boolean; ready: boolean; downloading: boolean; line: string; canDownload: boolean };
  lastOutput: string | null;
  brief: {
    enabled: boolean;
    instruction: string;
    defaultInstruction: string;
    where: string;
    available: boolean;
    text: string;
    path: string | null;
    busy: boolean;
  };
  translate: {
    target: string;
    languages: { code: string; label: string }[];
    where: string;
    available: boolean;
    text: string;
    path: string | null;
    busy: boolean;
  };
  ru: boolean;
  editor: {
    available: boolean;
    reason?: string;
    audioPath: string | null;
    txtPath: string | null;
    segments: { start: number; end: number; text: string; speaker?: number }[];
    mediaUrl: string | null;
    sourceHint?: string;
  };
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
  fromUrl(url: string): Promise<FileState>;
  downloadYtDlp(): Promise<FileState>;
  downloadDiarize(): Promise<FileState>;
  setBriefInstruction(text: string): Promise<FileState>;
  runBrief(path?: string): Promise<FileState>;
  setTranslateTarget(text: string): Promise<FileState>;
  runTranslate(to?: string, path?: string): Promise<FileState>;
  openEditor(path?: string): Promise<FileState>;
  mediaUrl(audioPath: string): Promise<string | null>;
  onState(fn: (s: FileState) => void): () => void;
  onToast(fn: (s: string) => void): () => void;
}
interface MeetingState {
  recording: boolean;
  startedAt: number;
  seconds: number;
  systemOn: boolean;
  systemSupported: boolean;
  capturing: 'mic+system' | 'mic' | null;
  folder: string;
  note: string;
  ru: boolean;
}
type SystemPlan = { kind: 'loopback' } | { kind: 'none' };
interface MeetingApi {
  state(): Promise<MeetingState>;
  start(): Promise<{ ok: boolean; micId: string; system: SystemPlan; state: MeetingState }>;
  systemOpened(ok: boolean, reason?: string): Promise<MeetingState>;
  pcm(chunk: Float32Array): void;
  stop(): Promise<MeetingState>;
  cancel(): Promise<MeetingState>;
  failed(reason: string): Promise<MeetingState>;
  setSystem(on: boolean): Promise<MeetingState>;
  onState(fn: (s: MeetingState) => void): () => void;
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
  idleMinutes: number;
  idleChoices: { value: number; label: string }[];
  idleHint: string;
  status: string;
  download: { kind: string; percent: number | null; text: string; running: boolean; failed: boolean } | null;
  vad: { enabled: boolean; onDisk: boolean; downloading: boolean; canDownload: boolean; note: string } | null;
}
interface SpeechApi {
  state(): Promise<SpeechState>;
  select(kind: string): Promise<SpeechState>;
  setDevice(d: 'Gpu' | 'Cpu'): Promise<SpeechState>;
  setThreads(n: number): Promise<SpeechState>;
  setIdle(minutes: number): Promise<SpeechState>;
  download(kind: string): Promise<SpeechState>;
  cancel(): Promise<SpeechState>;
  dismiss(): Promise<SpeechState>;
  remove(kind: string): Promise<SpeechState>;
  setVad(on: boolean): Promise<SpeechState>;
  downloadVad(): Promise<SpeechState>;
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
  spoken: { punctuation: boolean; numbers: boolean; punctuationLabel: string; punctuationHint: string; numbersLabel: string; numbersHint: string };
  script: { heading: string; command: string; placeholder: string; hint: string; files: boolean; filesLabel: string; testLabel: string; testLine: string; testOk: boolean | null; busy: boolean };
  snippets: { heading: string; hint: string; triggerHeader: string; textHeader: string; triggerPlaceholder: string; textPlaceholder: string; addLabel: string; rows: { id: number; trigger: string; text: string }[] };
}
interface DictApi {
  setScript(command: string): Promise<DictState>;
  setScriptFiles(on: boolean): Promise<DictState>;
  testScript(): Promise<DictState>;
  setSnippet(id: number, trigger: string, text: string): Promise<DictState>;
  addSnippet(): Promise<{ id: number; state: DictState }>;
  removeSnippet(id: number): Promise<DictState>;
  setSpoken(kind: 'punctuation' | 'numbers', on: boolean): Promise<DictState>;
  state(): Promise<DictState>;
  setRow(id: number, from: string, to: string): Promise<DictState>;
  add(): Promise<{ id: number; state: DictState }>;
  remove(id: number): Promise<DictState>;
  suggest(): Promise<DictState>;
  addSuggestion(heard: string, written: string): Promise<DictState>;
}
interface SalesRowDto { id: number; Code: string; Name: string; Line: string; SimilarCode: string }
interface SalesState {
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
  rows: SalesRowDto[];
  ragHeading: string;
  ragIntro: string;
  ragFolder: string;
  ragFolderText: string;
  pickLabel: string;
  clearLabel: string;
  canClear: boolean;
  ragStatus: string;
  modeNote: string;
  salesMode: boolean;
}
interface SalesApi {
  state(): Promise<SalesState>;
  setRow(id: number, code: string, name: string, line: string, similar: string): Promise<SalesState>;
  add(): Promise<{ id: number; state: SalesState }>;
  remove(id: number): Promise<SalesState>;
  pickFolder(): Promise<SalesState>;
  clearFolder(): Promise<SalesState>;
  showCall(extension: string, number: string, manager: string): Promise<SalesState>;
}
interface BrainRow { kind: string | null; label: string; selected: boolean; onDisk: boolean; path: string | null; canDownload: boolean; downloadLabel: string }
interface BrainDownload { kind: string; title: string; intro: string; percent: number | null; text: string; running: boolean; failed: boolean }
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
  download: BrainDownload | null;
  appRules: {
    heading: string;
    hint: string;
    rules: { match: string; edit: string; instruction: string; instructionVisible: boolean; simple: string; active: boolean; hit: boolean }[];
    editVisible: boolean;
    editChoices: { value: string; label: string }[];
    simpleChoices: { value: string; label: string }[];
    matchPlaceholder: string;
    instructionPlaceholder: string;
    last: string;
    lastMatch: string;
    canAdd: boolean;
  };
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
  download(kind: string): Promise<BrainState>;
  cancelDownload(): Promise<BrainState>;
  dismissDownload(): Promise<BrainState>;
  close(): Promise<boolean>;
  onState(fn: (s: BrainState) => void): () => void;
  addRule(match?: string): Promise<BrainState>;
  updateRule(i: number, patch: Record<string, string>): Promise<BrainState>;
  removeRule(i: number): Promise<BrainState>;
  raiseRule(i: number): Promise<BrainState>;
}
type TextPart = string | { link: string; page: string };
type Phase = 'NoModel' | 'Idle' | 'Listening' | 'Recognizing';
interface DictationState {
  ru: boolean;
  intro: string;
  startCard: null | { title: string; close: string; steps: TextPart[][] };
  mode: string;
  modeChoices: { value: string; label: string }[];
  modeHint: string;
  hotkey: number;
  hotkeyChoices: { value: number; label: string }[];
  hotkeyTitle: string;
  insertMode: string;
  insertChoices: { value: string; label: string }[];
  keyNote: string;
  showOverlay: boolean;
  overlayLabel: string;
  overlayTip: string;
  soundCues: boolean;
  soundCuesLabel: string;
  soundCuesTip: string;
  wakeWord: boolean;
  wakeLabel: string;
  wakeTip: string;
  wakeNote: string;
  micId: string;
  micChoices: { value: string; label: string }[];
  micHint: string;
  phase: Phase;
  phaseLine: string;
  stopEnabled: boolean;
  stopLabel: string;
  stopTip: string;
  holdLabel: string;
  holdEnabled: boolean;
  holdHint: string;
  status: string;
  noModel: TextPart[] | null;
  lastText: string;
  lastTextLabel: string;
  client: boolean;
  version: string;
  versionLabel: string;
  checkUpdatesLabel: string;
  checkUpdatesTip: string;
}
interface DictationApi {
  state(): Promise<DictationState>;
  setMode(v: string): Promise<DictationState>;
  setHotkey(vk: number): Promise<DictationState>;
  setInsertMode(v: string): Promise<DictationState>;
  setOverlay(v: boolean): Promise<DictationState>;
  setSoundCues(v: boolean): Promise<DictationState>;
  setMic(id: string): Promise<DictationState>;
  setDevices(list: { id: string; label: string }[], defaultName: string): Promise<DictationState>;
  dismissStartCard(): Promise<DictationState>;
  startTake(): Promise<{ ok: boolean; micId: string; state: DictationState }>;
  appendPcm(chunk: Float32Array): void;
  stopTake(): Promise<DictationState>;
  cancelTake(): Promise<DictationState>;
  micFailed(name: string, message: string): Promise<DictationState>;
  onState(fn: (s: DictationState) => void): () => void;
  onLevel(fn: (v: number) => void): () => void;
  onCue(fn: (cue: { kind: string; tones: CueToneSpec[] }) => void): () => void;
  onHot(fn: (ev: HotEvent) => void): () => void;
  setWakeWord(v: boolean): Promise<DictationState>;
  wakeWant(): Promise<WakeWant>;
  onWake(fn: (want: WakeWant) => void): () => void;
  wakePcm(chunk: Float32Array): void;
  wakeMicFailed(name: string, message: string): Promise<DictationState>;
  checkUpdates(): Promise<DictationState>;
}
/** «Чаво»: keep a microphone open for the word (main decides), on this device ('' = default). */
interface WakeWant { on: boolean; micId: string }
/** The global hold key: the main side already started the take; this side only runs the mic. */
type HotEvent = { kind: 'start'; micId: string } | { kind: 'stop' } | { kind: 'end' };
interface CueToneSpec { freq: number; at: number; ms: number; gain: number }
interface NetworkState {
  ru: boolean;
  heading: string;
  intro: string;
  roleLabel: string;
  role: 'Host' | 'Client';
  roleChoices: { value: string; label: string }[];
  client: boolean;
  host: {
    note: string;
    heading: string;
    status: string;
    lanOn: boolean;
    lanButton: string;
    lanBusy: boolean;
    firewallNote: string;
    keepAwake: boolean;
    keepAwakeLabel: string;
    keepAwakeHint: string;
  };
  remote: {
    note: string;
    hostLabel: string;
    portLabel: string;
    host: string;
    port: number;
    checkLabel: string;
    checking: boolean;
    checkStatus: string;
  };
}
interface NetworkApi {
  state(): Promise<NetworkState>;
  setRole(v: string): Promise<NetworkState>;
  setRemote(host: string, port: string): Promise<NetworkState>;
  checkHost(): Promise<NetworkState>;
  toggleLan(): Promise<NetworkState>;
  setKeepAwake(v: boolean): Promise<NetworkState>;
  onState(fn: (s: NetworkState) => void): () => void;
}
interface HistoryRow { id: string; when: string; seconds: string; final: string; raw: string | null; command: string | null; tag: string; failed: boolean }
interface HistoryState {
  ru: boolean;
  intro: string;
  keepLabel: string;
  keep: string;
  keepChoices: { value: string; label: string }[];
  keepHint: string;
  query: string;
  searchPlaceholder: string;
  rows: HistoryRow[];
  countLine: string;
  empty: string;
  status: string;
  canRerun: boolean;
  rerunTip: string;
  rerunningId: string | null;
  labels: { copy: string; copyRaw: string; rerun: string; remove: string; clearAll: string; rawHeader: string };
}
interface HistoryApi {
  state(): Promise<HistoryState>;
  setQuery(q: string): Promise<HistoryState>;
  setKeep(k: string): Promise<HistoryState>;
  copy(id: string, which: 'final' | 'raw'): Promise<HistoryState>;
  remove(id: string): Promise<HistoryState>;
  clearAll(): Promise<HistoryState>;
  rerun(id: string): Promise<HistoryState>;
  onState(fn: (s: HistoryState) => void): () => void;
}
const bridge = (window as unknown as { chawo: { file: FileApi; meeting: MeetingApi; speech: SpeechApi; dict: DictApi; brain: BrainApi; dictation: DictationApi; network: NetworkApi; sales: SalesApi; history: HistoryApi } }).chawo;

const titlesEn: Record<string, string> = {
  dictation: 'Dictation',
  file: 'File transcription',
  history: 'History',
  speech: 'Speech',
  dictionary: 'Dictionary',
  sales: 'Sales',
  brain: 'Brain',
  network: 'Network',
};
const titles: Record<string, string> = {
  dictation: 'Диктовка',
  file: 'Расшифровка файла',
  history: 'История',
  speech: 'Распознавание',
  dictionary: 'Словарь',
  sales: 'Продажи',
  brain: 'Мозг',
  network: 'Сеть',
};

const page = document.getElementById('page') as HTMLElement;
let current = 'dictation';
let fileState: FileState | null = null;
let meetingState: MeetingState | null = null;
let speechState: SpeechState | null = null;
let dictState: DictState | null = null;
let brainState: BrainState | null = null;
let dictationState: DictationState | null = null;
let networkState: NetworkState | null = null;
let historyState: HistoryState | null = null;
let salesState: SalesState | null = null;
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

const applyNetwork = (st: NetworkState) => {
  const prev = networkState;
  networkState = st;
  if (st.ru !== ru) {
    setLanguage(st.ru);
    return;
  }
  if (current !== 'network') return;
  // A push while the host address is being typed: refresh the status lines only.
  const active = document.activeElement as HTMLElement | null;
  if (prev && prev.role === st.role && active && page.contains(active) && active.tagName === 'INPUT') {
    const set = (key: string, text: string) => {
      const n = page.querySelector<HTMLElement>(`[data-net="${key}"]`);
      if (n) n.textContent = text;
    };
    set('hermes-status', st.host.status);
    set('check-status', st.remote.checkStatus);
    const check = page.querySelector<HTMLButtonElement>('[data-net="check"]');
    if (check) check.disabled = st.remote.checking;
    return;
  }
  renderNetwork();
};

function renderNetwork(): void {
  const s = networkState;
  page.replaceChildren(el('h1', { textContent: title('network') }));
  if (!s) return;
  page.append(el('p', { className: 'muted', textContent: s.intro }));
  page.append(el('label', { className: 'block', textContent: s.roleLabel }));
  const role = selectOf(s.roleChoices, s.role, (v) => void bridge.network.setRole(v).then(applyNetwork));
  role.className = 'wide';
  page.append(role);

  if (!s.client) {
    const h = s.host;
    const box = el('fieldset', {}, el('legend', { textContent: h.heading }));
    box.append(el('p', { textContent: h.note }));
    const status = el('p', { className: 'muted line', textContent: h.status });
    status.dataset.net = 'hermes-status';
    box.append(status);
    const lan = button(h.lanButton, () => {
      lan.disabled = true;
      void bridge.network.toggleLan().then(applyNetwork);
    });
    lan.disabled = h.lanBusy;
    box.append(el('div', { className: 'row' }, lan));
    if (h.firewallNote) box.append(el('p', { className: 'muted hint', textContent: h.firewallNote }));
    const awake = el('input', { type: 'checkbox', checked: h.keepAwake });
    awake.addEventListener('change', () => void bridge.network.setKeepAwake(awake.checked).then(applyNetwork));
    box.append(el('label', { className: 'check' }, awake, ' ' + h.keepAwakeLabel));
    box.append(el('p', { className: 'muted hint indent', textContent: h.keepAwakeHint }));
    page.append(box);
    return;
  }

  const r = s.remote;
  page.append(el('p', { textContent: r.note }));
  const host = el('input', { type: 'text', value: r.host, spellcheck: false, autocomplete: 'off', placeholder: '192.168.1.20' });
  const port = el('input', { type: 'text', value: String(r.port), spellcheck: false, autocomplete: 'off', inputMode: 'numeric' });
  port.style.width = '120px';
  const commit = () => bridge.network.setRemote(host.value, port.value);
  // Saved when the field loses focus (WPF LostFocus); Enter does the same.
  for (const input of [host, port]) {
    input.addEventListener('change', () => void commit().then(applyNetwork));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
  }
  page.append(el('div', { className: 'form' },
    el('span', { textContent: r.hostLabel }), host,
    el('span', { textContent: r.portLabel }), el('div', { className: 'inline' }, port),
  ));
  const check = button(r.checkLabel, () => {
    check.disabled = true;
    void commit().then(() => bridge.network.checkHost()).then(applyNetwork);
  });
  check.dataset.net = 'check';
  check.disabled = r.checking;
  const checkRow = el('div', { className: 'row' }, check);
  checkRow.style.marginTop = '12px';
  page.append(checkRow);
  const status = el('p', { className: 'muted line', textContent: r.checkStatus });
  status.dataset.net = 'check-status';
  page.append(status);
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
    const busy = s.download?.running === true;
    const rows = el('div', { className: 'models' });
    for (const r of v.rows) {
      const row = el('div', { className: 'model' });
      if (r.kind) {
        const radio = el('input', { type: 'radio', name: 'brain-model', checked: r.selected, disabled: busy });
        const kind = r.kind;
        radio.addEventListener('change', () => void bridge.brain.setLocalModel(kind).then(applyBrain));
        row.append(el('label', {}, radio, ' ', r.label));
      } else {
        row.append(el('label', { textContent: r.label }));
      }
      if (r.onDisk) row.append(el('span', { className: 'disk', textContent: L('на диске', 'on disk') }));
      if (r.kind && r.canDownload) {
        const kind = r.kind;
        const dl = button(r.downloadLabel, () => void bridge.brain.download(kind).then(applyBrain));
        dl.disabled = busy;
        row.append(dl);
      }
      if (r.path) {
        const path = r.path;
        const del = button(L('Удалить', 'Delete'), () => void bridge.brain.deleteGguf(path).then(applyBrain));
        del.disabled = busy && r.selected;
        row.append(del);
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
    const d = s.download;
    if (d) {
      const card = el('div', { className: `card${d.failed ? ' failed' : ''}` });
      card.append(el('div', { textContent: d.title }), el('p', { className: 'muted hint', textContent: d.intro }));
      if (d.running) {
        const bar = el('div', { className: `progress${d.percent === null ? ' indeterminate' : ''}` }, el('div'));
        if (d.percent !== null) (bar.firstChild as HTMLElement).style.width = `${d.percent.toFixed(1)}%`;
        card.append(bar);
      }
      card.append(el('p', { className: 'status muted', textContent: d.text }));
      const act = el('div', { className: 'row' });
      if (d.running) act.append(button(L('Отмена', 'Cancel'), () => void bridge.brain.cancelDownload().then(applyBrain)));
      else {
        if (d.failed) act.append(button(L('Повторить', 'Retry'), () => void bridge.brain.download(d.kind).then(applyBrain), 'primary'));
        act.append(button(L('Скрыть', 'Hide'), () => void bridge.brain.dismissDownload().then(applyBrain), 'link'));
      }
      card.append(act);
      page.append(card);
    } else if (v.rows.some((r) => r.canDownload)) {
      page.append(el('p', { className: 'muted hint', textContent: L('Пока кнопка «Скачать» не нажата, в сеть ничего не уходит.', 'Nothing goes out on the network until you press Download.') }));
    }
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
  renderAppRules(s);
}

/** «Для отдельных программ»: one card per rule, the first matching rule from the top wins. */
function renderAppRules(s: BrainState): void {
  const v = s.appRules;
  page.append(el('label', { className: 'block', textContent: v.heading }), el('p', { className: 'muted hint', textContent: v.hint }));
  v.rules.forEach((r, i) => {
    const card = el('div', { className: `card app-rule${r.hit ? ' hit' : ''}${r.active ? '' : ' inactive'}` });
    card.dataset.rule = String(i);
    const match = el('input', { type: 'text', value: r.match, spellcheck: false, placeholder: v.matchPlaceholder });
    match.dataset.rule = 'match';
    match.addEventListener('change', () => void bridge.brain.updateRule(i, { match: match.value }).then(applyBrain));
    const head = el('div', { className: 'card-head' }, match);
    if (i > 0) head.append(button('↑', () => void bridge.brain.raiseRule(i).then(applyBrain), 'link'));
    head.append(button(L('Удалить', 'Delete'), () => void bridge.brain.removeRule(i).then(applyBrain), 'link'));
    card.append(head);
    const row = el('div', { className: 'row' });
    if (v.editVisible) {
      const edit = selectOf(v.editChoices, r.edit, (x) => void bridge.brain.updateRule(i, { edit: x }).then(applyBrain));
      edit.dataset.rule = 'edit';
      row.append(edit);
    }
    const simple = selectOf(v.simpleChoices, r.simple, (x) => void bridge.brain.updateRule(i, { simple: x }).then(applyBrain));
    simple.dataset.rule = 'simple';
    row.append(simple);
    card.append(row);
    if (r.instructionVisible) {
      const box = el('textarea', { value: r.instruction, spellcheck: false, rows: 3, placeholder: v.instructionPlaceholder });
      box.dataset.rule = 'instruction';
      box.addEventListener('change', () => void bridge.brain.updateRule(i, { instruction: box.value }).then((st) => { brainState = st; }));
      card.append(box);
    }
    page.append(card);
  });
  if (v.last) page.append(el('p', { className: 'muted hint line', textContent: v.last }));
  const act = el('div', { className: 'row' });
  if (v.canAdd) {
    const add = button(L('Добавить правило', 'Add a rule'), () => void bridge.brain.addRule().then(applyBrain));
    add.dataset.rule = 'add';
    act.append(add);
    if (v.lastMatch) {
      const name = v.lastMatch;
      const quick = button(L(`Добавить для ${name}`, `Add for ${name}`), () => void bridge.brain.addRule(name).then(applyBrain));
      quick.dataset.rule = 'add-last';
      act.append(quick);
    }
  }
  page.append(act);
}


// ── «Диктовка» ───────────────────────────────────────────────

const METER_BARS = 28;
const meter: number[] = new Array(METER_BARS).fill(0);

/** One take's capture: mic stream → 16 kHz AudioContext → worklet → chunks to main. */
class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private flushed: (() => void) | null = null;

  async start(deviceId: string, onChunk: (c: Float32Array) => void): Promise<void> {
    const ask = (id: string) => navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        channelCount: 1,
        // Raw input like WPF waveIn: recognition normalizes the level itself.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    try {
      this.stream = await ask(deviceId);
    } catch (e) {
      // A saved device that is gone: fall back to the default input like Recorder.StartAsync.
      const name = (e as DOMException)?.name;
      if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError' && name !== 'NotReadableError')) throw e;
      this.stream = await ask('');
    }
    try {
      this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    await this.ctx.audioWorklet.addModule('mic-processor.js');
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'chawo-mic', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) onChunk(e.data);
      else if (e.data === 'flushed') this.flushed?.();
    };
    source.connect(this.node);
    // The worklet writes nothing to its output, so this only keeps the graph pulling: no sound plays.
    this.node.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Sends the last partial chunk, then releases the mic (its indicator goes off between takes). */
  async stop(): Promise<void> {
    if (this.node) {
      const done = new Promise<void>((r) => { this.flushed = r; setTimeout(r, 250); });
      this.node.port.postMessage('flush');
      await done;
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}

let holdPressed = false;
let startJob: Promise<MicCapture | null> | null = null;
let activeCapture: MicCapture | null = null;
let dictationShape = '';

async function refreshMicDevices(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((d) => d.kind === 'audioinput');
    const def = inputs.find((d) => d.deviceId === 'default');
    const defaultName = (def?.label ?? '').replace(/^(default|по умолчанию)\s*[-—:]\s*/i, '');
    const list = inputs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label }));
    applyDictation(await bridge.dictation.setDevices(list, defaultName));
  } catch {
    /* no mediaDevices: the list keeps only the default row */
  }
}

async function beginTake(): Promise<MicCapture | null> {
  const r = await bridge.dictation.startTake();
  applyDictation(r.state);
  if (!r.ok) {
    // No model, client role or busy: the status says why; the button does not pretend to listen.
    holdPressed = false;
    updateDictationLive();
    return null;
  }
  const cap = new MicCapture();
  try {
    await cap.start(r.micId, (c) => bridge.dictation.appendPcm(c));
  } catch (e) {
    await cap.stop().catch(() => undefined);
    const err = e as DOMException;
    applyDictation(await bridge.dictation.micFailed(err?.name ?? 'Error', err?.message ?? String(e)));
    holdPressed = false;
    updateDictationLive();
    return null;
  }
  activeCapture = cap;
  return cap;
}

function holdDown(): void {
  if (holdPressed || dictationState?.phase === 'Recognizing') return;
  holdPressed = true;
  updateDictationLive();
  startJob = beginTake();
}

async function holdUp(): Promise<void> {
  if (!holdPressed) return;
  holdPressed = false;
  updateDictationLive();
  const job = startJob;
  startJob = null;
  const cap = job ? await job : null;
  if (!cap || activeCapture !== cap) return;
  activeCapture = null;
  await cap.stop();
  applyDictation(await bridge.dictation.stopTake());
  void refreshMicDevices();
}

// ── the global hold key (Windows helper) ──
// The key is seen by the main process; the take is already started there. The mic lives here, so the
// main side asks us to open it, to stop it (then recognize), or to drop it (Escape). Window focus does
// not matter: the window may be hidden in the tray.
let hotJob: Promise<MicCapture | null> | null = null;

async function hotOpen(micId: string): Promise<MicCapture | null> {
  const cap = new MicCapture();
  try {
    await cap.start(micId, (c) => bridge.dictation.appendPcm(c));
  } catch (e) {
    await cap.stop().catch(() => undefined);
    const err = e as DOMException;
    applyDictation(await bridge.dictation.micFailed(err?.name ?? 'Error', err?.message ?? String(e)));
    return null;
  }
  activeCapture = cap;
  return cap;
}

async function hotClose(recognize: boolean): Promise<void> {
  const job = hotJob;
  hotJob = null;
  const cap = job ? await job : null;
  if (cap && activeCapture === cap) {
    activeCapture = null;
    await cap.stop();
  } else if (cap) await cap.stop().catch(() => undefined);
  if (recognize && cap) applyDictation(await bridge.dictation.stopTake());
}

// ── «Чаво»: an always-on capture for the word, separate from the take's own capture ──
// Main asks for it only while the setting is on and recognition is local. Its chunks go to the word's
// detector; during a take started by the word the main side feeds them into that take.
let wakeCapture: MicCapture | null = null;
let wakeKey = '';
let wakeJob: Promise<void> = Promise.resolve();

function applyWake(want: WakeWant): void {
  const key = want.on ? `on|${want.micId}` : 'off';
  if (key === wakeKey) return;
  wakeKey = key;
  wakeJob = wakeJob.then(async () => {
    if (wakeCapture) {
      const cap = wakeCapture;
      wakeCapture = null;
      await cap.stop().catch(() => undefined);
    }
    if (!want.on || wakeKey !== key) return;
    const cap = new MicCapture();
    try {
      await cap.start(want.micId, (c) => bridge.dictation.wakePcm(c));
    } catch (e) {
      await cap.stop().catch(() => undefined);
      const err = e as DOMException;
      wakeKey = '';
      applyDictation(await bridge.dictation.wakeMicFailed(err?.name ?? 'Error', err?.message ?? String(e)));
      return;
    }
    if (wakeKey !== key) {
      await cap.stop().catch(() => undefined);
      return;
    }
    wakeCapture = cap;
    document.documentElement.dataset.wake = 'listening';
  }).finally(() => {
    if (!wakeCapture) document.documentElement.dataset.wake = 'off';
  });
}
bridge.dictation.onWake(applyWake);
void bridge.dictation.wakeWant().then(applyWake);

bridge.dictation.onHot((ev) => {
  if (ev.kind === 'start') {
    if (hotJob) return;
    hotJob = hotOpen(ev.micId);
  } else void hotClose(ev.kind === 'stop');
});

function cancelTake(): void {
  holdPressed = false;
  void bridge.dictation.cancelTake().then(applyDictation);
}

const applyDictation = (s: DictationState) => {
  dictationState = s;
  // The take ended on the main side (5-minute cap, Stop, Escape): release the mic.
  if (activeCapture && s.phase !== 'Listening') {
    const cap = activeCapture;
    activeCapture = null;
    holdPressed = false;
    void cap.stop();
  }
  if (s.phase !== 'Listening') meter.fill(0);
  if (s.ru !== ru) { setLanguage(s.ru); return; }
  if (current !== 'dictation') return;
  if (shapeOf(s) === dictationShape && page.querySelector('[data-d="hold"]')) updateDictationLive();
  else renderDictation();
};

/** Everything except the live take fields; a change here redraws the page, otherwise it updates in place. */
function shapeOf(s: DictationState): string {
  const { phase: _p, phaseLine: _l, stopEnabled: _s, holdLabel: _h, holdEnabled: _e, status: _st, lastText: _t, ...rest } = s;
  return JSON.stringify(rest);
}

function partsTo(parent: HTMLElement, parts: TextPart[]): HTMLElement {
  for (const p of parts) {
    if (typeof p === 'string') parent.append(p);
    else parent.append(button(p.link, () => document.querySelector<HTMLButtonElement>(`.nav button[data-page="${p.page}"]`)?.click(), 'link inline-link'));
  }
  return parent;
}

function renderDictation(): void {
  const s = dictationState;
  page.replaceChildren(el('h1', { textContent: title('dictation') }));
  if (!s) return;
  dictationShape = shapeOf(s);
  page.append(el('p', { className: 'muted', textContent: s.intro }));

  if (s.startCard) {
    const c = s.startCard;
    const card = el('div', { className: 'card start' },
      el('div', { className: 'card-head' },
        el('strong', { textContent: c.title }),
        button(c.close, () => void bridge.dictation.dismissStartCard().then(applyDictation), 'link'),
      ));
    for (const step of c.steps) card.append(partsTo(el('p', { className: 'step' }), step));
    page.append(card);
  }

  page.append(el('label', { className: 'block', textContent: L('Режим', 'Mode') }),
    selectOf(s.modeChoices, s.mode, (v) => void bridge.dictation.setMode(v).then(applyDictation)),
    el('p', { className: 'muted hint', textContent: s.modeHint }));

  // Phase line + Stop (WPF), then the in-window hold button with the level meter.
  const stop = button(s.stopLabel, () => cancelTake());
  stop.dataset.d = 'stop';
  stop.title = s.stopTip;
  const phase = el('div', { className: 'card phase' }, el('span', { className: 'phase-line' }), stop);
  (phase.firstChild as HTMLElement).dataset.d = 'phase';
  page.append(phase);

  const hold = el('button', { className: 'hold', type: 'button' });
  hold.dataset.d = 'hold';
  hold.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { hold.setPointerCapture(e.pointerId); } catch { /* synthetic or already-gone pointer */ }
    holdDown();
  });
  hold.addEventListener('keydown', (e) => {
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); holdDown(); }
  });
  hold.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); void holdUp(); }
  });
  hold.addEventListener('contextmenu', (e) => e.preventDefault());
  const bars = el('div', { className: 'meter' });
  bars.dataset.d = 'meter';
  for (let i = 0; i < METER_BARS; i++) bars.append(el('span'));
  page.append(el('div', { className: 'hold-row' }, hold, bars), el('p', { className: 'muted hint', textContent: s.holdHint }));

  const status = el('p', { className: 'status line' });
  status.dataset.d = 'status';
  page.append(status);
  if (s.noModel) page.append(partsTo(el('p', { className: 'muted hint line' }), s.noModel));
  const last = el('div', { className: 'card result' });
  last.dataset.d = 'last';
  last.append(el('div', { className: 'muted hint', textContent: s.lastTextLabel }), el('div', { className: 'last-text' }));
  page.append(last);

  const form = el('div', { className: 'form wide' });
  form.append(el('span', { textContent: L('Клавиша диктовки', 'Dictation key') }),
    selectOf(s.hotkeyChoices.map((c) => ({ value: String(c.value), label: c.label })), String(s.hotkey),
      (v) => void bridge.dictation.setHotkey(Number(v)).then(applyDictation)));
  form.append(el('span', { textContent: L('Как вставлять текст', 'How to insert text') }),
    selectOf(s.insertChoices, s.insertMode, (v) => void bridge.dictation.setInsertMode(v).then(applyDictation)));
  page.append(form);
  if (s.keyNote) page.append(el('p', { className: 'muted hint', textContent: s.keyNote }));

  page.append(el('label', { className: 'block', textContent: L('Микрофон', 'Microphone') }));
  const mic = selectOf(s.micChoices, s.micId, (v) => void bridge.dictation.setMic(v).then(applyDictation));
  mic.classList.add('wide');
  page.append(mic, el('p', { className: 'muted hint', textContent: s.micHint }));

  const ov = el('input', { type: 'checkbox', checked: s.showOverlay });
  ov.addEventListener('change', () => void bridge.dictation.setOverlay(ov.checked).then(applyDictation));
  const ovLabel = el('label', { className: 'check' }, ov, ' ', s.overlayLabel);
  ovLabel.title = s.overlayTip;
  page.append(ovLabel);

  const cue = el('input', { type: 'checkbox', checked: s.soundCues });
  cue.dataset.d = 'cues';
  cue.addEventListener('change', () => void bridge.dictation.setSoundCues(cue.checked).then(applyDictation));
  const cueLabel = el('label', { className: 'check' }, cue, ' ', s.soundCuesLabel);
  cueLabel.title = s.soundCuesTip;
  page.append(cueLabel);

  const wake = el('input', { type: 'checkbox', checked: s.wakeWord });
  wake.dataset.d = 'wake';
  wake.addEventListener('change', () => void bridge.dictation.setWakeWord(wake.checked).then(applyDictation));
  const wakeLabel = el('label', { className: 'check' }, wake, ' ', s.wakeLabel);
  wakeLabel.title = s.wakeTip;
  page.append(wakeLabel);
  if (s.wakeNote) {
    const note = el('p', { className: 'muted hint', textContent: s.wakeNote });
    note.dataset.d = 'wake-note';
    page.append(note);
  }

  // Manual update check (WPF CheckUpdatesButton at the bottom of Dictation). Check only; opens the release page if the user confirms.
  const upd = button(s.checkUpdatesLabel, () => {
    upd.disabled = true;
    void bridge.dictation.checkUpdates().then(applyDictation).finally(() => { upd.disabled = false; });
  });
  upd.dataset.d = 'updates';
  upd.title = s.checkUpdatesTip;
  page.append(upd);
  if (s.version) {
    page.append(el('p', { className: 'muted hint', textContent: `${s.versionLabel} ${s.version}` }));
  }

  updateDictationLive();
}

/** Phase, Stop, hold button, status and the last phrase, without rebuilding the page (a held button keeps its pointer). */
function updateDictationLive(): void {
  const s = dictationState;
  if (!s || current !== 'dictation') return;
  const q = (k: string) => page.querySelector<HTMLElement>(`[data-d="${k}"]`);
  const phase = q('phase');
  if (phase) phase.textContent = s.phaseLine;
  const stop = q('stop') as HTMLButtonElement | null;
  if (stop) stop.disabled = !s.stopEnabled;
  const hold = q('hold') as HTMLButtonElement | null;
  if (hold) {
    const listening = holdPressed || s.phase === 'Listening';
    hold.textContent = holdPressed && s.phase !== 'Listening' ? L('Говорите… отпустите, чтобы распознать', 'Speak… release to recognize') : s.holdLabel;
    hold.classList.toggle('pressed', listening);
    hold.classList.toggle('busy', s.phase === 'Recognizing');
    hold.disabled = !s.holdEnabled && !holdPressed;
  }
  const status = q('status');
  if (status) status.textContent = s.status;
  const last = q('last');
  if (last) {
    last.hidden = !s.lastText;
    (last.lastElementChild as HTMLElement).textContent = s.lastText;
  }
  drawMeter();
}

function drawMeter(): void {
  const bars = page.querySelector<HTMLElement>('[data-d="meter"]');
  if (!bars) return;
  const kids = bars.children;
  for (let i = 0; i < kids.length; i++) (kids[i] as HTMLElement).style.height = `${Math.round(8 + 92 * meter[i])}%`;
}

// Sound cues: tones come from main (core/cues.ts); synthesised here, so no audio files and no network.
let cueCtx: AudioContext | null = null;
let cuesPlayed = 0;
function playCue(cue: { kind: string; tones: CueToneSpec[] }): void {
  if (!cue || !Array.isArray(cue.tones)) return;
  try {
    cueCtx ??= new AudioContext();
    if (cueCtx.state === 'suspended') void cueCtx.resume();
    const t0 = cueCtx.currentTime + 0.01;
    for (const tone of cue.tones.slice(0, 8)) {
      const freq = Math.min(4000, Math.max(80, Number(tone.freq) || 0));
      const at = Math.min(1000, Math.max(0, Number(tone.at) || 0)) / 1000;
      const len = Math.min(500, Math.max(10, Number(tone.ms) || 0)) / 1000;
      const peak = Math.min(0.1, Math.max(0, Number(tone.gain) || 0));
      const osc = cueCtx.createOscillator();
      const gain = cueCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // 8 ms fade in and out: no clicks.
      const fade = Math.min(0.008, len / 3);
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(peak, t0 + at + fade);
      gain.gain.setValueAtTime(peak, t0 + at + len - fade);
      gain.gain.linearRampToValueAtTime(0, t0 + at + len);
      osc.connect(gain).connect(cueCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
    cuesPlayed++;
    document.documentElement.dataset.cues = `${cuesPlayed}:${cue.kind}:${cueCtx.state}`;
  } catch {
    /* no audio output: the cue is a nicety, the take goes on */
  }
}

function onLevel(v: number): void {
  meter.shift();
  meter.push(Math.max(0, Math.min(1, Number(v) || 0)));
  if (current === 'dictation') drawMeter();
}

window.addEventListener('pointerup', () => void holdUp());
window.addEventListener('pointercancel', () => void holdUp());
// A lost window (Alt+Tab while holding) ends the take instead of leaving it stuck.
window.addEventListener('blur', () => void holdUp());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dictationState && (dictationState.phase === 'Listening' || dictationState.phase === 'Recognizing')) cancelTake();
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshMicDevices());

function setLanguage(r: boolean): void {
  ru = r;
  document.documentElement.lang = r ? 'ru' : 'en';
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav button'))) b.textContent = title(b.dataset.page ?? '');
  if (current === 'speech') renderSpeech();
  else if (current === 'dictation') renderDictation();
  else if (current === 'dictionary') renderDictionary();
  else if (current === 'brain') renderBrain();
  else if (current === 'network') renderNetwork();
  else if (current === 'history') renderHistory();
  else if (current === 'sales') renderSales();
  else if (current !== 'file') show(current);
}

const applyHistory = (st: HistoryState) => {
  historyState = st;
  if (st.ru !== ru) {
    setLanguage(st.ru);
    return;
  }
  if (current !== 'history') return;
  // While the search box is being typed in, only the list and the lines below it are redrawn.
  const search = page.querySelector<HTMLInputElement>('[data-history="search"]');
  if (search && document.activeElement === search) {
    fillHistoryList(st);
    return;
  }
  renderHistory();
};

function fillHistoryList(s: HistoryState): void {
  const list = page.querySelector<HTMLElement>('[data-history="list"]');
  const count = page.querySelector<HTMLElement>('[data-history="count"]');
  const status = page.querySelector<HTMLElement>('[data-history="status"]');
  if (count) count.textContent = s.countLine;
  if (status) status.textContent = s.status;
  if (!list) return;
  list.replaceChildren();
  if (s.rows.length === 0) {
    list.append(el('div', { className: 'empty muted', textContent: s.empty }));
    return;
  }
  for (const r of s.rows) {
    const head = el('div', { className: 'hist-head muted' }, el('span', { textContent: `${r.when} · ${r.seconds}` }));
    if (r.command) head.append(el('span', { className: 'hist-cmd', textContent: `«${r.command}»` }));
    if (r.tag) head.append(el('span', { className: `hist-tag${r.failed ? ' failed' : ''}`, textContent: r.tag }));
    const item = el('div', { className: 'hist-item' }, head, el('div', { className: 'hist-text', textContent: r.final }));
    if (r.raw) item.append(el('div', { className: 'hist-raw muted' }, el('span', { textContent: s.labels.rawHeader + ' ' }), r.raw));
    const acts = el('div', { className: 'row hist-acts' },
      button(s.labels.copy, () => void bridge.history.copy(r.id, 'final').then(applyHistory)),
    );
    if (r.raw) acts.append(button(s.labels.copyRaw, () => void bridge.history.copy(r.id, 'raw').then(applyHistory), 'link'));
    const again = button(s.rerunningId === r.id ? '…' : s.labels.rerun, () => void bridge.history.rerun(r.id).then(applyHistory), 'link');
    again.disabled = !s.canRerun;
    if (s.rerunTip) again.title = s.rerunTip;
    acts.append(again, button(s.labels.remove, () => void bridge.history.remove(r.id).then(applyHistory), 'link'));
    item.append(acts);
    list.append(item);
  }
}

function renderHistory(): void {
  const s = historyState;
  page.replaceChildren(el('h1', { textContent: title('history') }));
  if (!s) return;
  page.append(el('p', { className: 'muted', textContent: s.intro }));
  const keep = selectOf(s.keepChoices, s.keep, (v) => void bridge.history.setKeep(v).then(applyHistory));
  keep.setAttribute('aria-label', s.keepLabel);
  const search = el('input', { type: 'text', value: s.query, placeholder: s.searchPlaceholder, spellcheck: false });
  search.dataset.history = 'search';
  search.className = 'hist-search';
  search.addEventListener('input', () => void bridge.history.setQuery(search.value).then(applyHistory));
  const clear = button(s.labels.clearAll, () => void bridge.history.clearAll().then(applyHistory), 'link');
  clear.disabled = s.rows.length === 0 && !s.query;
  page.append(el('div', { className: 'row' }, search, el('label', {}, s.keepLabel + ' ', keep), clear));
  page.append(el('p', { className: 'muted hint', textContent: s.keepHint }));
  const status = el('p', { className: 'status line' });
  status.dataset.history = 'status';
  const list = el('div', { className: 'hist' });
  list.dataset.history = 'list';
  const count = el('p', { className: 'muted hint' });
  count.dataset.history = 'count';
  page.append(status, list, count);
  fillHistoryList(s);
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

  // Voice punctuation and numbers: two switches, each with one hint line.
  const sp = s.spoken;
  const punct = el('input', { type: 'checkbox', checked: sp.punctuation });
  punct.dataset.dict = 'punctuation';
  punct.addEventListener('change', () => void bridge.dict.setSpoken('punctuation', punct.checked).then((st) => applyDict(st)));
  page.append(el('label', { className: 'check' }, punct, ' ' + sp.punctuationLabel),
    el('p', { className: 'muted hint indent', textContent: sp.punctuationHint }));
  const nums = el('input', { type: 'checkbox', checked: sp.numbers });
  nums.dataset.dict = 'numbers';
  nums.addEventListener('change', () => void bridge.dict.setSpoken('numbers', nums.checked).then((st) => applyDict(st)));
  page.append(el('label', { className: 'check' }, nums, ' ' + sp.numbersLabel),
    el('p', { className: 'muted hint indent', textContent: sp.numbersHint }));

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

  // «Сниппеты»: compact block — trigger, text (grows with lines), delete.
  const sn = s.snippets;
  const snBox = el('fieldset', { className: 'snippets' }, el('legend', { textContent: sn.heading }),
    el('p', { className: 'muted hint', textContent: sn.hint }));
  snBox.dataset.dict = 'snippets';
  for (const r of sn.rows) {
    const trig = el('input', { type: 'text', value: r.trigger, placeholder: sn.triggerPlaceholder, spellcheck: false });
    const body = el('textarea', { value: r.text, placeholder: sn.textPlaceholder, spellcheck: false, rows: Math.min(6, Math.max(1, r.text.split('\n').length)) });
    trig.setAttribute('aria-label', sn.triggerHeader);
    body.setAttribute('aria-label', sn.textHeader);
    trig.dataset.dict = 'snippetTrigger';
    body.dataset.dict = 'snippetText';
    const send = () => void bridge.dict.setSnippet(r.id, trig.value, body.value).then((st) => { dictState = st; });
    trig.addEventListener('input', send);
    body.addEventListener('input', () => { body.rows = Math.min(6, Math.max(1, body.value.split('\n').length)); send(); });
    const del = button(s.deleteLabel, () => void bridge.dict.removeSnippet(r.id).then((st) => applyDict(st)));
    snBox.append(el('div', { className: 'snippet-row' }, trig, body, del));
    if (r.id === focusId) focusEl = trig;
  }
  const addSn = button(sn.addLabel, () => void bridge.dict.addSnippet().then((res) => applyDict(res.state, res.id)));
  addSn.dataset.dict = 'snippetAdd';
  snBox.append(el('div', { className: 'row' }, addSn));
  page.append(snBox);

  // «Свой скрипт»: last, for people who write code. One field, one switch, one check button.
  const sc = s.script;
  const cmd = el('input', { type: 'text', value: sc.command, placeholder: sc.placeholder, spellcheck: false });
  cmd.dataset.dict = 'script';
  cmd.setAttribute('aria-label', sc.heading);
  cmd.className = 'grow';
  cmd.addEventListener('input', () => void bridge.dict.setScript(cmd.value).then((st) => { dictState = st; }));
  const test = button(sc.testLabel, () => {
    test.disabled = true;
    void bridge.dict.setScript(cmd.value).then(() => bridge.dict.testScript()).then((st) => applyDict(st));
  });
  test.dataset.dict = 'scriptTest';
  test.disabled = sc.busy;
  const files = el('input', { type: 'checkbox', checked: sc.files });
  files.dataset.dict = 'scriptFiles';
  files.addEventListener('change', () => void bridge.dict.setScriptFiles(files.checked).then((st) => applyDict(st)));
  const box = el('fieldset', { className: 'post-script' }, el('legend', { textContent: sc.heading }),
    el('p', { className: 'muted hint', textContent: sc.hint }),
    el('div', { className: 'row' }, cmd, test),
    el('label', { className: 'check' }, files, ' ' + sc.filesLabel));
  if (sc.testLine) {
    const line = el('p', { className: 'status line' + (sc.testOk === false ? ' warn' : ''), textContent: sc.testLine });
    line.dataset.dict = 'scriptResult';
    box.append(line);
  }
  page.append(box);
  if (focusEl) focusEl.focus();
}

const applySales = (st: SalesState, focusId?: number) => {
  salesState = st;
  if (st.ru !== ru) setLanguage(st.ru);
  else if (current === 'sales') renderSales(focusId);
};

function renderSales(focusId?: number): void {
  const s = salesState;
  page.replaceChildren(el('h1', { textContent: title('sales') }));
  if (!s) return;
  page.append(el('p', { className: 'muted', textContent: s.intro }));
  page.append(el('p', { className: s.salesMode ? 'hint' : 'hint warn', textContent: s.modeNote }));

  // Catalog: code, name, short line, similar code; saved on every edit, the page is not redrawn.
  const table = el('div', { className: 'dict sales' },
    el('div', { className: 'dict-row head muted' },
      el('span', { textContent: s.codeHeader }),
      el('span', { textContent: s.nameHeader }),
      el('span', { textContent: s.lineHeader }),
      el('span', { textContent: s.similarHeader }),
      el('span'),
    ),
  );
  let focusEl: HTMLInputElement | null = null;
  for (const r of s.rows) {
    const box = (value: string, label: string) => {
      const i = el('input', { type: 'text', value, spellcheck: false });
      i.setAttribute('aria-label', label);
      return i;
    };
    const code = box(r.Code, s.codeHeader);
    const name = box(r.Name, s.nameHeader);
    const line = box(r.Line, s.lineHeader);
    const similar = box(r.SimilarCode, s.similarHeader);
    const send = () => void bridge.sales.setRow(r.id, code.value, name.value, line.value, similar.value).then((st) => { salesState = st; });
    for (const i of [code, name, line, similar]) i.addEventListener('input', send);
    const del = button(s.deleteLabel, () => void bridge.sales.remove(r.id).then((st) => applySales(st)));
    table.append(el('div', { className: 'dict-row' }, code, name, line, similar, del));
    if (r.id === focusId) focusEl = code;
  }
  page.append(table);
  page.append(el('div', { className: 'row' },
    button(s.addLabel, () => void bridge.sales.add().then((res) => applySales(res.state, res.id))),
  ));

  // Materials folder (local RAG).
  const rag = el('fieldset', {}, el('legend', { textContent: s.ragHeading }), el('p', { className: 'muted hint', textContent: s.ragIntro }));
  const folder = el('input', { type: 'text', value: s.ragFolderText, readOnly: true, spellcheck: false });
  folder.setAttribute('aria-label', s.ragHeading);
  const clear = button(s.clearLabel, () => void bridge.sales.clearFolder().then((st) => applySales(st)));
  clear.disabled = !s.canClear;
  rag.append(el('div', { className: 'folder-row' }, folder,
    button(s.pickLabel, () => void bridge.sales.pickFolder().then((st) => applySales(st))),
    clear,
  ));
  rag.append(el('p', { className: 'muted hint', textContent: s.ragStatus }));
  page.append(rag);

  // Call stand-in.
  const call = el('fieldset', {}, el('legend', { textContent: s.callHeading }), el('p', { className: 'muted hint', textContent: s.callIntro }));
  const field = (value: string, label: string) => {
    const i = el('input', { type: 'text', value, spellcheck: false, autocomplete: 'off' });
    i.setAttribute('aria-label', label);
    return el('label', { className: 'stack' }, el('span', { className: 'muted', textContent: label }), i);
  };
  const ext = field(s.call.extension, s.extensionHeader);
  const num = field(s.call.number, s.numberHeader);
  const mgr = field(s.call.manager, s.managerHeader);
  const val = (l: HTMLElement) => (l.querySelector('input') as HTMLInputElement).value;
  call.append(el('div', { className: 'call-row' }, ext, num, mgr));
  call.append(el('div', { className: 'row' },
    button(s.showCallLabel, () => void bridge.sales.showCall(val(ext), val(num), val(mgr)).then((st) => applySales(st))),
  ));
  if (s.call.status) call.append(el('p', { className: 'muted hint', textContent: s.call.status }));
  page.append(call);
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

  if (s.vad) {
    const v = s.vad;
    const cb = el('input', { type: 'checkbox', checked: v.enabled });
    cb.addEventListener('change', () => void bridge.speech.setVad(cb.checked).then(applySpeech));
    page.append(el('label', { className: 'block' }, cb, L(' Обрезать тишину (VAD)', ' Trim silence (VAD)')));
    const hint = el('p', { className: 'muted hint', textContent: v.note });
    if (v.canDownload) hint.append(' ', button(L('Скачать (2 МБ)', 'Download (2 MB)'), () => void bridge.speech.downloadVad().then(applySpeech), 'link'));
    page.append(hint);
  }

  page.append(el('label', { className: 'block', textContent: L('Выгружать модели при простое', 'Unload models when idle') }));
  const idle = el('select');
  for (const c of s.idleChoices) idle.append(el('option', { value: String(c.value), textContent: c.label, selected: c.value === s.idleMinutes }));
  idle.addEventListener('change', () => void bridge.speech.setIdle(Number(idle.value)).then(applySpeech));
  page.append(idle, el('p', { className: 'muted hint', textContent: s.idleHint }));

  page.append(el('p', { className: 'muted line', textContent: s.status }));
}

/** Reused across File page re-renders so seek/play position is not lost on status pushes. */
let editorAudio: HTMLAudioElement | null = null;
let editorAudioUrl: string | null = null;

function formatSegTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function ensureEditorAudio(mediaUrl: string): HTMLAudioElement {
  if (editorAudio && editorAudioUrl === mediaUrl) return editorAudio;
  const a = document.createElement('audio');
  a.controls = true;
  a.preload = 'metadata';
  a.className = 'transcript-audio';
  a.src = mediaUrl;
  editorAudio = a;
  editorAudioUrl = mediaUrl;
  return a;
}

/** The link field survives the page re-rendering on every queue push (text, focus, caret). */
let urlDraft = '';
/** «Перевести»: what the user is typing in the language field; null = show the saved value. */
let translateDraft: string | null = null;

function renderFile(): void {
  const s = fileState;
  const prev = document.activeElement as HTMLInputElement | null;
  const hadFocus = prev?.id === 'file-url';
  const langFocus = prev?.id === 'translate-to' ? [prev.selectionStart, prev.selectionEnd] : null;
  const caret = hadFocus ? [prev!.selectionStart, prev!.selectionEnd] : null;
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
    // Actions share the last grid column, so «Показать» + «Слушать» + × stay on one line.
    const acts = el('span', { className: 'acts' });
    if (it.outputPath) {
      acts.append(button(L('Показать', 'Show'), () => void bridge.file.reveal(it.outputPath), 'link'));
      acts.append(button(L('Слушать', 'Listen'), () => void bridge.file.openEditor(it.outputPath).then(apply), 'link'));
    }
    if (it.state !== 'Running') acts.append(button('×', () => void bridge.file.remove(it.id).then(apply), 'link x'));
    row.append(acts);
    list.append(row);
  }
  page.append(list);
  if (s.items.some((i) => i.state !== 'Queued' && i.state !== 'Running')) {
    page.append(el('div', { className: 'row' }, button(L('Убрать готовые из списка', 'Clear finished'), () => void bridge.file.clearFinished().then(apply), 'link')));
  }

  // «Расшифровка»: timed phrases; click seeks the source audio (chawo-media://).
  const ed = s.editor ?? { available: false, reason: 'missing', audioPath: null, txtPath: null, segments: [], mediaUrl: null };
  const editorBox = el('fieldset', { className: 'transcript-editor' },
    el('legend', { textContent: L('Расшифровка', 'Transcript') }),
  );
  if (ed.available && ed.mediaUrl && ed.segments.length > 0) {
    const audio = ensureEditorAudio(ed.mediaUrl);
    const phrases = el('div', { className: 'phrases' });
    const rows: HTMLElement[] = [];
    for (let i = 0; i < ed.segments.length; i++) {
      const seg = ed.segments[i]!;
      const sp = typeof seg.speaker === 'number' ? L(`Спикер ${seg.speaker + 1}`, `Speaker ${seg.speaker + 1}`) + ' · ' : '';
      const row = el('button', {
        type: 'button',
        className: 'phrase',
      },
        el('span', { className: 'phrase-time', textContent: formatSegTime(seg.start) }),
        el('span', { className: 'phrase-body', textContent: sp + seg.text }),
      );
      row.addEventListener('click', () => {
        audio.currentTime = Math.max(0, seg.start);
        void audio.play().catch(() => { /* autoplay / decode */ });
      });
      rows.push(row);
      phrases.append(row);
    }
    const paint = () => {
      const t = audio.currentTime;
      for (let i = 0; i < ed.segments.length; i++) {
        const seg = ed.segments[i]!;
        const next = ed.segments[i + 1];
        const end = seg.end > seg.start ? seg.end : (next ? next.start : seg.start + 0.5);
        rows[i]!.classList.toggle('active', t >= seg.start && t < end);
      }
    };
    audio.ontimeupdate = paint;
    audio.onplay = paint;
    paint();
    editorBox.append(
      audio,
      el('p', { className: 'muted hint', textContent: L('Нажмите фразу — воспроизведение с этого места.', 'Click a phrase to play from that time.') }),
      phrases,
    );
    if (ed.txtPath) {
      editorBox.append(el('div', { className: 'row' },
        button(L('Показать файл', 'Show file'), () => void bridge.file.reveal(ed.txtPath!), 'link'),
      ));
    }
  } else {
    const why = ed.reason === 'no-timings'
      ? L('Нет меток времени. Включите «Метки времени» или сохранение .srt / .json и расшифруйте снова.', 'No timings. Enable timestamps or .srt / .json and transcribe again.')
      : ed.reason === 'no-audio'
        ? L('Фразы есть, но исходный звук рядом не найден.', 'Phrases are here, but the source audio was not found beside them.')
        : ed.txtPath
          ? L('Расшифровка ещё без фраз со временем.', 'The transcript has no timed phrases yet.')
          : L('После расшифровки здесь появятся фразы — нажмите, чтобы слушать с этого места.', 'After transcription, phrases appear here — click to play from that time.');
    editorBox.append(el('p', { className: 'muted hint', textContent: why }));
    if (ed.txtPath || s.lastOutput) {
      editorBox.append(el('div', { className: 'row' },
        button(L('Открыть расшифровку', 'Open transcript'), () => void bridge.file.openEditor(ed.txtPath || s.lastOutput || undefined).then(apply), 'link'),
      ));
    }
  }
  page.append(editorBox);

  page.append(el('p', { className: 'status', textContent: s.status }));
  renderMeeting();

  const ts = el('input', { type: 'checkbox', checked: s.options.timestamps });
  ts.addEventListener('change', () => void bridge.file.setOptions({ timestamps: ts.checked }).then(apply));
  // One row for every extra file; .srt keeps its own WPF setting, the others share FileExtraFormats.
  const formats = el('span', { className: 'formats' });
  const srt = el('input', { type: 'checkbox', checked: s.options.srt });
  srt.addEventListener('change', () => void bridge.file.setOptions({ srt: srt.checked }).then(apply));
  formats.append(el('label', { title: L('Субтитры SubRip', 'SubRip subtitles') }, srt, ' .srt'));
  for (const [f, tip] of EXTRA_FORMATS) {
    const box = el('input', { type: 'checkbox', checked: s.options.extra.includes(f) });
    box.addEventListener('change', () => {
      const next = EXTRA_FORMATS.map(([x]) => x).filter((x) => (x === f ? box.checked : s.options.extra.includes(x)));
      void bridge.file.setOptions({ extra: next }).then(apply);
    });
    formats.append(el('label', { title: L(tip[0], tip[1]) }, box, ` .${f}`));
  }
  const diar = el('input', { type: 'checkbox', checked: s.options.diarize });
  diar.addEventListener('change', () => void bridge.file.setOptions({ diarize: diar.checked }).then(apply));
  const speed = el('select');
  for (const [v, label] of SPEED.map(([v, r]) => [v, ru ? r : SPEED_EN[v]] as [string, string])) speed.append(el('option', { value: v, textContent: label, selected: v === s.options.parallelism }));
  speed.addEventListener('change', () => void bridge.file.setOptions({ parallelism: speed.value }).then(apply));

  page.append(
    el('fieldset', {},
      el('legend', { textContent: L('Вывод', 'Output') }),
      el('label', {}, ts, L(' Метки времени [чч:мм:сс] в .txt', ' Timestamps [hh:mm:ss] in .txt')),
      el('div', { className: 'row' }, L('Ещё сохранять рядом: ', 'Also save beside it: '), formats),
      el('label', {}, diar, L(' Разделять спикеров', ' Separate speakers')),
      el('label', {}, L('Скорость длинных записей ', 'Long recording speed '), speed),
    ),
  );


  // «Кратко и задачи» — after a meeting/file transcript, via the Brain (local by default).
  const br = s.brief ?? { enabled: false, instruction: '', defaultInstruction: '', where: '', available: false, text: '', path: null, busy: false };
  const briefOn = el('input', { type: 'checkbox', checked: br.enabled || s.options.brief, disabled: !br.available && !br.enabled });
  briefOn.addEventListener('change', () => void bridge.file.setOptions({ brief: briefOn.checked }).then(apply));
  const instr = el('textarea', { rows: 4, spellcheck: true }) as HTMLTextAreaElement;
  instr.value = br.instruction || br.defaultInstruction;
  instr.placeholder = br.defaultInstruction;
  instr.addEventListener('change', () => void bridge.file.setBriefInstruction(instr.value).then((st) => { fileState = st; }));
  const make = button(L('Составить по последней расшифровке', 'Build from the last transcript'), () => void bridge.file.runBrief().then(apply), 'primary');
  make.disabled = s.busy || br.busy || !br.available || !s.lastOutput;
  const briefBox = el('fieldset', { className: 'meeting-brief' },
    el('legend', { textContent: L('Кратко и задачи', 'Brief and tasks') }),
    el('label', {}, briefOn, L(' После расшифровки писать .brief.txt', ' After transcription also write .brief.txt')),
    el('p', { className: 'muted hint', textContent: br.available
      ? L(`Мозг: ${br.where}. Инструкцию формата можно править — Мозг следует ей.`, `Brain: ${br.where}. You can edit the format instruction — the Brain follows it.`)
      : L('Нужен Мозг: скачайте локальную модель на «Мозге» или настройте свой сервер. Расшифровка без этого всё равно работает.', 'Needs the Brain: download a local model on Brain, or set up your own server. Transcription still works without it.') }),
    el('label', {}, L('Инструкция формата вывода', 'Output format instruction')),
    instr,
    el('div', { className: 'row' }, make),
  );
  if (br.text) {
    const card = el('div', { className: 'card result brief-card' },
      el('div', { className: 'card-head' },
        el('strong', { textContent: L('Карточка', 'Card') }),
        br.path ? button(L('Показать файл', 'Show file'), () => void bridge.file.reveal(br.path!), 'link') : el('span'),
      ),
      el('pre', { className: 'last-text', textContent: br.text }),
    );
    briefBox.append(card);
  }
  page.append(briefBox);

  // «Перевести» — offline translation of the last transcript via the same Brain (IDEAS №15).
  const tr = s.translate ?? { target: '', languages: [], where: '', available: false, text: '', path: null, busy: false };
  const langListId = 'translate-langs';
  const lang = el('input', { type: 'text', id: 'translate-to', value: translateDraft ?? tr.target, spellcheck: false, autocomplete: 'off',
    placeholder: L('авто: русский → английский, иначе → русский', 'auto: Russian → English, else → Russian') });
  lang.setAttribute('list', langListId);
  const langs = el('datalist', { id: langListId });
  for (const l of tr.languages) langs.append(el('option', { value: l.label }));
  lang.addEventListener('input', () => { translateDraft = lang.value; });
  lang.addEventListener('change', () => void bridge.file.setTranslateTarget(lang.value).then((st) => { translateDraft = null; fileState = st; }));
  const doTranslate = button(L('Перевести последнюю расшифровку', 'Translate the last transcript'),
    () => void bridge.file.runTranslate(lang.value).then((st) => { translateDraft = null; apply(st); }));
  doTranslate.disabled = s.busy || tr.busy || !tr.available || !s.lastOutput;
  const translateBox = el('fieldset', { className: 'translate-box' },
    el('legend', { textContent: L('Перевод', 'Translation') }),
    el('p', { className: 'muted hint', textContent: tr.available
      ? L(`Мозг: ${tr.where}. Пишет .translate.txt рядом с расшифровкой. В диктовке: «Чаво, переведи на …».`,
        `Brain: ${tr.where}. Writes .translate.txt beside the transcript. In dictation: “Chawo, translate to …”.`)
      : L('Нужен Мозг: скачайте локальную модель на «Мозге» или настройте свой сервер.', 'Needs the Brain: download a local model on Brain, or set up your own server.') }),
    el('div', { className: 'row inline' }, el('label', { textContent: L('На язык ', 'Into ') }), lang, langs, doTranslate),
  );
  if (tr.text) {
    translateBox.append(el('div', { className: 'card result translate-card' },
      el('div', { className: 'card-head' },
        el('strong', { textContent: L('Перевод', 'Translation') }),
        tr.path ? button(L('Показать файл', 'Show file'), () => void bridge.file.reveal(tr.path!), 'link') : el('span'),
      ),
      el('pre', { className: 'last-text', textContent: tr.text }),
    ));
  }
  page.append(translateBox);
  if (langFocus) {
    lang.focus();
    lang.setSelectionRange(langFocus[0], langFocus[1]);
  }


    const link = el('input', { type: 'text', id: 'file-url', value: urlDraft, spellcheck: false, autocomplete: 'off', placeholder: 'https://www.youtube.com/watch?v=…' });
  const go = () => {
    if (!urlDraft.trim()) return;
    void bridge.file.fromUrl(urlDraft).then((st) => {
      if (st.url.busy) urlDraft = '';
      apply(st);
    });
  };
  link.addEventListener('input', () => (urlDraft = link.value));
  link.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const fetchBtn = button(L('Скачать и расшифровать', 'Download and transcribe'), go);
  fetchBtn.disabled = s.url.busy || !s.url.installed;
  const byUrl = el('fieldset', {},
    el('legend', { textContent: L('По ссылке', 'From a link') }),
    el('div', { className: 'row' }, link, fetchBtn),
    el('p', { className: 'muted hint', textContent: L(
      `Ссылку откроет yt-dlp — только этот шаг идёт через интернет. Звук сохранится в ${s.url.folder}, текст — рядом, расшифровка на этом компьютере.`,
      `yt-dlp opens the link — only this step uses the internet. The audio is saved to ${s.url.folder} with the text beside it; transcription runs on this computer.`) }),
    el('p', { className: 'muted', textContent: s.url.line }),
  );
  if (s.url.canDownload && (!s.url.installed || s.url.managed)) {
    const b = button(s.url.managed ? L('Обновить yt-dlp', 'Update yt-dlp') : L('Скачать yt-dlp', 'Download yt-dlp'), () => void bridge.file.downloadYtDlp().then(apply), 'link');
    b.disabled = s.busy;
    byUrl.append(b);
  }
  page.append(byUrl);
  if (hadFocus) {
    link.focus();
    if (caret) link.setSelectionRange(caret[0], caret[1]);
  }

  const ff = el('fieldset', {}, el('legend', { textContent: 'ffmpeg' }), el('p', { className: 'muted', textContent: s.ffmpeg.line }));
  if (!s.ffmpeg.installed && s.ffmpeg.canDownload) ff.append(button(L('Скачать ffmpeg', 'Download ffmpeg'), () => void bridge.file.downloadFfmpeg().then(apply)));
  page.append(ff);

  const d = s.diarization ?? { onDisk: false, ready: false, downloading: false, line: '', canDownload: true };
  const diarFs = el('fieldset', {},
    el('legend', { textContent: L('Спикеры', 'Speakers') }),
    el('p', { className: 'muted', textContent: d.line }),
  );
  if (d.canDownload) diarFs.append(button(L('Скачать модели (~47 МБ)', 'Download models (~47 MB)'), () => void bridge.file.downloadDiarize().then(apply)));
  page.append(diarFs);
}

// ── «Запись встречи» (on the file page) ─────────────────────

/** Mic + computer sound → meeting worklet (16 kHz, interleaved stereo) → main writes the WAV. */
class MeetingCapture {
  private streams: MediaStream[] = [];
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private flushed: (() => void) | null = null;
  /** Peaks of the last chunk: [mic, computer]. */
  levels: [number, number] = [0, 0];

  private static async mic(id: string): Promise<MediaStream> {
    const ask = (d: string) => navigator.mediaDevices.getUserMedia({
      audio: { deviceId: d ? { exact: d } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    try {
      return await ask(id);
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (!id || (name !== 'OverconstrainedError' && name !== 'NotFoundError' && name !== 'NotReadableError')) throw e;
      return ask('');
    }
  }

  /** Opens the computer sound; null (and the reason to main) when it cannot be had. */
  private static async system(plan: SystemPlan): Promise<MediaStream | null> {
    if (plan.kind === 'none') return null;
    try {
      // Raw like the mic: Chromium's AGC would otherwise turn the output monitor's volume down (seen on Linux).
      const st = await navigator.mediaDevices.getDisplayMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: true,
      });
      // Only the sound is wanted: the screen track is stopped before any frame is used.
      for (const v of st.getVideoTracks()) { v.stop(); st.removeTrack(v); }
      if (st.getAudioTracks().length === 0) {
        await bridge.meeting.systemOpened(false, L('нет звуковой дорожки', 'no audio track'));
        return null;
      }
      await bridge.meeting.systemOpened(true);
      return st;
    } catch (e) {
      await bridge.meeting.systemOpened(false, (e as DOMException)?.name ?? String(e));
      return null;
    }
  }

  async start(micId: string, plan: SystemPlan): Promise<void> {
    const mic = await MeetingCapture.mic(micId);
    this.streams.push(mic);
    const sys = await MeetingCapture.system(plan);
    if (sys) this.streams.push(sys);
    try {
      this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
    }
    await this.ctx.audioWorklet.addModule('meeting-processor.js');
    this.node = new AudioWorkletNode(this.ctx, 'chawo-meeting', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) {
        const c = e.data;
        let a = 0;
        let b = 0;
        for (let k = 0; k + 1 < c.length; k += 2) {
          const x = Math.abs(c[k]);
          const y = Math.abs(c[k + 1]);
          if (x > a) a = x;
          if (y > b) b = y;
        }
        this.levels = [a, b];
        bridge.meeting.pcm(c);
      } else if (e.data === 'flushed') this.flushed?.();
    };
    this.ctx.createMediaStreamSource(mic).connect(this.node, 0, 0);
    if (sys) this.ctx.createMediaStreamSource(sys).connect(this.node, 0, 1);
    // The worklet outputs silence; the connection only keeps the graph running.
    this.node.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async stop(): Promise<void> {
    if (this.node) {
      const done = new Promise<void>((r) => { this.flushed = r; setTimeout(r, 500); });
      this.node.port.postMessage('flush');
      await done;
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    for (const st of this.streams) st.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => undefined);
    this.node = null;
    this.ctx = null;
    this.streams = [];
  }
}

let meetingCapture: MeetingCapture | null = null;
let meetingBusy = false;
let meetingTimer: number | null = null;

const clockText = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const bars = (v: number) => '▮'.repeat(Math.min(8, Math.round(Math.sqrt(Math.min(1, v)) * 8))).padEnd(8, '·');

function meetingLive(): void {
  const m = meetingState;
  const clock = document.querySelector('[data-m="clock"]');
  if (!m || !m.recording || !clock) return;
  clock.textContent = clockText((Date.now() - m.startedAt) / 1000);
  const lv = meetingCapture?.levels ?? [0, 0];
  const mic = document.querySelector('[data-m="mic"]');
  const sys = document.querySelector('[data-m="sys"]');
  if (mic) mic.textContent = bars(lv[0]);
  if (sys) sys.textContent = bars(lv[1]);
}

function applyMeeting(s: MeetingState): void {
  meetingState = s;
  if (s.recording && meetingTimer === null) meetingTimer = window.setInterval(meetingLive, 500);
  if (!s.recording && meetingTimer !== null) {
    window.clearInterval(meetingTimer);
    meetingTimer = null;
  }
  if (current === 'file') renderFile();
}

async function meetingStart(): Promise<void> {
  if (meetingBusy || meetingState?.recording) return;
  meetingBusy = true;
  try {
    const r = await bridge.meeting.start();
    if (!r.ok) {
      applyMeeting(r.state);
      return;
    }
    const cap = new MeetingCapture();
    try {
      await cap.start(r.micId, r.system);
    } catch (e) {
      await cap.stop().catch(() => undefined);
      applyMeeting(await bridge.meeting.failed((e as DOMException)?.name ?? String(e)));
      return;
    }
    meetingCapture = cap;
    applyMeeting(await bridge.meeting.state());
  } finally {
    meetingBusy = false;
  }
}

async function meetingFinish(cancel: boolean): Promise<void> {
  if (meetingBusy) return;
  meetingBusy = true;
  try {
    const cap = meetingCapture;
    meetingCapture = null;
    await cap?.stop();
    applyMeeting(await (cancel ? bridge.meeting.cancel() : bridge.meeting.stop()));
  } finally {
    meetingBusy = false;
  }
}

function renderMeeting(): void {
  const m = meetingState;
  if (!m) return;
  const box = el('fieldset', { className: 'meeting' }, el('legend', { textContent: L('Встреча', 'Meeting') }));
  if (m.recording) {
    const span = (key: string, cls = '') => {
      const e = el('span', { className: cls });
      e.dataset.m = key;
      return e;
    };
    const clock = span('clock');
    clock.textContent = clockText((Date.now() - m.startedAt) / 1000);
    const line = el('p', { className: 'rec' },
      el('span', { className: 'dot', textContent: '● ' }),
      el('span', { textContent: L('Запись ', 'Recording ') }),
      clock,
      el('span', { className: 'muted', textContent: L(' · микрофон ', ' · mic ') }),
      span('mic', 'lv'),
    );
    if (m.capturing === 'mic+system') {
      line.append(el('span', { className: 'muted', textContent: L(' · компьютер ', ' · computer ') }), span('sys', 'lv'));
    }
    box.append(line, el('div', { className: 'row' },
      button(L('Остановить и расшифровать', 'Stop and transcribe'), () => void meetingFinish(false), 'primary'),
      button(L('Отменить', 'Cancel'), () => void meetingFinish(true), 'link'),
    ));
  } else {
    box.append(el('div', { className: 'row' }, button(L('Записать встречу', 'Record a meeting'), () => void meetingStart())));
    if (m.systemSupported) {
      const cb = el('input', { type: 'checkbox', checked: m.systemOn });
      cb.addEventListener('change', () => void bridge.meeting.setSystem(cb.checked).then(applyMeeting));
      box.append(el('label', {}, cb, L(' Со звуком компьютера (собеседники в Zoom, Teams, Telegram)', ' With the computer sound (people in Zoom, Teams, Telegram)')));
    }
    box.append(el('p', { className: 'muted hint', textContent: L(`Запись остаётся только на этом компьютере: ${m.folder}. Текст сохранится рядом.`, `The recording stays on this PC only: ${m.folder}. The text is saved next to it.`) }));
  }
  if (m.note) box.append(el('p', { className: 'muted', textContent: m.note }));
  page.append(box);
  meetingLive();
}

function show(name: string): void {
  if (current === 'brain' && name !== 'brain') void bridge.brain.close();
  current = name;
  if (name === 'dictation') {
    renderDictation();
    void bridge.dictation.state().then(applyDictation).then(() => refreshMicDevices());
    return;
  }
  if (name === 'file') {
    renderFile();
    void bridge.file.state().then(apply);
    void bridge.meeting.state().then(applyMeeting);
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
  if (name === 'history') {
    renderHistory();
    void bridge.history.state().then(applyHistory);
    return;
  }
  if (name === 'sales') {
    renderSales();
    void bridge.sales.state().then((st) => applySales(st));
    return;
  }
  if (name === 'network') {
    renderNetwork();
    void bridge.network.state().then(applyNetwork);
    return;
  }
  page.replaceChildren(
    el('h1', { textContent: title(name) }),
    el('p', { className: 'muted', textContent: L('Этого раздела нет.', 'This section is not here.') }),
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
bridge.meeting.onState(applyMeeting);
bridge.speech.onState(applySpeech);
bridge.brain.onState(applyBrainPush);
bridge.dictation.onState(applyDictation);
bridge.dictation.onLevel(onLevel);
bridge.dictation.onCue(playCue);
bridge.network.onState(applyNetwork);
bridge.history.onState(applyHistory);
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

show(current);
