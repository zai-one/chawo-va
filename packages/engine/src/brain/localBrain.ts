// The Brain on this computer: llama.cpp's llama-server with a small Qwen model. Port of src/App/LocalBrain.cs.
// Nothing goes online except the one-time download of the engine (~18 MB) and the model (~2 GB), both pinned
// by SHA-256, and only when the user presses Download. The server starts on the first command, listens on a
// random loopback port with a random API key, and is stopped after «Выгружать модели при простое» minutes
// without a request (15 by default; it holds ~2.5 GB).
// On app exit the child is killed; a Windows job object (kill even on a crash) is a later nicety.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { t } from '@chawo/core/strings';
import { PROGRAM_EXE_NAMES } from '../dataMigration';
import { extractZipTree } from '../file/zip';
import * as Log from '../log';
import {
  abortError,
  availableBytes,
  fetchResumable,
  InvalidDataError,
  ModelDownloadException,
  verifyShaAsync,
} from '../models/modelDownloader';
import { unpackTarGzTree } from '../models/tarGz';
import { localDataDir } from '../paths';
import type { BrainDeviceKind, LocalBrainKind, SettingsData } from '../settings';
import { BrainException } from './speechCleanup';

/** Whether "on this computer" is offered in the menus. On since 1.0.7. */
export const Offered = true;

export const EngineTag = 'b10701';

/** Windows builds, pinned like the WPF app. */
const EngineUrl =
  'https://github.com/ggml-org/llama.cpp/releases/download/b10701/llama-b10701-bin-win-cpu-x64.zip';
const EngineSha256 = '84ecf626a9893a7701a5883480b06fb91043ee9cb76de10c5aaeea43cfc7c680';
const VulkanUrl =
  'https://github.com/ggml-org/llama.cpp/releases/download/b10701/llama-b10701-bin-win-vulkan-x64.zip';
const VulkanSha256 = 'ea3524895529aff485ec3d8da477d654f9cc4375cb9e6651793daaca7208daf2';

export const ModelTitle = 'Qwen3 4B';
export const ModelFile = 'Qwen3-4B-Instruct-2507-Q3_K_M.gguf';
export const Qwen3Urls = [
  'https://github.com/moznoazachem/giga-pisar-win/releases/download/brain-models/Qwen3-4B-Instruct-2507-Q3_K_M.gguf',
  'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q3_K_M.gguf',
] as const;
export const Qwen3Sha256 = '9c6e0763577125a994a9bea0bbd7a737ac4498b8a6a4e0f788727553af1806c9';
export const Qwen3Bytes = 2_075_618_400;

export const Qwen35File = 'Qwen3.5-4B-Q3_K_M.gguf';
export const Qwen35Bytes = 2_293_388_448;
export const Qwen35Sha256 = 'd6981ab4d77ba712b48ef69d69042d75b5e39b9dce5fb5a5b054fd08e06afb95';
export const Qwen35Url = 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q3_K_M.gguf';

/** A pasted GGUF larger than this is refused. */
export const MaxCustomBytes = 16 * 2 ** 30;
export const RecommendedRamBytes = 8 * 2 ** 30;
const ContextTokens = 2048;
export const IdleStopMs = 15 * 60_000;
export const StartTimeoutMs = 90_000;
const DownloadIdleMs = 60_000;

export function dir(): string {
  return join(localDataDir(), 'brain');
}

export function logPath(): string {
  return join(localDataDir(), 'brain.log');
}

export function engineDirFor(kind: BrainDeviceKind): string {
  return join(dir(), kind === 'Gpu' ? `engine-${EngineTag}-vulkan` : `engine-${EngineTag}`);
}

export function serverExeName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/** Path to the llama-server binary for the device: `llama-server.exe` on Windows, `llama-server` elsewhere. */
export function serverExeFor(kind: BrainDeviceKind): string {
  return join(engineDirFor(kind), serverExeName());
}

export function title(s: Pick<SettingsData, 'BrainModel'>): string {
  switch (s.BrainModel) {
    case 'Qwen35':
      return 'Qwen3.5 4B';
    case 'Custom':
      return t('Своя модель', 'Custom model');
    default:
      return ModelTitle;
  }
}

export function choiceLabel(kind: LocalBrainKind): string {
  switch (kind) {
    case 'Qwen3':
      return t('Qwen3 4B, 2,1 ГБ', 'Qwen3 4B, 2.1 GB');
    case 'Qwen35':
      return t('Qwen3.5 4B, 2,3 ГБ', 'Qwen3.5 4B, 2.3 GB');
    default:
      return t('Своя ссылка Hugging Face', 'Own Hugging Face link');
  }
}

export function safeGgufName(leaf: string): string {
  const chars: string[] = [];
  for (let i = 0; i < leaf.length; i++) {
    const c = leaf[i]!;
    const ok =
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c === '.' ||
      c === '-' ||
      c === '_';
    chars.push(ok ? c : '_');
  }
  let name = chars.join('');
  while (name.includes('..')) name = name.replaceAll('..', '_');
  if (!name.toLowerCase().endsWith('.gguf') || name.length < 6) return '';
  if (name.length > 160) name = name.slice(-160);
  if (name.startsWith('.')) name = 'm' + name;
  return name;
}

/**
 * Turns a Hugging Face file page into a resolve URL. Rejects anything that is not https
 * on huggingface.co / hf.co and does not name a .gguf.
 */
export function tryParseCustomUrl(raw: string | null | undefined): { ok: true; url: string; fileName: string } | { ok: false; error: string } {
  const error = 'Нужна ссылка Hugging Face на файл .gguf.';
  const text = (raw ?? '').trim();
  let uri: URL;
  try {
    uri = new URL(text);
  } catch {
    return { ok: false, error };
  }
  if (uri.protocol.toLowerCase() !== 'https:') return { ok: false, error };
  const host = uri.hostname.toLowerCase();
  if (host !== 'huggingface.co' && host !== 'www.huggingface.co' && host !== 'hf.co' && host !== 'www.hf.co') {
    return { ok: false, error };
  }
  let path = uri.pathname;
  const blob = '/blob/';
  const at = path.toLowerCase().indexOf(blob);
  if (at >= 0) path = path.slice(0, at) + '/resolve/' + path.slice(at + blob.length);
  if (path.toLowerCase().indexOf('/resolve/') < 0) return { ok: false, error };
  const leaf = path.split('/').filter(Boolean).pop() ?? '';
  if (!leaf.toLowerCase().endsWith('.gguf')) return { ok: false, error };
  const fileName = safeGgufName(leaf);
  if (fileName.length === 0) return { ok: false, error };
  uri.pathname = path;
  uri.search = '';
  uri.hash = '';
  return { ok: true, url: uri.href, fileName };
}

export function modelPath(s: Pick<SettingsData, 'BrainModel' | 'BrainCustomUrl'>): string {
  if (s.BrainModel === 'Custom') {
    const parsed = tryParseCustomUrl(s.BrainCustomUrl);
    if (!parsed.ok) return join(dir(), 'custom.gguf');
    return join(dir(), parsed.fileName);
  }
  return join(dir(), s.BrainModel === 'Qwen35' ? Qwen35File : ModelFile);
}

export function weightBytes(s: Pick<SettingsData, 'BrainModel' | 'BrainCustomUrl'>): number {
  switch (s.BrainModel) {
    case 'Qwen35':
      return Qwen35Bytes;
    case 'Custom': {
      const path = modelPath(s);
      try {
        if (existsSync(path)) return statSync(path).size;
      } catch {
        /* fall through */
      }
      return Qwen35Bytes;
    }
    default:
      return Qwen3Bytes;
  }
}

/** First four bytes are "GGUF". Reads only the header, never the multi-GB body. */
export function hasGgufMagic(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.alloc(4);
    return readSync(fd, b, 0, 4, 0) === 4 && b[0] === 0x47 && b[1] === 0x47 && b[2] === 0x55 && b[3] === 0x46;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Engine plus the selected GGUF, checked by size (built-in) or by the GGUF header (custom). */
export function isReady(s: Pick<SettingsData, 'BrainModel' | 'BrainCustomUrl' | 'BrainDevice'>): boolean {
  const path = modelPath(s);
  if (!existsSync(serverExeFor(s.BrainDevice)) || !existsSync(path)) return false;
  let len: number;
  try {
    len = statSync(path).size;
  } catch {
    return false;
  }
  switch (s.BrainModel) {
    case 'Qwen3':
      return len === Qwen3Bytes;
    case 'Qwen35':
      return len === Qwen35Bytes;
    default:
      return len > 1024 && len <= MaxCustomBytes && hasGgufMagic(path);
  }
}

export function hasAnything(): boolean {
  const d = dir();
  if (!existsSync(d)) return false;
  if (existsSync(serverExeFor('Cpu'))) return true;
  try {
    return readdirSync(d).some((n) => n.toLowerCase().endsWith('.gguf'));
  } catch {
    return false;
  }
}

export function memoryNeeded(s: Pick<SettingsData, 'BrainModel' | 'BrainCustomUrl'>): number {
  return weightBytes(s) + 600 * 2 ** 20;
}

export function gb(bytes: number): string {
  return (bytes / 2 ** 30).toFixed(1);
}

export interface InstalledGguf {
  path: string;
  label: string;
}

/** GGUF files in the brain folder. The llama.cpp engine and the app are not included. */
export function installedGgufs(): InstalledGguf[] {
  const d = dir();
  if (!existsSync(d)) return [];
  const list: InstalledGguf[] = [];
  let names: string[];
  try {
    names = readdirSync(d);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.gguf')) continue;
    const path = join(d, name);
    let info: { size: number };
    try {
      info = { size: statSync(path).size };
    } catch {
      continue;
    }
    if (info.size <= 1024) continue;
    const label =
      name.toLowerCase() === ModelFile.toLowerCase()
        ? 'Qwen3 4B'
        : name.toLowerCase() === Qwen35File.toLowerCase()
          ? 'Qwen3.5 4B'
          : name;
    list.push({ path, label });
  }
  return list;
}

// ── download ─────────────────────────────────────────────────

/** Progress of a Brain download. Phases as in C#: download | verify | unpack | done. */
export interface BrainProgress {
  received: number;
  total: number;
  phase: 'download' | 'verify' | 'unpack' | 'done';
}

export interface EngineSpec {
  url: string;
  /** SHA-256 of the archive; GitHub release digests for every build we offer. */
  sha256: string;
  /** Exact archive size, also the download cap. */
  bytes: number;
  archive: 'zip' | 'tar.gz';
}

/**
 * llama.cpp b10701 build for this platform and device. Windows: the WPF pins. Linux: the official ubuntu
 * tarballs, SHA-256 from the GitHub release asset digests. Null where llama.cpp ships no matching build.
 */
export function engineSpecFor(
  kind: BrainDeviceKind,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EngineSpec | null {
  const base = `https://github.com/ggml-org/llama.cpp/releases/download/${EngineTag}/llama-${EngineTag}-bin-`;
  const gpu = kind === 'Gpu';
  if (platform === 'win32' && arch === 'x64') {
    return gpu
      ? { url: VulkanUrl, sha256: VulkanSha256, bytes: 34_917_373, archive: 'zip' }
      : { url: EngineUrl, sha256: EngineSha256, bytes: 18_146_059, archive: 'zip' };
  }
  if (platform === 'linux' && arch === 'x64') {
    return gpu
      ? { url: base + 'ubuntu-vulkan-x64.tar.gz', sha256: '58a7d9b479ec6f6e7e8703f0aa654e0b67f6f7b1f226aa0f8e9e4feb83f77f50', bytes: 33_484_371, archive: 'tar.gz' }
      : { url: base + 'ubuntu-x64.tar.gz', sha256: '234b90b329c2b2b6932bf0bf3d737e461bdadee6babb47a14386535776287f9d', bytes: 16_423_425, archive: 'tar.gz' };
  }
  if (platform === 'linux' && arch === 'arm64') {
    return gpu
      ? { url: base + 'ubuntu-vulkan-arm64.tar.gz', sha256: '48e3a8dcc7e12ff02e9ea991e18fe622fc37ee4802e53c81c21f835155434dce', bytes: 27_298_780, archive: 'tar.gz' }
      : { url: base + 'ubuntu-arm64.tar.gz', sha256: '63e6fbd5af9ac53584b212cf772f9d714e66202acd74bcc807a9498405cc2cd7', bytes: 13_159_921, archive: 'tar.gz' };
  }
  return null;
}

export interface ModelSpec {
  urls: readonly string[];
  /** Null for a custom GGUF: checked by its header instead. */
  sha256: string | null;
  /** 0 for a custom GGUF (size unknown, capped at MaxCustomBytes). */
  bytes: number;
}

/** Where the selected GGUF comes from. Throws ModelDownloadException('rejected') for a bad custom link. */
export function modelSpecFor(s: Pick<SettingsData, 'BrainModel' | 'BrainCustomUrl'>): ModelSpec {
  if (s.BrainModel === 'Custom') {
    const parsed = tryParseCustomUrl(s.BrainCustomUrl);
    if (!parsed.ok) throw new ModelDownloadException('rejected', parsed.error);
    return { urls: [parsed.url], sha256: null, bytes: 0 };
  }
  if (s.BrainModel === 'Qwen35') return { urls: [Qwen35Url], sha256: Qwen35Sha256, bytes: Qwen35Bytes };
  return { urls: Qwen3Urls, sha256: Qwen3Sha256, bytes: Qwen3Bytes };
}

export interface DownloadDeps {
  fetch?: typeof fetch;
  engineSpec?: (kind: BrainDeviceKind) => EngineSpec | null;
  modelSpec?: (s: SettingsData) => ModelSpec;
  /** Free bytes on the brain folder's volume; null when unknown. */
  freeBytes?: (dir: string) => number | null;
  idleMs?: number;
}

const USER_AGENT = `ChawoVoiceAssistant/2.0.0-alpha.0 (${process.platform})`;

const isAbort = (e: unknown) =>
  (e instanceof Error && e.name === 'AbortError') ||
  (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ABORT_ERR');

function tryRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Fetches the engine and the selected GGUF. Nothing here runs until the download button calls it.
 * The model resumes from its `.part` file (HTTP Range); a source that fails hands over to the next mirror.
 */
export async function downloadAsync(
  s: SettingsData,
  onProgress: (p: BrainProgress) => void,
  signal: AbortSignal,
  deps: DownloadDeps = {},
): Promise<void> {
  const spec = (deps.modelSpec ?? modelSpecFor)(s);
  const dest = modelPath(s);

  stop();
  const d = dir();
  mkdirSync(d, { recursive: true });
  let need = (spec.bytes > 0 ? spec.bytes : 3 * 2 ** 30) + 200 * 2 ** 20;
  const part = dest + '.part';
  if (existsSync(part)) need -= statSync(part).size;
  const free = (deps.freeBytes ?? availableBytes)(d);
  if (free !== null && free < need) {
    throw new ModelDownloadException('noSpace', `only ${Math.floor(free / 2 ** 20)} MB free, need ${Math.floor(need / 2 ** 20)}`);
  }
  const fetchOpts = { fetch: deps.fetch, idleMs: deps.idleMs ?? DownloadIdleMs, maxBytes: MaxCustomBytes, userAgent: USER_AGENT };

  try {
    await ensureEngine(s.BrainDevice, onProgress, signal, deps);

    const have =
      existsSync(dest) &&
      (spec.bytes > 0 ? statSync(dest).size === spec.bytes : hasGgufMagic(dest) && statSync(dest).size > 1024);
    if (!have) {
      for (let i = 0; ; i++) {
        try {
          await fetchResumable(spec.urls[i]!, part, spec.bytes, (r, tot) => onProgress({ received: r, total: tot, phase: 'download' }), signal, fetchOpts);
          onProgress({ received: 0, total: 0, phase: 'verify' });
          try {
            if (spec.sha256 != null) await verifyShaAsync(part, spec.sha256, 'model', signal);
            else if (!hasGgufMagic(part)) {
              throw new ModelDownloadException('rejected', t('Это не файл GGUF. Он не запускается как программа.', 'This is not a GGUF file. It is never run as a program.'));
            }
          } catch (e) {
            if (!isAbort(e)) tryRm(part);
            throw e;
          }
          break;
        } catch (e) {
          if (i + 1 < spec.urls.length && !signal.aborted && !isAbort(e)) {
            Log.write(`brain model source ${i} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}; trying the next one`);
            continue;
          }
          throw e;
        }
      }
      rmSync(dest, { force: true });
      renameSync(part, dest);
    }
    onProgress({ received: 1, total: 1, phase: 'done' });
  } catch (e) {
    if (e instanceof ModelDownloadException) throw e;
    if (signal.aborted || isAbort(e)) throw abortError();
    const msg = e instanceof Error ? e.message : String(e);
    if ((e as { code?: string }).code === 'ENOSPC') throw new ModelDownloadException('noSpace', msg, e);
    if (e instanceof InvalidDataError) throw new ModelDownloadException('corrupt', msg, e);
    throw new ModelDownloadException('network', msg, e);
  }
}

/** Finds the folder holding `name` under root (the archive may nest everything in `llama-bXXXX/`). */
function findDirWith(root: string, name: string, depth = 3): string | null {
  if (existsSync(join(root, name))) return root;
  if (depth <= 0) return null;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findDirWith(join(root, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** Downloads, checks and unpacks llama-server for the device unless it is already there. */
export async function ensureEngine(
  kind: BrainDeviceKind,
  onProgress: (p: BrainProgress) => void,
  signal: AbortSignal,
  deps: DownloadDeps = {},
): Promise<void> {
  const exe = serverExeFor(kind);
  if (existsSync(exe)) return;
  const spec = (deps.engineSpec ?? engineSpecFor)(kind);
  if (!spec) {
    throw new ModelDownloadException(
      'rejected',
      t(`Для ${process.platform}/${process.arch} нет готовой сборки llama.cpp.`, `No llama.cpp build for ${process.platform}/${process.arch}.`),
    );
  }
  const engineDir = engineDirFor(kind);
  mkdirSync(dir(), { recursive: true });
  const archive = join(dir(), `${kind === 'Gpu' ? 'engine-vulkan' : 'engine'}.${spec.archive}.part`);
  tryRm(archive);
  const temp = engineDir + '.tmp';
  try {
    await fetchResumable(spec.url, archive, spec.bytes, (r, tot) => onProgress({ received: r, total: tot, phase: 'download' }), signal, {
      fetch: deps.fetch,
      idleMs: deps.idleMs ?? DownloadIdleMs,
      userAgent: USER_AGENT,
    });
    onProgress({ received: 0, total: 0, phase: 'verify' });
    await verifyShaAsync(archive, spec.sha256, 'engine', signal);
    onProgress({ received: 0, total: 0, phase: 'unpack' });
    tryRm(temp);
    try {
      if (spec.archive === 'zip') extractZipTree(archive, temp);
      else await unpackTarGzTree(archive, temp, { signal });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new InvalidDataError(e instanceof Error ? e.message : String(e));
    }
    const name = basename(exe);
    const found = findDirWith(temp, name);
    if (!found) throw new InvalidDataError(t(`в архиве движка нет ${name}`, `the engine archive has no ${name}`));
    if (process.platform !== 'win32') chmodSync(join(found, name), 0o755);
    tryRm(engineDir);
    renameSync(found, engineDir);
  } finally {
    tryRm(temp);
    tryRm(archive);
  }
}

// ── delete ───────────────────────────────────────────────────

/** Deletes one GGUF under the brain folder. Stops llama-server first. Does not delete the engine or the app. */
export function deleteGguf(path: string): void {
  const full = resolve(path);
  const root = resolve(dir());
  const rel = relative(root, full);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(t('файл не в папке мозга', 'the file is not in the Brain folder'));
  }
  if (!full.toLowerCase().endsWith('.gguf')) throw new Error(t('это не файл модели', 'this is not a model file'));
  if (PROGRAM_EXE_NAMES.some((n) => existsSync(join(root, n)))) {
    throw new Error(t('рядом лежит программа, файл не удалён', 'the program is next to it, the file was not deleted'));
  }
  stop();
  rmSync(full, { force: true });
  try {
    rmSync(full + '.part', { force: true });
  } catch {
    /* ignore */
  }
}

/** Removes the whole brain folder (engines and models). */
export function deleteModel(): void {
  stop();
  try {
    rmSync(dir(), { recursive: true, force: true });
  } catch (e) {
    Log.write(`brain delete failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── server ───────────────────────────────────────────────────

export type LocalBrainRuntime = {
  isReady(s: SettingsData): boolean;
  readonly running: boolean;
  readonly endpointUrl: string;
  readonly apiKey: string;
  ensureStarted(s: SettingsData, tick: (sec: number) => void, signal: AbortSignal): Promise<void>;
  /** Kills the server (fakes may omit it). */
  stop?(): void;
  /** Restart the idle delay (after a request, or when the setting changes). */
  touch?(): void;
  /** Set when Vulkan failed and the CPU engine took over. */
  readonly deviceNote?: string | null;
};

/** Spawns like child_process.spawn; tests inject a Node script posing as llama-server. */
export type SpawnLike = (command: string, args: readonly string[], options: { cwd: string; windowsHide: boolean; detached: boolean; stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;

export interface RuntimeOptions {
  spawn?: SpawnLike;
  fetch?: typeof fetch;
  isReady?: (s: SettingsData) => boolean;
  exeFor?: (kind: BrainDeviceKind) => string;
  modelPathFor?: (s: SettingsData) => string;
  logPath?: () => string;
  /** Idle delay in ms, or a getter for the live setting; 0 or less keeps the server running. */
  idleStopMs?: number | (() => number);
  startTimeoutMs?: number;
  healthDelayMs?: number;
  healthTimeoutMs?: number;
}

/** Ask the OS for a free loopback port, then let it go (C# FreePort). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

/** Arguments for llama-server b10701, exactly as the WPF app passes them. */
export function serverArgs(modelPath: string, port: number, apiKey: string, device: BrainDeviceKind): string[] {
  // --reasoning off alone does not stop Qwen3.5: the template still opens a think block.
  // --reasoning-budget 0 and enable_thinking false close it. The same false is sent on every request.
  const args = [
    '-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey,
    '-c', String(ContextTokens), '--no-webui', '--jinja',
    '--reasoning', 'off', '--reasoning-budget', '0',
    '--chat-template-kwargs', '{"enable_thinking":false}',
  ];
  // Vulkan build: 99 layers puts a 4B Q3 file on the card.
  if (device === 'Gpu') args.push('-ngl', '99');
  return args;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      rej(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      res();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface Server {
  proc: ChildProcess;
  exited: boolean;
}

const live = new Set<LlamaServerRuntime>();
let exitHooked = false;
function hookExit(rt: LlamaServerRuntime): void {
  live.add(rt);
  if (exitHooked) return;
  exitHooked = true;
  // A synchronous kill is all 'exit' allows; the app also calls stop() on before-quit.
  process.once('exit', () => {
    for (const r of live) r.stop();
  });
}

/** llama-server as a child process. Port of LocalBrain.EnsureStartedAsync / StartProcess / Stop. */
export class LlamaServerRuntime implements LocalBrainRuntime {
  private server: Server | null = null;
  private port = 0;
  private key = '';
  private loadedPath: string | null = null;
  private loadedDevice: BrainDeviceKind = 'Cpu';
  /** Vulkan failed for this load and CPU took over: do not retry the card on every phrase. */
  private fellBack = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private log: WriteStream | null = null;
  private gate: Promise<unknown> = Promise.resolve();
  private note: string | null = null;
  private readonly o: Required<Omit<RuntimeOptions, 'fetch'>> & { fetch?: typeof fetch };

  constructor(opts: RuntimeOptions = {}) {
    this.o = {
      spawn: (cmd, args, options) => nodeSpawn(cmd, [...args], options),
      isReady,
      exeFor: serverExeFor,
      modelPathFor: modelPath,
      logPath,
      idleStopMs: () => (idleSource ? idleSource() : IdleStopMs),
      startTimeoutMs: StartTimeoutMs,
      healthDelayMs: 400,
      healthTimeoutMs: 2000,
      // An option passed as undefined keeps its default.
      ...(Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as RuntimeOptions),
    };
  }

  isReady(s: SettingsData): boolean {
    return this.o.isReady(s);
  }

  get running(): boolean {
    return this.server != null && !this.server.exited;
  }

  get endpointUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get apiKey(): string {
    return this.key;
  }

  get deviceNote(): string | null {
    return this.note;
  }

  /** The device the running server was started on (CPU after a Vulkan fallback). */
  get loadedOn(): BrainDeviceKind | null {
    return this.running ? this.loadedDevice : null;
  }

  /** Starts the server if needed and waits until it answers /health. Reports elapsed seconds while starting. */
  async ensureStarted(s: SettingsData, tick: (sec: number) => void, signal: AbortSignal): Promise<void> {
    if (!this.o.isReady(s)) {
      throw new BrainException(
        existsSync(this.o.exeFor(s.BrainDevice))
          ? t('модель Мозга не скачана', 'the Brain model is not downloaded')
          : t('движок мозга не скачан', 'the brain engine is not downloaded'),
      );
    }
    const model = this.o.modelPathFor(s);
    const device = s.BrainDevice;
    // One decision at a time: a dictation take and a file brain arriving together share one server.
    const server = await this.serial(async () => {
      const samePath = this.loadedPath != null && this.loadedPath.toLowerCase() === model.toLowerCase();
      const same =
        this.running &&
        samePath &&
        (this.loadedDevice === device || (device === 'Gpu' && this.loadedDevice === 'Cpu' && this.fellBack));
      return same ? this.server! : this.startProcess(model, device);
    });

    try {
      await this.waitHealthy(server, tick, signal);
    } catch (e) {
      const cpu = this.o.exeFor('Cpu');
      if (!(e instanceof BrainException) || device !== 'Gpu' || this.loadedDevice !== 'Gpu' || !existsSync(cpu)) throw e;
      Log.write('brain vulkan did not start, using the CPU engine');
      this.note = t('Видеокарта не поднялась, мозг считает на процессоре.', 'The video card did not start, the brain is on the processor.');
      const cpuServer = await this.serial(() => this.startProcess(model, 'Cpu'));
      this.fellBack = true;
      await this.waitHealthy(cpuServer, tick, signal);
    }
    Log.write(`brain up on port ${this.port}, device ${this.loadedDevice}`);
    this.touchIdle();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn, fn);
    this.gate = run.catch(() => undefined);
    return run;
  }

  private async waitHealthy(server: Server, tick: (sec: number) => void, signal: AbortSignal): Promise<void> {
    const doFetch = this.o.fetch ?? globalThis.fetch;
    const started = Date.now();
    let lastTick = 0;
    for (;;) {
      if (signal.aborted) throw abortError();
      if (server.exited || server !== this.server) {
        throw new BrainException(
          t(`нейронка упала при запуске, подробности в ${this.o.logPath()}`, `the Brain crashed on start, details in ${this.o.logPath()}`),
        );
      }
      try {
        const res = await doFetch(`http://127.0.0.1:${this.port}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.o.healthTimeoutMs)]),
        });
        const body = await res.text();
        if (body.includes('ok')) {
          if (this.loadedDevice === 'Gpu') this.note = null;
          return;
        }
      } catch {
        if (signal.aborted) throw abortError();
        /* not up yet */
      }
      const elapsed = Date.now() - started;
      if (elapsed > this.o.startTimeoutMs) {
        this.stop();
        throw new BrainException(t('нейронка не поднялась за полторы минуты', 'the Brain did not come up within 90 seconds'));
      }
      const sec = Math.floor(elapsed / 1000);
      if (sec >= 3 && sec !== lastTick) {
        lastTick = sec;
        tick(sec);
      }
      await sleep(this.o.healthDelayMs, signal);
    }
  }

  private async startProcess(modelPath: string, device: BrainDeviceKind): Promise<Server> {
    this.stop();
    const exe = this.o.exeFor(device);
    if (!existsSync(exe)) throw new BrainException(t('движок мозга не скачан', 'the brain engine is not downloaded'));
    this.port = await freePort();
    this.key = randomBytes(16).toString('hex').toUpperCase();

    const logFile = this.o.logPath();
    mkdirSync(resolve(logFile, '..'), { recursive: true });
    const log = createWriteStream(logFile, { flags: 'w' });
    log.on('error', () => undefined);
    this.log = log;
    let proc: ChildProcess;
    try {
      proc = this.o.spawn(exe, serverArgs(modelPath, this.port, this.key, device), {
        cwd: resolve(exe, '..'),
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.closeLog();
      throw e;
    }
    const server: Server = { proc, exited: false };
    proc.stdout?.on('data', (c: Buffer) => this.log === log && log.write(c));
    proc.stderr?.on('data', (c: Buffer) => this.log === log && log.write(c));
    proc.on('error', (e) => {
      server.exited = true;
      Log.write(`brain process error: ${e.message}`);
    });
    proc.on('exit', (code, sig) => {
      server.exited = true;
      if (this.server === server) Log.write(`brain process exited: ${code ?? sig}`);
    });
    this.server = server;
    this.loadedPath = modelPath;
    this.loadedDevice = device;
    hookExit(this);
    Log.write(`brain starting: ${basename(modelPath)}, engine ${EngineTag}/${device}, reasoning off, budget 0`);
    return server;
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const o = this.o.idleStopMs;
    const ms = typeof o === 'function' ? o() : o;
    if (!(ms > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      Log.write(`brain idle for ${Math.round(ms / 60_000)} min, releasing memory`);
      this.stop();
    }, ms);
    this.idleTimer.unref?.();
  }

  /** A request just finished, or «Выгружать модели при простое» changed: count the delay from now (only while running). */
  touch(): void {
    if (this.running) this.touchIdle();
  }

  private closeLog(): void {
    const log = this.log;
    this.log = null;
    try {
      log?.end();
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const server = this.server;
    this.server = null;
    this.loadedPath = null;
    this.fellBack = false;
    if (server && !server.exited) {
      try {
        server.proc.kill();
        const hard = setTimeout(() => {
          if (!server.exited) {
            try {
              server.proc.kill('SIGKILL');
            } catch {
              /* gone */
            }
          }
        }, 2000);
        hard.unref?.();
      } catch {
        /* gone */
      }
    }
    this.closeLog();
    live.delete(this);
  }
}

/** Default runtime: the real llama-server child process. */
export function createDefaultRuntime(opts?: RuntimeOptions): LocalBrainRuntime {
  return new LlamaServerRuntime(opts);
}

let activeRuntime: LocalBrainRuntime = createDefaultRuntime();

/** Tests / FileBrain / Brain inject a fake that is always ready and never spawns a process. */
export function setRuntime(runtime: LocalBrainRuntime): void {
  if (runtime !== activeRuntime) activeRuntime.stop?.();
  activeRuntime = runtime;
}

export function getRuntime(): LocalBrainRuntime {
  return activeRuntime;
}

export function resetRuntime(): void {
  activeRuntime.stop?.();
  activeRuntime = createDefaultRuntime();
}

export const EngineDownload = { EngineUrl, EngineSha256, VulkanUrl, VulkanSha256 };

/** Convenience for callers that still use static-style names. */
export const Running = {
  get value() {
    return activeRuntime.running;
  },
};
export function endpointUrl(): string {
  return activeRuntime.endpointUrl;
}
export function apiKey(): string {
  return activeRuntime.apiKey;
}
export function deviceNote(): string | null {
  return activeRuntime.deviceNote ?? null;
}
/** LocalBrain.Stop: kills the server, clears the idle timer, closes the log. */
export function stop(): void {
  activeRuntime.stop?.();
}
/** Live idle delay for the default runtime (set once by the app from its settings). */
let idleSource: (() => number) | null = null;
export function setIdleSource(ms: () => number): void {
  idleSource = ms;
  activeRuntime.touch?.();
}
export function idleChanged(): void {
  activeRuntime.touch?.();
}
export async function ensureStarted(s: SettingsData, tick: (sec: number) => void, signal: AbortSignal): Promise<void> {
  return activeRuntime.ensureStarted(s, tick, signal);
}
