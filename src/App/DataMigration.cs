// First start of 1.17.0: the data folders got the product's name.
//
//   %LOCALAPPDATA%\GigaPisar  ->  %LOCALAPPDATA%\ChawoVoiceAssistant   (models, brain, logs)
//   %APPDATA%\GigaPisar       ->  %APPDATA%\ChawoVoiceAssistant        (settings.json: dictionary, catalog, keys)
//
// Runs only when the new folder does not exist and the old one does. Local data is moved
// (same volume, so gigabytes of weights are not copied and not downloaded again); a file that
// cannot be moved (the old app still has it open) is copied instead. Roaming settings are copied,
// so the old version keeps working if someone goes back to it (model folders there are
// not copied; SpeechModelStore still finds them in place).
// Everything goes into "<new>.migrating" first and is renamed at the end, so an interrupted
// run is simply continued on the next start.

namespace ChawoVA.App;

public static class DataMigration
{
    /// <summary>Folder name used by versions before 1.17.0 (and by the upstream app).</summary>
    private const string LegacyFolderName = "GigaPisar";

    /// <summary>Program EXE names, current and before 1.17.0. A folder holding one of them is never deleted.</summary>
    public static readonly string[] ProgramExeNames = ["ChawoVoiceAssistant.exe", LegacyFolderName + ".exe"];

    public static string LegacyLocalDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), LegacyFolderName);
    public static string LegacyRoamingDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), LegacyFolderName);

    private static readonly List<string> Pending = new();

    /// <summary>Testing variables: CHAWO_&lt;name&gt;, or the PISAR_&lt;name&gt; spelling of versions before 1.17.0.</summary>
    public static string? Env(string name) =>
        Environment.GetEnvironmentVariable("CHAWO_" + name) is { Length: > 0 } v ? v
        : Environment.GetEnvironmentVariable("PISAR_" + name);

    public static void Run()
    {
        try { Migrate(LegacyLocalDir, Settings.LocalDataDir, move: true); }
        catch (Exception e) { Pending.Add($"migrate local failed: {e.Message}"); }
        try { Migrate(LegacyRoamingDir, Settings.AppDataDir, move: false); }
        catch (Exception e) { Pending.Add($"migrate roaming failed: {e.Message}"); }
    }

    /// <summary>Writes what the migration did to the new log, once logging is safe.</summary>
    public static void FlushLog()
    {
        foreach (var line in Pending) Log.Write(line);
        Pending.Clear();
    }

    private static void Migrate(string oldDir, string newDir, bool move)
    {
        if (Directory.Exists(newDir) || !Directory.Exists(oldDir)) return;
        if (string.Equals(Path.GetFullPath(oldDir), Path.GetFullPath(newDir), StringComparison.OrdinalIgnoreCase)) return;
        var staging = newDir + ".migrating";
        Directory.CreateDirectory(staging);
        int failed = 0;
        CopyTree(oldDir, staging, move, ref failed);
        RewriteOldPaths(Path.Combine(staging, "settings.json"));
        Directory.Move(staging, newDir);
        if (move) TryRemoveEmpty(oldDir);
        Pending.Add($"migrated {oldDir} -> {newDir} ({(move ? "move" : "copy")}, {failed} item(s) left behind)");
    }

    private static void CopyTree(string from, string to, bool move, ref int failed)
    {
        Directory.CreateDirectory(to);
        foreach (var file in Directory.EnumerateFiles(from))
        {
            var dest = Path.Combine(to, Path.GetFileName(file));
            if (File.Exists(dest)) continue;   // taken by an earlier, interrupted run
            try
            {
                if (move)
                {
                    try { File.Move(file, dest); continue; }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
                File.Copy(file, dest);
            }
            catch (Exception e)
            {
                failed++;
                try { if (File.Exists(dest)) File.Delete(dest); } catch { }
                Pending.Add($"migrate: {file}: {e.Message}");
            }
        }
        foreach (var dir in Directory.EnumerateDirectories(from))
        {
            var name = Path.GetFileName(dir);
            // Roaming is copied, not moved: weights that ended up there stay put and are found by
            // SpeechModelStore's legacy search, instead of copying gigabytes at startup.
            if (!move && (name.Equals("model", StringComparison.OrdinalIgnoreCase) || name.Equals("models", StringComparison.OrdinalIgnoreCase)))
                continue;
            var dest = Path.Combine(to, name);
            if (move && !Directory.Exists(dest))
            {
                try { Directory.Move(dir, dest); continue; }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            CopyTree(dir, dest, move, ref failed);
            if (move) TryRemoveEmpty(dir);
        }
    }

    /// <summary>An absolute path into the old local folder inside settings.json now points at the new one.</summary>
    private static void RewriteOldPaths(string settingsPath)
    {
        try
        {
            if (!File.Exists(settingsPath)) return;
            var text = File.ReadAllText(settingsPath);
            string Json(string p) => p.Replace("\\", "\\\\");
            var updated = text
                .Replace(Json(LegacyLocalDir) + "\\\\", Json(Settings.LocalDataDir) + "\\\\", StringComparison.OrdinalIgnoreCase)
                .Replace(Json(LegacyRoamingDir) + "\\\\", Json(Settings.AppDataDir) + "\\\\", StringComparison.OrdinalIgnoreCase);
            if (updated != text) File.WriteAllText(settingsPath, updated);
        }
        catch (Exception e) { Pending.Add($"migrate: settings paths: {e.Message}"); }
    }

    private static void TryRemoveEmpty(string dir)
    {
        try
        {
            if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any())
                Directory.Delete(dir);
        }
        catch { }
    }
}
