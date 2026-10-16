// Local speech recognition through ONNX Runtime (onnxruntime-node).
// Port of src/Core/Recognizer.cs.
//
// Two published GigaAM graphs:
//   multilingual_large_ctc — 600M CTC (fp32). Russian, English and the rest of the multilingual vocabulary.
//   v3_e2e_rnnt — smaller Russian end-to-end RNN-T (punctuation, int8).
//
// DeviceActual/Provider: on Linux prefer CUDA when available, else CPU.
// On Windows prefer DirectML (dml) when available, else CPU.
// GPU open failure falls back to CPU and sets deviceNote.
//
// Session.create/run are async in the JS binding, so the public factory is Recognizer.open
// and Transcribe* return Promises. Core stays Electron-free.

import { readFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import './ortPrivacy';
import * as ort from 'onnxruntime-node';
import { resample, silences, chunkBounds } from './audio';
import { chooseScript } from './ctcScriptDecoder';
import { CtcVocab } from './ctcVocab';
import { Features } from './features';
import { parseModelConfig, type ModelConfig } from './modelConfig';
import type { CtcScript, SpeechDeviceKind, SpeechModelKind } from './speechModels';
import { modelId } from './speechModels';
import { Tokenizer } from './tokenizer';

export { CtcVocab } from './ctcVocab';

export const MAX_CHUNK_SECONDS = 24.0;
const MAX_SYMBOLS_PER_FRAME = 3;

type Session = ort.InferenceSession;

/** Simple async mutex so only one Run (or batch) holds the sessions at a time. */
class AsyncLock {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.chain;
    this.chain = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function cores(): number {
  return Math.max(1, cpus().length);
}

function preferGpuProvider(): 'cuda' | 'dml' {
  return process.platform === 'win32' ? 'dml' : 'cuda';
}

function sessionOptions(gpu: boolean, threads: number, provider: 'cuda' | 'dml' | 'cpu'): ort.InferenceSession.SessionOptions {
  const opts: ort.InferenceSession.SessionOptions = {
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    logSeverityLevel: 3, // error
    enableMemPattern: !gpu,
  };
  if (gpu && provider !== 'cpu') {
    opts.executionProviders = [provider, 'cpu'];
  } else {
    opts.executionProviders = ['cpu'];
  }
  return opts;
}

function acceptsBatch(session: Session | null | undefined, inputName: string): boolean {
  if (!session) return false;
  const meta = session.inputMetadata.find((m) => m.name === inputName);
  if (!meta || !meta.isTensor) return false;
  const dims = meta.shape;
  if (!dims || dims.length < 1) return false;
  const d0 = dims[0];
  // ORT JS: symbolic dims are strings; C# used -1 for dynamic.
  return typeof d0 === 'string' || (typeof d0 === 'number' && d0 < 0);
}

function isTerminateMessage(msg: string): boolean {
  return /terminate/i.test(msg);
}

function isMemoryPressureMessage(msg: string): boolean {
  return (
    /memory/i.test(msg) ||
    /OOM/i.test(msg) ||
    /out of/i.test(msg) ||
    /DXGI/i.test(msg) ||
    (/FAILED/i.test(msg) && /alloc/i.test(msg))
  );
}

export { isMemoryPressureMessage, isTerminateMessage };

function floatTensor(data: Float32Array, dims: number[]): ort.Tensor {
  return new ort.Tensor('float32', data, dims);
}

function int64Tensor(values: number[], dims: number[]): ort.Tensor {
  const buf = BigInt64Array.from(values.map((v) => BigInt(v)));
  return new ort.Tensor('int64', buf, dims);
}

function asFloat32(data: ort.Tensor['data']): Float32Array {
  if (data instanceof Float32Array) return data;
  return Float32Array.from(data as ArrayLike<number>);
}

function asInt32(data: ort.Tensor['data']): Int32Array {
  if (data instanceof Int32Array) return data;
  if (data instanceof BigInt64Array) {
    const out = new Int32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = Number(data[i]);
    return out;
  }
  return Int32Array.from(data as ArrayLike<number>);
}

export class Recognizer {
  static readonly MaxChunkSeconds = MAX_CHUNK_SECONDS;

  readonly modelDir: string;
  readonly kind: SpeechModelKind;
  readonly modelId: string;
  readonly encoderAcceptsBatch: boolean;
  deviceActual: string = 'cpu';
  provider: string = 'cpu';
  deviceNote: string | null = null;
  intraOpThreads = 0;
  script: CtcScript = 'auto';

  private ctc: Session | null = null;
  private encoder: Session | null = null;
  private decoder: Session | null = null;
  private joint: Session | null = null;
  private tokenizer: Tokenizer | null = null;
  private ctcVocab: CtcVocab | null = null;
  private readonly features: Features;
  private readonly cfg: ModelConfig;
  private readonly runLock = new AsyncLock();
  /** 1 while a dictation pass (owned) is inside the session lock. */
  private ownedRun = 0;
  /** Bumped when that pass / any CancelRun should abort. */
  private kill = 0;
  private terminateSet = false;
  private disposed = false;

  private constructor(
    modelDir: string,
    kind: SpeechModelKind,
    cfg: ModelConfig,
    features: Features,
    encoderAcceptsBatch: boolean,
  ) {
    this.modelDir = modelDir;
    this.kind = kind;
    this.modelId = modelId(kind);
    this.cfg = cfg;
    this.features = features;
    this.encoderAcceptsBatch = encoderAcceptsBatch;
  }

  get sampleRate(): number {
    return this.cfg.features.sampleRate;
  }

  static modelExists(dir: string, kind: SpeechModelKind): boolean {
    if (kind === 'v3_e2e_rnnt') {
      const name = 'v3_e2e_rnnt';
      return (
        existsSync(join(dir, name + '.yaml')) &&
        existsSync(join(dir, name + '_encoder.onnx')) &&
        existsSync(join(dir, name + '_decoder.onnx')) &&
        existsSync(join(dir, name + '_joint.onnx')) &&
        existsSync(join(dir, name + '_tokenizer.model'))
      );
    }
    return (
      existsSync(join(dir, 'multilingual_large_ctc.onnx')) &&
      existsSync(join(dir, 'multilingual_large_ctc.onnx.data')) &&
      existsSync(join(dir, 'multilingual_large_ctc.yaml')) &&
      existsSync(join(dir, 'multilingual_vocab.txt'))
    );
  }

  /**
   * Opens sessions. Prefer GPU EP when asked; on failure fall back to CPU and set deviceNote.
   * threads: 0 = all cores; GPU sessions cap intra-op at min(4, cores).
   */
  static async open(
    modelDir: string,
    kind: SpeechModelKind,
    device: SpeechDeviceKind,
    threads = 0,
  ): Promise<Recognizer> {
    const nCores = cores();
    const cpuThreads = threads <= 0 ? nCores : Math.min(Math.max(threads, 1), nCores);
    const gpuThreads = Math.min(4, nCores);
    const wantGpu = device === 'gpu';
    const gpuProvider = preferGpuProvider();

    if (kind === 'v3_e2e_rnnt') {
      const name = 'v3_e2e_rnnt';
      const cfg = parseModelConfig(readFileSync(join(modelDir, name + '.yaml'), 'utf8'));
      const features = new Features(cfg.features);
      const tokenizer = new Tokenizer(new Uint8Array(readFileSync(join(modelDir, name + '_tokenizer.model'))), name + '_tokenizer.model');
      let deviceNote: string | null = null;
      if (wantGpu) {
        try {
          const encoder = await openSession(join(modelDir, name + '_encoder.onnx'), true, gpuThreads, gpuProvider);
          const decoder = await openSession(join(modelDir, name + '_decoder.onnx'), true, gpuThreads, gpuProvider);
          const joint = await openSession(join(modelDir, name + '_joint.onnx'), true, gpuThreads, gpuProvider);
          const rec = new Recognizer(modelDir, kind, cfg, features, acceptsBatch(encoder, 'audio_signal'));
          rec.tokenizer = tokenizer;
          rec.encoder = encoder;
          rec.decoder = decoder;
          rec.joint = joint;
          rec.deviceActual = 'gpu';
          rec.provider = gpuProvider;
          rec.intraOpThreads = gpuThreads;
          return rec;
        } catch (e) {
          deviceNote = e instanceof Error ? e.message : String(e);
        }
      }
      const encoder = await openSession(join(modelDir, name + '_encoder.onnx'), false, cpuThreads, 'cpu');
      const decoder = await openSession(join(modelDir, name + '_decoder.onnx'), false, cpuThreads, 'cpu');
      const joint = await openSession(join(modelDir, name + '_joint.onnx'), false, cpuThreads, 'cpu');
      const rec = new Recognizer(modelDir, kind, cfg, features, acceptsBatch(encoder, 'audio_signal'));
      rec.tokenizer = tokenizer;
      rec.encoder = encoder;
      rec.decoder = decoder;
      rec.joint = joint;
      rec.deviceActual = 'cpu';
      rec.provider = 'cpu';
      rec.intraOpThreads = cpuThreads;
      rec.deviceNote = deviceNote;
      return rec;
    }

    const cfg = parseModelConfig(readFileSync(join(modelDir, 'multilingual_large_ctc.yaml'), 'utf8'));
    const features = new Features(cfg.features);
    const ctcVocab = CtcVocab.load(join(modelDir, 'multilingual_vocab.txt'));
    let deviceNote: string | null = null;
    if (wantGpu) {
      try {
        const ctc = await openSession(join(modelDir, 'multilingual_large_ctc.onnx'), true, gpuThreads, gpuProvider);
        const rec = new Recognizer(modelDir, kind, cfg, features, acceptsBatch(ctc, 'features'));
        rec.ctcVocab = ctcVocab;
        rec.ctc = ctc;
        rec.deviceActual = 'gpu';
        rec.provider = gpuProvider;
        rec.intraOpThreads = gpuThreads;
        return rec;
      } catch (e) {
        deviceNote = e instanceof Error ? e.message : String(e);
      }
    }
    const ctc = await openSession(join(modelDir, 'multilingual_large_ctc.onnx'), false, cpuThreads, 'cpu');
    const rec = new Recognizer(modelDir, kind, cfg, features, acceptsBatch(ctc, 'features'));
    rec.ctcVocab = ctcVocab;
    rec.ctc = ctc;
    rec.deviceActual = 'cpu';
    rec.provider = 'cpu';
    rec.intraOpThreads = cpuThreads;
    rec.deviceNote = deviceNote;
    return rec;
  }

  /**
   * Abort any in-flight Run (file workers).
   * onnxruntime-node does not yet honor RunOptions.terminate (WASM-only), so this is best-effort:
   * kill flag + owned-run semantics; in-flight ORT calls finish on their own.
   */
  cancelRun(): void {
    this.kill++;
    this.terminateSet = true;
  }

  /** Abort the dictation pass that owns the session. No-op if idle or a non-owned (Hermes) call holds it. */
  cancelOwned(): void {
    if (this.ownedRun === 0) return;
    this.kill++;
    this.terminateSet = true;
  }

  async warmup(): Promise<void> {
    const n = Math.max(this.cfg.features.winLength, 1);
    await this.execute(new Float32Array(n), this.sampleRate, false, null);
  }

  /** Recognizes a recording. Not cancelled by cancelOwned (Hermes). */
  async transcribe(samples: Float32Array, rate: number): Promise<string> {
    return this.execute(samples, rate, false, null);
  }

  pieceRanges(samplesAtModelRate: Float32Array, pauses?: readonly number[]): Array<{ from: number; to: number }> {
    return Recognizer.splitRanges(samplesAtModelRate, this.sampleRate, pauses);
  }

  /**
   * Same pause split without a loaded model (client mode posts each piece to the host).
   * Offsets are sample indices at `rate`. `pauses` (seconds, e.g. VAD `pauseMidpoints`) replaces the
   * energy `silences()` cut candidates when given; without it the split is the WPF one.
   */
  static splitRanges(samplesAtModelRate: Float32Array, rate: number, pauses?: readonly number[]): Array<{ from: number; to: number }> {
    const n = samplesAtModelRate.length;
    if (n <= 0 || rate <= 0) return [];
    const total = n / rate;
    if (total <= MAX_CHUNK_SECONDS + 1) return [{ from: 0, to: n }];
    const bounds = chunkBounds(total, pauses ?? silences(samplesAtModelRate, rate), MAX_CHUNK_SECONDS);
    const ranges: Array<{ from: number; to: number }> = [];
    for (const [a, b] of bounds) {
      const from = Math.min(n, Math.trunc(a * rate));
      const to = Math.min(n, Math.trunc(b * rate));
      if (to > from) ranges.push({ from, to });
    }
    if (ranges.length === 0) ranges.push({ from: 0, to: n });
    return ranges;
  }

  async transcribePiece(samplesAtModelRate: Float32Array): Promise<string> {
    return this.execute(samplesAtModelRate, this.sampleRate, false, null);
  }

  async transcribeCancelable(samples: Float32Array, rate: number, stillWanted: (() => boolean) | null = null): Promise<string> {
    return this.execute(samples, rate, true, stillWanted);
  }

  async transcribeBatch(pieces: Float32Array[], signal?: AbortSignal): Promise<string[]> {
    if (pieces.length === 0) return [];
    if (pieces.length === 1) return [await this.transcribePiece(pieces[0])];
    if (!this.encoderAcceptsBatch) {
      const one: string[] = new Array(pieces.length);
      for (let i = 0; i < pieces.length; i++) {
        if (signal?.aborted) throw abortError();
        one[i] = await this.transcribePiece(pieces[i]);
      }
      return one;
    }
    if (signal?.aborted) throw abortError();
    return this.runLock.run(async () => {
      this.disarmTerminate();
      try {
        return this.kind === 'v3_e2e_rnnt'
          ? await this.decodeRnntBatch(pieces, signal)
          : await this.decodeCtcBatch(pieces, signal);
      } finally {
        if (this.terminateSet) this.disarmTerminate();
      }
    });
  }

  async transcribeChunk(wave: Float32Array): Promise<string> {
    if (wave.length < this.cfg.features.winLength) return '';
    const { values, frames } = this.features.compute(wave);
    if (frames === 0) return '';
    return this.kind === 'v3_e2e_rnnt'
      ? await this.decodeRnnt(values, frames, wave.length)
      : await this.decodeCtc(values, frames, wave.length);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.runLock.run(async () => {
      this.disposed = true;
      const release = async (s: Session | null) => {
        if (!s) return;
        try {
          await s.release();
        } catch {
          /* ignore */
        }
      };
      await release(this.ctc);
      await release(this.encoder);
      await release(this.decoder);
      await release(this.joint);
      this.ctc = null;
      this.encoder = this.decoder = this.joint = null;
    });
  }

  private async execute(
    samples: Float32Array,
    rate: number,
    owned: boolean,
    stillWanted: (() => boolean) | null,
  ): Promise<string> {
    const seen = this.kill;
    return this.runLock.run(async () => {
      if (stillWanted != null && !stillWanted()) return '';
      if (owned && this.kill !== seen) return '';
      this.disarmTerminate();
      if (owned) this.ownedRun = 1;
      try {
        return await this.transcribeCore(samples, rate);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (owned && (this.kill !== seen || this.terminateSet || isTerminateMessage(msg))) return '';
        throw e;
      } finally {
        if (owned) this.ownedRun = 0;
        if (this.terminateSet) this.disarmTerminate();
      }
    });
  }

  private disarmTerminate(): void {
    this.terminateSet = false;
  }

  private async transcribeCore(samples: Float32Array, rate: number): Promise<string> {
    if (rate !== this.sampleRate) samples = resample(samples, rate, this.sampleRate);
    const total = samples.length / this.sampleRate;
    if (total <= MAX_CHUNK_SECONDS + 1) return this.transcribeChunk(samples);

    const bounds = chunkBounds(total, silences(samples, this.sampleRate), MAX_CHUNK_SECONDS);
    const parts: string[] = [];
    for (const [a, b] of bounds) {
      if (this.terminateSet || this.kill) break;
      const from = Math.min(samples.length, Math.trunc(a * this.sampleRate));
      const to = Math.min(samples.length, Math.trunc(b * this.sampleRate));
      if (to > from) {
        const text = await this.transcribeChunk(samples.subarray(from, to));
        if (text.length > 0) parts.push(text);
      }
    }
    return parts.join(' ');
  }

  private async decodeCtc(feats: Float32Array, frames: number, samples: number): Promise<string> {
    const nMels = this.cfg.features.nMels;
    const lengths = [this.features.outLen(samples)];
    const feeds: Record<string, ort.Tensor> = {
      features: floatTensor(feats, [1, nMels, frames]),
      feature_lengths: int64Tensor(lengths, [1]),
    };
    const outs = await this.ctc!.run(feeds);
    const logits = outs[this.ctc!.outputNames[0]];
    const shape = logits.dims;
    const data = asFloat32(logits.data);
    const classes = this.ctcVocab!.count;
    let time: number;
    let classesLast: boolean;
    if (shape.length === 3 && shape[2] === classes) {
      time = Number(shape[1]);
      classesLast = true;
    } else if (shape.length === 3 && shape[1] === classes) {
      time = Number(shape[2]);
      classesLast = false;
    } else if (shape.length === 2 && shape[1] === classes) {
      time = Number(shape[0]);
      classesLast = true;
    } else {
      throw new Error(`unexpected CTC output shape ${shape.join('x')} for ${classes} classes`);
    }

    const limit = Math.min(time, Math.floor((frames - 1) / this.cfg.subsamplingFactor) + 1);
    const blank = this.ctcVocab!.blankId;
    const kinds = this.ctcVocab!.kinds;
    const script = this.script;
    const scores = data;
    const vocab = this.ctcVocab!;

    const greedy = (allowLatin: boolean, allowCyrillic: boolean) => {
      let prev = -1;
      const ids: number[] = [];
      let sum = 0;
      for (let t = 0; t < limit; t++) {
        let best = blank;
        let bestValue = Number.NEGATIVE_INFINITY;
        for (let c = 0; c < classes; c++) {
          const kind = c < kinds.length ? kinds[c] : 'neutral';
          if (kind === 'latin' && !allowLatin) continue;
          if (kind === 'cyrillic' && !allowCyrillic) continue;
          const v = classesLast ? scores[t * classes + c] : scores[c * time + t];
          if (v > bestValue) {
            bestValue = v;
            best = c;
          }
        }
        if (bestValue > Number.NEGATIVE_INFINITY) sum += bestValue;
        if (best !== blank && best !== prev) ids.push(best);
        prev = best;
      }
      return { text: vocab.decode(ids), sum, frames: limit };
    };

    return chooseScript(script, greedy);
  }

  private async decodeRnnt(feats: Float32Array, frames: number, samples: number): Promise<string> {
    const nMels = this.cfg.features.nMels;
    const lengths = [this.features.outLen(samples)];
    const feeds: Record<string, ort.Tensor> = {
      audio_signal: floatTensor(feats, [1, nMels, frames]),
      length: int64Tensor(lengths, [1]),
    };
    const encOut = await this.encoder!.run(feeds);
    const encName = this.encoder!.outputNames[0];
    const lenName = this.encoder!.outputNames[1];
    const encTensor = encOut[encName];
    const encShape = encTensor.dims;
    const encD = Number(encShape[1]);
    const encT = Number(encShape[2]);
    const encoded = asFloat32(encTensor.data);
    const encLenRaw = asInt32(encOut[lenName].data)[0];
    const encLen = Math.min(encLenRaw, encT);
    return this.tokenizer!.decode(await this.greedyRnnt(encoded, encD, encT, encLen));
  }

  private async greedyRnnt(encoded: Float32Array, encD: number, encT: number, encLen: number): Promise<number[]> {
    const hidden = this.cfg.predHidden;
    const layers = this.cfg.predLayers;
    const blank = this.tokenizer!.blankId;
    const hyp: number[] = [];
    const stateShape = [layers, 1, hidden];
    const zeros = new Float32Array(layers * hidden);
    const h = new Float32Array(layers * hidden);
    const c = new Float32Array(layers * hidden);
    let label = blank;
    const frame = new Float32Array(encD);
    const dec = new Float32Array(hidden);
    let started = false;

    for (let t = 0; t < encLen; t++) {
      if (this.terminateSet) break;
      for (let d = 0; d < encD; d++) frame[d] = encoded[d * encT + t];
      for (let s = 0; s < MAX_SYMBOLS_PER_FRAME; s++) {
        const xLabel = BigInt64Array.from([BigInt(started ? label : blank)]);
        const decFeeds: Record<string, ort.Tensor> = {
          x: new ort.Tensor('int64', xLabel, [1, 1]),
          hi: floatTensor(started ? h : zeros, stateShape),
          ci: floatTensor(started ? c : zeros, stateShape),
        };
        const decOut = await this.decoder!.run(decFeeds);
        const decNames = this.decoder!.outputNames;
        {
          const out0 = asFloat32(decOut[decNames[0]].data);
          dec.fill(0);
          dec.set(out0.subarray(0, Math.min(out0.length, hidden)));
        }
        const jointFeeds: Record<string, ort.Tensor> = {
          enc: floatTensor(frame, [1, encD, 1]),
          dec: floatTensor(dec, [1, hidden, 1]),
        };
        const jointOut = await this.joint!.run(jointFeeds);
        const logits = asFloat32(jointOut[this.joint!.outputNames[0]].data);
        if (logits.length !== blank + 1) {
          throw new Error(`Tokenizer has ${blank} pieces but the joint network outputs ${logits.length} classes`);
        }
        let best = 0;
        let bestValue = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < logits.length; i++) {
          if (logits[i] > bestValue) {
            bestValue = logits[i];
            best = i;
          }
        }
        if (best === blank) break;
        hyp.push(best);
        label = best;
        const hOut = asFloat32(decOut[decNames[1]].data);
        const cOut = asFloat32(decOut[decNames[2]].data);
        h.set(hOut.subarray(0, h.length));
        c.set(cOut.subarray(0, c.length));
        started = true;
      }
    }
    return hyp;
  }

  private async decodeCtcBatch(pieces: Float32Array[], signal?: AbortSignal): Promise<string[]> {
    const nMels = this.cfg.features.nMels;
    const b = pieces.length;
    const featsList: Float32Array[] = new Array(b);
    const frames = new Int32Array(b);
    const sampleLens = new Int32Array(b);
    let maxFrames = 0;
    for (let i = 0; i < b; i++) {
      if (signal?.aborted) throw abortError();
      if (pieces[i].length < this.cfg.features.winLength) {
        featsList[i] = new Float32Array(0);
        frames[i] = 0;
        sampleLens[i] = pieces[i].length;
        continue;
      }
      const { values, frames: fr } = this.features.compute(pieces[i]);
      featsList[i] = values;
      frames[i] = fr;
      sampleLens[i] = pieces[i].length;
      if (fr > maxFrames) maxFrames = fr;
    }
    const texts: string[] = new Array(b);
    if (maxFrames === 0) {
      for (let i = 0; i < b; i++) texts[i] = '';
      return texts;
    }

    const packed = new Float32Array(b * nMels * maxFrames);
    const lengths: number[] = new Array(b);
    for (let i = 0; i < b; i++) {
      lengths[i] = frames[i] === 0 ? 0 : this.features.outLen(sampleLens[i]);
      const fr = frames[i];
      if (fr === 0) continue;
      for (let m = 0; m < nMels; m++) {
        packed.set(featsList[i].subarray(m * fr, m * fr + fr), i * nMels * maxFrames + m * maxFrames);
      }
    }

    const feeds: Record<string, ort.Tensor> = {
      features: floatTensor(packed, [b, nMels, maxFrames]),
      feature_lengths: int64Tensor(lengths, [b]),
    };
    const outs = await this.ctc!.run(feeds);
    const logits = outs[this.ctc!.outputNames[0]];
    const shape = logits.dims;
    const data = asFloat32(logits.data);
    const classes = this.ctcVocab!.count;
    let time: number;
    let classesLast: boolean;
    if (shape.length === 3 && shape[0] === b && shape[2] === classes) {
      time = Number(shape[1]);
      classesLast = true;
    } else if (shape.length === 3 && shape[0] === b && shape[1] === classes) {
      time = Number(shape[2]);
      classesLast = false;
    } else {
      throw new Error(`unexpected batched CTC output shape ${shape.join('x')} for batch ${b}, ${classes} classes`);
    }

    const blank = this.ctcVocab!.blankId;
    const kinds = this.ctcVocab!.kinds;
    const script = this.script;
    const vocab = this.ctcVocab!;

    for (let i = 0; i < b; i++) {
      if (signal?.aborted) throw abortError();
      if (frames[i] === 0) {
        texts[i] = '';
        continue;
      }
      const limit = Math.min(time, Math.floor((frames[i] - 1) / this.cfg.subsamplingFactor) + 1);
      const baseOff = i * time * classes;

      const greedy = (allowLatin: boolean, allowCyrillic: boolean) => {
        let prev = -1;
        const ids: number[] = [];
        let sum = 0;
        for (let t = 0; t < limit; t++) {
          let best = blank;
          let bestValue = Number.NEGATIVE_INFINITY;
          for (let c = 0; c < classes; c++) {
            const kind = c < kinds.length ? kinds[c] : 'neutral';
            if (kind === 'latin' && !allowLatin) continue;
            if (kind === 'cyrillic' && !allowCyrillic) continue;
            const v = classesLast
              ? data[baseOff + t * classes + c]
              : data[i * classes * time + c * time + t];
            if (v > bestValue) {
              bestValue = v;
              best = c;
            }
          }
          if (bestValue > Number.NEGATIVE_INFINITY) sum += bestValue;
          if (best !== blank && best !== prev) ids.push(best);
          prev = best;
        }
        return { text: vocab.decode(ids), sum, frames: limit };
      };

      texts[i] = chooseScript(script, greedy);
    }
    return texts;
  }

  private async decodeRnntBatch(pieces: Float32Array[], signal?: AbortSignal): Promise<string[]> {
    const nMels = this.cfg.features.nMels;
    const b = pieces.length;
    const featsList: Float32Array[] = new Array(b);
    const frames = new Int32Array(b);
    const sampleLens = new Int32Array(b);
    let maxFrames = 0;
    for (let i = 0; i < b; i++) {
      if (signal?.aborted) throw abortError();
      if (pieces[i].length < this.cfg.features.winLength) {
        featsList[i] = new Float32Array(0);
        frames[i] = 0;
        sampleLens[i] = pieces[i].length;
        continue;
      }
      const { values, frames: fr } = this.features.compute(pieces[i]);
      featsList[i] = values;
      frames[i] = fr;
      sampleLens[i] = pieces[i].length;
      if (fr > maxFrames) maxFrames = fr;
    }
    const texts: string[] = new Array(b);
    if (maxFrames === 0) {
      for (let i = 0; i < b; i++) texts[i] = '';
      return texts;
    }

    const packed = new Float32Array(b * nMels * maxFrames);
    const lengths: number[] = new Array(b);
    for (let i = 0; i < b; i++) {
      lengths[i] = frames[i] === 0 ? 0 : this.features.outLen(sampleLens[i]);
      const fr = frames[i];
      if (fr === 0) continue;
      for (let m = 0; m < nMels; m++) {
        packed.set(featsList[i].subarray(m * fr, m * fr + fr), i * nMels * maxFrames + m * maxFrames);
      }
    }

    const feeds: Record<string, ort.Tensor> = {
      audio_signal: floatTensor(packed, [b, nMels, maxFrames]),
      length: int64Tensor(lengths, [b]),
    };
    const encOut = await this.encoder!.run(feeds);
    const encName = this.encoder!.outputNames[0];
    const lenName = this.encoder!.outputNames[1];
    const encTensor = encOut[encName];
    const encShape = encTensor.dims;
    if (encShape.length !== 3 || Number(encShape[0]) !== b) {
      throw new Error(`unexpected batched encoder shape ${encShape.join('x')} for batch ${b}`);
    }
    const encD = Number(encShape[1]);
    const encT = Number(encShape[2]);
    const encodedAll = asFloat32(encTensor.data);
    const encLens = asInt32(encOut[lenName].data);

    for (let i = 0; i < b; i++) {
      if (signal?.aborted) throw abortError();
      if (frames[i] === 0) {
        texts[i] = '';
        continue;
      }
      const encoded = new Float32Array(encD * encT);
      for (let d = 0; d < encD; d++) {
        encoded.set(
          encodedAll.subarray(i * encD * encT + d * encT, i * encD * encT + d * encT + encT),
          d * encT,
        );
      }
      const encLen = Math.min(encLens[i], encT);
      texts[i] = this.tokenizer!.decode(await this.greedyRnnt(encoded, encD, encT, encLen));
    }
    return texts;
  }
}

async function openSession(
  path: string,
  gpu: boolean,
  threads: number,
  provider: 'cuda' | 'dml' | 'cpu',
): Promise<Session> {
  return ort.InferenceSession.create(path, sessionOptions(gpu, threads, provider));
}

function abortError(): Error {
  const e = new Error('Operation canceled');
  e.name = 'AbortError';
  return e;
}
