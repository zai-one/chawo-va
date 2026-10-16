import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run as migrateRun, flushLog, PROGRAM_EXE_NAMES } from '../src/dataMigration';
import { appDataDir, localDataDir, legacyLocalDir, legacyRoamingDir } from '../src/paths';

const ENV_KEYS = ['CHAWO_APPDATA', 'CHAWO_LOCALAPPDATA', 'PISAR_APPDATA', 'PISAR_LOCALAPPDATA'] as const;
let saved: Record<string, string | undefined> = {};
let root: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = mkdtempSync(join(tmpdir(), 'chawo-mig-'));
  process.env.CHAWO_APPDATA = join(root, 'roaming');
  process.env.CHAWO_LOCALAPPDATA = join(root, 'local');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('DataMigration', () => {
  it('moves local tree via staging and copies roaming (skipping models)', () => {
    const legLocal = legacyLocalDir();
    const legRoam = legacyRoamingDir();
    mkdirSync(join(legLocal, 'models', 'v3-e2e-rnnt'), { recursive: true });
    writeFileSync(join(legLocal, 'models', 'v3-e2e-rnnt', 'v3_e2e_rnnt.yaml'), 'cfg\n');
    writeFileSync(join(legLocal, 'note.txt'), 'local\n');

    mkdirSync(join(legRoam, 'models', 'skip'), { recursive: true });
    writeFileSync(join(legRoam, 'models', 'skip', 'big.bin'), 'weights');
    writeFileSync(join(legRoam, 'settings.json'), '{"RagFolder":"ok"}');

    migrateRun();
    flushLog();

    expect(existsSync(localDataDir())).toBe(true);
    expect(existsSync(join(localDataDir(), 'note.txt'))).toBe(true);
    expect(existsSync(join(localDataDir(), 'models', 'v3-e2e-rnnt', 'v3_e2e_rnnt.yaml'))).toBe(true);
    expect(existsSync(legLocal + '.migrating')).toBe(false);

    expect(existsSync(appDataDir())).toBe(true);
    expect(existsSync(join(appDataDir(), 'settings.json'))).toBe(true);
    expect(existsSync(join(appDataDir(), 'models'))).toBe(false);
    // roaming was copy: legacy settings still there
    expect(existsSync(join(legRoam, 'settings.json'))).toBe(true);
  });

  it('is a no-op when the new folder already exists', () => {
    mkdirSync(localDataDir(), { recursive: true });
    writeFileSync(join(localDataDir(), 'keep.txt'), 'x');
    mkdirSync(legacyLocalDir(), { recursive: true });
    writeFileSync(join(legacyLocalDir(), 'old.txt'), 'y');
    migrateRun();
    expect(readdirSync(localDataDir())).toEqual(['keep.txt']);
    expect(existsSync(join(legacyLocalDir(), 'old.txt'))).toBe(true);
  });

  it('rewrites absolute legacy paths inside settings.json', () => {
    const legLocal = legacyLocalDir();
    mkdirSync(legLocal, { recursive: true });
    const escaped = legLocal.replace(/\\/g, '\\\\');
    writeFileSync(
      join(legLocal, 'settings.json'),
      `{"RagFolder":"${escaped}\\\\docs"}`,
      'utf8',
    );
    // put settings under roaming legacy for copy path too — use local move which also rewrites
    migrateRun();
    const text = readFileSync(join(localDataDir(), 'settings.json'), 'utf8');
    expect(text).toContain(localDataDir().replace(/\\/g, '\\\\'));
    expect(text).not.toContain(escaped + '\\\\docs');
  });

  it('exposes program exe names for delete safety', () => {
    expect(PROGRAM_EXE_NAMES).toContain('ChawoVoiceAssistant.exe');
    expect(PROGRAM_EXE_NAMES).toContain('GigaPisar.exe');
  });
});
