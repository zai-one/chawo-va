// Speaker diarization off the main thread. sherpa-onnx's process() is synchronous and takes minutes on an
// hour-long recording; on the main thread that froze the window and every IPC call until it returned.
// DiarizeRuntime starts this file by path (out/main/diarizeWorker.js); it needs nothing of the app but
// sherpa-onnx-node. The config comes with each request.

import { parentPort } from 'node:worker_threads';

type Diarizer = { process(samples: Float32Array): { start: number; end: number; speaker: number }[] };

export interface DiarizeWorkerRequest {
  /** Models + clustering, as OfflineSpeakerDiarization takes them; `key` says when to rebuild. */
  config: Record<string, unknown>;
  key: string;
  pcm: Float32Array;
}

export type DiarizeWorkerReply =
  | { ok: true; spans: { start: number; end: number; speaker: number }[] }
  | { ok: false; error: string; noSherpa?: boolean };

let sd: Diarizer | null = null;
let sdKey = '';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

parentPort?.on('message', (m: DiarizeWorkerRequest) => {
  const reply = (r: DiarizeWorkerReply) => parentPort?.postMessage(r);
  if (!sd || sdKey !== m.key) {
    let sherpa: { OfflineSpeakerDiarization: new (config: Record<string, unknown>) => Diarizer };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sherpa = require('sherpa-onnx-node') as typeof sherpa;
    } catch (e) {
      reply({ ok: false, error: message(e), noSherpa: true });
      return;
    }
    try {
      sd = new sherpa.OfflineSpeakerDiarization(m.config);
      sdKey = m.key;
    } catch (e) {
      sd = null;
      reply({ ok: false, error: message(e) });
      return;
    }
  }
  try {
    const spans = (sd.process(m.pcm) ?? []).map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }));
    reply({ ok: true, spans });
  } catch (e) {
    reply({ ok: false, error: message(e) });
  }
});
