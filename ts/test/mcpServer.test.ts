import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { LineReader, MAX_RESULT_CHARS, McpServer, TOOLS, configSnippet, launchFor, serveStdio } from '../src/main/mcp/mcpServer';
import { MAX_FILE_BYTES } from '../src/main/history/askSources';
import { parseArgs } from '../src/cli/args';
import * as Settings from '../src/main/settings';

let dir: string;
let meet: string;
let outside: string;
const t = (_ru: string, en: string) => en;
const mk = (roots?: string[]) => new McpServer({ version: '9.9.9', roots: () => roots ?? [meet], history: () => [{ id: 'h1', ts: Date.parse('2026-10-13T10:00:00Z'), raw: '', final: 'Позвонить Ивану про скидку', command: null, brain: false, brainFailed: false, seconds: 1 } as never], trackers: () => '', t });
const ready = async (s: McpServer) => { await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }); return s; };
const call = async (s: McpServer, name: string, args: Record<string, unknown>) => ((await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } }).result;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-mcp-'));
  meet = join(dir, 'Встречи');
  outside = join(dir, 'secret');
  mkdirSync(join(meet, 'sub'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(meet, 'call.txt'), '[00:00:01] Спикер 1: Здравствуйте, обсудим скидку.\n[00:00:09] Спикер 2: Дорого.\n');
  writeFileSync(join(meet, 'call.srt'), '1\n00:00:00,000 --> 00:00:08,000\nСпикер 1: Здравствуйте, обсудим скидку.\n\n2\n00:00:08,000 --> 00:00:10,000\nСпикер 2: Дорого.\n');
  writeFileSync(join(meet, 'call.brief.txt'), 'Кратко\n- скидка\n');
  writeFileSync(join(meet, 'call.score.json'), JSON.stringify({ version: 1, score: 3, max: 6, percent: 50 }));
  writeFileSync(join(meet, 'sub', 'long.txt'), 'а'.repeat(MAX_RESULT_CHARS + 500));
  writeFileSync(join(meet, 'big.txt'), 'б'.repeat(10));
  writeFileSync(join(meet, 'huge.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
  writeFileSync(join(meet, 'notes.exe'), 'MZ');
  writeFileSync(join(outside, 'passwords.txt'), 'секрет скидка');
  symlinkSync(join(outside, 'passwords.txt'), join(meet, 'link.txt'));
  symlinkSync(outside, join(meet, 'linkdir'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('protocol', () => {
  it('initialize negotiates the version; unknown → latest; tools/list is read-only', async () => {
    const s = mk();
    const r = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown> } };
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.serverInfo).toMatchObject({ name: 'chawo-va', version: '9.9.9' });
    expect(Object.keys(r.result.capabilities)).toEqual(['tools']);
    const r2 = (await mk().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as { result: { protocolVersion: string } };
    expect(r2.result.protocolVersion).toBe('2025-11-25');
    const l = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: typeof TOOLS } };
    expect(l.result.tools.map((x) => x.name)).toEqual(['search', 'list_meetings', 'get_transcript', 'get_brief', 'get_score', 'get_stats']);
    expect(l.result.tools.every((x) => x.annotations.readOnlyHint && !x.annotations.destructiveHint)).toBe(true);
  });
  it('notifications get no answer; unknown method, batch, bad request, call before initialize', async () => {
    const s = mk();
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await s.handle({ jsonrpc: '2.0', method: 'whatever' })).toBeNull();
    expect(await s.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
    expect(await s.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toMatchObject({ error: { code: -32600 } });
    expect(await s.handle({ id: 4, method: 'ping' })).toMatchObject({ id: 4, error: { code: -32600 } });
    expect(await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search', arguments: { query: 'x' } } })).toMatchObject({ error: { code: -32002 } });
    expect(await s.handle({ jsonrpc: '2.0', id: 6, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 6, result: {} });
    await ready(s);
    expect(await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'write_file', arguments: {} } })).toMatchObject({ error: { code: -32602 } });
  });
  it('stdio: one JSON per line out, parse errors answered, oversized lines skipped, nothing else written', async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveStdio(mk(), input, (s) => out.push(s));
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\r\n');
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"pi');
    input.write('ng"}\n');
    input.write('"' + 'x'.repeat(1_100_000) + '"\n');
    input.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
    input.end();
    await done;
    expect(out.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
    const msgs = out.map((l) => JSON.parse(l));
    // Responses may come out of order (JSON-RPC matches them by id).
    expect(msgs.map((m) => String(m.id ?? m.error?.code)).sort()).toEqual(['-32600', '-32700', '1', '2', '3']);
  });
  it('LineReader does not grow without bound', () => {
    const got: string[] = [];
    let long = 0;
    const r = new LineReader((l) => got.push(l), () => long++, 10);
    r.push('12345');
    r.push('678901234');
    r.push('5\nok\n');
    expect([got, long]).toEqual([['ok'], 1]);
  });
});

describe('tools', () => {
  it('search finds transcripts and dictation; history off; limits', async () => {
    const s = await ready(mk());
    const r = await call(s, 'search', { query: 'скидка' });
    const res = r.structuredContent!.results as { kind: string; path: string | null }[];
    expect(res.some((x) => x.kind === 'transcript' && x.path?.endsWith('call.txt'))).toBe(true);
    expect(res.some((x) => x.kind === 'dictation')).toBe(true);
    expect(res.some((x) => x.path?.includes('secret') || x.path?.includes('link'))).toBe(false);
    const r2 = await call(s, 'search', { query: 'скидка', history: false });
    expect((r2.structuredContent!.results as { kind: string }[]).every((x) => x.kind !== 'dictation')).toBe(true);
    expect((await call(s, 'search', { query: 'x'.repeat(600) })).isError).toBe(true);
    expect((await call(s, 'search', {})).isError).toBe(true);
  });
  it('list_meetings: newest first, flags, no sidecars, no files outside', async () => {
    const s = await ready(mk());
    const r = await call(s, 'list_meetings', { limit: 50 });
    const m = r.structuredContent!.meetings as { name: string; brief: boolean; score: boolean; timings: boolean }[];
    const call1 = m.find((x) => x.name === 'call.txt')!;
    expect(call1).toMatchObject({ brief: true, score: true, timings: true });
    expect(m.some((x) => x.name.endsWith('.brief.txt') || x.name === 'passwords.txt' || x.name === 'huge.txt' || x.name === 'link.txt')).toBe(false);
  });
  it('get_transcript pages long files; brief / score / stats read the sidecars', async () => {
    const s = await ready(mk());
    const long = join(meet, 'sub', 'long.txt');
    const p1 = await call(s, 'get_transcript', { path: long });
    expect(p1.structuredContent).toMatchObject({ offset: 0, nextOffset: MAX_RESULT_CHARS });
    expect(p1.content[0]!.text).toMatch(/call again with offset/);
    const p2 = await call(s, 'get_transcript', { path: long, offset: MAX_RESULT_CHARS });
    expect(p2.content[0]!.text).toHaveLength(500);
    expect((await call(s, 'get_brief', { path: join(meet, 'call.txt') })).content[0]!.text).toContain('скидка');
    expect((await call(s, 'get_score', { path: join(meet, 'call.txt') })).structuredContent).toMatchObject({ percent: 50 });
    expect((await call(s, 'get_brief', { path: join(meet, 'big.txt') })).content[0]!.text).toMatch(/No brief/);
    const st = await call(s, 'get_stats', { path: join(meet, 'call.txt') });
    expect(st.isError).toBeUndefined();
    expect(st.content[0]!.text).toMatch(/Speaker 1/);
  });
  it('path traversal, symlinks, relative paths, other types and big files are refused', async () => {
    const s = await ready(mk());
    const bad = [
      join(meet, '..', 'secret', 'passwords.txt'),
      join(outside, 'passwords.txt'),
      join(meet, 'link.txt'),
      join(meet, 'linkdir', 'passwords.txt'),
      'call.txt',
      '../secret/passwords.txt',
      join(meet, 'notes.exe'),
      join(meet, 'huge.txt'),
      join(meet, 'nope.txt'),
      meet,
      join(meet, 'call.txt') + '\0.txt',
      join(dir, 'Встречи-evil', 'x.txt'),
    ];
    for (const path of bad) {
      const r = await call(s, 'get_transcript', { path });
      expect(r.isError, path).toBe(true);
      expect(r.content[0]!.text).not.toContain('секрет');
    }
    for (const tool of ['get_brief', 'get_score', 'get_stats']) expect((await call(s, tool, { path: join(outside, 'passwords.txt') })).isError).toBe(true);
    // A file root shares only that file.
    const one = await ready(mk([join(meet, 'call.txt')]));
    expect((await call(one, 'get_transcript', { path: join(meet, 'call.txt') })).isError).toBeUndefined();
    expect((await call(one, 'get_transcript', { path: join(meet, 'big.txt') })).isError).toBe(true);
    expect((await call(one, 'get_brief', { path: join(meet, 'call.txt') })).isError).toBe(true); // sidecar is outside a file root
  });
});

describe('config, settings, CLI args', () => {
  it('snippet for Claude Desktop / Cursor', () => {
    const l = launchFor('C:\\Apps\\Chawo\\ChawoVoiceAssistant.exe', 'C:\\Apps\\Chawo\\resources\\app.asar', { CHAWO_APPDATA: undefined, CHAWO_MEETINGS_DIR: '/m' });
    const j = JSON.parse(configSnippet(l.command, l.args, l.env));
    expect(j.mcpServers['chawo-va'].command).toBe('C:\\Apps\\Chawo\\ChawoVoiceAssistant.exe');
    expect(j.mcpServers['chawo-va'].args.at(-1)).toBe('mcp');
    expect(j.mcpServers['chawo-va'].args[0]).toMatch(/dist[\\/]cli\.js$/);
    expect(j.mcpServers['chawo-va'].env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CHAWO_MEETINGS_DIR: '/m' });
  });
  it('McpEnabled is off by default and round-trips', () => {
    const s = Settings.defaults();
    expect(s.McpEnabled).toBe(false);
    s.McpEnabled = true;
    expect(Settings.fromJsonObject(Settings.toJsonObject(s)).settings.McpEnabled).toBe(true);
  });
  it('mcp takes only --in, --no-history, --lang', () => {
    const r = parseArgs(['mcp', '--in', '/m', '--no-history', '--lang', 'en']);
    expect(r.ok && r.options.command === 'mcp' && r.options.askIn[0] === '/m' && r.options.noHistory).toBe(true);
    for (const a of [['mcp', 'x'], ['mcp', '--json'], ['mcp', '--port', '80'], ['mcp', '--stdout'], ['mcp', '--search'], ['history', '--in', '/m']]) expect(parseArgs(a).ok, a.join(' ')).toBe(false);
  });
});
