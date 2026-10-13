// User settings JSON in %APPDATA%\ChawoVoiceAssistant\settings.json.
// Shape and load/save rules match src/App/Settings.cs (JsonStringEnumConverter PascalCase).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_RULES, formatRules, parseRules, type ReplacePair } from '../core/wordReplace';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from '../core/speechModels';
import type { FileParallelismKind } from '../core/fileParallel';
import { HERMES_PORT } from '../core/speechModels';
import { write as logWrite } from './log';
import { appDataDir, settingsPath } from './paths';
import { providerIdFromUrl } from './brainProviders';

export type InsertMode = 'Type' | 'Paste';
export type NetworkRole = 'Host' | 'Client';
export type AppMode = 'Dictation' | 'Sales';
export type UiLanguage = 'Auto' | 'Russian' | 'English';
export type BrainSource = 'Off' | 'Local' | 'Server';
export type LocalBrainKind = 'Qwen3' | 'Qwen35' | 'Custom';
export type BrainDeviceKind = 'Cpu' | 'Gpu';

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
  CopyPhraseToClipboard: boolean;
  RestoreClipboardAfterCopy: boolean;
  KeepLastRecording: boolean;
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
  FileUseBrain: boolean;
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
  BrainModel: LocalBrainKind;
  BrainCustomUrl: string;
  BrainInstruction: string;
  SimpleSyntax: boolean;
  WordReplacementRules: string;
  /** «запятая», «новая строка» … → marks in a dictated phrase (IDEAS №9). Off by default. */
  SpokenPunctuation: boolean;
  /** «двадцать пять» → «25» in a dictated phrase. Off by default. */
  SpokenNumbers: boolean;
  CleanupEndpointUrl: string;
  /** Plain API key in memory only; never written as plaintext. */
  CleanupApiKey: string;
  CleanupModel: string;
  ProviderKeys: Record<string, string>;
  ProviderModels: Record<string, string>;
  CleanupPrompt: string;
  OverlayX: number | null;
  OverlayY: number | null;
}

export function defaults(): SettingsData {
  return {
    HotkeyVk: 0xa3,
    InsertMode: 'Paste',
    ShowOverlay: true,
    CopyPhraseToClipboard: false,
    RestoreClipboardAfterCopy: true,
    KeepLastRecording: false,
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
    FileUseBrain: false,
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
    BrainModel: 'Qwen3',
    BrainCustomUrl: '',
    BrainInstruction: '',
    SimpleSyntax: false,
    WordReplacementRules: '',
    SpokenPunctuation: false,
    SpokenNumbers: false,
    CleanupEndpointUrl: '',
    CleanupApiKey: '',
    CleanupModel: '',
    ProviderKeys: {},
    ProviderModels: {},
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

/** Tests may inject a reversible hook. Production uses electron.safeStorage when available. */
export function setProtectHooks(protect: ProtectFn | null, unprotect: UnprotectFn | null): void {
  protectImpl = protect;
  unprotectImpl = unprotect;
}

function trySafeStorageProtect(plain: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      safeStorage?: {
        isEncryptionAvailable: () => boolean;
        encryptString: (s: string) => Buffer;
        decryptString: (b: Buffer) => string;
      };
    };
    const ss = electron.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
      return ss.encryptString(plain).toString('base64');
    }
  } catch {
    /* not in Electron, or safeStorage unavailable */
  }
  return null;
}

function trySafeStorageUnprotect(stored: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      safeStorage?: {
        isEncryptionAvailable: () => boolean;
        decryptString: (b: Buffer) => string;
      };
    };
    const ss = electron.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
      return ss.decryptString(Buffer.from(stored, 'base64'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function protect(plain: string): string {
  if (!plain) return '';
  if (protectImpl) return protectImpl(plain);
  const via = trySafeStorageProtect(plain);
  // Never write plaintext secrets to disk.
  return via ?? '';
}

export function unprotect(stored: string | null | undefined): string {
  if (!stored) return '';
  if (unprotectImpl) {
    try {
      return unprotectImpl(stored);
    } catch {
      logWrite('api key unprotect failed: hook');
      return '';
    }
  }
  const via = trySafeStorageUnprotect(stored);
  if (via !== null) return via;
  logWrite('api key unprotect failed: unavailable');
  return '';
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
  d.CopyPhraseToClipboard = asBool(raw.CopyPhraseToClipboard, d.CopyPhraseToClipboard);
  d.RestoreClipboardAfterCopy = asBool(raw.RestoreClipboardAfterCopy, d.RestoreClipboardAfterCopy);
  d.KeepLastRecording = asBool(raw.KeepLastRecording, d.KeepLastRecording);
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
  d.FileUseBrain = asBool(raw.FileUseBrain, d.FileUseBrain);
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
  d.BrainModel = asEnum(raw.BrainModel, ['Qwen3', 'Qwen35', 'Custom'] as const, d.BrainModel);
  d.BrainCustomUrl = asString(raw.BrainCustomUrl, d.BrainCustomUrl);
  d.BrainInstruction = asString(raw.BrainInstruction, d.BrainInstruction);
  d.SimpleSyntax = asBool(raw.SimpleSyntax, d.SimpleSyntax);
  d.WordReplacementRules = asString(raw.WordReplacementRules, d.WordReplacementRules);
  d.SpokenPunctuation = asBool(raw.SpokenPunctuation, d.SpokenPunctuation);
  d.SpokenNumbers = asBool(raw.SpokenNumbers, d.SpokenNumbers);
  d.CleanupEndpointUrl = asString(raw.CleanupEndpointUrl, d.CleanupEndpointUrl);
  d.CleanupModel = asString(raw.CleanupModel, d.CleanupModel);
  d.ProviderModels = parseStringMap(raw.ProviderModels);
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

/** Disk shape: omit memory-only fields; write protected secrets when encryption works. */
export function toJsonObject(s: SettingsData): Record<string, unknown> {
  const o: Record<string, unknown> = {
    HotkeyVk: s.HotkeyVk,
    InsertMode: s.InsertMode,
    ShowOverlay: s.ShowOverlay,
    CopyPhraseToClipboard: s.CopyPhraseToClipboard,
    RestoreClipboardAfterCopy: s.RestoreClipboardAfterCopy,
    KeepLastRecording: s.KeepLastRecording,
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
    FileUseBrain: s.FileUseBrain,
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
    BrainModel: s.BrainModel,
    BrainCustomUrl: s.BrainCustomUrl,
    BrainInstruction: s.BrainInstruction,
    SimpleSyntax: s.SimpleSyntax,
    WordReplacementRules: s.WordReplacementRules,
    SpokenPunctuation: s.SpokenPunctuation,
    SpokenNumbers: s.SpokenNumbers,
    CleanupEndpointUrl: s.CleanupEndpointUrl,
    CleanupModel: s.CleanupModel,
    ProviderModels: s.ProviderModels,
    CleanupPrompt: s.CleanupPrompt,
    OverlayX: s.OverlayX,
    OverlayY: s.OverlayY,
  };

  if (s.CleanupApiKey.length > 0) {
    const enc = protect(s.CleanupApiKey);
    if (enc) o.CleanupApiKeyProtected = enc;
    // else omit: never write plaintext
  }

  const pk: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.ProviderKeys)) {
    if (!v) continue;
    const enc = protect(v);
    if (enc) pk[k] = enc;
  }
  if (Object.keys(pk).length > 0) o.ProviderKeysProtected = pk;

  return o;
}

export function load(): SettingsData {
  try {
    const path = settingsPath();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const { settings: s, plainKeyOnDisk } = fromJsonObject(raw);

      if (Object.keys(s.ProviderKeys).length === 0 && s.CleanupApiKey.length > 0) {
        const id = providerIdFromUrl(s.CleanupEndpointUrl);
        s.ProviderKeys[id] = s.CleanupApiKey;
        if (s.CleanupModel.length > 0) s.ProviderModels[id] = s.CleanupModel;
        save(s);
      } else if (plainKeyOnDisk) {
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
    mkdirSync(appDataDir(), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(toJsonObject(s), null, 2) + '\n', 'utf8');
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
