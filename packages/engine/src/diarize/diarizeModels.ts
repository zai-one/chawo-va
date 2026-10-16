// Speaker-diarization models on disk (sherpa-onnx pyannote segmentation + 3D-Speaker embedding).
// Downloaded only on a user action into %LOCALAPPDATA%\ChawoVoiceAssistant\models\diarization\.
// Not committed to the repo. No telemetry, no API keys.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fetchFile } from '../models/modelDownloader';
import { env, localDataDir, modelDirOverride } from '../paths';
import * as Log from '../log';

export const DIAR_DIR_NAME = 'diarization';
export const SEGMENTATION_FILE = 'model.onnx';
export const EMBEDDING_FILE = '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';

export const SEGMENTATION_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2';
export const EMBEDDING_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';

/** Approximate download sizes (bytes) for progress UI. */
export const SEGMENTATION_ARCHIVE_SIZE = 6_958_444;
export const EMBEDDING_SIZE = 39_593_761;
export const DIAR_TOTAL_BYTES = SEGMENTATION_ARCHIVE_SIZE + EMBEDDING_SIZE;

export interface DiarModelPaths {
  segmentation: string;
  embedding: string;
}

/** Canonical folder for a fresh download. */
export function diarizationDir(): string {
  return join(localDataDir(), 'models', DIAR_DIR_NAME);
}

export function segmentationPath(dir = diarizationDir()): string {
  return join(dir, SEGMENTATION_FILE);
}

export function embeddingPath(dir = diarizationDir()): string {
  return join(dir, EMBEDDING_FILE);
}

function bigEnough(path: string, minBytes: number): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size >= minBytes;
  } catch {
    return false;
  }
}

/** Both ONNX files present and non-trivial. */
export function looksComplete(dir: string): boolean {
  // Segmentation ~5.7 MB unpacked; embedding ~28 MB. Use soft floors so a partial download fails.
  return bigEnough(segmentationPath(dir), 1_000_000) && bigEnough(embeddingPath(dir), 5_000_000);
}

/** CHAWO_DIAR_DIR, canonical path, then CHAWO_MODEL_DIR/diarization. Null when incomplete. */
export function findDiarizationModels(): DiarModelPaths | null {
  const candidates: string[] = [];
  const explicit = env('DIAR_DIR');
  if (explicit) candidates.push(explicit);
  candidates.push(diarizationDir());
  const override = modelDirOverride();
  if (override) {
    candidates.push(join(override, DIAR_DIR_NAME));
    candidates.push(override);
  }
  for (const dir of candidates) {
    if (looksComplete(dir)) {
      return { segmentation: segmentationPath(dir), embedding: embeddingPath(dir) };
    }
  }
  return null;
}

export type ProgressFn = (received: number, total: number, stage: string) => void;
export type FetchToFile = (
  url: string,
  dest: string,
  size: number,
  onProgress: (got: number, total: number) => void,
  signal?: AbortSignal,
) => Promise<void>;

/**
 * Unpack a .tar.bz2 into destDir as basenames only (python3 stdlib bz2 — no system bzip2 needed).
 * Returns written basenames. Refuses path traversal.
 */
export async function unpackTarBz2Flat(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  mkdirSync(destDir, { recursive: true });
  const script = [
    'import tarfile, os, sys',
    'src, dest = sys.argv[1], sys.argv[2]',
    'os.makedirs(dest, exist_ok=True)',
    'out = []',
    'with tarfile.open(src, "r:bz2") as tf:',
    '  for m in tf.getmembers():',
    '    if not m.isfile(): continue',
    '    base = os.path.basename(m.name.replace("\\\\", "/"))',
    '    if not base or base.startswith("._"): continue',
    '    if ".." in base: continue',
    '    target = os.path.join(dest, base)',
    '    f = tf.extractfile(m)',
    '    if f is None: continue',
    '    data = f.read()',
    '    with open(target, "wb") as w: w.write(data)',
    '    out.append(base)',
    'sys.stdout.write("\\n".join(out))',
  ].join('\n');
  const py = join(destDir, '.unpack-bz2.py');
  writeFileSync(py, script, 'utf8');
  try {
    const names = await new Promise<string[]>((resolve, reject) => {
      if (signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
        return;
      }
      const child = spawn('python3', [py, archivePath, destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      const onAbort = () => {
        child.kill('SIGKILL');
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve(stdout.split('\n').filter(Boolean));
        else reject(new Error(stderr.trim() || `python3 unpack failed (${code})`));
      });
    });
    return names;
  } finally {
    try {
      rmSync(py, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Download segmentation archive + embedding into `diarizationDir()`. Concurrent-safe at the caller.
 * Throws on network / unpack errors; cleans `.tmp` / `.part`.
 */
export async function downloadDiarizationModels(
  progress: ProgressFn,
  signal?: AbortSignal,
  fetchTo?: FetchToFile,
): Promise<DiarModelPaths> {
  const dest = diarizationDir();
  const temp = dest + '.tmp';
  const get: FetchToFile =
    fetchTo ??
    ((url, to, size, onP, sig) => fetchFile(url, to, size, onP, sig));

  try {
    if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { recursive: true });

    const archive = join(temp, 'segmentation.tar.bz2');
    progress(0, DIAR_TOTAL_BYTES, 'segmentation');
    await get(
      SEGMENTATION_ARCHIVE_URL,
      archive,
      SEGMENTATION_ARCHIVE_SIZE,
      (got, total) => progress(got, DIAR_TOTAL_BYTES, 'segmentation'),
      signal,
    );
    if (signal?.aborted) throw abortErr();
    progress(SEGMENTATION_ARCHIVE_SIZE, DIAR_TOTAL_BYTES, 'unpack');
    await unpackTarBz2Flat(archive, temp, signal);
    try {
      rmSync(archive, { force: true });
    } catch {
      /* ignore */
    }
    if (!bigEnough(join(temp, SEGMENTATION_FILE), 1_000_000)) {
      throw new Error('segmentation model.onnx missing after unpack');
    }

    const embPart = join(temp, EMBEDDING_FILE + '.part');
    await get(
      EMBEDDING_URL,
      embPart,
      EMBEDDING_SIZE,
      (got) => progress(SEGMENTATION_ARCHIVE_SIZE + got, DIAR_TOTAL_BYTES, 'embedding'),
      signal,
    );
    renameSync(embPart, join(temp, EMBEDDING_FILE));
    if (!looksComplete(temp)) throw new Error('diarization models incomplete after download');

    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    renameSync(temp, dest);
    Log.write(`diarization models ready: ${dest}`);
    progress(DIAR_TOTAL_BYTES, DIAR_TOTAL_BYTES, 'done');
    return { segmentation: segmentationPath(dest), embedding: embeddingPath(dest) };
  } catch (e) {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function abortErr(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
