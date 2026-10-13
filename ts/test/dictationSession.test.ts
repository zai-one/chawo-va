import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '../src/core/strings';
import { SAMPLE_RATE } from '../src/core/takeBuffer';
import * as Settings from '../src/main/settings';
import { DictationSession, type RecognizerLike, type SessionHooks } from '../src/main/dictation/dictationSession';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-dict-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});

class FakeRecognizer implements RecognizerLike {
  readonly modelId: string;
  deviceActual = 'cpu';
  deviceNote: string | null = null;
  intraOpThreads = 4;
  calls: { samples: Float32Array; rate: number }[] = [];
  disposed = 0;
  cancels = 0;
  reply = 'привет мир';
  gate: Promise<void> | null = null;
  constructor(readonly kind: 'v3_e2e_rnnt' | 'multilingual_large_ctc' = 'v3_e2e_rnnt') {
    this.modelId = kind === 'v3_e2e_rnnt' ? 'v3_e2e_rnnt' : 'multilingual_large_ctc';
  }
  async transcribeCancelable(samples: Float32Array, rate: number, stillWanted: (() => boolean) | null): Promise<string> {
    this.calls.push({ samples: samples.slice(), rate });
    if (this.gate) await this.gate;
    return stillWanted && !stillWanted() ? '' : this.reply;
  }
  cancelOwned(): void {
    this.cancels++;
  }
  async dispose(): Promise<void> {
    this.disposed++;
  }
}

/** ~0.6 s of "speech": a loud burst over a quiet floor, so the dynamics check passes. */
function speech(seconds = 1, amp = 0.3): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const burst = i > n * 0.3 && i < n * 0.7 ? amp : 0;
    out[i] = burst * Math.sin(i * 0.2) + 0.001 * Math.sin(i * 1.3);
  }
  return out;
}

function feed(sess: DictationSession, samples: Float32Array): void {
  for (let i = 0; i < samples.length; i += 640) sess.appendPcm(samples.subarray(i, i + 640));
}

function make(over: Partial<SessionHooks> = {}, edit?: (s: Settings.SettingsData) => void) {
  const s = Settings.defaults();
  edit?.(s);
  const opened: { dir: string; kind: string; device: string; threads: number; script: string }[] = [];
  const recs: FakeRecognizer[] = [];
  const copied: string[] = [];
  const wavs: number[] = [];
  let onDisk = true;
  let pushes = 0;
  let openGate: Promise<void> | null = null;
  let openFail: Error | null = null;
  const sess = new DictationSession({
    settings: () => s,
    push: () => void pushes++,
    copy: (t) => void copied.push(t),
    writeWav: (x) => void wavs.push(x.length),
    micName: () => 'USB Mic',
    find: (k) => (onDisk ? `/m/${k}` : null),
    open: async (d, kind, device, threads, script) => {
      opened.push({ dir: d, kind, device, threads, script });
      if (openGate) await openGate;
      if (openFail) throw openFail;
      const r = new FakeRecognizer(kind);
      recs.push(r);
      return r;
    },
    platform: 'win32',
    ...over,
  });
  return {
    s, sess, opened, recs, copied, wavs,
    pushes: () => pushes,
    setOnDisk: (v: boolean) => { onDisk = v; },
    setOpenGate: (g: Promise<void> | null) => { openGate = g; },
    setOpenFail: (e: Error | null) => { openFail = e; },
  };
}

describe('DictationSession', () => {
  it('a full take: start → chunks → stop → recognizer → dictionary → clipboard', async () => {
    const { s, sess, opened, recs, copied } = make({}, (x) => { x.WordReplacementRules = 'мир=Мир!'; x.CpuThreads = 3; x.SpeechDevice = 'Cpu'; });
    expect(sess.phase).toBe('Idle');
    expect(sess.startTake().ok).toBe(true);
    expect(sess.phase).toBe('Listening');
    feed(sess, speech(1));
    expect(sess.level()).toBeGreaterThan(0);
    const text = await sess.stopTake();
    expect(text).toBe('привет Мир!');
    expect(copied).toEqual(['привет Мир!']);
    expect(sess.phase).toBe('Idle');
    expect(sess.view().lastText).toBe('привет Мир!');
    expect(sess.view().status).toMatch(/^Готово\. Фраза в буфере обмена/);
    expect(opened).toEqual([{ dir: '/m/v3_e2e_rnnt', kind: 'v3_e2e_rnnt', device: 'cpu', threads: 3, script: 'auto' }]);
    expect(recs[0].calls).toHaveLength(1);
    expect(recs[0].calls[0].rate).toBe(16000);
    expect(recs[0].calls[0].samples.length).toBe(16000);
    expect(s.MicrophoneId).toBe('');
  });

  it('quiet takes are normalized to a 0.5 peak before recognition', async () => {
    const { sess, recs } = make();
    sess.startTake();
    feed(sess, speech(1, 0.05));
    await sess.stopTake();
    const got = recs[0].calls[0].samples;
    let peak = 0;
    for (const v of got) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.5, 2);
  });

  it('the recognizer is reused across takes and reopened only after a speech settings change', async () => {
    const { s, sess, opened, recs } = make();
    for (let i = 0; i < 2; i++) {
      sess.startTake();
      feed(sess, speech(1));
      await sess.stopTake();
    }
    expect(opened).toHaveLength(1);
    sess.speechChanged(); // nothing changed: keep it
    expect(recs[0].disposed).toBe(0);
    s.SpeechModel = 'MultilingualLargeCtc';
    sess.speechChanged();
    await Promise.resolve();
    expect(recs[0].disposed).toBe(1);
    sess.startTake();
    feed(sess, speech(1));
    await sess.stopTake();
    expect(opened.map((o) => o.kind)).toEqual(['v3_e2e_rnnt', 'multilingual_large_ctc']);
  });

  it('a short tap is not recognized (MinTakeSamples = 0.25 s)', async () => {
    const { sess, recs, copied } = make();
    sess.startTake();
    feed(sess, speech(0.2));
    expect(await sess.stopTake()).toBeNull();
    expect(recs.flatMap((r) => r.calls)).toHaveLength(0);
    expect(copied).toEqual([]);
    expect(sess.view().status).toBe('Слишком коротко. Держите кнопку, пока говорите.');
  });

  it('silence says to check the microphone by name (WPF hint)', async () => {
    const { sess, recs } = make();
    sess.startTake();
    feed(sess, new Float32Array(SAMPLE_RATE));
    expect(await sess.stopTake()).toBeNull();
    expect(recs.flatMap((r) => r.calls)).toHaveLength(0);
    expect(sess.view().status).toBe('Тишина на входе. Проверьте микрофон и его громкость: USB Mic');
  });

  it('an empty recognition says "Не разобрал"', async () => {
    const { sess, recs } = make();
    sess.startTake();
    await sess.ensureLoaded();
    recs[0].reply = '';
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBeNull();
    expect(sess.view().status).toBe('Не разобрал. Попробуйте ещё раз ближе к микрофону.');
  });

  it('no model on disk: the take does not start and the status points to «Распознавание»', () => {
    const { sess, opened, setOnDisk } = make();
    setOnDisk(false);
    expect(sess.phase).toBe('NoModel');
    expect(sess.startTake().ok).toBe(false);
    expect(sess.phase).toBe('NoModel');
    expect(sess.view().status).toBe('Модель не скачана. Откройте «Распознавание» и нажмите «Скачать» в строке модели. Сама она не скачивается.');
    expect(opened).toHaveLength(0);
  });

  it('client role without a host address does not record and says where to set it', () => {
    const { sess, opened } = make({}, (x) => { x.NetworkRole = 'Client'; });
    expect(sess.phase).toBe('Idle');
    expect(sess.startTake().ok).toBe(false);
    expect(sess.view().status).toBe('Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.');
    expect(opened).toHaveLength(0);
  });

  it('client role: the take goes to the host, no local model is opened or needed', async () => {
    const posts: { host: string; samples: number; rate: number; signal: AbortSignal }[] = [];
    const { sess, opened, copied, setOnDisk } = make({
      remote: async (s, samples, rate, signal) => {
        posts.push({ host: s.RemoteHost, samples: samples.length, rate, signal });
        return 'с хоста';
      },
      partialMs: 0,
    }, (x) => { x.NetworkRole = 'Client'; x.RemoteHost = '192.168.1.20'; x.WordReplacementRules = 'хоста=Хоста'; });
    setOnDisk(false);
    expect(sess.phase).toBe('Idle');
    expect(sess.startTake().ok).toBe(true);
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBe('с Хоста');
    expect(copied).toEqual(['с Хоста']);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ host: '192.168.1.20', samples: 16000, rate: 16000 });
    expect(posts[0].signal.aborted).toBe(false);
    expect(opened).toHaveLength(0);
    expect(await sess.ensureLoaded()).toBeNull();
    expect(sess.current()).toBeNull();
  });

  it('client role: a host error is the page status (WPF RemoteHostException text), nothing copied', async () => {
    const { RemoteHostException } = await import('../src/main/network/remoteSpeech');
    const { sess, copied } = make({
      remote: async () => {
        throw new RemoteHostException('Хост на связи, но модель там не загружена. Здесь ничего не скачиваю.', 'The host answered, but its model is not loaded.');
      },
      partialMs: 0,
    }, (x) => { x.NetworkRole = 'Client'; x.RemoteHost = 'host.lan'; });
    sess.startTake();
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBeNull();
    expect(copied).toEqual([]);
    expect(sess.view().status).toBe('Хост на связи, но модель там не загружена. Здесь ничего не скачиваю.');
    expect(sess.phase).toBe('Idle');
  });

  it('client role: Stop while the host works aborts the request and drops the take', async () => {
    let seen: AbortSignal | null = null;
    const { sess, copied } = make({
      remote: (_s, _x, _r, signal) => new Promise<string>((_resolve, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => {
          const e = new Error('Operation canceled');
          e.name = 'AbortError';
          reject(e);
        });
      }),
      partialMs: 0,
    }, (x) => { x.NetworkRole = 'Client'; x.RemoteHost = 'host.lan'; });
    sess.startTake();
    feed(sess, speech(1));
    const p = sess.stopTake();
    await new Promise((r) => setTimeout(r, 5));
    expect(sess.phase).toBe('Recognizing');
    sess.cancelTake();
    expect(await p).toBeNull();
    expect(seen!.aborted).toBe(true);
    expect(copied).toEqual([]);
    expect(sess.view().status).toBe('');
  });

  it('client role: live drafts are posted to the host too and shown on the pill', async () => {
    const partials: string[] = [];
    const overlay = {
      showListening() {}, showRecognizing() {}, showStatus() {}, showHint() {}, showCaption() {}, hideNow() {},
      showPartial(text: string) { partials.push(text); },
    };
    let n = 0;
    const { sess } = make({ remote: async () => `черновик ${++n}`, partialMs: 0, overlay }, (x) => {
      x.NetworkRole = 'Client'; x.RemoteHost = 'host.lan'; x.ShowOverlay = true;
    });
    sess.startTake();
    feed(sess, speech(1));
    await sess.partialTick();
    expect(partials).toEqual(['черновик 1']);
    expect(await sess.stopTake()).toBe('черновик 2');
  });

  it('a second press while listening or recognizing is ignored', async () => {
    const { sess, recs } = make();
    sess.startTake();
    expect(sess.startTake().ok).toBe(false);
    await sess.ensureLoaded();
    let open!: () => void;
    recs[0].gate = new Promise<void>((r) => { open = r; });
    feed(sess, speech(1));
    const p = sess.stopTake();
    expect(sess.phase).toBe('Recognizing');
    expect(sess.isBusy).toBe(true);
    expect(sess.startTake().ok).toBe(false);
    expect(await sess.stopTake()).toBeNull();
    open();
    expect(await p).toBe('привет мир');
  });

  it('cancel while listening drops the take; cancel while recognizing drops the result', async () => {
    const { sess, recs, copied } = make();
    sess.startTake();
    feed(sess, speech(1));
    sess.cancelTake();
    expect(sess.phase).toBe('Idle');
    expect(await sess.stopTake()).toBeNull();
    await sess.ensureLoaded();
    expect(recs[0].calls).toHaveLength(0);

    let open!: () => void;
    recs[0].gate = new Promise<void>((r) => { open = r; });
    sess.startTake();
    feed(sess, speech(1));
    const p = sess.stopTake();
    sess.cancelTake();
    expect(recs[0].cancels).toBe(1);
    open();
    expect(await p).toBeNull();
    expect(copied).toEqual([]);
    expect(sess.phase).toBe('Idle');
  });

  it('a take started while the model loads waits for it', async () => {
    const { sess, recs, setOpenGate } = make();
    let open!: () => void;
    setOpenGate(new Promise<void>((r) => { open = r; }));
    sess.startTake();
    expect(sess.view().loading).toBe(true);
    feed(sess, speech(1));
    const p = sess.stopTake();
    open();
    expect(await p).toBe('привет мир');
    expect(recs).toHaveLength(1);
    expect(sess.view().loading).toBe(false);
  });

  it('a model that fails to load: NoModel phase, reason in the status, retried on the next take', async () => {
    const { sess, setOpenFail, recs } = make();
    setOpenFail(new Error('bad onnx'));
    sess.startTake();
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBeNull();
    expect(sess.view().status).toBe('Модель не загрузилась: bad onnx');
    expect(sess.phase).toBe('NoModel');
    expect(sess.sessionLine()).toBe('Файлы на месте, но сессия не загружена. bad onnx');
    setOpenFail(null);
    sess.startTake();
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBe('привет мир');
    expect(recs).toHaveLength(1);
  });

  it('take too long: the 5-minute cap stops the take by itself', async () => {
    const { sess, recs } = make();
    sess.startTake();
    await sess.ensureLoaded();
    const minute = speech(60);
    for (let m = 0; m < 5; m++) feed(sess, minute);
    // The cap fires on the chunk that reaches 5 minutes; stopTake runs from the callback.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(sess.phase).toBe('Idle');
    expect(recs[0].calls).toHaveLength(1);
    expect(recs[0].calls[0].samples.length).toBe(5 * 60 * SAMPLE_RATE);
    expect(sess.view().status).toMatch(/^Запись длиннее 5 минут остановлена сама\. Готово/);
  });

  it('KeepLastRecording writes the take before recognition', async () => {
    const { sess, wavs } = make({}, (x) => { x.KeepLastRecording = true; });
    sess.startTake();
    feed(sess, speech(1));
    await sess.stopTake();
    expect(wavs).toEqual([16000]);
  });

  it('mic failure ends the take with the WPF wording', () => {
    const { sess } = make();
    sess.startTake();
    sess.micFailed('NotAllowedError', 'Permission denied');
    expect(sess.phase).toBe('Idle');
    expect(sess.view().status).toMatch(/^Windows не даёт доступ к микрофону/);
  });

  it('session line for «Распознавание» (App.SpeechStatusText) and release before delete', async () => {
    const { sess, recs } = make();
    expect(sess.sessionLine()).toBeNull();
    await sess.ensureLoaded();
    expect(sess.sessionLine()).toBe('Загружена v3_e2e_rnnt, считает на процессоре. Потоков процессора: 4.');
    recs[0].deviceActual = 'gpu';
    expect(sess.sessionLine()).toBe('Загружена v3_e2e_rnnt, считает на видеокарте (DirectML). Настройка потоков процессор не трогает, пока считает видеокарта.');
    await sess.release();
    expect(recs[0].disposed).toBe(1);
    expect(sess.sessionLine()).toBeNull();
  });

  it('GPU fallback note when the video card did not start', async () => {
    const { sess, recs } = make({
      open: async (_d, kind) => {
        const r = new FakeRecognizer(kind);
        r.deviceNote = 'DML failed';
        recs.push(r);
        return r;
      },
    });
    await sess.ensureLoaded();
    expect(sess.sessionLine()).toContain('Видеокарта не поднялась, считаю на процессоре.');
  });
});

describe('DictationSession + VAD', () => {
  it('VadEnabled: the trimmed take goes to the recognizer; KeepLastRecording still gets the full take', async () => {
    const trims: number[] = [];
    const { sess, recs, copied, wavs } = make({
      trim: async (_s, x) => {
        trims.push(x.length);
        return x.slice(4000, 12000);
      },
    }, (x) => { x.KeepLastRecording = true; });
    sess.startTake();
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBe('привет мир');
    expect(trims).toEqual([16000]);
    expect(wavs).toEqual([16000]);
    expect(recs[0].calls[0].samples.length).toBe(8000);
    expect(copied).toEqual(['привет мир']);
  });

  it('VadEnabled off: no trim, the whole take is recognized', async () => {
    let trims = 0;
    const { sess, recs } = make({ trim: async (_s, x) => { trims++; return x.slice(0, 10); } }, (x) => { x.VadEnabled = false; });
    sess.startTake();
    feed(sess, speech(1));
    await sess.stopTake();
    expect(trims).toBe(0);
    expect(recs[0].calls[0].samples.length).toBe(16000);
  });

  it('silence and short takes are judged before the trim (trim not called)', async () => {
    let trims = 0;
    const { sess, recs } = make({ trim: async (_s, x) => { trims++; return x; } });
    sess.startTake();
    feed(sess, new Float32Array(16000));
    expect(await sess.stopTake()).toBeNull();
    expect(sess.view().status).toMatch(/^Тишина на входе/);
    sess.startTake();
    feed(sess, speech(0.2));
    expect(await sess.stopTake()).toBeNull();
    expect(sess.view().status).toMatch(/^Слишком коротко/);
    expect(trims).toBe(0);
    expect(recs.flatMap((r) => r.calls)).toHaveLength(0);
  });

  it('the Client role posts the trimmed take', async () => {
    const posted: number[] = [];
    const { sess } = make({
      trim: async (_s, x) => x.slice(0, 6000),
      remote: async (_s, x) => { posted.push(x.length); return 'с хоста'; },
    }, (x) => { x.NetworkRole = 'Client'; x.RemoteHost = '192.168.1.5'; });
    expect(sess.startTake().ok).toBe(true);
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBe('с хоста');
    expect(posted).toEqual([6000]);
  });

  it('cancel during the trim drops the take', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { sess, recs, copied } = make({ trim: async (_s, x) => { await gate; return x; } });
    sess.startTake();
    feed(sess, speech(1));
    const p = sess.stopTake();
    await new Promise((r) => setTimeout(r, 0));
    sess.cancelTake();
    release();
    expect(await p).toBeNull();
    expect(recs.flatMap((r) => r.calls)).toHaveLength(0);
    expect(copied).toEqual([]);
  });

  it('VadAutoStopMs: silence after speech stops the take by itself and the text is copied', async () => {
    const { sess, copied } = make({ trim: async (_s, x) => x }, (x) => { x.VadAutoStopMs = 600; });
    sess.startTake();
    const x = new Float32Array(3 * SAMPLE_RATE);
    for (let i = 0.3 * SAMPLE_RATE; i < 1.2 * SAMPLE_RATE; i++) x[i] = 0.3 * Math.sin(i * 0.2);
    feed(sess, x);
    for (let i = 0; i < 20 && copied.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(sess.phase).not.toBe('Listening');
    expect(copied).toEqual(['привет мир']);
  });

  it('VadAutoStopMs 0 (default): a long silence never stops a take', () => {
    const { s, sess } = make();
    expect(s.VadAutoStopMs).toBe(0);
    sess.startTake();
    feed(sess, speech(1));
    feed(sess, new Float32Array(5 * SAMPLE_RATE));
    expect(sess.phase).toBe('Listening');
    sess.cancelTake();
  });
});

describe('DictationSession in «Продажи» mode', () => {
  it('drafts run with the pill off and go to the sales card; the recognized take too (before the dictionary)', async () => {
    const sales: string[] = [];
    const partials: string[] = [];
    const overlay = {
      showListening() {}, showRecognizing() {}, showStatus() {}, showHint() {}, showCaption() {}, hideNow() {},
      showPartial(text: string) { partials.push(text); },
    };
    const { sess } = make({ partialMs: 0, overlay, sales: (t) => void sales.push(t) }, (x) => {
      x.Mode = 'Sales'; x.ShowOverlay = false; x.WordReplacementRules = 'мир=Мир!';
    });
    sess.startTake();
    await sess.ensureLoaded();
    feed(sess, speech(1));
    await sess.partialTick();
    expect(sales).toEqual(['привет мир']);
    expect(partials).toEqual([]); // pill is off
    expect(await sess.stopTake()).toBe('привет Мир!');
    expect(sales).toEqual(['привет мир', 'привет мир']);
  });

  it('Dictation mode: no drafts without the pill and nothing goes to the card', async () => {
    const sales: string[] = [];
    const { sess, recs } = make({ partialMs: 0, sales: (t) => void sales.push(t) }, (x) => { x.ShowOverlay = false; });
    sess.startTake();
    await sess.ensureLoaded();
    feed(sess, speech(1));
    await sess.partialTick();
    expect(recs[0].calls).toHaveLength(0);
    await sess.stopTake();
    expect(sales).toEqual([]);
  });

  it('a throwing card does not break the take', async () => {
    const { sess, copied } = make({ partialMs: 0, sales: () => { throw new Error('boom'); } }, (x) => { x.Mode = 'Sales'; });
    sess.startTake();
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBe('привет мир');
    expect(copied).toEqual(['привет мир']);
  });

  it('client role in Sales mode: host drafts and the host take reach the card', async () => {
    const sales: string[] = [];
    let n = 0;
    const { sess } = make({ remote: async () => `TP-${++n}`, partialMs: 0, sales: (t) => void sales.push(t) }, (x) => {
      x.NetworkRole = 'Client'; x.RemoteHost = 'host.lan'; x.Mode = 'Sales'; x.ShowOverlay = false;
    });
    sess.startTake();
    feed(sess, speech(1));
    await sess.partialTick();
    await sess.stopTake();
    expect(sales).toEqual(['TP-1', 'TP-2']);
  });
});

describe('DictationSession: global hold key takes go into the focused app', () => {
  class FakeInserter {
    calls: { text: string; mode: string; keep: boolean; restore: boolean }[] = [];
    reply: 'Done' | 'Blocked' | Error = 'Done';
    async insert(text: string, mode: 'Type' | 'Paste', clip: { keep: boolean; restore: boolean }) {
      this.calls.push({ text, mode, ...clip });
      if (this.reply instanceof Error) throw this.reply;
      return this.reply;
    }
  }

  async function take(sess: DictationSession, source: 'window' | 'hotkey') {
    expect(sess.startTake(source).ok).toBe(true);
    feed(sess, speech(1));
    return sess.stopTake();
  }

  it('a hotkey take is inserted with the insert mode and phrase-clipboard settings, not copied', async () => {
    const ins = new FakeInserter();
    const { sess, copied } = make({ inserter: () => ins }, (x) => { x.InsertMode = 'Type'; x.CopyPhraseToClipboard = true; x.RestoreClipboardAfterCopy = false; });
    expect(await take(sess, 'hotkey')).toBe('привет мир');
    expect(ins.calls).toEqual([{ text: 'привет мир', mode: 'Type', keep: true, restore: false }]);
    expect(copied).toEqual([]);
    expect(sess.view().status).toBe('Готово. Фраза вставлена.');
    expect(sess.view().lastText).toBe('привет мир');
  });

  it('the in-window button still copies even when the helper is there', async () => {
    const ins = new FakeInserter();
    const { sess, copied } = make({ inserter: () => ins });
    await take(sess, 'window');
    expect(ins.calls).toEqual([]);
    expect(copied).toEqual(['привет мир']);
  });

  it('no helper running: a hotkey take falls back to the clipboard', async () => {
    const { sess, copied } = make({ inserter: () => null });
    await take(sess, 'hotkey');
    expect(copied).toEqual(['привет мир']);
    expect(sess.view().status).toMatch(/^Готово\. Фраза в буфере обмена/);
  });

  it('an elevated target: the WPF admin hint; Type mode also puts the phrase on the clipboard', async () => {
    const ins = new FakeInserter();
    ins.reply = 'Blocked';
    const { s, sess, copied } = make({ inserter: () => ins });
    await take(sess, 'hotkey'); // Paste: the helper already left the phrase on the clipboard
    expect(sess.view().status).toBe('Это окно запущено от администратора, вставить туда нельзя. Текст лежит в буфере обмена.');
    expect(copied).toEqual([]);
    s.InsertMode = 'Type';
    await take(sess, 'hotkey');
    expect(copied).toEqual(['привет мир']);
  });

  it('the helper died mid-insert: the phrase goes to the clipboard with a hint', async () => {
    const ins = new FakeInserter();
    ins.reply = new Error('native helper exited');
    const { sess, copied } = make({ inserter: () => ins });
    await take(sess, 'hotkey');
    expect(copied).toEqual(['привет мир']);
    expect(sess.view().status).toBe('Вставить не получилось. Фраза в буфере обмена: вставьте её Ctrl+V.');
  });

  it('a Brain failure on a hotkey take: inserted as recognized with the WPF hint', async () => {
    const ins = new FakeInserter();
    const { sess } = make({
      inserter: () => ins,
      brainUsable: () => true,
      transform: async () => { throw new Error('boom'); },
    }, (x) => { x.Brain = 'Server'; x.BrainEveryTake = true; });
    await take(sess, 'hotkey');
    expect(ins.calls[0].text).toBe('привет мир');
    expect(sess.view().status).toBe('Мозг не справился: сервер не ответил. Вставлен текст без правки.');
  });

  it('Escape during a hotkey take: nothing is inserted', async () => {
    const ins = new FakeInserter();
    const { sess, copied } = make({ inserter: () => ins });
    sess.startTake('hotkey');
    feed(sess, speech(1));
    sess.cancelTake();
    expect(await sess.stopTake()).toBeNull();
    expect(ins.calls).toEqual([]);
    expect(copied).toEqual([]);
  });

  it('a tap of the key: "keep holding the key"', async () => {
    const { sess } = make({ inserter: () => new FakeInserter() });
    sess.startTake('hotkey');
    feed(sess, speech(0.1));
    await sess.stopTake();
    expect(sess.view().status).toBe('Слишком коротко. Держите клавишу, пока говорите.');
  });
});

/** Manual clock for the idle unload: run() fires whatever is pending. */
function manualClock() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    clock: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (h: unknown) => void pending.delete(h as number),
    },
    pending: () => [...pending.values()].map((p) => p.ms),
    run: () => {
      const list = [...pending.entries()];
      pending.clear();
      for (const [, p] of list) p.fn();
    },
  };
}

describe('DictationSession idle unload (IDEAS №13)', () => {
  it('unloads the recognizer after the idle delay and the next take loads it again', async () => {
    const c = manualClock();
    const { s, sess, opened, recs } = make({ idleClock: c.clock });
    expect(s.IdleUnloadMinutes).toBe(15);
    sess.startTake();
    feed(sess, speech(1));
    await sess.stopTake();
    expect(sess.current()).toBe(recs[0]);
    expect(c.pending()).toEqual([15 * 60_000]);
    c.run();
    await Promise.resolve();
    expect(sess.current()).toBeNull();
    expect(recs[0].disposed).toBe(1);
    expect(sess.sessionLine()).toBeNull();
    expect(sess.phase).toBe('Idle');
    // Lazy warm-up: the key press starts loading while the user speaks.
    sess.startTake();
    expect(opened).toHaveLength(2);
    feed(sess, speech(1));
    expect(await sess.stopTake()).toBe('привет мир');
    expect(recs).toHaveLength(2);
  });

  it('never unloads at 0 minutes', async () => {
    const c = manualClock();
    const { sess, recs } = make({ idleClock: c.clock }, (x) => { x.IdleUnloadMinutes = 0; });
    await sess.ensureLoaded();
    expect(c.pending()).toEqual([]);
    expect(sess.current()).toBe(recs[0]);
  });

  it('waits while recording or while Hermes uses the recognizer', async () => {
    const c = manualClock();
    let hermes = true;
    const { sess, recs } = make({ idleClock: c.clock, idleBusy: () => hermes }, (x) => { x.IdleUnloadMinutes = 5; });
    await sess.ensureLoaded();
    expect(c.pending()).toEqual([5 * 60_000]);
    c.run();
    expect(sess.current()).toBe(recs[0]);
    expect(c.pending()).toEqual([5 * 60_000]);
    hermes = false;
    sess.startTake();
    c.run();
    expect(sess.current()).toBe(recs[0]);
    sess.cancelTake();
    c.run();
    await Promise.resolve();
    expect(sess.current()).toBeNull();
    expect(recs[0].disposed).toBe(1);
  });

  it('touchIdle restarts the delay only while something is loaded; release cancels it', async () => {
    const c = manualClock();
    const { s, sess } = make({ idleClock: c.clock });
    sess.touchIdle();
    expect(c.pending()).toEqual([]);
    await sess.ensureLoaded();
    s.IdleUnloadMinutes = 30;
    sess.touchIdle();
    expect(c.pending()).toEqual([30 * 60_000]);
    await sess.release();
    expect(c.pending()).toEqual([]);
  });
});
