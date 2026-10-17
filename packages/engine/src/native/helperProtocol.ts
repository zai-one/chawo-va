// Line protocol of the Windows native helper (ts/native/win, ChawoNative.exe). One line per message,
// fields split by single spaces, text as base64 UTF-8. Pure functions: tested without Windows.

export const PROTOCOL = 1;

export type InsertMode = 'Type' | 'Paste';
export type InsertResult = 'Done' | 'Blocked';

/** App → helper. */
export type HelperCommand =
  | { kind: 'hotkey'; vk: number }
  | { kind: 'arm'; on: boolean }
  /** «Озвучить» key (0 = off): "tts" on each press, the key swallowed. */
  | { kind: 'ttskey'; vk: number }
  /** Selection watching: "mup x y" after a drag or a double click with the left button. */
  | { kind: 'selwatch'; on: boolean }
  /** The selection via UI Automation only (no Ctrl+C). */
  | { kind: 'selprobe'; id: number }
  | { kind: 'insert'; id: number; mode: InsertMode; keep: boolean; restore: boolean; text: string }
  | { kind: 'copysel'; id: number }
  | { kind: 'selread'; id: number }
  | { kind: 'fg'; id: number }
  | { kind: 'ping'; id: number }
  | { kind: 'quit' };

/** Helper → app. */
export type HelperEvent =
  | { kind: 'ready'; protocol: number }
  | { kind: 'hookfail'; reason: string }
  | { kind: 'down' }
  | { kind: 'up' }
  | { kind: 'esc' }
  | { kind: 'tts' }
  /** Left button released after a drag or a double click, physical screen pixels. */
  | { kind: 'mup'; x: number; y: number }
  | { kind: 'ok'; id: number; result: InsertResult }
  | { kind: 'sel'; id: number; text: string | null }
  | { kind: 'fg'; id: number; process: string }
  | { kind: 'pong'; id: number }
  | { kind: 'err'; id: number; reason: string }
  | { kind: 'log'; text: string };

export const toB64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
export const fromB64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const bit = (b: boolean) => (b ? '1' : '0');

export function encode(c: HelperCommand): string {
  switch (c.kind) {
    case 'hotkey': return `hotkey ${Math.trunc(c.vk)}\n`;
    case 'arm': return `arm ${bit(c.on)}\n`;
    case 'ttskey': return `ttskey ${Math.trunc(c.vk)}\n`;
    case 'selwatch': return `selwatch ${bit(c.on)}\n`;
    case 'selprobe': return `selprobe ${c.id}\n`;
    case 'insert': return `insert ${c.id} ${c.mode} ${bit(c.keep)} ${bit(c.restore)} ${toB64(c.text)}\n`;
    case 'copysel': return `copysel ${c.id}\n`;
    case 'selread': return `selread ${c.id}\n`;
    case 'fg': return `fg ${c.id}\n`;
    case 'ping': return `ping ${c.id}\n`;
    case 'quit': return 'quit\n';
  }
}

/** One stdout line → event, or null for anything we do not understand (never throws). */
export function parse(line: string): HelperEvent | null {
  const p = line.trim().split(' ');
  const id = Number(p[1]);
  const hasId = p.length >= 2 && Number.isInteger(id);
  switch (p[0]) {
    case 'ready': return { kind: 'ready', protocol: Number(p[1]) || 0 };
    case 'hookfail': return { kind: 'hookfail', reason: fromB64(p[1] ?? '') };
    case 'down': case 'up': case 'esc': case 'tts': return { kind: p[0] };
    case 'mup': {
      const x = Number(p[1]);
      const y = Number(p[2]);
      return Number.isInteger(x) && Number.isInteger(y) ? { kind: 'mup', x, y } : null;
    }
    case 'ok':
      return hasId && (p[2] === 'Done' || p[2] === 'Blocked') ? { kind: 'ok', id, result: p[2] } : null;
    case 'sel':
      if (!hasId || p.length < 3) return null;
      return { kind: 'sel', id, text: p[2] === '-' ? null : fromB64(p[2]) };
    case 'fg': return hasId ? { kind: 'fg', id, process: fromB64(p[2] ?? '') } : null;
    case 'pong': return hasId ? { kind: 'pong', id } : null;
    case 'err': return hasId ? { kind: 'err', id, reason: p[2] ?? 'error' } : null;
    case 'log': return { kind: 'log', text: fromB64(p[1] ?? '') };
    default: return null;
  }
}

/** Splits a stdout stream into lines across chunk boundaries. */
export class LineSplitter {
  private rest = '';
  push(chunk: string): string[] {
    const all = this.rest + chunk;
    const lines = all.split('\n');
    this.rest = lines.pop() ?? '';
    // A runaway line without a newline is not ours: drop it rather than grow forever.
    if (this.rest.length > 16 * 1024 * 1024) this.rest = '';
    return lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }
}
