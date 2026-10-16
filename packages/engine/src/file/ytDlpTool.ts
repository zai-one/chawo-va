// Optional yt-dlp for «Расшифровать по ссылке». Not bundled: the official standalone build is
// downloaded from the yt-dlp GitHub release only when the user presses the button and is checked
// against the SHA2-256SUMS of the same release; a yt-dlp on PATH is used as is. The audio lands in
// a plain folder (Downloads/Chawo), then goes through the usual local file queue, so only the
// download itself touches the network.

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { t } from '@chawo/core/strings';
import { parseYtDlpLine, shaFromSums, ytDlpArgs, ytDlpAsset, ytDlpError } from '@chawo/core/mediaUrl';
import { fetchFile, sha256File } from '../models/modelDownloader';
import { toolsDir } from './ffmpegTool';
import * as Ffmpeg from './ffmpegTool';

export const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
/** A video page can take a while to resolve; an hour of audio is ~60 MB, so 30 min is generous. */
export const FETCH_TIMEOUT_MS = 30 * 60 * 1000;

const isWin = () => process.platform === 'win32';
export const exeName = () => (isWin() ? 'yt-dlp.exe' : 'yt-dlp');
export const installDir = () => join(toolsDir(), 'yt-dlp');
export const exePath = () => join(installDir(), exeName());
export const asset = () => ytDlpAsset(process.platform, process.arch);

/** The official build exists for Windows, macOS and Linux x64/arm64. */
export const canDownload = () => asset() !== null;

export function isManaged(): boolean {
  try {
    return existsSync(exePath()) && statSync(exePath()).size > 1_000_000;
  } catch {
    return false;
  }
}

export function find(pathEnv = process.env.PATH ?? ''): string | null {
  if (isManaged()) return exePath();
  for (const raw of pathEnv.split(delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const candidate = join(dir, exeName());
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* PATH may be odd */
    }
  }
  return null;
}

export function statusLine(): string {
  const found = find();
  if (!found) {
    return canDownload()
      ? t(
          'yt-dlp нет. Кнопка ниже скачает официальную сборку с GitHub (~20–40 МБ) и проверит её контрольную сумму.',
          'yt-dlp is missing. The button below downloads the official build from GitHub (~20–40 MB) and checks its checksum.',
        )
      : t('yt-dlp нет. Установите его пакетным менеджером (например, pipx install yt-dlp).', 'yt-dlp is missing. Install it with your package manager (e.g. pipx install yt-dlp).');
  }
  return found === exePath() ? `yt-dlp: ${found}` : t(`yt-dlp в PATH: ${found}`, `yt-dlp on PATH: ${found}`);
}

/** Download (or refresh) the standalone yt-dlp, verify sha256, check `--version`, then swap it in. */
export async function downloadAsync(
  progress: ((line: string) => void) | undefined,
  signal?: AbortSignal,
  base = RELEASE_BASE,
  name = asset(),
): Promise<string> {
  if (!name) throw new Error('no yt-dlp build for this OS');
  mkdirSync(installDir(), { recursive: true });
  const staged = join(installDir(), exeName() + '.download');
  rmSync(staged, { force: true });
  try {
    progress?.(t('Скачиваю yt-dlp…', 'Downloading yt-dlp…'));
    const sumsRes = await fetch(base + 'SHA2-256SUMS', { signal, redirect: 'follow' });
    if (!sumsRes.ok) throw new Error(`SHA2-256SUMS: HTTP ${sumsRes.status}`);
    const expected = shaFromSums(await sumsRes.text(), name);
    if (!expected) throw new Error(`${name} is not listed in SHA2-256SUMS`);

    let lastMb = -4;
    await fetchFile(
      base + name,
      staged,
      0,
      (got) => {
        const mb = Math.floor(got / (1024 * 1024));
        if (mb - lastMb >= 4) {
          lastMb = mb;
          progress?.(t(`Скачиваю yt-dlp… ${mb} МБ`, `Downloading yt-dlp… ${mb} MB`));
        }
      },
      signal,
    );
    const got = await sha256File(staged, signal);
    if (got !== expected) throw new Error(t('контрольная сумма yt-dlp не совпала', 'yt-dlp checksum mismatch'));
    if (!isWin()) chmodSync(staged, 0o755);
    const version = await runVersion(staged, signal);
    rmSync(exePath(), { force: true });
    renameSync(staged, exePath());
    progress?.(t(`yt-dlp ${version} готов: ${exePath()}`, `yt-dlp ${version} ready: ${exePath()}`));
    return exePath();
  } finally {
    rmSync(staged, { force: true });
  }
}

function runVersion(exe: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, signal });
    let out = '';
    p.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error('yt-dlp --version failed'))));
  });
}

export interface FetchAudioOptions {
  progress?: (percent: number) => void;
  signal?: AbortSignal;
  exe?: string | null;
  ffmpeg?: string | null;
  /** Electron's own binary (or node in the CLI) runs YouTube's JS challenge (no deno install needed). */
  jsRuntime?: string | null;
  timeoutMs?: number;
}

/** Runs yt-dlp for one link and resolves with the saved audio path. */
export function fetchAudio(url: string, outDir: string, o: FetchAudioOptions = {}): Promise<string> {
  const exe = o.exe === undefined ? find() : o.exe;
  if (!exe) return Promise.reject(new Error(t('yt-dlp не найден', 'yt-dlp not found')));
  mkdirSync(outDir, { recursive: true });
  const ffmpeg = o.ffmpeg === undefined ? Ffmpeg.find() : o.ffmpeg;
  // Electron (with ELECTRON_RUN_AS_NODE) in the app, plain node in the CLI: both pass yt-dlp's JS challenges.
  const jsRuntime = o.jsRuntime === undefined ? process.execPath : o.jsRuntime;
  const args = ytDlpArgs({ url, outDir, ffmpeg, jsRuntime });
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } as NodeJS.ProcessEnv;
  if (jsRuntime) env.ELECTRON_RUN_AS_NODE = '1';
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Error('aborted'));
    // Own process group on POSIX so Stop also ends the ffmpeg/node children yt-dlp started.
    const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, detached: !isWin() });
    let file: string | null = null;
    let err = '';
    let buf = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => killTree(p.pid);
    const timer = setTimeout(() => {
      kill();
      done(() => reject(new Error(t('yt-dlp не уложился в 30 минут', 'yt-dlp took longer than 30 minutes'))));
    }, o.timeoutMs ?? FETCH_TIMEOUT_MS);
    const onAbort = () => {
      kill();
      done(() => reject(new Error('aborted')));
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    p.stdout.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = parseYtDlpLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (line?.kind === 'progress') o.progress?.(line.percent);
        else if (line?.kind === 'file') file = line.path;
      }
    });
    p.stderr.on('data', (b: Buffer) => {
      if (err.length < 16384) err += b.toString('utf8');
    });
    p.on('error', (e) => done(() => reject(e)));
    p.on('close', (code) => {
      const last = parseYtDlpLine(buf);
      if (last?.kind === 'file') file = last.path;
      done(() => {
        if (code !== 0) return reject(new Error(ytDlpError(err) || `yt-dlp exit ${code}`));
        if (!file || !existsSync(file)) return reject(new Error(t('yt-dlp не сообщил, куда сохранил файл', 'yt-dlp did not report the saved file')));
        resolve(file);
      });
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWin()) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    else process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}
