// Decoder for Hermes. Starts on 127.0.0.1. After the user opens the port it can bind 0.0.0.0 so
// other machines on the LAN can POST audio. The audio is decoded here. This process does not upload
// it. Port of src/App/HermesServer.cs on Node's http module (main process only, no framework):
//   GET  /v1/health | /health        → {ok, model_loaded, model, device, provider, port, listen}
//   POST /v1/transcribe | /transcribe → raw WAV/Ogg body or the first part of multipart/form-data
// POST needs Content-Length (no chunked uploads) and at most FileTranscript.MaxBytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { MAX_BYTES } from '../file/fileTranscript';
import * as Log from '../log';

/** C# record HermesResult(ModelLoaded, Text, Model, Device, Provider, Seconds, Error). */
export interface HermesResult {
  modelLoaded: boolean;
  text: string | null;
  model: string;
  device: string;
  provider: string;
  seconds: number;
  error: string | null;
}

/** Empty audio is the health probe: answer with the model state, recognize nothing. */
export type HermesTranscribe = (audio: Uint8Array) => Promise<HermesResult> | HermesResult;

export interface HermesServerOptions {
  /** Tests: pretend the peer has this address (the 403 path without a second machine). */
  remoteAddress?: (socket: Socket) => string | undefined;
}

class BadRequest extends Error {}

/** 127.0.0.0/8, ::1 and the IPv4-mapped forms. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  let a = address.trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function boundary(contentType: string): string {
  for (const part of contentType.split(';')) {
    const p = part.trim();
    if (p.toLowerCase().startsWith('boundary=')) return p.slice('boundary='.length).trim().replace(/^"+|"+$/g, '');
  }
  return '';
}

/** Body of the first part (HermesServer.FirstFilePart), byte for byte the same rules. */
export function firstFilePart(body: Uint8Array, b: string): Uint8Array {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const sep = Buffer.from('--' + b, 'ascii');
  let start = buf.indexOf(sep, 0);
  if (start < 0) throw new BadRequest('multipart boundary not found');
  start += sep.length;
  if (start + 1 < buf.length && buf[start] === 0x0d) start += 2;
  let next = buf.indexOf(sep, start);
  if (next < 0) next = buf.length;
  const part = buf.subarray(start, next);
  const headerEnd = part.indexOf('\r\n\r\n', 0, 'ascii');
  if (headerEnd < 0) throw new BadRequest('multipart part has no header');
  const data = headerEnd + 4;
  let len = part.length - data;
  if (len >= 2 && part[len + data - 2] === 0x0d) len -= 2;
  if (data + len > part.length || len < 0) len = Math.max(0, part.length - data);
  return new Uint8Array(part.subarray(data, data + len));
}

export function extractAudio(contentType: string, body: Uint8Array): Uint8Array {
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    const b = boundary(contentType);
    if (b.length === 0) throw new BadRequest('multipart without a boundary');
    return firstFilePart(body, b);
  }
  return body;
}

const REASON: Record<number, string> = { 200: 'OK', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' };

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

/** Reads exactly Content-Length bytes into one buffer (a two-hour WAV is ~230 MB at 16 kHz). */
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

export class HermesServer {
  readonly listenOnLan: boolean;
  private readonly server: Server;
  private readonly requested: number;
  private started = false;
  private closed = false;

  constructor(
    port: number,
    private readonly transcribe: HermesTranscribe,
    listenOnLan = false,
    private readonly opts: HermesServerOptions = {},
  ) {
    this.requested = port;
    this.listenOnLan = listenOnLan;
    this.server = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => void this.handle(req, res));
    // A two-hour file is read, then the model runs for a long time before the answer is written.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 1_000;
    this.server.on('connection', (socket) => socket.setKeepAlive(true));
  }

  get bindAddress(): string {
    return this.listenOnLan ? '0.0.0.0' : '127.0.0.1';
  }

  /** The bound port (the requested one, or the OS pick for port 0 in tests). */
  get port(): number {
    const a = this.server.address() as AddressInfo | null;
    return a && typeof a === 'object' ? a.port : this.requested;
  }

  get listening(): boolean {
    return this.server.listening;
  }

  /** Binds; rejects when the port is taken or the address is not available. */
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
        this.server.on('error', (e) => Log.write(`hermes server: ${e.message}`));
        Log.write(`hermes listening on ${this.bindAddress}:${this.port}`);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.requested, this.bindAddress);
    });
  }

  /** Stops accepting and drops open connections (a long upload is cut, like WPF listener.Stop). */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
      if (!this.listenOnLan && !isLoopback(remote)) {
        req.resume();
        write(res, 403, { error: 'localhost_only' });
        return;
      }
      const method = req.method ?? '';
      let path = req.url ?? '/';
      const q = path.indexOf('?');
      if (q >= 0) path = path.slice(0, q);

      const lenText = req.headers['content-length'];
      let length = 0;
      if (lenText !== undefined) {
        // Long enough for about two hours of 44.1 kHz stereo 16-bit. Not a download.
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
          listen: this.bindAddress,
        });
        return;
      }
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
      const result = await this.transcribe(audio);
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
      Log.write(`hermes request failed: ${e instanceof Error ? e.name : 'Error'}: ${msg}`);
      try {
        write(res, 400, { error: 'bad_request', detail: msg });
      } catch {
        /* the peer is gone */
      }
    }
  }
}
