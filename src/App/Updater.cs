// Manual update check against GitHub releases of zai-one/chawo-va.
// The app tells the user when a newer release exists and gives its page.
// It does not download or install the update.

using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ChawoVA.App;

public sealed class UpdateInfo
{
    [JsonPropertyName("version")] public string Version { get; set; } = "";
    [JsonPropertyName("url")] public string Url { get; set; } = "";
    [JsonPropertyName("sha256")] public string Sha256 { get; set; } = "";
    [JsonPropertyName("notes")] public string Notes { get; set; } = "";
    [JsonPropertyName("notes_en")] public string NotesEn { get; set; } = "";
    [JsonPropertyName("size")] public long Size { get; set; }
}

public static class Updater
{
    /// <summary>This repository only. Not the upstream repository.</summary>
    public const string ReleasesApi = "https://api.github.com/repos/zai-one/chawo-va/releases/latest";
    public const string ReleasesPage = "https://github.com/zai-one/chawo-va/releases";

    public static readonly TimeSpan CheckInterval = TimeSpan.FromHours(6);
    public static readonly TimeSpan FirstCheckDelay = TimeSpan.FromSeconds(45);
    private const long MaxInstallerBytes = 512L << 20;

    public static string UpdatesDir => Path.Combine(Settings.LocalDataDir, "updates");

    /// <summary>
    /// Asks GitHub for the latest non-draft release of zai-one/chawo-va.
    /// Returns it only when it is newer than this build. Does not download anything.
    /// Null means this build is current (or there is no release yet).
    /// </summary>
    public static async Task<UpdateInfo?> CheckAsync(CancellationToken ct)
    {
        using var http = NewClient();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        using var req = new HttpRequestMessage(HttpMethod.Get, ReleasesApi);
        req.Headers.TryAddWithoutValidation("Accept", "application/vnd.github+json");
        using var response = await http.SendAsync(req, cts.Token);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            return null;
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"GitHub answered {(int)response.StatusCode}");
        var json = await response.Content.ReadAsStringAsync(cts.Token);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.TryGetProperty("draft", out var draft) && draft.ValueKind == JsonValueKind.True) return null;
        if (root.TryGetProperty("prerelease", out var pre) && pre.ValueKind == JsonValueKind.True) return null;
        var tag = root.TryGetProperty("tag_name", out var tagEl) ? tagEl.GetString() ?? "" : "";
        var verText = tag.Trim().TrimStart('v', 'V');
        if (!Version.TryParse(verText, out var remote)) return null;
        if (!Version.TryParse(ChawoApp.Version, out var local))
            throw new InvalidOperationException("local version is not a number");
        Log.Write($"update check: local {local}, remote {remote} ({ReleasesApi})");
        if (remote <= local) return null;
        var html = root.TryGetProperty("html_url", out var urlEl) ? urlEl.GetString() ?? "" : "";
        const string allowed = "https://github.com/zai-one/chawo-va/";
        if (!html.StartsWith(allowed, StringComparison.OrdinalIgnoreCase))
            html = ReleasesPage + "/tag/v" + verText;
        var body = root.TryGetProperty("body", out var bodyEl) ? bodyEl.GetString() ?? "" : "";
        return new UpdateInfo { Version = verText, Url = html, Notes = body, NotesEn = body };
    }

    /// <summary>Downloads the installer next to the app data, verifies it, returns its path.</summary>
    public static async Task<string> DownloadAsync(UpdateInfo info, IProgress<(long received, long total)> progress, CancellationToken ct)
    {
        Directory.CreateDirectory(UpdatesDir);
        var path = Path.Combine(UpdatesDir, $"ChawoVoiceAssistant-Setup-{info.Version}.exe");
        var part = path + ".part";

        using var http = NewClient();
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        idle.CancelAfter(TimeSpan.FromSeconds(60));
        try
        {
            using var response = await http.GetAsync(info.Url, HttpCompletionOption.ResponseHeadersRead, idle.Token);
            response.EnsureSuccessStatusCode();
            long total = response.Content.Headers.ContentLength ?? info.Size;
            if (total > MaxInstallerBytes) throw new InvalidDataException("installer too large");

            await using (var net = await response.Content.ReadAsStreamAsync(idle.Token))
            await using (var file = File.Create(part))
            {
                var buffer = new byte[1 << 16];
                long received = 0;
                int n;
                while ((n = await net.ReadAsync(buffer, idle.Token)) > 0)
                {
                    idle.CancelAfter(TimeSpan.FromSeconds(60));
                    await file.WriteAsync(buffer.AsMemory(0, n), ct);
                    received += n;
                    if (received > MaxInstallerBytes) throw new InvalidDataException("installer too large");
                    progress.Report((received, total));
                }
            }

            await using (var check = File.OpenRead(part))
            {
                var actual = Convert.ToHexString(await SHA256.HashDataAsync(check, ct)).ToLowerInvariant();
                if (!string.Equals(actual, info.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("checksum mismatch");
            }
            File.Move(part, path, overwrite: true);
            return path;
        }
        finally
        {
            try { if (File.Exists(part)) File.Delete(part); } catch { }
        }
    }

    /// <summary>Runs the installer silently. It replaces the files and relaunches the app; we exit right after.</summary>
    public static void Install(string installerPath)
    {
        // Keep the user's autostart choice: the installer's task would otherwise reset it to "on".
        var tasks = Autostart.IsEnabled() ? "autostart" : "!autostart";
        var psi = new System.Diagnostics.ProcessStartInfo(installerPath)
        {
            Arguments = $"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /MERGETASKS=\"{tasks}\"",
            UseShellExecute = true,
        };
        System.Diagnostics.Process.Start(psi);
    }

    /// <summary>Removes downloaded installers from earlier updates.</summary>
    public static void Cleanup()
    {
        try
        {
            if (!Directory.Exists(UpdatesDir)) return;
            foreach (var f in Directory.GetFiles(UpdatesDir)) File.Delete(f);
        }
        catch { }
    }

    private static HttpClient NewClient()
    {
        var handler = new SocketsHttpHandler { DefaultProxyCredentials = System.Net.CredentialCache.DefaultCredentials };
        var http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("ChawoVoiceAssistant/" + ChawoApp.Version + " (Windows)");
        http.DefaultRequestHeaders.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true };
        return http;
    }
}
