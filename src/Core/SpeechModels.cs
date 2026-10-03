namespace GigaPisar.Core;

/// <summary>Which published GigaAM weights to run.</summary>
public enum SpeechModelKind
{
    /// <summary>600M multilingual CTC. Largest GigaAM ASR that has a usable ONNX graph.</summary>
    MultilingualLargeCtc,
    /// <summary>Russian v3 end-to-end RNN-T with punctuation. Smaller, CPU-friendly.</summary>
    V3E2eRnnt,
}

/// <summary>Where the ONNX session should run. GPU falls back to CPU if DirectML cannot start.</summary>
public enum SpeechDeviceKind
{
    Gpu,
    Cpu,
}

public static class SpeechModels
{
    public const int HermesPort = 17831;

    public static string Id(SpeechModelKind kind) => kind switch
    {
        SpeechModelKind.V3E2eRnnt => "v3_e2e_rnnt",
        _ => "multilingual_large_ctc",
    };

    public static string Folder(SpeechModelKind kind) => kind switch
    {
        SpeechModelKind.V3E2eRnnt => "v3-e2e-rnnt",
        _ => "multilingual-large-ctc",
    };
}
