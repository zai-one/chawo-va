// Client role for file transcription: the decoded 16 kHz audio goes to the host as WAV. With
// timestamps or a timed output (.srt/.vtt/.json) on, every pause-split piece is posted on its own so its offset is known;
// otherwise the whole file goes in one request and the host splits it. Never downloads a model.
// Port of App.TranscribeRemote (+ the RemoteHostException handling of RunQueue/RunFileQueueAsync).

import { wavBytes } from '@chawo/core/audio';
import { Recognizer } from '@chawo/core/recognizer';
import { t } from '@chawo/core/strings';
import { fromRanges, needsTimings, type ExtraFormat } from '@chawo/core/transcriptFormat';
import * as Log from '../log';
import * as RemoteSpeech from '../network/remoteSpeech';
import { RemoteHostException, type FetchLike } from '../network/remoteSpeech';
import type { SettingsData } from '../settings';
import { filePauses } from '../vad/vadModel';
import type { FileRunnerDeps, FileTranscriber } from './fileRunner';

const RATE = 16000;

export type RemotePost = (s: SettingsData, body: Uint8Array, contentType: string, signal: AbortSignal) => Promise<string>;

export function remoteTranscriber(settings: () => SettingsData, post?: RemotePost, fetchImpl?: FetchLike): FileTranscriber {
  const send: RemotePost = post ?? ((s, body, type, signal) => RemoteSpeech.transcribeBytes(s, body, type, signal, fetchImpl));
  return async (path, samples, status, signal) => {
    const s = settings();
    const formats: ExtraFormat[] = [...(s.FileSrt ? (['srt'] as const) : []), ...s.FileExtraFormats];
    const perPiece = s.FileTimestamps || needsTimings(formats, s.FileTimestamps);
    if (!perPiece) {
      status(t('Отправляю на хост…', 'Sending to the host…'));
      const text = await send(s, wavBytes(samples, RATE), 'audio/wav', signal);
      Log.write(`file remote whole ${text.length} chars <- ${path}`);
      return [{ start: 0, end: samples.length / RATE, text }];
    }
    const pauses = samples.length > (Recognizer.MaxChunkSeconds + 1) * RATE
      ? await filePauses(s, samples, RATE, { signal, onStart: () => status(t('Ищу паузы в речи…', 'Finding pauses in speech…')) })
      : undefined;
    const ranges = Recognizer.splitRanges(samples, RATE, pauses);
    const texts: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      if (signal.aborted) {
        const e = new Error('Operation canceled');
        e.name = 'AbortError';
        throw e;
      }
      status(t(`Кусок ${i + 1} из ${ranges.length} на хосте…`, `Piece ${i + 1} of ${ranges.length} on the host…`), i / ranges.length);
      const { from, to } = ranges[i];
      texts.push(await send(s, wavBytes(samples.subarray(from, to), RATE), 'audio/wav', signal));
    }
    Log.write(`file remote pieces=${ranges.length} <- ${path}`);
    return fromRanges(ranges.map((r) => [r.from, r.to] as const), texts, RATE);
  };
}

/** prepare() for the Client role: only the host address has to make sense. */
export function remotePrepare(settings: () => SettingsData, post?: RemotePost, fetchImpl?: FetchLike): FileRunnerDeps['prepare'] {
  return async () => {
    const ep = RemoteSpeech.tryEndpoint(settings());
    if (!ep.ok) return { ok: false, message: t(ep.russian, ep.english) };
    return { ok: true, transcriber: remoteTranscriber(settings, post, fetchImpl) };
  };
}

/** Host errors end the run: the next file would fail the same way. Returns the line to show. */
export function remoteFatal(e: unknown): string | null {
  return e instanceof RemoteHostException ? t(e.russian, e.english) : null;
}
