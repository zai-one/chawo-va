// Plain text and SubRip output for a transcribed file. No Windows types: the same
// segment shape (start, end, text) is what a SaaS backend would store per chunk.

using System.Globalization;
using System.Text;

namespace ChawoVA.Core;

/// <summary>One recognized piece. Start/End are seconds in the source recording (real pause-split offsets).</summary>
public readonly record struct TranscriptSegment(double Start, double End, string Text);

public static class TranscriptFormat
{
    /// <summary>00:00:00 — hours always shown, seconds floored.</summary>
    public static string Clock(double seconds)
    {
        if (double.IsNaN(seconds) || seconds < 0) seconds = 0;
        long s = (long)Math.Floor(seconds);
        return string.Create(CultureInfo.InvariantCulture, $"{s / 3600:00}:{s / 60 % 60:00}:{s % 60:00}");
    }

    /// <summary>00:00:00,000 as SubRip wants it.</summary>
    public static string SrtTime(double seconds)
    {
        if (double.IsNaN(seconds) || seconds < 0) seconds = 0;
        long ms = (long)Math.Round(seconds * 1000.0);
        long s = ms / 1000;
        return string.Create(CultureInfo.InvariantCulture, $"{s / 3600:00}:{s / 60 % 60:00}:{s % 60:00},{ms % 1000:000}");
    }

    /// <summary>One line per non-empty piece; with timestamps each line starts with [hh:mm:ss] of the piece start.</summary>
    public static string Txt(IReadOnlyList<TranscriptSegment> segments, bool timestamps)
    {
        var sb = new StringBuilder();
        foreach (var seg in segments)
        {
            var text = (seg.Text ?? "").Trim();
            if (text.Length == 0) continue;
            if (sb.Length > 0) sb.Append('\n');
            if (timestamps) sb.Append('[').Append(Clock(seg.Start)).Append("] ");
            sb.Append(text);
        }
        return sb.ToString();
    }

    /// <summary>SubRip: index, start --> end, text, blank line. Empty pieces are left out and numbering stays continuous.</summary>
    public static string Srt(IReadOnlyList<TranscriptSegment> segments)
    {
        var sb = new StringBuilder();
        int n = 0;
        foreach (var seg in segments)
        {
            var text = (seg.Text ?? "").Trim();
            if (text.Length == 0) continue;
            n++;
            double end = Math.Max(seg.End, seg.Start + 0.5);
            sb.Append(n.ToString(CultureInfo.InvariantCulture)).Append("\r\n")
              .Append(SrtTime(seg.Start)).Append(" --> ").Append(SrtTime(end)).Append("\r\n")
              .Append(text.Replace("\r\n", "\n").Replace('\n', ' ')).Append("\r\n\r\n");
        }
        return sb.ToString();
    }

    /// <summary>Segments from pause-split sample ranges and the texts the model returned for them.</summary>
    public static List<TranscriptSegment> FromRanges(IReadOnlyList<(int from, int to)> ranges, IReadOnlyList<string> texts, int rate)
    {
        var list = new List<TranscriptSegment>(ranges.Count);
        double r = Math.Max(1, rate);
        for (int i = 0; i < ranges.Count && i < texts.Count; i++)
            list.Add(new TranscriptSegment(ranges[i].from / r, ranges[i].to / r, texts[i] ?? ""));
        return list;
    }
}
