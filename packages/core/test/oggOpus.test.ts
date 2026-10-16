import { describe, expect, it } from 'vitest';
import { readPackets } from '../src/oggOpus';

/** Build one Ogg page carrying complete packets (each segment len < 255). */
function oggPage(packets: Uint8Array[], serial = 1, seq = 0): Uint8Array {
  const segs: number[] = [];
  const payload: number[] = [];
  for (const p of packets) {
    if (p.length >= 255) throw new Error('test helper: keep packets under 255 bytes');
    segs.push(p.length);
    for (let i = 0; i < p.length; i++) payload.push(p[i]);
  }
  const header = new Uint8Array(27 + segs.length + payload.length);
  header[0] = 0x4f;
  header[1] = 0x67;
  header[2] = 0x67;
  header[3] = 0x53; // OggS
  header[4] = 0; // version
  header[5] = seq === 0 ? 2 : 0; // BOS on first
  // granule, serial, seq, checksum left zero
  header[14] = serial & 0xff;
  header[18] = seq & 0xff;
  header[26] = segs.length;
  for (let i = 0; i < segs.length; i++) header[27 + i] = segs[i];
  header.set(payload, 27 + segs.length);
  return header;
}

describe('oggOpus readPackets', () => {
  it('demuxes complete packets across pages', () => {
    const head = new TextEncoder().encode('OpusHead...........'); // 19 bytes
    const tags = new TextEncoder().encode('OpusTags');
    const audio = Uint8Array.from([1, 2, 3, 4]);
    const page0 = oggPage([head, tags], 1, 0);
    const page1 = oggPage([audio], 1, 1);
    const ogg = new Uint8Array(page0.length + page1.length);
    ogg.set(page0, 0);
    ogg.set(page1, page0.length);
    const packets = readPackets(ogg);
    expect(packets.length).toBe(3);
    expect(new TextDecoder().decode(packets[0].subarray(0, 8))).toBe('OpusHead');
    expect(new TextDecoder().decode(packets[1])).toBe('OpusTags');
    expect(Array.from(packets[2])).toEqual([1, 2, 3, 4]);
  });

  it('joins continuation segments (len 255)', () => {
    // One packet of 300 bytes: first segment 255, second 45.
    const body = new Uint8Array(300);
    for (let i = 0; i < 300; i++) body[i] = i & 0xff;
    const header = new Uint8Array(27 + 2 + 300);
    header[0] = 0x4f;
    header[1] = 0x67;
    header[2] = 0x67;
    header[3] = 0x53;
    header[26] = 2;
    header[27] = 255;
    header[28] = 45;
    header.set(body, 29);
    const packets = readPackets(header);
    expect(packets.length).toBe(1);
    expect(packets[0].length).toBe(300);
    expect(packets[0][0]).toBe(0);
    expect(packets[0][255]).toBe(255 & 0xff);
  });

  it('rejects streams with no Ogg pages', () => {
    expect(() => readPackets(new Uint8Array([1, 2, 3, 4]))).toThrow(/no ogg pages/);
  });
});
