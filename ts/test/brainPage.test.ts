import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '../src/core/strings';
import * as Settings from '../src/main/settings';
import { BrainController, brainFileFor, type BrainPageHooks, type TimerLike } from '../src/main/brain/brainPage';
import * as LocalBrain from '../src/main/brain/localBrain';

beforeAll(() => applyLanguage('Russian'));
afterAll(() => applyLanguage('Russian'));

function fakeTimer() {
  const jobs: { fn: () => void; ms: number }[] = [];
  const timer: TimerLike = {
    set: (fn, ms) => {
      const j = { fn, ms };
      jobs.push(j);
      return j;
    },
    clear: (h) => {
      const i = jobs.indexOf(h as (typeof jobs)[number]);
      if (i >= 0) jobs.splice(i, 1);
    },
  };
  return { timer, jobs, fire: () => jobs.splice(0).forEach((j) => j.fn()) };
}

interface Call { url: string; auth?: string; body?: unknown }

function fakeFetch(opts: { models?: string[]; modelsStatus?: number; chatStatus?: number } = {}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/models')) {
      const status = opts.modelsStatus ?? 200;
      return new Response(JSON.stringify({ data: (opts.models ?? []).map((id) => ({ id })) }), { status });
    }
    const status = opts.chatStatus ?? 200;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ок' } }] }), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function make(over: Partial<BrainPageHooks> = {}, edit?: (s: Settings.SettingsData) => void) {
  const s = Settings.defaults();
  edit?.(s);
  let saves = 0;
  let stops = 0;
  const t = fakeTimer();
  const ctl = new BrainController({
    settings: () => s,
    save: () => void saves++,
    stopLocal: () => void stops++,
    timer: t.timer,
    installed: () => [],
    isReady: () => false,
    ...over,
  });
  return { s, ctl, t, saves: () => saves, stops: () => stops };
}

const DEEPSEEK_KEY = 'sk-' + 'a'.repeat(32);

describe('«Мозг» page', () => {
  it('off by default: only the source choice and the WPF texts', () => {
    const { ctl } = make();
    const st = ctl.state();
    expect(st.source).toBe('Off');
    expect(st.sourceChoices.map((c) => c.label)).toEqual(['Выключен', 'На компьютере', 'В облаке']);
    expect(st.status).toBe('Текст вставляется как распознан.');
    expect(st.server.visible || st.local.visible || st.everyTake.visible || st.selection.visible || st.instruction.visible).toBe(false);
    expect(st.server.status).toBe('Выберите сервис и вставьте ключ, модель подберётся сама.');
  });

  it('switching source saves and stops the local Brain when leaving it', () => {
    const { s, ctl, saves, stops } = make();
    ctl.setSource('Local');
    expect(s.Brain).toBe('Local');
    expect(stops()).toBe(0);
    ctl.setSource('Server');
    expect(s.Brain).toBe('Server');
    expect(stops()).toBe(1);
    ctl.setSource('Server');
    expect(saves()).toBe(2);
    const st = ctl.state();
    expect(st.server.visible).toBe(true);
    expect(st.everyTake.visible).toBe(true);
    expect(st.instruction.visible).toBe(false);
    ctl.setEveryTake(true);
    expect(ctl.state().instruction.visible).toBe(true);
  });

  it('a pasted key picks its service, loads models after the pause, saves and probes', async () => {
    const { f, calls } = fakeFetch({ models: ['deepseek-chat', 'deepseek-reasoner', 'text-embedding-x'] });
    const { s, ctl, t } = make({ fetch: f }, (x) => (x.Brain = 'Server'));
    ctl.setProvider('openai');
    ctl.setKey(DEEPSEEK_KEY);
    let st = ctl.state();
    expect(st.server.providerId).toBe('deepseek');
    expect(st.server.status).toBe('Похоже на ключ DeepSeek, выбрал его.');
    expect(calls.length).toBe(0);
    expect(t.jobs.length).toBe(1);
    expect(t.jobs[0]!.ms).toBe(600);
    t.fire();
    await new Promise((r) => setTimeout(r, 0));
    await ctl.loadModels(true); // settle: the same work again is idempotent
    st = ctl.state();
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/models');
    expect(calls[0]!.auth).toBe(`Bearer ${DEEPSEEK_KEY}`);
    expect(st.server.models).not.toContain('text-embedding-x');
    expect(s.CleanupEndpointUrl).toBe('https://api.deepseek.com/v1');
    expect(s.CleanupApiKey).toBe(DEEPSEEK_KEY);
    expect(s.CleanupModel).toBe(st.server.model);
    expect(s.ProviderKeys.deepseek).toBe(DEEPSEEK_KEY);
    expect(calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(true);
    expect(st.server.status).toBe(`Всё работает, сохранено. Модель ${st.server.model}, текст (не звук) уходит на api.deepseek.com.`);
    expect(st.server.keySaved).toBe(true);
    expect(JSON.stringify(st)).not.toContain(DEEPSEEK_KEY);
  });

  it('a rejected key says so and saves nothing', async () => {
    const { f } = fakeFetch({ modelsStatus: 401 });
    const { s, ctl } = make({ fetch: f }, (x) => (x.Brain = 'Server'));
    ctl.setKey(DEEPSEEK_KEY);
    await ctl.loadModels(true);
    expect(ctl.state().server.status).toBe('DeepSeek не принял ключ. Проверьте, что ключ от этого сервиса и скопирован целиком.');
    expect(s.CleanupApiKey).toBe('');
  });

  it('each service keeps its own key and model; keys never move across', () => {
    const { s, ctl } = make({}, (x) => {
      x.Brain = 'Server';
      x.ProviderKeys = { groq: 'gsk_saved' };
      x.ProviderModels = { groq: 'llama-3.3-70b-versatile' };
    });
    ctl.setKey('typed-for-deepseek');
    ctl.setProvider('groq');
    expect(s.ProviderKeys.deepseek).toBe('typed-for-deepseek');
    let st = ctl.state();
    expect(st.server.model).toBe('llama-3.3-70b-versatile');
    expect(st.server.keySaved).toBe(true);
    expect(st.server.providers.find((p) => p.id === 'groq')!.label).toBe('Groq  ·  ключ сохранён');
    ctl.setProvider('openai');
    st = ctl.state();
    expect(st.server.keySaved).toBe(false);
    expect(st.server.model).toBe('gpt-4.1-mini');
  });

  it('own server: no key needed, address shows, http outside the home network warns', async () => {
    const { f } = fakeFetch({ models: ['qwen3'] });
    const { s, ctl } = make({ fetch: f }, (x) => (x.Brain = 'Server'));
    ctl.setProvider('custom');
    expect(ctl.state().server.custom).toBe(true);
    expect(ctl.state().server.keysLinkEnabled).toBe(false);
    ctl.setUrl('nonsense');
    await ctl.refresh();
    expect(ctl.state().server.status).toBe('Впишите адрес сервера.');
    ctl.setUrl('http://example.com:11434/v1');
    await ctl.refresh();
    expect(s.CleanupEndpointUrl).toBe('http://example.com:11434/v1');
    expect(s.CleanupModel).toBe('qwen3');
    expect(ctl.state().server.status).toContain('Внимание: адрес с http://');
  });

  it('cancel stops a pending key pause', () => {
    const { ctl, t } = make({}, (x) => (x.Brain = 'Server'));
    ctl.setKey(DEEPSEEK_KEY);
    expect(t.jobs.length).toBe(1);
    ctl.cancel();
    expect(t.jobs.length).toBe(0);
  });

  it('local: model rows, custom URL error, device change stops the engine', () => {
    const dir = LocalBrain.dir();
    const files = [
      { path: `${dir}/${LocalBrain.ModelFile}`, label: 'Qwen3 4B' },
      { path: `${dir}/stray.gguf`, label: 'stray.gguf' },
    ];
    const { s, ctl, stops } = make({ installed: () => files }, (x) => (x.Brain = 'Local'));
    let st = ctl.state();
    expect(st.local.visible).toBe(true);
    expect(st.local.rows.map((r) => [r.kind, r.onDisk])).toEqual([
      ['Qwen3', true],
      ['Qwen35', false],
      ['Custom', false],
      [null, true],
    ]);
    expect(st.local.fileStatus).toBe("Файла ещё нет. Нажмите кнопку, сама модель не скачивается.");
    ctl.selectLocalModel('Custom');
    st = ctl.state();
    expect(st.local.customUrlVisible).toBe(true);
    expect(st.local.fileStatus).toBe('Нужна ссылка Hugging Face на файл .gguf.');
    ctl.setCustomUrl('https://huggingface.co/a/b/blob/main/stray.gguf');
    expect(ctl.state().local.rows.find((r) => r.kind === 'Custom')!.path).toBe(`${dir}/stray.gguf`);
    expect(ctl.state().local.rows.length).toBe(3);
    const before = stops();
    ctl.setDevice('Gpu');
    expect(s.BrainDevice).toBe('Gpu');
    expect(stops()).toBe(before + 1);
    expect(ctl.deletablePath(`${dir}/stray.gguf`)).toBe(`${dir}/stray.gguf`);
    expect(ctl.deletablePath('/etc/passwd')).toBeNull();
  });

  it('brainFileFor never gives a built-in file to the custom row first', () => {
    const files = [{ path: `/b/${LocalBrain.Qwen35File}`, label: 'Qwen3.5 4B' }];
    expect(brainFileFor('Qwen35', '', files)).toBe(`/b/${LocalBrain.Qwen35File}`);
    expect(brainFileFor('Custom', '', files)).toBeNull();
  });

  it('«Команды над выделенным текстом» shows only on Windows (the helper reads the selection) and with a Brain', () => {
    const win = make({ platform: 'win32' }, (x) => (x.Brain = 'Server'));
    expect(win.ctl.state().selection.visible).toBe(true);
    const off = make({ platform: 'win32' }, (x) => (x.Brain = 'Off'));
    expect(off.ctl.state().selection.visible).toBe(false);
    for (const platform of ['linux', 'darwin'] as const) {
      const other = make({ platform }, (x) => (x.Brain = 'Server'));
      expect(other.ctl.state().selection.visible).toBe(false);
    }
  });

  it('instruction and selection save only on change', () => {
    const { s, ctl, saves } = make({}, (x) => (x.Brain = 'Server'));
    ctl.setInstruction('');
    ctl.setSelection(true);
    expect(saves()).toBe(0);
    ctl.setInstruction('Переведи на английский');
    ctl.setSelection(false);
    expect(s.BrainInstruction).toBe('Переведи на английский');
    expect(s.BrainOnSelection).toBe(false);
    expect(saves()).toBe(2);
  });
});

describe('«Мозг» page: download card', () => {
  type Prog = (p: LocalBrain.BrainProgress) => void;
  function gate() {
    let progress: Prog = () => {};
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    let signal!: AbortSignal;
    const calls: Settings.SettingsData[] = [];
    const download = (s: Settings.SettingsData, p: Prog, sig: AbortSignal) => {
      calls.push(s);
      progress = p;
      signal = sig;
      return new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
        sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    };
    return { download, calls, progress: (p: LocalBrain.BrainProgress) => progress(p), resolve: () => resolve(), reject: (e: unknown) => reject(e), signal: () => signal };
  }

  it('row button selects the model, shows «Скачиваю Мозг» with progress, clears on success', async () => {
    const g = gate();
    let ready = false;
    let pushes = 0;
    let changed = 0;
    const { s, ctl, stops } = make({ download: g.download, isReady: () => ready, push: () => void pushes++, changed: () => void changed++ }, (x) => { x.Brain = 'Local'; });
    let st = ctl.state();
    expect(st.download).toBeNull();
    expect(st.local.rows.filter((r) => r.canDownload).map((r) => r.kind)).toEqual(['Qwen3', 'Qwen35', 'Custom']);
    expect(st.local.rows[0]!.downloadLabel).toBe('Скачать');

    const done = ctl.download('Qwen35');
    expect(s.BrainModel).toBe('Qwen35');
    expect(stops()).toBe(1);
    expect(g.calls.length).toBe(1);
    st = ctl.state();
    expect(st.download).toMatchObject({ kind: 'Qwen35', title: 'Скачиваю Мозг', running: true, failed: false, text: 'Соединяюсь…', percent: null });
    expect(st.download!.intro).toBe('Нейросеть Qwen3.5 4B и движок llama.cpp. Если связь оборвётся, скачивание продолжится с того же места. Файл не запускается как программа.');

    g.progress({ received: 512 * 1048576, total: 1024 * 1048576, phase: 'download' });
    st = ctl.state();
    expect(st.download).toMatchObject({ running: true, percent: 50, text: 'Скачано 512 из 1024 МБ' });
    g.progress({ received: 0, total: 0, phase: 'verify' });
    expect(ctl.state().download!.text).toBe('Проверяю файл…');
    g.progress({ received: 0, total: 0, phase: 'unpack' });
    expect(ctl.state().download!.text).toBe('Распаковываю…');

    // A second press while running does nothing.
    await ctl.download('Qwen3');
    expect(g.calls.length).toBe(1);
    expect(s.BrainModel).toBe('Qwen35');

    ready = true;
    g.resolve();
    await done;
    st = ctl.state();
    expect(st.download).toBeNull();
    expect(changed).toBeGreaterThan(0);
    expect(pushes).toBeGreaterThan(3);
    expect(st.local.fileStatus.startsWith('Уже на диске: ')).toBe(true);
  });

  it('failure shows the WPF text with Retry; cancel just closes the card', async () => {
    const g = gate();
    const { ctl } = make({ download: g.download }, (x) => { x.Brain = 'Local'; });
    let p = ctl.download('Qwen3');
    const { ModelDownloadException } = await import('../src/main/models/modelDownloader');
    g.reject(new ModelDownloadException('noSpace', 'only 5 MB free'));
    await p;
    let st = ctl.state();
    expect(st.download).toMatchObject({ failed: true, running: false });
    expect(st.download!.text).toMatch(/^Мало места на диске: нужно около 2,5 ГБ свободных/);
    ctl.dismissDownload();
    expect(ctl.state().download).toBeNull();

    p = ctl.download('Qwen3');
    g.reject(new Error('socket hang up'));
    await p;
    expect(ctl.state().download!.text).toBe('Не получилось скачать. Проверьте интернет и попробуйте ещё раз.');

    p = ctl.download('Qwen3');
    expect(ctl.downloading).toBe(true);
    ctl.cancelDownload();
    await p;
    expect(g.signal().aborted).toBe(true);
    st = ctl.state();
    expect(st.download).toBeNull();
  });

  it('custom link: a bad link fails at once, no download; already on disk says so', async () => {
    const g = gate();
    const { ctl } = make({ download: g.download }, (x) => { x.Brain = 'Local'; x.BrainModel = 'Custom'; x.BrainCustomUrl = 'https://example.com/a.gguf'; });
    await ctl.download('Custom');
    expect(g.calls.length).toBe(0);
    expect(ctl.state().download).toMatchObject({ failed: true, text: 'Нужна ссылка Hugging Face на файл .gguf.' });

    const r = make({ download: g.download, isReady: () => true }, (x) => { x.Brain = 'Local'; });
    await r.ctl.download('Qwen3');
    expect(g.calls.length).toBe(0);
    expect(r.ctl.state().download!.text.startsWith('Эта модель уже на диске.')).toBe(true);
  });

  it('model on disk but no engine for the device: «Скачать движок» on the selected row; DeviceNote in the status', () => {
    const dir = LocalBrain.dir();
    const files = [{ path: `${dir}/${LocalBrain.ModelFile}`, label: 'Qwen3 4B' }];
    let ready = false;
    const { ctl } = make({ installed: () => files, isReady: () => ready, deviceNote: () => 'Видеокарта не поднялась, мозг считает на процессоре.' }, (x) => { x.Brain = 'Local'; x.BrainDevice = 'Gpu'; });
    let row = ctl.state().local.rows[0]!;
    expect(row).toMatchObject({ onDisk: true, canDownload: true, downloadLabel: 'Скачать движок' });
    ready = true;
    const st = ctl.state();
    row = st.local.rows[0]!;
    expect(row.canDownload).toBe(false);
    expect(st.local.fileStatus.endsWith(' Видеокарта не поднялась, мозг считает на процессоре.')).toBe(true);
  });
});

describe('«Контекст для Мозга» on the page', () => {
  it('hidden with the Brain off, off by default, each switch saves on its own', () => {
    expect(make().ctl.state().context.visible).toBe(false);
    const m = make({}, (x) => { x.Brain = 'Local'; });
    let st = m.ctl.state();
    expect(st.context).toMatchObject({ visible: true, clipboard: false, app: false, warning: '' });
    m.ctl.setContext({ clipboard: true });
    expect(m.s.BrainContextClipboard).toBe(true);
    expect(m.s.BrainContextApp).toBe(false);
    expect(m.saves()).toBe(1);
    m.ctl.setContext({ clipboard: true });
    expect(m.saves()).toBe(1);
    st = m.ctl.state();
    expect(st.context.warning).toBe(''); // local Brain: nothing leaves the PC
  });
  it('cloud Brain with context on: a warning naming the host; loopback server: none', () => {
    const m = make({}, (x) => { x.Brain = 'Server'; x.CleanupEndpointUrl = 'https://api.openai.com/v1'; x.CleanupModel = 'm'; x.CleanupApiKey = 'k'; });
    expect(m.ctl.state().context.warning).toBe('');
    m.ctl.setContext({ app: true });
    expect(m.ctl.state().context.warning).toContain('api.openai.com');
    expect(m.ctl.state().context.warning).toContain('уходит с компьютера');
    m.s.CleanupEndpointUrl = 'http://127.0.0.1:8080/v1';
    expect(m.ctl.state().context.warning).toBe('');
  });
});

