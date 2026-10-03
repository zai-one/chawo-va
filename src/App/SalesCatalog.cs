// Local sales catalog. Matching is letters on this PC: no network and no model.

namespace GigaPisar.App;

public sealed class SalesCatalogItem
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>The one short line shown on the card.</summary>
    public string Line { get; set; } = "";
    /// <summary>Optional other code. A hit on this code is labeled похоже, not exact.</summary>
    public string SimilarCode { get; set; } = "";
}

public enum SalesHitKind { Exact, Similar }

public readonly record struct SalesHit(SalesHitKind Kind, string Name, string Line, string Code, string RagSnippet = "");

public static class SalesCatalog
{
    /// <summary>
    /// Exact when the live text contains a catalog code as its own token.
    /// Otherwise a similar-code token, or the nearest name by shared letters.
    /// Returns null when nothing is close enough to show.
    /// </summary>
    public static SalesHit? Match(string transcript, IReadOnlyList<SalesCatalogItem> items)
    {
        if (string.IsNullOrWhiteSpace(transcript) || items.Count == 0) return null;
        string folded = Fold(transcript);

        SalesCatalogItem? exact = null;
        int exactLen = -1;
        foreach (var item in items)
        {
            string code = Fold(item.Code);
            if (code.Length < 2 || !ContainsToken(folded, code) || code.Length <= exactLen) continue;
            exact = item;
            exactLen = code.Length;
        }
        if (exact != null)
            return new SalesHit(SalesHitKind.Exact, ShowName(exact), exact.Line.Trim(), exact.Code.Trim());

        SalesCatalogItem? similar = null;
        int similarLen = -1;
        foreach (var item in items)
        {
            string code = Fold(item.SimilarCode);
            if (code.Length < 2 || !ContainsToken(folded, code) || code.Length <= similarLen) continue;
            similar = item;
            similarLen = code.Length;
        }
        if (similar != null)
            return new SalesHit(SalesHitKind.Similar, ShowName(similar), similar.Line.Trim(), similar.Code.Trim());

        var words = folded.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        SalesCatalogItem? nearest = null;
        double best = 0;
        int bestOverlap = 0;
        foreach (var item in items)
        {
            string name = Letters(item.Name);
            if (name.Length < 3) continue;
            for (int i = 0; i < words.Length; i++)
            {
                Consider(item, name, Letters(words[i]), ref nearest, ref best, ref bestOverlap);
                if (i + 1 < words.Length)
                    Consider(item, name, Letters(words[i] + words[i + 1]), ref nearest, ref best, ref bestOverlap);
            }
        }
        if (nearest == null) return null;
        return new SalesHit(SalesHitKind.Similar, ShowName(nearest), nearest.Line.Trim(), nearest.Code.Trim());
    }

    private static void Consider(SalesCatalogItem item, string name, string chunk,
        ref SalesCatalogItem? nearest, ref double best, ref int bestOverlap)
    {
        if (chunk.Length < 3) return;
        int overlap = SharedLetters(name, chunk);
        if (overlap < 3) return;
        double score = overlap / (double)Math.Max(name.Length, chunk.Length);
        if (score < 0.6) return;
        if (score < best || (Math.Abs(score - best) < 0.0001 && overlap <= bestOverlap)) return;
        best = score;
        bestOverlap = overlap;
        nearest = item;
    }

    public static SalesHit WithRag(SalesHit hit, string? snippet) =>
        hit with { RagSnippet = string.IsNullOrWhiteSpace(snippet) ? "" : snippet.Trim() };

    private static string ShowName(SalesCatalogItem item)
    {
        string name = item.Name.Trim();
        return name.Length > 0 ? name : item.Code.Trim();
    }

    /// <summary>Lowercase, ё→е, everything except letters, digits, hyphen and underscore becomes a space.</summary>
    private static string Fold(string text)
    {
        var sb = new System.Text.StringBuilder(text.Length);
        foreach (char raw in text.Trim().ToLowerInvariant())
        {
            char c = raw == 'ё' ? 'е' : raw;
            if (char.IsLetterOrDigit(c) || c == '-' || c == '_') sb.Append(c);
            else if (sb.Length > 0 && sb[^1] != ' ') sb.Append(' ');
        }
        return sb.ToString().Trim();
    }

    private static string Letters(string folded)
    {
        var sb = new System.Text.StringBuilder(folded.Length);
        foreach (char c in folded)
            if (char.IsLetter(c)) sb.Append(c);
        return sb.ToString();
    }

    private static int SharedLetters(string a, string b)
    {
        var counts = new Dictionary<char, int>();
        foreach (char c in a) counts[c] = counts.GetValueOrDefault(c) + 1;
        int n = 0;
        foreach (char c in b)
        {
            if (!counts.TryGetValue(c, out int k) || k == 0) continue;
            counts[c] = k - 1;
            n++;
        }
        return n;
    }

    private static bool ContainsToken(string folded, string token)
    {
        int from = 0;
        while (from <= folded.Length - token.Length)
        {
            int at = folded.IndexOf(token, from, StringComparison.Ordinal);
            if (at < 0) return false;
            bool left = at == 0 || folded[at - 1] == ' ';
            int end = at + token.Length;
            bool right = end == folded.Length || folded[end] == ' ';
            if (left && right) return true;
            from = at + 1;
        }
        return false;
    }
}
