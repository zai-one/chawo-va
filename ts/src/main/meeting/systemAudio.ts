// Where the «computer sound» of a meeting comes from on each OS.
// Windows: Chromium's WASAPI loopback through getDisplayMedia (main answers the request with
// `audio: 'loopback'`, the video track is dropped at once). Linux: the PulseAudio/PipeWire monitor
// of the default output, which Chromium lists as an ordinary input («Monitor of …»). macOS: not yet
// (needs ScreenCaptureKit flags and a Mac to test), so meetings record the microphone only there.

import { execFile } from 'node:child_process';

export type SystemAudioMode = 'loopback' | 'monitor' | 'none';

export function systemAudioMode(platform: NodeJS.Platform = process.platform): SystemAudioMode {
  if (platform === 'win32') return 'loopback';
  if (platform === 'linux') return 'monitor';
  return 'none';
}

export interface PulseSource {
  name: string;
  description: string;
}

/** `LC_ALL=C pactl list sources` → name/description pairs. */
export function parsePactlSources(text: string): PulseSource[] {
  const out: PulseSource[] = [];
  let cur: PulseSource | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^Source #\d+/.test(line)) {
      cur = { name: '', description: '' };
      out.push(cur);
    } else if (cur && line.startsWith('Name:')) cur.name = line.slice(5).trim();
    else if (cur && line.startsWith('Description:')) cur.description = line.slice(12).trim();
  }
  return out.filter((s) => s.name);
}

/** Label Chromium shows for the monitor of the default output, or '' when it cannot be told. */
export function defaultMonitorLabel(defaultSink: string, sources: readonly PulseSource[]): string {
  if (!defaultSink) return '';
  return sources.find((s) => s.name === `${defaultSink}.monitor`)?.description ?? '';
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, LC_ALL: 'C' }, timeout: 3000, windowsHide: true }, (err, stdout) =>
      resolve(err ? '' : String(stdout)),
    );
  });
}

/** Linux only: asks pactl (present with PulseAudio and PipeWire-pulse); '' when it is missing. */
export async function linuxDefaultMonitorLabel(): Promise<string> {
  const sink = (await run('pactl', ['get-default-sink'])).trim();
  if (!sink) return '';
  return defaultMonitorLabel(sink, parsePactlSources(await run('pactl', ['list', 'sources'])));
}

export interface InputDevice {
  deviceId: string;
  label: string;
}

const MONITOR = /^(monitor of|монитор)\b/i;

/** The input that carries the computer sound: the default output's monitor, else the first monitor. */
export function pickMonitor(devices: readonly InputDevice[], preferredLabel: string): InputDevice | null {
  const usable = devices.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  if (preferredLabel) {
    const exact = usable.find((d) => d.label === preferredLabel);
    if (exact) return exact;
  }
  return usable.find((d) => MONITOR.test(d.label)) ?? null;
}
