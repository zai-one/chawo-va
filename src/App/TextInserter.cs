// Puts recognized text into whatever has keyboard focus.
//
// Default: put the text on the clipboard, press Ctrl+V, restore the previous
// clipboard. The text is marked so Windows keeps it out of Clipboard History
// and the cloud clipboard. Alternative: synthesize Unicode key events, which
// leaves the clipboard alone; some apps (Windows 11 Notepad among them) garble
// fast input, so characters go in small batches with a pause.
//
// Runs on a worker thread; clipboard calls are marshalled to the UI thread
// because WPF's Clipboard requires STA.

using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Win32;
using WinClip = Windows.ApplicationModel.DataTransfer.Clipboard;
using WinTransfer = Windows.ApplicationModel.DataTransfer;

namespace ChawoVA.App;

public enum InsertResult { Done, Blocked }

public readonly record struct PhraseClipboardOptions(bool Keep, bool RestoreIfHistoryKeepsIt);

public static class TextInserter
{
    private const int CharsPerBatch = 8;
    private const int BatchPauseMs = 8;
    private const int ClipboardRestoreDelayMs = 800;
    private const int ErrorAccessDenied = 5;
    private static readonly SemaphoreSlim ClipboardGate = new(1, 1);

    public static InsertResult Insert(string text, InsertMode mode, CancellationToken cancellationToken = default) =>
        Insert(text, mode, cancellationToken, default);

    public static InsertResult Insert(string text, InsertMode mode, CancellationToken cancellationToken, PhraseClipboardOptions clip)
    {
        if (string.IsNullOrEmpty(text)) return InsertResult.Done;
        return mode == InsertMode.Paste ? Paste(text, cancellationToken, clip) : TypeAndMaybeCopy(text, clip, cancellationToken);
    }

    private static InsertResult TypeAndMaybeCopy(string text, PhraseClipboardOptions clip, CancellationToken cancellationToken)
    {
        var result = Type(text);
        if (result == InsertResult.Done && clip.Keep)
            RememberAsync(text, clip.RestoreIfHistoryKeepsIt, cancellationToken).GetAwaiter().GetResult();
        return result;
    }

    public static InsertResult Type(string text)
    {
        var inputs = new List<Native.INPUT>(text.Length * 2);
        foreach (char ch in text)
        {
            if (ch == '\n')
            {
                inputs.Add(Key(Native.VK_RETURN, 0, 0));
                inputs.Add(Key(Native.VK_RETURN, 0, Native.KEYEVENTF_KEYUP));
                continue;
            }
            if (ch == '\r') continue;
            inputs.Add(Key(0, ch, Native.KEYEVENTF_UNICODE));
            inputs.Add(Key(0, ch, Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP));
        }

        const int batch = CharsPerBatch * 2;
        for (int i = 0; i < inputs.Count; i += batch)
        {
            var slice = inputs.GetRange(i, Math.Min(batch, inputs.Count - i)).ToArray();
            if (!Send(slice)) return InsertResult.Blocked;
            Thread.Sleep(BatchPauseMs);
        }
        return InsertResult.Done;
    }

    public static InsertResult Paste(string text, CancellationToken cancellationToken = default) =>
        Paste(text, cancellationToken, default);

    public static InsertResult Paste(string text, CancellationToken cancellationToken, PhraseClipboardOptions clip)
    {
        ClipboardGate.Wait(cancellationToken);
        bool restoreOwnsGate = false;
        try
        {
            var ui = Application.Current.Dispatcher;
            cancellationToken.ThrowIfCancellationRequested();
            if (ui.HasShutdownStarted || ui.HasShutdownFinished) return InsertResult.Blocked;
            IDataObject? saved = null;
            uint sequence = 0;

            bool placed = ui.Invoke(() =>
            {
                saved = Snapshot();
                try
                {
                    if (clip.Keep)
                    {
                        // Plain text, no exclude formats: the clipboard history service records it.
                        Clipboard.SetText(text);
                    }
                    else
                    {
                        var data = new DataObject();
                        data.SetData(DataFormats.UnicodeText, text);
                        // Windows honours these formats: no Clipboard History entry, no cloud sync.
                        data.SetData("ExcludeClipboardContentFromMonitorProcessing", new MemoryStream(new byte[4]));
                        data.SetData("CanIncludeInClipboardHistory", new MemoryStream(new byte[4]));
                        data.SetData("CanUploadToCloudClipboard", new MemoryStream(new byte[4]));
                        Clipboard.SetDataObject(data, true);
                    }
                    sequence = Native.GetClipboardSequenceNumber();
                    return true;
                }
                catch (Exception e)
                {
                    Log.Write($"clipboard set failed, typing instead: {e.Message}");
                    return false;
                }
            });
            if (!placed)
            {
                var typed = Type(text);
                if (typed == InsertResult.Done && clip.Keep)
                {
                    uint seq = 0;
                    bool again = ui.Invoke(() =>
                    {
                        try
                        {
                            Clipboard.SetText(text);
                            seq = Native.GetClipboardSequenceNumber();
                            return true;
                        }
                        catch (Exception e)
                        {
                            Log.Write($"phrase clipboard set failed: {e.Message}");
                            return false;
                        }
                    });
                    if (again && clip.RestoreIfHistoryKeepsIt)
                        KeepOrRestoreAsync(ui, text, saved, seq, cancellationToken).GetAwaiter().GetResult();
                }
                return typed;
            }

            var ok = Send(new[]
            {
                Key(Native.VK_CONTROL, 0, 0),
                Key(Native.VK_V, 0, 0),
                Key(Native.VK_V, 0, Native.KEYEVENTF_KEYUP),
                Key(Native.VK_CONTROL, 0, Native.KEYEVENTF_KEYUP),
            });
            if (!ok) return InsertResult.Blocked;   // our text stays on the clipboard so the user can paste by hand

            // Recording may resume as soon as Ctrl+V is sent. Keep clipboard operations serialized
            // until the target has had time to read it, even when there is no snapshot to restore.
            restoreOwnsGate = true;
            if (clip.Keep)
                _ = RestoreKeepingHistoryAsync(ui, text, saved, sequence, clip.RestoreIfHistoryKeepsIt, cancellationToken);
            else
                _ = RestoreClipboardAsync(ui, saved, sequence, cancellationToken);
            return InsertResult.Done;
        }
        finally
        {
            if (!restoreOwnsGate) ClipboardGate.Release();
        }
    }

    /// <summary>Copy the finished phrase. Used when insertion itself does not touch the clipboard.</summary>
    private static async Task RememberAsync(string text, bool restoreIfHistoryKeepsIt, CancellationToken cancellationToken)
    {
        try
        {
            ClipboardGate.Wait(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return;
        }
        var ui = Application.Current.Dispatcher;
        try
        {
            if (cancellationToken.IsCancellationRequested || ui.HasShutdownStarted || ui.HasShutdownFinished) return;
            IDataObject? saved = null;
            uint sequence = 0;
            bool placed = ui.Invoke(() =>
            {
                saved = Snapshot();
                try
                {
                    Clipboard.SetText(text);
                    sequence = Native.GetClipboardSequenceNumber();
                    return true;
                }
                catch (Exception e)
                {
                    Log.Write($"phrase clipboard set failed: {e.Message}");
                    return false;
                }
            });
            if (!placed || !restoreIfHistoryKeepsIt) return;
            await KeepOrRestoreAsync(ui, text, saved, sequence, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            ClipboardGate.Release();
        }
    }

    /// <summary>
    /// The phrase is already the current clipboard, which is what puts it into Win+V when history is on.
    /// Windows has no API that inserts into history without also making the text current.
    /// Wait until the history service has the phrase, then put the previous clipboard back.
    /// If history is off, or the phrase is not in history after the restore, put the phrase back
    /// and leave it current. The dictated phrase is never dropped on the floor.
    /// </summary>
    private static async Task RestoreKeepingHistoryAsync(Dispatcher ui, string text, IDataObject? saved, uint sequence,
        bool restore, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(ClipboardRestoreDelayMs, cancellationToken).ConfigureAwait(false);
            if (!restore || ui.HasShutdownStarted || ui.HasShutdownFinished) return;
            await KeepOrRestoreAsync(ui, text, saved, sequence, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested || ui.HasShutdownStarted)
        {
        }
        catch (Exception e)
        {
            Log.Write($"clipboard history restore failed: {e.Message}");
        }
        finally
        {
            ClipboardGate.Release();
        }
    }

    private static async Task KeepOrRestoreAsync(Dispatcher ui, string text, IDataObject? saved, uint sequence,
        CancellationToken cancellationToken)
    {
        if (!await WaitUntilHistoryHasAsync(text, cancellationToken).ConfigureAwait(false))
        {
            Log.Write("clipboard history does not have the phrase; leaving it as the current clipboard");
            return;
        }
        bool restored = false;
        await ui.InvokeAsync(() =>
        {
            if (cancellationToken.IsCancellationRequested || ui.HasShutdownStarted) return;
            if (sequence != 0 && Native.GetClipboardSequenceNumber() != sequence) return;
            try
            {
                if (saved != null) Clipboard.SetDataObject(saved, true);
                else Clipboard.Clear();
                restored = true;
            }
            catch (Exception e) { Log.Write($"clipboard restore failed: {e.Message}"); }
        }, DispatcherPriority.Normal, cancellationToken).Task.ConfigureAwait(false);
        if (!restored) return;
        if (await WaitUntilHistoryHasAsync(text, cancellationToken).ConfigureAwait(false)) return;
        Log.Write("restore dropped the phrase from clipboard history; putting the phrase back");
        await ui.InvokeAsync(() =>
        {
            try { Clipboard.SetText(text); }
            catch (Exception e) { Log.Write($"phrase clipboard restore failed: {e.Message}"); }
        }).Task.ConfigureAwait(false);
    }

    private static async Task<bool> WaitUntilHistoryHasAsync(string text, CancellationToken cancellationToken)
    {
        if (!HistoryEnabled()) return false;
        var deadline = DateTime.UtcNow.AddMilliseconds(1200);
        while (true)
        {
            if (await HistoryHasAsync(text).ConfigureAwait(false)) return true;
            if (DateTime.UtcNow >= deadline) return false;
            await Task.Delay(150, cancellationToken).ConfigureAwait(false);
        }
    }

    private static bool HistoryEnabled()
    {
        try
        {
            return WinClip.IsHistoryEnabled();
        }
        catch (Exception e)
        {
            Log.Write($"IsHistoryEnabled failed: {e.GetType().Name}");
        }
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Clipboard");
            return key?.GetValue("EnableClipboardHistory") is int v && v != 0;
        }
        catch { return false; }
    }

    private static async Task<bool> HistoryHasAsync(string text)
    {
        try
        {
            WinTransfer.ClipboardHistoryItemsResult result = await WinClip.GetHistoryItemsAsync();
            if (result.Status != WinTransfer.ClipboardHistoryItemsResultStatus.Success) return false;
            int seen = 0;
            foreach (WinTransfer.ClipboardHistoryItem item in result.Items)
            {
                if (seen++ >= 25) break;
                try
                {
                    if (!item.Content.Contains(WinTransfer.StandardDataFormats.Text)) continue;
                    string got = await item.Content.GetTextAsync();
                    if (string.Equals(got.Trim(), text.Trim(), StringComparison.Ordinal)) return true;
                }
                catch { /* a history item the shell will not give us as text */ }
            }
            return false;
        }
        catch (Exception e)
        {
            Log.Write($"clipboard history read failed: {e.GetType().Name}: {e.Message}");
            return false;
        }
    }

    private static async Task RestoreClipboardAsync(Dispatcher ui, IDataObject? saved, uint sequence,
        CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(ClipboardRestoreDelayMs, cancellationToken).ConfigureAwait(false);
            if (saved == null || sequence == 0 || ui.HasShutdownStarted || ui.HasShutdownFinished) return;
            await ui.InvokeAsync(() =>
            {
                if (cancellationToken.IsCancellationRequested || ui.HasShutdownStarted) return;
                if (Native.GetClipboardSequenceNumber() == sequence)
                    Clipboard.SetDataObject(saved, true);
            }, DispatcherPriority.Normal, cancellationToken).Task.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested || ui.HasShutdownStarted)
        {
        }
        catch (Exception e)
        {
            Log.Write($"clipboard restore failed: {e.Message}");
        }
        finally
        {
            ClipboardGate.Release();
        }
    }

    /// <summary>
    /// Fallback for apps that do not tell UI Automation what is selected: presses Ctrl+C, reads the copied
    /// text and puts the previous clipboard back. Returns null when nothing was selected (the clipboard did
    /// not change). Call from a worker thread.
    /// </summary>
    public static string? CopySelection(CancellationToken cancellationToken = default)
    {
        try
        {
            ClipboardGate.Wait(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        try
        {
            var ui = Application.Current.Dispatcher;
            if (cancellationToken.IsCancellationRequested || ui.HasShutdownStarted || ui.HasShutdownFinished) return null;
            IDataObject? saved = ui.Invoke(Snapshot);
            uint before = Native.GetClipboardSequenceNumber();
            if (!Send(new[]
                {
                    Key(Native.VK_CONTROL, 0, 0),
                    Key(Native.VK_C, 0, 0),
                    Key(Native.VK_C, 0, Native.KEYEVENTF_KEYUP),
                    Key(Native.VK_CONTROL, 0, Native.KEYEVENTF_KEYUP),
                }))
                return null;

            // The app copies asynchronously; a change of the clipboard sequence number means it did.
            var deadline = DateTime.UtcNow.AddMilliseconds(400);
            while (Native.GetClipboardSequenceNumber() == before && DateTime.UtcNow < deadline)
            {
                if (cancellationToken.IsCancellationRequested) return null;
                Thread.Sleep(15);
            }
            if (Native.GetClipboardSequenceNumber() == before) return null;
            if (cancellationToken.IsCancellationRequested || ui.HasShutdownStarted || ui.HasShutdownFinished) return null;

            return ui.Invoke(() =>
            {
                string? text = null;
                try { if (Clipboard.ContainsText()) text = Clipboard.GetText(); }
                catch (Exception e) { Log.Write($"clipboard read failed: {e.Message}"); }
                try
                {
                    if (saved != null) Clipboard.SetDataObject(saved, true);
                    else Clipboard.Clear();
                }
                catch (Exception e) { Log.Write($"clipboard restore failed: {e.Message}"); }
                return string.IsNullOrWhiteSpace(text) ? null : text;
            });
        }
        finally
        {
            ClipboardGate.Release();
        }
    }

    /// <summary>Deep copy of the current clipboard: the live object belongs to another app and dies when we replace it.</summary>
    private static IDataObject? Snapshot()
    {
        try
        {
            var live = Clipboard.GetDataObject();
            if (live == null) return null;
            var copy = new DataObject();
            int formats = 0;
            foreach (var format in live.GetFormats(false))
            {
                try
                {
                    var value = live.GetData(format, false);
                    if (value == null) continue;
                    copy.SetData(format, value);
                    formats++;
                }
                catch { /* delayed-render or private format: skip it */ }
            }
            return formats > 0 ? copy : null;
        }
        catch (Exception e)
        {
            Log.Write($"clipboard snapshot failed: {e.Message}");
            return null;
        }
    }

    private static bool Send(Native.INPUT[] inputs)
    {
        uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Native.INPUT>());
        if (sent == inputs.Length) return true;
        int error = Marshal.GetLastWin32Error();
        Log.Write($"SendInput sent {sent}/{inputs.Length}, error {error}" + (error == ErrorAccessDenied ? " (target runs elevated)" : ""));
        return false;
    }

    private static Native.INPUT Key(ushort vk, ushort scan, uint flags) => new()
    {
        type = Native.INPUT_KEYBOARD,
        u = new Native.INPUTUNION { ki = new Native.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } },
    };
}
