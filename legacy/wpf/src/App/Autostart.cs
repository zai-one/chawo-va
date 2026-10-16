// "Start with Windows" through the per-user Run key. No admin rights needed.

using Microsoft.Win32;

namespace ChawoVA.App;

public static class Autostart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "ChawoVoiceAssistant";
    /// <summary>Run-key value written before 1.17.0.</summary>
    private const string LegacyValueName = "GigaPisar";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(ValueName) is string;
    }

    public static void Set(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (key == null) return;
        if (enabled)
            key.SetValue(ValueName, $"\"{Environment.ProcessPath}\"");
        else
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        key.DeleteValue(LegacyValueName, throwOnMissingValue: false);
    }

    /// <summary>
    /// Before 1.17.0 the value had the old name and pointed at the old EXE. If the user had
    /// "start with Windows" on, keep it on for this EXE and drop the old value.
    /// </summary>
    public static void MigrateLegacy()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            if (key?.GetValue(LegacyValueName) is not string) return;
            key.SetValue(ValueName, $"\"{Environment.ProcessPath}\"");
            key.DeleteValue(LegacyValueName, throwOnMissingValue: false);
            Log.Write("autostart: legacy Run value moved to the new name");
        }
        catch (Exception e) { Log.Write($"autostart migrate failed: {e.Message}"); }
    }
}
