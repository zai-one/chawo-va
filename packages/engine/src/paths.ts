// App data locations. Port of Settings.*Dir / DataMigration.Legacy* / Env from the WPF app.
// Overridable via CHAWO_* (and legacy PISAR_*) for tests and portable installs.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SpeechModelKind } from '@chawo/core/speechModels';
import { modelFolder } from '@chawo/core/speechModels';

export const DATA_FOLDER = 'ChawoVoiceAssistant';
export const LEGACY_FOLDER = 'GigaPisar';

/** CHAWO_<name>, falling back to PISAR_<name> (pre-1.17.0 spelling). */
export function env(name: string): string | undefined {
  const chawo = process.env['CHAWO_' + name];
  if (chawo && chawo.length > 0) return chawo;
  const pisar = process.env['PISAR_' + name];
  if (pisar && pisar.length > 0) return pisar;
  return undefined;
}

function roamingRoot(): string {
  const o = env('APPDATA');
  if (o) return o;
  if (process.platform === 'win32') {
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function localRoot(): string {
  const o = env('LOCALAPPDATA');
  if (o) return o;
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  }
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

/** %APPDATA%\ChawoVoiceAssistant (settings, catalog, keys). */
export function appDataDir(): string {
  return join(roamingRoot(), DATA_FOLDER);
}

/** %LOCALAPPDATA%\ChawoVoiceAssistant (models, brain, logs). */
export function localDataDir(): string {
  return join(localRoot(), DATA_FOLDER);
}

export function legacyLocalDir(): string {
  return join(localRoot(), LEGACY_FOLDER);
}

export function legacyRoamingDir(): string {
  return join(roamingRoot(), LEGACY_FOLDER);
}

export function modelDirectory(kind: SpeechModelKind): string {
  return join(localDataDir(), 'models', modelFolder(kind));
}

export function settingsPath(): string {
  return join(appDataDir(), 'settings.json');
}

export function logPath(): string {
  return join(localDataDir(), 'chawo-va.log');
}

/** Snippets («вставь подпись»): shared by the «Словарь» page, dictation and `chawo-va snippets`. */
export function snippetsPath(): string {
  return join(appDataDir(), 'snippets.json');
}

/** Custom «Кратко и задачи» templates; shared by the File page and `chawo-va brief --template`. */
export function briefTemplatesPath(): string {
  return join(appDataDir(), 'brief-templates.json');
}

/** Custom call checklists («Проверка по чек-листу»); shared by the File page and `chawo-va score`. */
export function checklistsPath(): string {
  return join(appDataDir(), 'checklists.json');
}

/** «Словарь из исправлений»: counted word fixes and the «Добавлять сами» switch (learned-words.json). */
export function learnedWordsPath(): string {
  return join(appDataDir(), 'learned-words.json');
}

/** «В CRM» settings with the tokens (crm.json, owner-only). Shared by the app and `chawo-va crm`. */
export function crmConfigPath(): string {
  return join(appDataDir(), 'crm.json');
}

/**
 * chawo.db: dictation history (the «История» page and `chawo-va history`) and the «В CRM» journal of
 * what was sent (keys, ids, times; no text, no tokens). Older history.jsonl / crm-sent.json beside it
 * are imported on first use.
 */
export function databasePath(): string {
  return join(localDataDir(), 'chawo.db');
}

export function lastTakePath(): string {
  return join(localDataDir(), 'last.wav');
}

/** Optional absolute model search override (CHAWO_MODEL_DIR / PISAR_MODEL_DIR). */
export function modelDirOverride(): string | undefined {
  return env('MODEL_DIR');
}
