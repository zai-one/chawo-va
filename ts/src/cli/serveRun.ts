// `chawo-va serve`: start the headless CPU transcription server and block until SIGINT/SIGTERM.
// Model load is best-effort at start (health reports model_loaded). Sync Hermes POSTs share one
// FileJob (serialized). Async jobs each open their own FileJob so several long files can run in
// parallel up to the worker cap. Never downloads weights. CPU only.

import { wavBytes } from '../core/audio';
import type { FileParallelismKind } from '../core/fileParallel';
import type { CtcScript, SpeechModelKind } from '../core/speechModels';
import { HERMES_PORT } from '../core/speechModels';
import { FileJob } from '../core/fileJob';
import { Recognizer } from '../core/recognizer';
import { decode16k, load16k } from '../main/file/fileTranscript';
import { makeHermesTranscribe } from '../main/network/hermesTranscribe';
import type { HermesRecognizer } from '../main/network/hermesTranscribe';
import { resolveBind, resolveToken, DEFAULT_TTL_MS } from '../main/network/serveAuth';
import { defaultDataDir, defaultWorkerCount, ensureDataDir } from '../main/network/serveJobs';
import { ServeServer } from '../main/network/serveServer';
import { engineFromJob } from './engine';
import type { CliOptions } from './args';

export interface ServeDeps {
  t: (ru: string, en: string) => string;
  out(text: string): void;
  err(text: string): void;
  findModel(kind: SpeechModelKind, override: string | null): string | null;
  log(line: string): void;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  openJob?: (
    dir: string,
    kind: SpeechModelKind,
    threads: FileParallelismKind,
    script: CtcScript,
  ) => Promise<FileJob>;
  decode?: (audio: Uint8Array, label: string) => Promise<Float32Array>;
  load16k?: typeof load16k;
  wait?: (signal: AbortSignal) => Promise<void>;
}

function waitForever(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Serialize async work so a shared FileJob is not run concurrently. */
function mutex() {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export async function runServe(o: CliOptions, d: ServeDeps): Promise<number> {
  const t = d.t;
  const env = d.env ?? process.env;
  const token = resolveToken(o.token, env);
  const bind = resolveBind(o.host, token);
  if (!bind.ok) {
    d.err(t(`chawo-va serve: ${bind.error}\n`, `chawo-va serve: ${bind.error}\n`));
    return 2;
  }

  const kind: SpeechModelKind = o.model ?? 'v3_e2e_rnnt';
  const threads: FileParallelismKind = o.threads ?? 'auto';
  const script: CtcScript = o.script ?? 'auto';
  const port = o.port && o.port > 0 && o.port <= 65535 ? o.port : HERMES_PORT;
  const dataDir = ensureDataDir(o.dataDir?.trim() || defaultDataDir(env));
  const modelDir = d.findModel(kind, o.modelDir);
  if (!modelDir) {
    d.err(
      o.modelDir
        ? t(`chawo-va serve: в ${o.modelDir} нет полной модели ${kind}.\n`, `chawo-va serve: ${o.modelDir} has no complete ${kind} model.\n`)
        : t(
            'chawo-va serve: модели нет на диске. Скачайте её в приложении или укажите --model-dir / CHAWO_MODEL_DIR.\n',
            'chawo-va serve: the model is not on disk. Download it in the app or pass --model-dir / CHAWO_MODEL_DIR.\n',
          ),
    );
    return 3;
  }

  const openJob = d.openJob ?? ((dir, k, th, sc) => FileJob.open(dir, k, 'cpu', th, sc));
  const load = d.load16k ?? load16k;
  const decode = d.decode ?? decode16k;
  const withHermes = mutex();

  let syncJob: FileJob | null = null;
  let hermesRec: HermesRecognizer | null = null;

  const ensureSync = async (): Promise<FileJob> => {
    if (syncJob) return syncJob;
    syncJob = await openJob(modelDir, kind, threads, script);
    hermesRec = {
      modelId: kind,
      deviceActual: syncJob.deviceActual,
      provider: syncJob.provider,
      pieceRanges: (samples, pauses) => Recognizer.splitRanges(samples, 16000, pauses),
      async transcribeCancelable(samples) {
        const j = syncJob!;
        return withHermes(async () => {
          const ranges = Recognizer.splitRanges(samples, 16000);
          const bits = await j.run(samples, ranges, null);
          return bits.filter((b) => b.length > 0).join('\n');
        });
      },
    };
    return syncJob;
  };

  let warmed: FileJob;
  try {
    warmed = await ensureSync();
  } catch (e) {
    d.err(
      t(
        `chawo-va serve: модель не загрузилась: ${e instanceof Error ? e.message : String(e)}\n`,
        `chawo-va serve: the model did not load: ${e instanceof Error ? e.message : String(e)}\n`,
      ),
    );
    return 3;
  }

  const hermes = makeHermesTranscribe({
    current: () => hermesRec,
    load: async () => {
      await ensureSync();
      return hermesRec;
    },
    modelName: () => kind,
    decode,
  });

  // Each async job opens its own FileJob (piece-parallelism inside, files in parallel up to workers).
  const jobTranscribe = async (audioPath: string, signal: AbortSignal) => {
    const j = await openJob(modelDir, kind, threads, script);
    try {
      const samples = await load(audioPath, signal);
      if (samples.length === 0) throw new Error('empty audio');
      const engine = engineFromJob(j, { vad: true, t });
      const onAbort = () => j.cancel();
      signal.addEventListener('abort', onAbort);
      try {
        const segs = await engine.transcribe(samples, () => undefined, signal);
        const text = segs.map((s) => s.text).filter(Boolean).join('\n');
        const segments = segs
          .filter((s) => s.text)
          .map((s) => ({ start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000, text: s.text }));
        return { text, seconds: samples.length / 16000, model: kind, device: j.deviceActual, segments };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    } finally {
      await j.dispose().catch(() => undefined);
    }
  };

  const workers = defaultWorkerCount(threads, kind);
  const server = new ServeServer({
    host: bind.host,
    port,
    token,
    dataDir,
    transcribe: hermes,
    jobTranscribe,
    ttlMs: DEFAULT_TTL_MS,
    workers,
    threads,
    modelKind: kind,
    log: (line) => d.log(line),
  });

  try {
    await server.start();
  } catch (e) {
    await warmed.dispose().catch(() => undefined);
    d.err(
      t(
        `chawo-va serve: не удалось слушать ${bind.host}:${port}: ${e instanceof Error ? e.message : String(e)}\n`,
        `chawo-va serve: could not listen on ${bind.host}:${port}: ${e instanceof Error ? e.message : String(e)}\n`,
      ),
    );
    return 1;
  }

  d.out(
    t(
      `Слушаю ${bind.host}:${server.port} · модель ${kind} · CPU · воркеров ${workers} · данные ${dataDir}` +
        (token ? ' · токен включён' : ' · только localhost (без токена)') +
        '\n',
      `Listening ${bind.host}:${server.port} · model ${kind} · CPU · workers ${workers} · data ${dataDir}` +
        (token ? ' · token on' : ' · localhost only (no token)') +
        '\n',
    ),
  );
  d.log(`serve up ${bind.host}:${server.port} model=${kind} workers=${workers}`);

  const wait = d.wait ?? waitForever;
  await wait(d.signal);

  d.out(t('Останавливаю…\n', 'Stopping…\n'));
  await server.dispose();
  await warmed.dispose().catch(() => undefined);
  return 0;
}

export function silenceWav(samples = 1600): Uint8Array {
  return wavBytes(new Float32Array(samples).fill(0.01), 16000);
}
