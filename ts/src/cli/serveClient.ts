// CLI client for `chawo-va transcribe --server URL`: posts files to the serve job API, polls
// until done, writes the same local outputs as a local run. No model on this machine.

import { basename, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveToken } from '../main/network/serveAuth';
import type { CliOptions } from './args';
import type { CliDeps, CliDefaults } from './run';
import { EXIT_FAILED, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE } from './run';
import { isLinkInput } from '../core/mediaUrl';
import { toSrt, toTxt, type TranscriptSegment } from '../core/transcriptFormat';
import { writeExtras } from '../main/file/transcriptExport';

export type FetchLike = typeof fetch;

export interface ServeClientDeps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Poll interval ms (tests use a small value). */
  pollMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const e = new Error('Operation canceled');
      e.name = 'AbortError';
      reject(e);
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      const e = new Error('Operation canceled');
      e.name = 'AbortError';
      reject(e);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeServerUrl(raw: string): { ok: true; base: string } | { ok: false; error: string } {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return { ok: false, error: '--server is empty' };
  try {
    const u = new URL(s.includes('://') ? s : `http://${s}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: '--server needs http:// or https://' };
    }
    u.pathname = '';
    u.search = '';
    u.hash = '';
    return { ok: true, base: u.toString().replace(/\/+$/, '') };
  } catch {
    return { ok: false, error: 'bad --server URL' };
  }
}

async function postJob(
  base: string,
  token: string | null,
  bytes: Uint8Array,
  filename: string,
  contentType: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<{ id: string }> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(bytes.length),
    'Content-Disposition': `attachment; filename="${basename(filename).replace(/"/g, '')}"`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetchImpl(`${base}/v1/jobs`, { method: 'POST', headers, body: bytes as unknown as BodyInit, signal, redirect: 'manual' });
  const text = await resp.text();
  if (resp.status === 401) throw new Error('unauthorized (check --token / CHAWO_SERVE_TOKEN)');
  if (resp.status < 200 || resp.status > 299) throw new Error(`server ${resp.status}: ${text.slice(0, 200)}`);
  const doc = JSON.parse(text) as { id?: string };
  if (!doc.id) throw new Error('server did not return a job id');
  return { id: doc.id };
}

async function pollJob(
  base: string,
  token: string | null,
  id: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  pollMs: number,
): Promise<{ text: string; seconds: number | null; model: string | null; device: string | null; segments: TranscriptSegment[] | null }> {
  for (;;) {
    if (signal.aborted) {
      const e = new Error('Operation canceled');
      e.name = 'AbortError';
      throw e;
    }
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetchImpl(`${base}/v1/jobs/${id}`, { method: 'GET', headers, signal, redirect: 'manual' });
    const body = await resp.text();
    if (resp.status === 404) throw new Error('job not found');
    if (resp.status === 401) throw new Error('unauthorized (check --token / CHAWO_SERVE_TOKEN)');
    if (resp.status < 200 || resp.status > 299) throw new Error(`server ${resp.status}: ${body.slice(0, 200)}`);
    const doc = JSON.parse(body) as {
      status?: string;
      text?: string | null;
      error?: string | null;
      seconds?: number | null;
      model?: string | null;
      device?: string | null;
      segments?: unknown;
    };
    if (doc.status === 'done') {
      return {
        text: typeof doc.text === 'string' ? doc.text : '',
        seconds: typeof doc.seconds === 'number' ? doc.seconds : null,
        model: typeof doc.model === 'string' ? doc.model : null,
        device: typeof doc.device === 'string' ? doc.device : null,
        segments: parseSegments(doc.segments),
      };
    }
    if (doc.status === 'error') throw new Error(doc.error || 'job failed');
    await sleep(pollMs, signal);
  }
}

/** Segments from a job response; null when absent or malformed (older servers). */
export function parseSegments(raw: unknown): TranscriptSegment[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TranscriptSegment[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null;
    const g = r as { start?: unknown; end?: unknown; text?: unknown };
    if (typeof g.start !== 'number' || typeof g.end !== 'number' || typeof g.text !== 'string') return null;
    if (!Number.isFinite(g.start) || !Number.isFinite(g.end)) return null;
    out.push({ start: g.start, end: g.end, text: g.text });
  }
  return out;
}

function guessContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.wav') || lower.endsWith('.wave')) return 'audio/wav';
  if (lower.endsWith('.ogg') || lower.endsWith('.opus')) return 'audio/ogg';
  return 'application/octet-stream';
}

/**
 * Transcribe files via a remote `chawo-va serve`. Links are not supported here (download locally
 * first). Brain / diarize / post-script still run locally after the text returns when those flags
 * are not run here. When the server returns timed segments, -f srt,vtt,json,md,docx are written
 * with the same writers as a local run; otherwise only .txt.
 */
export async function transcribeViaServer(
  o: CliOptions,
  _defaults: CliDefaults,
  d: CliDeps,
  extra: ServeClientDeps = {},
): Promise<number> {
  const t = d.t;
  const say = (line: string) => {
    if (!o.quiet) d.err(line + '\n');
  };
  const fail = (line: string) => d.err(line + '\n');

  const norm = normalizeServerUrl(o.server ?? '');
  if (!norm.ok) {
    fail(t(`chawo-va: ${norm.error}`, `chawo-va: ${norm.error}`));
    return EXIT_USAGE;
  }
  const token = resolveToken(o.token, extra.env ?? process.env);
  const fetchImpl = extra.fetch ?? globalThis.fetch;
  const pollMs = extra.pollMs ?? 500;

  const files: string[] = [];
  let failed = 0;
  for (const input of o.inputs) {
    if (isLinkInput(input)) {
      fail(t(`Ошибка: --server не скачивает ссылки: ${input}`, `Error: --server does not download links: ${input}`));
      failed++;
    } else if (d.isDirectory(input)) {
      const found = d.collectFromFolder(input);
      if (found.length === 0) {
        fail(t(`Ошибка: в папке ${input} нет аудиофайлов.`, `Error: no audio files in ${input}.`));
        failed++;
      }
      for (const f of found) if (!files.includes(f)) files.push(f);
    } else if (d.exists(input)) {
      if (!files.includes(input)) files.push(input);
    } else {
      fail(t(`Ошибка: такого файла нет: ${input}`, `Error: no such file: ${input}`));
      failed++;
    }
  }
  if (files.length === 0) return EXIT_FAILED;

  const formats = o.formats.length > 0 ? o.formats : (['txt'] as const);
  const timestamps = o.timestamps ?? _defaults.timestamps;

  say(t(`Сервер: ${norm.base}`, `Server: ${norm.base}`));
  if (o.outDir && !o.stdout) d.mkdirp(o.outDir);

  for (let i = 0; i < files.length; i++) {
    if (d.signal.aborted) break;
    const src = files[i]!;
    const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : '';
    say(prefix + src);
    try {
      const bytes = new Uint8Array(readFileSync(src));
      const { id } = await postJob(norm.base, token, bytes, src, guessContentType(src), fetchImpl, d.signal);
      say(prefix + t(`Задание ${id}…`, `Job ${id}…`));
      const result = await pollJob(norm.base, token, id, fetchImpl, d.signal, pollMs);
      const segs = result.segments;
      // With segments the .txt is built like a local run (timestamps option respected).
      const body = segs && segs.length > 0 ? toTxt(segs, timestamps) : result.text;
      const text = body.endsWith('\n') ? body : body + (body ? '\n' : '');
      if (o.stdout) {
        if (files.length > 1) d.out(`==> ${src} <==\n`);
        d.out(text || '\n');
      } else {
        const beside = d.outputPath(src);
        const txt = o.outDir ? join(o.outDir, basename(beside)) : beside;
        if (o.skipExisting && d.exists(txt)) {
          say(prefix + t(`Пропуск, уже есть: ${txt}`, `Skipped, already there: ${txt}`));
          continue;
        }
        const written: string[] = [];
        if ((formats as readonly string[]).includes('txt')) d.writeFile(txt, text);
        const timed = formats.filter((f) => f !== 'txt');
        if (timed.length > 0 && !segs) {
          say(prefix + t('Сервер не вернул фразы с метками времени: сохранён только .txt.', 'The server returned no timed segments: only .txt is saved.'));
          if (!(formats as readonly string[]).includes('txt')) d.writeFile(txt, text);
        } else if (segs) {
          if ((formats as readonly string[]).includes('srt')) {
            d.writeFile(txt.replace(/\.txt$/i, '.srt'), toSrt(segs));
            written.push('.srt');
          }
          const extras = formats.filter((f): f is 'vtt' | 'json' | 'md' | 'docx' => f === 'vtt' || f === 'json' || f === 'md' || f === 'docx');
          if (extras.length > 0) {
            const dur = result.seconds ?? (segs.length ? segs[segs.length - 1]!.end : 0);
            const res = writeExtras(txt, src, segs, dur, extras, timestamps, (p, data) => d.writeFile(p, data));
            written.push(...res.written);
            for (const f of res.failed) fail(prefix + t(`Ошибка: ${f}`, `Error: ${f}`));
            if (res.failed.length > 0) failed++;
          }
        }
        const notes = [
          result.seconds != null ? `${result.seconds.toFixed(1)}s` : null,
          result.model,
          result.device,
          ...written,
        ].filter(Boolean);
        say(prefix + t(`Готово: ${txt}`, `Done: ${txt}`) + (notes.length ? ` (${notes.join(' · ')})` : ''));
      }
      d.log(`cli server ${src} job=${id} chars=${result.text.length}`);
    } catch (e) {
      if (d.signal.aborted) break;
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      fail(prefix + t(`Ошибка: ${src}: ${msg}`, `Error: ${src}: ${msg}`));
      d.log(`cli server ${src} failed: ${msg}`);
    }
  }

  if (d.signal.aborted) {
    fail(t('Прервано.', 'Interrupted.'));
    return EXIT_INTERRUPTED;
  }
  return failed > 0 ? EXIT_FAILED : EXIT_OK;
}
