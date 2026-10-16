// One elevated command that allows inbound TCP for the Hermes port (Windows only). Windows shows the
// usual UAC prompt. The rule is named so it can be found in Windows Defender Firewall.
// Elsewhere the app does not touch the OS firewall: binding 0.0.0.0 needs no admin rights, and
// ufw/firewalld/macOS rules stay the user's call (the «Сеть» page says so). Port of HermesFirewall.cs.

import { spawn, type SpawnOptions } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Log from '../log';

export const RULE_NAME = 'Chawo Voice Assistant';
/** Rule name used before 1.17.0; removed whenever the button runs. */
const LEGACY_RULE_NAME = 'Giga Pisar Hermes';
const WAIT_MS = 120_000;

export interface FirewallResult {
  ok: boolean;
  error: string;
  /** False when nothing was attempted (not Windows). */
  attempted: boolean;
}

type Spawn = (cmd: string, args: string[], opts: SpawnOptions) => import('node:child_process').ChildProcess;

export interface FirewallDeps {
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  tempDir?: () => string;
  waitMs?: number;
}

const psQuote = (text: string) => "'" + text.replace(/'/g, "''") + "'";

export function firewallScript(port: number): string {
  // delete is best-effort (it fails when the rule is not there yet). add decides the exit code.
  return '@echo off\r\n' +
    `netsh advfirewall firewall delete rule name="${LEGACY_RULE_NAME}" >nul 2>&1\r\n` +
    `netsh advfirewall firewall delete rule name="${RULE_NAME}" protocol=TCP localport=${port} >nul 2>&1\r\n` +
    `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow protocol=TCP localport=${port}\r\n` +
    'exit /b %ERRORLEVEL%\r\n';
}

/** Adds an inbound allow rule for every profile. ok=false if UAC is cancelled or netsh fails. */
export function tryOpenPort(port: number, deps: FirewallDeps = {}): Promise<FirewallResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return Promise.resolve({ ok: true, error: '', attempted: false });
  const run = deps.spawn ?? (spawn as unknown as Spawn);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: FirewallResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const bat = join((deps.tempDir ?? tmpdir)(), 'chawo-voice-assistant-firewall.cmd');
      writeFileSync(bat, firewallScript(port));
      // One UAC prompt. -Wait so we know whether the rule landed before we bind.
      const script =
        "$p = Start-Process -FilePath cmd.exe -ArgumentList @('/c', " + psQuote(bat) + ') ' +
        '-Verb RunAs -WindowStyle Hidden -Wait -PassThru; ' +
        'if ($null -eq $p) { exit 1 }; exit $p.ExitCode';
      const child = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* gone */
        }
        done({ ok: false, error: 'timed out waiting for the firewall prompt', attempted: true });
      }, deps.waitMs ?? WAIT_MS);
      child.once('error', (e) => {
        clearTimeout(timer);
        done({ ok: false, error: e.message || 'powershell did not start', attempted: true });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        done(code === 0 ? { ok: true, error: '', attempted: true } : { ok: false, error: `netsh exit ${code ?? -1}`, attempted: true });
      });
    } catch (e) {
      done({ ok: false, error: e instanceof Error ? e.message : String(e), attempted: true });
    }
  });
}

/** Opens the Windows Firewall console so the rule can be checked by hand. No-op elsewhere. */
export function openConsole(deps: FirewallDeps = {}): void {
  if ((deps.platform ?? process.platform) !== 'win32') return;
  try {
    const run = deps.spawn ?? (spawn as unknown as Spawn);
    const child = run('mmc.exe', ['WF.msc'], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (e) => Log.write(`firewall console: ${e.message}`));
    child.unref();
  } catch (e) {
    Log.write(`firewall console: ${e instanceof Error ? e.message : String(e)}`);
  }
}
