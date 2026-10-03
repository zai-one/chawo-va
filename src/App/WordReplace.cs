// Spoken brand words the neural vocab will not spell. Applied to the finished
// phrase only, after recognition (and after simple syntax), never to the live draft.
// One rule per line: "как слышится -> как писать". Matching is whole-word and
// ignores case, so "Цпу" and "цпу" both become CPU. The list is short; this does
// not re-run the model.

using System.Text.RegularExpressions;

namespace GigaPisar.App;

public static class WordReplace
{
    public const string DefaultRules =
        "цпу -> CPU\n" +
        "сипиу -> CPU\n" +
        "гпу -> GPU\n" +
        "джипию -> GPU\n" +
        "таптейн -> Taptain\n" +
        "таптэйн -> Taptain\n" +
        "чаво -> Chawo\n";

    private static readonly object Gate = new();
    private static string _cachedRules = "\u0000";
    private static (Regex re, string to)[] _cached = [];

    public static string Apply(string text, string? rules)
    {
        if (string.IsNullOrEmpty(text) || string.IsNullOrWhiteSpace(rules)) return text;
        foreach (var (re, to) in Rules(rules))
            text = re.Replace(text, _ => to);
        return text;
    }

    private static (Regex re, string to)[] Rules(string rules)
    {
        lock (Gate)
        {
            if (rules == _cachedRules) return _cached;
            var list = new List<(int len, Regex re, string to)>();
            foreach (var raw in rules.Split('\n'))
            {
                var line = raw.Trim().TrimEnd('\r');
                if (line.Length == 0 || line.StartsWith('#')) continue;
                int cut = line.IndexOf("->", StringComparison.Ordinal);
                int width = 2;
                if (cut < 0) { cut = line.IndexOf("=>", StringComparison.Ordinal); width = 2; }
                if (cut < 0) { cut = line.IndexOf('='); width = 1; }
                if (cut <= 0) continue;
                var from = line[..cut].Trim();
                var to = line[(cut + width)..].Trim();
                if (from.Length == 0 || to.Length == 0) continue;
                var re = new Regex(
                    $@"(?<![\p{{L}}\p{{N}}_\-]){Regex.Escape(from)}(?![\p{{L}}\p{{N}}_\-])",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
                list.Add((from.Length, re, to));
            }
            _cached = list.OrderByDescending(x => x.len).Select(x => (x.re, x.to)).ToArray();
            _cachedRules = rules;
            return _cached;
        }
    }
}
