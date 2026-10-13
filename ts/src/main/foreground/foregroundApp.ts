// Which program has the focus when the dictation key goes down (for per-app modes). Best effort and
// local only: nothing leaves the computer, the window title is kept in memory for matching and never
// logged or saved. Called only while at least one per-app rule exists.
//   Windows: PowerShell + GetForegroundWindow until the native helper (ts/feat-win-native, `fg`) is
//            merged; then that helper answers instead and this path stays as the fallback.
//   Linux:   xprop on X11 / XWayland (_NET_ACTIVE_WINDOW → _NET_WM_PID, WM_CLASS, _NET_WM_NAME).
//   macOS:   osascript (System Events: frontmost process name).

import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import type { ForegroundApp } from '../../core/appRules';
import { exeKey } from '../../core/appRules';

export type ExecLike = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export const realExec: ExecLike = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export interface ForegroundDeps {
  platform?: NodeJS.Platform;
  exec?: ExecLike;
  /** /proc/<pid>/exe → executable path (Linux). */
  procExe?: (pid: number) => string | null;
  /** Our own executable names: the focus on Chawo itself matches no rule. */
  selfNames?: readonly string[];
  timeoutMs?: number;
}

const TIMEOUT_MS = 2500;

function defaultProcExe(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    try {
      return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
}

function defaultSelfNames(): string[] {
  const names = new Set<string>([exeKey(basename(process.execPath)), 'chawo voice assistant', 'chawovoiceassistant', 'chawo-va']);
  return [...names].filter((x) => x.length > 0);
}

// ── Windows ────────────────────────────────────────────────

/** UTF-8 JSON on stdout: {"exe":"Telegram.exe","title":"…"} or nothing when there is no window. */
export const WINDOWS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -Namespace ChawoFg -Name W -MemberDefinition \'',
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);',
  '\'',
  '$h = [ChawoFg.W]::GetForegroundWindow()',
  'if ($h -eq [System.IntPtr]::Zero) { exit 0 }',
  '$sb = New-Object System.Text.StringBuilder 512',
  '[void][ChawoFg.W]::GetWindowText($h, $sb, 512)',
  '$fgPid = 0',
  '[void][ChawoFg.W]::GetWindowThreadProcessId($h, [ref]$fgPid)',
  '$p = Get-Process -Id $fgPid',
  '$exe = $p.ProcessName + ".exe"',
  '@{ exe = $exe; title = $sb.ToString() } | ConvertTo-Json -Compress',
].join('\n');

export function parseWindowsOutput(out: string): ForegroundApp | null {
  const line = out.trim().split(/\r?\n/).pop() ?? '';
  if (!line.startsWith('{')) return null;
  try {
    const o = JSON.parse(line) as { exe?: unknown; title?: unknown };
    const exe = typeof o.exe === 'string' ? o.exe : '';
    if (!exe) return null;
    return { exe, title: typeof o.title === 'string' ? o.title : '' };
  } catch {
    return null;
  }
}

// ── Linux (X11) ───────────────────────────────────────────

/** `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007` → "0x3a00007"; 0x0 (no window) → null. */
export function parseActiveWindow(out: string): string | null {
  const m = /#\s*(0x[0-9a-f]+)/i.exec(out);
  if (!m || /^0x0+$/i.test(m[1]!)) return null;
  return m[1]!;
}

/** Decodes the C-escaped string xprop prints (UTF8_STRING: \" \\ and \ooo octal bytes). */
function unescapeXprop(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1));
      if (oct) {
        bytes.push(parseInt(oct[0], 8));
        i += oct[0].length;
        continue;
      }
      i++;
      bytes.push(...Buffer.from(s[i]!, 'utf8'));
      continue;
    }
    bytes.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface XWindowInfo {
  pid: number | null;
  wmClass: string[];
  title: string;
}

export function parseWindowProps(out: string): XWindowInfo {
  const pidM = /_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/.exec(out);
  const classM = /WM_CLASS\([^)]*\)\s*=\s*(.*)$/m.exec(out);
  const nameM = /_NET_WM_NAME\([^)]*\)\s*=\s*"(.*)"\s*$/m.exec(out) ?? /WM_NAME\([^)]*\)\s*=\s*"(.*)"\s*$/m.exec(out);
  const wmClass = classM ? [...classM[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unescapeXprop(m[1]!)) : [];
  return {
    pid: pidM ? Number(pidM[1]) : null,
    wmClass,
    title: nameM ? unescapeXprop(nameM[1]!) : '',
  };
}

// ── macOS ─────────────────────────────────────────────────

export const MAC_SCRIPT = 'tell application "System Events" to get name of first application process whose frontmost is true';

/** Detects the focused program. Any failure (no X server, no PowerShell, timeout) is null. */
export async function detectForeground(deps: ForegroundDeps = {}): Promise<ForegroundApp | null> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? realExec;
  const timeout = deps.timeoutMs ?? TIMEOUT_MS;
  const self = new Set((deps.selfNames ?? defaultSelfNames()).map(exeKey));
  let app: ForegroundApp | null = null;
  try {
    if (platform === 'win32') {
      app = parseWindowsOutput(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT], timeout));
    } else if (platform === 'linux') {
      const id = parseActiveWindow(await exec('xprop', ['-root', '_NET_ACTIVE_WINDOW'], timeout));
      if (id) {
        const info = parseWindowProps(await exec('xprop', ['-id', id, '_NET_WM_PID', 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME'], timeout));
        const path = info.pid !== null ? (deps.procExe ?? defaultProcExe)(info.pid) : null;
        const exe = path ? basename(path) : (info.wmClass[0] ?? info.wmClass[1] ?? '');
        if (exe) app = { exe, title: info.title };
      }
    } else if (platform === 'darwin') {
      const name = (await exec('osascript', ['-e', MAC_SCRIPT], timeout)).trim();
      if (name) app = { exe: name, title: '' };
    }
  } catch {
    return null;
  }
  if (app && self.has(exeKey(app.exe))) return null;
  return app;
}
