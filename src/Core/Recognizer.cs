// Local speech recognition through ONNX Runtime.
//
// Two published GigaAM graphs:
//   multilingual_large_ctc — 600M CTC, the largest ASR Sber has shipped with a
//     usable ONNX file (fp32, so a video card can run it). Russian, English and
//     the rest of the multilingual vocabulary. No punctuation head.
//   v3_e2e_rnnt — the smaller Russian end-to-end RNN-T (punctuation, int8).
//
// GPU means DirectML (DX12): NVIDIA, AMD and Intel, no separate CUDA install.
// If that provider fails to start, the same weights run on the CPU.

using Microsoft.ML.OnnxRuntime;

namespace ChawoVA.Core;

public sealed class Recognizer : IDisposable
{
    public const double MaxChunkSeconds = 24.0;
    private const int MaxSymbolsPerFrame = 3;

    private readonly SpeechModelKind _kind;
    private InferenceSession? _ctc;
    private InferenceSession? _encoder;
    private InferenceSession? _decoder;
    private InferenceSession? _joint;
    private Tokenizer? _tokenizer;
    private CtcVocab? _ctcVocab;
    private readonly Features _features;
    private readonly ModelConfig _cfg;
    private readonly object _runLock = new();
    private RunOptions _runOptions = new();
    /// <summary>1 while a dictation pass (partial or final) is inside the session lock.</summary>
    private int _ownedRun;
    /// <summary>Bumped when that dictation pass should abort. Hermes calls do not own the run.</summary>
    private int _kill;
    private volatile bool _terminateSet;

    public string ModelDir { get; }
    public SpeechModelKind Kind => _kind;
    public string ModelId => SpeechModels.Id(_kind);
    /// <summary>"gpu" when DirectML accepted the session, otherwise "cpu".</summary>
    public string DeviceActual { get; private set; } = "cpu";
    /// <summary>"directml" or "cpu".</summary>
    public string Provider { get; private set; } = "cpu";
    /// <summary>Set when a GPU request had to fall back to the CPU.</summary>
    public string? DeviceNote { get; private set; }
    /// <summary>Intra-op threads of the session that is actually running. GPU stays at the old cap of 4.</summary>
    public int IntraOpThreads { get; private set; }
    public int SampleRate => _cfg.Features.SampleRate;
    /// <summary>CTC letter mask. Read at the start of each CTC decode. v3 does not read it.</summary>
    private volatile int _script;
    public CtcScript Script
    {
        get => (CtcScript)_script;
        set => _script = (int)value;
    }

    public static bool ModelExists(string dir, SpeechModelKind kind)
    {
        if (kind == SpeechModelKind.V3E2eRnnt)
        {
            const string name = "v3_e2e_rnnt";
            return File.Exists(Path.Combine(dir, name + ".yaml")) &&
                   File.Exists(Path.Combine(dir, name + "_encoder.onnx")) &&
                   File.Exists(Path.Combine(dir, name + "_decoder.onnx")) &&
                   File.Exists(Path.Combine(dir, name + "_joint.onnx")) &&
                   File.Exists(Path.Combine(dir, name + "_tokenizer.model"));
        }
        return File.Exists(Path.Combine(dir, "multilingual_large_ctc.onnx")) &&
               File.Exists(Path.Combine(dir, "multilingual_large_ctc.onnx.data")) &&
               File.Exists(Path.Combine(dir, "multilingual_large_ctc.yaml")) &&
               File.Exists(Path.Combine(dir, "multilingual_vocab.txt"));
    }

    public Recognizer(string modelDir, SpeechModelKind kind, SpeechDeviceKind device, int threads = 0)
    {
        ModelDir = modelDir;
        _kind = kind;
        int cores = Math.Max(1, Environment.ProcessorCount);
        // 0 means all logical processors. The old hard cap was min(4, cores), in this program, not in the graph.
        int cpuThreads = threads <= 0 ? cores : Math.Clamp(threads, 1, cores);
        // DirectML does not go faster with more CPU threads. Leave that session as it was.
        int gpuThreads = Math.Min(4, cores);
        bool wantGpu = device == SpeechDeviceKind.Gpu;

        if (kind == SpeechModelKind.V3E2eRnnt)
        {
            const string name = "v3_e2e_rnnt";
            _cfg = ModelConfig.Load(Path.Combine(modelDir, name + ".yaml"));
            _features = new Features(_cfg.Features);
            _tokenizer = new Tokenizer(Path.Combine(modelDir, name + "_tokenizer.model"));
            try
            {
                if (wantGpu)
                {
                    _encoder = Open(Path.Combine(modelDir, name + "_encoder.onnx"), true, gpuThreads);
                    _decoder = Open(Path.Combine(modelDir, name + "_decoder.onnx"), true, gpuThreads);
                    _joint = Open(Path.Combine(modelDir, name + "_joint.onnx"), true, gpuThreads);
                    DeviceActual = "gpu";
                    Provider = "directml";
                    IntraOpThreads = gpuThreads;
                    return;
                }
            }
            catch (Exception e)
            {
                _encoder?.Dispose();
                _decoder?.Dispose();
                _joint?.Dispose();
                _encoder = _decoder = _joint = null;
                DeviceNote = e.Message;
            }
            _encoder = Open(Path.Combine(modelDir, name + "_encoder.onnx"), false, cpuThreads);
            _decoder = Open(Path.Combine(modelDir, name + "_decoder.onnx"), false, cpuThreads);
            _joint = Open(Path.Combine(modelDir, name + "_joint.onnx"), false, cpuThreads);
            DeviceActual = "cpu";
            Provider = "cpu";
            IntraOpThreads = cpuThreads;
            return;
        }

        _cfg = ModelConfig.Load(Path.Combine(modelDir, "multilingual_large_ctc.yaml"));
        _features = new Features(_cfg.Features);
        _ctcVocab = CtcVocab.Load(Path.Combine(modelDir, "multilingual_vocab.txt"));
        try
        {
            if (wantGpu)
            {
                _ctc = Open(Path.Combine(modelDir, "multilingual_large_ctc.onnx"), true, gpuThreads);
                DeviceActual = "gpu";
                Provider = "directml";
                IntraOpThreads = gpuThreads;
                return;
            }
        }
        catch (Exception e)
        {
            _ctc?.Dispose();
            _ctc = null;
            DeviceNote = e.Message;
        }
        _ctc = Open(Path.Combine(modelDir, "multilingual_large_ctc.onnx"), false, cpuThreads);
        DeviceActual = "cpu";
        Provider = "cpu";
        IntraOpThreads = cpuThreads;
    }

    private static InferenceSession Open(string path, bool gpu, int threads)
    {
        using var options = new SessionOptions
        {
            GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL,
            ExecutionMode = ExecutionMode.ORT_SEQUENTIAL,
            IntraOpNumThreads = threads,
            InterOpNumThreads = 1,
            LogSeverityLevel = OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR,
            EnableMemoryPattern = !gpu,
        };
        if (gpu) options.AppendExecutionProvider_DML(0);
        return new InferenceSession(path, options);
    }

    /// <summary>
    /// One silent pass, just long enough for a frame. DirectML compiles the graph on the first
    /// <c>Run</c>, not when the session is created, so this is what makes the next phrase fast.
    /// The text is discarded. Does not download anything.
    /// </summary>
    public void Warmup()
    {
        int n = Math.Max(_cfg.Features.WinLength, 1);
        Execute(new float[n], SampleRate, owned: false, null);
    }

    /// <summary>Recognizes a recording. Not cancelled by <see cref="CancelOwned"/> (Hermes).</summary>
    public string Transcribe(float[] samples, int rate) => Execute(samples, rate, owned: false, null);

    /// <summary>
    /// Ranges at the model rate. Each piece is at most <see cref="MaxChunkSeconds"/>,
    /// cut on a pause the same way <see cref="Transcribe"/> splits a long take.
    /// </summary>
    public List<(int from, int to)> PieceRanges(float[] samplesAtModelRate)
    {
        int n = samplesAtModelRate.Length;
        int rate = SampleRate;
        if (n <= 0 || rate <= 0) return new();
        double total = (double)n / rate;
        if (total <= MaxChunkSeconds + 1) return new() { (0, n) };
        var bounds = AudioUtils.ChunkBounds(total, AudioUtils.Silences(samplesAtModelRate, rate), MaxChunkSeconds);
        var ranges = new List<(int, int)>(bounds.Count);
        foreach (var (a, b) in bounds)
        {
            int from = Math.Min(n, (int)(a * rate));
            int to = Math.Min(n, (int)(b * rate));
            if (to > from) ranges.Add((from, to));
        }
        if (ranges.Count == 0) ranges.Add((0, n));
        return ranges;
    }

    /// <summary>
    /// One piece. The session lock drops when this returns, so dictation can run between pieces of a long file.
    /// A piece longer than <see cref="MaxChunkSeconds"/> is still split inside the lock.
    /// </summary>
    public string TranscribePiece(float[] samplesAtModelRate) => Execute(samplesAtModelRate, SampleRate, owned: false, null);

    /// <summary>
    /// Dictation pass. <see cref="CancelOwned"/> aborts it if it is inside the session.
    /// A pass that has not entered yet, or that was aborted, returns an empty string.
    /// </summary>
    public string TranscribeCancelable(float[] samples, int rate, Func<bool>? stillWanted = null) =>
        Execute(samples, rate, owned: true, stillWanted);

    /// <summary>
    /// Abort the dictation pass that is inside ONNX right now. Does nothing if the session
    /// is idle or a Hermes call holds it, so a stray Escape cannot kill another request.
    /// The same <see cref="RunOptions"/> instance is flagged; ONNX watches that flag from
    /// another thread. There is no way to drop a result without touching the in-flight run.
    /// </summary>
    public void CancelOwned()
    {
        if (Volatile.Read(ref _ownedRun) == 0) return;
        Interlocked.Increment(ref _kill);
        _terminateSet = true;
        try { _runOptions.Terminate = true; }
        catch { /* the pass ends on its own; the caller ignores the result */ }
    }

    private string Execute(float[] samples, int rate, bool owned, Func<bool>? stillWanted)
    {
        int seen = Volatile.Read(ref _kill);
        lock (_runLock)
        {
            // Checked under the lock, so a release that landed before we started does not run a draft.
            if (stillWanted != null && !stillWanted())
                return "";
            if (owned && Volatile.Read(ref _kill) != seen)
                return "";
            DisarmTerminate();
            if (owned) Volatile.Write(ref _ownedRun, 1);
            try
            {
                return TranscribeCore(samples, rate);
            }
            catch (OnnxRuntimeException ex) when (owned && (Volatile.Read(ref _kill) != seen || _terminateSet || IsTerminate(ex)))
            {
                return "";
            }
            finally
            {
                if (owned) Volatile.Write(ref _ownedRun, 0);
                if (_terminateSet) DisarmTerminate();
            }
        }
    }

    private void DisarmTerminate()
    {
        _terminateSet = false;
        try
        {
            if (_runOptions.Terminate)
                _runOptions.Terminate = false;
        }
        catch
        {
            try { _runOptions.Dispose(); } catch { }
            _runOptions = new RunOptions();
        }
    }

    private static bool IsTerminate(OnnxRuntimeException ex) =>
        ex.Message.Contains("terminate", StringComparison.OrdinalIgnoreCase);

    /// <summary>Recognizes a recording of any length; long ones are split at pauses.</summary>
    private string TranscribeCore(float[] samples, int rate)
    {
        if (rate != SampleRate)
            samples = AudioUtils.Resample(samples, rate, SampleRate);

        double total = (double)samples.Length / SampleRate;
        if (total <= MaxChunkSeconds + 1) return TranscribeChunk(samples);

        var bounds = AudioUtils.ChunkBounds(total, AudioUtils.Silences(samples, SampleRate), MaxChunkSeconds);
        var parts = new List<string>();
        foreach (var (a, b) in bounds)
        {
            int from = Math.Min(samples.Length, (int)(a * SampleRate));
            int to = Math.Min(samples.Length, (int)(b * SampleRate));
            if (to > from)
            {
                var text = TranscribeChunk(samples.AsSpan(from, to - from));
                if (text.Length > 0) parts.Add(text);
            }
        }
        return string.Join(' ', parts);
    }

    public string TranscribeChunk(ReadOnlySpan<float> wave)
    {
        if (wave.Length < _cfg.Features.WinLength) return "";
        var (feats, frames) = _features.Compute(wave);
        if (frames == 0) return "";
        return _kind == SpeechModelKind.V3E2eRnnt ? DecodeRnnt(feats, frames, wave.Length) : DecodeCtc(feats, frames, wave.Length);
    }

    private string DecodeCtc(float[] feats, int frames, int samples)
    {
        int nMels = _cfg.Features.NMels;
        var lengths = new long[] { _features.OutLen(samples) };
        using var featsValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance,
            feats.AsMemory(), new long[] { 1, nMels, frames });
        using var lenValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance,
            lengths.AsMemory(), new long[] { 1 });
        using var outs = _ctc!.Run(_runOptions,
            new Dictionary<string, OrtValue> { ["features"] = featsValue, ["feature_lengths"] = lenValue },
            _ctc.OutputNames);
        var logits = outs[0];
        var shape = logits.GetTensorTypeAndShape().Shape;
        var data = logits.GetTensorDataAsSpan<float>();
        int classes = _ctcVocab!.Count;
        int time;
        bool classesLast;
        if (shape.Length == 3 && shape[2] == classes) { time = (int)shape[1]; classesLast = true; }
        else if (shape.Length == 3 && shape[1] == classes) { time = (int)shape[2]; classesLast = false; }
        else if (shape.Length == 2 && shape[1] == classes) { time = (int)shape[0]; classesLast = true; }
        else throw new InvalidDataException($"unexpected CTC output shape {string.Join('x', shape)} for {classes} classes");

        int limit = Math.Min(time, (frames - 1) / _cfg.SubsamplingFactor + 1);
        int blank = _ctcVocab.BlankId;
        var kinds = _ctcVocab.Kinds;
        var script = Script;
        // A delegate cannot capture the OrtValue span, so the logits are copied before the argmax.
        var scores = data.ToArray();

        CtcScriptDecoder.Path Greedy(bool allowLatin, bool allowCyrillic)
        {
            int prev = -1;
            var ids = new List<int>();
            double sum = 0;
            for (int t = 0; t < limit; t++)
            {
                int best = blank;
                float bestValue = float.NegativeInfinity;
                for (int c = 0; c < classes; c++)
                {
                    var kind = c < kinds.Length ? kinds[c] : CtcScriptDecoder.TokenKind.Neutral;
                    if (kind == CtcScriptDecoder.TokenKind.Latin && !allowLatin) continue;
                    if (kind == CtcScriptDecoder.TokenKind.Cyrillic && !allowCyrillic) continue;
                    float v = classesLast ? scores[t * classes + c] : scores[c * time + t];
                    if (v > bestValue) { bestValue = v; best = c; }
                }
                if (bestValue > float.NegativeInfinity) sum += bestValue;
                if (best != blank && best != prev) ids.Add(best);
                prev = best;
            }
            return new CtcScriptDecoder.Path(_ctcVocab.Decode(ids), sum, limit);
        }

        return CtcScriptDecoder.Choose(script, Greedy);
    }

    private string DecodeRnnt(float[] feats, int frames, int samples)
    {
        int nMels = _cfg.Features.NMels;
        var lengths = new long[] { _features.OutLen(samples) };
        using var featsValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance,
            feats.AsMemory(), new long[] { 1, nMels, frames });
        using var lenValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance,
            lengths.AsMemory(), new long[] { 1 });
        using var encOut = _encoder!.Run(_runOptions,
            new Dictionary<string, OrtValue> { ["audio_signal"] = featsValue, ["length"] = lenValue },
            _encoder.OutputNames);

        var encShape = encOut[0].GetTensorTypeAndShape().Shape;
        int encD = (int)encShape[1], encT = (int)encShape[2];
        var encoded = encOut[0].GetTensorDataAsSpan<float>().ToArray();
        int encLen = Math.Min((int)encOut[1].GetTensorDataAsSpan<int>()[0], encT);
        return _tokenizer!.Decode(GreedyRnnt(encoded, encD, encT, encLen));
    }

    private List<int> GreedyRnnt(float[] encoded, int encD, int encT, int encLen)
    {
        int hidden = _cfg.PredHidden, layers = _cfg.PredLayers;
        int blank = _tokenizer!.BlankId;
        var hyp = new List<int>();
        var stateShape = new long[] { layers, 1, hidden };
        var zeros = new float[layers * hidden];
        var h = new float[layers * hidden];
        var c = new float[layers * hidden];
        var label = new long[] { blank };
        var frame = new float[encD];
        var dec = new float[hidden];
        bool started = false;
        var decInputs = new Dictionary<string, OrtValue>(3);
        var jointInputs = new Dictionary<string, OrtValue>(2);

        for (int t = 0; t < encLen; t++)
        {
            for (int d = 0; d < encD; d++) frame[d] = encoded[d * encT + t];
            for (int s = 0; s < MaxSymbolsPerFrame; s++)
            {
                label[0] = started ? label[0] : blank;
                using var xValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance, label.AsMemory(), new long[] { 1, 1 });
                using var hValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance, (started ? h : zeros).AsMemory(), stateShape);
                using var cValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance, (started ? c : zeros).AsMemory(), stateShape);
                decInputs["x"] = xValue; decInputs["hi"] = hValue; decInputs["ci"] = cValue;
                using var decOut = _decoder!.Run(_runOptions, decInputs, _decoder.OutputNames);
                decOut[0].GetTensorDataAsSpan<float>().CopyTo(dec);
                using var encValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance, frame.AsMemory(), new long[] { 1, encD, 1 });
                using var decValue = OrtValue.CreateTensorValueFromMemory(OrtMemoryInfo.DefaultInstance, dec.AsMemory(), new long[] { 1, hidden, 1 });
                jointInputs["enc"] = encValue; jointInputs["dec"] = decValue;
                using var jointOut = _joint!.Run(_runOptions, jointInputs, _joint.OutputNames);
                var logits = jointOut[0].GetTensorDataAsSpan<float>();
                if (logits.Length != blank + 1)
                    throw new InvalidDataException($"Tokenizer has {blank} pieces but the joint network outputs {logits.Length} classes");
                int best = 0;
                float bestValue = float.NegativeInfinity;
                for (int i = 0; i < logits.Length; i++)
                    if (logits[i] > bestValue) { bestValue = logits[i]; best = i; }
                if (best == blank) break;
                hyp.Add(best);
                label[0] = best;
                decOut[1].GetTensorDataAsSpan<float>().CopyTo(h);
                decOut[2].GetTensorDataAsSpan<float>().CopyTo(c);
                started = true;
            }
        }
        return hyp;
    }

    public void Dispose()
    {
        // Same lock as a pass, so a warmup or a dictation run finishes before the session goes away.
        lock (_runLock)
        {
            _runOptions.Dispose();
            _ctc?.Dispose();
            _encoder?.Dispose();
            _decoder?.Dispose();
            _joint?.Dispose();
            _ctc = null;
            _encoder = _decoder = _joint = null;
        }
    }

    private sealed class CtcVocab
    {
        private readonly string[] _tokens;
        public int BlankId { get; }
        public int Count => _tokens.Length;
        public CtcScriptDecoder.TokenKind[] Kinds { get; }

        private CtcVocab(string[] tokens, int blank)
        {
            _tokens = tokens;
            BlankId = blank;
            Kinds = new CtcScriptDecoder.TokenKind[tokens.Length];
            for (int i = 0; i < tokens.Length; i++)
                Kinds[i] = CtcScriptDecoder.Classify(tokens[i]);
        }

        public static CtcVocab Load(string path)
        {
            var lines = File.ReadAllLines(path);
            var tokens = new string[lines.Length];
            int blank = -1;
            int n = 0;
            foreach (var raw in lines)
            {
                var line = raw.TrimEnd('\r');
                if (line.Length == 0) continue;
                int sp = line.LastIndexOf(' ');
                if (sp <= 0 || !int.TryParse(line[(sp + 1)..], out int id)) continue;
                var token = line[..sp];
                if (id < 0 || id >= tokens.Length) continue;
                tokens[id] = token;
                if (token == "<blk>") blank = id;
                n = Math.Max(n, id + 1);
            }
            if (n == 0) throw new InvalidDataException($"empty CTC vocab: {path}");
            if (blank < 0) blank = n - 1;
            if (tokens.Length != n) Array.Resize(ref tokens, n);
            for (int i = 0; i < tokens.Length; i++) tokens[i] ??= "";
            return new CtcVocab(tokens, blank);
        }

        public string Decode(IReadOnlyList<int> ids)
        {
            var sb = new System.Text.StringBuilder();
            foreach (var id in ids)
            {
                if (id < 0 || id >= _tokens.Length || id == BlankId) continue;
                var token = _tokens[id];
                if (token.StartsWith('<')) continue;
                sb.Append(token);
            }
            return sb.Replace('▁', ' ').ToString().Trim();
        }
    }
}
