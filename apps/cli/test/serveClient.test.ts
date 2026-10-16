import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, type CliOptions } from '../src/cli/args';
import { parseSegments, transcribeViaServer } from '../src/cli/serveClient';
import type { CliDeps, CliDefaults } from '../src/cli/run';

const DEFAULTS = { model: 'v3_e2e_rnnt', device: 'cpu', threads: 'auto', script: 'auto', timestamps: false, language: 'Auto' } as unknown as CliDefaults;

function opts(argv: string[]): CliOptions {
  const r = parseArgs(argv) as unknown as { ok: boolean; options?: CliOptions; opts?: CliOptions } & CliOptions;
  return (r.options ?? r.opts ?? r);
}

function setup(segments: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'chawo-client-'));
  const src = join(dir, 'talk.wav');
  writeFileSync(src, Buffer.from('RIFF0000WAVE'));
  const files = new Map<string, string | Buffer>();
  const errs: string[] = [];
  const d = {
    t: (_ru: string, en: string) => en,
    out: () => undefined,
    err: (s: string) => errs.push(s),
    log: () => undefined,
    signal: new AbortController().signal,
    exists: (p: string) => p === src || files.has(p),
    isDirectory: () => false,
    collectFromFolder: () => [],
    mkdirp: () => undefined,
    outputPath: (p: string) => p.replace(/\.[^.]+$/, '.txt'),
    writeFile: (p: string, data: string | Buffer) => files.set(p, data),
  } as unknown as CliDeps;
  const fetchImpl = (async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'abc', status: 'queued' }), { status: 201 });
    return new Response(
      JSON.stringify({ id: 'abc', status: 'done', text: 'Hello.\nWorld.', seconds: 3, model: 'v3_e2e_rnnt', device: 'cpu', segments }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { dir, src, files, errs, d, fetchImpl };
}

describe('transcribe --server output formats', () => {
  it('writes txt, srt, vtt, json, md, docx from server segments', async () => {
    const segs = [{ start: 0, end: 1.2, text: 'Hello.' }, { start: 1.5, end: 3, text: 'World.' }];
    const s = setup(segs);
    const o = opts(['transcribe', s.src, '--server', 'http://127.0.0.1:1', '-f', 'txt,srt,vtt,json,md,docx']);
    const code = await transcribeViaServer(o, DEFAULTS, s.d, { fetch: s.fetchImpl, pollMs: 1, env: {} });
    expect(code).toBe(0);
    const base = s.src.replace(/\.wav$/, '');
    for (const ext of ['txt', 'srt', 'vtt', 'json', 'md', 'docx']) expect(s.files.has(`${base}.${ext}`), ext).toBe(true);
    expect(String(s.files.get(`${base}.srt`))).toContain('00:00:01,500 --> 00:00:03,000');
    expect(String(s.files.get(`${base}.vtt`))).toMatch(/^WEBVTT/);
    expect(JSON.parse(String(s.files.get(`${base}.json`))).segments).toHaveLength(2);
    expect(Buffer.isBuffer(s.files.get(`${base}.docx`)) || s.files.get(`${base}.docx`) instanceof Uint8Array).toBe(true);
    expect(s.files.get(`${base}.txt`)).toBe('Hello.\nWorld.\n');
  });

  it('honours --timestamps in the .txt like a local run', async () => {
    const s = setup([{ start: 0, end: 1, text: 'Hi.' }]);
    const o = opts(['transcribe', s.src, '--server', 'http://127.0.0.1:1', '--timestamps']);
    expect(await transcribeViaServer(o, DEFAULTS, s.d, { fetch: s.fetchImpl, pollMs: 1, env: {} })).toBe(0);
    expect(String(s.files.get(s.src.replace(/\.wav$/, '.txt')))).toMatch(/\[00:00\]|00:00/);
  });

  it('falls back to .txt only when the server has no segments', async () => {
    const s = setup(undefined);
    const o = opts(['transcribe', s.src, '--server', 'http://127.0.0.1:1', '-f', 'srt']);
    expect(await transcribeViaServer(o, DEFAULTS, s.d, { fetch: s.fetchImpl, pollMs: 1, env: {} })).toBe(0);
    expect([...s.files.keys()].map((k) => k.slice(-4))).toEqual(['.txt']);
    expect(s.errs.join('')).toContain('no timed segments');
  });

  it('parseSegments rejects malformed rows', () => {
    expect(parseSegments(null)).toBeNull();
    expect(parseSegments([{ start: 0, end: 1 }])).toBeNull();
    expect(parseSegments([{ start: 0, end: 1, text: 'x', speaker: 2 }])).toEqual([{ start: 0, end: 1, text: 'x' }]);
  });
});
