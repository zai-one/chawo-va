#!/usr/bin/env node
// chawo-va CLI entry: `chawo-va transcribe <files…>` (and brief / translate / history). Plain Node (no Electron window, no
// Chromium decoder). Settings are read, never written. See src/cli/run.ts.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileJob } from './core/fileJob';
import { applyLanguage, t } from './core/strings';
import { scriptCommand } from './core/postScript';
import { engineFromJob } from './cli/engine';
import { diarizeHook } from './main/diarize/diarizeRuntime';
import { runCli, EXIT_INTERRUPTED, type CliDefaults, type CliDeps, type Engine, type EngineConfig } from './cli/run';
import * as Log from './main/log';
import { findComplete, looksComplete } from './main/models/speechModelStore';
import { historyFilePath, settingsPath } from './main/paths';
import { defaults as settingsDefaults, fromJsonObject, toCtcScript, toFileParallelism, toSpeechDeviceKind, toSpeechModelKind } from './main/settings';
import { collectFromFolder, load16k, outputPath } from './main/file/fileTranscript';
import * as MeetingBrief from './main/brain/meetingBrief';
import * as Translate from './main/brain/translate';
import * as FileBrain from './main/brain/fileBrain';
import * as LocalBrain from './main/brain/localBrain';
import type { SettingsData } from './main/settings';
import type { SpeechModelKind } from './core/speechModels';

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
  } catch {
    return '?';
  }
}

/** settings.json read-only (load() may migrate and save; the CLI must not touch the app's file). */
function readSettings(): SettingsData {
  let s = settingsDefaults();
  try {
    const path = settingsPath();
    if (existsSync(path)) s = fromJsonObject(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).settings;
  } catch {
    /* defaults */
  }
  return s;
}

export function readDefaults(): CliDefaults {
  const s = readSettings();
  return {
    model: toSpeechModelKind(s.SpeechModel),
    device: toSpeechDeviceKind(s.SpeechDevice),
    threads: toFileParallelism(s.FileParallelism),
    script: toCtcScript(s.CtcScript),
    timestamps: s.FileTimestamps,
    language: s.Language,
    postScript: s.PostScriptFiles ? scriptCommand(s.PostScript) : null,
    historyKeep: s.HistoryKeep,
    vad: s.VadEnabled,
    diarize: s.FileDiarize,
    brain: s.FileUseBrain,
    brief: s.MeetingBriefEnabled,
  };
}

async function openEngine(cfg: EngineConfig): Promise<Engine> {
  const job = await FileJob.open(cfg.dir, cfg.kind, cfg.device, cfg.threads, cfg.script);
  return engineFromJob(job, { vad: cfg.vad, t });
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
    runDiarize: diarizeHook(undefined, () => t('Разделяю спикеров…', 'Separating speakers…')),
    load16k,
    outputPath,
    briefOutputPath: (txt) => MeetingBrief.outputPath(txt),
    brainOutputPath: (txt) => FileBrain.outputPath(txt),
    translateOutputPath: (txt) => Translate.outputPath(txt),
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
    writeFile: (p, data) => (typeof data === 'string' ? writeFileSync(p, data, 'utf8') : writeFileSync(p, data)),
    readFile: (p) => readFileSync(p, 'utf8'),
    briefBrain: () => {
      const s = readSettings();
      const target = MeetingBrief.target(s);
      return {
        target,
        instruction: s.MeetingBriefInstruction,
        cloud: MeetingBrief.cloudName(s),
        ask: FileBrain.createAsk(s, target === 'None' ? 'Local' : target),
      };
    },
    fileBrain: () => {
      const s = readSettings();
      const target = FileBrain.target(s);
      return { target, cloud: FileBrain.cloudName(s), ask: FileBrain.createAsk(s, target === 'None' ? 'Local' : target) };
    },
    translateBrain: () => {
      const s = readSettings();
      const target = Translate.target(s);
      return {
        target,
        to: s.TranslateTarget,
        ask: FileBrain.createAsk(s, target === 'None' ? 'Local' : target),
      };
    },
    historyPath: historyFilePath,
    clock: () => Date.now(),
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
      // A local Brain (llama-server child) started for brain / brief / translate must not outlive the run.
      LocalBrain.getRuntime().stop?.();
      await Log.flush();
      process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(`chawo-va: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
