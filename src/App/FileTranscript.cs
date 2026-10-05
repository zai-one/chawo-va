// A long dialogue file becomes a .txt beside it. The path is read in place.
// Decode order: 16-bit PCM WAV / Ogg-Opus → Windows Media Foundation → optional ffmpeg.
// Nothing is copied under the name "upload", and no model is downloaded here.

using ChawoVA.Core;
using NAudio.MediaFoundation;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace ChawoVA.App;

public static class FileTranscript
{
    /// <summary>About 1.7 GB: two hours of 44.1 kHz stereo 16-bit, with room. Larger files are refused.</summary>
    public const long MaxBytes = 1_800_000_000;

    /// <summary>Extensions the picker lists. Decode may still need ffmpeg for some of them.</summary>
    public static readonly string[] Extensions =
    [
        ".wav", ".wave",
        ".ogg", ".opus",
        ".mp3",
        ".m4a", ".aac", ".mp4", ".m4v",
        ".mov", ".mkv", ".webm", ".3gp", ".3g2",
        ".flac",
        ".wma",
        ".amr",
    ];

    public static string OpenFilter =>
        "Audio|" + string.Join(";", Extensions.Select(e => "*" + e))
        + "|WAV (*.wav)|*.wav;*.wave"
        + "|All|*.*";

    private static int _mfStarted;

    /// <summary>Same folder, same base name, extension .txt. talk.wav -> talk.txt.</summary>
    public static string OutputPath(string source)
    {
        string full = Path.GetFullPath(source);
        string? dir = Path.GetDirectoryName(full);
        if (string.IsNullOrEmpty(dir)) dir = Directory.GetCurrentDirectory();
        string name = Path.GetFileNameWithoutExtension(full);
        if (name.Length == 0) name = "transcript";
        return Path.Combine(dir, name + ".txt");
    }

    public static bool HasSupportedExtension(string path)
    {
        string ext = Path.GetExtension(path);
        return Extensions.Any(e => e.Equals(ext, StringComparison.OrdinalIgnoreCase));
    }

    public static IReadOnlyList<string> CollectFromFolder(string folder)
    {
        if (!Directory.Exists(folder)) return Array.Empty<string>();
        return Directory.EnumerateFiles(folder)
            .Where(HasSupportedExtension)
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public static bool IsWav(ReadOnlySpan<byte> d) =>
        d.Length >= 12 && d[0] == (byte)'R' && d[1] == (byte)'I' && d[2] == (byte)'F' && d[3] == (byte)'F'
        && d[8] == (byte)'W' && d[9] == (byte)'A' && d[10] == (byte)'V' && d[11] == (byte)'E';

    public static bool IsOgg(ReadOnlySpan<byte> d) =>
        d.Length >= 4 && d[0] == (byte)'O' && d[1] == (byte)'g' && d[2] == (byte)'g' && d[3] == (byte)'S';

    /// <summary>16 kHz mono float. Tries native WAV/Ogg, then Media Foundation, then ffmpeg if present.</summary>
    public static float[] Load16k(string path, CancellationToken cancel = default)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException(path);
        if (info.Length > MaxBytes) throw new InvalidDataException("file is too large");

        // Fast path: our own WAV (16-bit PCM) and Ogg/Opus readers.
        try
        {
            cancel.ThrowIfCancellationRequested();
            byte[] head = new byte[Math.Min(64, (int)info.Length)];
            using (var fs = File.OpenRead(path))
                _ = fs.Read(head, 0, head.Length);
            if (IsWav(head) || IsOgg(head))
            {
                // Full read only when the header matches — keeps big unsupported files from filling RAM twice.
                byte[] audio = File.ReadAllBytes(path);
                cancel.ThrowIfCancellationRequested();
                return DecodeNative(audio, path);
            }
        }
        catch (InvalidDataException)
        {
            // Fall through: e.g. WAV float/24-bit, or Ogg that is not Opus.
        }

        cancel.ThrowIfCancellationRequested();
        Exception? mfError = null;
        try
        {
            return DecodeMediaFoundation(path);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            mfError = ex;
            Log.Write($"file MF decode failed ({path}): {ex.GetType().Name}: {ex.Message}");
        }

        cancel.ThrowIfCancellationRequested();
        if (FfmpegTool.Find() != null)
        {
            try { return FfmpegTool.DecodeTo16k(path, cancel); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                throw new InvalidDataException(
                    "could not decode with Media Foundation or ffmpeg: " + (mfError?.Message ?? "") + " / " + ex.Message,
                    ex);
            }
        }

        string hint = FfmpegTool.IsInstalled
            ? ""
            : " Install ffmpeg (button on the File transcription page) for Opus-in-WebM/MKV, some FLAC and AMR.";
        throw new InvalidDataException(
            (mfError?.Message ?? "unsupported audio format") + hint);
    }

    /// <summary>16 kHz mono. WAV must be 16-bit PCM. Ogg must be Opus.</summary>
    public static float[] Decode16k(byte[] audio, string label)
    {
        if (IsWav(audio) || IsOgg(audio)) return DecodeNative(audio, label);
        throw new InvalidDataException("need a wav or ogg/opus buffer");
    }

    private static float[] DecodeNative(byte[] audio, string label)
    {
        if (IsWav(audio))
        {
            var (samples, rate) = AudioUtils.ReadWav(audio, label);
            if (rate != 16000) samples = AudioUtils.Resample(samples, rate, 16000);
            return samples;
        }
        if (IsOgg(audio)) return OggOpus.DecodeTo16kMono(audio);
        throw new InvalidDataException("need a wav or ogg/opus file");
    }

    private static float[] DecodeMediaFoundation(string path)
    {
        EnsureMediaFoundation();
        using var reader = new MediaFoundationReader(path);
        ISampleProvider samples = reader.ToSampleProvider();
        if (samples.WaveFormat.Channels > 1)
            samples = new StereoToMonoSampleProvider(samples) { LeftVolume = 0.5f, RightVolume = 0.5f };
        else if (samples.WaveFormat.Channels != 1)
            throw new InvalidDataException($"unsupported channel count {samples.WaveFormat.Channels}");
        if (samples.WaveFormat.SampleRate != 16000)
            samples = new WdlResamplingSampleProvider(samples, 16000);

        // Read in chunks; MediaFoundationReader streams.
        var chunks = new List<float[]>(64);
        int total = 0;
        var buf = new float[16000]; // 1 s
        int n;
        while ((n = samples.Read(buf, 0, buf.Length)) > 0)
        {
            var copy = new float[n];
            Array.Copy(buf, copy, n);
            chunks.Add(copy);
            total += n;
            if (total > 16000 * 60 * 60 * 3) // > 3 hours of 16 kHz mono
                throw new InvalidDataException("decoded audio is too large");
        }
        var all = new float[total];
        int o = 0;
        foreach (var c in chunks)
        {
            Array.Copy(c, 0, all, o, c.Length);
            o += c.Length;
        }
        return all;
    }

    private static void EnsureMediaFoundation()
    {
        if (Interlocked.CompareExchange(ref _mfStarted, 1, 0) == 0)
        {
            try { MediaFoundationApi.Startup(); }
            catch
            {
                Interlocked.Exchange(ref _mfStarted, 0);
                throw;
            }
        }
    }
}
