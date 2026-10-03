// WAV reading/writing and splitting long recordings at pauses.

namespace GigaPisar.Core;

public static class AudioUtils
{
    /// <summary>Reads a 16-bit PCM WAV; takes the first channel.</summary>
    public static (float[] samples, int rate) ReadWav(string path) => ReadWav(File.ReadAllBytes(path), path);

    /// <summary>Reads a 16-bit PCM WAV from memory; takes the first channel.</summary>
    public static (float[] samples, int rate) ReadWav(byte[] d, string label = "wav")
    {
        if (d.Length < 44 || BitConverter.ToUInt32(d, 0) != 0x46464952u)
            throw new InvalidDataException($"Not a WAV file: {label}");

        int rate = 16000, channels = 1, bits = 16;
        int i = 12;
        while (i + 8 <= d.Length)
        {
            uint id = BitConverter.ToUInt32(d, i);
            uint size32 = BitConverter.ToUInt32(d, i + 4);
            int body = i + 8;
            if (size32 > (uint)(d.Length - body)) throw new InvalidDataException($"Truncated WAV: {label}");
            int size = (int)size32;
            if (id == 0x20746D66u) // "fmt "
            {
                if (body + 16 > d.Length) throw new InvalidDataException($"Truncated WAV header: {label}");
                if (BitConverter.ToUInt16(d, body) != 1) throw new InvalidDataException($"Expected PCM WAV: {label}");
                channels = BitConverter.ToUInt16(d, body + 2);
                rate = (int)BitConverter.ToUInt32(d, body + 4);
                bits = BitConverter.ToUInt16(d, body + 14);
            }
            else if (id == 0x61746164u) // "data"
            {
                if (bits != 16) throw new InvalidDataException($"Expected 16-bit WAV, got {bits}-bit: {label}");
                int end = Math.Min(body + size, d.Length);
                var outp = new List<float>((end - body) / 2 / Math.Max(1, channels));
                for (int p = body; p + 2 * channels <= end; p += 2 * channels)
                    outp.Add(BitConverter.ToInt16(d, p) / 32768f);
                return (outp.ToArray(), rate);
            }
            i = body + size + (size & 1);
        }
        throw new InvalidDataException($"No data chunk in WAV: {label}");
    }

    /// <summary>Writes a 16-bit mono WAV. Used to keep the last dictation for debugging.</summary>
    public static void WriteWav(ReadOnlySpan<float> samples, int rate, string path)
    {
        File.WriteAllBytes(path, WavBytes(samples, rate));
    }

    /// <summary>16-bit mono WAV in memory. The network client posts this to another PC.</summary>
    public static byte[] WavBytes(ReadOnlySpan<float> samples, int rate)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms, System.Text.Encoding.UTF8, leaveOpen: true);
        int body = samples.Length * 2;
        w.Write("RIFF"u8); w.Write(36 + body);
        w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16);
        w.Write((short)1); w.Write((short)1); w.Write(rate); w.Write(rate * 2); w.Write((short)2); w.Write((short)16);
        w.Write("data"u8); w.Write(body);
        foreach (var x in samples)
            w.Write((short)Math.Clamp((int)(x * 32767f), -32768, 32767));
        w.Flush();
        return ms.ToArray();
    }

    /// <summary>Linear resample. Hermes and dictation both feed the model 16 kHz.</summary>
    public static float[] Resample(float[] src, int srcRate, int dstRate)
    {
        if (srcRate == dstRate) return src;
        if (srcRate <= 0 || dstRate <= 0 || src.Length == 0) return src;
        int dstLen = Math.Max(1, (int)((long)src.Length * dstRate / srcRate));
        var dst = new float[dstLen];
        double step = (double)srcRate / dstRate;
        for (int i = 0; i < dstLen; i++)
        {
            double x = (i + 0.5) * step - 0.5;
            int i0 = (int)Math.Floor(x);
            double f = x - i0;
            float a = src[Math.Clamp(i0, 0, src.Length - 1)];
            float b = src[Math.Clamp(i0 + 1, 0, src.Length - 1)];
            dst[i] = (float)(a + (b - a) * f);
        }
        return dst;
    }

    /// <summary>Midpoints of pauses, candidates for cut points. Mirrors ffmpeg silencedetect.</summary>
    public static List<double> Silences(ReadOnlySpan<float> x, int rate, float noiseDb = -35f, double minSeconds = 0.3)
    {
        float threshold = MathF.Pow(10f, noiseDb / 20f);
        int minRun = (int)(minSeconds * rate);
        var points = new List<double>();
        int start = -1;
        for (int i = 0; i < x.Length; i++)
        {
            if (Math.Abs(x[i]) < threshold)
            {
                if (start < 0) start = i;
            }
            else if (start >= 0)
            {
                if (i - start >= minRun) points.Add((start + i) / 2.0 / rate);
                start = -1;
            }
        }
        return points;
    }

    /// <summary>Chunk boundaries: never longer than maxChunk, cut at the last pause before the limit.</summary>
    public static List<(double from, double to)> ChunkBounds(double total, List<double> silences, double maxChunk)
    {
        var bounds = new List<(double, double)>();
        double pos = 0;
        while (total - pos > maxChunk)
        {
            double cut = pos + maxChunk;
            for (int i = silences.Count - 1; i >= 0; i--)
            {
                if (silences[i] > pos + 3 && silences[i] <= pos + maxChunk) { cut = silences[i]; break; }
            }
            bounds.Add((pos, cut));
            pos = cut;
        }
        bounds.Add((pos, total));
        return bounds;
    }
}
