// Headless HTTP server for `chawo-va serve`: Hermes-compatible health/transcribe plus an async
// job API for long files. Reuses extractAudio / isLoopback from HermesServer; auth + bind rules
// live in serveAuth; the job queue in serveJobs. CPU only — the caller injects transcription.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { MAX_BYTES } from '../file/fileTranscript';
import * as Log from '../log';
import { authorize } from './serveAuth';
import { extractAudio, isLoopback, type HermesResult, type HermesTranscribe } from './hermesServer';
import { ServeJobStore, type JobTranscribe } from './serveJobs';

export interface ServeServerOptions {
  host: string;
  port: number;
  /** Required for non-loopback binds; loopback peers may skip the bearer. */
  token: string | null;
  dataDir: string;
  /** Sync Hermes POST /v1/transcribe (short takes). Empty audio = health probe. */
  transcribe: HermesTranscribe;
  /** Async job worker (long files; full decode chain including ffmpeg when available). */
  jobTranscribe: JobTranscribe;
  ttlMs?: number;
  workers?: number;
  threads?: import('@chawo/core/fileParallel').FileParallelismKind;
  modelKind?: import('@chawo/core/speechModels').SpeechModelKind;
  /** Tests: pretend the peer has this address. */
  remoteAddress?: (socket: Socket) => string | undefined;
  now?: () => number;
  sweepEveryMs?: number;
  log?: (line: string) => void;
}

class BadRequest extends Error {}

const REASON: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

function write(res: ServerResponse, code: number, payload: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, REASON[code] ?? 'Error', {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': json.length,
    Connection: 'close',
  });
  res.end(json);
}

function readBody(req: IncomingMessage, length: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (length === 0) {
      req.resume();
      req.once('end', () => resolve(new Uint8Array(0)));
      req.once('error', reject);
      return;
    }
    const out = Buffer.allocUnsafe(length);
    let got = 0;
    req.on('data', (chunk: Buffer) => {
      if (got + chunk.length > length) {
        reject(new BadRequest('body longer than Content-Length'));
        req.destroy();
        return;
      }
      chunk.copy(out, got);
      got += chunk.length;
    });
    req.once('end', () => (got === length ? resolve(out) : reject(new BadRequest('unexpected end of request body'))));
    req.once('aborted', () => reject(new BadRequest('unexpected end of request body')));
    req.once('error', reject);
  });
}

function contentFilename(contentType: string, contentDisposition: string | undefined): string | null {
  if (contentDisposition) {
    const m = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(contentDisposition);
    if (m) return decodeURIComponent(m[1]!.replace(/"/g, '').trim());
  }
  if (contentType.toLowerCase().includes('audio/wav') || contentType.toLowerCase().includes('audio/wave')) return 'audio.wav';
  if (contentType.toLowerCase().includes('ogg') || contentType.toLowerCase().includes('opus')) return 'audio.ogg';
  return null;
}

export class ServeServer {
  readonly host: string;
  readonly token: string | null;
  readonly jobs: ServeJobStore;
  private readonly server: Server;
  private readonly requested: number;
  private readonly transcribe: HermesTranscribe;
  private readonly opts: ServeServerOptions;
  private started = false;
  private closed = false;

  constructor(opts: ServeServerOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.token = opts.token;
    this.requested = opts.port;
    this.transcribe = opts.transcribe;
    const log = opts.log ?? ((line: string) => Log.write(line));
    this.jobs = new ServeJobStore(opts.jobTranscribe, {
      dataDir: opts.dataDir,
      ttlMs: opts.ttlMs,
      workers: opts.workers,
      threads: opts.threads,
      modelKind: opts.modelKind,
      now: opts.now,
      sweepEveryMs: opts.sweepEveryMs,
      log,
    });
    this.server = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => void this.handle(req, res));
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 1_000;
    this.server.on('connection', (socket) => socket.setKeepAlive(true));
  }

  get port(): number {
    const a = this.server.address() as AddressInfo | null;
    return a && typeof a === 'object' ? a.port : this.requested;
  }

  get listening(): boolean {
    return this.server.listening;
  }

  get bindAddress(): string {
    return this.host;
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => {
        this.server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        this.server.off('error', onError);
        this.server.on('error', (e) => Log.write(`serve: ${e.message}`));
        Log.write(`serve listening on ${this.host}:${this.port} token=${this.token ? 'yes' : 'no'} data=${this.opts.dataDir}`);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.requested, this.host);
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.jobs.dispose();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  stop(): Promise<void> {
    return this.dispose();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const remote = this.opts.remoteAddress?.(req.socket) ?? req.socket.remoteAddress;
      // Without a token the process only binds loopback; still reject non-loopback peers.
      if (!this.token && !isLoopback(remote)) {
        req.resume();
        write(res, 403, { error: 'localhost_only' });
        return;
      }
      const auth = authorize(req.headers.authorization, this.token, remote);
      if (!auth.ok) {
        req.resume();
        write(res, auth.status, { error: auth.error });
        return;
      }

      const method = req.method ?? '';
      let path = req.url ?? '/';
      const q = path.indexOf('?');
      if (q >= 0) path = path.slice(0, q);

      const lenText = req.headers['content-length'];
      let length = 0;
      if (lenText !== undefined) {
        length = /^\d+$/.test(lenText.trim()) ? Number(lenText.trim()) : -1;
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES) {
          throw new BadRequest('content-length is missing or too large');
        }
      } else if (method === 'POST') {
        throw new BadRequest('POST needs Content-Length');
      }

      if (method === 'GET' && (path === '/v1/health' || path === '/health')) {
        req.resume();
        const status = await this.transcribe(new Uint8Array(0));
        write(res, 200, {
          ok: true,
          model_loaded: status.modelLoaded,
          model: status.model,
          device: status.device,
          provider: status.provider,
          port: this.port,
          listen: this.host,
          jobs: { workers: this.jobs.workers, queued: this.jobs.queued, active: this.jobs.active },
        });
        return;
      }

      // Job API
      if (method === 'POST' && (path === '/v1/jobs' || path === '/jobs')) {
        const body = await readBody(req, length);
        const ct = String(req.headers['content-type'] ?? '');
        const audio = extractAudio(ct, body);
        if (audio.length === 0) {
          write(res, 400, { error: 'empty_body' });
          return;
        }
        const filename = contentFilename(ct, req.headers['content-disposition']);
        const rec = this.jobs.create(audio, filename);
        write(res, 201, this.jobs.toPublic(rec));
        return;
      }

      const jobMatch = /^\/(?:v1\/)?jobs\/([A-Za-z0-9_-]+)$/.exec(path);
      if (jobMatch) {
        const id = jobMatch[1]!;
        if (method === 'GET') {
          req.resume();
          const rec = this.jobs.get(id);
          if (!rec) {
            write(res, 404, { error: 'not_found' });
            return;
          }
          write(res, 200, this.jobs.toPublic(rec));
          return;
        }
        if (method === 'DELETE') {
          req.resume();
          if (!this.jobs.delete(id)) {
            write(res, 404, { error: 'not_found' });
            return;
          }
          write(res, 200, { ok: true, id });
          return;
        }
      }

      // Hermes sync transcribe
      const body = await readBody(req, length);
      if (method !== 'POST' || (path !== '/v1/transcribe' && path !== '/transcribe')) {
        write(res, 404, { error: 'not_found' });
        return;
      }
      const audio = extractAudio(String(req.headers['content-type'] ?? ''), body);
      if (audio.length === 0) {
        write(res, 400, { error: 'empty_body' });
        return;
      }
      const result: HermesResult = await this.transcribe(audio);
      if (!result.modelLoaded) {
        write(res, 503, { error: 'model_not_loaded' });
        return;
      }
      if (result.error != null) {
        write(res, 400, { error: 'bad_audio', detail: result.error });
        return;
      }
      write(res, 200, {
        text: result.text,
        model: result.model,
        device: result.device,
        provider: result.provider,
        sample_rate: 16000,
        seconds: Math.round(result.seconds * 1000) / 1000,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Log.write(`serve request failed: ${e instanceof Error ? e.name : 'Error'}: ${msg}`);
      try {
        write(res, 400, { error: 'bad_request', detail: msg });
      } catch {
        /* peer gone */
      }
    }
  }
}
