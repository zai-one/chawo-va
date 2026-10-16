// `chawo-va mcp`: a read-only MCP server over stdio (JSON-RPC 2.0, one message per line, as in the
// MCP stdio transport). It lets an assistant (Claude Desktop, Cursor, …) search and read the user's
// own transcripts and dictation phrases. Nothing is written, nothing is sent, no port is opened.
// Files are served only from the allowed folders (the meetings folder, «Спросить историю» folders,
// --in), after realpath, so «..» and symlinks cannot leave them. No Electron imports, unit-tested.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import * as Ask from '@chawo/core/askHistory';
import { computeCallStats, formatCallStats, parseTrackers } from '@chawo/core/callStats';
import { loadTimedTranscript } from '@chawo/core/transcriptFormat';
import * as AskSources from '../history/askSources';
import type { HistoryEntry } from '../history/historyStore';

export const SERVER_NAME = 'chawo-va';
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** One incoming line longer than this is refused (and skipped) without parsing. */
export const MAX_LINE_BYTES = 1_000_000;
/** Text returned by one call is cut here; get_transcript pages with offset. */
export const MAX_RESULT_CHARS = 60_000;
export const MAX_LIST = 200;
const READ_EXT = new Set(['.txt', '.md', '.srt', '.vtt', '.json']);
const TRANSCRIPT_EXT = new Set(['.txt', '.md', '.srt', '.vtt']);

export interface McpDeps {
  version: string;
  /** Allowed folders / files (meetings folder, AskFolders, --in). */
  roots: () => string[];
  /** Dictation phrases within «Хранить»; [] when history is off or excluded. */
  history: () => HistoryEntry[];
  /** Settings CallTrackers text ('' = built-in trackers). */
  trackers: () => string;
  t: (ru: string, en: string) => string;
  platform?: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Request { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }
export class ToolError extends Error {}

const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

export const TOOLS = [
  {
    name: 'search',
    title: 'Search transcripts and dictation',
    description: 'Full-text search (local BM25, Russian/English stemming) over the user\'s meeting/file transcripts and dictation phrases. Returns the best short excerpts with their file paths. Read-only.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' }, limit: { type: 'integer', minimum: 1, maximum: Ask.MAX_TOP, default: Ask.DEFAULT_TOP }, history: { type: 'boolean', default: true, description: 'Include dictation phrases' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'list_meetings',
    title: 'List recent transcripts',
    description: 'Recent transcripts in the allowed folders, newest first: path, name, modified time, size, and which analyses exist (brief, score, timings).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIST, default: 20 } }, additionalProperties: false },
  },
  {
    name: 'get_transcript',
    title: 'Read a transcript',
    description: 'Text of one transcript (.txt/.md/.srt/.vtt) from the allowed folders. Long files come in pages: pass offset from the previous answer.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path as returned by list_meetings or search' }, offset: { type: 'integer', minimum: 0, default: 0 }, maxChars: { type: 'integer', minimum: 1000, maximum: MAX_RESULT_CHARS, default: MAX_RESULT_CHARS } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'get_brief',
    title: 'Brief and tasks of a transcript',
    description: 'The saved «Brief and tasks» card (.brief.txt) next to a transcript, if it was made. Never runs the Brain.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'get_score',
    title: 'Checklist score of a call',
    description: 'The saved checklist score (.score.json) next to a transcript, if it was made. Never runs the Brain.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'get_stats',
    title: 'Call statistics',
    description: 'Talk ratio, monologues and keyword trackers computed locally from the transcript timings (.srt/.json/[hh:mm:ss]).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
].map((x) => ({ ...x, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));

function str(args: Record<string, unknown>, k: string, max: number, required = true): string {
  const v = args[k];
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`"${k}" must be a non-empty string`);
  if (v.length > max) throw new ToolError(`"${k}" is longer than ${max} characters`);
  return v.trim();
}

function int(args: Record<string, unknown>, k: string, def: number, min: number, max: number): number {
  const v = args[k];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolError(`"${k}" must be an integer`);
  return Math.min(max, Math.max(min, v));
}

export class McpServer {
  private initialized = false;
  constructor(private readonly d: McpDeps) {}

  private real(p: string): string | null {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  }

  private fold(p: string): string {
    return (this.d.platform ?? process.platform) === 'win32' || (this.d.platform ?? process.platform) === 'darwin' ? p.toLowerCase() : p;
  }

  /** Real paths of the allowed roots (missing ones dropped). */
  allowedRoots(): { path: string; dir: boolean }[] {
    const out: { path: string; dir: boolean }[] = [];
    for (const r of this.d.roots()) {
      const rp = this.real(r);
      if (!rp) continue;
      try {
        out.push({ path: rp, dir: statSync(rp).isDirectory() });
      } catch {
        /* gone */
      }
    }
    return out;
  }

  /** The real path of `p` when it is a readable file inside an allowed root; ToolError otherwise. */
  resolveAllowed(p: string, exts: ReadonlySet<string> = READ_EXT): string {
    if (!isAbsolute(p)) throw new ToolError('path must be absolute (take it from list_meetings or search)');
    if (/\0/.test(p)) throw new ToolError('bad path');
    const rp = this.real(p);
    if (!rp) throw new ToolError('no such file');
    const f = this.fold(rp);
    const inside = this.allowedRoots().some((r) => (r.dir ? f.startsWith(this.fold(r.path.endsWith(sep) ? r.path : r.path + sep)) : f === this.fold(r.path)));
    if (!inside) throw new ToolError('this file is outside the folders Chawo shares (meetings folder and «Ask history» folders)');
    if (!exts.has(extname(rp).toLowerCase())) throw new ToolError(`only ${[...exts].join(', ')} files are served`);
    const st = statSync(rp);
    if (!st.isFile()) throw new ToolError('not a file');
    if (st.size > AskSources.MAX_FILE_BYTES) throw new ToolError(`file is larger than ${AskSources.MAX_FILE_BYTES} bytes`);
    return rp;
  }

  /** Sibling (.brief.txt, .score.json, .srt) of an allowed transcript, also checked; null when missing. */
  private sibling(txt: string, suffix: string): string | null {
    const stem = txt.replace(/\.[^./\\]+$/, '').replace(/\.brain$/, '');
    const p = stem + suffix;
    if (!existsSync(p)) return null;
    return this.resolveAllowed(p);
  }

  private read(p: string): string {
    let s = readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; structuredContent?: Json; isError?: boolean }> {
    switch (name) {
      case 'search': {
        const query = str(args, 'query', Ask.MAX_QUESTION);
        const limit = int(args, 'limit', Ask.DEFAULT_TOP, 1, Ask.MAX_TOP);
        const history = args.history === undefined ? true : args.history === true;
        const sources = AskSources.loadSources({ history: history ? this.d.history() : [], inputs: this.d.roots() }, this.d.t);
        const found = Ask.search(query, sources, limit);
        const list = Ask.excerpts(found, MAX_RESULT_CHARS);
        const items = list.map((x) => ({ n: x.n, kind: x.kind, title: x.title, path: x.path, when: x.when ? new Date(x.when).toISOString() : null, text: x.text }));
        const body = items.length === 0 ? 'Nothing found.' : items.map((x) => `[${x.n}] ${x.title}${x.path ? ` (${x.path})` : ''}${x.when ? ` · ${x.when}` : ''}\n${x.text}`).join('\n\n');
        return { ...text(body), structuredContent: { results: items } as unknown as Json };
      }
      case 'list_meetings': {
        const limit = int(args, 'limit', 20, 1, MAX_LIST);
        const files = AskSources.transcriptFiles(this.d.roots(), MAX_LIST).filter((p) => {
          const n = p.toLowerCase();
          return !n.endsWith('.brief.txt') && !n.endsWith('.score.txt') && !n.endsWith('.brain.txt');
        }).slice(0, limit);
        const items = files.flatMap((p) => {
          let st;
          try {
            st = statSync(p);
          } catch {
            return []; // removed between listing and stat
          }
          const stem = p.replace(/\.[^./\\]+$/, '');
          return [{ path: p, name: basename(p), folder: dirname(p), modified: new Date(st.mtimeMs).toISOString(), bytes: st.size, brief: existsSync(stem + '.brief.txt'), score: existsSync(stem + '.score.json'), timings: existsSync(stem + '.srt') || existsSync(stem + '.json') }];
        });
        const body = items.length === 0 ? 'No transcripts in the shared folders.' : items.map((x) => `${x.modified}  ${x.path}${x.brief ? '  [brief]' : ''}${x.score ? '  [score]' : ''}`).join('\n');
        return { ...text(body), structuredContent: { meetings: items } as unknown as Json };
      }
      case 'get_transcript': {
        const p = this.resolveAllowed(str(args, 'path', 4096), TRANSCRIPT_EXT);
        const all = this.read(p);
        const offset = int(args, 'offset', 0, 0, all.length);
        const max = int(args, 'maxChars', MAX_RESULT_CHARS, 1000, MAX_RESULT_CHARS);
        const chunk = all.slice(offset, offset + max);
        const next = offset + chunk.length < all.length ? offset + chunk.length : null;
        const tail = next === null ? '' : `\n\n[… ${all.length - next} more characters; call again with offset ${next}]`;
        return { ...text(chunk + tail), structuredContent: { path: p, offset, length: all.length, nextOffset: next } };
      }
      case 'get_brief': {
        const p = this.resolveAllowed(str(args, 'path', 4096), TRANSCRIPT_EXT);
        const b = this.sibling(p, '.brief.txt');
        if (!b) return { ...text('No brief for this transcript yet (make it in the app or with `chawo-va brief`).'), isError: false };
        return text(this.read(b).slice(0, MAX_RESULT_CHARS));
      }
      case 'get_score': {
        const p = this.resolveAllowed(str(args, 'path', 4096), TRANSCRIPT_EXT);
        const sj = this.sibling(p, '.score.json');
        if (!sj) return text('No checklist score for this transcript yet (make it in the app or with `chawo-va score`).');
        let parsed: Json;
        try {
          parsed = JSON.parse(this.read(sj)) as Json;
        } catch {
          throw new ToolError('the .score.json file is damaged');
        }
        const st = this.sibling(p, '.score.txt');
        return { ...text((st ? this.read(st) : JSON.stringify(parsed, null, 2)).slice(0, MAX_RESULT_CHARS)), structuredContent: parsed };
      }
      case 'get_stats': {
        const p = this.resolveAllowed(str(args, 'path', 4096));
        const loaded = loadTimedTranscript(p, (q) => {
          try {
            return existsSync(q) ? this.read(this.resolveAllowed(q)) : null;
          } catch {
            return null;
          }
        });
        if (!loaded.available) throw new ToolError('no timings for this transcript (needs .srt, .json or [hh:mm:ss] lines)');
        const st = computeCallStats(loaded.segments, parseTrackers(this.d.trackers()));
        return { ...text(formatCallStats(st, this.d.t).slice(0, MAX_RESULT_CHARS)), structuredContent: JSON.parse(JSON.stringify(st)) as Json };
      }
      default:
        throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
  }

  /** One JSON-RPC message in, zero or one out (notifications get none). */
  async handle(msg: unknown): Promise<Json | null> {
    if (Array.isArray(msg)) return rpcError(null, -32600, 'batches are not supported');
    if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'invalid request');
    const r = msg as Request;
    const id = r.id ?? null;
    const isNote = r.id === undefined;
    if (r.jsonrpc !== '2.0' || typeof r.method !== 'string') return isNote ? null : rpcError(id, -32600, 'invalid request');
    try {
      const result = await this.dispatch(r);
      return isNote || result === undefined ? null : { jsonrpc: '2.0', id, result };
    } catch (e) {
      if (isNote) return null;
      if (e instanceof RpcError) return rpcError(id, e.code, e.message);
      return rpcError(id, -32603, 'internal error');
    }
  }

  private async dispatch(r: Request): Promise<Json | undefined> {
    const params = r.params && typeof r.params === 'object' ? r.params : {};
    switch (r.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        this.initialized = true;
        return {
          protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'Chawo Voice Assistant', version: this.d.version },
          instructions: 'Read-only access to the user\'s own meeting transcripts and dictation history on this computer. Use search or list_meetings first, then get_transcript / get_brief / get_score / get_stats with the returned path.',
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS as unknown as Json };
      case 'tools/call': {
        if (!this.initialized) throw new RpcError(-32002, 'server not initialized');
        const name = typeof params.name === 'string' ? params.name : '';
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
        if (!TOOLS.some((x) => x.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
        try {
          return await this.call(name, args);
        } catch (e) {
          // Tool problems are results with isError (the model can read them), not protocol errors.
          const m = e instanceof ToolError ? e.message : 'the tool failed';
          return { content: [{ type: 'text', text: m }], isError: true };
        }
      }
      default:
        if (r.method.startsWith('notifications/')) return undefined;
        throw new RpcError(-32601, `Method not found: ${r.method}`);
    }
  }
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function rpcError(id: string | number | null, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Line framing for stdio: feed chunks in, get whole messages out. Oversized lines are dropped
 * (with a parse error answer) instead of growing the buffer without bound.
 */
export class LineReader {
  private buf = '';
  private skipping = false;
  constructor(private readonly onLine: (line: string) => void, private readonly onTooLong: () => void, private readonly max = MAX_LINE_BYTES) {}
  push(chunk: string): void {
    let s = chunk;
    for (;;) {
      const nl = s.indexOf('\n');
      if (nl < 0) {
        if (!this.skipping) {
          this.buf += s;
          if (Buffer.byteLength(this.buf) > this.max) {
            this.buf = '';
            this.skipping = true;
            this.onTooLong();
          }
        }
        return;
      }
      const part = s.slice(0, nl);
      s = s.slice(nl + 1);
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      const line = (this.buf + part).replace(/\r$/, '');
      this.buf = '';
      if (Buffer.byteLength(line) > this.max) this.onTooLong();
      else if (line.trim()) this.onLine(line);
    }
  }
}

/** Runs the server on the given streams until input ends. `write` is the only thing that touches stdout. */
export function serveStdio(server: McpServer, input: NodeJS.ReadableStream, write: (s: string) => void): Promise<void> {
  let chain = Promise.resolve();
  const send = (m: Json | null) => {
    if (m !== null) write(JSON.stringify(m) + '\n');
  };
  const reader = new LineReader(
    (line) => {
      chain = chain.then(async () => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          send(rpcError(null, -32700, 'parse error'));
          return;
        }
        send(await server.handle(msg));
      });
    },
    () => send(rpcError(null, -32600, `message larger than ${MAX_LINE_BYTES} bytes`)),
  );
  input.setEncoding?.('utf8');
  input.on('data', (c: string | Buffer) => reader.push(typeof c === 'string' ? c : c.toString('utf8')));
  return new Promise((resolve) => input.on('end', () => void chain.then(resolve)));
}

/** Config snippet for Claude Desktop / Cursor (both read {"mcpServers": {...}}). */
export function configSnippet(command: string, args: string[], env: Record<string, string> = {}): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args, ...(Object.keys(env).length > 0 ? { env } : {}) } } }, null, 2);
}

/** command/args for this install: the app executable in Node mode running out/main/cli.js mcp. */
export function launchFor(execPath: string, appPath: string, extraEnv: Record<string, string | undefined> = {}): { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  for (const [k, v] of Object.entries(extraEnv)) if (v) env[k] = v;
  return { command: execPath, args: [join(appPath, 'out', 'main', 'cli.js'), 'mcp'], env };
}
