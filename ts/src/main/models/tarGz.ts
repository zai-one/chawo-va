// Minimal ustar/pax-compatible tar reader for regular files only (basename only, skip ._*).
// Used to unpack the v3 model archive without adding a dependency.

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const BLOCK = 512;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;

function parseOctal(buf: Buffer, start: number, len: number): number {
  const s = buf.toString('utf8', start, start + len).replace(/\0/g, '').trim();
  if (!s) return 0;
  return parseInt(s, 8) || 0;
}

function readName(header: Buffer): string {
  const name = header.toString('utf8', 0, 100).replace(/\0/g, '').trim();
  const prefix = header.toString('utf8', 345, 500).replace(/\0/g, '').trim();
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * Extract regular files from a .tar.gz into destDir (flat: basename only).
 * Skips directories, links, and AppleDouble `._*` entries.
 */
export async function unpackTarGzFlat(
  archivePath: string,
  destDir: string,
  opts?: { maxFileBytes?: number; signal?: AbortSignal },
): Promise<string[]> {
  const maxBytes = opts?.maxFileBytes ?? MAX_FILE_BYTES;
  mkdirSync(destDir, { recursive: true });
  const written: string[] = [];

  const gunzip = createGunzip();
  const input = createReadStream(archivePath);
  const chunks: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      input.destroy();
      gunzip.destroy();
      reject(new Error('aborted'));
    };
    if (opts?.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    gunzip.on('data', (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      // Soft cap: a model archive decompressed should stay under a few GB.
      if (total > maxBytes * 2) {
        input.destroy();
        gunzip.destroy();
        reject(new Error('decompressed archive too large'));
      }
    });
    gunzip.on('error', reject);
    gunzip.on('end', () => resolve());
    input.on('error', reject);
    input.pipe(gunzip);
  });

  const data = Buffer.concat(chunks, total);
  let offset = 0;

  while (offset + BLOCK <= data.length) {
    if (opts?.signal?.aborted) throw new Error('aborted');
    const header = data.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    // End of archive: two zero blocks
    if (header.every((b) => b === 0)) break;

    const typeFlag = header[156] ?? 0;
    const size = parseOctal(header, 124, 12);
    const name = readName(header);
    const dataSize = size;
    const padded = Math.ceil(dataSize / BLOCK) * BLOCK;
    const payload = data.subarray(offset, offset + dataSize);
    offset += padded;

    // '0' or '\0' = regular file; skip others
    const isReg = typeFlag === 0 || typeFlag === 48; // \0 or '0'
    if (!isReg) continue;
    const base = name.split(/[/\\]/).pop() ?? '';
    if (!base || base.startsWith('._')) continue;
    if (dataSize > maxBytes) throw new Error(`entry too large: ${base}`);

    const outPath = join(destDir, base);
    await writeBuffer(outPath, payload, opts?.signal);
    written.push(base);
  }

  return written;
}

async function writeBuffer(path: string, buf: Buffer, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('aborted');
  await pipeline(Readable.from(buf), createWriteStream(path));
}

/** Build a tiny ustar .tar (then caller can gzip it) for tests. */
export function buildUstar(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const header = Buffer.alloc(BLOCK, 0);
    const name = e.name.slice(0, 100);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100, 'utf8'); // mode
    header.write('0000000\0', 108, 'utf8'); // uid
    header.write('0000000\0', 116, 'utf8'); // gid
    const sizeOct = e.data.length.toString(8).padStart(11, '0') + '\0';
    header.write(sizeOct, 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8'); // mtime
    header.write('        ', 148, 'utf8'); // checksum placeholder spaces
    header[156] = 48; // '0' regular
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += header[i]!;
    const chk = sum.toString(8).padStart(6, '0') + '\0 ';
    header.write(chk, 148, 'utf8');
    parts.push(header);
    parts.push(e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
