// The Brain on this computer: llama.cpp's llama-server with a small Qwen model,
// the same pair the macOS app uses. Nothing goes online except the one-time
// download of the engine (~18 MB) and the model (~2 GB), both pinned by SHA-256.
//
// The server starts on the first command (a couple of seconds on a fast CPU,
// longer on a laptop), listens on a random loopback port with a random API key,
// and is stopped after 15 idle minutes because it holds ~2.5 GB of memory.
// It lives in a job object, so it dies together with Pisar even on a crash.

using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace GigaPisar.App;

public enum LocalBrainKind { Qwen3, Qwen35, Custom }

/// <summary>Where llama.cpp runs. Gpu is the official b10701 Windows Vulkan build, not a label.</summary>
public enum BrainDeviceKind { Cpu, Gpu }

public static class LocalBrain
{
    /// <summary>
    /// Whether "on this computer" is offered in the menus. On since 1.0.7, when the model got
    /// its mirror on GitHub (the brain-models release): from Russia Hugging Face crawls.
    /// </summary>
    public const bool Offered = true;

    public const string EngineTag = "b10701";
    private const string EngineUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b10701/llama-b10701-bin-win-cpu-x64.zip";
    private const string EngineSha256 = "84ecf626a9893a7701a5883480b06fb91043ee9cb76de10c5aaeea43cfc7c680";
    /// <summary>Same llama.cpp tag, Vulkan build. RTX 3070 uses it through the NVIDIA Vulkan driver. Not bundled in the app zip.</summary>
    private const string VulkanUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b10701/llama-b10701-bin-win-vulkan-x64.zip";
    private const string VulkanSha256 = "ea3524895529aff485ec3d8da477d654f9cc4375cb9e6651793daaca7208daf2";

    public const string ModelTitle = "Qwen3 4B";
    public const string ModelFile = "Qwen3-4B-Instruct-2507-Q3_K_M.gguf";
    /// <summary>Our GitHub mirror first (fast from Russia, where Hugging Face is slow or blocked), then the original.</summary>
    private static readonly string[] Qwen3Urls =
    {
        "https://github.com/moznoazachem/giga-pisar-win/releases/download/brain-models/Qwen3-4B-Instruct-2507-Q3_K_M.gguf",
        "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q3_K_M.gguf",
    };
    private const string Qwen3Sha256 = "9c6e0763577125a994a9bea0bbd7a737ac4498b8a6a4e0f788727553af1806c9";
    public const long Qwen3Bytes = 2_075_618_400;

    /// <summary>Qwen3.5 thinks unless llama-server is told not to. Same role as Qwen3 4B, newer weights.</summary>
    public const string Qwen35File = "Qwen3.5-4B-Q3_K_M.gguf";
    public const long Qwen35Bytes = 2_293_388_448;
    private const string Qwen35Sha256 = "d6981ab4d77ba712b48ef69d69042d75b5e39b9dce5fb5a5b054fd08e06afb95";
    private const string Qwen35Url = "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q3_K_M.gguf";

    /// <summary>A pasted GGUF larger than this is refused. It is never executed as a program.</summary>
    private const long MaxCustomBytes = 16L << 30;


    /// <summary>Below this much RAM the Brain would crowd everything else out; we say so before downloading.</summary>
    public const ulong RecommendedRamBytes = 8UL << 30;
    private const int ContextTokens = 2048;
    private static readonly TimeSpan IdleStop = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan DownloadIdleTimeout = TimeSpan.FromSeconds(60);

    public static string Dir => Path.Combine(Settings.LocalDataDir, "brain");
    private static string EngineDirFor(BrainDeviceKind kind) =>
        Path.Combine(Dir, kind == BrainDeviceKind.Gpu ? "engine-" + EngineTag + "-vulkan" : "engine-" + EngineTag);
    private static string ServerExeFor(BrainDeviceKind kind) => Path.Combine(EngineDirFor(kind), "llama-server.exe");
    private static string EngineDir => EngineDirFor(BrainDeviceKind.Cpu);
    private static string ServerExe => ServerExeFor(BrainDeviceKind.Cpu);
    public static string LogPath => Path.Combine(Settings.LocalDataDir, "brain.log");

    public static string Title(Settings s) => s.BrainModel switch
    {
        LocalBrainKind.Qwen35 => "Qwen3.5 4B",
        LocalBrainKind.Custom => L.T("Своя модель", "Custom model"),
        _ => ModelTitle,
    };

    public static string ChoiceLabel(LocalBrainKind kind) => kind switch
    {
        LocalBrainKind.Qwen3 => L.T("Qwen3 4B, 2,1 ГБ", "Qwen3 4B, 2.1 GB"),
        LocalBrainKind.Qwen35 => L.T("Qwen3.5 4B, 2,3 ГБ", "Qwen3.5 4B, 2.3 GB"),
        _ => L.T("Своя ссылка Hugging Face", "Own Hugging Face link"),
    };

    /// <summary>
    /// Turns a Hugging Face file page into a resolve URL. Rejects anything that is not https
    /// on huggingface.co / hf.co and does not name a .gguf. The file is only downloaded later, on the button.
    /// </summary>
    public static bool TryParseCustomUrl(string? raw, out string url, out string fileName, out string error)
    {
        url = "";
        fileName = "";
        error = "Нужна ссылка Hugging Face на файл .gguf.";
        var text = (raw ?? "").Trim();
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) return false;
        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)) return false;
        var host = uri.IdnHost.ToLowerInvariant();
        if (host is not ("huggingface.co" or "www.huggingface.co" or "hf.co" or "www.hf.co")) return false;
        var path = uri.AbsolutePath;
        const string blob = "/blob/";
        int at = path.IndexOf(blob, StringComparison.OrdinalIgnoreCase);
        if (at >= 0)
            path = string.Concat(path.AsSpan(0, at), "/resolve/", path.AsSpan(at + blob.Length));
        if (path.IndexOf("/resolve/", StringComparison.OrdinalIgnoreCase) < 0) return false;
        var leaf = path.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "";
        if (!leaf.EndsWith(".gguf", StringComparison.OrdinalIgnoreCase)) return false;
        fileName = SafeGgufName(leaf);
        if (fileName.Length == 0) return false;
        var b = new UriBuilder(uri) { Path = path, Query = "", Fragment = "" };
        url = b.Uri.AbsoluteUri;
        error = "";
        return true;
    }

    private static string SafeGgufName(string leaf)
    {
        var chars = new char[leaf.Length];
        for (int i = 0; i < leaf.Length; i++)
        {
            char c = leaf[i];
            chars[i] = c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') or (>= '0' and <= '9') or '.' or '-' or '_' ? c : '_';
        }
        var name = new string(chars);
        while (name.Contains("..", StringComparison.Ordinal)) name = name.Replace("..", "_", StringComparison.Ordinal);
        if (!name.EndsWith(".gguf", StringComparison.OrdinalIgnoreCase) || name.Length < 6) return "";
        if (name.Length > 160) name = name[^160..];
        if (name.StartsWith('.')) name = "m" + name;
        return name;
    }

    public static string ModelPath(Settings s)
    {
        if (s.BrainModel == LocalBrainKind.Custom)
        {
            if (!TryParseCustomUrl(s.BrainCustomUrl, out _, out var name, out _))
                return Path.Combine(Dir, "custom.gguf");
            return Path.Combine(Dir, name);
        }
        return Path.Combine(Dir, s.BrainModel == LocalBrainKind.Qwen35 ? Qwen35File : ModelFile);
    }

    public static long WeightBytes(Settings s) => s.BrainModel switch
    {
        LocalBrainKind.Qwen35 => Qwen35Bytes,
        LocalBrainKind.Custom => File.Exists(ModelPath(s)) ? new FileInfo(ModelPath(s)).Length : Qwen35Bytes,
        _ => Qwen3Bytes,
    };

    private static bool HasGgufMagic(string path)
    {
        try
        {
            Span<byte> magic = stackalloc byte[4];
            using var stream = File.OpenRead(path);
            return stream.Read(magic) == 4 && magic[0] == (byte)'G' && magic[1] == (byte)'G' && magic[2] == (byte)'U' && magic[3] == (byte)'F';
        }
        catch { return false; }
    }

    /// <summary>Engine plus the selected GGUF, checked by size (built-in) or by the GGUF header (custom).</summary>
    public static bool IsReady(Settings s)
    {
        var path = ModelPath(s);
        if (!File.Exists(ServerExeFor(s.BrainDevice)) || !File.Exists(path)) return false;
        long len = new FileInfo(path).Length;
        return s.BrainModel switch
        {
            LocalBrainKind.Qwen3 => len == Qwen3Bytes,
            LocalBrainKind.Qwen35 => len == Qwen35Bytes,
            _ => len > 1024 && len <= MaxCustomBytes && HasGgufMagic(path),
        };
    }

    public static bool HasAnything() =>
        Directory.Exists(Dir) && (File.Exists(ServerExe) || Directory.EnumerateFiles(Dir, "*.gguf").Any());

    // ── memory ───────────────────────────────────────────────────

    /// <summary>Selected model file plus context and llama.cpp overhead.</summary>
    public static ulong MemoryNeeded(Settings s) => (ulong)WeightBytes(s) + (600UL << 20);

    public static (ulong total, ulong available) Memory()
    {
        var m = new Native.MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<Native.MEMORYSTATUSEX>() };
        return Native.GlobalMemoryStatusEx(ref m) ? (m.ullTotalPhys, m.ullAvailPhys) : (0, 0);
    }

    public static string Gb(ulong bytes) => (bytes / (double)(1UL << 30)).ToString("0.0");

    // ── download ─────────────────────────────────────────────────

    /// <summary>Fetches the engine and the selected GGUF. Nothing here runs until the download button calls it.</summary>
    public static async Task DownloadAsync(Settings s, IProgress<ModelDownloader.Progress> progress, CancellationToken ct)
    {
        string[] urls;
        string? sha;
        long bytes;
        string dest = ModelPath(s);
        if (s.BrainModel == LocalBrainKind.Custom)
        {
            if (!TryParseCustomUrl(s.BrainCustomUrl, out var customUrl, out _, out var error))
                throw new ModelDownloadException(DownloadFailure.Rejected, error);
            urls = [customUrl];
            sha = null;
            bytes = 0;
        }
        else if (s.BrainModel == LocalBrainKind.Qwen35)
        {
            urls = [Qwen35Url];
            sha = Qwen35Sha256;
            bytes = Qwen35Bytes;
        }
        else
        {
            urls = Qwen3Urls;
            sha = Qwen3Sha256;
            bytes = Qwen3Bytes;
        }

        Stop();
        Directory.CreateDirectory(Dir);
        long need = (bytes > 0 ? bytes : 3L << 30) + (200L << 20);
        var part = dest + ".part";
        if (File.Exists(part)) need -= new FileInfo(part).Length;
        var free = new DriveInfo(Path.GetPathRoot(Dir)!).AvailableFreeSpace;
        if (free < need)
            throw new ModelDownloadException(DownloadFailure.NoSpace, $"only {free >> 20} MB free, need {need >> 20}");

        using var handler = new SocketsHttpHandler { DefaultProxyCredentials = CredentialCache.DefaultCredentials };
        using var http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("GigaPisar/" + PisarApp.Version + " (Windows)");

        try
        {
            await EnsureEngineAsync(http, s.BrainDevice, progress, ct);

            bool have = File.Exists(dest) && (bytes > 0 ? new FileInfo(dest).Length == bytes : HasGgufMagic(dest) && new FileInfo(dest).Length > 1024);
            if (!have)
            {
                for (int i = 0; ; i++)
                {
                    try
                    {
                        await FetchAsync(http, urls[i], part, bytes, progress, ct);
                        progress.Report(new ModelDownloader.Progress(0, 0, "verify"));
                        try
                        {
                            await Task.Run(() =>
                            {
                                if (sha != null) Verify(part, sha, "model");
                                else if (!HasGgufMagic(part))
                                    throw new ModelDownloadException(DownloadFailure.Rejected, "Это не файл GGUF. Он не запускается как программа.");
                            }, ct);
                        }
                        catch (InvalidDataException) { File.Delete(part); throw; }
                        catch (ModelDownloadException) { try { File.Delete(part); } catch { } throw; }
                        break;
                    }
                    catch (Exception e) when (i + 1 < urls.Length && !ct.IsCancellationRequested
                                              && e is HttpRequestException or ModelDownloadException or OperationCanceledException
                                                   or IOException or InvalidDataException)
                    {
                        Log.Write($"brain model source {i} failed: {e.GetType().Name}: {e.Message}; trying the next one");
                    }
                }
                File.Move(part, dest, overwrite: true);
            }
            progress.Report(new ModelDownloader.Progress(1, 1, "done"));
        }
        catch (ModelDownloadException) { throw; }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (OperationCanceledException e)
        {
            throw new ModelDownloadException(DownloadFailure.Network, "download stalled", e);
        }
        catch (IOException e) when (e.HResult == unchecked((int)0x80070070))
        {
            throw new ModelDownloadException(DownloadFailure.NoSpace, e.Message, e);
        }
        catch (InvalidDataException e)
        {
            throw new ModelDownloadException(DownloadFailure.Corrupt, e.Message, e);
        }
        catch (Exception e)
        {
            throw new ModelDownloadException(DownloadFailure.Network, e.Message, e);
        }
    }

    /// <summary>Downloads url into path, continuing from what is already there (HTTP Range).</summary>
    private static async Task FetchAsync(HttpClient http, string url, string path, long expected,
        IProgress<ModelDownloader.Progress>? progress, CancellationToken ct)
    {
        long cap = expected > 0 ? expected : MaxCustomBytes;
        long have = File.Exists(path) ? new FileInfo(path).Length : 0;
        if (have > cap) { File.Delete(path); have = 0; }

        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        idle.CancelAfter(DownloadIdleTimeout);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (have > 0) request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(have, null);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, idle.Token);
        if (have > 0 && response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable) return;   // already complete
        response.EnsureSuccessStatusCode();
        if (have > 0 && response.StatusCode != HttpStatusCode.PartialContent) have = 0;               // server ignored Range

        long total = response.Content.Headers.ContentLength is long len ? have + len : expected;
        if (total > cap) throw new InvalidDataException($"{Path.GetFileName(path)} is larger than expected: {total}");

        await using var net = await response.Content.ReadAsStreamAsync(idle.Token);
        await using var file = new FileStream(path, have > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write);
        var buffer = new byte[1 << 16];
        long received = have;
        var lastReport = DateTime.MinValue;
        int n;
        while ((n = await net.ReadAsync(buffer, idle.Token)) > 0)
        {
            idle.CancelAfter(DownloadIdleTimeout);
            await file.WriteAsync(buffer.AsMemory(0, n), ct);
            received += n;
            if (received > cap) throw new InvalidDataException("download larger than expected");
            if (progress != null && (DateTime.UtcNow - lastReport).TotalMilliseconds > 100)
            {
                progress.Report(new ModelDownloader.Progress(received, total, "download"));
                lastReport = DateTime.UtcNow;
            }
        }
        if (total > 0 && received != total)
            throw new ModelDownloadException(DownloadFailure.Network, $"incomplete download: {received} of {total}");
        if (expected == 0 && received < 1024)
            throw new ModelDownloadException(DownloadFailure.Network, "download too small to be a GGUF");
    }

    private static void Verify(string path, string sha256, string what)
    {
        using var stream = File.OpenRead(path);
        var actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (actual != sha256) throw new InvalidDataException($"checksum mismatch for the {what}");
    }

    public readonly record struct InstalledGguf(string Path, string Label);

    /// <summary>GGUF files in the brain folder. The llama.cpp engine and the app are not included.</summary>
    public static IReadOnlyList<InstalledGguf> InstalledGgufs()
    {
        if (!Directory.Exists(Dir)) return Array.Empty<InstalledGguf>();
        var list = new List<InstalledGguf>();
        foreach (var path in Directory.EnumerateFiles(Dir, "*.gguf"))
        {
            var info = new FileInfo(path);
            if (info.Length <= 1024) continue;
            var name = info.Name;
            string label = name.Equals(ModelFile, StringComparison.OrdinalIgnoreCase) ? "Qwen3 4B"
                : name.Equals(Qwen35File, StringComparison.OrdinalIgnoreCase) ? "Qwen3.5 4B"
                : name;
            list.Add(new InstalledGguf(info.FullName, label));
        }
        return list;
    }

    /// <summary>Deletes one GGUF under the brain folder. Stops llama-server first. Does not delete the engine or the app.</summary>
    public static void DeleteGguf(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetFullPath(Dir);
        var rel = Path.GetRelativePath(root, full);
        if (rel == ".." || rel.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) || Path.IsPathRooted(rel))
            throw new IOException("файл не в папке мозга");
        if (!full.EndsWith(".gguf", StringComparison.OrdinalIgnoreCase))
            throw new IOException("это не файл модели");
        if (File.Exists(Path.Combine(root, "GigaPisar.exe")))
            throw new IOException("рядом лежит программа, файл не удалён");
        Stop();
        if (File.Exists(full)) File.Delete(full);
        var part = full + ".part";
        if (File.Exists(part))
        {
            try { File.Delete(part); } catch { }
        }
    }

    public static void DeleteModel()
    {
        Stop();
        try { if (Directory.Exists(Dir)) Directory.Delete(Dir, true); } catch (Exception e) { Log.Write($"brain delete failed: {e.Message}"); }
    }

    private static async Task EnsureEngineAsync(HttpClient http, BrainDeviceKind kind, IProgress<ModelDownloader.Progress> progress, CancellationToken ct)
    {
        var exe = ServerExeFor(kind);
        if (File.Exists(exe)) return;
        var url = kind == BrainDeviceKind.Gpu ? VulkanUrl : EngineUrl;
        var sha = kind == BrainDeviceKind.Gpu ? VulkanSha256 : EngineSha256;
        var engineDir = EngineDirFor(kind);
        var zip = Path.Combine(Dir, (kind == BrainDeviceKind.Gpu ? "engine-vulkan.zip.part" : "engine.zip.part"));
        if (File.Exists(zip)) File.Delete(zip);
        await FetchAsync(http, url, zip, 64L << 20, null, ct);
        await Task.Run(() => Verify(zip, sha, "engine"), ct);
        progress.Report(new ModelDownloader.Progress(0, 0, "unpack"));
        await Task.Run(() =>
        {
            var temp = engineDir + ".tmp";
            if (Directory.Exists(temp)) Directory.Delete(temp, true);
            ZipFile.ExtractToDirectory(zip, temp);
            if (!File.Exists(Path.Combine(temp, "llama-server.exe")))
                throw new InvalidDataException("в архиве движка нет llama-server.exe");
            if (Directory.Exists(engineDir)) Directory.Delete(engineDir, true);
            Directory.Move(temp, engineDir);
        }, ct);
        File.Delete(zip);
    }

    // ── server ───────────────────────────────────────────────────

    private static readonly object Gate = new();
    private static Process? _server;
    private static IntPtr _job;
    private static int _port;
    private static string _apiKey = "";
    private static System.Threading.Timer? _idleTimer;
    private static StreamWriter? _log;

    public static bool Running { get { lock (Gate) return _server is { HasExited: false }; } }
    public static string EndpointUrl => $"http://127.0.0.1:{_port}/v1";
    public static string ApiKey => _apiKey;

    /// <summary>Starts the server if needed and waits until it answers /health. Reports elapsed seconds while starting.</summary>
    public static async Task EnsureStartedAsync(Settings s, Action<int>? startingTick, CancellationToken ct)
    {
        var model = ModelPath(s);
        Process server;
        lock (Gate)
        {
            // A server left on the previous file is not the one we want. Alive is not the same as ready.
            var device = s.BrainDevice;
            bool same = _server is { HasExited: false }
                && string.Equals(_loadedPath, model, StringComparison.OrdinalIgnoreCase)
                && _loadedDevice == device;
            server = same ? _server! : StartProcess(model, device);
        }

        try
        {
            await WaitHealthyAsync(server, startingTick, ct);
        }
        catch (BrainException) when (s.BrainDevice == BrainDeviceKind.Gpu && File.Exists(ServerExeFor(BrainDeviceKind.Cpu)))
        {
            Log.Write("brain vulkan did not start, using the CPU engine");
            DeviceNote = L.T("Видеокарта не поднялась, мозг считает на процессоре.", "The video card did not start, the brain is on the processor.");
            lock (Gate) server = StartProcess(model, BrainDeviceKind.Cpu);
            await WaitHealthyAsync(server, startingTick, ct);
        }
        Log.Write($"brain up on port {_port}, device {_loadedDevice}");
        TouchIdle();
    }

    /// <summary>Set when Vulkan failed and the CPU engine took over. Cleared on the next successful GPU start.</summary>
    public static string? DeviceNote { get; private set; }

    private static async Task WaitHealthyAsync(Process server, Action<int>? startingTick, CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var sw = Stopwatch.StartNew();
        int lastTick = 0;
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (server.HasExited)
                throw new BrainException(L.T($"нейронка упала при запуске, подробности в {LogPath}",
                                             $"the Brain crashed on start, details in {LogPath}"));
            try
            {
                var body = await http.GetStringAsync($"http://127.0.0.1:{_port}/health", ct);
                if (body.Contains("ok"))
                {
                    if (_loadedDevice == BrainDeviceKind.Gpu) DeviceNote = null;
                    return;
                }
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested) { }
            if (sw.Elapsed > StartTimeout)
            {
                Stop();
                throw new BrainException(L.T("нейронка не поднялась за полторы минуты", "the Brain did not come up within 90 seconds"));
            }
            int sec = (int)sw.Elapsed.TotalSeconds;
            if (sec >= 3 && sec != lastTick) { lastTick = sec; startingTick?.Invoke(sec); }
            await Task.Delay(400, ct);
        }
    }

    private static string? _loadedPath;
    private static BrainDeviceKind _loadedDevice;

    private static Process StartProcess(string modelPath, BrainDeviceKind device)
    {
        Stop();
        _port = FreePort();
        _apiKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var exe = ServerExeFor(device);
        if (!File.Exists(exe))
            throw new BrainException(L.T("движок мозга не скачан", "the brain engine is not downloaded"));
        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = EngineDirFor(device),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // b10701: --jinja uses the GGUF chat template, --reasoning off stops Qwen3.5 from thinking into the answer.
        foreach (var a in new[] { "-m", modelPath, "--host", "127.0.0.1", "--port", _port.ToString(), "--api-key", _apiKey,
                                  "-c", ContextTokens.ToString(), "--no-webui", "--jinja", "--reasoning", "off" })
            psi.ArgumentList.Add(a);
        // Vulkan build of the same b10701. 99 layers puts a 4B Q3 file on the card. CPU build ignores nothing here: the flag is GPU-only.
        if (device == BrainDeviceKind.Gpu)
        {
            psi.ArgumentList.Add("-ngl");
            psi.ArgumentList.Add("99");
        }

        // Shared read/write so a writer left from a previous run can never block this one.
        var log = new StreamWriter(new FileStream(LogPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true };
        _log = log;
        var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        void Write(string? line)
        {
            if (line == null) return;
            lock (log) { try { log.WriteLine(line); } catch { } }
        }
        p.OutputDataReceived += (_, e) => Write(e.Data);
        p.ErrorDataReceived += (_, e) => Write(e.Data);
        try { p.Start(); }
        catch
        {
            CloseLog();
            p.Dispose();
            throw;
        }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        AttachToJob(p);
        _server = p;
        _loadedPath = modelPath;
        _loadedDevice = device;
        Log.Write($"brain starting: {Path.GetFileName(modelPath)}, engine {EngineTag}/{device}, reasoning off");
        return p;
    }

    /// <summary>Kill-on-close job: if Pisar exits or crashes, Windows ends the server too.</summary>
    private static void AttachToJob(Process p)
    {
        try
        {
            if (_job == IntPtr.Zero)
            {
                _job = Native.CreateJobObject(IntPtr.Zero, null);
                var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                Native.SetInformationJobObject(_job, Native.JobObjectExtendedLimitInformation, ref info,
                    (uint)Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
            }
            if (!Native.AssignProcessToJobObject(_job, p.Handle))
                Log.Write($"brain job assign failed: {Marshal.GetLastWin32Error()}");
        }
        catch (Exception e) { Log.Write($"brain job failed: {e.Message}"); }
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    private static void TouchIdle()
    {
        lock (Gate)
        {
            _idleTimer?.Dispose();
            _idleTimer = new System.Threading.Timer(_ =>
            {
                Log.Write("brain idle for 15 minutes, releasing memory");
                Stop();
            }, null, IdleStop, Timeout.InfiniteTimeSpan);
        }
    }

    private static void CloseLog()
    {
        var log = _log;
        _log = null;
        if (log != null) lock (log) { try { log.Dispose(); } catch { } }
    }

    public static void Stop()
    {
        lock (Gate)
        {
            _idleTimer?.Dispose();
            _idleTimer = null;
            try
            {
                if (_server is { HasExited: false })
                {
                    _server.Kill();
                    _server.WaitForExit(2000);
                }
            }
            catch { }
            _server?.Dispose();
            _server = null;
            _loadedPath = null;
            CloseLog();
        }
    }
}

public sealed class BrainException(string reason) : Exception(reason);
