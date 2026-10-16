// Long-file transcription: dedicated sessions so dictation is not locked out,
// CPU workers in parallel, GPU batches on one DirectML session.

using System.Diagnostics;
using System.Threading.Tasks;

namespace ChawoVA.Core;

public sealed class FileJob : IDisposable
{
    private readonly Recognizer[] _workers;
    private readonly FileParallelPlan _plan;
    private int _disposed;

    public FileParallelPlan Plan => _plan;
    public string DeviceActual => _workers[0].DeviceActual;
    public string Provider => _workers[0].Provider;

    private FileJob(Recognizer[] workers, FileParallelPlan plan)
    {
        _workers = workers;
        _plan = plan;
    }

    /// <summary>
    /// Opens sessions used only for this file. Does not touch the dictation recognizer.
    /// On GPU always one session (DirectML is not safe for concurrent Run).
    /// </summary>
    public static FileJob Open(
        string modelDir,
        SpeechModelKind kind,
        SpeechDeviceKind device,
        FileParallelismKind parallelism,
        CtcScript script,
        long availableBytes = -1)
    {
        if (availableBytes < 0)
        {
            try
            {
                var gc = GC.GetGCMemoryInfo();
                availableBytes = Math.Max(0, gc.TotalAvailableMemoryBytes - gc.MemoryLoadBytes);
            }
            catch { availableBytes = 4L << 30; }
        }

        int cores = Math.Max(1, Environment.ProcessorCount);
        // First session: learn real device (GPU may fall back) and whether the graph batches.
        var first = new Recognizer(modelDir, kind, device, threads: Math.Max(1, cores / 2));
        first.Script = script;
        bool useGpu = first.DeviceActual == "gpu";
        var plan = FileParallel.Resolve(
            parallelism, useGpu, first.EncoderAcceptsBatch, kind, cores, availableBytes);

        Recognizer[] workers;
        try
        {
            if (plan.Workers == 1)
            {
                // Re-open only when intra-op threads differ a lot; otherwise keep the warm session.
                if (first.IntraOpThreads != plan.IntraOpThreads && !useGpu)
                {
                    first.Dispose();
                    first = new Recognizer(modelDir, kind, SpeechDeviceKind.Cpu, plan.IntraOpThreads);
                    first.Script = script;
                }
                workers = new[] { first };
                first = null!; // ownership moved
            }
            else
            {
                first.Dispose();
                first = null!;
                workers = new Recognizer[plan.Workers];
                for (int i = 0; i < plan.Workers; i++)
                {
                    workers[i] = new Recognizer(modelDir, kind, SpeechDeviceKind.Cpu, plan.IntraOpThreads);
                    workers[i].Script = script;
                }
            }
        }
        catch
        {
            first?.Dispose();
            throw;
        }

        return new FileJob(workers, plan);
    }

    /// <summary>
    /// Transcribe every piece. Results stay in piece order. Empty pieces stay empty strings
    /// so the caller can join with newlines the same way as the sequential path.
    /// </summary>
    public string[] Run(
        float[] samplesAtModelRate,
        IReadOnlyList<(int from, int to)> ranges,
        Action<int /*done*/, int /*total*/, double /*audioSecDone*/, double /*wallSec*/>? onProgress,
        CancellationToken cancel)
    {
        int n = ranges.Count;
        var texts = new string[n];
        if (n == 0) return texts;

        var sw = Stopwatch.StartNew();
        int done = 0;
        double audioDone = 0;
        object progressLock = new();

        void Report(int pieceSamples)
        {
            int d;
            double a;
            lock (progressLock)
            {
                done++;
                audioDone += pieceSamples / (double)Math.Max(1, _workers[0].SampleRate);
                d = done;
                a = audioDone;
            }
            onProgress?.Invoke(d, n, a, sw.Elapsed.TotalSeconds);
        }

        if (_plan.UseGpu || _plan.Workers == 1)
        {
            var rec = _workers[0];
            int batch = Math.Max(1, _plan.BatchSize);
            // Producer prepares the next batch of waveforms while the current batch runs.
            float[][]? readyWaves = null;
            int[]? readyLengths = null;
            int readyAt = 0;
            int readyTake = 0;

            float[][] CopyBatch(int at, int take, out int[] lengths)
            {
                var waves = new float[take][];
                lengths = new int[take];
                for (int k = 0; k < take; k++)
                {
                    var (from, to) = ranges[at + k];
                    lengths[k] = to - from;
                    waves[k] = new float[lengths[k]];
                    Array.Copy(samplesAtModelRate, from, waves[k], 0, lengths[k]);
                }
                return waves;
            }

            int i = 0;
            while (i < n)
            {
                cancel.ThrowIfCancellationRequested();
                int take = Math.Min(batch, n - i);
                float[][] waves;
                int[] lengths;
                if (readyWaves != null && readyAt == i && readyTake == take)
                {
                    waves = readyWaves;
                    lengths = readyLengths!;
                    readyWaves = null;
                }
                else
                {
                    waves = CopyBatch(i, take, out lengths);
                }

                // Kick off copy of the following batch on a worker thread.
                int nextAt = i + take;
                int nextTake = nextAt < n ? Math.Min(batch, n - nextAt) : 0;
                Task? prep = null;
                if (nextTake > 0)
                {
                    prep = Task.Run(() =>
                    {
                        var w = CopyBatch(nextAt, nextTake, out var lens);
                        readyWaves = w;
                        readyLengths = lens;
                        readyAt = nextAt;
                        readyTake = nextTake;
                    }, cancel);
                }

                string[] bits;
                try
                {
                    bits = take == 1
                        ? new[] { rec.TranscribePiece(waves[0]) }
                        : rec.TranscribeBatch(waves, cancel);
                }
                catch (Exception ex) when (take > 1 && IsMemoryPressure(ex))
                {
                    try { prep?.Wait(cancel); } catch { /* ignore */ }
                    readyWaves = null;
                    batch = Math.Max(1, take / 2);
                    continue;
                }

                for (int k = 0; k < take; k++)
                {
                    texts[i + k] = bits[k] ?? "";
                    Report(lengths[k]);
                }
                i += take;
                try { prep?.Wait(cancel); } catch (OperationCanceledException) { throw; }
                catch { /* prep failed; next loop recopies */ readyWaves = null; }
            }
            return texts;
        }

        var gate = new object();
        int next = 0;
        Exception? fault = null;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        var threads = new Thread[_plan.Workers];
        for (int w = 0; w < _plan.Workers; w++)
        {
            int wid = w;
            threads[w] = new Thread(() =>
            {
                var rec = _workers[wid];
                try
                {
                    while (true)
                    {
                        int idx;
                        lock (gate)
                        {
                            if (fault != null) return;
                            if (next >= n) return;
                            idx = next++;
                        }
                        if (linked.IsCancellationRequested) return;
                        var (from, to) = ranges[idx];
                        var piece = new float[to - from];
                        Array.Copy(samplesAtModelRate, from, piece, 0, piece.Length);
                        string bit;
                        try
                        {
                            bit = rec.TranscribePiece(piece);
                        }
                        catch (Exception ex) when (linked.IsCancellationRequested || IsTerminate(ex))
                        {
                            return;
                        }
                        texts[idx] = bit ?? "";
                        Report(piece.Length);
                    }
                }
                catch (Exception ex)
                {
                    lock (gate) fault ??= ex;
                    try { linked.Cancel(); } catch { }
                    foreach (var r in _workers)
                        try { r.CancelRun(); } catch { }
                }
            })
            {
                IsBackground = true,
                Name = $"chawo-file-{wid}",
            };
            threads[w].Start();
        }

        using (cancel.Register(() =>
        {
            foreach (var r in _workers)
                try { r.CancelRun(); } catch { }
        }))
        {
            foreach (var th in threads)
                th.Join();
        }

        cancel.ThrowIfCancellationRequested();
        if (fault != null) throw fault;
        return texts;
    }

    public void Cancel()
    {
        foreach (var r in _workers)
            try { r.CancelRun(); } catch { }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        foreach (var r in _workers)
            try { r.Dispose(); } catch { }
    }

    private static bool IsMemoryPressure(Exception ex)
    {
        string m = ex.Message ?? "";
        return m.Contains("memory", StringComparison.OrdinalIgnoreCase)
            || m.Contains("OOM", StringComparison.OrdinalIgnoreCase)
            || m.Contains("out of", StringComparison.OrdinalIgnoreCase)
            || m.Contains("DXGI", StringComparison.OrdinalIgnoreCase)
            || (m.Contains("FAILED", StringComparison.OrdinalIgnoreCase)
                && m.Contains("alloc", StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsTerminate(Exception ex) =>
        (ex.Message ?? "").Contains("terminate", StringComparison.OrdinalIgnoreCase);
}
