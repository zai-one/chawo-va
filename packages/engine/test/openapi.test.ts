// docs/openapi.yaml must be a valid OpenAPI 3.1 document and list exactly the routes that
// serveServer.ts implements (parsed from the source), and live responses must carry the
// required fields of their schemas.
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse } from 'yaml';
import { wavBytes } from '@chawo/core/audio';
import { ServeServer } from '../src/network/serveServer';

const SPEC = join(__dirname, '..', '..', '..', 'docs', 'openapi.yaml');
const SRC = join(__dirname, '..', 'src', 'network', 'serveServer.ts');
const doc = parse(readFileSync(SPEC, 'utf8')) as {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { required?: string[] }> };
};

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

function specRoutes(): string[] {
  const out: string[] = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const m of Object.keys(item)) if (METHODS.includes(m)) out.push(`${m.toUpperCase()} ${p}`);
  }
  return out.sort();
}

/** Routes from the handler source: `method === 'X' && (path === 'a' || path === 'b')`, the job regex,
 *  and the Hermes `method !== 'POST' || (path !== 'a' && path !== 'b')` fallthrough. */
function codeRoutes(): string[] {
  const src = readFileSync(SRC, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/method === '([A-Z]+)' && \(([^)]*)\)/g)) {
    for (const p of m[2]!.matchAll(/path === '([^']+)'/g)) out.add(`${m[1]} ${p[1]}`);
  }
  for (const m of src.matchAll(/method !== '([A-Z]+)' \|\| \(([^)]*)\)/g)) {
    for (const p of m[2]!.matchAll(/path !== '([^']+)'/g)) out.add(`${m[1]} ${p[1]}`);
  }
  const job = /\/\^\\\/\(\?:v1\\\/\)\?jobs\\\/\(\[A-Za-z0-9_-\]\+\)\$\/\.exec\(path\)([\s\S]*?)\/\/ Hermes sync/.exec(src);
  expect(job, 'job route regex not found in serveServer.ts').not.toBeNull();
  for (const m of job![1]!.matchAll(/method === '([A-Z]+)'/g)) {
    out.add(`${m[1]} /v1/jobs/{id}`);
    out.add(`${m[1]} /jobs/{id}`);
  }
  return [...out].sort();
}

const servers: ServeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.dispose();
});

describe('docs/openapi.yaml', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    await expect(SwaggerParser.validate(SPEC)).resolves.toBeTruthy();
  });

  it('lists exactly the routes the server implements', () => {
    const code = codeRoutes();
    expect(code.length).toBeGreaterThanOrEqual(10);
    expect(specRoutes()).toEqual(code);
  });

  it('declares bearer auth', () => {
    const raw = parse(readFileSync(SPEC, 'utf8')) as { components: { securitySchemes: Record<string, { type: string; scheme: string }> } };
    expect(raw.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('live responses carry the required fields of their schemas', async () => {
    const server = new ServeServer({
      host: '127.0.0.1',
      port: 0,
      token: null,
      dataDir: mkdtempSync(join(tmpdir(), 'chawo-openapi-')),
      transcribe: (a) => ({ modelLoaded: true, text: a.length ? 'hi' : null, model: 'v3_e2e_rnnt', device: 'cpu', provider: 'cpu', seconds: 0.1, error: null }),
      jobTranscribe: async () => ({ text: 'a\nb', seconds: 2, model: 'v3_e2e_rnnt', device: 'cpu', segments: [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }] }),
      workers: 1,
    });
    servers.push(server);
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    const keys = (name: string) => doc.components.schemas[name]!.required ?? [];
    const health = (await (await fetch(`${base}/v1/health`)).json()) as Record<string, unknown>;
    expect(Object.keys(health).sort()).toEqual([...keys('Health')].sort());
    const wav = wavBytes(new Float32Array(1600), 16000);
    const tr = (await (await fetch(`${base}/v1/transcribe`, { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav' } })).json()) as Record<string, unknown>;
    expect(Object.keys(tr).sort()).toEqual([...keys('TranscribeResult')].sort());
    const created = await fetch(`${base}/v1/jobs`, { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav' } });
    expect(created.status).toBe(201);
    const job = (await created.json()) as { id: string };
    expect(Object.keys(job).sort()).toEqual([...keys('Job')].sort());
    let done: { status: string; segments: unknown } = { status: '', segments: null };
    for (let i = 0; i < 100 && done.status !== 'done'; i++) {
      done = (await (await fetch(`${base}/v1/jobs/${job.id}`)).json()) as typeof done;
      if (done.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    }
    expect(done.segments).toEqual([{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }]);
    const del = (await (await fetch(`${base}/v1/jobs/${job.id}`, { method: 'DELETE' })).json()) as Record<string, unknown>;
    expect(Object.keys(del).sort()).toEqual([...keys('Deleted')].sort());
    const nf = await fetch(`${base}/v1/jobs/${job.id}`);
    expect(nf.status).toBe(404);
    const errEnum = (doc.components.schemas.Error as unknown as { properties: { error: { enum: string[] } } }).properties.error.enum;
    expect(errEnum).toContain(((await nf.json()) as { error: string }).error);
  });
});
