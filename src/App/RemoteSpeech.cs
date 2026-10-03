// Client of another Giga Pisar. Posts a WAV to http://host:port/v1/transcribe.
// Never downloads weights. A dead host is an error, not a reason to fetch a model.

using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using GigaPisar.Core;

namespace GigaPisar.App;

public sealed class RemoteHostException : Exception
{
    public string Russian { get; }
    public string English { get; }

    public RemoteHostException(string russian, string english) : base(russian)
    {
        Russian = russian;
        English = english;
    }
}

public static class RemoteSpeech
{
    private static HttpClient MakeClient(TimeSpan timeout) => new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(5),
    })
    { Timeout = timeout };

    private static readonly HttpClient Http = MakeClient(TimeSpan.FromSeconds(90));

    /// <summary>File posts can take hours. Cancelled only by the caller's token. Does not download a model.</summary>
    private static readonly HttpClient FileHttp = MakeClient(Timeout.InfiniteTimeSpan);

    public static bool TryEndpoint(Settings settings, out Uri transcribe, out string russian, out string english)
    {
        transcribe = null!;
        var host = (settings.RemoteHost ?? "").Trim();
        int port = settings.RemotePort is >= 1 and <= 65535 ? settings.RemotePort : SpeechModels.HermesPort;

        if (host.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || host.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            if (!Uri.TryCreate(host, UriKind.Absolute, out var parsed) || string.IsNullOrEmpty(parsed.Host))
            {
                russian = "Адрес хоста не разобрать. Нужен IP или имя.";
                english = "Could not read the host address. Use an IP or a name.";
                return false;
            }
            if (!string.Equals(parsed.Scheme, "http", StringComparison.OrdinalIgnoreCase))
            {
                russian = "Нужен адрес http. Хост Писаря слушает http, не https.";
                english = "Use http. Pisar's host listens on http, not https.";
                return false;
            }
            if (parsed.Port > 0) port = parsed.Port;
            host = parsed.IdnHost;
        }

        host = host.Trim().TrimEnd('/');
        if (host.Length == 0 || host.IndexOfAny([' ', '/', '\\', '?']) >= 0)
        {
            russian = "Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.";
            english = "Set the host address under Network. This PC does not download a model.";
            return false;
        }

        string hostPart = host.Contains(':') && !host.StartsWith('[') ? $"[{host}]" : host;
        if (!Uri.TryCreate($"http://{hostPart}:{port}/v1/transcribe", UriKind.Absolute, out transcribe!))
        {
            russian = "Адрес хоста или порт неверные. Модель здесь не скачивается.";
            english = "The host address or port is not valid. This PC does not download a model.";
            return false;
        }
        russian = "";
        english = "";
        return true;
    }

    /// <summary>Sends 16 kHz audio. Throws <see cref="RemoteHostException"/> when the host is down or has no model. Does not download.</summary>
    public static string Transcribe(Settings settings, float[] samples, int rate, CancellationToken cancel)
    {
        if (!TryEndpoint(settings, out var uri, out var ru, out var en))
            throw new RemoteHostException(ru, en);
        if (rate != 16000) samples = AudioUtils.Resample(samples, rate, 16000);
        var wav = AudioUtils.WavBytes(samples, 16000);
        using var req = new HttpRequestMessage(HttpMethod.Post, uri);
        req.Content = new ByteArrayContent(wav);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        HttpResponseMessage resp;
        try
        {
            resp = Http.Send(req, cancel);
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            throw Down();
        }

        return ReadText(resp, cancel);
    }

    private static string ReadText(HttpResponseMessage resp, CancellationToken cancel)
    {
        using (resp)
        {
            string body;
            try { body = resp.Content.ReadAsStringAsync(cancel).GetAwaiter().GetResult(); }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
            catch (Exception) { throw Down(); }

            if ((int)resp.StatusCode == 503)
                throw new RemoteHostException(
                    "Хост на связи, но модель там не загружена. Здесь ничего не скачиваю.",
                    "The host answered, but its model is not loaded. Nothing is downloaded here.");
            if ((int)resp.StatusCode == 400)
                throw new RemoteHostException(
                    "Хост не принял файл. Нужен WAV 16 бит или Ogg/Opus. Модель здесь не скачивается.",
                    "The host rejected the file. It needs 16-bit WAV or Ogg/Opus. This PC does not download a model.");
            if (!resp.IsSuccessStatusCode)
                throw new RemoteHostException(
                    $"Хост ответил ошибкой {(int)resp.StatusCode}. Модель здесь не скачивается.",
                    $"The host returned {(int)resp.StatusCode}. This PC does not download a model.");
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
                    return text.GetString() ?? "";
            }
            catch (JsonException) { }
            throw new RemoteHostException(
                "Хост ответил не текстом. Модель здесь не скачивается.",
                "The host answer was not text. This PC does not download a model.");
        }
    }

    /// <summary>
    /// Posts the file bytes as-is (wav or ogg). The host splits and recognizes.
    /// Does not download a model. Cancel with <paramref name="cancel"/>.
    /// </summary>
    public static string TranscribeBytes(Settings settings, byte[] body, string contentType, CancellationToken cancel)
    {
        if (!TryEndpoint(settings, out var uri, out var ru, out var en))
            throw new RemoteHostException(ru, en);
        if (body.LongLength > FileTranscript.MaxBytes)
            throw new RemoteHostException(
                "Файл слишком большой. Модель здесь не скачивается.",
                "The file is too large. This PC does not download a model.");
        using var req = new HttpRequestMessage(HttpMethod.Post, uri);
        req.Content = new ByteArrayContent(body);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        HttpResponseMessage resp;
        try
        {
            resp = FileHttp.Send(req, cancel);
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            throw Down();
        }
        return ReadText(resp, cancel);
    }

    /// <summary>Short Russian line for the Network page. Never downloads.</summary>
    public static string Check(Settings settings)
    {
        if (!TryEndpoint(settings, out var transcribe, out var ru, out _))
            return ru;
        var health = new UriBuilder(transcribe) { Path = "/v1/health", Query = "" }.Uri;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            using var resp = Http.Send(new HttpRequestMessage(HttpMethod.Get, health), cts.Token);
            var body = resp.Content.ReadAsStringAsync(cts.Token).GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode)
                return $"Хост ответил {(int)resp.StatusCode}. Модель здесь не скачивается.";
            bool loaded = false;
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("model_loaded", out var flag)
                    && flag.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    loaded = flag.GetBoolean();
            }
            catch (JsonException) { }
            return loaded
                ? "Хост отвечает, модель загружена."
                : "Хост отвечает, но модель там не загружена. Здесь ничего не скачиваю.";
        }
        catch (Exception)
        {
            return "Хост не отвечает. Проверьте адрес и порт. Модель здесь не скачивается.";
        }
    }

    private static RemoteHostException Down() => new(
        "Хост не отвечает. Проверьте адрес и порт. Модель на этом компьютере не скачивается.",
        "The host did not answer. Check the address and port. This PC does not download a model.");
}
