// Letter-script choice for multilingual CTC greedy decoding.
//
// The published graph (istupakov multilingual_large_ctc) takes only
// "features" and "feature_lengths". There is no language id, blank, or
// hotword input. The vocabulary is one character per id: ▁, apostrophe,
// a–z, Cyrillic letters (Russian and a few Central Asian), and <blk>.
// Forcing a script means skipping those letter ids when picking the
// best logit of each frame. It does not spell an English word the model
// did not score.

namespace GigaPisar.Core;

public static class CtcScriptDecoder
{
    /// <summary>
    /// Auto accepts the Latin-only path when its mean chosen logit is within
    /// this of the free path. Not measured on the 2.4 GB weights. A frame
    /// where the model is sure of a Cyrillic letter costs more than this,
    /// so that text stays Cyrillic.
    /// </summary>
    public const double AutoLatinGapPerFrame = 0.75;

    public enum TokenKind { Neutral, Latin, Cyrillic }

    public readonly record struct Path(string Text, double Sum, int Frames);

    public static TokenKind Classify(string token)
    {
        if (string.IsNullOrEmpty(token) || token[0] == '<') return TokenKind.Neutral;
        bool lat = false, cyr = false;
        foreach (char ch in token)
        {
            if (ch is >= 'A' and <= 'Z' or >= 'a' and <= 'z') lat = true;
            else if (ch is >= '\u0400' and <= '\u052F') cyr = true;
        }
        if (cyr && !lat) return TokenKind.Cyrillic;
        if (lat && !cyr) return TokenKind.Latin;
        return TokenKind.Neutral;
    }

    /// <summary>
    /// <paramref name="greedy"/> is called with (allow Latin letters, allow Cyrillic letters).
    /// Neutral tokens, including blank, stay allowed in every call.
    /// </summary>
    public static string Choose(CtcScript script, Func<bool, bool, Path> greedy)
    {
        if (script == CtcScript.English) return greedy(true, false).Text;
        if (script == CtcScript.Russian) return greedy(false, true).Text;

        var free = greedy(true, true);
        if (MostlyLatin(free.Text)) return free.Text;
        var latin = greedy(true, false);
        if (!HasLatinLetter(latin.Text)) return free.Text;
        int frames = Math.Max(1, Math.Max(free.Frames, latin.Frames));
        double gap = (free.Sum - latin.Sum) / frames;
        return gap <= AutoLatinGapPerFrame ? latin.Text : free.Text;
    }

    public static bool MostlyLatin(string text)
    {
        CountLetters(text, out int lat, out int cyr);
        return lat > 0 && lat >= cyr;
    }

    public static bool HasLatinLetter(string text)
    {
        CountLetters(text, out int lat, out _);
        return lat > 0;
    }

    private static void CountLetters(string text, out int lat, out int cyr)
    {
        lat = 0;
        cyr = 0;
        foreach (char ch in text)
        {
            if (ch is >= 'A' and <= 'Z' or >= 'a' and <= 'z') lat++;
            else if (ch is >= '\u0400' and <= '\u052F') cyr++;
        }
    }
}
