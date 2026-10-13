#!/usr/bin/env node
// chawo-va CLI entry: `chawo-va transcribe <files…>`. Plain Node (no Electron window, no
// Chromium decoder). Settings are read, never written. See src/cli/run.ts.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileJob } from './core/fileJob';
import { Recognizer } from './core/recognizer';
import { applyLanguage, t } from './core/strings';
import { fromRanges } from './core/transcriptFormat';
import { runCli, EXIT_INTERRUPTED, type CliDefaults, type CliDeps, type Engine, type EngineConfig } from './cli/run';
import * as Log from './main/log';
import { findComplete, looksComplete } from './main/models/speechModelStore';
import { settingsPath } from './main/paths';
import { defaults as settingsDefaults, fromJsonObject, toCtcScript, toFileParallelism, toSpeechDeviceKind, toSpeechModelKind } from './main/settings';
import { collectFromFolder, load16k, outputPath } from './main/file/fileTranscript';
import type { SpeechModelKind } from './core/speechModels';

const RATE = 16000;

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
  } catch {
    return '?';
  }
}

/** settings.json read-only (load() may migrate and save; the CLI must not touch the app's file). */
export function readDefaults(): CliDefaults {
  let s = settingsDefaults();
  try {
    const path = settingsPath();
    if (existsSync(path)) s = fromJsonObject(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).settings;
  } catch {
    /* defaults */
  }
  return {
    model: toSpeechModelKind(s.SpeechModel),
    device: toSpeechDeviceKind(s.SpeechDevice),
    threads: toFileParallelism(s.FileParallelism),
    script: toCtcScript(s.CtcScript),
    timestamps: s.FileTimestamps,
    language: s.Language,
  };
}

async function openEngine(cfg: EngineConfig): Promise<Engine> {
  const job = await FileJob.open(cfg.dir, cfg.kind, cfg.device, cfg.threads, cfg.script);
  return {
    summary: t(job.plan.summaryRu, job.plan.summaryEn),
    device: `${job.deviceActual}/${job.provider}`,
    async transcribe(samples, progress, signal) {
      const onAbort = () => job.cancel();
      signal.addEventListener('abort', onAbort);
      try {
        const ranges = Recognizer.splitRanges(samples, RATE);
        progress(0, ranges.length, 0, 0);
        const bits = await job.run(samples, ranges, progress, signal);
        return fromRanges(ranges.map((r) => [r.from, r.to] as const), bits, RATE);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    dispose: () => job.dispose(),
  };
}

function findModel(kind: SpeechModelKind, override: string | null): string | null {
  if (override) return looksComplete(override, kind) ? override : null;
  return findComplete(kind);
}

export function realDeps(signal: AbortSignal): CliDeps {
  return {
    version: version(),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    isTTY: Boolean(process.stderr.isTTY),
    defaults: readDefaults,
    applyLanguage: (c) => applyLanguage(c),
    t,
    findModel,
    openEngine,
    load16k,
    outputPath,
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    exists: (p) => existsSync(p),
    collectFromFolder,
    mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
    writeFile: (p, text) => writeFileSync(p, text, 'utf8'),
    log: (line) => Log.write(line),
    now: () => Date.now(),
    signal,
  };
}

if (require.main === module) {
  const ac = new AbortController();
  process.on('SIGINT', () => {
    if (ac.signal.aborted) process.exit(EXIT_INTERRUPTED);
    ac.abort();
  });
  runCli(process.argv.slice(2), realDeps(ac.signal))
    .then(async (code) => {
      await Log.flush();
      process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(`chawo-va: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
