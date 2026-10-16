// Manual update check against GitHub releases of zai-one/chawo-va.
// The app tells the user when a newer release exists and gives its page.
// It does not download or install the update. Port of src/App/Updater.cs (CheckAsync only).

export const RELEASES_API = 'https://api.github.com/repos/zai-one/chawo-va/releases/latest';
export const RELEASES_PAGE = 'https://github.com/zai-one/chawo-va/releases';
const ALLOWED_URL_PREFIX = 'https://github.com/zai-one/chawo-va/';

export type FetchLike = typeof fetch;

export interface UpdateInfo {
  version: string;
  url: string;
  notes: string;
}

export type CheckResult =
  | { kind: 'current' }
  | { kind: 'newer'; info: UpdateInfo }
  | { kind: 'error'; message: string };

/** Strip a leading v/V and parse major.minor.patch (extra pre-release suffix ignored for compare). */
export function parseVersion(text: string): number[] | null {
  const s = text.trim().replace(/^[vV]/, '');
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** True when remote is strictly newer than local (same rule as System.Version compare). */
export function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] !== l[i]) return r[i] > l[i];
  }
  return false;
}

export interface CheckOptions {
  /** Current app version (package.json / app.getVersion()). */
  localVersion: string;
  fetch?: FetchLike;
  /** Abort / idle timeout; default 20 s like WPF. */
  timeoutMs?: number;
  userAgent?: string;
  log?: (line: string) => void;
}

/**
 * Asks GitHub for the latest non-draft, non-prerelease release of zai-one/chawo-va.
 * Returns it only when it is newer than this build. Does not download anything.
 */
export async function checkLatest(opts: CheckOptions): Promise<CheckResult> {
  const local = opts.localVersion.trim();
  if (!parseVersion(local)) {
    return { kind: 'error', message: 'local version is not a number' };
  }
  const fetchFn = opts.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { kind: 'error', message: 'fetch is not available' };
  }
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(RELEASES_API, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': opts.userAgent ?? `ChawoVoiceAssistant/${local}`,
        'Cache-Control': 'no-cache',
      },
      signal: ac.signal,
    });
    if (res.status === 404) return { kind: 'current' };
    if (!res.ok) {
      return { kind: 'error', message: `GitHub answered ${res.status}` };
    }
    const root = (await res.json()) as Record<string, unknown>;
    if (root.draft === true || root.prerelease === true) return { kind: 'current' };
    const tag = typeof root.tag_name === 'string' ? root.tag_name : '';
    const verText = tag.trim().replace(/^[vV]/, '');
    if (!parseVersion(verText)) return { kind: 'current' };
    opts.log?.(`update check: local ${local}, remote ${verText} (${RELEASES_API})`);
    if (!isNewer(verText, local)) return { kind: 'current' };
    let html = typeof root.html_url === 'string' ? root.html_url : '';
    if (!html.toLowerCase().startsWith(ALLOWED_URL_PREFIX.toLowerCase())) {
      html = `${RELEASES_PAGE}/tag/v${verText}`;
    }
    const body = typeof root.body === 'string' ? root.body : '';
    return { kind: 'newer', info: { version: verText, url: html, notes: body } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ac.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
      return { kind: 'error', message: 'timeout' };
    }
    return { kind: 'error', message: msg };
  } finally {
    clearTimeout(timer);
  }
}
