// Finds GigaAM weights that are already on disk so a second download is not started.
//
// The app keeps a model in %LOCALAPPDATA%\ChawoVoiceAssistant\models\<id>.
// Folders of versions before 1.17.0 (see DataMigration.Legacy*) are still searched,
// in case the first-start move could not take everything.
// A portable copy may sit next to the EXE (model\, models\<id>\, or the EXE folder).
// Roaming %APPDATA%\ChawoVoiceAssistant is checked too, in case a build wrote there.
// The first folder that contains every required file, at a size that is not a
// stub or a half-finished download, is used as-is. Nothing is copied and nothing
// is downloaded.

using ChawoVA.Core;

namespace ChawoVA.App;

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

        if (DataMigration.Env("MODEL_DIR") is { Length: > 0 } env)
            yield return env;

        // Data folders of versions before 1.17.0, if the first-start move left anything behind.
        foreach (var legacy in new[] { DataMigration.LegacyLocalDir, DataMigration.LegacyRoamingDir })
        {
            yield return Path.Combine(legacy, "models", folder);
            yield return Path.Combine(legacy, "model");
        }

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

    /// <summary>Russian label for the per-model delete button.</summary>
    public static string DeleteButtonLabel(SpeechModelKind kind) => kind switch
    {
        SpeechModelKind.V3E2eRnnt => "Удалить русскую модель v3",
        _ => "Удалить большую модель, 2,4 ГБ",
    };

    public static bool HasDeletable(SpeechModelKind kind) => DeletableTargets(kind).Count > 0;

    /// <summary>
    /// Copies under %LOCALAPPDATA%\ChawoVoiceAssistant only. Never the program folder and never a directory
    /// that contains the program EXE. A folder that holds only this model's files is removed whole;
    /// otherwise only those files are listed.
    /// </summary>
    public static IReadOnlyList<string> DeletableTargets(SpeechModelKind kind)
    {
        var root = Path.GetFullPath(Settings.LocalDataDir);
        var list = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Add(string path)
        {
            string full;
            try { full = Path.GetFullPath(path); }
            catch { return; }
            if (!seen.Add(full)) return;
            if (!IsUnder(full, root)) return;
            var dir = Directory.Exists(full) ? full : Path.GetDirectoryName(full);
            if (dir != null && DataMigration.ProgramExeNames.Any(n => File.Exists(Path.Combine(dir, n)))) return;
            list.Add(full);
        }

        void ConsiderDirectory(string dir)
        {
            if (!Directory.Exists(dir)) return;
            string full;
            try { full = Path.GetFullPath(dir); }
            catch { return; }
            if (!IsUnder(full, root) || string.Equals(full, root, StringComparison.OrdinalIgnoreCase)) return;
            if (DataMigration.ProgramExeNames.Any(n => File.Exists(Path.Combine(full, n)))) return;
            if (!DirectoryHasModelBits(full, kind) && !LooksComplete(full, kind)) return;
            if (OnlyThisModel(full, kind))
                Add(full);
            else
            {
                foreach (var name in FilesOf(kind))
                {
                    var file = Path.Combine(full, name);
                    if (File.Exists(file)) Add(file);
                }
            }
        }

        ConsiderDirectory(Settings.ModelDirectory(kind));
        ConsiderDirectory(Settings.ModelDirectory(kind) + ".tmp");
        ConsiderDirectory(Path.Combine(root, "model"));
        var models = Path.Combine(root, "models");
        if (Directory.Exists(models))
        {
            foreach (var child in Directory.EnumerateDirectories(models))
                ConsiderDirectory(child);
        }
        if (kind == SpeechModelKind.V3E2eRnnt)
        {
            var part = Path.Combine(root, "model.tar.gz.part");
            if (File.Exists(part)) Add(part);
        }
        return list;
    }

    /// <summary>Deletes <see cref="DeletableTargets"/>. Throws if any path could not be removed.</summary>
    public static void DeleteInstalled(SpeechModelKind kind)
    {
        var errors = new List<string>();
        foreach (var target in DeletableTargets(kind).OrderByDescending(t => t.Length))
        {
            try
            {
                if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
                else if (File.Exists(target)) File.Delete(target);
            }
            catch (Exception e)
            {
                errors.Add(e.Message);
                Log.Write($"speech model delete failed: {target}: {e.Message}");
            }
        }
        if (errors.Count > 0) throw new IOException(string.Join("\n", errors));
    }

    private static bool IsUnder(string full, string root)
    {
        var rel = Path.GetRelativePath(root, full);
        return rel != ".." && !rel.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) && !Path.IsPathRooted(rel);
    }

    private static string[] FilesOf(SpeechModelKind kind) => kind == SpeechModelKind.V3E2eRnnt
        ? ["v3_e2e_rnnt_encoder.onnx", "v3_e2e_rnnt_decoder.onnx", "v3_e2e_rnnt_joint.onnx", "v3_e2e_rnnt_tokenizer.model", "v3_e2e_rnnt.yaml"]
        : ["multilingual_large_ctc.onnx", "multilingual_large_ctc.onnx.data", "multilingual_large_ctc.yaml", "multilingual_vocab.txt"];

    private static bool DirectoryHasModelBits(string dir, SpeechModelKind kind)
    {
        try
        {
            foreach (var name in FilesOf(kind))
            {
                var info = new FileInfo(Path.Combine(dir, name));
                if (info.Exists && info.Length > 0) return true;
            }
        }
        catch { }
        return false;
    }

    private static bool OnlyThisModel(string dir, SpeechModelKind kind)
    {
        try
        {
            var allowed = new HashSet<string>(FilesOf(kind), StringComparer.OrdinalIgnoreCase);
            foreach (var file in Directory.EnumerateFiles(dir))
                if (!allowed.Contains(Path.GetFileName(file))) return false;
            if (Directory.EnumerateDirectories(dir).Any()) return false;
            return DirectoryHasModelBits(dir, kind);
        }
        catch { return false; }
    }

}
