import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelFile,
  Qwen3Bytes,
  isReady,
  modelPath,
  tryParseCustomUrl,
} from '../src/main/brain/localBrain';
import { defaults } from '../src/main/settings';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'chawo-brain-'));
  process.env.CHAWO_LOCALAPPDATA = root;
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
});

describe('LocalBrain helpers', () => {
  it('TryParseCustomUrl: HF blob→resolve, reject non-HF / non-gguf', () => {
    const ok = tryParseCustomUrl('https://huggingface.co/org/repo/blob/main/My Model.gguf');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.url).toContain('/resolve/main/');
      expect(ok.fileName.toLowerCase().endsWith('.gguf')).toBe(true);
      expect(ok.fileName).not.toContain(' ');
    }
    expect(tryParseCustomUrl('https://example.com/x.gguf').ok).toBe(false);
    expect(tryParseCustomUrl('https://huggingface.co/org/repo/blob/main/readme.md').ok).toBe(false);
    expect(tryParseCustomUrl('http://huggingface.co/org/repo/resolve/main/a.gguf').ok).toBe(false);
  });

  it('ModelPath and IsReady with temp dirs', () => {
    const s = defaults();
    s.BrainModel = 'Qwen3';
    s.BrainDevice = 'Cpu';
    const path = modelPath(s);
    expect(path.endsWith(ModelFile)).toBe(true);

    expect(isReady(s)).toBe(false);
    const brainDir = join(root, 'ChawoVoiceAssistant', 'brain');
    const engineDir = join(brainDir, 'engine-b10701');
    mkdirSync(engineDir, { recursive: true });
    const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    writeFileSync(join(engineDir, exe), 'x');
    // wrong size
    writeFileSync(path, Buffer.alloc(100));
    expect(isReady(s)).toBe(false);
    // exact Qwen3 size (sparse — do not allocate 2 GB)
    const fd = openSync(path, 'w');
    ftruncateSync(fd, Qwen3Bytes);
    closeSync(fd);
    expect(isReady(s)).toBe(true);
  });
});
