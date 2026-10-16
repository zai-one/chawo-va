// Preload of the hidden decoder window. Gets bytes from main, decodes with WebAudio at 16 kHz,
// averages channels to mono and posts the samples back. No other API is exposed.
import { ipcRenderer } from 'electron';

const RATE = 16000;

ipcRenderer.on('decoder:decode', (_e, id: number, bytes: Uint8Array) => void decode(id, bytes));

async function decode(id: number, bytes: Uint8Array): Promise<void> {
  try {
    // An OfflineAudioContext at 16 kHz makes decodeAudioData resample for us.
    const ctx = new OfflineAudioContext(1, 1, RATE);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const buf = await ctx.decodeAudioData(ab);
    const n = buf.length;
    const mono = new Float32Array(n);
    const k = 1 / buf.numberOfChannels;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i] * k;
    }
    ipcRenderer.send('decoder:result', id, true, mono, buf.sampleRate);
  } catch (err) {
    const e = err as Error;
    ipcRenderer.send('decoder:result', id, false, `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`, 0);
  }
}
