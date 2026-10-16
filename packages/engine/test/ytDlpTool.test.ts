// yt-dlp download (sha256 from SHA2-256SUMS, --version check) and one fetch through a fake yt-dlp
// shell script. No network: fetch is stubbed. POSIX only (the fakes are /bin/sh scripts).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '@chawo/core/strings';
import { sha256Hex } from '../src/models/modelDownloader';
import * as YtDlp from '../src/file/ytDlpTool';

const posix = process.platform !== 'win32';
beforeAll(() => applyLanguage('Russian'));

let root: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CHAWO_LOCALAPPDATA;
  root = mkdtempSync(join(tmpdir(), 'chawo-ytdlp-'));
  process.env.CHAWO_LOCALAPPDATA = root;
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CHAWO_LOCALAPPDATA;
  else process.env.CHAWO_LOCALAPPDATA = saved;
});

/** A >1 MB /bin/sh "yt-dlp" that prints a version (the padding is a comment). */
const fakeBinary = (version = '2026.08.19') => Buffer.from(`#!/bin/sh\necho ${version}\nexit 0\n#${'x'.repeat(1_100_000)}\n`);

function stubNet(files: Record<string, Buffer | string>) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const body = files[url];
    if (body === undefined) return new Response('no', { status: 404 });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
  });
  return urls;
}

describe.runIf(posix)('YtDlp.downloadAsync', () => {
  const base = 'https://dl.test/';
  it('downloads the build, checks sha256 and --version, installs it', async () => {
    const bin = fakeBinary();
    const urls = stubNet({ [base + 'SHA2-256SUMS']: `${sha256Hex(bin)}  yt-dlp_linux\n${'0'.repeat(64)}  yt-dlp\n`, [base + 'yt-dlp_linux']: bin });
    const lines: string[] = [];
    const p = await YtDlp.downloadAsync((l) => lines.push(l), undefined, base, 'yt-dlp_linux');
    expect(p).toBe(YtDlp.exePath());
    expect(urls).toEqual([base + 'SHA2-256SUMS', base + 'yt-dlp_linux']);
    expect(YtDlp.isManaged()).toBe(true);
    expect(YtDlp.find('')).toBe(YtDlp.exePath());
    expect(lines.at(-1)).toBe(`yt-dlp 2026.08.19 готов: ${YtDlp.exePath()}`);
    expect(YtDlp.statusLine()).toBe(`yt-dlp: ${YtDlp.exePath()}`);
  });

  it('refuses a checksum mismatch and keeps the old build', async () => {
    const old = fakeBinary('2025.01.01');
    mkdirSync(YtDlp.installDir(), { recursive: true });
    writeFileSync(YtDlp.exePath(), old);
    stubNet({ [base + 'SHA2-256SUMS']: `${'1'.repeat(64)}  yt-dlp_linux\n`, [base + 'yt-dlp_linux']: fakeBinary() });
    await expect(YtDlp.downloadAsync(undefined, undefined, base, 'yt-dlp_linux')).rejects.toThrow('контрольная сумма yt-dlp не совпала');
    expect(readFileSync(YtDlp.exePath()).equals(old)).toBe(true);
    expect(existsSync(YtDlp.exePath() + '.download')).toBe(false);
  });

  it('refuses a build missing from SHA2-256SUMS', async () => {
    stubNet({ [base + 'SHA2-256SUMS']: `${'1'.repeat(64)}  yt-dlp\n` });
    await expect(YtDlp.downloadAsync(undefined, undefined, base, 'yt-dlp_linux')).rejects.toThrow('not listed');
  });
});

describe.runIf(posix)('YtDlp.fetchAudio', () => {
  function script(body: string): string {
    const p = join(root, 'fake-yt-dlp');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  it('passes the link after --, reports progress and resolves with the saved file', async () => {
    const out = join(root, 'out');
    const saved = join(out, 'Ролик [abc].m4a');
    const argsFile = join(root, 'args.txt');
    const exe = script(
      `printf '%s\\n' "$@" > '${argsFile}'\nmkdir -p '${out}'\n: > '${saved}'\n` +
        `echo 'chawo-progress   5.0%'\necho 'chawo-progress  50.0%'\necho 'chawo-progress 100.0%'\necho '[download] noise'\nprintf 'chawo-file %s\\n' '${saved}'`,
    );
    const seen: number[] = [];
    const p = await YtDlp.fetchAudio('https://x.test/v?a=1', out, { exe, ffmpeg: null, jsRuntime: null, progress: (n) => seen.push(n) });
    expect(p).toBe(saved);
    expect(seen).toEqual([5, 50, 100]);
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args.slice(-2)).toEqual(['--', 'https://x.test/v?a=1']);
    expect(args[args.indexOf('-P') + 1]).toBe(out);
  });

  it('turns a yt-dlp error into its ERROR line', async () => {
    const exe = script(`echo 'WARNING: slow' >&2\necho 'ERROR: [generic] Unsupported URL: https://x.test/' >&2\nexit 1`);
    await expect(YtDlp.fetchAudio('https://x.test/', join(root, 'o'), { exe, ffmpeg: null, jsRuntime: null })).rejects.toThrow(
      '[generic] Unsupported URL: https://x.test/',
    );
  });

  it('fails when no file was reported', async () => {
    const exe = script('exit 0');
    await expect(YtDlp.fetchAudio('https://x.test/', join(root, 'o'), { exe, ffmpeg: null, jsRuntime: null })).rejects.toThrow('не сообщил');
  });

  it('stops on abort and on the timeout', async () => {
    const exe = script('sleep 5');
    const ctrl = new AbortController();
    const p = YtDlp.fetchAudio('https://x.test/', join(root, 'o'), { exe, ffmpeg: null, jsRuntime: null, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    await expect(p).rejects.toThrow('aborted');
    await expect(YtDlp.fetchAudio('https://x.test/', join(root, 'o'), { exe, ffmpeg: null, jsRuntime: null, timeoutMs: 150 })).rejects.toThrow('30 минут');
  });

  it('without yt-dlp says so', async () => {
    await expect(YtDlp.fetchAudio('https://x.test/', join(root, 'o'), { exe: null })).rejects.toThrow('yt-dlp не найден');
  });
});
