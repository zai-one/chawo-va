// «Место на диске»: what is found, what is preselected, what is never touched, and that remove() deletes
// only items of a fresh scan.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import * as LocalBrain from '../src/brain/localBrain';
import { remove, scan, sizeText, type CleanupItem, type CleanupOptions } from '../src/cleanup/diskCleanup';
import * as Settings from '../src/settings';

let root = '';
let local = '';
let roaming = '';
const saved = { local: process.env.CHAWO_LOCALAPPDATA, roaming: process.env.CHAWO_APPDATA };
const DAY = 86_400_000;

function file(path: string, bytes = 10, ageMs = 0): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path, t, t);
  }
  return path;
}

const opts = (extra: Partial<CleanupOptions> = {}): CleanupOptions => ({ settings: Settings.defaults(), ...extra });
const byLabel = (items: CleanupItem[], re: RegExp) => items.find((i) => re.test(i.label));

beforeEach(() => {
  applyLanguage('Russian');
  root = mkdtempSync(join(tmpdir(), 'chawo-cleanup-'));
  process.env.CHAWO_LOCALAPPDATA = join(root, 'local');
  process.env.CHAWO_APPDATA = join(root, 'roaming');
  local = join(root, 'local', 'ChawoVoiceAssistant');
  roaming = join(root, 'roaming', 'ChawoVoiceAssistant');
  mkdirSync(local, { recursive: true });
  mkdirSync(roaming, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [['CHAWO_LOCALAPPDATA', saved.local], ['CHAWO_APPDATA', saved.roaming]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('scan', () => {
  it('finds leftovers of older versions, unfinished downloads, old engines and plain-text copies', () => {
    file(join(root, 'local', 'GigaPisar', 'models', 'old.onnx'), 1000);
    file(join(local, 'model.tar.gz.part'), 500, DAY);
    file(join(local, 'brain', 'engine-b9000', 'llama-server'), 300);
    file(join(local, 'history.jsonl.bak'), 50);
    file(join(roaming, 'settings.json.123.abc.tmp'), 5, DAY);
    file(join(local, 'last.wav'), 70);
    const items = scan(opts());
    const legacy = byLabel(items, /GigaPisar/);
    expect(legacy).toMatchObject({ group: 'legacy', preselected: true, bytes: 1000 });
    expect(byLabel(items, /Недокачанный/)).toMatchObject({ group: 'partial', preselected: true, bytes: 500 });
    expect(byLabel(items, /Старые версии движка/)).toMatchObject({ group: 'unused', preselected: true, bytes: 300 });
    expect(byLabel(items, /Копия истории/)).toMatchObject({ group: 'privacy', preselected: true });
    expect(byLabel(items, /Временные/)).toMatchObject({ group: 'temp', preselected: true });
    expect(byLabel(items, /Последняя запись/)).toMatchObject({ preselected: true });
  });

  it('a file still being written (changed in the last 10 minutes) is not offered', () => {
    file(join(local, 'model.tar.gz.part'), 500);
    file(join(roaming, 'snippets.json.tmp'), 5);
    const items = scan(opts());
    expect(byLabel(items, /Недокачанный/)).toBeUndefined();
    expect(byLabel(items, /Временные/)).toBeUndefined();
  });

  it('never offers what is in use, nor a folder that holds it', () => {
    const s = Settings.defaults();
    const engine = file(join(LocalBrain.engineDirFor(s.BrainDevice), 'llama-server'), 100);
    const chosen = file(LocalBrain.modelPath(s), 2000);
    const other = file(join(local, 'brain', 'other.gguf'), 3000);
    const oldModel = file(join(root, 'local', 'GigaPisar', 'model', 'encoder.onnx'), 10);
    file(LocalBrain.modelPath(s) + '.part', 100, DAY);
    const items = scan(opts({ settings: s, keep: [oldModel] }));
    const all = items.flatMap((i) => i.paths);
    expect(all).not.toContain(chosen);
    expect(all.some((p) => engine.startsWith(p))).toBe(false);
    expect(byLabel(items, /GigaPisar/)).toBeUndefined();
    // Another Brain model is offered but not ticked; the chosen model's .part resumes, so it is not ticked either.
    expect(items.find((i) => i.paths.includes(other))).toMatchObject({ preselected: false });
    expect(byLabel(items, /докачается/)).toMatchObject({ preselected: false });
  });

  it('offers recordings only with a transcript next to them and older than the limit, never ticked', () => {
    const meetings = join(root, 'Встречи');
    const done = file(join(meetings, 'a.wav'), 1000, 40 * DAY);
    file(join(meetings, 'a.txt'), 5);
    file(join(meetings, 'b.wav'), 1000, 40 * DAY); // no transcript
    file(join(meetings, 'c.wav'), 1000, 2 * DAY); // too recent
    file(join(meetings, 'c.txt'), 5);
    const downloads = join(root, 'Downloads', 'Chawo');
    const dl = file(join(downloads, 'talk.m4a'), 400, 40 * DAY);
    file(join(downloads, 'talk.srt'), 5);
    file(join(downloads, 'talk2.webm.part'), 50, DAY);
    const items = scan(opts({ meetings: [meetings, join(root, 'Meetings')], downloads }));
    expect(byLabel(items, /Записи встреч/)).toMatchObject({ group: 'recordings', paths: [done], preselected: false, bytes: 1000 });
    expect(byLabel(items, /скачанное по ссылкам/)).toMatchObject({ group: 'downloads', paths: [dl], preselected: false });
    expect(items.find((i) => i.paths.some((p) => p.endsWith('talk2.webm.part')))).toMatchObject({ group: 'partial', preselected: true });
    expect(existsSync(join(meetings, 'a.txt'))).toBe(true);
  });

  it('the same leftovers get the same id on the next scan', () => {
    file(join(local, 'history.jsonl.bak'), 50);
    expect(scan(opts()).map((i) => i.id)).toEqual(scan(opts()).map((i) => i.id));
  });
});

describe('remove', () => {
  it('deletes the chosen items of a fresh scan and reports the space freed', () => {
    const legacy = file(join(root, 'local', 'GigaPisar', 'x.bin'), 1000);
    const bak = file(join(local, 'history.jsonl.bak'), 50);
    const items = scan(opts());
    const id = byLabel(items, /GigaPisar/)!.id;
    const r = remove([id, 'not-an-id'], opts());
    expect(r).toMatchObject({ freedBytes: 1000, failed: [] });
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(root, 'local', 'GigaPisar'))).toBe(false);
    expect(existsSync(bak)).toBe(true);
  });

  it('an item that became in use after the scan is not deleted', () => {
    const other = file(join(local, 'brain', 'other.gguf'), 3000);
    const id = scan(opts()).find((i) => i.paths.includes(other))!.id;
    const s = Settings.defaults();
    s.BrainModel = 'Custom';
    s.BrainCustomUrl = 'https://huggingface.co/x/y/resolve/main/other.gguf';
    expect(remove([id], opts({ settings: s })).removed).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });
});

describe('old engines after an engine update', () => {
  it('pruneOldEngines removes other versions and keeps the current one (CPU and GPU)', () => {
    const cpu = file(join(LocalBrain.engineDirFor('Cpu'), 'llama-server'));
    const gpu = file(join(LocalBrain.engineDirFor('Gpu'), 'llama-server'));
    file(join(local, 'brain', 'engine-b9000', 'llama-server'));
    file(join(local, 'brain', 'engine-b9000-vulkan', 'llama-server'));
    expect(LocalBrain.pruneOldEngines().sort()).toEqual(['engine-b9000', 'engine-b9000-vulkan']);
    expect([existsSync(cpu), existsSync(gpu)]).toEqual([true, true]);
  });
});

it('sizeText', () => {
  expect([sizeText(500), sizeText(5 * 1024 ** 2), sizeText(2.4 * 1024 ** 3)]).toEqual(['1 КБ', '5 МБ', '2,4 ГБ']);
});
