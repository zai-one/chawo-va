import { describe, expect, it } from 'vitest';
import { encode, fromB64, LineSplitter, parse, toB64 } from '../src/main/native/helperProtocol';

describe('native helper protocol', () => {
  it('encodes commands as one line, text as base64 UTF-8', () => {
    expect(encode({ kind: 'hotkey', vk: 0xa3 })).toBe('hotkey 163\n');
    expect(encode({ kind: 'hotkey', vk: 0x10000 })).toBe('hotkey 65536\n');
    expect(encode({ kind: 'arm', on: true })).toBe('arm 1\n');
    expect(encode({ kind: 'arm', on: false })).toBe('arm 0\n');
    const line = encode({ kind: 'insert', id: 7, mode: 'Paste', keep: true, restore: false, text: 'Привет,\nмир 👋' });
    expect(line.endsWith('\n')).toBe(true);
    const p = line.trim().split(' ');
    expect(p.slice(0, 5)).toEqual(['insert', '7', 'Paste', '1', '0']);
    expect(p).toHaveLength(6);
    expect(fromB64(p[5])).toBe('Привет,\nмир 👋');
    expect(encode({ kind: 'copysel', id: 2 })).toBe('copysel 2\n');
    expect(encode({ kind: 'fg', id: 3 })).toBe('fg 3\n');
    expect(encode({ kind: 'quit' })).toBe('quit\n');
  });

  it('parses every helper event and ignores junk', () => {
    expect(parse('ready 1')).toEqual({ kind: 'ready', protocol: 1 });
    expect(parse('down')).toEqual({ kind: 'down' });
    expect(parse('up')).toEqual({ kind: 'up' });
    expect(parse('esc')).toEqual({ kind: 'esc' });
    expect(parse('ok 5 Done')).toEqual({ kind: 'ok', id: 5, result: 'Done' });
    expect(parse('ok 5 Blocked')).toEqual({ kind: 'ok', id: 5, result: 'Blocked' });
    expect(parse('ok 5 Maybe')).toBeNull();
    expect(parse('sel 4 -')).toEqual({ kind: 'sel', id: 4, text: null });
    expect(parse(`sel 4 ${toB64('выделено')}`)).toEqual({ kind: 'sel', id: 4, text: 'выделено' });
    expect(parse(`fg 9 ${toB64('WINWORD')}`)).toEqual({ kind: 'fg', id: 9, process: 'WINWORD' });
    expect(parse('pong 1')).toEqual({ kind: 'pong', id: 1 });
    expect(parse('err 3 unknown')).toEqual({ kind: 'err', id: 3, reason: 'unknown' });
    expect(parse(`log ${toB64('SendInput sent 0/4, error 5')}`)).toEqual({ kind: 'log', text: 'SendInput sent 0/4, error 5' });
    expect(parse(`hookfail ${toB64('SetWindowsHookEx failed: 5')}`)).toEqual({ kind: 'hookfail', reason: 'SetWindowsHookEx failed: 5' });
    expect(parse('')).toBeNull();
    expect(parse('hello world')).toBeNull();
    expect(parse('ok x Done')).toBeNull();
  });

  it('splits stdout into lines across chunks, tolerating CRLF', () => {
    const s = new LineSplitter();
    expect(s.push('rea')).toEqual([]);
    expect(s.push('dy 1\r\ndo')).toEqual(['ready 1']);
    expect(s.push('wn\nup\n\n')).toEqual(['down', 'up']);
  });
});
