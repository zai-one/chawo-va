// Brain on a selection (WPF HintSelectionAsync + the selection branch of HandleReleaseAsync).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '@chawo/core/strings';
import { SAMPLE_RATE } from '@chawo/core/takeBuffer';
import * as Settings from '../src/settings';
import { DictationSession, type RecognizerLike, type SessionHooks } from '../src/dictation/dictationSession';
import type { OverlaySink } from '../src/overlay/overlayModel';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-sel-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});

class Rec implements RecognizerLike {
  readonly kind = 'v3_e2e_rnnt' as const;
  readonly modelId = 'v3_e2e_rnnt';
  deviceActual = 'cpu';
  deviceNote: string | null = null;
  intraOpThreads = 4;
  constructor(public reply: string) {}
  async transcribeCancelable(): Promise<string> { return this.reply; }
  cancelOwned(): void {}
  async dispose(): Promise<void> {}
}

function speech(seconds = 1): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (i > n * 0.3 && i < n * 0.7 ? 0.3 : 0) * Math.sin(i * 0.2) + 0.001 * Math.sin(i * 1.3);
  return out;
}

class Inserter {
  calls: string[] = [];
  async insert(text: string) { this.calls.push(text); return 'Done' as const; }
}

class Reader {
  calls = 0;
  release: ((v: string | null) => void) | null = null;
  constructor(public value: string | null, public deferred = false) {}
  readSelection(): Promise<string | null> {
    this.calls++;
    if (!this.deferred) return Promise.resolve(this.value);
    return new Promise((r) => { this.release = r; });
  }
}

interface BrainCall { body: string; command: string | null; selection: boolean | undefined }

function make(opts: {
  heard?: string;
  reader?: Reader | null;
  brain?: (body: string, command: string | null) => string | Error;
  brainUsable?: boolean;
  overlay?: OverlaySink;
  edit?: (s: Settings.SettingsData) => void;
} = {}) {
  const s = Settings.defaults();
  s.Brain = 'Server';
  s.ShowOverlay = false;
  opts.edit?.(s);
  const ins = new Inserter();
  const brain: BrainCall[] = [];
  const copied: string[] = [];
  const hooks: SessionHooks = {
    settings: () => s,
    copy: (t) => void copied.push(t),
    find: (k) => `/m/${k}`,
    open: async () => new Rec(opts.heard ?? 'сделай короче'),
    platform: 'win32',
    partialMs: 0,
    overlay: opts.overlay,
    inserter: () => ins,
    selection: () => opts.reader ?? null,
    brainUsable: () => opts.brainUsable ?? true,
    transform: async (_s, body, command, _status, _signal, selection) => {
      brain.push({ body, command, selection });
      const r = opts.brain ? opts.brain(body, command) : `КОРОТКО: ${body}`;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const sess = new DictationSession(hooks);
  return { s, sess, ins, brain, copied };
}

async function take(sess: DictationSession, source: 'window' | 'hotkey' = 'hotkey') {
  expect(sess.startTake(source).ok).toBe(true);
  const x = speech(1);
  for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
  return sess.stopTake();
}

describe('DictationSession: Brain on a selection', () => {
  it('selected text + speech = a command on the selection, pasted over it, with the Ctrl+Z hint', async () => {
    const reader = new Reader('Длинный абзац текста, который надо сократить.');
    const { sess, ins, brain } = make({ reader, heard: 'Чаво, сделай короче.' });
    expect(await take(sess)).toBe('КОРОТКО: Длинный абзац текста, который надо сократить.');
    expect(reader.calls).toBe(1);
    expect(brain).toEqual([{ body: 'Длинный абзац текста, который надо сократить.', command: 'сделай короче', selection: true }]);
    expect(ins.calls).toEqual(['КОРОТКО: Длинный абзац текста, который надо сократить.']);
    expect(sess.view().status).toBe('Готово. Вернуть как было: Ctrl+Z');
  });

  it('the address is optional before a command on a selection', async () => {
    const { sess, brain } = make({ reader: new Reader('текст'), heard: 'переведи на английский' });
    await take(sess);
    expect(brain[0]).toMatchObject({ command: 'переведи на английский', selection: true });
  });

  it('a Brain failure leaves the selection alone: nothing is inserted, the WPF hint says so', async () => {
    const { sess, ins, copied } = make({ reader: new Reader('мой текст'), brain: () => new Error('boom') });
    expect(await take(sess)).toBeNull();
    expect(ins.calls).toEqual([]);
    expect(copied).toEqual([]);
    expect(sess.view().status).toBe('Мозг не справился: сервер не ответил. Выделенный текст не тронут.');
  });

  it('an empty Brain answer never wipes the selection', async () => {
    const { sess, ins } = make({ reader: new Reader('мой текст'), brain: () => '  ' });
    await take(sess);
    expect(ins.calls).toEqual([]);
    expect(sess.view().status).toBe('Мозг не справился: нейросеть вернула пустой ответ. Выделенный текст не тронут.');
  });

  it('simple syntax is not applied to an edited selection', async () => {
    const { sess, ins } = make({ reader: new Reader('Текст.'), brain: () => 'Готовый Текст.', edit: (s) => { s.SimpleSyntax = true; } });
    await take(sess);
    expect(ins.calls).toEqual(['Готовый Текст.']);
  });

  it('nothing selected: plain dictation (and «Чаво, …» on the dictated text still works)', async () => {
    const { sess, ins, brain } = make({ reader: new Reader(null), heard: 'привет мир' });
    await take(sess);
    expect(brain).toEqual([]);
    expect(ins.calls).toEqual(['привет мир']);
    const b = make({ reader: new Reader(null), heard: 'привет мир, Чаво, переведи' });
    await take(b.sess);
    expect(b.brain).toEqual([{ body: 'привет мир', command: 'переведи', selection: false }]);
  });

  it('no read when the setting is off, the Brain is not usable, or the take came from the window button', async () => {
    const r1 = new Reader('x');
    await take(make({ reader: r1, edit: (s) => { s.BrainOnSelection = false; } }).sess);
    const r2 = new Reader('x');
    await take(make({ reader: r2, brainUsable: false }).sess);
    const r3 = new Reader('x');
    const w = make({ reader: r3 });
    await take(w.sess, 'window');
    expect([r1.calls, r2.calls, r3.calls]).toEqual([0, 0, 0]);
    expect(w.copied).toEqual(['сделай короче']);
  });

  it('no helper (reader null): plain dictation', async () => {
    const { sess, ins } = make({ reader: null, heard: 'просто текст' });
    await take(sess);
    expect(ins.calls).toEqual(['просто текст']);
  });

  it('a silent take does not wait for the selection and does nothing to it', async () => {
    const reader = new Reader('мой текст');
    const { sess, ins, brain } = make({ reader, heard: '' });
    await take(sess);
    expect(brain).toEqual([]);
    expect(ins.calls).toEqual([]);
  });

  it('a slow read: the take waits for it at release', async () => {
    const reader = new Reader(null, true);
    const { sess, ins } = make({ reader });
    expect(sess.startTake('hotkey').ok).toBe(true);
    const x = speech(1);
    for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
    const done = sess.stopTake();
    await new Promise((r) => setTimeout(r, 20));
    expect(ins.calls).toEqual([]);
    reader.release!('выделено');
    expect(await done).toBe('КОРОТКО: выделено');
  });

  it('Escape while the selection is read: nothing is inserted, nothing sent to the Brain', async () => {
    const reader = new Reader(null, true);
    const { sess, ins, brain } = make({ reader });
    sess.startTake('hotkey');
    const x = speech(1);
    for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
    const done = sess.stopTake();
    await new Promise((r) => setTimeout(r, 10));
    sess.cancelTake();
    reader.release!('выделено');
    expect(await done).toBeNull();
    expect(brain).toEqual([]);
    expect(ins.calls).toEqual([]);
  });

  it('while listening the pill says how much is selected (HintSelectionAsync); without the pill the page does', async () => {
    const captions: string[] = [];
    const overlay: OverlaySink = {
      showListening() {}, showRecognizing() {}, showPartial() {}, showStatus() {}, showHint() {}, hideNow() {},
      showCaption: (t) => void captions.push(t),
    };
    const a = make({ reader: new Reader('двенадцать з'), overlay, edit: (s) => { s.ShowOverlay = true; } });
    a.sess.startTake('hotkey');
    await new Promise((r) => setTimeout(r, 0));
    expect(captions).toEqual(['Выделено 12 знаков. Скажите, что с ними сделать']);
    a.sess.cancelTake();

    const b = make({ reader: new Reader('abc') });
    b.sess.startTake('hotkey');
    await new Promise((r) => setTimeout(r, 0));
    expect(b.sess.view().status).toBe('Выделено 3 знаков. Скажите, что с ними сделать');
    b.sess.cancelTake();
  });

  it('a read that finishes after the take ended shows no hint', async () => {
    const captions: string[] = [];
    const overlay: OverlaySink = {
      showListening() {}, showRecognizing() {}, showPartial() {}, showStatus() {}, showHint() {}, hideNow() {},
      showCaption: (t) => void captions.push(t),
    };
    const reader = new Reader(null, true);
    const { sess } = make({ reader, overlay, edit: (s) => { s.ShowOverlay = true; } });
    sess.startTake('hotkey');
    sess.cancelTake();
    reader.release!('поздно');
    await new Promise((r) => setTimeout(r, 0));
    expect(captions).toEqual([]);
  });
});
