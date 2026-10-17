// LocalBrain download: resumable fetch, engine unpack, model fallback and checks. Never touches the network:
// every request goes to an in-memory fake that understands Range.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { applyLanguage } from '@chawo/core/strings';
import * as LocalBrain from '../src/brain/localBrain';
import { buildZip } from '../src/file/zip';
import {
  fetchResumable,
  InvalidDataError,
  ModelDownloadException,
  sha256Hex,
  verifyShaAsync,
} from '../src/models/modelDownloader';
import { buildUstarTree, unpackTarGzTree } from '../src/models/tarGz';
import * as Settings from '../src/settings';

beforeAll(() => applyLanguage('Russian'));

let root: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CHAWO_LOCALAPPDATA;
  root = mkdtempSync(join(tmpdir(), 'chawo-brain-dl-'));
  process.env.CHAWO_LOCALAPPDATA = root;
});
afterEach(() => {
  LocalBrain.resetRuntime();
  rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CHAWO_LOCALAPPDATA;
  else process.env.CHAWO_LOCALAPPDATA = saved;
});

interface Req { url: string; range: string | null }

/** Fake fetch over a URL → bytes map. Range honoured unless ignoreRange; dropAt cuts the first response. */
function fakeNet(files: Record<string, Buffer>, opts: { ignoreRange?: boolean; dropAt?: number; status?: Record<string, number>; hang?: boolean } = {}) {
  const reqs: Req[] = [];
  let dropped = false;
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.Range ?? null;
    reqs.push({ url, range });
    const forced = opts.status?.[url];
    if (forced) return new Response('nope', { status: forced });
    const data = files[url];
    if (!data) return new Response('missing', { status: 404 });
    let start = 0;
    let status = 200;
    if (range && !opts.ignoreRange) {
      start = Number(/bytes=(\d+)-/.exec(range)![1]);
      if (start >= data.length) return new Response(null, { status: 416 });
      status = 206;
    }
    const body = data.subarray(start);
    const signal = init?.signal;
    const drop = opts.dropAt != null && !dropped;
    if (drop) dropped = true;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        if (opts.hang) {
          signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          return;
        }
        if (drop) return;
        for (let i = 0; i < body.length; i += 4096) c.enqueue(new Uint8Array(body.subarray(i, i + 4096)));
        c.close();
      },
      pull(c) {
        if (!drop) return;
        // First read gets the bytes, the next one sees the connection die.
        if (!sent) {
          sent = true;
          c.enqueue(new Uint8Array(body.subarray(0, opts.dropAt)));
        } else c.error(new TypeError('terminated'));
      },
    });
    return new Response(stream, { status, headers: { 'content-length': String(body.length) } });
  }) as unknown as typeof fetch;
  return { f, reqs };
}

const gguf = (n: number, fill = 7) => {
  const b = Buffer.alloc(n, fill);
  b.write('GGUF', 0, 'ascii');
  return b;
};

const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

function engineZip() {
  const zip = buildZip([
    { name: exeName, data: Buffer.from('#!fake server'), deflate: true },
    { name: 'ggml.dll', data: Buffer.alloc(300, 1) },
  ]);
  const spec: LocalBrain.EngineSpec = { url: 'https://example.test/engine.zip', sha256: sha256Hex(zip), bytes: zip.length, archive: 'zip' };
  return { zip, spec };
}

describe('fetchResumable (C# FetchAsync)', () => {
  const url = 'https://example.test/m.gguf';
  const data = gguf(50_000);

  it('fresh download writes the file and reports progress', async () => {
    const { f, reqs } = fakeNet({ [url]: data });
    const dest = join(root, 'a.part');
    const seen: number[] = [];
    await fetchResumable(url, dest, data.length, (r) => seen.push(r), undefined, { fetch: f });
    expect(readFileSync(dest).equals(data)).toBe(true);
    expect(reqs[0].range).toBeNull();
    expect(seen[seen.length - 1]).toBe(data.length);
  });

  it('continues a .part with Range: 206 appends the rest', async () => {
    const { f, reqs } = fakeNet({ [url]: data });
    const dest = join(root, 'b.part');
    writeFileSync(dest, data.subarray(0, 12_345));
    await fetchResumable(url, dest, data.length, null, undefined, { fetch: f });
    expect(reqs[0].range).toBe('bytes=12345-');
    expect(readFileSync(dest).equals(data)).toBe(true);
  });

  it('a dropped connection keeps the .part and the next call resumes', async () => {
    const { f, reqs } = fakeNet({ [url]: data }, { dropAt: 20_000 });
    const dest = join(root, 'c.part');
    await expect(fetchResumable(url, dest, data.length, null, undefined, { fetch: f })).rejects.toThrow();
    expect(statSync(dest).size).toBe(20_000);
    await fetchResumable(url, dest, data.length, null, undefined, { fetch: f });
    expect(reqs[1].range).toBe('bytes=20000-');
    expect(readFileSync(dest).equals(data)).toBe(true);
  });

  it('416 on a resumed request means already complete', async () => {
    const { f } = fakeNet({ [url]: data });
    const dest = join(root, 'd.part');
    writeFileSync(dest, data);
    await fetchResumable(url, dest, data.length, null, undefined, { fetch: f });
    expect(readFileSync(dest).equals(data)).toBe(true);
  });

  it('a server that ignores Range (200) restarts from zero', async () => {
    const { f } = fakeNet({ [url]: data }, { ignoreRange: true });
    const dest = join(root, 'e.part');
    writeFileSync(dest, Buffer.alloc(1000, 9));
    await fetchResumable(url, dest, data.length, null, undefined, { fetch: f });
    expect(readFileSync(dest).equals(data)).toBe(true);
  });

  it('larger than expected is refused (InvalidData), a .part above the cap is dropped', async () => {
    const { f } = fakeNet({ [url]: data });
    const dest = join(root, 'f.part');
    writeFileSync(dest, Buffer.alloc(200, 1));
    await expect(fetchResumable(url, dest, 100, null, undefined, { fetch: f })).rejects.toBeInstanceOf(InvalidDataError);
  });

  it('custom (expected 0): capped by maxBytes, and under 1 KB is not a GGUF', async () => {
    const tiny = 'https://example.test/tiny.gguf';
    const { f } = fakeNet({ [url]: data, [tiny]: gguf(500) });
    await expect(fetchResumable(url, join(root, 'g.part'), 0, null, undefined, { fetch: f, maxBytes: 10_000 })).rejects.toBeInstanceOf(InvalidDataError);
    await expect(fetchResumable(tiny, join(root, 'h.part'), 0, null, undefined, { fetch: f })).rejects.toThrow(/too small/);
  });

  it('HTTP errors and stalls are network failures; cancel is an AbortError', async () => {
    const { f } = fakeNet({}, {});
    const e1 = await fetchResumable(url, join(root, 'i.part'), 10, null, undefined, { fetch: f }).catch((e) => e);
    expect(e1).toBeInstanceOf(ModelDownloadException);
    expect((e1 as ModelDownloadException).kind).toBe('network');

    const hang = fakeNet({ [url]: data }, { hang: true });
    const e2 = await fetchResumable(url, join(root, 'j.part'), data.length, null, undefined, { fetch: hang.f, idleMs: 50 }).catch((e) => e);
    expect((e2 as Error).message).toBe('download stalled');

    const ac = new AbortController();
    const p = fetchResumable(url, join(root, 'k.part'), data.length, null, ac.signal, { fetch: hang.f, idleMs: 10_000 });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('verifyShaAsync', () => {
  it('passes on a match, InvalidData on a mismatch', async () => {
    const p = join(root, 'x.bin');
    writeFileSync(p, 'hello');
    await verifyShaAsync(p, sha256Hex('hello'), 'model');
    await expect(verifyShaAsync(p, sha256Hex('other'), 'model')).rejects.toThrow('checksum mismatch for the model');
  });
});

describe('engine unpack', () => {
  it('zip: llama-server lands in engine-b10701, archive removed', async () => {
    const { zip, spec } = engineZip();
    const { f } = fakeNet({ [spec.url]: zip });
    const phases: string[] = [];
    await LocalBrain.ensureEngine('Cpu', (p) => phases.push(p.phase), new AbortController().signal, { fetch: f, engineSpec: () => spec });
    const exe = LocalBrain.serverExeFor('Cpu');
    expect(exe).toContain(join('brain', 'engine-b10701', exeName));
    expect(readFileSync(exe, 'utf8')).toBe('#!fake server');
    expect(existsSync(join(LocalBrain.engineDirFor('Cpu'), 'ggml.dll'))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(exe).mode & 0o111).not.toBe(0);
    expect(phases).toContain('verify');
    expect(phases).toContain('unpack');
    expect(LocalBrain.installedGgufs()).toEqual([]);
    expect(readdir(LocalBrain.dir()).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('tar.gz nested in llama-bXXXX/ with symlinks: flattened into the Vulkan engine folder', async () => {
    const tar = gzipSync(buildUstarTree([
      { name: 'llama-b10701/', dir: true },
      { name: `llama-b10701/${exeName}`, data: Buffer.from('srv'), mode: 0o755 },
      { name: 'llama-b10701/libllama.so.0.3.0', data: Buffer.alloc(100, 2), mode: 0o755 },
      { name: 'llama-b10701/libllama.so.0', link: 'libllama.so.0.3.0' },
      { name: 'llama-b10701/evil', link: '../../etc/passwd' },
      { name: '../escape.txt', data: Buffer.from('x') },
    ]));
    const spec: LocalBrain.EngineSpec = { url: 'https://example.test/e.tgz', sha256: sha256Hex(tar), bytes: tar.length, archive: 'tar.gz' };
    const { f } = fakeNet({ [spec.url]: tar });
    await LocalBrain.ensureEngine('Gpu', () => {}, new AbortController().signal, { fetch: f, engineSpec: () => spec });
    const dirGpu = LocalBrain.engineDirFor('Gpu');
    expect(dirGpu.endsWith('engine-b10701-vulkan')).toBe(true);
    expect(readFileSync(join(dirGpu, exeName), 'utf8')).toBe('srv');
    if (process.platform !== 'win32') {
      expect(lstatSync(join(dirGpu, 'libllama.so.0')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dirGpu, 'libllama.so.0'))).toBe('libllama.so.0.3.0');
    }
    expect(existsSync(join(dirGpu, 'evil'))).toBe(false);
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
    expect(existsSync(join(LocalBrain.dir(), 'escape.txt'))).toBe(false);
  });

  it('an archive without llama-server or with a wrong checksum is corrupt', async () => {
    const zip = buildZip([{ name: 'readme.txt', data: Buffer.from('hi') }]);
    const spec: LocalBrain.EngineSpec = { url: 'https://example.test/x.zip', sha256: sha256Hex(zip), bytes: zip.length, archive: 'zip' };
    const { f } = fakeNet({ [spec.url]: zip });
    await expect(LocalBrain.ensureEngine('Cpu', () => {}, new AbortController().signal, { fetch: f, engineSpec: () => spec })).rejects.toThrow(/нет llama-server/);
    const bad = { ...spec, sha256: sha256Hex('nope') };
    await expect(LocalBrain.ensureEngine('Cpu', () => {}, new AbortController().signal, { fetch: f, engineSpec: () => bad })).rejects.toBeInstanceOf(InvalidDataError);
    expect(existsSync(LocalBrain.serverExeFor('Cpu'))).toBe(false);
  });

  it('pinned engine builds: Windows WPF SHAs, Linux GitHub digests, nothing for unknown platforms', () => {
    expect(LocalBrain.engineSpecFor('Cpu', 'win32', 'x64')!.sha256).toBe('84ecf626a9893a7701a5883480b06fb91043ee9cb76de10c5aaeea43cfc7c680');
    expect(LocalBrain.engineSpecFor('Gpu', 'win32', 'x64')!.sha256).toBe('ea3524895529aff485ec3d8da477d654f9cc4375cb9e6651793daaca7208daf2');
    expect(LocalBrain.engineSpecFor('Cpu', 'linux', 'x64')!.url).toMatch(/llama-b10701-bin-ubuntu-x64\.tar\.gz$/);
    expect(LocalBrain.engineSpecFor('Gpu', 'linux', 'x64')!.url).toMatch(/ubuntu-vulkan-x64\.tar\.gz$/);
    expect(LocalBrain.engineSpecFor('Cpu', 'darwin', 'arm64')).toBeNull();
  });
});

function readdir(d: string): string[] {
  return existsSync(d) ? readdirSync(d) : [];
}

describe('downloadAsync', () => {
  const customUrl = 'https://huggingface.co/org/repo/resolve/main/tiny.gguf';

  function custom() {
    const s = Settings.defaults();
    s.Brain = 'Local';
    s.BrainModel = 'Custom';
    s.BrainCustomUrl = customUrl;
    return s;
  }

  it('custom GGUF: engine + model, phases end in done, IsReady after', async () => {
    const { zip, spec } = engineZip();
    const model = gguf(4096);
    const { f, reqs } = fakeNet({ [spec.url]: zip, [customUrl]: model });
    const s = custom();
    const phases: string[] = [];
    await LocalBrain.downloadAsync(s, (p) => phases.push(p.phase), new AbortController().signal, { fetch: f, engineSpec: () => spec });
    expect(reqs.map((r) => r.url)).toEqual([spec.url, customUrl]);
    expect(readFileSync(LocalBrain.modelPath(s)).equals(model)).toBe(true);
    expect(existsSync(LocalBrain.modelPath(s) + '.part')).toBe(false);
    expect(phases[phases.length - 1]).toBe('done');
    expect(LocalBrain.isReady(s)).toBe(true);

    // Second press: nothing fetched again.
    await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, { fetch: f, engineSpec: () => spec });
    expect(reqs.length).toBe(2);
  });

  it('a model picked on disk: only the engine is fetched; a missing file is refused before any request', async () => {
    const { zip, spec } = engineZip();
    const { f, reqs } = fakeNet({ [spec.url]: zip });
    const s = Settings.defaults();
    s.Brain = 'Local';
    s.BrainModel = 'File';
    s.BrainModelFile = join(root, 'D', 'Qwen3.5-9B.gguf');
    const missing = await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, { fetch: f, engineSpec: () => spec }).catch((x) => x);
    expect((missing as ModelDownloadException).kind).toBe('rejected');
    expect(reqs).toHaveLength(0);
    mkdirSync(join(root, 'D'), { recursive: true });
    writeFileSync(s.BrainModelFile, gguf(4096));
    await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, { fetch: f, engineSpec: () => spec });
    expect(reqs.map((r) => r.url)).toEqual([spec.url]);
    expect(LocalBrain.isReady(s)).toBe(true);
  });

  it('custom file that is not a GGUF is rejected and removed; a bad link never fetches', async () => {
    const { zip, spec } = engineZip();
    const { f, reqs } = fakeNet({ [spec.url]: zip, [customUrl]: Buffer.alloc(4096, 1) });
    const s = custom();
    const e = await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, { fetch: f, engineSpec: () => spec }).catch((x) => x);
    expect(e).toBeInstanceOf(ModelDownloadException);
    expect((e as ModelDownloadException).kind).toBe('rejected');
    expect((e as Error).message).toBe('Это не файл GGUF. Он не запускается как программа.');
    expect(existsSync(LocalBrain.modelPath(s) + '.part')).toBe(false);

    s.BrainCustomUrl = 'https://example.com/x.gguf';
    const n = reqs.length;
    const e2 = await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, { fetch: f, engineSpec: () => spec }).catch((x) => x);
    expect((e2 as ModelDownloadException).kind).toBe('rejected');
    expect(reqs.length).toBe(n);
  });

  it('built-in model: first mirror fails, the second one is used; SHA checked', async () => {
    const { zip, spec } = engineZip();
    const model = gguf(9000, 3);
    const urls = ['https://mirror.test/q.gguf', 'https://hf.test/q.gguf'];
    const { f, reqs } = fakeNet({ [spec.url]: zip, [urls[1]]: model }, { status: { [urls[0]]: 503 } });
    const s = Settings.defaults();
    s.BrainModel = 'Qwen3';
    await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, {
      fetch: f,
      engineSpec: () => spec,
      modelSpec: () => ({ urls, sha256: sha256Hex(model), bytes: model.length }),
    });
    expect(reqs.map((r) => r.url)).toEqual([spec.url, ...urls]);
    expect(readFileSync(LocalBrain.modelPath(s)).equals(model)).toBe(true);
    expect(LocalBrain.modelPath(s).endsWith(LocalBrain.ModelFile)).toBe(true);
  });

  it('checksum mismatch is corrupt and the .part is deleted; low disk is noSpace', async () => {
    const { zip, spec } = engineZip();
    const model = gguf(9000, 3);
    const url = 'https://hf.test/q.gguf';
    const { f } = fakeNet({ [spec.url]: zip, [url]: model });
    const s = Settings.defaults();
    s.BrainModel = 'Qwen35';
    const deps = { fetch: f, engineSpec: () => spec, modelSpec: () => ({ urls: [url], sha256: sha256Hex('x'), bytes: model.length }) };
    const e = await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, deps).catch((x) => x);
    expect((e as ModelDownloadException).kind).toBe('corrupt');
    expect(existsSync(LocalBrain.modelPath(s) + '.part')).toBe(false);
    expect(existsSync(LocalBrain.modelPath(s))).toBe(false);

    const e2 = await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, { ...deps, freeBytes: () => 1024 }).catch((x) => x);
    expect((e2 as ModelDownloadException).kind).toBe('noSpace');
  });

  it('cancel is an AbortError, not a failure, and the .part stays for the next press', async () => {
    const { zip, spec } = engineZip();
    const url = 'https://hf.test/q.gguf';
    const model = gguf(9000, 3);
    const hang = fakeNet({ [spec.url]: zip, [url]: model }, { dropAt: 3000 });
    const s = Settings.defaults();
    const deps = { fetch: hang.f, engineSpec: () => spec, modelSpec: () => ({ urls: [url], sha256: sha256Hex(model), bytes: model.length }) };
    // The engine download is cut first (dropAt hits the first response) → network failure.
    const e = await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, deps).catch((x) => x);
    expect((e as ModelDownloadException).kind).toBe('network');
    // Retry: engine fine, model downloaded; then cancel a fresh run before it starts.
    await LocalBrain.downloadAsync(s, () => {}, new AbortController().signal, deps);
    expect(readFileSync(LocalBrain.modelPath(s)).equals(model)).toBe(true);
    const ac = new AbortController();
    ac.abort();
    rmSync(LocalBrain.modelPath(s));
    writeFileSync(LocalBrain.modelPath(s) + '.part', model.subarray(0, 100));
    const e3 = await LocalBrain.downloadAsync(s, () => {}, ac.signal, deps).catch((x) => x);
    expect((e3 as Error).name).toBe('AbortError');
    expect(statSync(LocalBrain.modelPath(s) + '.part').size).toBe(100);
  });
});

describe('deleteGguf / deleteModel', () => {
  it('deletes only a .gguf inside the brain folder, with its .part', async () => {
    const d = LocalBrain.dir();
    mkdirSync(d, { recursive: true });
    const p = join(d, 'x.gguf');
    writeFileSync(p, gguf(2000));
    writeFileSync(p + '.part', 'x');
    await expect(LocalBrain.deleteGguf(join(root, 'outside.gguf'))).rejects.toThrow('файл не в папке моделей мозга');
    await expect(LocalBrain.deleteGguf(join(d, 'notes.txt'))).rejects.toThrow('это не файл модели');
    await LocalBrain.deleteGguf(p);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(p + '.part')).toBe(false);
    // A chosen models folder counts too.
    const models = join(root, 'Models');
    mkdirSync(models, { recursive: true });
    const q = join(models, 'y.gguf');
    writeFileSync(q, gguf(2000));
    await expect(LocalBrain.deleteGguf(q)).rejects.toThrow('файл не в папке моделей мозга');
    await LocalBrain.deleteGguf(q, { BrainModelsDir: models });
    expect(existsSync(q)).toBe(false);
  });

  it('a chosen models folder: downloads land there, models already in the brain folder stay usable', () => {
    const s = Settings.defaults();
    s.BrainModelsDir = join(root, 'D-Models');
    expect(LocalBrain.modelPath(s)).toBe(join(root, 'D-Models', LocalBrain.ModelFile));
    mkdirSync(LocalBrain.dir(), { recursive: true });
    writeFileSync(join(LocalBrain.dir(), LocalBrain.ModelFile), gguf(2000));
    expect(LocalBrain.modelPath(s)).toBe(join(LocalBrain.dir(), LocalBrain.ModelFile));
    expect(LocalBrain.installedGgufs(s).map((g) => g.label)).toEqual(['Qwen3 4B']);
    s.BrainModel = 'File';
    s.BrainModelFile = join(root, 'elsewhere', 'm.gguf');
    expect(LocalBrain.modelPath(s)).toBe(s.BrainModelFile);
    expect(LocalBrain.title(s)).toBe('m');
  });

  it('waits for the running engine to let go of the model before deleting it', async () => {
    const d = LocalBrain.dir();
    mkdirSync(d, { recursive: true });
    const p = join(d, 'busy.gguf');
    writeFileSync(p, gguf(2000));
    const order: string[] = [];
    LocalBrain.setRuntime({
      isReady: () => true,
      running: true,
      endpointUrl: '',
      apiKey: '',
      ensureStarted: async () => {},
      stopAsync: async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(existsSync(p) ? 'stopped, file still there' : 'stopped after delete');
      },
    });
    try {
      await LocalBrain.deleteGguf(p);
    } finally {
      LocalBrain.resetRuntime();
    }
    expect(order).toEqual(['stopped, file still there']);
    expect(existsSync(p)).toBe(false);
  });

  it('refuses when the program sits in the brain folder; deleteModel wipes the folder', async () => {
    const d = LocalBrain.dir();
    mkdirSync(d, { recursive: true });
    const p = join(d, 'x.gguf');
    writeFileSync(p, gguf(2000));
    writeFileSync(join(d, 'ChawoVoiceAssistant.exe'), 'MZ');
    await expect(LocalBrain.deleteGguf(p)).rejects.toThrow('рядом лежит программа');
    expect(existsSync(p)).toBe(true);
    await LocalBrain.deleteModel();
    expect(existsSync(d)).toBe(false);
  });
});

describe('unpackTarGzTree', () => {
  it('keeps folders and modes', async () => {
    const tgz = join(root, 'a.tgz');
    writeFileSync(tgz, gzipSync(buildUstarTree([{ name: 'a/b/c.txt', data: Buffer.from('c'), mode: 0o755 }])));
    const out = join(root, 'out');
    expect(await unpackTarGzTree(tgz, out)).toEqual(['a/b/c.txt']);
    expect(readFileSync(join(out, 'a', 'b', 'c.txt'), 'utf8')).toBe('c');
    if (process.platform !== 'win32') expect(statSync(join(out, 'a', 'b', 'c.txt')).mode & 0o111).not.toBe(0);
  });
});
