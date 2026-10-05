// Optional ffmpeg.exe for formats Windows Media Foundation cannot decode
// (Opus in WebM/MKV, some FLAC, AMR, …). Not bundled; downloaded only when asked.

using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;

namespace ChawoVA.App;

public static class FfmpegTool
{
    /// <summary>Pinned LGPL static win64 build from BtbN (no shared DLLs). Not bundled in the release zip.</summary>
    public const string DownloadUrl =
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip";

    /// <summary>Expected archive size from the BtbN "latest" asset listing (Oct 2026). Re-checked at download.</summary>
    public const long ExpectedZipBytes = 170_539_488;

    /// <summary>Allow ±2% drift if BtbN rebuilds the same tag.</summary>
    public const long ZipSizeTolerance = ExpectedZipBytes / 50;

    public static string ToolsDir => Path.Combine(Settings.LocalDataDir, "tools");
    public static string InstallDir => Path.Combine(ToolsDir, "ffmpeg");
    public static string ExePath => Path.Combine(InstallDir, "ffmpeg.exe");

    public static string? Find()
    {
        if (File.Exists(ExePath) && new FileInfo(ExePath).Length > 1_000_000)
            return ExePath;
        try
        {
            var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                string candidate = Path.Combine(dir.Trim('"'), "ffmpeg.exe");
                if (File.Exists(candidate)) return candidate;
            }
        }
        catch { /* PATH may be odd */ }
        return null;
    }

    public static bool IsInstalled => Find() != null;

    public static string StatusLine()
    {
        var found = Find();
        if (found == null)
            return L.T("ffmpeg нет. Нужен для Opus в WebM/MKV, части FLAC и AMR — кнопка ниже скачает LGPL-сборку BtbN (~170 МБ), в архив программы не входит.",
                       "ffmpeg is missing. Needed for Opus in WebM/MKV, some FLAC and AMR — the button below downloads the BtbN LGPL build (~170 MB); it is not in the app zip.");
        if (string.Equals(found, ExePath, StringComparison.OrdinalIgnoreCase))
            return L.T($"ffmpeg: {found}", $"ffmpeg: {found}");
        return L.T($"ffmpeg в PATH: {found}", $"ffmpeg on PATH: {found}");
    }

    /// <summary>Download the zip, verify size, extract ffmpeg.exe into InstallDir. Throws on failure.</summary>
    public static async Task DownloadAsync(IProgress<string>? progress, CancellationToken cancel)
    {
        Directory.CreateDirectory(ToolsDir);
        string zipPath = Path.Combine(ToolsDir, "ffmpeg-download.zip");
        string staging = Path.Combine(ToolsDir, "ffmpeg-staging");
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);

        progress?.Report(L.T("Скачиваю ffmpeg…", "Downloading ffmpeg…"));
        using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) })
        using (var resp = await http.GetAsync(DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancel))
        {
            resp.EnsureSuccessStatusCode();
            long? len = resp.Content.Headers.ContentLength;
            if (len is long n && Math.Abs(n - ExpectedZipBytes) > ZipSizeTolerance)
                throw new InvalidDataException($"unexpected ffmpeg zip size {n}, expected about {ExpectedZipBytes}");
            await using (var fs = File.Create(zipPath))
            await using (var stream = await resp.Content.ReadAsStreamAsync(cancel))
            {
                var buf = new byte[1024 * 256];
                long got = 0;
                int read;
                while ((read = await stream.ReadAsync(buf, cancel)) > 0)
                {
                    await fs.WriteAsync(buf.AsMemory(0, read), cancel);
                    got += read;
                    if (got % (8L * 1024 * 1024) < buf.Length)
                        progress?.Report(L.T($"Скачиваю ffmpeg… {got / (1024 * 1024)} МБ",
                                             $"Downloading ffmpeg… {got / (1024 * 1024)} MB"));
                }
                if (Math.Abs(got - ExpectedZipBytes) > ZipSizeTolerance)
                    throw new InvalidDataException($"downloaded ffmpeg zip size {got}, expected about {ExpectedZipBytes}");
            }
        }

        progress?.Report(L.T("Распаковываю ffmpeg…", "Extracting ffmpeg…"));
        cancel.ThrowIfCancellationRequested();
        ZipFile.ExtractToDirectory(zipPath, staging, overwriteFiles: true);
        string? exe = Directory.EnumerateFiles(staging, "ffmpeg.exe", SearchOption.AllDirectories).FirstOrDefault();
        if (exe == null || new FileInfo(exe).Length < 1_000_000)
            throw new InvalidDataException("ffmpeg.exe missing from the archive");

        if (Directory.Exists(InstallDir)) Directory.Delete(InstallDir, true);
        Directory.CreateDirectory(InstallDir);
        File.Copy(exe, ExePath, overwrite: true);
        // Keep companion DLLs if the build is shared (LGPL static usually has none next to exe).
        string? exeDir = Path.GetDirectoryName(exe);
        if (exeDir != null)
        {
            foreach (var dll in Directory.EnumerateFiles(exeDir, "*.dll"))
                File.Copy(dll, Path.Combine(InstallDir, Path.GetFileName(dll)), overwrite: true);
        }

        try { File.Delete(zipPath); } catch { }
        try { Directory.Delete(staging, true); } catch { }

        // Smoke: -version must exit 0
        var psi = new ProcessStartInfo(ExePath, "-hide_banner -version")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("could not start ffmpeg");
        _ = await p.StandardOutput.ReadToEndAsync(cancel);
        await p.WaitForExitAsync(cancel);
        if (p.ExitCode != 0) throw new InvalidOperationException("ffmpeg -version failed");
        progress?.Report(L.T($"ffmpeg готов: {ExePath}", $"ffmpeg ready: {ExePath}"));
    }

    /// <summary>Decode any ffmpeg-readable file to 16 kHz mono float32 PCM via a temp WAV.</summary>
    public static float[] DecodeTo16k(string path, CancellationToken cancel = default)
    {
        string? ffmpeg = Find() ?? throw new FileNotFoundException("ffmpeg not found");
        string tmp = Path.Combine(Path.GetTempPath(), "chawo-va-" + Guid.NewGuid().ToString("N") + ".wav");
        try
        {
            var psi = new ProcessStartInfo(ffmpeg)
            {
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            // -y overwrite; 16-bit PCM mono 16 kHz
            psi.ArgumentList.Add("-hide_banner");
            psi.ArgumentList.Add("-nostdin");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add(path);
            psi.ArgumentList.Add("-ac");
            psi.ArgumentList.Add("1");
            psi.ArgumentList.Add("-ar");
            psi.ArgumentList.Add("16000");
            psi.ArgumentList.Add("-c:a");
            psi.ArgumentList.Add("pcm_s16le");
            psi.ArgumentList.Add("-vn");
            psi.ArgumentList.Add("-y");
            psi.ArgumentList.Add(tmp);
            using var p = Process.Start(psi) ?? throw new InvalidOperationException("could not start ffmpeg");
            string err = p.StandardError.ReadToEnd();
            p.WaitForExit();
            cancel.ThrowIfCancellationRequested();
            if (p.ExitCode != 0 || !File.Exists(tmp))
                throw new InvalidDataException("ffmpeg failed: " + TrimErr(err));
            var (samples, rate) = ChawoVA.Core.AudioUtils.ReadWav(tmp);
            if (rate != 16000) samples = ChawoVA.Core.AudioUtils.Resample(samples, rate, 16000);
            return samples;
        }
        finally
        {
            try { File.Delete(tmp); } catch { }
        }
    }

    private static string TrimErr(string err)
    {
        if (string.IsNullOrWhiteSpace(err)) return "(no stderr)";
        var lines = err.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return string.Join(" | ", lines.TakeLast(3));
    }
}
