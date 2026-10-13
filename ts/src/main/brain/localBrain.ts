// Local Brain helpers + injectable runtime. Port of src/App/LocalBrain.cs (constants / disk checks this tick).
// Process lifecycle and multi-GB downloads are deferred: default ensureStarted throws until that port lands.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../../core/strings';
import { localDataDir } from '../paths';
import type { BrainDeviceKind, LocalBrainKind, SettingsData } from '../settings';
import { BrainException } from './speechCleanup';

/** Whether "on this computer" is offered in the menus. On since 1.0.7. */
export const Offered = true;

export const EngineTag = 'b10701';

/** Windows zip names stay as in C# for download later; Linux looks for `llama-server` (no .exe). */
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

export function dir(): string {
  return join(localDataDir(), 'brain');
}

export function logPath(): string {
  return join(localDataDir(), 'brain.log');
}

function engineDirFor(kind: BrainDeviceKind): string {
  return join(dir(), kind === 'Gpu' ? `engine-${EngineTag}-vulkan` : `engine-${EngineTag}`);
}

/**
 * Path to llama-server binary for the device.
 * Windows keeps the C# zip layout (`llama-server.exe`); on Linux look for `llama-server` (no .exe).
 * Engine zip download still uses the Windows names above when that port lands.
 */
export function serverExeFor(kind: BrainDeviceKind): string {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return join(engineDirFor(kind), name);
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

export function hasGgufMagic(path: string): boolean {
  try {
    const fd = readFileSync(path);
    return fd.length >= 4 && fd[0] === 0x47 && fd[1] === 0x47 && fd[2] === 0x55 && fd[3] === 0x46; // GGUF
  } catch {
    return false;
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

/** Download of multi-GB models is not in this tick. Constants above are ready for a later port. */
export async function downloadAsync(_s: SettingsData, _onProgress: (p: { received: number; total: number; phase: string }) => void, _signal: AbortSignal): Promise<void> {
  throw new BrainException(t('скачивание мозга пока не перенесено', 'Brain download is not ported yet'));
}

export type LocalBrainRuntime = {
  isReady(s: SettingsData): boolean;
  readonly running: boolean;
  readonly endpointUrl: string;
  readonly apiKey: string;
  ensureStarted(s: SettingsData, tick: (sec: number) => void, signal: AbortSignal): Promise<void>;
};

/** Default runtime: disk IsReady; ensureStarted throws until the process port lands. */
export function createDefaultRuntime(): LocalBrainRuntime {
  return {
    isReady,
    get running() {
      return false;
    },
    get endpointUrl() {
      return 'http://127.0.0.1:0/v1';
    },
    get apiKey() {
      return '';
    },
    async ensureStarted(_s, _tick, _signal) {
      throw new BrainException(
        t('локальный сервер мозга ещё не запускается в этой сборке', 'local Brain server not started in this build'),
      );
    },
  };
}

let activeRuntime: LocalBrainRuntime = createDefaultRuntime();

/** Tests / FileBrain / Brain inject a fake that is always ready and never spawns a process. */
export function setRuntime(runtime: LocalBrainRuntime): void {
  activeRuntime = runtime;
}

export function getRuntime(): LocalBrainRuntime {
  return activeRuntime;
}

export function resetRuntime(): void {
  activeRuntime = createDefaultRuntime();
}

// Re-export unused download URL constants so a later tick can import them from one place.
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
export async function ensureStarted(s: SettingsData, tick: (sec: number) => void, signal: AbortSignal): Promise<void> {
  return activeRuntime.ensureStarted(s, tick, signal);
}

