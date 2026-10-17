// Inserting text and reading a selection: port of src/App/TextInserter.cs on raw Win32.
//
// Default insert: put the text on the clipboard, press Ctrl+V, put the previous clipboard back. The text
// is marked so Windows keeps it out of Clipboard History and the cloud clipboard. Alternative: Unicode
// key events, which leave the clipboard alone; some apps (Windows 11 Notepad among them) garble fast
// input, so characters go in small batches with a pause.
//
// Everything runs on one worker thread, one command at a time, which also serialises the clipboard like
// the WPF ClipboardGate: the restore after Ctrl+V happens before the next command is taken. The thread
// owns a message-only window (the clipboard owner) and pumps messages while it waits, because other apps
// SendMessage the clipboard owner (WM_DESTROYCLIPBOARD) and would hang if nobody answered.
//
// Difference from WPF: .NET Framework has no WinRT clipboard-history API. With "keep the phrase in Win+V"
// the WPF app waits until history shows the phrase before restoring; here we wait the same 1.2 s when
// history is on (registry) and then restore, and leave the phrase current when history is off.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace ChawoNative;

internal sealed class Worker
{
    private const int CharsPerBatch = 8;
    private const int BatchPauseMs = 8;
    private const int ClipboardRestoreDelayMs = 800;
    private const int HistorySettleMs = 1200;
    private const int ErrorAccessDenied = 5;
    private const long SnapshotCap = 64L * 1024 * 1024;

    private readonly ConcurrentQueue<string[]> _queue = new();
    private readonly AutoResetEvent _wake = new(false);
    private readonly Action<string> _emit;
    private IntPtr _window;

    public Worker(Action<string> emit) => _emit = emit;

    public void Start()
    {
        var thread = new Thread(Run) { IsBackground = true, Name = "ChawoNative.Worker" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    public void Post(string[] command)
    {
        _queue.Enqueue(command);
        _wake.Set();
    }

    private void Run()
    {
        _window = Win32.CreateWindowEx(0, "STATIC", "ChawoNative", 0, 0, 0, 0, 0, Win32.HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (_window == IntPtr.Zero) Program.Log("message window failed: " + Marshal.GetLastWin32Error());
        var handles = new[] { _wake.SafeWaitHandle.DangerousGetHandle() };
        while (true)
        {
            uint r = Win32.MsgWaitForMultipleObjects(1, handles, false, 0xFFFFFFFF, Win32.QS_ALLINPUT);
            if (r == Win32.WAIT_OBJECT_0)
            {
                while (_queue.TryDequeue(out var cmd))
                {
                    try { Execute(cmd); }
                    catch (Exception e) { Program.Log($"{cmd[0]} failed: {e.GetType().Name}: {e.Message}"); Reply(cmd, "error"); }
                }
            }
            else DrainMessages();
        }
    }

    private static void Reply(string[] cmd, string what)
    {
        // Every request carries an id in cmd[1]; the caller would otherwise wait for its timeout.
        if (cmd.Length > 1) Program.Emit($"err {cmd[1]} {what}");
    }

    private void Execute(string[] cmd)
    {
        switch (cmd[0])
        {
            case "insert" when cmd.Length >= 6:
            {
                string id = cmd[1];
                bool paste = cmd[2] == "Paste";
                bool keep = cmd[3] == "1";
                bool restore = cmd[4] == "1";
                string text = Program.FromB64(cmd[5]);
                Action? after = null;
                string result = string.IsNullOrEmpty(text) ? "Done" : paste ? Paste(text, keep, restore, out after) : TypeAndMaybeCopy(text, keep, restore, out after);
                _emit($"ok {id} {result}");
                after?.Invoke();   // the clipboard restore: before the next command, like the WPF gate
                break;
            }
            case "copysel" when cmd.Length >= 2:
            {
                string? sel = CopySelection();
                _emit($"sel {cmd[1]} {(sel == null ? "-" : Program.ToB64(sel))}");
                break;
            }
            case "selread" when cmd.Length >= 2:
            {
                // SelectionReader: UI Automation first, Ctrl+C only for apps that do not say.
                string? sel = SelectionReader.TryGet(CopySelection);
                _emit($"sel {cmd[1]} {(sel == null ? "-" : Program.ToB64(sel))}");
                break;
            }
            case "selprobe" when cmd.Length >= 2:
            {
                // After a mouse selection: UI Automation only. No Ctrl+C here, it would run on every drag.
                string? sel = SelectionReader.TryGet(() => null);
                _emit($"sel {cmd[1]} {(sel == null ? "-" : Program.ToB64(sel))}");
                break;
            }
            case "fg" when cmd.Length >= 2:
                _emit($"fg {cmd[1]} {Program.ToB64(ForegroundProcess())}");
                break;
            case "ping" when cmd.Length >= 2:
                _emit($"pong {cmd[1]}");
                break;
            default:
                Program.Log("unknown command: " + cmd[0]);
                Reply(cmd, "unknown");
                break;
        }
    }

    // ── insertion ──

    private string TypeAndMaybeCopy(string text, bool keep, bool restore, out Action? after)
    {
        after = null;
        var result = Type(text);
        if (result != "Done" || !keep) return result;
        var saved = Snapshot();
        if (!SetText(text, exclude: false)) return result;
        uint seq = Win32.GetClipboardSequenceNumber();
        if (restore) after = () => KeepOrRestore(saved, seq, HistorySettleMs);
        return result;
    }

    private string Paste(string text, bool keep, bool restore, out Action? after)
    {
        after = null;
        var saved = Snapshot();
        // keep: plain text, no exclude formats, so the clipboard history service records it.
        if (!SetText(text, exclude: !keep))
        {
            Program.Log("clipboard set failed, typing instead");
            var typed = Type(text);
            if (typed == "Done" && keep && SetText(text, exclude: false) && restore)
            {
                uint s = Win32.GetClipboardSequenceNumber();
                after = () => KeepOrRestore(saved, s, HistorySettleMs);
            }
            return typed;
        }
        uint sequence = Win32.GetClipboardSequenceNumber();
        if (!Send(Chord(Win32.VK_V))) return "Blocked";   // our text stays on the clipboard so the user can paste by hand

        if (keep)
        {
            if (restore) after = () => KeepOrRestore(saved, sequence, ClipboardRestoreDelayMs + 400);
            else after = () => Pump(ClipboardRestoreDelayMs);   // still give the target time to read it
        }
        else
        {
            after = () =>
            {
                Pump(ClipboardRestoreDelayMs);
                if (saved == null || sequence == 0) return;
                if (Win32.GetClipboardSequenceNumber() == sequence) Restore(saved);
            };
        }
        return "Done";
    }

    /// <summary>
    /// The phrase is the current clipboard, which is what puts it into Win+V when history is on. With history
    /// on, give the history service time to take it, then put the previous clipboard back (if nobody copied
    /// anything meanwhile). With history off, leave the phrase current: the dictated phrase is never dropped.
    /// </summary>
    private void KeepOrRestore(List<KeyValuePair<uint, byte[]>>? saved, uint sequence, int waitMs)
    {
        if (!HistoryEnabled())
        {
            Program.Log("clipboard history is off; leaving the phrase as the current clipboard");
            return;
        }
        Pump(waitMs);
        if (sequence != 0 && Win32.GetClipboardSequenceNumber() != sequence) return;
        if (saved != null) Restore(saved);
        else Clear();
    }

    private static bool HistoryEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Clipboard");
            return key?.GetValue("EnableClipboardHistory") is int v && v != 0;
        }
        catch { return false; }
    }

    public string Type(string text)
    {
        var inputs = new List<Win32.INPUT>(text.Length * 2);
        foreach (char ch in text)
        {
            if (ch == '\n')
            {
                inputs.Add(Key(Win32.VK_RETURN, 0, 0));
                inputs.Add(Key(Win32.VK_RETURN, 0, Win32.KEYEVENTF_KEYUP));
                continue;
            }
            if (ch == '\r') continue;
            inputs.Add(Key(0, ch, Win32.KEYEVENTF_UNICODE));
            inputs.Add(Key(0, ch, Win32.KEYEVENTF_UNICODE | Win32.KEYEVENTF_KEYUP));
        }
        const int batch = CharsPerBatch * 2;
        for (int i = 0; i < inputs.Count; i += batch)
        {
            var slice = inputs.GetRange(i, Math.Min(batch, inputs.Count - i)).ToArray();
            if (!Send(slice)) return "Blocked";
            Pump(BatchPauseMs);
        }
        return "Done";
    }

    // ── selection ──

    /// <summary>
    /// Presses Ctrl+C, reads the copied text and puts the previous clipboard back. Null when nothing was
    /// selected (the clipboard did not change).
    /// </summary>
    private string? CopySelection()
    {
        var saved = Snapshot();
        uint before = Win32.GetClipboardSequenceNumber();
        if (!Send(Chord(Win32.VK_C))) return null;
        var watch = Stopwatch.StartNew();
        while (Win32.GetClipboardSequenceNumber() == before && watch.ElapsedMilliseconds < 400) Pump(15);
        if (Win32.GetClipboardSequenceNumber() == before) return null;
        string? text = GetText();
        if (saved != null) Restore(saved);
        else Clear();
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }

    private static string ForegroundProcess()
    {
        try
        {
            var hwnd = Win32.GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return "";
            Win32.GetWindowThreadProcessId(hwnd, out uint pid);
            if (pid == 0) return "";
            using var p = Process.GetProcessById((int)pid);
            return p.ProcessName;
        }
        catch { return ""; }
    }

    // ── clipboard on raw Win32 ──

    private bool Open()
    {
        // Another app may hold the clipboard for a moment.
        for (int i = 0; i < 10; i++)
        {
            if (Win32.OpenClipboard(_window)) return true;
            Pump(20);
        }
        Program.Log("OpenClipboard failed: " + Marshal.GetLastWin32Error());
        return false;
    }

    /// <summary>GDI handles, metafiles and private handle formats cannot be copied as plain bytes.</summary>
    private static bool Copyable(uint format) =>
        format is not (2 or 3 or 9 or 14 or 0x80 or 0x82 or 0x83 or 0x8E) && !(format >= 0x0200 && format <= 0x03FF);

    /// <summary>Deep copy of the current clipboard: the live data belongs to another app and goes when we replace it.</summary>
    private List<KeyValuePair<uint, byte[]>>? Snapshot()
    {
        if (!Open()) return null;
        try
        {
            var list = new List<KeyValuePair<uint, byte[]>>();
            long total = 0;
            uint format = 0;
            while ((format = Win32.EnumClipboardFormats(format)) != 0)
            {
                if (!Copyable(format)) continue;
                try
                {
                    IntPtr h = Win32.GetClipboardData(format);   // renders delayed formats
                    if (h == IntPtr.Zero) continue;
                    long size = (long)Win32.GlobalSize(h).ToUInt64();
                    if (size <= 0 || total + size > SnapshotCap) continue;
                    IntPtr p = Win32.GlobalLock(h);
                    if (p == IntPtr.Zero) continue;
                    try
                    {
                        var bytes = new byte[size];
                        Marshal.Copy(p, bytes, 0, (int)size);
                        list.Add(new KeyValuePair<uint, byte[]>(format, bytes));
                        total += size;
                    }
                    finally { Win32.GlobalUnlock(h); }
                }
                catch { /* a format the owner will not render: skip it */ }
            }
            return list.Count > 0 ? list : null;
        }
        finally { Win32.CloseClipboard(); }
    }

    private void Restore(List<KeyValuePair<uint, byte[]>> saved)
    {
        if (!Open()) return;
        try
        {
            Win32.EmptyClipboard();
            foreach (var kv in saved) Put(kv.Key, kv.Value);
        }
        catch (Exception e) { Program.Log("clipboard restore failed: " + e.Message); }
        finally { Win32.CloseClipboard(); }
    }

    private void Clear()
    {
        if (!Open()) return;
        try { Win32.EmptyClipboard(); }
        finally { Win32.CloseClipboard(); }
    }

    private bool SetText(string text, bool exclude)
    {
        if (!Open()) return false;
        try
        {
            if (!Win32.EmptyClipboard()) return false;
            if (!Put(Win32.CF_UNICODETEXT, Encoding.Unicode.GetBytes(text + "\0"))) return false;
            if (exclude)
            {
                // Windows honours these formats: no Clipboard History entry, no cloud sync.
                var zero = new byte[4];
                Put(Win32.RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), zero);
                Put(Win32.RegisterClipboardFormat("CanIncludeInClipboardHistory"), zero);
                Put(Win32.RegisterClipboardFormat("CanUploadToCloudClipboard"), zero);
            }
            return true;
        }
        finally { Win32.CloseClipboard(); }
    }

    private string? GetText()
    {
        if (!Win32.IsClipboardFormatAvailable(Win32.CF_UNICODETEXT) || !Open()) return null;
        try
        {
            IntPtr h = Win32.GetClipboardData(Win32.CF_UNICODETEXT);
            if (h == IntPtr.Zero) return null;
            IntPtr p = Win32.GlobalLock(h);
            if (p == IntPtr.Zero) return null;
            try { return Marshal.PtrToStringUni(p); }
            finally { Win32.GlobalUnlock(h); }
        }
        finally { Win32.CloseClipboard(); }
    }

    /// <summary>SetClipboardData with a fresh HGLOBAL; the system owns it on success.</summary>
    private static bool Put(uint format, byte[] bytes)
    {
        if (format == 0) return false;
        IntPtr h = Win32.GlobalAlloc(Win32.GMEM_MOVEABLE, (UIntPtr)Math.Max(bytes.Length, 1));
        if (h == IntPtr.Zero) return false;
        IntPtr p = Win32.GlobalLock(h);
        if (p == IntPtr.Zero) { Win32.GlobalFree(h); return false; }
        Marshal.Copy(bytes, 0, p, bytes.Length);
        Win32.GlobalUnlock(h);
        if (Win32.SetClipboardData(format, h) != IntPtr.Zero) return true;
        Win32.GlobalFree(h);
        return false;
    }

    // ── input ──

    private static Win32.INPUT[] Chord(ushort vk) => new[]
    {
        Key(Win32.VK_CONTROL, 0, 0),
        Key(vk, 0, 0),
        Key(vk, 0, Win32.KEYEVENTF_KEYUP),
        Key(Win32.VK_CONTROL, 0, Win32.KEYEVENTF_KEYUP),
    };

    private static bool Send(Win32.INPUT[] inputs)
    {
        uint sent = Win32.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Win32.INPUT>());
        if (sent == inputs.Length) return true;
        int error = Marshal.GetLastWin32Error();
        Program.Log($"SendInput sent {sent}/{inputs.Length}, error {error}" + (error == ErrorAccessDenied ? " (target runs elevated)" : ""));
        return false;
    }

    private static Win32.INPUT Key(ushort vk, ushort scan, uint flags) => new()
    {
        type = Win32.INPUT_KEYBOARD,
        u = new Win32.INPUTUNION { ki = new Win32.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } },
    };

    // ── message pump while waiting ──

    private void Pump(int ms)
    {
        var watch = Stopwatch.StartNew();
        while (true)
        {
            DrainMessages();
            long left = ms - watch.ElapsedMilliseconds;
            if (left <= 0) return;
            Win32.MsgWaitForMultipleObjects(0, Array.Empty<IntPtr>(), false, (uint)left, Win32.QS_ALLINPUT);
        }
    }

    private static void DrainMessages()
    {
        while (Win32.PeekMessage(out var msg, IntPtr.Zero, 0, 0, Win32.PM_REMOVE))
        {
            Win32.TranslateMessage(ref msg);
            Win32.DispatchMessage(ref msg);
        }
    }
}
