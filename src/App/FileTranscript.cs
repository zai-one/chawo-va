// A long dialogue file becomes a .txt beside it. The path is read in place.
// Nothing is copied under the name "upload", and no model is downloaded.

using ChawoVA.Core;

namespace ChawoVA.App;

public static class FileTranscript
{
    /// <summary>About 1.7 GB: two hours of 44.1 kHz stereo 16-bit, with room. Larger files are refused.</summary>
    public const long MaxBytes = 1_800_000_000;

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

    public static bool IsWav(ReadOnlySpan<byte> d) =>
        d.Length >= 12 && d[0] == (byte)'R' && d[1] == (byte)'I' && d[2] == (byte)'F' && d[3] == (byte)'F'
        && d[8] == (byte)'W' && d[9] == (byte)'A' && d[10] == (byte)'V' && d[11] == (byte)'E';

    public static bool IsOgg(ReadOnlySpan<byte> d) =>
        d.Length >= 4 && d[0] == (byte)'O' && d[1] == (byte)'g' && d[2] == (byte)'g' && d[3] == (byte)'S';

    /// <summary>16 kHz mono. WAV must be 16-bit PCM. Ogg must be Opus.</summary>
    public static float[] Decode16k(byte[] audio, string label)
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

    public static float[] Load16k(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException(path);
        if (info.Length > MaxBytes) throw new InvalidDataException("file is too large");
        return Decode16k(File.ReadAllBytes(path), path);
    }
}
