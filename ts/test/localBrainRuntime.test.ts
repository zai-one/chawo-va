// LocalBrain process runtime against a fake llama-server (a small Node script). No model, no network.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '../src/core/strings';
import * as LocalBrain from '../src/main/brain/localBrain';
import { LlamaServerRuntime, serverArgs, type RuntimeOptions, type SpawnLike } from '../src/main/brain/localBrain';
import { BrainException } from '../src/main/brain/speechCleanup';
import * as Settings from '../src/main/settings';
import type { BrainDeviceKind } from '../src/main/settings';

const FIXTURE = join(__dirname, 'fixtures', 'fake-llama-server.cjs');
let root: string;
let argsFile: string;
let cpuExe: string;
let gpuExe: string;
const runtimes: LlamaServerRuntime[] = [];

/** Runs the script through this Node so it works without a shebang (Windows too). */
const nodeSpawn: SpawnLike = (cmd, args, o) => spawn(process.execPath, [cmd, ...args], o);

beforeAll(() => {
  applyLanguage('Russian');
  root = mkdtempSync(join(tmpdir(), 'chawo-brain-rt-'));
  argsFile = join(root, 'args.jsonl');
  process.env.FAKE_LLAMA_ARGS = argsFile;
  cpuExe = join(root, 'engine-cpu', 'llama-server');
  gpuExe = join(root, 'engine-gpu', 'llama-server');
  for (const exe of [cpuExe, gpuExe]) {
    mkdirSync(join(exe, '..'), { recursive: true });
    copyFileSync(FIXTURE, exe);
    chmodSync(exe, 0o755);
  }
});
afterEach(() => {
  for (const r of runtimes.splice(0)) r.stop();
});
afterAll(() => {
  delete process.env.FAKE_LLAMA_ARGS;
  rmSync(root, { recursive: true, force: true });
});

function settings(model: string, device: BrainDeviceKind = 'Cpu') {
  const s = Settings.defaults();
  s.Brain = 'Local';
  s.BrainModel = 'Custom';
  s.BrainCustomUrl = `https://huggingface.co/a/b/resolve/main/${model}.gguf`;
  s.BrainDevice = device;
  return s;
}

function make(over: RuntimeOptions = {}) {
  const rt = new LlamaServerRuntime({
    spawn: nodeSpawn,
    isReady: () => true,
    exeFor: (k) => (k === 'Gpu' ? gpuExe : cpuExe),
    modelPathFor: (s) => join(root, LocalBrain.tryParseCustomUrl(s.BrainCustomUrl).ok ? (LocalBrain.tryParseCustomUrl(s.BrainCustomUrl) as { fileName: string }).fileName : 'x.gguf'),
    logPath: () => join(root, 'brain.log'),
    healthDelayMs: 50,
    ...over,
  });
  runtimes.push(rt);
  return rt;
}

function launches(): { pid: number; args: string[]; exe: string }[] {
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const signal = () => new AbortController().signal;

describe('LlamaServerRuntime (fake llama-server)', () => {
  it('starts with the WPF arguments, answers on the endpoint with the key, reuses, stops', async () => {
    const before = launches().length;
    const rt = make();
    const s = settings('good');
    expect(rt.running).toBe(false);
    await rt.ensureStarted(s, () => {}, signal());
    expect(rt.running).toBe(true);
    expect(rt.endpointUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(rt.apiKey).toMatch(/^[0-9A-F]{32}$/);
    const l = launches().slice(before);
    expect(l.length).toBe(1);
    const port = Number(/:(\d+)\/v1$/.exec(rt.endpointUrl)![1]);
    expect(l[0]!.args).toEqual(serverArgs(join(root, 'good.gguf'), port, rt.apiKey, 'Cpu'));
    expect(l[0]!.args).toEqual([
      '-m', join(root, 'good.gguf'), '--host', '127.0.0.1', '--port', String(port), '--api-key', rt.apiKey,
      '-c', '2048', '--no-webui', '--jinja', '--reasoning', 'off', '--reasoning-budget', '0',
      '--chat-template-kwargs', '{"enable_thinking":false}',
    ]);

    const ok = await fetch(rt.endpointUrl + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + rt.apiKey } });
    expect(ok.status).toBe(200);

    await rt.ensureStarted(s, () => {}, signal());
    expect(launches().length - before).toBe(1); // same model, same device: reused

    expect(readFileSync(join(root, 'brain.log'), 'utf8')).toContain('fake llama-server starting');
    const pid = l[0]!.pid;
    rt.stop();
    expect(rt.running).toBe(false);
    await until(() => !alive(pid));
  });

  it('another model restarts the server; concurrent callers share one start', async () => {
    const rt = make();
    const before = launches().length;
    await Promise.all([rt.ensureStarted(settings('one'), () => {}, signal()), rt.ensureStarted(settings('one'), () => {}, signal())]);
    expect(launches().length - before).toBe(1);
    const first = launches()[launches().length - 1]!.pid;
    await rt.ensureStarted(settings('two'), () => {}, signal());
    expect(launches().length - before).toBe(2);
    await until(() => !alive(first));
  });

  it('GPU crash falls back to the CPU engine with the WPF note, and stays there', async () => {
    // The fake crashes on any model path containing "crash"; route the GPU launch to it via a wrapper spawn.
    const rt2 = make({
      spawn: (cmd, args, o) => {
        const a = [...args];
        if (cmd === gpuExe) a[a.indexOf('-m') + 1] = 'crash.gguf';
        return nodeSpawn(cmd, a, o);
      },
    });
    const before = launches().length;
    const s = settings('fallback', 'Gpu');
    await rt2.ensureStarted(s, () => {}, signal());
    const l = launches().slice(before);
    expect(l.map((x) => x.exe)).toEqual([gpuExe, cpuExe]);
    expect(l[0]!.args.slice(-2)).toEqual(['-ngl', '99']);
    expect(l[1]!.args).not.toContain('-ngl');
    expect(rt2.deviceNote).toBe('Видеокарта не поднялась, мозг считает на процессоре.');
    expect(rt2.loadedOn).toBe('Cpu');
    await rt2.ensureStarted(s, () => {}, signal());
    expect(launches().length - before).toBe(2); // no new GPU attempt on every phrase
    rt2.stop();
    expect(rt2.loadedOn).toBeNull();
  });

  it('a crash without a CPU engine is a BrainException naming the log', async () => {
    const rt = make({ exeFor: (k) => (k === 'Gpu' ? gpuExe : join(root, 'missing', 'llama-server')) });
    const e = await rt.ensureStarted(settings('crash', 'Gpu'), () => {}, signal()).catch((x) => x);
    expect(e).toBeInstanceOf(BrainException);
    expect((e as Error).message).toBe(`нейронка упала при запуске, подробности в ${join(root, 'brain.log')}`);
  });

  it('no answer within the start timeout: stopped and reported', async () => {
    const rt = make({ startTimeoutMs: 400 });
    const before = launches().length;
    const e = await rt.ensureStarted(settings('mute'), () => {}, signal()).catch((x) => x);
    expect((e as Error).message).toBe('нейронка не поднялась за полторы минуты');
    expect(rt.running).toBe(false);
    await until(() => launches().length > before);
    const pid = launches()[launches().length - 1]!.pid;
    await until(() => !alive(pid));
  });

  it('slow start reports seconds from 3 on', async () => {
    const rt = make();
    const ticks: number[] = [];
    await rt.ensureStarted(settings('slow'), (sec) => ticks.push(sec), signal());
    expect(ticks[0]).toBe(3);
  }, 10_000);

  it('idle stop releases the server', async () => {
    const rt = make({ idleStopMs: 150 });
    await rt.ensureStarted(settings('idle'), () => {}, signal());
    const pid = launches()[launches().length - 1]!.pid;
    expect(rt.running).toBe(true);
    await until(() => !rt.running);
    await until(() => !alive(pid));
  });

  it('idle delay follows a live getter; 0 keeps the server; touch() counts from the last answer', async () => {
    let ms = 0;
    const rt = make({ idleStopMs: () => ms });
    await rt.ensureStarted(settings('idle-live'), () => {}, signal());
    await new Promise((r) => setTimeout(r, 300));
    expect(rt.running).toBe(true);
    ms = 400;
    rt.touch();
    await new Promise((r) => setTimeout(r, 250));
    rt.touch();
    await new Promise((r) => setTimeout(r, 250));
    expect(rt.running).toBe(true);
    await until(() => !rt.running);
    // Not running: touch() does not arm anything.
    rt.touch();
    expect(rt.running).toBe(false);
  }, 10_000);

  it('not ready: clear error before anything starts; cancel while waiting is an AbortError', async () => {
    const before = launches().length;
    const rt = make({ isReady: () => false });
    await expect(rt.ensureStarted(settings('x'), () => {}, signal())).rejects.toThrow('модель Мозга не скачана');
    const rt2 = make({ isReady: () => false, exeFor: () => join(root, 'nope') });
    await expect(rt2.ensureStarted(settings('x'), () => {}, signal())).rejects.toThrow('движок мозга не скачан');
    expect(launches().length).toBe(before);

    const rt3 = make();
    const ac = new AbortController();
    const p = rt3.ensureStarted(settings('mute2-mute'), () => {}, ac.signal);
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('module stop() goes to the active runtime', async () => {
    const rt = make();
    LocalBrain.setRuntime(rt);
    await LocalBrain.ensureStarted(settings('mod'), () => {}, signal());
    expect(LocalBrain.Running.value).toBe(true);
    expect(LocalBrain.endpointUrl()).toBe(rt.endpointUrl);
    LocalBrain.stop();
    expect(LocalBrain.Running.value).toBe(false);
    LocalBrain.resetRuntime();
  });

  it.skipIf(process.platform === 'win32')('default spawn runs the binary itself (shebang script)', async () => {
    const rt = make({ spawn: undefined });
    await rt.ensureStarted(settings('direct'), () => {}, signal());
    expect(rt.running).toBe(true);
  });
});

describe('real disk checks feed the runtime', () => {
  it('isReady via disk: custom GGUF magic + engine present', () => {
    const saved = process.env.CHAWO_LOCALAPPDATA;
    process.env.CHAWO_LOCALAPPDATA = join(root, 'appdata');
    try {
      const s = settings('disk');
      expect(LocalBrain.isReady(s)).toBe(false);
      mkdirSync(LocalBrain.engineDirFor('Cpu'), { recursive: true });
      writeFileSync(LocalBrain.serverExeFor('Cpu'), 'x');
      const g = Buffer.alloc(2048, 1);
      g.write('GGUF', 0, 'ascii');
      writeFileSync(LocalBrain.modelPath(s), g);
      expect(LocalBrain.isReady(s)).toBe(true);
      writeFileSync(LocalBrain.modelPath(s), Buffer.alloc(2048, 1));
      expect(LocalBrain.isReady(s)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CHAWO_LOCALAPPDATA;
      else process.env.CHAWO_LOCALAPPDATA = saved;
    }
  });
});
