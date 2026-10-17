// User settings JSON in %APPDATA%\ChawoVoiceAssistant\settings.json.
// Shape and load/save rules match src/App/Settings.cs (JsonStringEnumConverter PascalCase).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseAppRules, type AppRule } from '@chawo/core/appRules';
import { DEFAULT_RULES, formatRules, parseRules, type ReplacePair } from '@chawo/core/wordReplace';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '@chawo/core/speechModels';
import type { FileParallelismKind } from '@chawo/core/fileParallel';
import { HERMES_PORT } from '@chawo/core/speechModels';
import { DEFAULT_IDLE_UNLOAD_MINUTES, normalizeIdleMinutes } from '@chawo/core/idleTimer';
import { write as logWrite } from './log';
import { appDataDir, settingsPath } from './paths';
import { All as BRAIN_PROVIDERS, providerIdFromUrl } from './brain/brainProviders';
import { readSecret, SECRET, writeSecret } from './secrets';
import { HISTORY_KEEPS, type HistoryKeep } from './history/historyStore';

export type InsertMode = 'Type' | 'Paste';
export type NetworkRole = 'Host' | 'Client';
export type AppMode = 'Dictation' | 'Sales';
export type UiLanguage = 'Auto' | 'Russian' | 'English';
export type BrainSource = 'Off' | 'Local' | 'Server';
/** Built-in models, a Hugging Face link, or any .gguf already on disk (BrainModelFile). */
export type LocalBrainKind = 'Qwen3' | 'Qwen35' | 'Custom' | 'File';
export type BrainDeviceKind = 'Cpu' | 'Gpu';
/** How «Мозг» edits each take: ready prompts, or the user's own instruction (BrainInstruction). */
export type BrainStyle = 'Clean' | 'Edit' | 'Format' | 'Custom';

/** PascalCase names as written by the WPF JsonStringEnumConverter. */
export type SettingsSpeechModel = 'MultilingualLargeCtc' | 'V3E2eRnnt';
export type SettingsSpeechDevice = 'Gpu' | 'Cpu';
export type SettingsCtcScript = 'Auto' | 'Russian' | 'English';
export type SettingsFileParallelism = 'Auto' | 'Gentle1' | 'Two' | 'Four' | 'Max';

export const LEFT_CTRL_WIN_HOTKEY = 0x10000;

export interface SalesCatalogItem {
  Code: string;
  Name: string;
  Line: string;
  SimilarCode: string;
}

export interface SettingsData {
  HotkeyVk: number;
  InsertMode: InsertMode;
  ShowOverlay: boolean;
  /** Soft start/stop tones for a take (TS port only; off by default). */
  SoundCues: boolean;
  /** «Чаво» starts a take hands-free (local only, off by default). */
  WakeWord: boolean;
  CopyPhraseToClipboard: boolean;
  RestoreClipboardAfterCopy: boolean;
  KeepLastRecording: boolean;
  /** How long the dictation history keeps takes («История»); Off keeps nothing. */
  HistoryKeep: HistoryKeep;
  FirstRunDone: boolean;
  Language: UiLanguage;
  CheckUpdates: boolean;
  Brain: BrainSource;
  SpeechModel: SettingsSpeechModel;
  SpeechDevice: SettingsSpeechDevice;
  CpuThreads: number;
  FileParallelism: SettingsFileParallelism;
  FileTimestamps: boolean;
  FileSrt: boolean;
  /** Extra outputs beside the .txt besides .srt (TS port only; WPF ignores the key). */
  FileExtraFormats: FileExtraFormat[];
  FileUseBrain: boolean;
  /** Opt-in local speaker diarization after file transcription. */
  FileDiarize: boolean;
  /** «Запись встречи»: also record the computer sound (Zoom/Teams/Telegram), not just the mic. */
  MeetingSystemAudio: boolean;
  /** Offer to record when Zoom/Teams/… or a local .ics event looks active. Off by default. */
  MeetingAutoDetect: boolean;
  /** When MeetingAutoDetect is on: watch known meeting apps (Windows/Linux process heuristics). */
  MeetingAutoDetectApps: boolean;
  /** Optional path to a .ics file or a folder of .ics (local calendar only, no cloud APIs). */
  MeetingAutoDetectCalendar: string;
  /** After file/meeting transcription, also write name.brief.txt («Кратко и задачи»). Off by default. */
  MeetingBriefEnabled: boolean;
  /** User-editable format instruction for the brief card; empty = built-in default. */
  MeetingBriefInstruction: string;
  /** Selected «Кратко и задачи» template id/name; '' = own instruction (MeetingBriefInstruction). */
  MeetingBriefTemplate: string;
  /** «Проверка по чек-листу» after transcription → .score.json / .score.txt. */
  CallScoreEnabled: boolean;
  /** Selected checklist id/name; '' = built-in «Звонок продаж». */
  CallScoreChecklist: string;
  /** «Статистика разговора» trackers: «Название: термин, …» per line; '' = built-in (core/callStats). */
  CallTrackers: string;
  /** «Спросить историю»: extra folders with transcripts, one per line (the meetings folder is always searched). */
  AskFolders: string;
  /** `chawo-va mcp` (read-only MCP server for assistants) allowed; off by default. */
  McpEnabled: boolean;
  /** «Перевести»: last target language (code, name or free text); empty = auto (RU→EN, else →RU). */
  TranslateTarget: string;
  StartHintDismissed: boolean;
  MicrophoneId: string;
  BrainDevice: BrainDeviceKind;
  CtcScript: SettingsCtcScript;
  HermesOnLan: boolean;
  NetworkRole: NetworkRole;
  Mode: AppMode;
  SalesCatalog: SalesCatalogItem[];
  RagFolder: string;
  RemoteHost: string;
  RemotePort: number;
  KeepAwakeWhileListening: boolean;
  BrainEveryTake: boolean;
  BrainOnSelection: boolean;
  /** «Контекст для Мозга»: clipboard text goes to the Brain with the phrase. Opt-in, off by default. */
  BrainContextClipboard: boolean;
  /** «Контекст для Мозга»: the focused program and window title go to the Brain. Opt-in, off by default. */
  BrainContextApp: boolean;
  BrainModel: LocalBrainKind;
  BrainCustomUrl: string;
  /** BrainModel 'File': the .gguf on disk, picked from the list or with «Выбрать файл». */
  BrainModelFile: string;
  /** Where Brain models are downloaded and looked for; empty: the brain folder in the app data. */
  BrainModelsDir: string;
  BrainInstruction: string;
  BrainStyle: BrainStyle;
  SimpleSyntax: boolean;
  /** Silero VAD: trim silence around a take and cut long files at real pauses (needs the 2 MB model). */
  VadEnabled: boolean;
  /** Stop a take after this many ms of silence following speech; 0 = off (settings.json only for now). */
  VadAutoStopMs: number;
  /** Unload the speech model and the local Brain after this many idle minutes (0, 5, 15, 30, 60; 0 = never). */
  IdleUnloadMinutes: number;
  WordReplacementRules: string;
  /** «запятая», «новая строка» … → marks in a dictated phrase (IDEAS №9). Off by default. */
  SpokenPunctuation: boolean;
  /** «двадцать пять» → «25» in a dictated phrase. Off by default. */
  SpokenNumbers: boolean;
  /** «Свой скрипт»: command that gets the finished text on stdin and prints the new text; empty = off. */
  PostScript: string;
  /** Also run PostScript on file transcripts (.txt only). Off by default: dictation only. */
  PostScriptFiles: boolean;
  /** Per-app modes: overrides of the take editing for a focused program (first match wins). */
  AppRules: AppRule[];
  CleanupEndpointUrl: string;
  /** Plain API key in memory only; never written as plaintext. */
  CleanupApiKey: string;
  CleanupModel: string;
  ProviderKeys: Record<string, string>;
  ProviderModels: Record<string, string>;
  /**
   * «Голос» (TS port only): text-to-speech service id ('' = off: nothing is read aloud and nothing goes out).
   * Its key lives in ProviderKeys under the same id (shared with the Brain for the same service).
   */
  TtsProvider: string;
  /** Address of an own OpenAI-compatible speech server (TtsProvider 'tts-custom'). */
  TtsEndpointUrl: string;
  TtsModel: string;
  TtsVoice: string;
  /** Playback speed the player starts with, 0.5…2. */
  TtsSpeed: number;
  /** «Озвучить» button next to a text selected with the mouse in any app. */
  TtsSelectionButton: boolean;
  /** Key that reads the selection aloud (HOTKEY_CHOICES value), 0 = none. */
  TtsHotkeyVk: number;
  CleanupPrompt: string;
  OverlayX: number | null;
  OverlayY: number | null;
}

export function defaults(): SettingsData {
  return {
    HotkeyVk: 0xa3,
    InsertMode: 'Paste',
    ShowOverlay: true,
    SoundCues: false,
    WakeWord: false,
    CopyPhraseToClipboard: false,
    RestoreClipboardAfterCopy: true,
    KeepLastRecording: false,
    HistoryKeep: 'Week',
    FirstRunDone: false,
    Language: 'Auto',
    CheckUpdates: false,
    Brain: 'Off',
    SpeechModel: 'V3E2eRnnt',
    SpeechDevice: 'Gpu',
    CpuThreads: 0,
    FileParallelism: 'Auto',
    FileTimestamps: true,
    FileSrt: false,
    FileExtraFormats: [],
    FileUseBrain: false,
    FileDiarize: false,
    MeetingSystemAudio: true,
    MeetingAutoDetect: false,
    MeetingAutoDetectApps: true,
    MeetingAutoDetectCalendar: '',
    MeetingBriefEnabled: false,
    MeetingBriefInstruction: '',
    MeetingBriefTemplate: '',
    CallScoreEnabled: false,
    CallScoreChecklist: '',
    CallTrackers: '',
    AskFolders: '',
    McpEnabled: false,
    TranslateTarget: '',
    StartHintDismissed: false,
    MicrophoneId: '',
    BrainDevice: 'Cpu',
    CtcScript: 'Auto',
    HermesOnLan: false,
    NetworkRole: 'Host',
    Mode: 'Dictation',
    SalesCatalog: [],
    RagFolder: '',
    RemoteHost: '',
    RemotePort: HERMES_PORT,
    KeepAwakeWhileListening: false,
    BrainEveryTake: false,
    BrainOnSelection: true,
    BrainContextClipboard: false,
    BrainContextApp: false,
    BrainModel: 'Qwen3',
    BrainCustomUrl: '',
    BrainModelFile: '',
    BrainModelsDir: '',
    BrainInstruction: '',
    BrainStyle: 'Clean',
    SimpleSyntax: false,
    VadEnabled: true,
    VadAutoStopMs: 0,
    IdleUnloadMinutes: DEFAULT_IDLE_UNLOAD_MINUTES,
    WordReplacementRules: '',
    SpokenPunctuation: false,
    SpokenNumbers: false,
    PostScript: '',
    PostScriptFiles: false,
    AppRules: [],
    CleanupEndpointUrl: '',
    CleanupApiKey: '',
    CleanupModel: '',
    ProviderKeys: {},
    ProviderModels: {},
    TtsProvider: '',
    TtsEndpointUrl: '',
    TtsModel: '',
    TtsVoice: '',
    TtsSpeed: 1,
    TtsSelectionButton: true,
    TtsHotkeyVk: 0,
    CleanupPrompt: '',
    OverlayX: null,
    OverlayY: null,
  };
}

export function toSpeechModelKind(s: SettingsSpeechModel): SpeechModelKind {
  return s === 'V3E2eRnnt' ? 'v3_e2e_rnnt' : 'multilingual_large_ctc';
}

export function fromSpeechModelKind(k: SpeechModelKind): SettingsSpeechModel {
  return k === 'v3_e2e_rnnt' ? 'V3E2eRnnt' : 'MultilingualLargeCtc';
}

export function toSpeechDeviceKind(s: SettingsSpeechDevice): SpeechDeviceKind {
  return s === 'Gpu' ? 'gpu' : 'cpu';
}

export function toCtcScript(s: SettingsCtcScript): CtcScript {
  if (s === 'Russian') return 'russian';
  if (s === 'English') return 'english';
  return 'auto';
}

export function toFileParallelism(s: SettingsFileParallelism): FileParallelismKind {
  switch (s) {
    case 'Gentle1':
      return 1;
    case 'Two':
      return 2;
    case 'Four':
      return 4;
    case 'Max':
      return 'max';
    default:
      return 'auto';
  }
}

export function effectiveWordReplacementRules(s: SettingsData): string {
  return !s.WordReplacementRules || !s.WordReplacementRules.trim()
    ? DEFAULT_RULES
    : s.WordReplacementRules;
}

export function dictionaryRows(s: SettingsData): ReplacePair[] {
  if (!s.WordReplacementRules || !s.WordReplacementRules.trim()) return parseRules(DEFAULT_RULES);
  return parseRules(s.WordReplacementRules);
}

export function saveDictionary(s: SettingsData, rows: readonly ReplacePair[]): void {
  const kept = rows.filter((r) => r.from.trim().length > 0 || r.to.trim().length > 0);
  s.WordReplacementRules = kept.length === 0 ? '#' : formatRules(kept);
}

// --- secret protect / unprotect ---

type ProtectFn = (plain: string) => string;
type UnprotectFn = (stored: string) => string;

let protectImpl: ProtectFn | null = null;
let unprotectImpl: UnprotectFn | null = null;

/**
 * How secrets are sealed on disk. This module has no Electron import (the CLI and tests load it in plain
 * Node): the app installs electron.safeStorage at startup, tests install a reversible stand-in. Without a
 * codec nothing is sealed, so a secret is not written at all — never plaintext.
 */
export function setProtectHooks(protect: ProtectFn | null, unprotect: UnprotectFn | null): void {
  protectImpl = protect;
  unprotectImpl = unprotect;
}

export function protect(plain: string): string {
  if (!plain || !protectImpl) return '';
  try {
    return protectImpl(plain);
  } catch {
    logWrite('api key protect failed');
    return '';
  }
}

export function unprotect(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!unprotectImpl) {
    logWrite('api key unprotect failed: unavailable');
    return '';
  }
  try {
    return unprotectImpl(stored);
  } catch {
    logWrite('api key unprotect failed: hook');
    return '';
  }
}

export type FileExtraFormat = 'vtt' | 'json' | 'md' | 'docx';
export const FILE_EXTRA_FORMATS: readonly FileExtraFormat[] = ['vtt', 'json', 'md', 'docx'];

/** Known names only, each once, in the fixed order (so the file stays stable). */
export function asExtraFormats(v: unknown): FileExtraFormat[] {
  if (!Array.isArray(v)) return [];
  return FILE_EXTRA_FORMATS.filter((f) => v.includes(f));
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function parseCatalog(raw: unknown): SalesCatalogItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SalesCatalogItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    out.push({
      Code: asString(o.Code, ''),
      Name: asString(o.Name, ''),
      Line: asString(o.Line, ''),
      SimilarCode: asString(o.SimilarCode, ''),
    });
  }
  return out;
}

function parseStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/** Build SettingsData from a parsed JSON object (WPF or our own). */
export function fromJsonObject(raw: Record<string, unknown>): { settings: SettingsData; plainKeyOnDisk: boolean } {
  const d = defaults();
  let plainKeyOnDisk = false;

  d.HotkeyVk = asInt(raw.HotkeyVk, d.HotkeyVk);
  d.InsertMode = asEnum(raw.InsertMode, ['Type', 'Paste'] as const, d.InsertMode);
  d.ShowOverlay = asBool(raw.ShowOverlay, d.ShowOverlay);
  d.SoundCues = asBool(raw.SoundCues, d.SoundCues);
  d.WakeWord = asBool(raw.WakeWord, d.WakeWord);
  d.CopyPhraseToClipboard = asBool(raw.CopyPhraseToClipboard, d.CopyPhraseToClipboard);
  d.RestoreClipboardAfterCopy = asBool(raw.RestoreClipboardAfterCopy, d.RestoreClipboardAfterCopy);
  d.KeepLastRecording = asBool(raw.KeepLastRecording, d.KeepLastRecording);
  d.HistoryKeep = asEnum(raw.HistoryKeep, HISTORY_KEEPS, d.HistoryKeep);
  d.FirstRunDone = asBool(raw.FirstRunDone, d.FirstRunDone);
  d.Language = asEnum(raw.Language, ['Auto', 'Russian', 'English'] as const, d.Language);
  d.CheckUpdates = asBool(raw.CheckUpdates, d.CheckUpdates);
  d.Brain = asEnum(raw.Brain, ['Off', 'Local', 'Server'] as const, d.Brain);
  d.SpeechModel = asEnum(
    raw.SpeechModel,
    ['MultilingualLargeCtc', 'V3E2eRnnt'] as const,
    d.SpeechModel,
  );
  d.SpeechDevice = asEnum(raw.SpeechDevice, ['Gpu', 'Cpu'] as const, d.SpeechDevice);
  d.CpuThreads = asInt(raw.CpuThreads, d.CpuThreads);
  d.FileParallelism = asEnum(
    raw.FileParallelism,
    ['Auto', 'Gentle1', 'Two', 'Four', 'Max'] as const,
    d.FileParallelism,
  );
  d.FileTimestamps = asBool(raw.FileTimestamps, d.FileTimestamps);
  d.FileSrt = asBool(raw.FileSrt, d.FileSrt);
  d.FileExtraFormats = asExtraFormats(raw.FileExtraFormats);
  d.FileUseBrain = asBool(raw.FileUseBrain, d.FileUseBrain);
  d.FileDiarize = asBool(raw.FileDiarize, d.FileDiarize);
  d.MeetingSystemAudio = asBool(raw.MeetingSystemAudio, d.MeetingSystemAudio);
  d.MeetingAutoDetect = asBool(raw.MeetingAutoDetect, d.MeetingAutoDetect);
  d.MeetingAutoDetectApps = asBool(raw.MeetingAutoDetectApps, d.MeetingAutoDetectApps);
  d.MeetingAutoDetectCalendar = asString(raw.MeetingAutoDetectCalendar, d.MeetingAutoDetectCalendar);
  d.MeetingBriefEnabled = asBool(raw.MeetingBriefEnabled, d.MeetingBriefEnabled);
  d.MeetingBriefInstruction = asString(raw.MeetingBriefInstruction, d.MeetingBriefInstruction);
  d.MeetingBriefTemplate = asString(raw.MeetingBriefTemplate, d.MeetingBriefTemplate);
  d.CallScoreEnabled = asBool(raw.CallScoreEnabled, d.CallScoreEnabled);
  d.CallScoreChecklist = asString(raw.CallScoreChecklist, d.CallScoreChecklist);
  d.CallTrackers = asString(raw.CallTrackers, d.CallTrackers).slice(0, 8000);
  d.AskFolders = asString(raw.AskFolders, d.AskFolders).slice(0, 8000);
  d.McpEnabled = asBool(raw.McpEnabled, d.McpEnabled);
  d.TranslateTarget = asString(raw.TranslateTarget, d.TranslateTarget);
  d.StartHintDismissed = asBool(raw.StartHintDismissed, d.StartHintDismissed);
  d.MicrophoneId = asString(raw.MicrophoneId, d.MicrophoneId);
  d.BrainDevice = asEnum(raw.BrainDevice, ['Cpu', 'Gpu'] as const, d.BrainDevice);
  d.CtcScript = asEnum(raw.CtcScript, ['Auto', 'Russian', 'English'] as const, d.CtcScript);
  d.HermesOnLan = asBool(raw.HermesOnLan, d.HermesOnLan);
  d.NetworkRole = asEnum(raw.NetworkRole, ['Host', 'Client'] as const, d.NetworkRole);
  d.Mode = asEnum(raw.Mode, ['Dictation', 'Sales'] as const, d.Mode);
  d.SalesCatalog = parseCatalog(raw.SalesCatalog);
  d.RagFolder = asString(raw.RagFolder, d.RagFolder);
  d.RemoteHost = asString(raw.RemoteHost, d.RemoteHost);
  d.RemotePort = asInt(raw.RemotePort, d.RemotePort);
  d.KeepAwakeWhileListening = asBool(raw.KeepAwakeWhileListening, d.KeepAwakeWhileListening);
  d.BrainEveryTake = asBool(raw.BrainEveryTake, d.BrainEveryTake);
  d.BrainOnSelection = asBool(raw.BrainOnSelection, d.BrainOnSelection);
  d.BrainContextClipboard = asBool(raw.BrainContextClipboard, d.BrainContextClipboard);
  d.BrainContextApp = asBool(raw.BrainContextApp, d.BrainContextApp);
  d.BrainModel = asEnum(raw.BrainModel, ['Qwen3', 'Qwen35', 'Custom', 'File'] as const, d.BrainModel);
  d.BrainCustomUrl = asString(raw.BrainCustomUrl, d.BrainCustomUrl);
  d.BrainModelFile = asString(raw.BrainModelFile, d.BrainModelFile).slice(0, 1024);
  d.BrainModelsDir = asString(raw.BrainModelsDir, d.BrainModelsDir).slice(0, 1024);
  d.BrainInstruction = asString(raw.BrainInstruction, d.BrainInstruction);
  // Before the ready styles a written instruction was the way to edit: it stays in use.
  d.BrainStyle = asEnum(raw.BrainStyle, ['Clean', 'Edit', 'Format', 'Custom'] as const, d.BrainInstruction.trim() ? 'Custom' : d.BrainStyle);
  d.SimpleSyntax = asBool(raw.SimpleSyntax, d.SimpleSyntax);
  d.VadEnabled = asBool(raw.VadEnabled, d.VadEnabled);
  d.VadAutoStopMs = Math.min(60_000, Math.max(0, asInt(raw.VadAutoStopMs, d.VadAutoStopMs)));
  d.IdleUnloadMinutes = raw.IdleUnloadMinutes === undefined ? d.IdleUnloadMinutes : normalizeIdleMinutes(raw.IdleUnloadMinutes);
  d.WordReplacementRules = asString(raw.WordReplacementRules, d.WordReplacementRules);
  d.SpokenPunctuation = asBool(raw.SpokenPunctuation, d.SpokenPunctuation);
  d.SpokenNumbers = asBool(raw.SpokenNumbers, d.SpokenNumbers);
  d.PostScript = asString(raw.PostScript, d.PostScript);
  d.PostScriptFiles = asBool(raw.PostScriptFiles, d.PostScriptFiles);
  d.AppRules = parseAppRules(raw.AppRules);
  d.CleanupEndpointUrl = asString(raw.CleanupEndpointUrl, d.CleanupEndpointUrl);
  d.CleanupModel = asString(raw.CleanupModel, d.CleanupModel);
  d.ProviderModels = parseStringMap(raw.ProviderModels);
  d.TtsProvider = asString(raw.TtsProvider, d.TtsProvider).slice(0, 64);
  d.TtsEndpointUrl = asString(raw.TtsEndpointUrl, d.TtsEndpointUrl).slice(0, 2048);
  d.TtsModel = asString(raw.TtsModel, d.TtsModel).slice(0, 200);
  d.TtsVoice = asString(raw.TtsVoice, d.TtsVoice).slice(0, 200);
  d.TtsSpeed = Math.min(2, Math.max(0.5, typeof raw.TtsSpeed === 'number' && Number.isFinite(raw.TtsSpeed) ? raw.TtsSpeed : d.TtsSpeed));
  d.TtsSelectionButton = asBool(raw.TtsSelectionButton, d.TtsSelectionButton);
  d.TtsHotkeyVk = asInt(raw.TtsHotkeyVk, d.TtsHotkeyVk);
  d.CleanupPrompt = asString(raw.CleanupPrompt, d.CleanupPrompt);
  d.OverlayX = typeof raw.OverlayX === 'number' && Number.isFinite(raw.OverlayX) ? Math.trunc(raw.OverlayX) : null;
  d.OverlayY = typeof raw.OverlayY === 'number' && Number.isFinite(raw.OverlayY) ? Math.trunc(raw.OverlayY) : null;

  // Legacy CleanupEnabled → Server + every take
  if (raw.CleanupEnabled === true && d.Brain === 'Off') {
    d.Brain = 'Server';
    d.BrainEveryTake = true;
  }

  // Protected keys
  if (typeof raw.CleanupApiKeyProtected === 'string' && raw.CleanupApiKeyProtected.length > 0) {
    d.CleanupApiKey = unprotect(raw.CleanupApiKeyProtected);
  }
  // Legacy plaintext CleanupApiKey
  if (typeof raw.CleanupApiKey === 'string' && raw.CleanupApiKey.length > 0) {
    if (d.CleanupApiKey.length === 0) d.CleanupApiKey = raw.CleanupApiKey;
    plainKeyOnDisk = true;
  }

  if (raw.ProviderKeysProtected && typeof raw.ProviderKeysProtected === 'object') {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.ProviderKeysProtected as Record<string, unknown>)) {
      if (typeof v !== 'string' || !v) continue;
      const plain = unprotect(v);
      if (plain) map[k] = plain;
    }
    d.ProviderKeys = map;
  }

  return { settings: d, plainKeyOnDisk };
}

/** Disk shape: memory-only fields and secrets are left out (secrets go to the vault, see save). */
export function toJsonObject(s: SettingsData): Record<string, unknown> {
  const o: Record<string, unknown> = {
    HotkeyVk: s.HotkeyVk,
    InsertMode: s.InsertMode,
    ShowOverlay: s.ShowOverlay,
    SoundCues: s.SoundCues,
    WakeWord: s.WakeWord,
    CopyPhraseToClipboard: s.CopyPhraseToClipboard,
    RestoreClipboardAfterCopy: s.RestoreClipboardAfterCopy,
    KeepLastRecording: s.KeepLastRecording,
    HistoryKeep: s.HistoryKeep,
    FirstRunDone: s.FirstRunDone,
    Language: s.Language,
    CheckUpdates: false,
    Brain: s.Brain,
    SpeechModel: s.SpeechModel,
    SpeechDevice: s.SpeechDevice,
    CpuThreads: s.CpuThreads,
    FileParallelism: s.FileParallelism,
    FileTimestamps: s.FileTimestamps,
    FileSrt: s.FileSrt,
    FileExtraFormats: [...s.FileExtraFormats],
    FileUseBrain: s.FileUseBrain,
    FileDiarize: s.FileDiarize,
    MeetingSystemAudio: s.MeetingSystemAudio,
    MeetingAutoDetect: s.MeetingAutoDetect,
    MeetingAutoDetectApps: s.MeetingAutoDetectApps,
    MeetingAutoDetectCalendar: s.MeetingAutoDetectCalendar,
    MeetingBriefEnabled: s.MeetingBriefEnabled,
    MeetingBriefInstruction: s.MeetingBriefInstruction,
    MeetingBriefTemplate: s.MeetingBriefTemplate,
    CallScoreEnabled: s.CallScoreEnabled,
    CallScoreChecklist: s.CallScoreChecklist,
    CallTrackers: s.CallTrackers,
    AskFolders: s.AskFolders,
    McpEnabled: s.McpEnabled,
    TranslateTarget: s.TranslateTarget,
    StartHintDismissed: s.StartHintDismissed,
    MicrophoneId: s.MicrophoneId,
    BrainDevice: s.BrainDevice,
    CtcScript: s.CtcScript,
    HermesOnLan: s.HermesOnLan,
    NetworkRole: s.NetworkRole,
    Mode: s.Mode,
    SalesCatalog: s.SalesCatalog,
    RagFolder: s.RagFolder,
    RemoteHost: s.RemoteHost,
    RemotePort: s.RemotePort,
    KeepAwakeWhileListening: false,
    BrainEveryTake: s.BrainEveryTake,
    BrainOnSelection: s.BrainOnSelection,
    BrainContextClipboard: s.BrainContextClipboard,
    BrainContextApp: s.BrainContextApp,
    BrainModel: s.BrainModel,
    BrainCustomUrl: s.BrainCustomUrl,
    BrainModelFile: s.BrainModelFile,
    BrainModelsDir: s.BrainModelsDir,
    BrainInstruction: s.BrainInstruction,
    BrainStyle: s.BrainStyle,
    SimpleSyntax: s.SimpleSyntax,
    VadEnabled: s.VadEnabled,
    VadAutoStopMs: s.VadAutoStopMs,
    IdleUnloadMinutes: s.IdleUnloadMinutes,
    WordReplacementRules: s.WordReplacementRules,
    SpokenPunctuation: s.SpokenPunctuation,
    SpokenNumbers: s.SpokenNumbers,
    PostScript: s.PostScript,
    PostScriptFiles: s.PostScriptFiles,
    AppRules: s.AppRules,
    CleanupEndpointUrl: s.CleanupEndpointUrl,
    CleanupModel: s.CleanupModel,
    ProviderModels: s.ProviderModels,
    TtsProvider: s.TtsProvider,
    TtsEndpointUrl: s.TtsEndpointUrl,
    TtsModel: s.TtsModel,
    TtsVoice: s.TtsVoice,
    TtsSpeed: s.TtsSpeed,
    TtsSelectionButton: s.TtsSelectionButton,
    TtsHotkeyVk: s.TtsHotkeyVk,
    CleanupPrompt: s.CleanupPrompt,
    OverlayX: s.OverlayX,
    OverlayY: s.OverlayY,
  };

  return o;
}

/** Provider ids whose keys may be stored (the known services and «Свой сервер»). */
// The speech service of «Голос» keeps its key here too (its id may be one the Brain does not know).
const providerIds = (s: SettingsData): string[] =>
  [...new Set([...BRAIN_PROVIDERS.map((p) => p.id), ...Object.keys(s.ProviderKeys), ...(s.TtsProvider ? [s.TtsProvider] : [])])];

/**
 * Fills the API keys from the vault (OS credential store or secrets.json). A key found there wins over
 * a sealed copy in settings.json from an older version. Used by the app and, read-only, by the CLI.
 */
export function withSecrets(s: SettingsData): SettingsData {
  const cleanup = readSecret(SECRET.cleanupKey);
  if (cleanup) s.CleanupApiKey = cleanup;
  for (const id of providerIds(s)) {
    const v = readSecret(SECRET.providerKey(id));
    if (v) s.ProviderKeys[id] = v;
  }
  return s;
}

/**
 * Keys into the vault; settings.json gets none. Only where the vault refuses a write does a key stay
 * in settings.json, sealed with the OS (safeStorage) as before — never in plain text.
 */
function storeSecrets(s: SettingsData, o: Record<string, unknown>): void {
  if (!writeSecret(SECRET.cleanupKey, s.CleanupApiKey)) {
    const enc = s.CleanupApiKey ? protect(s.CleanupApiKey) : '';
    if (enc) o.CleanupApiKeyProtected = enc;
  }
  const sealed: Record<string, string> = {};
  for (const id of providerIds(s)) {
    const v = s.ProviderKeys[id] ?? '';
    if (writeSecret(SECRET.providerKey(id), v)) continue;
    const enc = v ? protect(v) : '';
    if (enc) sealed[id] = enc;
  }
  if (Object.keys(sealed).length > 0) o.ProviderKeysProtected = sealed;
}

export function load(): SettingsData {
  try {
    const path = settingsPath();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const { settings: parsed, plainKeyOnDisk } = fromJsonObject(raw);
      const s = withSecrets(parsed);
      // Keys of an older version sit sealed in settings.json: move them into the vault once.
      const sealedOnDisk = typeof raw.CleanupApiKeyProtected === 'string' || (raw.ProviderKeysProtected !== null && typeof raw.ProviderKeysProtected === 'object');

      if (Object.keys(s.ProviderKeys).length === 0 && s.CleanupApiKey.length > 0) {
        const id = providerIdFromUrl(s.CleanupEndpointUrl);
        s.ProviderKeys[id] = s.CleanupApiKey;
        if (s.CleanupModel.length > 0) s.ProviderModels[id] = s.CleanupModel;
        save(s);
      } else if (plainKeyOnDisk || sealedOnDisk) {
        save(s);
      }

      s.CheckUpdates = false;
      if (s.KeepAwakeWhileListening) {
        s.KeepAwakeWhileListening = false;
        save(s);
      }
      return s;
    }
  } catch (e) {
    logWrite(`settings load failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return defaults();
}

export function save(s: SettingsData): void {
  try {
    const o = toJsonObject(s);
    storeSecrets(s, o);
    mkdirSync(appDataDir(), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(o, null, 2) + '\n', 'utf8');
  } catch (e) {
    logWrite(`settings save failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const HOTKEY_CHOICES: { vk: number; ru: string; en: string }[] = [
  { vk: 0xa3, ru: 'Правый Ctrl', en: 'Right Ctrl' },
  { vk: LEFT_CTRL_WIN_HOTKEY, ru: 'Левый Ctrl + Win', en: 'Left Ctrl + Win' },
  { vk: 0xa5, ru: 'Правый Alt', en: 'Right Alt' },
  { vk: 0xa1, ru: 'Правый Shift', en: 'Right Shift' },
  { vk: 0x14, ru: 'Caps Lock', en: 'Caps Lock' },
  { vk: 0x91, ru: 'Scroll Lock', en: 'Scroll Lock' },
  { vk: 0x2d, ru: 'Insert', en: 'Insert' },
];
