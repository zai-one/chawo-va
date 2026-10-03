// Speech-model download. Nothing here runs until the user presses the button.
//
// multilingual_large_ctc: fp32 ONNX published by istupakov (export of Sber's
// 600M multilingual CTC). Files are checked against known SHA-256.
// v3_e2e_rnnt: the smaller int8 archive used by the original Windows app.

using System.Formats.Tar;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using GigaPisar.Core;

namespace GigaPisar.App;

public enum DownloadFailure { Network, NoSpace, Corrupt, Rejected }

public sealed class ModelDownloadException(DownloadFailure kind, string message, Exception? inner = null) : Exception(message, inner)
{
    public DownloadFailure Kind { get; } = kind;
}

public static class ModelDownloader
{
    public const string V3ArchiveUrl =
        "https://github.com/moznoazachem/giga-pisar-cli/releases/latest/download/gigaam-v3-onnx-int8.tar.gz";

    private const string LargeBase =
        "https://huggingface.co/istupakov/gigaam-multilingual-large-ctc-onnx/resolve/main/";

    private readonly record struct RemoteFile(string Name, string Url, string Sha256, long Size);

    private static readonly RemoteFile[] LargeFiles =
    [
        new("multilingual_large_ctc.onnx", LargeBase + "multilingual_large_ctc.onnx",
            "4a2d22279e90648262e1259e82982f1f1f7e2c4957e187c2b68459458c92fd5f", 909828),
        new("multilingual_large_ctc.onnx.data", LargeBase + "multilingual_large_ctc.onnx.data",
            "5a7bf60fd3883a707dda19862b58a9a30777bde3e439ff76b49580da1f18b1f1", 2343837696),
        new("multilingual_large_ctc.yaml", LargeBase + "multilingual_large_ctc.yaml",
            "a76e9370be21c0e416d627b59262ae567cbcdd21e58458f58498ea42ce0685a0", 1180),
        new("multilingual_vocab.txt", LargeBase + "multilingual_vocab.txt",
            "4d130287892e1099fedfb3f93c4b4cf8a263151158801680b28977d1be4133f4", 393),
    ];

    private static readonly Dictionary<string, string> V3Sha256 = new(StringComparer.OrdinalIgnoreCase)
    {
        ["v3_e2e_rnnt_encoder.onnx"] = "dbea5c6158413e34b3707b99b65ec394c63cbd32da4164311f86dd65f86563d6",
        ["v3_e2e_rnnt_decoder.onnx"] = "a0f27fd86246d57cbe2c7138f3355591fd039e3e1015fd4ff2fd2d3d2d4d319d",
        ["v3_e2e_rnnt_joint.onnx"] = "8bf573aca80d99ca4226aa0f9d43398998280ec505705955b5c6d92238b3e6d5",
        ["v3_e2e_rnnt_tokenizer.model"] = "828c12c991019eef952a960661f25a92d6ad279591e2ea466b4aeddf1d20a18a",
    };

    private const long MaxFileBytes = 4L << 30;
    private const int ReadBufferBytes = 1 << 16;
    private static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(120);

    public sealed record Progress(long Received, long Total, string Stage);

    public static long ApproxBytes(SpeechModelKind kind) =>
        kind == SpeechModelKind.V3E2eRnnt ? 220L << 20 : LargeFiles.Sum(f => f.Size);

    public static async Task DownloadAsync(SpeechModelKind kind, string targetDir, IProgress<Progress> progress, CancellationToken ct)
    {
        if (kind == SpeechModelKind.V3E2eRnnt)
            await DownloadV3Async(targetDir, progress, ct);
        else
            await DownloadLargeAsync(targetDir, progress, ct);
    }

    private static async Task DownloadLargeAsync(string targetDir, IProgress<Progress> progress, CancellationToken ct)
    {
        long need = ApproxBytes(SpeechModelKind.MultilingualLargeCtc) + (1L << 30);
        EnsureSpace(need);
        var temp = targetDir + ".tmp";
        try
        {
            if (Directory.Exists(temp)) Directory.Delete(temp, true);
            Directory.CreateDirectory(temp);
            long total = LargeFiles.Sum(f => f.Size);
            long done = 0;
            foreach (var file in LargeFiles)
            {
                var dest = Path.Combine(temp, file.Name);
                await FetchFileAsync(file.Url, dest, file.Size, (got, fileTotal) =>
                {
                    progress.Report(new Progress(done + got, total, "download"));
                }, ct);
                progress.Report(new Progress(done, total, "verify"));
                await Task.Run(() => VerifySha(dest, file.Sha256), ct);
                done += file.Size;
                progress.Report(new Progress(done, total, "download"));
            }
            if (Directory.Exists(targetDir)) Directory.Delete(targetDir, true);
            Directory.Move(temp, targetDir);
            progress.Report(new Progress(1, 1, "done"));
        }
        catch (ModelDownloadException) { throw; }
        catch (OperationCanceledException) { throw; }
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
        finally
        {
            try { if (Directory.Exists(temp)) Directory.Delete(temp, true); } catch { }
        }
    }

    private static async Task DownloadV3Async(string targetDir, IProgress<Progress> progress, CancellationToken ct)
    {
        EnsureSpace(1L << 30);
        Directory.CreateDirectory(Settings.LocalDataDir);
        var archive = Path.Combine(Settings.LocalDataDir, "model.tar.gz.part");
        var temp = targetDir + ".tmp";
        try
        {
            await FetchFileAsync(V3ArchiveUrl, archive, expectedSize: -1, (got, total) =>
                progress.Report(new Progress(got, total, "download")), ct);
            progress.Report(new Progress(0, 0, "unpack"));
            await Task.Run(() => UnpackV3(archive, temp, ct), ct);
            if (Directory.Exists(targetDir)) Directory.Delete(targetDir, true);
            Directory.Move(temp, targetDir);
            progress.Report(new Progress(1, 1, "done"));
        }
        catch (ModelDownloadException) { throw; }
        catch (OperationCanceledException) { throw; }
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
        finally
        {
            try { if (File.Exists(archive)) File.Delete(archive); } catch { }
            try { if (Directory.Exists(temp)) Directory.Delete(temp, true); } catch { }
        }
    }

    private static void EnsureSpace(long bytes)
    {
        var root = Path.GetPathRoot(Settings.LocalDataDir);
        if (string.IsNullOrEmpty(root)) return;
        var free = new DriveInfo(root).AvailableFreeSpace;
        if (free < bytes)
            throw new ModelDownloadException(DownloadFailure.NoSpace, $"only {free >> 20} MB free");
    }

    private static async Task FetchFileAsync(string url, string dest, long expectedSize, Action<long, long> progress, CancellationToken ct)
    {
        using var handler = new SocketsHttpHandler { DefaultProxyCredentials = CredentialCache.DefaultCredentials, AllowAutoRedirect = true };
        using var http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("GigaPisar/" + PisarApp.Version + " (Windows)");
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        idle.CancelAfter(IdleTimeout);
        using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, idle.Token);
        response.EnsureSuccessStatusCode();
        long total = response.Content.Headers.ContentLength ?? expectedSize;
        if (total > MaxFileBytes) throw new ModelDownloadException(DownloadFailure.Corrupt, $"file too large: {total}");
        await using var net = await response.Content.ReadAsStreamAsync(idle.Token);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        await using var file = File.Create(dest);
        var buffer = new byte[ReadBufferBytes];
        long received = 0;
        int n;
        var lastReport = DateTime.MinValue;
        while ((n = await net.ReadAsync(buffer, idle.Token)) > 0)
        {
            idle.CancelAfter(IdleTimeout);
            await file.WriteAsync(buffer.AsMemory(0, n), ct);
            received += n;
            if (received > MaxFileBytes) throw new ModelDownloadException(DownloadFailure.Corrupt, "file too large");
            if ((DateTime.UtcNow - lastReport).TotalMilliseconds > 100)
            {
                progress(received, total);
                lastReport = DateTime.UtcNow;
            }
        }
        if (total > 0 && received != total)
            throw new ModelDownloadException(DownloadFailure.Network, $"incomplete download: {received} of {total}");
        progress(received, total > 0 ? total : received);
    }

    private static void VerifySha(string path, string expected)
    {
        using var stream = File.OpenRead(path);
        var actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"checksum mismatch for {Path.GetFileName(path)}");
    }

    private static void UnpackV3(string archive, string temp, CancellationToken ct)
    {
        if (Directory.Exists(temp)) Directory.Delete(temp, true);
        Directory.CreateDirectory(temp);
        using (var fs = File.OpenRead(archive))
        using (var gz = new GZipStream(fs, CompressionMode.Decompress))
        using (var tar = new TarReader(gz))
        {
            while (tar.GetNextEntry() is { } entry)
            {
                ct.ThrowIfCancellationRequested();
                if (entry.EntryType != TarEntryType.RegularFile && entry.EntryType != TarEntryType.V7RegularFile) continue;
                var name = Path.GetFileName(entry.Name);
                if (name.Length == 0 || name.StartsWith("._")) continue;
                if (entry.Length > MaxFileBytes) throw new InvalidDataException($"entry too large: {name}");
                entry.ExtractToFile(Path.Combine(temp, name), overwrite: true);
            }
        }
        foreach (var (name, expected) in V3Sha256)
        {
            var path = Path.Combine(temp, name);
            if (!File.Exists(path)) throw new InvalidDataException($"missing {name}");
            VerifySha(path, expected);
        }
        if (!File.Exists(Path.Combine(temp, "v3_e2e_rnnt.yaml")))
            throw new InvalidDataException("missing model config");
    }
}
