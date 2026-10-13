// Minimal ZIP reader (stored + deflate, no ZIP64, no encryption) used to unpack the
// optional ffmpeg build. No dependency; reads the central directory, inflates on demand.

import { closeSync, openSync, readSync, fstatSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, pos + got);
    if (n <= 0) throw new Error('zip: unexpected end of file');
    got += n;
  }
  return b;
}

export function listZip(path: string): ZipEntry[] {
  const fd = openSync(path, 'r');
  try {
    return listFd(fd);
  } finally {
    closeSync(fd);
  }
}

function listFd(fd: number): ZipEntry[] {
  const size = fstatSync(fd).size;
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('zip: ZIP64 is not supported');
  const cd = readAt(fd, cdOffset, cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const flags = cd.readUInt16LE(p + 8);
    if (flags & 1) throw new Error('zip: encrypted entries are not supported');
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const sz = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compressedSize, size: sz, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function readEntry(path: string, entry: ZipEntry): Buffer {
  const fd = openSync(path, 'r');
  try {
    const lh = readAt(fd, entry.localHeaderOffset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip: bad local header');
    const start = entry.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = readAt(fd, start, entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: compression method ${entry.method} is not supported`);
    if (data.length !== entry.size) throw new Error(`zip: size mismatch for ${entry.name}`);
    return data;
  } finally {
    closeSync(fd);
  }
}

export function extractEntry(path: string, entry: ZipEntry, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readEntry(path, entry));
}

/** Test helper: builds a zip in memory (deflate when `deflate` is true). */
export function buildZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const crc = crc32Js;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, 'utf8');
    const c = crc(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(c, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(c, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function crc32Js(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * Extracts every file of a zip under dest, keeping folders. Entries that would land outside dest
 * (absolute, `..`, drive letters) are refused. Returns the relative paths written.
 */
export function extractZipTree(path: string, dest: string, maxEntryBytes = 512 * 1024 * 1024): string[] {
  const out: string[] = [];
  mkdirSync(dest, { recursive: true });
  for (const e of listZip(path)) {
    const name = e.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`zip: unsafe path ${e.name}`);
    const parts = name.split('/').filter((p) => p.length > 0 && p !== '.');
    if (parts.length === 0) continue;
    if (parts.some((p) => p === '..')) throw new Error(`zip: unsafe path ${e.name}`);
    if (e.size > maxEntryBytes) throw new Error(`zip: entry too large: ${e.name}`);
    extractEntry(path, e, join(dest, ...parts));
    out.push(parts.join('/'));
  }
  return out;
}
