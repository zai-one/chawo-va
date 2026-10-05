// Local sales materials: a folder of .txt / .md. No network and no model.
// Used for a card snippet when the catalog code is missing, and for
// dictionary suggestions the user still has to add by hand.

namespace ChawoVA.App;

public readonly record struct RagSnippet(string Text, string Source);

public readonly record struct DictSuggestion(string Heard, string Written, string Source);

public static class SalesRag
{
    private const int MaxFiles = 200;
    private const int MaxFileBytes = 512_000;
    private const int SnippetChars = 220;

    /// <summary>
    /// Best short paragraph from the folder that shares letters with the transcript.
    /// Null when the folder is empty, missing, or nothing is close enough.
    /// </summary>
    public static RagSnippet? FindSnippet(string transcript, string? folder)
    {
        if (string.IsNullOrWhiteSpace(transcript) || string.IsNullOrWhiteSpace(folder)) return null;
        if (!Directory.Exists(folder)) return null;
        string folded = Fold(transcript);
        var words = folded.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(Letters).Where(w => w.Length >= 3).Distinct().ToArray();
        if (words.Length == 0) return null;

        RagSnippet? best = null;
        double bestScore = 0;
        int bestOverlap = 0;
        foreach (var (path, text) in ReadFiles(folder))
        {
            foreach (var block in SplitBlocks(text))
            {
                string blockFold = Fold(block);
                string blockLetters = Letters(blockFold);
                if (blockLetters.Length < 8) continue;
                int overlap = 0;
                foreach (var w in words)
                {
                    if (blockFold.Contains(w, StringComparison.Ordinal) || SharedLetters(blockLetters, w) >= Math.Min(4, w.Length))
                        overlap += w.Length;
                }
                if (overlap < 4) continue;
                double score = overlap / (double)Math.Max(blockLetters.Length, folded.Replace(" ", "").Length);
                if (score < 0.08) continue;
                if (score < bestScore || (Math.Abs(score - bestScore) < 0.0001 && overlap <= bestOverlap)) continue;
                bestScore = score;
                bestOverlap = overlap;
                best = new RagSnippet(Clip(block.Trim(), SnippetChars), Path.GetFileName(path));
            }
        }
        return best;
    }

    /// <summary>
    /// Brand-like Latin tokens and Cyrillic neighbors from the same line.
    /// Suggestions are not applied; the caller shows them for the user to add.
    /// </summary>
    public static IReadOnlyList<DictSuggestion> SuggestDictionary(string? folder, IEnumerable<WordReplace.Pair> existing)
    {
        var list = new List<DictSuggestion>();
        if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder)) return list;
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in existing)
        {
            if (pair.From.Trim().Length > 0) taken.Add(pair.From.Trim());
            if (pair.To.Trim().Length > 0) taken.Add(pair.To.Trim());
        }

        foreach (var (path, text) in ReadFiles(folder))
        {
            string file = Path.GetFileName(path);
            foreach (var line in text.Split('\n'))
            {
                var latin = ExtractLatinBrands(line);
                var cyr = ExtractCyrillic(line);
                if (latin.Count == 0 || cyr.Count == 0) continue;
                foreach (var brand in latin)
                {
                    if (taken.Contains(brand)) continue;
                    foreach (var neighbor in cyr)
                    {
                        if (neighbor.Length < 3 || taken.Contains(neighbor)) continue;
                        // Same line only: Russian-looking neighbor -> Latin brand.
                        if (!NearEnough(neighbor, brand)) continue;
                        string key = neighbor + "->" + brand;
                        if (!taken.Add(key)) continue;
                        taken.Add(neighbor);
                        list.Add(new DictSuggestion(neighbor, brand, file));
                        if (list.Count >= 40) return list;
                        break;
                    }
                }
            }
        }
        return list;
    }

    private static IEnumerable<(string Path, string Text)> ReadFiles(string folder)
    {
        int n = 0;
        IEnumerable<string> paths;
        try
        {
            paths = Directory.EnumerateFiles(folder, "*.*", SearchOption.AllDirectories)
                .Where(p =>
                {
                    string ext = Path.GetExtension(p).ToLowerInvariant();
                    return ext is ".txt" or ".md" or ".markdown";
                })
                .Take(MaxFiles);
        }
        catch { yield break; }

        foreach (var path in paths)
        {
            if (++n > MaxFiles) yield break;
            string text;
            try
            {
                var info = new FileInfo(path);
                if (!info.Exists || info.Length == 0 || info.Length > MaxFileBytes) continue;
                text = File.ReadAllText(path);
            }
            catch { continue; }
            if (string.IsNullOrWhiteSpace(text)) continue;
            yield return (path, text);
        }
    }

    private static IEnumerable<string> SplitBlocks(string text)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0)
            {
                if (sb.Length > 0) { yield return sb.ToString(); sb.Clear(); }
                continue;
            }
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(line);
            if (sb.Length >= SnippetChars * 2)
            {
                yield return sb.ToString();
                sb.Clear();
            }
        }
        if (sb.Length > 0) yield return sb.ToString();
    }

    private static List<string> ExtractLatinBrands(string line)
    {
        var list = new List<string>();
        var sb = new System.Text.StringBuilder();
        void Flush()
        {
            if (sb.Length < 3) { sb.Clear(); return; }
            string t = sb.ToString();
            sb.Clear();
            bool hasUpper = t.Any(char.IsUpper);
            bool hasLetter = t.Any(char.IsLetter);
            if (!hasLetter) return;
            // Brand-like: CamelCase, ALLCAPS, or mixed with digits (SKU-ish Latin).
            if (!hasUpper && !t.Any(char.IsDigit)) return;
            if (t.All(char.IsDigit)) return;
            if (!list.Contains(t, StringComparer.Ordinal)) list.Add(t);
        }
        foreach (char c in line)
        {
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || char.IsDigit(c) || c is '-' or '_')
                sb.Append(c);
            else Flush();
        }
        Flush();
        return list;
    }

    private static List<string> ExtractCyrillic(string line)
    {
        var list = new List<string>();
        var sb = new System.Text.StringBuilder();
        void Flush()
        {
            if (sb.Length < 3) { sb.Clear(); return; }
            string t = sb.ToString();
            sb.Clear();
            if (!list.Contains(t, StringComparer.OrdinalIgnoreCase)) list.Add(t);
        }
        foreach (char c in line)
        {
            char lower = char.ToLowerInvariant(c == 'Ё' ? 'Е' : c == 'ё' ? 'е' : c);
            if (lower is >= 'а' and <= 'я') sb.Append(lower);
            else Flush();
        }
        Flush();
        return list;
    }

    /// <summary>Keep pairs that look related: shared letters or one looks like a translit of the other.</summary>
    private static bool NearEnough(string cyr, string latin)
    {
        string a = Letters(Fold(cyr));
        string b = Letters(Fold(TranslitHint(latin)));
        if (a.Length < 3 || b.Length < 3) return false;
        int share = SharedLetters(a, b);
        if (share >= 3 && share >= Math.Min(a.Length, b.Length) * 0.45) return true;
        // Same line already; accept a short Cyrillic gloss next to a brand (таптайн Taptain).
        return a.Length <= 12 && b.Length <= 16 && share >= 2;
    }

    private static string TranslitHint(string latin)
    {
        // Rough Latin→Cyrillic map so "Taptain" meets "таптайн" by letters.
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["ch"] = "ч", ["sh"] = "ш", ["zh"] = "ж", ["kh"] = "х", ["ts"] = "ц", ["ya"] = "я", ["yu"] = "ю",
            ["yo"] = "е", ["ye"] = "е", ["th"] = "т",
        };
        string s = latin.ToLowerInvariant();
        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < s.Length;)
        {
            bool hit = false;
            foreach (var (from, to) in map)
            {
                if (i + from.Length <= s.Length && s.AsSpan(i, from.Length).SequenceEqual(from.AsSpan()))
                {
                    sb.Append(to);
                    i += from.Length;
                    hit = true;
                    break;
                }
            }
            if (hit) continue;
            char c = s[i++];
            sb.Append(c switch
            {
                'a' => "а", 'b' => "б", 'c' => "к", 'd' => "д", 'e' => "е", 'f' => "ф",
                'g' => "г", 'h' => "х", 'i' => "и", 'j' => "дж", 'k' => "к", 'l' => "л",
                'm' => "м", 'n' => "н", 'o' => "о", 'p' => "п", 'q' => "к", 'r' => "р",
                's' => "с", 't' => "т", 'u' => "у", 'v' => "в", 'w' => "в", 'x' => "кс",
                'y' => "й", 'z' => "з", _ => c.ToString(),
            });
        }
        return sb.ToString();
    }

    private static string Clip(string text, int max)
    {
        if (text.Length <= max) return text;
        int cut = text.LastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        return text[..cut].TrimEnd() + "…";
    }

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
}
