// Finds GigaAM weights that are already on disk so a second download is not started.
//
// This fork keeps a model in %LOCALAPPDATA%\GigaPisar\models\<id>.
// The original Giga Pisar (1.0.x) keeps v3 in %LOCALAPPDATA%\GigaPisar\model.
// A portable copy may sit next to the EXE (model\, models\<id>\, or the EXE folder).
// Roaming %APPDATA%\GigaPisar is checked too, in case a build wrote there.
// The first folder that contains every required file, at a size that is not a
// stub or a half-finished download, is used as-is. Nothing is copied and nothing
// is downloaded.

using GigaPisar.Core;

namespace GigaPisar.App;

public static class SpeechModelStore
{
    public static string CanonicalDirectory(SpeechModelKind kind) => Settings.ModelDirectory(kind);

    /// <summary>Directory of a complete copy, or null when this model has to be downloaded.</summary>
    public static string? FindComplete(SpeechModelKind kind)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var dir in CandidateDirectories(kind))
        {
            string full;
            try { full = Path.GetFullPath(dir); }
            catch { continue; }
            if (!seen.Add(full)) continue;
            if (LooksComplete(full, kind)) return full;
        }
        return null;
    }

    public static bool LooksComplete(string dir, SpeechModelKind kind)
    {
        try
        {
            if (!Recognizer.ModelExists(dir, kind)) return false;
            if (kind == SpeechModelKind.V3E2eRnnt)
            {
                return Big(dir, "v3_e2e_rnnt_encoder.onnx", 20L << 20)
                    && Big(dir, "v3_e2e_rnnt_decoder.onnx", 100L << 10)
                    && Big(dir, "v3_e2e_rnnt_joint.onnx", 100L << 10)
                    && Big(dir, "v3_e2e_rnnt_tokenizer.model", 10L << 10)
                    && Big(dir, "v3_e2e_rnnt.yaml", 100);
            }
            // The fp32 graph's external data is 2.34 GB. Anything under 2 GB is a partial download.
            return Big(dir, "multilingual_large_ctc.onnx", 500L << 10)
                && Big(dir, "multilingual_large_ctc.onnx.data", 2_000_000_000L)
                && Big(dir, "multilingual_large_ctc.yaml", 200)
                && Big(dir, "multilingual_vocab.txt", 50);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Short Russian/English list of the places startup looks, for the settings window.</summary>
    public static string SearchSummary()
    {
        string local = Settings.LocalDataDir;
        string roaming = Settings.AppDataDir;
        string exe = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return string.Join("\n", new[]
        {
            Path.Combine(local, "models"),
            Path.Combine(local, "model"),
            Path.Combine(roaming, "models"),
            Path.Combine(roaming, "model"),
            Path.Combine(exe, "models"),
            Path.Combine(exe, "model"),
            exe,
        });
    }

    private static bool Big(string dir, string name, long minBytes)
    {
        var info = new FileInfo(Path.Combine(dir, name));
        return info.Exists && info.Length >= minBytes;
    }

    private static IEnumerable<string> CandidateDirectories(SpeechModelKind kind)
    {
        string folder = SpeechModels.Folder(kind);
        string local = Settings.LocalDataDir;
        string roaming = Settings.AppDataDir;
        string exe = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        // Canonical fork layout first, then the original app's single folder.
        yield return Path.Combine(local, "models", folder);
        yield return Path.Combine(local, "model");
        yield return Path.Combine(local, "models");
        yield return local;

        yield return Path.Combine(roaming, "models", folder);
        yield return Path.Combine(roaming, "model");
        yield return Path.Combine(roaming, "models");
        yield return roaming;

        yield return Path.Combine(exe, "models", folder);
        yield return Path.Combine(exe, "model");
        yield return Path.Combine(exe, "models");
        yield return Path.Combine(exe, folder);
        yield return exe;

        var parent = Path.GetDirectoryName(exe);
        if (!string.IsNullOrEmpty(parent))
        {
            yield return Path.Combine(parent, "models", folder);
            yield return Path.Combine(parent, "model");
            yield return Path.Combine(parent, "models");
            yield return parent;
        }

        if (Environment.GetEnvironmentVariable("PISAR_MODEL_DIR") is { Length: > 0 } env)
            yield return env;

        // One level down: a manual unzip often wraps the files in a single folder.
        foreach (var root in new[]
                 {
                     Path.Combine(local, "models"), Path.Combine(local, "model"), local,
                     Path.Combine(roaming, "models"), Path.Combine(roaming, "model"),
                     Path.Combine(exe, "models"), Path.Combine(exe, "model"), exe,
                 })
        {
            if (!Directory.Exists(root)) continue;
            IEnumerable<string> children;
            try { children = Directory.EnumerateDirectories(root); }
            catch { continue; }
            foreach (var child in children)
                yield return child;
        }
    }
}
