// «Запись встречи»: streams the meeting to a 16 kHz 16-bit stereo WAV on disk while it lasts
// (left = microphone, right = computer sound), so an hour-long call never sits in RAM. The header
// sizes are patched every few seconds, so a crash or power loss still leaves a playable file;
// `repairUnfinished` fixes whatever was left unpatched since then. Local only: nothing is uploaded.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const MEETING_RATE = 16000;
export const MEETING_CHANNELS = 2;
const BYTES_PER_FRAME = 2 * MEETING_CHANNELS;
const HEADER = 44;
/** Shorter than this is a mis-click: the file is dropped instead of transcribed. */
export const MIN_SECONDS = 1;

/** 44-byte PCM header for `dataBytes` of 16-bit audio. */
export function wavHeader(dataBytes: number, rate = MEETING_RATE, channels = MEETING_CHANNELS): Buffer {
  const b = Buffer.alloc(HEADER);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** «Встреча 2026-10-13 12-45.wav»; a second meeting in the same minute gets « (2)». */
export function meetingPath(dir: string, now: Date, word: string): string {
  const stem = `${word} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  let p = join(dir, `${stem}.wav`);
  for (let k = 2; existsSync(p); k++) p = join(dir, `${stem} (${k}).wav`);
  return p;
}

export interface MeetingResult {
  path: string;
  seconds: number;
}

export class MeetingRecorder {
  private fd: number | null = null;
  private file = '';
  private bytes = 0;
  private lastPatch = 0;
  private started = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** Peak of the last chunk per channel, 0..1 (left = mic, right = computer). */
  levels: [number, number] = [0, 0];

  constructor(private readonly now: () => number = Date.now, private readonly patchEveryMs = 5000) {}

  get recording(): boolean {
    return this.fd !== null;
  }

  get path(): string {
    return this.file;
  }

  get seconds(): number {
    return this.bytes / BYTES_PER_FRAME / MEETING_RATE;
  }

  get startedAt(): number {
    return this.started;
  }

  start(path: string): void {
    if (this.fd !== null) throw new Error('already recording');
    mkdirSync(join(path, '..'), { recursive: true });
    this.fd = openSync(path, 'w');
    this.file = path;
    this.bytes = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.levels = [0, 0];
    this.started = this.now();
    this.lastPatch = this.started;
    writeSync(this.fd, wavHeader(0), 0, HEADER, 0);
  }

  /** Interleaved stereo float frames [mic, computer, mic, computer, …] at 16 kHz. */
  append(frames: Float32Array): void {
    if (this.fd === null || frames.length < 2) return;
    const n = frames.length - (frames.length % 2);
    const b = Buffer.alloc(n * 2);
    let pl = 0;
    let pr = 0;
    for (let k = 0; k < n; k++) {
      const x = frames[k];
      const c = x > 1 ? 1 : x < -1 ? -1 : Number.isFinite(x) ? x : 0;
      const a = c < 0 ? -c : c;
      if (k & 1) { if (a > pr) pr = a; } else if (a > pl) pl = a;
      b.writeInt16LE(Math.round(c * 32767), k * 2);
    }
    this.levels = [pl, pr];
    this.pending.push(b);
    this.pendingBytes += b.length;
    // ~0.5 s of audio per disk write keeps syscalls rare without holding much in memory.
    if (this.pendingBytes >= MEETING_RATE * BYTES_PER_FRAME / 2) this.flush();
    if (this.now() - this.lastPatch >= this.patchEveryMs) this.patch();
  }

  private flush(): void {
    if (this.fd === null || this.pendingBytes === 0) return;
    const all = Buffer.concat(this.pending, this.pendingBytes);
    writeSync(this.fd, all, 0, all.length, HEADER + this.bytes);
    this.bytes += all.length;
    this.pending = [];
    this.pendingBytes = 0;
  }

  private patch(): void {
    if (this.fd === null) return;
    this.flush();
    writeSync(this.fd, wavHeader(this.bytes), 0, HEADER, 0);
    this.lastPatch = this.now();
  }

  /** Closes the file. Too short → deleted and null. */
  stop(): MeetingResult | null {
    if (this.fd === null) return null;
    this.patch();
    closeSync(this.fd);
    this.fd = null;
    const seconds = this.seconds;
    if (seconds < MIN_SECONDS) {
      rmSync(this.file, { force: true });
      return null;
    }
    return { path: this.file, seconds };
  }

  /** Drops the recording and its file. */
  cancel(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
    rmSync(this.file, { force: true });
  }
}

/** A file left by a crash has stale header sizes: rewrite them from the real file length. */
export function repairWav(path: string): boolean {
  const fd = openSync(path, 'r+');
  try {
    const size = fstatSync(fd).size;
    if (size < HEADER) return false;
    const h = Buffer.alloc(HEADER);
    readSync(fd, h, 0, HEADER, 0);
    if (h.toString('ascii', 0, 4) !== 'RIFF' || h.toString('ascii', 36, 40) !== 'data') return false;
    const channels = h.readUInt16LE(22) || 1;
    const frame = 2 * channels;
    const data = Math.floor((size - HEADER) / frame) * frame;
    if (h.readUInt32LE(40) === data && h.readUInt32LE(4) === 36 + data) return false;
    writeSync(fd, wavHeader(data, h.readUInt32LE(24), channels), 0, HEADER, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Repairs every meeting WAV in `dir` (start-up, before the folder is used again). */
export function repairUnfinished(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const fixed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.wav')) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile() && repairWav(p)) fixed.push(p);
    } catch {
      /* unreadable: leave it */
    }
  }
  return fixed;
}
