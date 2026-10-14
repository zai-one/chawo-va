#!/usr/bin/env node
// chawo-va CLI entry: `chawo-va transcribe <files, folders or links…>` (and brief / translate / history). Plain Node (no Electron window, no
// Chromium decoder). Settings are read, never written. See src/cli/run.ts.

import './core/ortPrivacy';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { downloadsFolder } from './core/mediaUrl';
import * as YtDlp from './main/file/ytDlpTool';
import { FileJob } from './core/fileJob';
import { applyLanguage, t } from './core/strings';
import { scriptCommand } from './core/postScript';
import { engineFromJob } from './cli/engine';
import { diarizeHook } from './main/diarize/diarizeRuntime';
import { runCli, EXIT_INTERRUPTED, type CliDefaults, type CliDeps, type Engine, type EngineConfig } from './cli/run';
import * as Log from './main/log';
import { findComplete, looksComplete } from './main/models/speechModelStore';
import { briefTemplatesPath, checklistsPath, crmConfigPath, crmSentPath, env, historyFilePath, learnedWordsPath, settingsPath, snippetsPath } from './main/paths';
import * as AskSources from './main/history/askSources';
import * as BriefTemplates from './main/brain/briefTemplates';
import * as CallScore from './main/brain/callScore';
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
    score: s.CallScoreEnabled,
    checklist: s.CallScoreChecklist,
    callTrackers: s.CallTrackers,
    mcpEnabled: s.McpEnabled,
  };
}

/** ~/.config/user-dirs.dirs (Linux XDG Downloads), or null. */
function userDirs(): string | null {
  try {
    return readFileSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'user-dirs.dirs'), 'utf8');
  } catch {
    return null;
  }
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
        instruction: BriefTemplates.resolveInstruction(s.MeetingBriefTemplate, s.MeetingBriefInstruction, BriefTemplates.loadCustom(briefTemplatesPath())).instruction,
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
    findYtDlp: () => YtDlp.find(),
    fetchAudio: (url, outDir, progress, signal) => YtDlp.fetchAudio(url, outDir, { progress, signal }),
    urlFolder: () => join(downloadsFolder(process.platform, homedir(), userDirs(), join), 'Chawo'),
    historyPath: historyFilePath,
    askBrain: () => {
      const s = readSettings();
      const target = FileBrain.target(s);
      return { target, cloud: FileBrain.cloudName(s), ask: FileBrain.createAsk(s, target === 'None' ? 'Local' : target) };
    },
    askFolders: () => {
      const s = readSettings();
      const docs = AskSources.documentsFolder(process.platform, homedir(), userDirs());
      const meet = AskSources.meetingFolders(docs, env('MEETINGS_DIR'));
      return [...meet, ...AskSources.parseFolders(s.AskFolders)];
    },
    snippetsPath,
    learnedPath: learnedWordsPath,
    settingsFile: settingsPath,
    meetingDetectSettings: () => {
      const s = readSettings();
      return {
        MeetingAutoDetectApps: s.MeetingAutoDetectApps,
        MeetingAutoDetectCalendar: s.MeetingAutoDetectCalendar,
      };
    },
    briefTemplates: () => BriefTemplates.loadCustom(briefTemplatesPath()),
    checklists: () => CallScore.loadCustom(checklistsPath()),
    crmConfigPath,
    crmSentPath,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    ask: async (question) => {
      const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stderr });
      try {
        const a = await new Promise<string>((res) => rl.question(question, res));
        return /^(y|yes|д|да)$/i.test(a.trim());
      } finally {
        rl.close();
      }
    },
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    mcpIo: () => {
      // The protocol owns stdout: keep a handle to the real writer, then send every other
      // stdout write (console.log in a library, a stray warning) to stderr so it cannot corrupt it.
      const real = process.stdout.write.bind(process.stdout);
      process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
      console.log = console.error;
      console.info = console.error;
      console.debug = console.error;
      // The client went away (EPIPE): nobody is listening, so leave quietly instead of a stack trace.
      process.stdout.on('error', () => process.exit(0));
      return { input: process.stdin, write: (s: string) => void real(s) };
    },
    clock: () => Date.now(),
    log: (line) => Log.write(line),
    now: () => Date.now(),
    signal,
  };
}

if (require.main === module) {
  const ac = new AbortController();
  const onStop = () => {
    if (ac.signal.aborted) process.exit(EXIT_INTERRUPTED);
    ac.abort();
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
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
