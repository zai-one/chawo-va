// Reads the text selected in the app the user works in, for Brain commands on a selection ("select,
// hold the key, say what to do with it"). Port of src/App/SelectionReader.cs.
//
// UI Automation first: no side effects and no false positives. Only when the app does not expose its
// text that way at all (LibreOffice, some Qt and Java apps) does the worker press Ctrl+C and put the
// clipboard back. An app that answers "nothing selected" through UI Automation is believed: VS Code,
// for one, copies the whole line on Ctrl+C without a selection. Terminals are skipped (Ctrl+C means
// "stop" there), and so are spreadsheets, where a cell is always selected and every dictation would
// turn into a command on it. The selected text itself is never logged.

using System;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace ChawoNative;

internal static class SelectionReader
{
    public const int MaxChars = 20_000;
    /// <summary>UI Automation can block on a busy app; we stop waiting after this (the app side waits 1.5 s in all).</summary>
    private const int UiaTimeoutMs = 1200;

    private static readonly string[] TerminalClasses =
        { "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "mintty", "PuTTY", "VirtualConsoleClass" };

    /// <summary>Spreadsheets: a cell is always selected, so Ctrl+C would always "find" a selection.</summary>
    private static readonly string[] SpreadsheetClasses = { "XLMAIN" };
    private static readonly string[] SpreadsheetTitles = { "LibreOffice Calc", "OpenOffice Calc", "WPS Spreadsheets" };

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);

    /// <summary>What UI Automation could tell: the text, "nothing selected", or "this app does not say".</summary>
    public enum Answer { Text, Nothing, Unsupported }

    /// <summary>A UI Automation read that has not finished yet (a hung app): no new ones pile up behind it.</summary>
    private static Thread? _inFlight;

    /// <summary>
    /// The selected text, or null when there is none or it cannot be read in time. <paramref name="copy"/>
    /// is the Ctrl+C fallback (runs on the caller's thread, which owns the clipboard window).
    /// </summary>
    public static string? TryGet(Func<string?> copy)
    {
        var fg = Win32.GetForegroundWindow();
        if (fg == IntPtr.Zero) return null;
        string cls = ClassOf(fg);
        if (TerminalClasses.Contains(cls)) { Program.Log("selection: terminal, skipped"); return null; }
        if (_inFlight is { IsAlive: true }) { Program.Log("selection: previous read still hangs"); return null; }
        bool spreadsheet = SpreadsheetClasses.Contains(cls) || SpreadsheetTitles.Any(t => TitleOf(fg).EndsWith(t, StringComparison.OrdinalIgnoreCase));

        Answer answer = Answer.Unsupported;
        string? text = null;
        var thread = new Thread(() =>
        {
            // Read() is compiled only when called: if UI Automation cannot even load (it ships with every
            // Windows 10/11, but not with Wine), the failure lands here instead of killing the helper.
            try { var r = Read(); answer = r.Item1; text = r.Item2; }
            catch (Exception e) { Program.Log($"selection: UI Automation unavailable ({e.GetType().Name})"); }
        })
            { IsBackground = true, Name = "ChawoNative.Selection" };
        thread.SetApartmentState(ApartmentState.MTA);
        _inFlight = thread;
        thread.Start();
        if (!thread.Join(UiaTimeoutMs)) { Program.Log("selection: UI Automation timed out"); return null; }
        if (answer == Answer.Text) Program.Log($"selection: via UI Automation, {text!.Length} chars");
        if (answer != Answer.Unsupported || spreadsheet) return text;
        var copied = copy();
        if (copied != null) Program.Log($"selection: via Ctrl+C, {copied.Length} chars");
        return Clip(copied);
    }

    public static string? Clip(string? s) => s != null && s.Length > MaxChars ? s.Substring(0, MaxChars) : s;

    private static string ClassOf(IntPtr hwnd)
    {
        var sb = new StringBuilder(128);
        GetClassName(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string TitleOf(IntPtr hwnd)
    {
        var sb = new StringBuilder(512);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static Tuple<Answer, string?> Read()
    {
        try
        {
            var focused = AutomationElement.FocusedElement;
            if (focused == null) return Tuple.Create<Answer, string?>(Answer.Unsupported, null);
            if (!focused.TryGetCurrentPattern(TextPattern.Pattern, out var p) || p is not TextPattern text)
                return Tuple.Create<Answer, string?>(Answer.Unsupported, null);
            var ranges = text.GetSelection();
            if (ranges.Length == 0) return Tuple.Create<Answer, string?>(Answer.Nothing, null);
            var sb = new StringBuilder();
            foreach (TextPatternRange r in ranges)
            {
                sb.Append(r.GetText(MaxChars - sb.Length));
                if (sb.Length >= MaxChars) break;
            }
            var s = sb.ToString();
            return s.Trim().Length == 0 ? Tuple.Create<Answer, string?>(Answer.Nothing, null) : Tuple.Create<Answer, string?>(Answer.Text, s);
        }
        catch (Exception e)
        {
            Program.Log($"selection: {e.GetType().Name}");
            return Tuple.Create<Answer, string?>(Answer.Unsupported, null);
        }
    }
}
