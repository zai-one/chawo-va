// Async job queue for `chawo-va serve`: upload → id → poll → text. Artifacts live under dataDir
// and are deleted after TTL (default 2 h). A small worker pool runs 1–N long files in parallel
// (CPU only; workers capped from FileParallel / cores / RAM, max 5 for the 1–5 users target).

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, freemem, tmpdir } from 'node:os';
import { resolvePlan, type FileParallelismKind } from '../../core/fileParallel';
import type { SpeechModelKind } from '../../core/speechModels';
import { DEFAULT_TTL_MS } from './serveAuth';

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  /** Original upload name, if any. */
  filename: string | null;
  /** Bytes of the stored audio. */
  bytes: number;
  /** Result text when done. */
  text: string | null;
  /** Relative path of result.txt under the job dir (when done). */
  resultPath: string | null;
  error: string | null;
  /** Audio seconds when known. */
  seconds: number | null;
  model: string | null;
  device: string | null;
}

export type JobTranscribe = (audioPath: string, signal: AbortSignal) => Promise<{
  text: string;
  seconds: number;
  model: string;
  device: string;
}>;

export interface ServeJobsOptions {
  dataDir: string;
  ttlMs?: number;
  /** Max concurrent workers (clamped 1–5). */
  workers?: number;
  /** File parallelism kind used only to pick a default worker count when workers is omitted. */
  threads?: FileParallelismKind;
  modelKind?: SpeechModelKind;
  now?: () => number;
  log?: (line: string) => void;
  /** How often the sweeper runs (ms). */
  sweepEveryMs?: number;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.CHAWO_SERVE_DATA_DIR ?? '').trim();
  if (fromEnv) return fromEnv;
  const xdg = (env.XDG_DATA_HOME ?? '').trim();
  if (xdg) return join(xdg, 'chawo-serve');
  // Prefer a sticky local share path; fall back to /tmp/chawo-serve for headless boxes.
  try {
    const home = env.HOME || '';
    if (home) return join(home, '.local', 'share', 'chawo-serve');
  } catch {
    /* ignore */
  }
  return join(tmpdir(), 'chawo-serve');
}

/** Cap workers for the 1–5 users / several long files target. */
export function defaultWorkerCount(
  threads: FileParallelismKind = 'auto',
  model: SpeechModelKind = 'v3_e2e_rnnt',
  nCores = Math.max(1, cpus().length),
  availableBytes = freemem(),
): number {
  const plan = resolvePlan(threads, false, false, model, nCores, availableBytes);
  return Math.min(5, Math.max(1, plan.workers));
}

function newId(): string {
  return createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 24);
}

export class ServeJobStore {
  readonly dataDir: string;
  readonly ttlMs: number;
  readonly workers: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly transcribe: JobTranscribe;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private running = 0;
  private closed = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly aborts = new Map<string, AbortController>();

  constructor(transcribe: JobTranscribe, opts: ServeJobsOptions) {
    this.transcribe = transcribe;
    this.dataDir = opts.dataDir;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.workers = Math.min(5, Math.max(1, opts.workers ?? defaultWorkerCount(opts.threads ?? 'auto', opts.modelKind ?? 'v3_e2e_rnnt')));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    mkdirSync(join(this.dataDir, 'jobs'), { recursive: true });
    this.loadFromDisk();
    const every = opts.sweepEveryMs ?? 60_000;
    this.sweepTimer = setInterval(() => this.sweep(), every);
    this.sweepTimer.unref?.();
    this.kick();
  }

  get size(): number {
    return this.jobs.size;
  }

  get queued(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.running;
  }

  create(audio: Uint8Array, filename: string | null): JobRecord {
    if (this.closed) throw new Error('job store closed');
    if (audio.length === 0) throw new Error('empty_body');
    const id = newId();
    const t = this.now();
    const dir = this.jobDir(id);
    mkdirSync(dir, { recursive: true });
    const audioName = safeName(filename) || 'audio.bin';
    writeFileSync(join(dir, audioName), audio);
    const rec: JobRecord = {
      id,
      status: 'queued',
      createdAt: t,
      updatedAt: t,
      filename: filename,
      bytes: audio.length,
      text: null,
      resultPath: null,
      error: null,
      seconds: null,
      model: null,
      device: null,
    };
    this.writeMeta(rec, audioName);
    this.jobs.set(id, rec);
    this.queue.push(id);
    this.log(`serve job ${id} queued bytes=${audio.length}`);
    const snapshot = { ...rec };
    this.kick();
    return snapshot;
  }

  get(id: string): JobRecord | null {
    const rec = this.jobs.get(id);
    return rec ? { ...rec } : null;
  }

  /** JSON shape for GET /v1/jobs/:id. */
  toPublic(rec: JobRecord): Record<string, unknown> {
    return {
      id: rec.id,
      status: rec.status,
      created_at: new Date(rec.createdAt).toISOString(),
      updated_at: new Date(rec.updatedAt).toISOString(),
      filename: rec.filename,
      bytes: rec.bytes,
      text: rec.text,
      result_path: rec.resultPath,
      error: rec.error,
      seconds: rec.seconds,
      model: rec.model,
      device: rec.device,
      ttl_ms: this.ttlMs,
    };
  }

  delete(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec) return false;
    const abort = this.aborts.get(id);
    if (abort) abort.abort();
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    this.jobs.delete(id);
    this.aborts.delete(id);
    try {
      rmSync(this.jobDir(id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    this.log(`serve job ${id} deleted`);
    return true;
  }

  /** Drop jobs older than TTL (by createdAt). */
  sweep(now = this.now()): number {
    let n = 0;
    for (const [id, rec] of [...this.jobs.entries()]) {
      if (now - rec.createdAt >= this.ttlMs) {
        this.delete(id);
        n++;
      }
    }
    if (n > 0) this.log(`serve sweep removed ${n} job(s)`);
    return n;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const a of this.aborts.values()) a.abort();
    this.aborts.clear();
    this.queue.length = 0;
  }

  private kick(): void {
    while (!this.closed && this.running < this.workers && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const rec = this.jobs.get(id);
      if (!rec || rec.status !== 'queued') continue;
      this.running++;
      void this.runOne(id).finally(() => {
        this.running--;
        this.kick();
      });
    }
  }

  private async runOne(id: string): Promise<void> {
    const rec = this.jobs.get(id);
    if (!rec) return;
    const ac = new AbortController();
    this.aborts.set(id, ac);
    rec.status = 'running';
    rec.updatedAt = this.now();
    this.writeMeta(rec);
    const audioPath = this.audioPath(id);
    try {
      if (!audioPath) throw new Error('audio missing');
      const result = await this.transcribe(audioPath, ac.signal);
      if (ac.signal.aborted || !this.jobs.has(id)) return;
      const resultRel = 'result.txt';
      writeFileSync(join(this.jobDir(id), resultRel), result.text, 'utf8');
      rec.status = 'done';
      rec.text = result.text;
      rec.resultPath = resultRel;
      rec.seconds = result.seconds;
      rec.model = result.model;
      rec.device = result.device;
      rec.error = null;
      rec.updatedAt = this.now();
      this.writeMeta(rec);
      this.log(`serve job ${id} done chars=${result.text.length} ${result.seconds.toFixed(1)}s`);
    } catch (e) {
      if (ac.signal.aborted || !this.jobs.has(id)) return;
      const msg = e instanceof Error ? e.message : String(e);
      rec.status = 'error';
      rec.error = msg;
      rec.updatedAt = this.now();
      this.writeMeta(rec);
      this.log(`serve job ${id} error: ${msg}`);
    } finally {
      this.aborts.delete(id);
    }
  }

  private jobDir(id: string): string {
    return join(this.dataDir, 'jobs', id);
  }

  private audioPath(id: string): string | null {
    const dir = this.jobDir(id);
    if (!existsSync(dir)) return null;
    const meta = this.readMetaRaw(id);
    if (meta?.audio && existsSync(join(dir, meta.audio))) return join(dir, meta.audio);
    for (const name of readdirSync(dir)) {
      if (name === 'meta.json' || name === 'result.txt') continue;
      return join(dir, name);
    }
    return null;
  }

  private writeMeta(rec: JobRecord, audioName?: string): void {
    const prev = this.readMetaRaw(rec.id);
    const payload = {
      ...rec,
      audio: audioName ?? prev?.audio ?? null,
    };
    writeFileSync(join(this.jobDir(rec.id), 'meta.json'), JSON.stringify(payload), 'utf8');
  }

  private readMetaRaw(id: string): (JobRecord & { audio?: string | null }) | null {
    try {
      return JSON.parse(readFileSync(join(this.jobDir(id), 'meta.json'), 'utf8')) as JobRecord & { audio?: string | null };
    } catch {
      return null;
    }
  }

  private loadFromDisk(): void {
    const root = join(this.dataDir, 'jobs');
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      const meta = this.readMetaRaw(name);
      if (!meta || !meta.id) continue;
      // Re-queue unfinished work after a restart; drop expired.
      if (this.now() - meta.createdAt >= this.ttlMs) {
        try {
          rmSync(this.jobDir(name), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      if (meta.status === 'running') meta.status = 'queued';
      this.jobs.set(meta.id, {
        id: meta.id,
        status: meta.status === 'done' || meta.status === 'error' ? meta.status : 'queued',
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        filename: meta.filename,
        bytes: meta.bytes,
        text: meta.text,
        resultPath: meta.resultPath,
        error: meta.error,
        seconds: meta.seconds,
        model: meta.model,
        device: meta.device,
      });
      if (meta.status !== 'done' && meta.status !== 'error') this.queue.push(meta.id);
    }
  }
}

function safeName(name: string | null | undefined): string {
  if (!name) return '';
  const base = name.replace(/[/\\]/g, '').replace(/\0/g, '').slice(0, 180);
  return base;
}

/** True when path looks like an existing directory we can use (or create). */
export function ensureDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`data-dir is not a directory: ${dir}`);
  return dir;
}
