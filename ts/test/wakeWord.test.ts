// «Чаво» as a hands-free start: the leading-word match, the streaming detector (energy gate → one probe
// per phrase), and the listener that turns a hit into a 'wake' take in the real DictationSession
// (fake recognizer), plus the IPC that tells the window to keep the word's microphone open.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  },
  clipboard: { writeText: () => undefined },
  BrowserWindow: class {},
}));

import { applyLanguage } from '../src/core/strings';
import { WakeDetector, matchWake, type WakeHit } from '../src/core/wakeWord';
import * as Settings from '../src/main/settings';
import { DictationSession, WAKE_NO_SPEECH_MS, type RecognizerLike } from '../src/main/dictation/dictationSession';
import { WakeListener } from '../src/main/dictation/wakeListener';
import { registerDictationIpc } from '../src/main/dictationIpc';

const RATE = 16000;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-wake-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});
beforeEach(() => handlers.clear());

function quiet(seconds: number): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.001 * Math.sin(i * 1.3);
  return out;
}
function voice(seconds: number, amp = 0.3): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(i * 0.2) * (0.6 + 0.4 * Math.sin(i / 400));
  return out;
}
function cat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function feed(push: (c: Float32Array) => void, x: Float32Array): void {
  for (let i = 0; i < x.length; i += 640) push(x.slice(i, i + 640));
}
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('matchWake', () => {
  it('the word at the very start, in the spellings the model gives, with or without a pause mark', () => {
    expect(matchWake('Чаво')).toEqual({ rest: '' });
    expect(matchWake('Чава.')).toEqual({ rest: '' });
    expect(matchWake('Чавы.')).toEqual({ rest: '' });
    expect(matchWake('чаво, переведи на английский')).toEqual({ rest: 'переведи на английский' });
    expect(matchWake('Чево — напиши маме')).toEqual({ rest: 'напиши маме' });
    expect(matchWake('«Чаво» привет')).toEqual({ rest: 'привет' });
    expect(matchWake('Chawo, hello')).toEqual({ rest: 'hello' });
  });

  it('not the word: other words, a longer word, the word later in the phrase', () => {
    expect(matchWake('Чего ты хочешь?')).toBeNull();
    expect(matchWake('Чавочка пришла')).toBeNull();
    expect(matchWake('Привет, Чаво')).toBeNull();
    expect(matchWake('Ча. Переведи на английский.')).toBeNull();
    expect(matchWake('')).toBeNull();
  });
});

function detector(reply: string | ((clip: Float32Array) => Promise<string | null>)) {
  const clips: Float32Array[] = [];
  const hits: WakeHit[] = [];
  const d = new WakeDetector(
    async (clip) => {
      clips.push(clip);
      return typeof reply === 'string' ? reply : reply(clip);
    },
    (h) => void hits.push(h),
  );
  return { d, clips, hits, push: (x: Float32Array) => feed((c) => d.push(c), x) };
}

describe('WakeDetector', () => {
  it('silence and a short click are never probed', async () => {
    const { d, push } = detector('Чаво');
    push(quiet(3));
    push(voice(0.1));
    push(quiet(1));
    await flush();
    expect(d.probes).toBe(0);
    expect(d.state).toBe('quiet');
  });

  it('«Чаво» and a pause: one probe of the phrase with the pre-roll, a word-only hit, then silent until resume', async () => {
    const { d, clips, hits, push } = detector('Чава.');
    push(quiet(1));
    push(voice(0.6));
    push(quiet(0.7));
    await flush();
    expect(d.probes).toBe(1);
    // pre-roll 0.4 s + 0.6 s of voice + the 0.45 s pause that ended it (window rounding aside)
    expect(clips[0].length / RATE).toBeGreaterThan(1.3);
    expect(clips[0].length / RATE).toBeLessThan(1.6);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ text: 'Чава.', rest: '', wordOnly: true });
    expect(d.state).toBe('handedOff');
    push(voice(1));
    push(quiet(1));
    await flush();
    expect(d.probes).toBe(1);
    d.resume();
    push(quiet(0.5));
    push(voice(0.6));
    push(quiet(0.6));
    await flush();
    expect(d.probes).toBe(2);
  });

  it('a phrase that goes on: probed after 1.6 s of speech, the hit carries everything heard so far', async () => {
    let release!: (v: string) => void;
    const { d, clips, hits, push } = detector(() => new Promise<string>((r) => { release = r; }));
    push(quiet(1));
    push(voice(1.8));
    expect(d.probes).toBe(1);
    expect(clips[0].length / RATE).toBeLessThan(2.1);
    push(voice(0.5)); // still talking while the probe runs
    release('Чаво, переведи');
    await flush();
    expect(hits).toHaveLength(1);
    expect(hits[0].wordOnly).toBe(false);
    expect(hits[0].rest).toBe('переведи');
    expect(hits[0].audio.length).toBeGreaterThan(clips[0].length);
  });

  it('someone else talking: no hit, the rest of that phrase is skipped, the next phrase is probed again', async () => {
    const { d, hits, push } = detector('Привет, как дела');
    push(quiet(1));
    push(voice(4));
    await flush();
    expect(d.probes).toBe(1);
    expect(d.state).toBe('skip');
    push(voice(2));
    expect(d.probes).toBe(1);
    push(quiet(0.6));
    expect(d.state).toBe('quiet');
    push(voice(0.6));
    push(quiet(0.6));
    await flush();
    expect(d.probes).toBe(2);
    expect(hits).toHaveLength(0);
  });

  it('speech that starts while the word is being checked is handed over in `after`, not lost', async () => {
    let release!: (v: string) => void;
    const { hits, push } = detector(() => new Promise<string>((r) => { release = r; }));
    push(quiet(1));
    push(voice(0.6));
    push(quiet(0.6)); // phrase ended → probe runs (slow)
    push(voice(0.8)); // the dictation already started
    release('Чаво');
    await flush();
    expect(hits).toHaveLength(1);
    expect(hits[0].wordOnly).toBe(true);
    expect(hits[0].after.length / RATE).toBeGreaterThan(0.8);
  });

  it('a miss while the next phrase is already under way: that phrase is checked too', async () => {
    const replies = ['Привет', 'Чаво'];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { d, hits, push } = detector(async () => {
      const text = replies.shift() ?? '';
      if (text === 'Привет') await gate;
      return text;
    });
    push(quiet(1));
    push(voice(0.6));
    push(quiet(0.6));
    push(voice(0.5)); // «Чаво» starts while «Привет» is still being checked
    release();
    await flush();
    push(voice(0.1));
    push(quiet(0.6));
    await flush();
    expect(d.probes).toBe(2);
    expect(hits).toHaveLength(1);
  });

  it('a probe that fails or answers after hold() is ignored', async () => {
    let release!: (v: string) => void;
    const late = detector(() => new Promise<string>((r) => { release = r; }));
    late.push(quiet(1));
    late.push(voice(0.6));
    late.push(quiet(0.6));
    late.d.hold();
    release('Чаво');
    await flush();
    expect(late.hits).toHaveLength(0);

    const broken = detector(async () => { throw new Error('ORT'); });
    broken.push(quiet(1));
    broken.push(voice(0.6));
    broken.push(quiet(0.6));
    await flush();
    expect(broken.hits).toHaveLength(0);
    expect(broken.d.state).toBe('quiet');
  });
});

class QueueRecognizer implements RecognizerLike {
  readonly kind = 'v3_e2e_rnnt' as const;
  readonly modelId = 'v3_e2e_rnnt';
  deviceActual = 'cpu';
  deviceNote: string | null = null;
  intraOpThreads = 4;
  calls: number[] = [];
  constructor(private readonly replies: string[]) {}
  async transcribeCancelable(samples: Float32Array): Promise<string> {
    this.calls.push(samples.length);
    return this.replies.shift() ?? '';
  }
  cancelOwned(): void {}
  async dispose(): Promise<void> {}
}

function rig(replies: string[], edit?: (s: Settings.SettingsData) => void) {
  const s = Settings.defaults();
  s.WakeWord = true;
  edit?.(s);
  const rec = new QueueRecognizer(replies);
  const copied: string[] = [];
  const inserted: string[] = [];
  const sess = new DictationSession({
    settings: () => s,
    copy: (t) => void copied.push(t),
    find: (k) => `/m/${k}`,
    open: async () => rec,
    platform: 'linux',
    trim: async (_s, x) => x,
    inserter: () => ({ insert: async (text: string) => { inserted.push(text); return 'Done'; } }) as never,
  });
  const started: WakeHit[] = [];
  const wake = new WakeListener(sess, () => s, { started: (h) => void started.push(h) });
  return { s, sess, rec, wake, copied, inserted, started, push: (x: Float32Array) => feed((c) => wake.push(c), x) };
}

describe('WakeListener + DictationSession', () => {
  it('«Чаво», pause, dictation, pause: a hands-free take ends by itself and the text is inserted like the key', async () => {
    const r = rig(['Чава.', 'привет мир']);
    r.push(quiet(1));
    r.push(voice(0.6));
    r.push(quiet(0.7));
    await flush();
    expect(r.started).toHaveLength(1);
    expect(r.sess.phase).toBe('Listening');
    expect(r.wake.inTake).toBe(true);
    // The take starts after the word: dictation, then a 1.5 s pause ends it (auto-stop is off in settings).
    r.push(voice(1.2));
    r.push(quiet(1.7));
    await flush(20);
    expect(r.sess.phase).toBe('Idle');
    expect(r.inserted).toEqual(['привет мир']);
    // The take did not include the word itself: ~1.2 s of voice plus the pause, not the 1.4 s probe clip too.
    expect(r.rec.calls[1] / RATE).toBeLessThan(3.2);
    // Listening for the word again.
    r.push(quiet(0.5));
    expect(r.wake.inTake).toBe(false);
    expect(r.wake.listening).toBe(true);
  });

  it('«Чаво, переведи…» in one breath: the take starts with what was already said', async () => {
    const r = rig(['Чаво, переведи', 'Чаво, переведи на английский: привет']);
    r.push(quiet(1));
    r.push(voice(2.5));
    await flush();
    expect(r.started).toHaveLength(1);
    expect(r.started[0].wordOnly).toBe(false);
    r.push(voice(0.5));
    r.push(quiet(1.7));
    await flush(20);
    expect(r.sess.phase).toBe('Idle');
    // Brain is off in defaults: the text goes in as recognized.
    expect(r.inserted).toHaveLength(1);
    expect(r.rec.calls[1] / RATE).toBeGreaterThan(4);
  });

  it('nothing said after the word: the take is dropped after 6 s with a note', async () => {
    const r = rig(['Чаво']);
    r.push(quiet(1));
    r.push(voice(0.6));
    r.push(quiet(0.7));
    await flush();
    expect(r.sess.phase).toBe('Listening');
    r.push(quiet(WAKE_NO_SPEECH_MS / 1000 + 0.2));
    expect(r.sess.phase).toBe('Idle');
    expect(r.sess.view().status).toBe('После «Чаво» ничего не прозвучало, запись отменена.');
    expect(r.inserted).toEqual([]);
  });

  it('off, the Client role, or a take from the key: the stream is ignored and nothing is probed', async () => {
    const off = rig(['Чаво'], (s) => { s.WakeWord = false; });
    off.push(quiet(1));
    off.push(voice(0.6));
    off.push(quiet(0.7));
    await flush();
    expect(off.rec.calls).toEqual([]);

    const client = rig(['Чаво'], (s) => { s.NetworkRole = 'Client'; s.RemoteHost = '127.0.0.1'; });
    expect(client.wake.wanted()).toBe(false);
    client.push(quiet(1));
    client.push(voice(0.6));
    client.push(quiet(0.7));
    await flush();
    expect(client.rec.calls).toEqual([]);

    const key = rig(['Чаво']);
    expect(key.sess.startTake('hotkey').ok).toBe(true);
    key.push(quiet(1));
    key.push(voice(0.6));
    key.push(quiet(0.7));
    await flush();
    expect(key.rec.calls).toEqual([]);
    expect(key.started).toEqual([]);
  });

  it('someone else talking never starts a take', async () => {
    const r = rig(['Привет, как дела', 'Чего ты хочешь']);
    r.push(quiet(1));
    r.push(voice(0.8));
    r.push(quiet(0.7));
    await flush();
    r.push(voice(0.8));
    r.push(quiet(0.7));
    await flush();
    expect(r.rec.calls).toHaveLength(2);
    expect(r.started).toEqual([]);
    expect(r.sess.phase).toBe('Idle');
  });
});

describe('«Чаво» IPC and setting', () => {
  it('the checkbox saves WakeWord and tells the window to open or close the word microphone', async () => {
    const s = Settings.defaults();
    s.StartHintDismissed = true;
    const sent: { channel: string; payload: unknown }[] = [];
    const win = { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } };
    registerDictationIpc(() => win as never, { get: () => s });
    expect(await handlers.get('wake:want')!()).toEqual({ on: false, micId: '' });
    const st = (await handlers.get('dictation:wake')!({}, true)) as { wakeWord: boolean; wakeNote: string };
    expect(s.WakeWord).toBe(true);
    expect(st.wakeWord).toBe(true);
    expect(st.wakeNote).toContain('модель распознавания');
    expect(sent.filter((x) => x.channel === 'wake:listen').map((x) => x.payload)).toEqual([{ on: true, micId: '' }]);
    expect(Settings.load().WakeWord).toBe(true);
    s.NetworkRole = 'Client';
    const cl = (await handlers.get('dictation:wake')!({}, true)) as { wakeNote: string };
    expect(cl.wakeNote).toContain('хост');
    expect(sent.filter((x) => x.channel === 'wake:listen').map((x) => x.payload).at(-1)).toEqual({ on: false, micId: '' });
  });

  it('off by default and kept through save/load', () => {
    expect(Settings.defaults().WakeWord).toBe(false);
    const s = Settings.defaults();
    s.WakeWord = true;
    expect(Settings.toJsonObject(s).WakeWord).toBe(true);
  });
});
