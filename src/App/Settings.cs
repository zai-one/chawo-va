// User settings stored as JSON in %APPDATA%\GigaPisar\settings.json.

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using GigaPisar.Core;

namespace GigaPisar.App;

public enum InsertMode { Type, Paste }

public sealed class Settings
{
    public const int LeftCtrlWinHotkey = 0x10000;

    /// <summary>Virtual-key code of the push-to-talk key. Default: right Ctrl.</summary>
    public int HotkeyVk { get; set; } = 0xA3;
    public InsertMode InsertMode { get; set; } = InsertMode.Paste;
    public bool ShowOverlay { get; set; } = true;
    /// <summary>
    /// After the final phrase is ready, also put it on the clipboard.
    /// Off unless the settings file says true. A missing key is false, not the old implicit on.
    /// </summary>
    public bool CopyPhraseToClipboard { get; set; } = false;
    /// <summary>
    /// After that copy, put the previous clipboard back, but only when the phrase stays in
    /// Windows clipboard history (Win+V). On by default. If history is off or the phrase would
    /// disappear from it, the phrase stays as the current clipboard.
    /// </summary>
    public bool RestoreClipboardAfterCopy { get; set; } = true;
    public bool KeepLastRecording { get; set; } = false;
    public bool FirstRunDone { get; set; } = false;
    public UiLanguage Language { get; set; } = UiLanguage.Auto;
    /// <summary>Kept for old settings files. Nothing reads this on a timer. Updates are a manual button against this fork.</summary>
    public bool CheckUpdates { get; set; } = false;
    /// <summary>Where the Brain thinks; Off by default.</summary>
    public BrainSource Brain { get; set; } = BrainSource.Off;
    /// <summary>Which GigaAM weights to run. Nothing is downloaded until the user asks.</summary>
    public SpeechModelKind SpeechModel { get; set; } = SpeechModelKind.V3E2eRnnt;
    /// <summary>Video card (DirectML) or CPU. GPU falls back to CPU if DirectML cannot start.</summary>
    public SpeechDeviceKind SpeechDevice { get; set; } = SpeechDeviceKind.Gpu;
    /// <summary>CPU intra-op threads. 0 means every logical processor. Not applied to a DirectML session.</summary>
    public int CpuThreads { get; set; }
    /// <summary>WASAPI capture endpoint id. Empty is the Windows default input device.</summary>
    public string MicrophoneId { get; set; } = "";
    /// <summary>Where the local llama.cpp brain runs. Cpu is the original engine. Gpu downloads the Vulkan build.</summary>
    public BrainDeviceKind BrainDevice { get; set; } = BrainDeviceKind.Cpu;

    /// <summary>
    /// Letter script for the large CTC model. Auto keeps Latin when the model already wrote Latin,
    /// and only replaces Cyrillic when a Latin-only argmax is close. v3 ignores this. Default Auto.
    /// </summary>
    public CtcScript CtcScript { get; set; } = CtcScript.Auto;
    /// <summary>Hermes accepts connections from the LAN (0.0.0.0). Off until the user opens the firewall port.</summary>
    public bool HermesOnLan { get; set; }
    /// <summary>While the Hermes listener is running, ask Windows not to idle-sleep. Off by default.</summary>
    public bool KeepAwakeWhileListening { get; set; }
    /// <summary>Send every take through the Brain, not only those ending with "Pisar, …".</summary>
    public bool BrainEveryTake { get; set; }
    /// <summary>With text selected at the key press, the take is a command on the selection. On by default, as on macOS.</summary>
    public bool BrainOnSelection { get; set; } = true;
    /// <summary>Which GGUF the local brain runs. Nothing is downloaded until the Brain tab button.</summary>
    public LocalBrainKind BrainModel { get; set; } = LocalBrainKind.Qwen3;
    /// <summary>Hugging Face link to a .gguf. Used only when <see cref="BrainModel"/> is Custom.</summary>
    public string BrainCustomUrl { get; set; } = "";
    /// <summary>
    /// Extra system prompt for the local brain only. Empty means the built-in editing rules.
    /// Cloud brains, including Xiaomi, do not receive this, so an empty or filled box cannot change them.
    /// </summary>
    public string BrainInstruction { get; set; } = "";
    /// <summary>A single dictated sentence goes in lowercase and without the closing period, like a chat reply.</summary>
    public bool SimpleSyntax { get; set; }
    /// <summary>One "heard -> written" rule per line. Empty uses <see cref="WordReplace.DefaultRules"/>. "#" means the user cleared the dictionary. Applied after recognition, before the Brain, not to the live draft.</summary>
    public string WordReplacementRules { get; set; } = "";

    /// <summary>Read-only migration from 1.0.3, where the server Brain had a single on/off switch and cleaned every take.</summary>
    [JsonPropertyName("CleanupEnabled")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? LegacyCleanupEnabled
    {
        get => null;
        set { if (value == true && Brain == BrainSource.Off) { Brain = BrainSource.Server; BrainEveryTake = true; } }
    }
    public string CleanupEndpointUrl { get; set; } = "";
    /// <summary>Plain API key in memory only; on disk it lives in <see cref="CleanupApiKeyProtected"/>.</summary>
    [JsonIgnore]
    public string CleanupApiKey { get; set; } = "";

    /// <summary>API key encrypted with DPAPI for the current Windows user (base64).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? CleanupApiKeyProtected
    {
        get => CleanupApiKey.Length == 0 ? null : Protect(CleanupApiKey);
        set => CleanupApiKey = Unprotect(value);
    }

    /// <summary>Read-only migration of a plain-text key written by the first cleanup build.</summary>
    [JsonPropertyName("CleanupApiKey")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LegacyCleanupApiKey
    {
        get => null;
        set
        {
            if (string.IsNullOrEmpty(value)) return;
            if (CleanupApiKey.Length == 0) CleanupApiKey = value;
            _plainKeyOnDisk = true;
        }
    }
    public string CleanupModel { get; set; } = "";

    /// <summary>
    /// A key for every cloud service (by provider id), so switching services keeps each key, as on
    /// macOS 3.9 and Android. In memory only; on disk each one is encrypted like <see cref="CleanupApiKeyProtected"/>,
    /// which still holds the active key, so an older version finds it after a rollback.
    /// </summary>
    [JsonIgnore]
    public Dictionary<string, string> ProviderKeys { get; set; } = new();

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? ProviderKeysProtected
    {
        get => ProviderKeys.Count == 0 ? null
            : ProviderKeys.Where(kv => kv.Value.Length > 0).ToDictionary(kv => kv.Key, kv => Protect(kv.Value));
        set => ProviderKeys = value == null ? new()
            : value.Select(kv => (kv.Key, Value: Unprotect(kv.Value))).Where(kv => kv.Value.Length > 0)
                   .ToDictionary(kv => kv.Key, kv => kv.Value);
    }

    /// <summary>The model last chosen for every service.</summary>
    public Dictionary<string, string> ProviderModels { get; set; } = new();
    /// <summary>Own "every take" instructions; empty means our default in the interface language.</summary>
    public string CleanupPrompt { get; set; } = "";
    [JsonIgnore]
    public string EffectiveCleanupPrompt => CleanupPrompt.Trim().Length == 0 || SpeechCleanup.IsDefaultPrompt(CleanupPrompt)
        ? SpeechCleanup.DefaultPrompt : CleanupPrompt;

    /// <summary>Blank rules mean the built-in list, so an old settings file still gets them. "#" means the user cleared the dictionary.</summary>
    public string EffectiveWordReplacementRules =>
        string.IsNullOrWhiteSpace(WordReplacementRules) ? WordReplace.DefaultRules : WordReplacementRules;

    public WordReplace.Pair[] DictionaryRows =>
        string.IsNullOrWhiteSpace(WordReplacementRules) ? WordReplace.Parse(WordReplace.DefaultRules)
        : WordReplace.Parse(WordReplacementRules);

    public void SaveDictionary(IReadOnlyList<WordReplace.Pair> rows)
    {
        var kept = rows.Where(r => r.From.Trim().Length > 0 || r.To.Trim().Length > 0).ToArray();
        WordReplacementRules = kept.Length == 0 ? "#" : WordReplace.Format(kept);
    }

    /// <summary>Where the user dragged the overlay to (screen pixels, window top-left); null means "follow the caret".</summary>
    public int? OverlayX { get; set; }
    public int? OverlayY { get; set; }

    public static string AppDataDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "GigaPisar");
    public static string LocalDataDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GigaPisar");
    public static string ModelDirectory(SpeechModelKind kind) =>
        Path.Combine(LocalDataDir, "models", SpeechModels.Folder(kind));
    public static string SettingsPath => Path.Combine(AppDataDir, "settings.json");
    public static string LogPath => Path.Combine(LocalDataDir, "pisar.log");
    public static string LastTakePath => Path.Combine(LocalDataDir, "last.wav");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    [JsonIgnore]
    private bool _plainKeyOnDisk;

    public static Settings Load()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsPath), JsonOptions) ?? new Settings();
                // Up to 1.0.6 there was one key for everything: it belongs to the service that was set up.
                if (s.ProviderKeys.Count == 0 && s.CleanupApiKey.Length > 0)
                {
                    var id = (s.CleanupEndpointUrl.Length > 0 ? BrainProviders.FromUrl(s.CleanupEndpointUrl) : BrainProviders.DeepSeek).Id;
                    s.ProviderKeys[id] = s.CleanupApiKey;
                    if (s.CleanupModel.Length > 0) s.ProviderModels[id] = s.CleanupModel;
                    s._plainKeyOnDisk = true;   // write the new layout at once
                }
                if (s._plainKeyOnDisk) s.Save();   // the plain-text key from 1.0.3 leaves the disk at once, encrypted
                s.CheckUpdates = false;
                // The only switch was removed from the window. Do not keep the PC awake with no way to turn it off.
                if (s.KeepAwakeWhileListening)
                {
                    s.KeepAwakeWhileListening = false;
                    s.Save();
                }
                return s;
            }
        }
        catch (Exception e) { Log.Write($"settings load failed: {e.Message}"); }
        return new Settings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(AppDataDir);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(this, JsonOptions));
        }
        catch (Exception e) { Log.Write($"settings save failed: {e.Message}"); }
    }

    private static readonly byte[] KeyEntropy = Encoding.UTF8.GetBytes("GigaPisar.CleanupApiKey");

    private static string Protect(string plain) =>
        Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), KeyEntropy, DataProtectionScope.CurrentUser));

    private static string Unprotect(string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return "";
        try
        {
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(stored), KeyEntropy, DataProtectionScope.CurrentUser));
        }
        catch (Exception e)
        {
            // Another user or machine: the key cannot be recovered, ask for it again.
            Log.Write($"api key unprotect failed: {e.GetType().Name}");
            return "";
        }
    }

    public static readonly (int vk, string ru, string en)[] HotkeyChoices =
    {
        (0xA3, "Правый Ctrl", "Right Ctrl"),
        (LeftCtrlWinHotkey, "Левый Ctrl + Win", "Left Ctrl + Win"),
        (0xA5, "Правый Alt", "Right Alt"),
        (0xA1, "Правый Shift", "Right Shift"),
        (0x14, "Caps Lock", "Caps Lock"),
        (0x91, "Scroll Lock", "Scroll Lock"),
        (0x2D, "Insert", "Insert"),
    };

    public static string HotkeyTitle(int vk)
    {
        foreach (var (k, ru, en) in HotkeyChoices) if (k == vk) return L.T(ru, en);
        return L.T($"клавиша {vk:X2}", $"key {vk:X2}");
    }
}

public static class Log
{
    private static readonly object Gate = new();

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Settings.LocalDataDir);
                var fi = new FileInfo(Settings.LogPath);
                if (fi.Exists && fi.Length > 1_000_000) fi.MoveTo(Settings.LogPath + ".1", overwrite: true);
                File.AppendAllText(Settings.LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
        }
        catch { /* logging must never break the app */ }
    }
}
