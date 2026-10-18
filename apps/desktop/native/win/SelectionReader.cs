// Reads the text selected in the app the user works in, for Brain commands on a selection ("select,
// hold the key, say what to do with it") and for reading it aloud. Port of src/App/SelectionReader.cs.
//
// UI Automation first: no side effects and no false positives. The focused element is asked, then the
// elements around it: a browser leaves the focus on a link or a field inside the selected stretch, and
// the selection belongs to the page. Only when the app does not expose its text that way at all
// (LibreOffice, some Qt and Java apps) does the worker press Ctrl+C and put the clipboard back. For a
// command, an app that answers "nothing selected" through UI Automation is believed: VS Code, for one,
// copies the whole line on Ctrl+C without a selection. Reading aloud is asked for on purpose, so there
// Ctrl+C goes after anything UI Automation missed. Terminals are skipped (Ctrl+C means "stop" there),
// and for commands so are spreadsheets, where a cell is always selected and every dictation would turn
// into a command on it. The selected text itself is never logged.

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
    /// <summary>Elements asked from the focus up: a link, its paragraph, the page and a few wrappers.</summary>
    private const int MaxDepth = 12;

    private static readonly string[] TerminalClasses =
        { "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "mintty", "PuTTY", "VirtualConsoleClass" };

    /// <summary>Spreadsheets: a cell is always selected, so Ctrl+C would always "find" a selection.</summary>
    private static readonly string[] SpreadsheetClasses = { "XLMAIN" };
    private static readonly string[] SpreadsheetTitles = { "LibreOffice Calc", "OpenOffice Calc", "WPS Spreadsheets" };

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);

    /// <summary>What UI Automation could tell: the text, "nothing selected", "this app does not say", or no answer in time.</summary>
    public enum Answer { Text, Nothing, Unsupported, Late }

    /// <summary>A UI Automation read that has not finished yet (a hung app): no new ones pile up behind it.</summary>
    private static Thread? _inFlight;

    /// <summary>
    /// The selected text, or null when there is none or it cannot be read in time. <paramref name="copy"/>
    /// is the Ctrl+C fallback (runs on the caller's thread, which owns the clipboard window). With
    /// <paramref name="toSpeak"/> it runs whenever UI Automation gave no text, spreadsheets included.
    /// </summary>
    public static string? TryGet(Func<string?> copy, bool toSpeak = false)
    {
        var fg = Win32.GetForegroundWindow();
        if (fg == IntPtr.Zero) return null;
        string cls = ClassOf(fg);
        if (TerminalClasses.Contains(cls)) { Program.Log("selection: terminal, skipped"); return null; }
        bool spreadsheet = SpreadsheetClasses.Contains(cls) || SpreadsheetTitles.Any(t => TitleOf(fg).EndsWith(t, StringComparison.OrdinalIgnoreCase));

        var (answer, text) = Ask();
        if (answer == Answer.Text) { Program.Log($"selection: via UI Automation, {text!.Length} chars"); return text; }
        if (!toSpeak && (answer != Answer.Unsupported || spreadsheet)) return null;
        var copied = copy();
        if (copied != null) Program.Log($"selection: via Ctrl+C, {copied.Length} chars");
        return Clip(copied);
    }

    /// <summary>UI Automation on its own thread, given up after UiaTimeoutMs (a hung app answers Late).</summary>
    private static (Answer, string?) Ask()
    {
        if (_inFlight is { IsAlive: true }) { Program.Log("selection: previous read still hangs"); return (Answer.Late, null); }
        (Answer, string?) result = (Answer.Unsupported, null);
        var thread = new Thread(() =>
        {
            // Read() is compiled only when called: if UI Automation cannot even load (it ships with every
            // Windows 10/11, but not with Wine), the failure lands here instead of killing the helper.
            try { result = Read(); }
            catch (Exception e) { Program.Log($"selection: UI Automation unavailable ({e.GetType().Name})"); }
        })
            { IsBackground = true, Name = "ChawoNative.Selection" };
        thread.SetApartmentState(ApartmentState.MTA);
        _inFlight = thread;
        thread.Start();
        if (thread.Join(UiaTimeoutMs)) return result;
        Program.Log("selection: UI Automation timed out");
        return (Answer.Late, null);
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
    private static (Answer, string?) Read()
    {
        var answer = Answer.Unsupported;
        try
        {
            var element = AutomationElement.FocusedElement;
            for (int depth = 0; element != null && depth < MaxDepth; depth++)
            {
                if (element.TryGetCurrentPattern(TextPattern.Pattern, out var p) && p is TextPattern pattern)
                {
                    var sb = new StringBuilder();
                    foreach (TextPatternRange r in pattern.GetSelection())
                    {
                        sb.Append(r.GetText(MaxChars - sb.Length));
                        if (sb.Length >= MaxChars) break;
                    }
                    var s = sb.ToString();
                    if (s.Trim().Length > 0) return (Answer.Text, s);
                    answer = Answer.Nothing;
                }
                element = TreeWalker.ControlViewWalker.GetParent(element);
            }
        }
        catch (Exception e)
        {
            // An element gone mid-walk (the page changed under us): what was learned so far stands.
            Program.Log($"selection: {e.GetType().Name}");
        }
        return (answer, null);
    }
}
