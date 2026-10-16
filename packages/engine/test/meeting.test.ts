import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWav } from '@chawo/core/audio';
import { applyLanguage } from '@chawo/core/strings';
import { MEETING_RATE, MeetingRecorder, meetingPath, repairUnfinished, repairWav, wavHeader } from '../src/meeting/meetingRecorder';
import { systemAudioMode } from '../src/meeting/systemAudio';
import { MeetingController, type MeetingDeps } from '../src/meeting/meetingController';
import * as Settings from '../src/settings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-meeting-'));
  applyLanguage('Russian');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Interleaved stereo: mic = a, computer = b, `frames` long. */
const stereo = (frames: number, a: number, b: number) => {
  const x = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    x[2 * i] = a;
    x[2 * i + 1] = b;
  }
  return x;
};

const channels = (path: string) => {
  const d = readFileSync(path);
  const n = Math.floor((d.length - 44) / 4);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = d.readInt16LE(44 + 4 * i) / 32768;
    r[i] = d.readInt16LE(46 + 4 * i) / 32768;
  }
  return { l, r, channels: d.readUInt16LE(22), rate: d.readUInt32LE(24), data: d.readUInt32LE(40), riff: d.readUInt32LE(4), size: d.length };
};

describe('readWav', () => {
  it('averages stereo channels so both the mic and the computer sound are heard', () => {
    const p = join(dir, 's.wav');
    const r = new MeetingRecorder();
    r.start(p);
    r.append(stereo(MEETING_RATE * 2, 0.5, -0.25));
    r.stop();
    const w = readWav(readFileSync(p));
    expect(w.rate).toBe(16000);
    expect(w.samples.length).toBe(MEETING_RATE * 2);
    expect(w.samples[100]).toBeCloseTo(0.125, 3);
  });
});

describe('MeetingRecorder', () => {
  it('names files by date and never overwrites', () => {
    const now = new Date(2026, 9, 13, 9, 5);
    const a = meetingPath(dir, now, 'Встреча');
    expect(a).toBe(join(dir, 'Встреча 2026-10-13 09-05.wav'));
    writeFileSync(a, '');
    expect(meetingPath(dir, now, 'Встреча')).toBe(join(dir, 'Встреча 2026-10-13 09-05 (2).wav'));
  });

  it('writes a 16 kHz 16-bit stereo WAV with the mic left and the computer right', () => {
    const p = join(dir, 'sub', 'm.wav');
    const r = new MeetingRecorder();
    r.start(p);
    for (let k = 0; k < 10; k++) r.append(stereo(4000, 0.25, -0.5));
    expect(r.levels[0]).toBeCloseTo(0.25, 5);
    expect(r.levels[1]).toBeCloseTo(0.5, 5);
    const res = r.stop()!;
    expect(res.path).toBe(p);
    expect(res.seconds).toBeCloseTo(2.5, 5);
    const c = channels(p);
    expect(c.channels).toBe(2);
    expect(c.rate).toBe(16000);
    expect(c.data).toBe(40000 * 4);
    expect(c.riff).toBe(36 + c.data);
    expect(c.l[123]).toBeCloseTo(0.25, 3);
    expect(c.r[39999]).toBeCloseTo(-0.5, 3);
  });

  it('clamps out-of-range and NaN samples', () => {
    const p = join(dir, 'c.wav');
    const r = new MeetingRecorder();
    r.start(p);
    const x = stereo(MEETING_RATE, 0, 0);
    x[0] = 3;
    x[1] = Number.NaN;
    x[2] = -7;
    r.append(x);
    r.stop();
    const c = channels(p);
    expect(c.l[0]).toBeCloseTo(1, 3);
    expect(c.r[0]).toBe(0);
    expect(c.l[1]).toBeCloseTo(-1, 3);
  });

  it('keeps the header valid during a long recording (crash-safe)', () => {
    let t = 0;
    const p = join(dir, 'long.wav');
    const r = new MeetingRecorder(() => t, 5000);
    r.start(p);
    for (let k = 0; k < 24; k++) {
      t += 250;
      r.append(stereo(4000, 0.1, 0.1));
    }
    // 6 s in: the 5 s patch has run, so a file copied now is playable up to then.
    const mid = channels(p);
    expect(mid.data).toBeGreaterThanOrEqual(20 * 4000 * 4);
    expect(mid.size).toBeGreaterThanOrEqual(44 + mid.data);
    r.stop();
    expect(channels(p).data).toBe(24 * 4000 * 4);
  });

  it('drops a recording under a second and deletes on cancel', () => {
    const a = join(dir, 'short.wav');
    const r = new MeetingRecorder();
    r.start(a);
    r.append(stereo(8000, 0.1, 0.1));
    expect(r.stop()).toBeNull();
    expect(existsSync(a)).toBe(false);
    const b = join(dir, 'cancel.wav');
    r.start(b);
    r.append(stereo(MEETING_RATE * 3, 0.1, 0.1));
    r.cancel();
    expect(existsSync(b)).toBe(false);
    expect(r.recording).toBe(false);
    expect(() => { r.start(a); r.start(b); }).toThrow(/already/);
    r.cancel();
  });

  it('repairs a WAV left with stale sizes by a crash', () => {
    const p = join(dir, 'crash.wav');
    const body = Buffer.alloc(16000 * 4 + 3); // a torn last frame
    writeFileSync(p, Buffer.concat([wavHeader(0), body]));
    writeFileSync(join(dir, 'note.txt'), 'x');
    expect(repairUnfinished(dir)).toEqual([p]);
    const c = channels(p);
    expect(c.data).toBe(16000 * 4);
    expect(repairWav(p)).toBe(false); // already right
    expect(repairUnfinished(join(dir, 'missing'))).toEqual([]);
    expect(readWav(readFileSync(p)).samples.length).toBe(16000);
  });
});

describe('system audio source', () => {
  it('per OS: Windows and Linux loopback, macOS not yet', () => {
    expect(systemAudioMode('win32')).toBe('loopback');
    expect(systemAudioMode('linux')).toBe('loopback');
    expect(systemAudioMode('darwin')).toBe('none');
  });
});

describe('MeetingController', () => {
  const make = (over: Partial<MeetingDeps> = {}) => {
    const s = { MeetingSystemAudio: true, MicrophoneId: 'mic-1', MeetingAutoDetect: false, MeetingAutoDetectApps: true, MeetingAutoDetectCalendar: '' };
    const calls = { enqueue: [] as string[], armed: [] as boolean[], saved: 0, changed: 0, log: [] as string[] };
    const d: MeetingDeps = {
      dir: () => dir,
      settings: () => s,
      save: () => calls.saved++,
      mode: () => 'loopback',
      armLoopback: (on) => calls.armed.push(on),
      enqueue: (p) => calls.enqueue.push(p),
      changed: () => calls.changed++,
      log: (l) => calls.log.push(l),
      isRussian: () => true,
      now: () => new Date(2026, 9, 13, 12, 45).getTime(),
      ...over,
    };
    return { c: new MeetingController(d), s, calls };
  };

  it('records mic + computer sound, then queues the file for transcription', async () => {
    const { c, calls } = make();
    const r = c.start();
    expect(r.ok).toBe(true);
    expect(r.micId).toBe('mic-1');
    expect(r.system).toEqual({ kind: 'loopback' });
    expect(r.state.recording).toBe(true);
    expect(r.state.capturing).toBe('mic+system');
    expect(c.start().ok).toBe(false); // one meeting at a time
    expect(calls.armed).toEqual([true]);
    c.systemOpened(true);
    c.pcm(stereo(MEETING_RATE * 2, 0.2, 0.3));
    const st = c.stop();
    expect(st.recording).toBe(false);
    const p = join(dir, 'Встреча 2026-10-13 12-45.wav');
    expect(calls.enqueue).toEqual([p]);
    expect(st.note).toBe(`Записано 00:00:02, файл добавлен в очередь расшифровки: ${p}`);
    expect(statSync(p).size).toBe(44 + MEETING_RATE * 2 * 4);
    expect(calls.armed.slice(1).every((a) => a === false)).toBe(true);
  });

  it('arms loopback for the one display-media request and disarms after a refusal', async () => {
    const { c, calls } = make();
    const r = c.start();
    expect(r.system).toEqual({ kind: 'loopback' });
    expect(calls.armed).toEqual([true]);
    const st = c.systemOpened(false, 'NotAllowedError');
    expect(calls.armed).toEqual([true, false]);
    expect(st.capturing).toBe('mic');
    expect(st.note).toMatch(/Звук компьютера не открылся \(NotAllowedError\) — пишу только микрофон/);
    c.cancel();
  });

  it('mic only when the setting is off or the OS has no capture yet', async () => {
    const off = make();
    off.s.MeetingSystemAudio = false;
    let r = off.c.start();
    expect(r.system).toEqual({ kind: 'none' });
    expect(r.state.capturing).toBe('mic');
    expect(r.state.note).toBe('');
    off.c.cancel();

    const mac = make({ mode: () => 'none' });
    r = mac.c.start();
    expect(r.state.systemSupported).toBe(false);
    expect(r.state.note).toMatch(/на этой системе пока не записывается/);
    mac.c.cancel();
  });

  it('cancel deletes, a failed mic drops the file, a mis-click is not queued', async () => {
    const { c, calls } = make();
    c.start();
    c.pcm(stereo(MEETING_RATE * 3, 0.1, 0.1));
    expect(c.cancel().note).toBe('Запись отменена и удалена.');
    c.start();
    expect(c.failed('NotAllowedError').note).toBe('Микрофон не открылся: NotAllowedError');
    c.start();
    c.pcm(stereo(4000, 0.1, 0.1));
    expect(c.stop().note).toBe('Запись короче секунды — не сохранена.');
    expect(calls.enqueue).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('saves the switch only on a real change; quit keeps what was recorded', async () => {
    const { c, s, calls } = make();
    c.setSystem(true);
    expect(calls.saved).toBe(0);
    expect(c.setSystem(false).systemOn).toBe(false);
    expect(s.MeetingSystemAudio).toBe(false);
    expect(calls.saved).toBe(1);
    c.start();
    c.pcm(stereo(MEETING_RATE * 2, 0.1, 0.1));
    c.dispose();
    expect(c.state().recording).toBe(false);
    expect(readdirSync(dir)).toEqual(['Встреча 2026-10-13 12-45.wav']);
    expect(calls.enqueue).toEqual([]);
  });

  it('repairs leftovers once when a meeting starts; a bad folder is reported', async () => {
    writeFileSync(join(dir, 'old.wav'), Buffer.concat([wavHeader(0), Buffer.alloc(400)]));
    const { c, calls } = make();
    c.start();
    c.cancel();
    expect(calls.log.some((l) => l.includes('repaired header'))).toBe(true);
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    const bad = make({ dir: () => join(blocker, 'sub') });
    const r = bad.c.start();
    expect(r.ok).toBe(false);
    expect(r.state.note).toMatch(/Не удалось создать файл записи/);
  });

  it('English UI lines', async () => {
    applyLanguage('English');
    const { c } = make({ mode: () => 'none' });
    const r = c.start();
    expect(r.state.note).toBe('Computer sound cannot be recorded on this OS yet — recording the microphone only.');
    c.pcm(stereo(MEETING_RATE, 0.1, 0.1));
    expect(c.stop().note).toMatch(/^Recorded 00:00:01, the file is queued for transcription: .*Meeting 2026-10-13 12-45\.wav$/);
  });
});

describe('settings', () => {
  it('MeetingSystemAudio defaults on and survives junk', () => {
    expect(Settings.defaults().MeetingSystemAudio).toBe(true);
  });
  it('MeetingAutoDetect defaults off; apps on; calendar empty', () => {
    const d = Settings.defaults();
    expect(d.MeetingAutoDetect).toBe(false);
    expect(d.MeetingAutoDetectApps).toBe(true);
    expect(d.MeetingAutoDetectCalendar).toBe('');
    d.MeetingAutoDetect = true;
    d.MeetingAutoDetectCalendar = 'C:\\cal.ics';
    const obj = Settings.toJsonObject(d);
    expect(obj).toMatchObject({ MeetingAutoDetect: true, MeetingAutoDetectApps: true, MeetingAutoDetectCalendar: 'C:\\cal.ics' });
    expect(Settings.fromJsonObject(obj).settings.MeetingAutoDetect).toBe(true);
    expect(Settings.fromJsonObject({}).settings.MeetingAutoDetect).toBe(false);
  });
});

describe('meeting worklet', () => {
  type Proc = { process(i: Float32Array[][]): boolean; port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void } };
  const load = async (rate: number) => {
    const posted: unknown[] = [];
    let Ctor: (new () => Proc) | null = null;
    vi.stubGlobal('sampleRate', rate);
    vi.stubGlobal('AudioWorkletProcessor', class {
      port = { onmessage: null as unknown, postMessage: (m: unknown) => posted.push(m) };
    });
    vi.stubGlobal('registerProcessor', (_n: string, c: new () => Proc) => (Ctor = c));
    const src = readFileSync(join(__dirname, '../../../apps/desktop/src/renderer/public/meeting-processor.js'), 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the worklet file as AudioWorkletGlobalScope would
    new Function(src)();
    const p = new Ctor!();
    vi.unstubAllGlobals();
    return { p, posted };
  };
  const q = (v: number, n = 128) => new Float32Array(n).fill(v);

  it('interleaves mic and computer at 16 kHz in 250 ms chunks', async () => {
    const { p, posted } = await load(16000);
    for (let k = 0; k < 32; k++) p.process([[q(0.5), q(0.1)], [q(-0.25)]]);
    // 32 × 128 = 4096 frames → one 4000-frame chunk, 96 pending
    expect(posted).toHaveLength(1);
    const c = posted[0] as Float32Array;
    expect(c.length).toBe(8000);
    expect(c[0]).toBeCloseTo(0.3, 5); // stereo mic averaged
    expect(c[1]).toBeCloseTo(-0.25, 5);
    p.port.onmessage!({ data: 'flush' });
    expect((posted[1] as Float32Array).length).toBe(192);
    expect(posted[2]).toBe('flushed');
  });

  it('writes silence for an unconnected computer input and decimates 48 kHz', async () => {
    const { p, posted } = await load(48000);
    for (let k = 0; k < 375; k++) p.process([[q(0.2)], []]);
    // 48 000 input frames → 16 000 output frames → four chunks
    expect(posted).toHaveLength(4);
    const c = posted[0] as Float32Array;
    expect(c[0]).toBeCloseTo(0.2, 5);
    expect(c[1]).toBe(0);
    expect(p.process([[], []])).toBe(true);
  });
});
