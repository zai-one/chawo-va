// «Запись встречи» on the «Расшифровка файла» page: the microphone plus the computer sound go into
// one stereo WAV in the meetings folder; «Остановить и расшифровать» puts that file into the usual
// file queue (same model, timestamps, .srt, Brain and parallel long-file mode) and the .txt lands
// next to it. No Electron here, so the flow is unit-tested; meetingIpc.ts wires it up.

import { MeetingRecorder, meetingPath, repairUnfinished } from './meetingRecorder';
import type { InputDevice, SystemAudioMode } from './systemAudio';
import { pickMonitor } from './systemAudio';
import { t } from '../../core/strings';

export interface MeetingStateDto {
  recording: boolean;
  /** Epoch ms of the start (the page ticks its own clock). */
  startedAt: number;
  seconds: number;
  /** The setting «Со звуком компьютера». */
  systemOn: boolean;
  /** False on an OS where the computer sound cannot be recorded yet: the checkbox is hidden. */
  systemSupported: boolean;
  /** What the current/last recording actually captures. */
  capturing: 'mic+system' | 'mic' | null;
  folder: string;
  /** One line under the button: what happened last, or why the computer sound is missing. */
  note: string;
  ru: boolean;
}

export type SystemPlan = { kind: 'loopback' } | { kind: 'device'; deviceId: string; label: string } | { kind: 'none' };

export interface StartResult {
  ok: boolean;
  micId: string;
  system: SystemPlan;
  state: MeetingStateDto;
}

export interface MeetingDeps {
  dir: () => string;
  settings: () => { MeetingSystemAudio: boolean; MicrophoneId: string };
  save: () => void;
  mode: () => SystemAudioMode;
  /** Linux: Chromium label of the default output's monitor ('' = unknown). */
  monitorLabel: () => Promise<string>;
  /** Windows: allow the next getDisplayMedia to be answered with loopback audio. */
  armLoopback: (on: boolean) => void;
  /** Adds the finished file to the file queue and starts the run. */
  enqueue: (path: string) => void;
  changed: () => void;
  log: (line: string) => void;
  isRussian: () => boolean;
  now?: () => number;
}

const clock = (sec: number) => {
  const s = Math.round(sec);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

export class MeetingController {
  readonly recorder: MeetingRecorder;
  private note = '';
  private capturing: 'mic+system' | 'mic' | null = null;
  private repaired = false;

  constructor(private readonly d: MeetingDeps) {
    this.recorder = new MeetingRecorder(d.now ?? Date.now);
  }

  state(): MeetingStateDto {
    const s = this.d.settings();
    return {
      recording: this.recorder.recording,
      startedAt: this.recorder.recording ? this.recorder.startedAt : 0,
      seconds: this.recorder.recording ? this.recorder.seconds : 0,
      systemOn: s.MeetingSystemAudio,
      systemSupported: this.d.mode() !== 'none',
      capturing: this.capturing,
      folder: this.d.dir(),
      note: this.note,
      ru: this.d.isRussian(),
    };
  }

  /** Opens the file and tells the page which streams to open. `devices` = the page's audio inputs. */
  async start(devices: readonly InputDevice[]): Promise<StartResult> {
    const s = this.d.settings();
    if (this.recorder.recording) return { ok: false, micId: s.MicrophoneId, system: { kind: 'none' }, state: this.state() };
    const dir = this.d.dir();
    if (!this.repaired) {
      this.repaired = true;
      try {
        for (const p of repairUnfinished(dir)) this.d.log(`meeting: repaired header of ${p}`);
      } catch {
        /* folder unreadable: start() reports it below */
      }
    }
    let system: SystemPlan = { kind: 'none' };
    this.note = '';
    if (s.MeetingSystemAudio) {
      const mode = this.d.mode();
      if (mode === 'loopback') system = { kind: 'loopback' };
      else if (mode === 'monitor') {
        const m = pickMonitor(devices, await this.d.monitorLabel());
        if (m) system = { kind: 'device', deviceId: m.deviceId, label: m.label };
        else this.note = t('Не нашёл звук компьютера (монитор PulseAudio/PipeWire) — пишу только микрофон.', 'Computer sound not found (no PulseAudio/PipeWire monitor) — recording the microphone only.');
      } else this.note = t('Звук компьютера на этой системе пока не записывается — пишу только микрофон.', 'Computer sound cannot be recorded on this OS yet — recording the microphone only.');
    }
    const word = t('Встреча', 'Meeting');
    let path: string;
    try {
      path = meetingPath(dir, new Date((this.d.now ?? Date.now)()), word);
      this.recorder.start(path);
    } catch (e) {
      this.note = t(`Не удалось создать файл записи: ${(e as Error).message}`, `Could not create the recording file: ${(e as Error).message}`);
      this.d.changed();
      return { ok: false, micId: s.MicrophoneId, system: { kind: 'none' }, state: this.state() };
    }
    this.capturing = system.kind === 'none' ? 'mic' : 'mic+system';
    if (system.kind === 'loopback') this.d.armLoopback(true);
    this.d.log(`meeting: start ${path} (${system.kind === 'device' ? `monitor «${system.label}»` : system.kind})`);
    this.d.changed();
    return { ok: true, micId: s.MicrophoneId, system, state: this.state() };
  }

  /** The page opened (or failed to open) the computer sound. */
  systemOpened(ok: boolean, reason = ''): MeetingStateDto {
    this.d.armLoopback(false);
    if (!ok && this.recorder.recording) {
      this.capturing = 'mic';
      this.note = t(`Звук компьютера не открылся${reason ? ` (${reason})` : ''} — пишу только микрофон.`, `Computer sound did not open${reason ? ` (${reason})` : ''} — recording the microphone only.`);
      this.d.log(`meeting: system audio failed: ${reason}`);
      this.d.changed();
    }
    return this.state();
  }

  pcm(frames: Float32Array): void {
    this.recorder.append(frames);
  }

  /** «Остановить и расшифровать». */
  stop(): MeetingStateDto {
    this.d.armLoopback(false);
    if (!this.recorder.recording) return this.state();
    const r = this.recorder.stop();
    if (!r) {
      this.note = t('Запись короче секунды — не сохранена.', 'The recording was under a second — not saved.');
    } else {
      this.note = t(`Записано ${clock(r.seconds)}, расшифровываю: ${r.path}`, `Recorded ${clock(r.seconds)}, transcribing: ${r.path}`);
      this.d.log(`meeting: stop ${r.path} ${r.seconds.toFixed(1)} s`);
      this.d.enqueue(r.path);
    }
    this.d.changed();
    return this.state();
  }

  /** «Отменить»: the file is deleted, nothing is transcribed. */
  cancel(): MeetingStateDto {
    this.d.armLoopback(false);
    if (this.recorder.recording) {
      this.recorder.cancel();
      this.note = t('Запись отменена и удалена.', 'Recording cancelled and deleted.');
      this.d.log('meeting: cancelled');
      this.d.changed();
    }
    return this.state();
  }

  /** The microphone could not be opened: drop the empty file. */
  failed(reason: string): MeetingStateDto {
    this.d.armLoopback(false);
    if (this.recorder.recording) this.recorder.cancel();
    this.capturing = null;
    this.note = t(`Микрофон не открылся: ${reason}`, `The microphone did not open: ${reason}`);
    this.d.log(`meeting: mic failed: ${reason}`);
    this.d.changed();
    return this.state();
  }

  setSystem(on: boolean): MeetingStateDto {
    const s = this.d.settings();
    if (s.MeetingSystemAudio !== on) {
      s.MeetingSystemAudio = on;
      this.d.save();
    }
    return this.state();
  }

  /** App quit while recording: keep what was recorded (the header is final), transcribe next time by hand. */
  dispose(): void {
    if (this.recorder.recording) {
      const r = this.recorder.stop();
      if (r) this.d.log(`meeting: saved on quit ${r.path} ${r.seconds.toFixed(1)} s`);
    }
  }
}
