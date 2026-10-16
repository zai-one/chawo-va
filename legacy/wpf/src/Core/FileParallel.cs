// How long file transcription splits work across CPU workers or a GPU batch.
// Dictation keeps its own session; this module only builds the file-side plan and progress line.

namespace ChawoVA.Core;

/// <summary>User choice on the File transcription page. Maps to CPU workers or GPU batch size.</summary>
public enum FileParallelismKind
{
    /// <summary>Pick workers/batch from cores, device and a rough RAM budget.</summary>
    Auto = 0,
    /// <summary>One piece at a time. Least memory.</summary>
    Gentle1 = 1,
    Two = 2,
    Four = 4,
    /// <summary>As many as the plan allows (CPU) or batch 8 (GPU).</summary>
    Max = 8,
}

/// <summary>Resolved shape of one file job. Logged and shown in the progress line when Auto picks it.</summary>
public sealed record FileParallelPlan(
    int Workers,
    int BatchSize,
    int IntraOpThreads,
    bool UseGpu,
    bool EncoderBatch,
    FileParallelismKind Kind,
    string SummaryRu,
    string SummaryEn);

public static class FileParallel
{
    /// <summary>Rough resident set of one InferenceSession set, so Auto does not spawn more workers than RAM allows.</summary>
    public static long EstimateSessionBytes(SpeechModelKind kind) =>
        kind == SpeechModelKind.V3E2eRnnt ? 550L << 20 : 2800L << 20;

    /// <summary>
    /// CPU: several sessions, cores split across workers.
    /// GPU (DirectML): one session, batch the encoder when the graph accepts a dynamic batch dim.
    /// </summary>
    public static FileParallelPlan Resolve(
        FileParallelismKind kind,
        bool useGpu,
        bool encoderAcceptsBatch,
        SpeechModelKind model,
        int cores,
        long availableBytes)
    {
        cores = Math.Max(1, cores);
        int asked = kind switch
        {
            FileParallelismKind.Gentle1 => 1,
            FileParallelismKind.Two => 2,
            FileParallelismKind.Four => 4,
            FileParallelismKind.Max => useGpu ? 8 : Math.Max(1, cores),
            _ => 0, // Auto
        };

        if (useGpu)
        {
            int batch = kind == FileParallelismKind.Auto
                ? (encoderAcceptsBatch ? 4 : 1)
                : asked;
            if (!encoderAcceptsBatch) batch = 1;
            batch = Math.Clamp(batch, 1, 8);
            bool auto = kind == FileParallelismKind.Auto;
            return new FileParallelPlan(
                Workers: 1,
                BatchSize: batch,
                IntraOpThreads: Math.Min(4, cores),
                UseGpu: true,
                EncoderBatch: encoderAcceptsBatch && batch > 1,
                Kind: kind,
                SummaryRu: auto ? $"Авто → пакет {batch}" : $"пакет {batch}",
                SummaryEn: auto ? $"Auto → batch {batch}" : $"batch {batch}");
        }

        int workers;
        if (kind == FileParallelismKind.Auto)
            workers = Math.Clamp(cores / 2, 1, 4);
        else
            workers = Math.Max(1, asked);

        long per = EstimateSessionBytes(model);
        // Keep about 1.2 GB for the OS, the UI and the dictation session if it is already warm.
        long budget = Math.Max(per, availableBytes - (1200L << 20));
        int byRam = Math.Max(1, (int)(budget / Math.Max(1, per)));
        workers = Math.Min(workers, byRam);
        workers = Math.Clamp(workers, 1, Math.Max(1, cores));
        int intra = Math.Max(1, cores / workers);
        bool isAuto = kind == FileParallelismKind.Auto;
        return new FileParallelPlan(
            Workers: workers,
            BatchSize: 1,
            IntraOpThreads: intra,
            UseGpu: false,
            EncoderBatch: false,
            Kind: kind,
            SummaryRu: isAuto ? $"Авто → {workers}× CPU" : $"{workers}× CPU",
            SummaryEn: isAuto ? $"Auto → {workers}× CPU" : $"{workers}× CPU");
    }

    /// <summary>Progress line body after the optional file-prefix.</summary>
    public static string ProgressLine(
        int done, int total, double audioSecondsDone, double wallSeconds,
        string? planSummary, Func<string, string, string> t)
    {
        done = Math.Clamp(done, 0, Math.Max(0, total));
        double rtf = wallSeconds > 0.05 && audioSecondsDone > 0
            ? audioSecondsDone / wallSeconds
            : 0;
        string left = "";
        if (rtf > 0.05 && done > 0 && done < total && total > 0)
        {
            double audioLeft = (total - done) * (audioSecondsDone / done);
            double secLeft = audioLeft / rtf;
            int mm = (int)(secLeft / 60);
            int ss = (int)(secLeft % 60);
            left = t($" · осталось ~{mm:D2}:{ss:D2}", $" · ~{mm:D2}:{ss:D2} left");
        }
        string speed = rtf > 0.05
            ? t($" · {rtf:0.#}× быстрее реального времени", $" · {rtf:0.#}× faster than real time")
            : "";
        string pick = string.IsNullOrEmpty(planSummary) ? "" : $" · {planSummary}";
        return t($"Кусок {done} из {total}", $"Piece {done} of {total}") + speed + left + pick;
    }
}
