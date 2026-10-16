// The Windows package config (package.json "build", electron-builder): no model weights, the CLI launcher
// and the native helper are shipped, native modules are unpacked from app.asar.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  main: string;
  build: {
    files: string[];
    asarUnpack: string[];
    extraResources: { from: string; to: string; filter: string[] }[];
    npmRebuild: boolean;
    win: { target: { target: string }[]; extraFiles: { from: string; to: string }[]; icon: string };
  };
};

describe('Windows packaging config', () => {
  it('excludes model weights and other platforms\' ORT binaries', () => {
    const f = pkg.build.files;
    expect(f).toContain('out/**/*');
    expect(f.some((x) => x.startsWith('!') && x.includes('onnx') && x.includes('gguf'))).toBe(true);
    expect(f).toContain('!node_modules/onnxruntime-node/bin/napi-v*/linux/**');
    expect(f).toContain('!node_modules/onnxruntime-node/bin/napi-v*/darwin/**');
  });

  it('builds an installer and a portable zip with the CLI next to the exe', () => {
    expect(pkg.build.win.target.map((t) => t.target).sort()).toEqual(['nsis', 'zip']);
    const cli = pkg.build.win.extraFiles.find((x) => x.to === 'chawo-va.cmd');
    expect(cli).toBeTruthy();
    const cmd = readFileSync(join(root, cli!.from), 'utf8');
    expect(cmd).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(cmd).toContain('ChawoVoiceAssistant.exe');
    expect(cmd).toContain('resources\\app.asar\\out\\main\\cli.js');
    expect(cmd).toContain('\r\n');
  });

  it('ships the native helper in resources\\native and unpacks native modules', () => {
    const r = pkg.build.extraResources.find((x) => x.to === 'native');
    expect(r?.filter).toContain('ChawoNative.exe');
    expect(pkg.build.asarUnpack).toContain('node_modules/onnxruntime-node/**');
    expect(pkg.build.asarUnpack.some((x) => x.includes('sherpa-onnx'))).toBe(true);
    expect(pkg.build.npmRebuild).toBe(false); // N-API modules, no rebuild against Electron
  });
});
