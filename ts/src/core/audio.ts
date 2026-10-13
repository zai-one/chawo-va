// WAV reading/writing, resampling and pause-based splitting. Port of src/Core/AudioUtils.cs.
// Pure functions over bytes/Float32Array so they run in Electron main, a worker, or a CLI server.

/** Reads a 16-bit PCM WAV from memory; takes the first channel. */
export function readWav(d: Uint8Array, label = 'wav'): { samples: Float32Array; rate: number } {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 44 || v.getUint32(0, true) !== 0x46464952) throw new Error(`Not a WAV file: ${label}`);
  let rate = 16000;
  let channels = 1;
  let bits = 16;
  let i = 12;
  while (i + 8 <= d.length) {
    const id = v.getUint32(i, true);
    const size = v.getUint32(i + 4, true);
    const body = i + 8;
    if (size > d.length - body) throw new Error(`Truncated WAV: ${label}`);
    if (id === 0x20746d66) {
      // "fmt "
      if (body + 16 > d.length) throw new Error(`Truncated WAV header: ${label}`);
      if (v.getUint16(body, true) !== 1) throw new Error(`Expected PCM WAV: ${label}`);
      channels = v.getUint16(body + 2, true);
      rate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === 0x61746164) {
      // "data"
      if (bits !== 16) throw new Error(`Expected 16-bit WAV, got ${bits}-bit: ${label}`);
      const end = Math.min(body + size, d.length);
      const step = 2 * Math.max(1, channels);
      const count = Math.max(0, Math.floor((end - body) / step));
      const out = new Float32Array(count);
      for (let k = 0, p = body; k < count; k++, p += step) out[k] = v.getInt16(p, true) / 32768;
      return { samples: out, rate };
    }
    i = body + size + (size & 1);
  }
  throw new Error(`No data chunk in WAV: ${label}`);
}

/** 16-bit mono WAV in memory. */
export function wavBytes(samples: Float32Array, rate: number): Uint8Array {
  const body = samples.length * 2;
  const buf = new Uint8Array(44 + body);
  const v = new DataView(buf.buffer);
  const ascii = (off: number, s: string) => {
    for (let k = 0; k < 4; k++) buf[off + k] = s.charCodeAt(k);
  };
  ascii(0, 'RIFF');
  v.setInt32(4, 36 + body, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setInt32(16, 16, true);
  v.setInt16(20, 1, true);
  v.setInt16(22, 1, true);
  v.setInt32(24, rate, true);
  v.setInt32(28, rate * 2, true);
  v.setInt16(32, 2, true);
  v.setInt16(34, 16, true);
  ascii(36, 'data');
  v.setInt32(40, body, true);
  for (let k = 0; k < samples.length; k++) {
    const s = Math.max(-32768, Math.min(32767, Math.trunc(samples[k] * 32767)));
    v.setInt16(44 + 2 * k, s, true);
  }
  return buf;
}

/** Linear resample. Dictation and the LAN server both feed the model 16 kHz. */
export function resample(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate || srcRate <= 0 || dstRate <= 0 || src.length === 0) return src;
  const dstLen = Math.max(1, Math.floor((src.length * dstRate) / srcRate));
  const dst = new Float32Array(dstLen);
  const step = srcRate / dstRate;
  const last = src.length - 1;
  for (let i = 0; i < dstLen; i++) {
    const x = (i + 0.5) * step - 0.5;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = src[Math.min(Math.max(i0, 0), last)];
    const b = src[Math.min(Math.max(i0 + 1, 0), last)];
    dst[i] = a + (b - a) * f;
  }
  return dst;
}

/** Midpoints of pauses (seconds), candidates for cut points. Mirrors ffmpeg silencedetect. */
export function silences(x: Float32Array, rate: number, noiseDb = -35, minSeconds = 0.3): number[] {
  const threshold = Math.fround(Math.pow(10, noiseDb / 20));
  const minRun = Math.trunc(minSeconds * rate);
  const points: number[] = [];
  let start = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) < threshold) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minRun) points.push((start + i) / 2.0 / rate);
      start = -1;
    }
  }
  return points;
}

/** Chunk boundaries in seconds: never longer than maxChunk, cut at the last pause before the limit. */
export function chunkBounds(total: number, pauses: readonly number[], maxChunk: number): [number, number][] {
  const bounds: [number, number][] = [];
  let pos = 0;
  while (total - pos > maxChunk) {
    let cut = pos + maxChunk;
    for (let i = pauses.length - 1; i >= 0; i--) {
      if (pauses[i] > pos + 3 && pauses[i] <= pos + maxChunk) {
        cut = pauses[i];
        break;
      }
    }
    bounds.push([pos, cut]);
    pos = cut;
  }
  bounds.push([pos, total]);
  return bounds;
}
