// Privileged chawo-media:// scheme so the sandboxed renderer can seek/play a known local audio file.
// The scheme is registered (before app.ready) with the app's own in appProtocol.ts; handle() after ready.
// Chromium only seeks when the response speaks HTTP Range (Accept-Ranges / 206) — net.fetch(file)
// alone is not enough for a custom scheme, so we serve bytes ourselves.

import { protocol } from 'electron';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { resolve, extname } from 'node:path';
import { decodeMediaUrl, encodeMediaUrl, MEDIA_SCHEME } from '@chawo/core/localMedia';

const allowed = new Set<string>();

const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.mp4': 'audio/mp4',
  '.wma': 'audio/x-ms-wma',
  '.mkv': 'video/x-matroska',
};

function key(p: string): string {
  return resolve(p);
}

/** Allow-list a queue audio path (or clear with empty). Only these are served. */
export function allowMediaPath(path: string | null | undefined): void {
  allowed.clear();
  const p = (path ?? '').trim();
  if (p) allowed.add(key(p));
}

export function isMediaAllowed(path: string): boolean {
  return allowed.has(key(path));
}

/** Build a URL only when the path is already allow-listed; otherwise null. */
export function mediaUrlFor(path: string | null | undefined): string | null {
  const p = (path ?? '').trim();
  if (!p || !isMediaAllowed(p)) return null;
  try {
    return encodeMediaUrl(resolve(p));
  } catch {
    return null;
  }
}

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return null;
  let start = m[1] ? Number(m[1]) : NaN;
  let end = m[2] ? Number(m[2]) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // suffix: bytes=-500 → last 500 bytes
    const n = end;
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) return null;
    if (Number.isNaN(end) || end >= size) end = size - 1;
    if (end < start) return null;
  }
  if (start >= size) return null;
  return { start, end };
}

/** After app.ready: serve allow-listed files with Range support for <audio> seek. */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const path = decodeMediaUrl(request.url);
    if (!path || !isMediaAllowed(path) || !existsSync(path)) {
      return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
    }
    let st;
    try {
      st = statSync(path);
    } catch {
      return new Response('Not Found', { status: 404 });
    }
    if (!st.isFile()) return new Response('Not Found', { status: 404 });
    const size = st.size;
    const type = mimeFor(path);
    const range = parseRange(request.headers.get('range'), size);
    const headers = new Headers({
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    if (!range) {
      headers.set('Content-Length', String(size));
      const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
      return new Response(stream, { status: 200, headers });
    }
    const { start, end } = range;
    const chunk = end - start + 1;
    headers.set('Content-Length', String(chunk));
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers });
  });
}
