// Known meeting apps: process-name / window-title heuristics (Windows + Linux). Pure matching is
// unit-tested; listing processes needs an injected exec. On macOS the list is empty and
// appsSupported is false — calendar .ics still works elsewhere.

export interface MeetingAppHit {
  /** Canonical short name shown in the UI (Zoom, Teams, …). */
  app: string;
  /** Process name or window title that matched. */
  matched: string;
}

/** Lowercased exe stems (without .exe) → display name. */
export const MEETING_PROCESSES: Readonly<Record<string, string>> = {
  zoom: 'Zoom',
  cpthost: 'Zoom',
  zoomusinstaller: 'Zoom',
  teams: 'Teams',
  'ms-teams': 'Teams',
  msteams: 'Teams',
  'teams-for-linux': 'Teams',
  skype: 'Skype',
  skypeapp: 'Skype',
  skypeforlinux: 'Skype',
  discord: 'Discord',
  webex: 'Webex',
  webexhost: 'Webex',
  webexmta: 'Webex',
  ciscocollabhost: 'Webex',
  atmgr: 'Webex',
  telemost: 'Телемост',
  yandextelemost: 'Телемост',
  // Browser hosts alone are not enough — titles are checked below.
};

/**
 * Window-title fragments (lowercased) that mean a browser meeting tab is open.
 * Matched only when the process looks like a browser.
 */
export const MEETING_TITLE_HINTS: ReadonlyArray<{ needle: string; app: string }> = [
  { needle: 'zoom meeting', app: 'Zoom' },
  { needle: 'zoom webinar', app: 'Zoom' },
  { needle: 'microsoft teams', app: 'Teams' },
  { needle: '| microsoft teams', app: 'Teams' },
  { needle: 'google meet', app: 'Google Meet' },
  { needle: 'meet.google.com', app: 'Google Meet' },
  { needle: 'телемост', app: 'Телемост' },
  { needle: 'telemost', app: 'Телемост' },
  { needle: 'telemost.yandex', app: 'Телемост' },
  { needle: 'webex meeting', app: 'Webex' },
  { needle: 'skype', app: 'Skype' },
];

const BROWSER_STEMS = new Set([
  'chrome',
  'msedge',
  'edge',
  'firefox',
  'opera',
  'brave',
  'chromium',
  'yandex',
  'browser',
  'vivaldi',
]);

export function stemOf(processName: string): string {
  return processName.trim().toLowerCase().replace(/\.exe$/i, '');
}

export function isBrowserStem(stem: string): boolean {
  return BROWSER_STEMS.has(stem) || stem.includes('chrome') || stem.includes('firefox') || stem.includes('yandex');
}

/** Match one process name (optional MainWindowTitle) against the known list. */
export function matchMeetingProcess(processName: string, windowTitle = ''): MeetingAppHit | null {
  const stem = stemOf(processName);
  if (!stem) return null;
  const byProc = MEETING_PROCESSES[stem];
  if (byProc) return { app: byProc, matched: processName.trim() || stem };

  const title = windowTitle.trim().toLowerCase();
  if (!title || !isBrowserStem(stem)) return null;
  for (const h of MEETING_TITLE_HINTS) {
    if (title.includes(h.needle)) return { app: h.app, matched: windowTitle.trim() || processName };
  }
  return null;
}

/** Deduplicate hits by app name, keeping the first match. */
export function matchMeetingProcesses(
  rows: ReadonlyArray<{ name: string; title?: string }>,
): MeetingAppHit[] {
  const out: MeetingAppHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const hit = matchMeetingProcess(r.name, r.title ?? '');
    if (!hit || seen.has(hit.app)) continue;
    seen.add(hit.app);
    out.push(hit);
  }
  return out;
}

export type ExecLike = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export interface ListMeetingAppsDeps {
  platform?: NodeJS.Platform;
  exec?: ExecLike;
  timeoutMs?: number;
}

/** PowerShell: one line per process with a window — `ProcessName|MainWindowTitle`. */
export const WINDOWS_LIST_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Get-Process | Where-Object { $_.ProcessName } | ForEach-Object {',
  '  $t = $_.MainWindowTitle',
  '  if (-not $t) { $t = "" }',
  '  "{0}|{1}" -f $_.ProcessName, ($t -replace "[\\r\\n\\|]", " ")',
  '}',
].join('\n');

export function parseWindowsProcessList(out: string): Array<{ name: string; title: string }> {
  const rows: Array<{ name: string; title: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const bar = s.indexOf('|');
    if (bar < 0) {
      rows.push({ name: s, title: '' });
      continue;
    }
    rows.push({ name: s.slice(0, bar), title: s.slice(bar + 1) });
  }
  return rows;
}

/** `ps -eo comm=` lines → process name rows (no window title). */
export function parseLinuxProcessList(out: string): Array<{ name: string; title: string }> {
  const rows: Array<{ name: string; title: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    let name = line.trim();
    if (!name) continue;
    // Skip rare header if present; basename when a path slips through.
    if (name === 'COMM' || name === 'COMMAND') continue;
    const slash = name.lastIndexOf('/');
    if (slash >= 0) name = name.slice(slash + 1);
    if (!name) continue;
    rows.push({ name, title: '' });
  }
  return rows;
}

/** True when process heuristics are implemented for this OS. */
export function meetingAppsSupported(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'linux';
}

/**
 * Running meeting apps on this machine. Windows: PowerShell process list.
 * Linux: `ps -eo comm=` (process names only; no window titles without optional tools).
 * Elsewhere: unsupported (empty list) — callers use appsSupported === false.
 */
export async function listMeetingApps(deps: ListMeetingAppsDeps = {}): Promise<{
  supported: boolean;
  hits: MeetingAppHit[];
}> {
  const platform = deps.platform ?? process.platform;
  if (!meetingAppsSupported(platform)) return { supported: false, hits: [] };
  const exec = deps.exec;
  if (!exec) return { supported: true, hits: [] };
  const timeout = deps.timeoutMs ?? 4000;
  try {
    if (platform === 'linux') {
      const out = await exec('ps', ['-eo', 'comm='], timeout);
      return { supported: true, hits: matchMeetingProcesses(parseLinuxProcessList(out)) };
    }
    const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST_SCRIPT], timeout);
    return { supported: true, hits: matchMeetingProcesses(parseWindowsProcessList(out)) };
  } catch {
    return { supported: true, hits: [] };
  }
}
