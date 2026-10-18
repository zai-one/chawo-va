import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import { SAMPLE_RATE } from '@chawo/core/takeBuffer';
import {
  CUE_MAX_GAIN,
  CueTracker,
  cueForTransition,
  cueLength,
  cueTones,
  trayStateFor,
  trayTooltip,
  type CueKind,
  type CuePhase,
} from '@chawo/core/cues';
import { DOT_RECORDING, paintDot } from '@chawo/core/trayDot';
import * as Settings from '../src/settings';
import { DictationController, type TakeView } from '../src/dictation/dictationPage';
import { DictationSession, type RecognizerLike } from '../src/dictation/dictationSession';

beforeAll(() => applyLanguage('Russian'));
afterAll(() => applyLanguage('Russian'));

describe('cueForTransition', () => {
  const table: [CuePhase, CuePhase, CueKind | null][] = [
    ['Idle', 'Listening', 'start'],
    ['NoModel', 'Listening', 'start'],
    ['Listening', 'Recognizing', 'stop'],
    ['Listening', 'Idle', 'cancel'],
    ['Listening', 'NoModel', 'cancel'],
    ['Recognizing', 'Idle', null],
    ['Recognizing', 'Listening', 'start'],
    ['Idle', 'NoModel', null],
    ['NoModel', 'Idle', null],
    ['Idle', 'Idle', null],
    ['Listening', 'Listening', null],
  ];
  it.each(table)('%s → %s = %s', (a, b, want) => {
    expect(cueForTransition(a, b)).toBe(want);
  });
});

describe('cue tones', () => {
  it('every cue is short, quiet and in the speech-free hearing band', () => {
    for (const k of ['start', 'stop', 'cancel'] as CueKind[]) {
      const tones = cueTones(k);
      expect(tones.length).toBeGreaterThan(0);
      expect(cueLength(k)).toBeLessThanOrEqual(300);
      for (const t of tones) {
        expect(t.gain).toBeGreaterThan(0);
        expect(t.gain).toBeLessThanOrEqual(CUE_MAX_GAIN);
        expect(t.freq).toBeGreaterThanOrEqual(200);
        expect(t.freq).toBeLessThanOrEqual(2000);
        expect(t.ms).toBeGreaterThanOrEqual(30);
      }
    }
  });
  it('start rises, stop falls, cancel is lower than both', () => {
    const f = (k: CueKind) => cueTones(k).map((t) => t.freq);
    const [s0, s1] = f('start');
    const [p0, p1] = f('stop');
    expect(s1).toBeGreaterThan(s0);
    expect(p1).toBeLessThan(p0);
    expect(Math.max(...f('cancel'))).toBeLessThan(Math.min(...f('start'), ...f('stop')));
  });
  it('returns copies: callers cannot change the table', () => {
    cueTones('start')[0].freq = 1;
    expect(cueTones('start')[0].freq).not.toBe(1);
  });
});

describe('CueTracker', () => {
  it('first phase is only the baseline; then plays on changes while enabled', () => {
    let on = true;
    const played: CueKind[] = [];
    const tr = new CueTracker(() => on, (k) => played.push(k));
    tr.observe('Listening'); // app start mid-take: no beep
    tr.observe('Listening');
    tr.observe('Recognizing');
    tr.observe('Idle');
    tr.observe('Listening');
    on = false;
    tr.observe('Idle');
    on = true;
    tr.observe('Listening');
    expect(played).toEqual(['stop', 'start', 'start']);
  });
});

describe('tray state', () => {
  it('maps phases and tooltips', () => {
    expect(trayStateFor('Listening')).toBe('recording');
    expect(trayStateFor('Recognizing')).toBe('recognizing');
    expect(trayStateFor('Idle')).toBe('idle');
    expect(trayStateFor('NoModel')).toBe('idle');
    expect(trayTooltip('idle', 'Chawo 2.0')).toBe('Chawo 2.0');
    expect(trayTooltip('recording', 'Chawo 2.0')).toBe('Chawo 2.0 — идёт запись');
    expect(trayTooltip('recognizing', 'Chawo 2.0')).toBe('Chawo 2.0 — распознаю');
    applyLanguage('English');
    expect(trayTooltip('recording', 'Chawo')).toBe('Chawo — recording');
    applyLanguage('Russian');
  });
});

describe('paintDot', () => {
  const W = 32;
  const H = 32;
  const px = (b: Uint8Array, x: number, y: number) => Array.from(b.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
  it('paints a red dot bottom-right with a dark ring, leaves the rest alone', () => {
    const src = new Uint8Array(W * H * 4); // fully transparent
    src.set([200, 200, 200, 255], (2 * W + 2) * 4); // one glyph pixel top-left
    const out = paintDot(src, W, H, DOT_RECORDING);
    expect(out).not.toBe(src);
    expect(px(src, 24, 24)).toEqual([0, 0, 0, 0]); // input untouched
    // centre of the dot: BGRA of #EF5143, opaque
    expect(px(out, 24, 24)).toEqual([0x43, 0x51, 0xef, 255]);
    // far corner and the glyph pixel stay as they were
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out, 2, 2)).toEqual([200, 200, 200, 255]);
    // just outside the dot but inside the ring: dark, opaque-ish
    const ring = px(out, 31, 24);
    expect(ring[3]).toBeGreaterThan(100);
    expect(Math.max(ring[0], ring[1], ring[2])).toBeLessThan(80);
  });
  it('scales with the icon and refuses a short buffer', () => {
    const big = paintDot(new Uint8Array(64 * 64 * 4), 64, 64, DOT_RECORDING);
    const covered = (b: Uint8Array) => { let n = 0; for (let i = 3; i < b.length; i += 4) if (b[i] > 0) n++; return n; };
    const small = paintDot(new Uint8Array(16 * 16 * 4), 16, 16, DOT_RECORDING);
    expect(covered(big) / (64 * 64)).toBeCloseTo(covered(small) / (16 * 16), 1);
    expect(() => paintDot(new Uint8Array(10), 16, 16, DOT_RECORDING)).toThrow();
  });
});

describe('SoundCues setting', () => {
  it('defaults off, round-trips through settings.json, garbage keeps the default', () => {
    expect(Settings.defaults().SoundCues).toBe(false);
    const s = Settings.defaults();
    s.SoundCues = true;
    expect(Settings.toJsonObject(s).SoundCues).toBe(true);
    expect(Settings.fromJsonObject({ SoundCues: true }).settings.SoundCues).toBe(true);
    expect(Settings.fromJsonObject({ SoundCues: 'yes' }).settings.SoundCues).toBe(false);
    expect(Settings.fromJsonObject({}).settings.SoundCues).toBe(false);
  });

  it('one checkbox on «Диктовка»: label, tip, saves once', () => {
    const s = Settings.defaults();
    let saves = 0;
    let changes = 0;
    const take: TakeView = { phase: 'Idle', status: '', lastText: '', loading: false };
    const ctl = new DictationController({
      settings: () => s,
      save: () => void saves++,
      changed: () => void changes++,
      take: () => take,
      find: () => '/m/x',
      platform: 'win32',
    });
    const st = ctl.state();
    expect(st.soundCues).toBe(false);
    expect(st.soundCuesLabel).toBe('Звуковые сигналы начала и конца записи');
    expect(st.soundCuesTip).toContain('ничего не скачивается');
    ctl.setSoundCues(true);
    ctl.setSoundCues(true);
    expect(s.SoundCues).toBe(true);
    expect(saves).toBe(1);
    expect(changes).toBe(1);
    expect(ctl.state().soundCues).toBe(true);
  });

  it('«Win+V» checkbox on Windows only: keeps the phrase in clipboard history, saves once', () => {
    const s = Settings.defaults();
    let saves = 0;
    const take: TakeView = { phase: 'Idle', status: '', lastText: '', loading: false };
    const hooks = { settings: () => s, save: () => void saves++, take: () => take, find: () => '/m/x' };
    const ctl = new DictationController({ ...hooks, platform: 'win32' });
    expect(ctl.state().keepPhrase).toMatchObject({ on: false, label: 'Сохранять фразу в журнале буфера обмена (Win+V)' });
    expect(ctl.state().keepPhrase?.tip).toMatch(/облачный буфер.*не уходит/);
    ctl.setKeepPhrase(true);
    ctl.setKeepPhrase(true);
    expect(s.CopyPhraseToClipboard).toBe(true);
    expect(saves).toBe(1);
    expect(ctl.state().keepPhrase?.on).toBe(true);
    expect(new DictationController({ ...hooks, platform: 'linux' }).state().keepPhrase).toBeNull();
  });
});

class FakeRec implements RecognizerLike {
  readonly kind = 'v3_e2e_rnnt' as const;
  readonly modelId = 'v3_e2e_rnnt';
  deviceActual = 'cpu';
  deviceNote: string | null = null;
  intraOpThreads = 1;
  async transcribeCancelable(): Promise<string> { return 'привет мир'; }
  cancelOwned(): void {}
  async dispose(): Promise<void> {}
}

function speech(seconds = 1, amp = 0.3): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (i > n * 0.3 && i < n * 0.7 ? amp : 0) * Math.sin(i * 0.2) + 0.001 * Math.sin(i * 1.3);
  return out;
}

describe('cues follow a real DictationSession (as dictationIpc wires them)', () => {
  function rig(enabled: boolean) {
    const s = Settings.defaults();
    s.SoundCues = enabled;
    const played: CueKind[] = [];
    const tray: string[] = [];
    let sess!: DictationSession;
    const tracker = new CueTracker(() => s.SoundCues, (k) => played.push(k));
    const observe = () => {
      tracker.observe(sess.phase);
      const t = trayStateFor(sess.phase);
      if (tray[tray.length - 1] !== t) tray.push(t);
    };
    sess = new DictationSession({
      settings: () => s,
      push: observe,
      find: () => '/m/x',
      open: async () => new FakeRec(),
      platform: 'win32',
      partialMs: 0,
      brainUsable: () => false,
    });
    return { s, sess, played, tray, observe };
  }

  it('take → start, release → stop; Escape → cancel', async () => {
    const { sess, played, tray, observe } = rig(true);
    observe(); // baseline Idle
    await sess.ensureLoaded();
    expect(sess.startTake().ok).toBe(true);
    const a = speech(1.2);
    for (let i = 0; i < a.length; i += 640) sess.appendPcm(a.subarray(i, i + 640));
    const text = await sess.stopTake();
    expect(text).toBe('привет мир');
    expect(sess.startTake().ok).toBe(true);
    sess.cancelTake();
    observe();
    expect(played).toEqual(['start', 'stop', 'start', 'cancel']);
    expect(tray).toEqual(['idle', 'recording', 'recognizing', 'idle', 'recording', 'idle']);
  });

  it('off: no cues, but the tray still follows the take', async () => {
    const { sess, played, tray, observe } = rig(false);
    observe();
    await sess.ensureLoaded();
    sess.startTake();
    sess.cancelTake();
    observe();
    expect(played).toEqual([]);
    expect(tray).toEqual(['idle', 'recording', 'idle']);
  });
});
