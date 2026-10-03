// Decoder for Hermes. Starts on 127.0.0.1. After the user opens the firewall
// port it can bind 0.0.0.0 so other machines on the LAN can POST audio.
// The audio is decoded here. This process does not upload it.

using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using GigaPisar.Core;

namespace GigaPisar.App;

public sealed class HermesServer : IDisposable
{
    private readonly TcpListener _listener;
    private readonly Func<byte[], HermesResult> _transcribe;
    private readonly CancellationTokenSource _cts = new();

    public int Port { get; }

    public bool ListenOnLan { get; }
    public string BindAddress => ListenOnLan ? "0.0.0.0" : "127.0.0.1";

    public HermesServer(int port, Func<byte[], HermesResult> transcribe, bool listenOnLan = false)
    {
        Port = port;
        ListenOnLan = listenOnLan;
        _transcribe = transcribe;
        _listener = new TcpListener(listenOnLan ? IPAddress.Any : IPAddress.Loopback, port);
    }

    public void Start()
    {
        _listener.Start();
        _ = Task.Run(AcceptLoop);
        Log.Write($"hermes listening on {BindAddress}:{Port}");
    }

    private async Task AcceptLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(_cts.Token); }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException) { break; }
            catch (Exception e)
            {
                Log.Write($"hermes accept: {e.Message}");
                break;
            }
            _ = Task.Run(() => Handle(client));
        }
    }

    private void Handle(TcpClient client)
    {
        using (client)
        {
            try
            {
                if (!ListenOnLan && client.Client.RemoteEndPoint is IPEndPoint ep && !IPAddress.IsLoopback(ep.Address))
                {
                    Write(client.GetStream(), 403, JsonSerializer.Serialize(new { error = "localhost_only" }));
                    return;
                }
                // A two-hour file is read, then the model runs for a long time before the answer is written.
                client.ReceiveTimeout = 0;
                client.SendTimeout = 0;
                try { client.Client.SetSocketOption(System.Net.Sockets.SocketOptionLevel.Socket, System.Net.Sockets.SocketOptionName.KeepAlive, true); }
                catch { /* keepalive is optional */ }
                var stream = client.GetStream();
                var (method, path, headers, body) = ReadRequest(stream);
                if (method == "GET" && (path == "/v1/health" || path == "/health"))
                {
                    var status = _transcribe(Array.Empty<byte>());
                    Write(stream, 200, JsonSerializer.Serialize(new
                    {
                        ok = true,
                        model_loaded = status.ModelLoaded,
                        model = status.Model,
                        device = status.Device,
                        provider = status.Provider,
                        port = Port,
                        listen = BindAddress,
                    }));
                    return;
                }
                if (method != "POST" || (path != "/v1/transcribe" && path != "/transcribe"))
                {
                    Write(stream, 404, JsonSerializer.Serialize(new { error = "not_found" }));
                    return;
                }
                var audio = ExtractAudio(headers, body);
                if (audio.Length == 0)
                {
                    Write(stream, 400, JsonSerializer.Serialize(new { error = "empty_body" }));
                    return;
                }
                var result = _transcribe(audio);
                if (!result.ModelLoaded)
                {
                    Write(stream, 503, JsonSerializer.Serialize(new { error = "model_not_loaded" }));
                    return;
                }
                if (result.Error != null)
                {
                    Write(stream, 400, JsonSerializer.Serialize(new { error = "bad_audio", detail = result.Error }));
                    return;
                }
                Write(stream, 200, JsonSerializer.Serialize(new
                {
                    text = result.Text,
                    model = result.Model,
                    device = result.Device,
                    provider = result.Provider,
                    sample_rate = 16000,
                    seconds = Math.Round(result.Seconds, 3),
                }));
            }
            catch (Exception e)
            {
                Log.Write($"hermes request failed: {e.GetType().Name}: {e.Message}");
                try { Write(client.GetStream(), 400, JsonSerializer.Serialize(new { error = "bad_request", detail = e.Message })); }
                catch { }
            }
        }
    }

    private static byte[] ExtractAudio(Dictionary<string, string> headers, byte[] body)
    {
        headers.TryGetValue("content-type", out var type);
        type ??= "";
        if (type.StartsWith("multipart/form-data", StringComparison.OrdinalIgnoreCase))
        {
            var boundary = Boundary(type);
            if (boundary.Length == 0) throw new InvalidDataException("multipart without a boundary");
            return FirstFilePart(body, boundary);
        }
        return body;
    }

    private static string Boundary(string contentType)
    {
        foreach (var part in contentType.Split(';'))
        {
            var p = part.Trim();
            if (p.StartsWith("boundary=", StringComparison.OrdinalIgnoreCase))
            {
                var b = p["boundary=".Length..].Trim().Trim('"');
                return b;
            }
        }
        return "";
    }

    private static byte[] FirstFilePart(byte[] body, string boundary)
    {
        var sep = Encoding.ASCII.GetBytes("--" + boundary);
        int start = IndexOf(body, sep, 0);
        if (start < 0) throw new InvalidDataException("multipart boundary not found");
        start += sep.Length;
        if (start + 1 < body.Length && body[start] == (byte)'\r') start += 2;
        int next = IndexOf(body, sep, start);
        if (next < 0) next = body.Length;
        var part = body.AsSpan(start, next - start);
        var headerEnd = IndexOf(part, "\r\n\r\n"u8, 0);
        if (headerEnd < 0) throw new InvalidDataException("multipart part has no header");
        int data = headerEnd + 4;
        int len = part.Length - data;
        if (len >= 2 && part[len + data - 2] == (byte)'\r') len -= 2;
        if (data + len > part.Length || len < 0) len = Math.Max(0, part.Length - data);
        return part.Slice(data, len).ToArray();
    }

    private static (string method, string path, Dictionary<string, string> headers, byte[] body) ReadRequest(NetworkStream stream)
    {
        var headerBytes = ReadUntil(stream, "\r\n\r\n"u8, 64 * 1024);
        var text = Encoding.ASCII.GetString(headerBytes);
        var lines = text.Split("\r\n");
        if (lines.Length == 0) throw new InvalidDataException("empty request");
        var req = lines[0].Split(' ');
        if (req.Length < 2) throw new InvalidDataException("bad request line");
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon <= 0) continue;
            headers[lines[i][..colon].Trim()] = lines[i][(colon + 1)..].Trim();
        }
        int length = 0;
        if (headers.TryGetValue("content-length", out var lenText))
        {
            // Long enough for about two hours of 44.1 kHz stereo 16-bit. Not a download.
            if (!int.TryParse(lenText, out length) || length < 0 || length > FileTranscript.MaxBytes)
                throw new InvalidDataException("content-length is missing or too large");
        }
        else if (req[0] == "POST")
            throw new InvalidDataException("POST needs Content-Length");
        var body = length == 0 ? Array.Empty<byte>() : ReadExact(stream, length);
        var path = req[1];
        int q = path.IndexOf('?');
        if (q >= 0) path = path[..q];
        return (req[0], path, headers, body);
    }

    private static byte[] ReadUntil(NetworkStream stream, ReadOnlySpan<byte> marker, int cap)
    {
        var buf = new List<byte>(1024);
        var one = new byte[1];
        while (buf.Count < cap)
        {
            int n = stream.Read(one, 0, 1);
            if (n == 0) break;
            buf.Add(one[0]);
            if (buf.Count >= marker.Length && EndsWith(buf, marker))
                return buf.ToArray();
        }
        throw new InvalidDataException("request headers too large or incomplete");
    }

    private static byte[] ReadExact(NetworkStream stream, int length)
    {
        var buf = new byte[length];
        int got = 0;
        while (got < length)
        {
            int n = stream.Read(buf, got, length - got);
            if (n == 0) throw new InvalidDataException("unexpected end of request body");
            got += n;
        }
        return buf;
    }

    private static bool EndsWith(List<byte> buf, ReadOnlySpan<byte> marker)
    {
        int o = buf.Count - marker.Length;
        for (int i = 0; i < marker.Length; i++)
            if (buf[o + i] != marker[i]) return false;
        return true;
    }

    private static int IndexOf(ReadOnlySpan<byte> hay, ReadOnlySpan<byte> needle, int from)
    {
        for (int i = from; i + needle.Length <= hay.Length; i++)
        {
            if (hay.Slice(i, needle.Length).SequenceEqual(needle)) return i;
        }
        return -1;
    }

    private static void Write(NetworkStream stream, int code, string json)
    {
        var payload = Encoding.UTF8.GetBytes(json);
        string reason = code switch { 200 => "OK", 400 => "Bad Request", 403 => "Forbidden", 404 => "Not Found", 503 => "Service Unavailable", _ => "Error" };
        var head = Encoding.ASCII.GetBytes($"HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n");
        stream.Write(head);
        stream.Write(payload);
    }

    public void Dispose()
    {
        _cts.Cancel();
        _listener.Stop();
        _cts.Dispose();
    }
}

public sealed record HermesResult(bool ModelLoaded, string? Text, string Model, string Device, string Provider, double Seconds, string? Error);
