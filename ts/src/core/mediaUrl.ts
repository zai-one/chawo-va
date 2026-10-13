// Pure helpers for «Расшифровать по ссылке»: which input counts as a link, the yt-dlp command line
// and its stdout lines, the release asset for this OS and its line in SHA2-256SUMS. No I/O here, so
// the CLI and tests can use it without Electron.

export type MediaUrlCheck = { ok: true; url: string } | { ok: false; reason: 'empty' | 'scheme' | 'invalid' | 'long' };

export const MAX_URL_LENGTH = 2048;

/** Only http(s) links; file:, data:, javascript: and bare words are refused (yt-dlp would read local files). */
export function parseMediaUrl(input: string): MediaUrlCheck {
  let s = (input ?? '').trim().replace(/^<|>$/g, '');
  if (!s) return { ok: false, reason: 'empty' };
  if (s.length > MAX_URL_LENGTH) return { ok: false, reason: 'long' };
  // «youtube.com/watch?v=…» without a scheme is common when copied from the address bar.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+([/?#:]|$)/.test(s)) s = 'https://' + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (!u.hostname) return { ok: false, reason: 'invalid' };
  return { ok: true, url: u.toString() };
}

export interface YtDlpArgsInput {
  url: string;
  outDir: string;
  /** Our or PATH ffmpeg; without it yt-dlp still saves a single audio stream as is. */
  ffmpeg?: string | null;
  /** A node-compatible runtime for YouTube's JS challenges (Electron itself with ELECTRON_RUN_AS_NODE). */
  jsRuntime?: string | null;
}

export const PROGRESS_TAG = 'chawo-progress ';
export const FILE_TAG = 'chawo-file ';

/**
 * One audio stream, no playlist, no user config/cookies, a readable name with the id, progress and
 * the final path on stdout with our own tags. "--" keeps the URL from being read as an option.
 */
export function ytDlpArgs(o: YtDlpArgsInput): string[] {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--newline',
    '--no-colors',
    '--no-mtime',
    '--windows-filenames',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
    '-P', o.outDir,
    '-o', '%(title).90B [%(id)s].%(ext)s',
    '--progress',
    '--progress-template', `download:${PROGRESS_TAG}%(progress._percent_str)s`,
    '--print', `after_move:${FILE_TAG}%(filepath)s`,
    '--no-simulate',
  ];
  if (o.ffmpeg) args.push('--ffmpeg-location', o.ffmpeg);
  if (o.jsRuntime) args.push('--js-runtimes', `node:${o.jsRuntime}`);
  args.push('--', o.url);
  return args;
}

export type YtDlpLine = { kind: 'progress'; percent: number } | { kind: 'file'; path: string } | null;

export function parseYtDlpLine(raw: string): YtDlpLine {
  const line = raw.replace(/\r$/, '');
  if (line.startsWith(FILE_TAG)) {
    const path = line.slice(FILE_TAG.length).trim();
    return path ? { kind: 'file', path } : null;
  }
  if (line.startsWith(PROGRESS_TAG)) {
    const m = /(\d+(?:\.\d+)?)%/.exec(line.slice(PROGRESS_TAG.length));
    if (!m) return null;
    const p = Math.max(0, Math.min(100, Number(m[1])));
    return Number.isFinite(p) ? { kind: 'progress', percent: p } : null;
  }
  return null;
}

/** The standalone yt-dlp build for this OS from the official GitHub release, or null. */
export function ytDlpAsset(platform: string, arch: string): string | null {
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64' ? 'yt-dlp.exe' : null;
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') {
    if (arch === 'x64') return 'yt-dlp_linux';
    if (arch === 'arm64') return 'yt-dlp_linux_aarch64';
  }
  return null;
}

/** sha256 for one file from a SHA2-256SUMS body ("<hex>  <name>" per line), lowercased. */
export function shaFromSums(sums: string, name: string): string | null {
  for (const raw of sums.split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(raw.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

/** Last useful stderr line of yt-dlp ("ERROR: [youtube] …: Video unavailable"), shortened. */
export function ytDlpError(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith('ERROR:')) ?? lines[lines.length - 1] ?? '';
  const s = err.replace(/^ERROR:\s*/, '');
  return s.length > 300 ? s.slice(0, 297) + '…' : s;
}
