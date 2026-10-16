// Ogg/Opus -> 16 kHz mono PCM. Telegram voice notes are this container.
// Port of src/Core/OggOpus.cs. Demux matches the C# ReadPackets path;
// decode uses the opus-decoder WASM package (Concentus equivalent).

import { OpusDecoder } from 'opus-decoder';

const ascii = (buf: Uint8Array, off: number, n: number) =>
  String.fromCharCode(...buf.subarray(off, off + n));

/**
 * Demux Ogg pages into complete packets (continuation segments with len==255 are joined).
 * Exported for unit tests; DecodeTo16kMono uses it internally.
 */
export function readPackets(ogg: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  const partial: number[] = [];
  let i = 0;
  while (i + 27 <= ogg.length) {
    if (ogg[i] !== 0x4f || ogg[i + 1] !== 0x67 || ogg[i + 2] !== 0x67 || ogg[i + 3] !== 0x53) break; // "OggS"
    const nseg = ogg[i + 26];
    const table = i + 27;
    if (table + nseg > ogg.length) throw new Error('truncated ogg page');
    let pos = table + nseg;
    for (let s = 0; s < nseg; s++) {
      const len = ogg[table + s];
      if (pos + len > ogg.length) throw new Error('truncated ogg payload');
      for (let b = 0; b < len; b++) partial.push(ogg[pos + b]);
      pos += len;
      if (len < 255) {
        packets.push(Uint8Array.from(partial));
        partial.length = 0;
      }
    }
    i = pos;
  }
  if (packets.length === 0) throw new Error('no ogg pages');
  return packets;
}

/**
 * Decode an Ogg/Opus file to 16 kHz mono float PCM.
 * Skips OpusHead + OpusTags (first two packets). Respects OpusHead preskip scaled 48k→16k.
 */
export async function decodeTo16kMono(ogg: Uint8Array): Promise<Float32Array> {
  const packets = readPackets(ogg);
  if (packets.length < 2) throw new Error('ogg/opus file is too short');
  const head = packets[0];
  if (head.length < 19 || ascii(head, 0, 8) !== 'OpusHead') throw new Error('not an ogg/opus file');

  const preskip48 = head[10] | (head[11] << 8);
  const skip = Math.trunc((preskip48 * 16000) / 48000);

  const decoder = new OpusDecoder({ sampleRate: 16000, channels: 1, forceStereo: false });
  await decoder.ready;
  try {
    const samples: number[] = [];
    for (let i = 2; i < packets.length; i++) {
      const packet = packets[i];
      if (packet.length === 0) continue;
      const { channelData, samplesDecoded, errors } = decoder.decodeFrame(packet);
      if (errors && errors.length > 0) {
        // Soft-fail individual bad packets the way a media player would; empty audio still errors below.
        continue;
      }
      const ch0 = channelData[0];
      for (let s = 0; s < samplesDecoded; s++) samples.push(ch0[s]);
    }
    if (skip > 0 && skip < samples.length) samples.splice(0, skip);
    if (samples.length === 0) throw new Error('ogg/opus file had no audio');
    return Float32Array.from(samples);
  } finally {
    decoder.free();
  }
}
