import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appDataDir,
  localDataDir,
  legacyLocalDir,
  modelDirectory,
  settingsPath,
  logPath,
} from '../src/main/paths';
import {
  defaults,
  dictionaryRows,
  effectiveWordReplacementRules,
  fromJsonObject,
  load,
  save,
  saveDictionary,
  setProtectHooks,
  toJsonObject,
  protect,
  unprotect,
} from '../src/main/settings';
import { write as logWrite, flush as logFlush } from '../src/main/log';
import { DEFAULT_RULES } from '../src/core/wordReplace';

const ENV_KEYS = [
  'CHAWO_APPDATA',
  'CHAWO_LOCALAPPDATA',
  'PISAR_APPDATA',
  'PISAR_LOCALAPPDATA',
  'CHAWO_MODEL_DIR',
  'PISAR_MODEL_DIR',
] as const;

let saved: Record<string, string | undefined> = {};
let root: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = mkdtempSync(join(tmpdir(), 'chawo-settings-'));
  process.env.CHAWO_APPDATA = join(root, 'roaming');
  process.env.CHAWO_LOCALAPPDATA = join(root, 'local');
  setProtectHooks(null, null);
});

afterEach(() => {
  setProtectHooks(null, null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('paths', () => {
  it('builds ChawoVoiceAssistant under overridden parents', () => {
    expect(appDataDir()).toBe(join(root, 'roaming', 'ChawoVoiceAssistant'));
    expect(localDataDir()).toBe(join(root, 'local', 'ChawoVoiceAssistant'));
    expect(legacyLocalDir()).toBe(join(root, 'local', 'GigaPisar'));
    expect(modelDirectory('v3_e2e_rnnt')).toBe(
      join(root, 'local', 'ChawoVoiceAssistant', 'models', 'v3-e2e-rnnt'),
    );
    expect(settingsPath()).toBe(join(appDataDir(), 'settings.json'));
    expect(logPath()).toBe(join(localDataDir(), 'chawo-va.log'));
  });
});

describe('settings', () => {
  it('round-trips without secrets', () => {
    const s = defaults();
    s.HotkeyVk = 0xa5;
    s.InsertMode = 'Type';
    s.SpeechModel = 'MultilingualLargeCtc';
    s.FileParallelism = 'Four';
    s.WordReplacementRules = 'а -> b\n';
    s.SalesCatalog = [{ Code: 'X1', Name: 'Item', Line: 'line', SimilarCode: '' }];
    s.OverlayX = 10;
    s.OverlayY = 20;
    save(s);
    const loaded = load();
    expect(loaded.HotkeyVk).toBe(0xa5);
    expect(loaded.InsertMode).toBe('Type');
    expect(loaded.SpeechModel).toBe('MultilingualLargeCtc');
    expect(loaded.FileParallelism).toBe('Four');
    expect(loaded.WordReplacementRules).toBe('а -> b\n');
    expect(loaded.SalesCatalog).toEqual(s.SalesCatalog);
    expect(loaded.OverlayX).toBe(10);
    expect(loaded.CheckUpdates).toBe(false);
    expect(loaded.KeepAwakeWhileListening).toBe(false);
    const disk = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    expect(disk.CleanupApiKey).toBeUndefined();
    expect(disk.CleanupApiKeyProtected).toBeUndefined();
  });

  it('never writes plaintext API keys without a protect hook', () => {
    const s = defaults();
    s.CleanupApiKey = 'sk-secret';
    s.ProviderKeys = { deepseek: 'sk-secret' };
    const obj = toJsonObject(s);
    expect(obj.CleanupApiKey).toBeUndefined();
    expect(obj.CleanupApiKeyProtected).toBeUndefined();
    expect(obj.ProviderKeysProtected).toBeUndefined();
  });

  it('protects secrets when a hook is injected', () => {
    setProtectHooks(
      (p) => Buffer.from(p, 'utf8').toString('base64'),
      (s) => Buffer.from(s, 'base64').toString('utf8'),
    );
    expect(protect('abc')).toBe(Buffer.from('abc').toString('base64'));
    expect(unprotect(protect('hello'))).toBe('hello');

    const s = defaults();
    s.CleanupApiKey = 'sk-test';
    s.ProviderKeys = { deepseek: 'sk-test' };
    save(s);
    const disk = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    expect(disk.CleanupApiKey).toBeUndefined();
    expect(typeof disk.CleanupApiKeyProtected).toBe('string');
    expect(disk.CleanupApiKeyProtected).not.toContain('sk-test');

    const loaded = load();
    expect(loaded.CleanupApiKey).toBe('sk-test');
    expect(loaded.ProviderKeys.deepseek).toBe('sk-test');
  });

  it('migrates legacy CleanupEnabled and blank dictionary defaults', () => {
    const { settings } = fromJsonObject({ CleanupEnabled: true, Brain: 'Off' });
    expect(settings.Brain).toBe('Server');
    expect(settings.BrainEveryTake).toBe(true);
    expect(effectiveWordReplacementRules(defaults())).toBe(DEFAULT_RULES);
    expect(dictionaryRows(defaults()).length).toBeGreaterThan(0);
    const s = defaults();
    saveDictionary(s, []);
    expect(s.WordReplacementRules).toBe('#');
    expect(dictionaryRows(s)).toEqual([]);
  });

  it('forces CheckUpdates and KeepAwakeWhileListening off on load', () => {
    mkdirSync(appDataDir(), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ CheckUpdates: true, KeepAwakeWhileListening: true }),
      'utf8',
    );
    const s = load();
    expect(s.CheckUpdates).toBe(false);
    expect(s.KeepAwakeWhileListening).toBe(false);
    const disk = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    expect(disk.KeepAwakeWhileListening).toBe(false);
  });
});

describe('log', () => {
  it('appends without throwing', async () => {
    logWrite('hello from test');
    await logFlush();
    expect(existsSync(logPath())).toBe(true);
    expect(readFileSync(logPath(), 'utf8')).toContain('hello from test');
  });
});
