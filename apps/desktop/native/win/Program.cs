// Chawo Voice Assistant native helper for Windows. Started by the Electron main process with pipes;
// one line per message, fields split by single spaces, text as base64 UTF-8. Exits when stdin closes,
// so it never outlives the app.
//
// app → helper:  hotkey <vk> | arm <0|1> | ttskey <vk> | selwatch <0|1>
//                insert <id> <Paste|Type> <keep 0|1> <restore 0|1> <b64>
//                copysel <id> | selread <id> | selprobe <id> | fg <id> | ping <id>
// helper → app:  ready <protocol> | hookfail <b64> | down | up | esc | tts | mup <x> <y>
//                ok <id> <Done|Blocked> | sel <id> <b64|-> | fg <id> <b64> | pong <id> | err <id> <reason> | log <b64>
//
// Nothing is logged to disk here and no text is ever written to the log: log lines carry only events.

using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Threading;

namespace ChawoNative;

internal static class Program
{
    public const int Protocol = 1;
    private static readonly BlockingCollection<string> Outbox = new();

    public static void Emit(string line) => Outbox.Add(line);
    public static void Log(string text) => Emit("log " + ToB64(text));
    public static string ToB64(string s) => Convert.ToBase64String(Encoding.UTF8.GetBytes(s));
    public static string FromB64(string s)
    {
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }
        catch { return ""; }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        var utf8 = new UTF8Encoding(false);
        var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
        var writer = new Thread(() =>
        {
            try { foreach (var line in Outbox.GetConsumingEnumerable()) stdout.WriteLine(line); }
            catch { Environment.Exit(0); }   // the app is gone
        }) { IsBackground = true, Name = "ChawoNative.Out" };
        writer.Start();

        int vk = 0xA3;
        for (int i = 0; i + 1 < args.Length; i++)
            if (args[i] == "--hotkey" && int.TryParse(args[i + 1], out var v)) vk = v;

        var hook = new Hook(vk, Emit);
        var worker = new Worker(Emit);
        worker.Start();
        string? hookError = hook.Start();
        if (hookError != null) Emit("hookfail " + ToB64(hookError));
        Emit("ready " + Protocol);

        var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            var parts = line.Trim().Split(' ');
            if (parts.Length == 0 || parts[0].Length == 0) continue;
            switch (parts[0])
            {
                case "hotkey" when parts.Length >= 2 && int.TryParse(parts[1], out var k):
                    hook.HotkeyVk = k;
                    break;
                case "arm" when parts.Length >= 2:
                    hook.ArmCancel = parts[1] == "1";
                    break;
                case "ttskey" when parts.Length >= 2 && int.TryParse(parts[1], out var t):
                    hook.TtsVk = t;
                    break;
                case "selwatch" when parts.Length >= 2:
                    hook.WatchSelection = parts[1] == "1";
                    break;
                case "quit":
                    line = null;
                    break;
                default:
                    worker.Post(parts);
                    break;
            }
            if (line == null) break;
        }
        hook.Stop();
        Outbox.CompleteAdding();
        writer.Join(500);
        return 0;
    }
}
