// Global push-to-talk key: port of src/App/KeyboardHook.cs. A low-level keyboard hook sees the key
// before any application does; we swallow it so the app underneath never notices it being held.
//
// The hook lives on its own thread with its own message loop. Windows silently removes the hook if the
// callback is not serviced within a few hundred milliseconds, so the callback only flips flags and
// queues a line for the stdout writer thread; it never touches the clipboard, stdin or stdout itself.

using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace ChawoNative;

internal sealed class Hook
{
    /// <summary>Settings.LeftCtrlWinHotkey in the WPF app: Left Ctrl + Win as one hold key.</summary>
    public const int LeftCtrlWin = 0x10000;

    private readonly Win32.LowLevelKeyboardProc _proc;   // kept alive for the unmanaged side
    private readonly Action<string> _emit;
    private readonly ManualResetEventSlim _ready = new(false);
    private IntPtr _hook;
    private uint _threadId;
    private string? _installError;
    private volatile int _hotkeyVk;
    private volatile bool _armCancel;
    private bool _down;
    private bool _escapeLatched;
    private int _activeWinVk;
    private int _activeSingleVk;

    public int HotkeyVk { get => _hotkeyVk; set => _hotkeyVk = value; }

    /// <summary>While set, Escape is swallowed and "esc" goes out once per press.</summary>
    public bool ArmCancel { get => _armCancel; set => _armCancel = value; }

    public Hook(int hotkeyVk, Action<string> emit)
    {
        _hotkeyVk = hotkeyVk;
        _emit = emit;
        _proc = Callback;
    }

    /// <summary>Installs the hook on its own thread. Returns null on success, else the reason.</summary>
    public string? Start()
    {
        var thread = new Thread(Run) { IsBackground = true, Name = "ChawoNative.Hook", Priority = ThreadPriority.Highest };
        thread.Start();
        _ready.Wait();
        return _installError;
    }

    private void Run()
    {
        _threadId = Win32.GetCurrentThreadId();
        _hook = Win32.SetWindowsHookEx(Win32.WH_KEYBOARD_LL, _proc, Win32.GetModuleHandle(null), 0);
        if (_hook == IntPtr.Zero)
            _installError = "SetWindowsHookEx failed: " + Marshal.GetLastWin32Error();
        _ready.Set();
        if (_hook == IntPtr.Zero) return;

        while (Win32.GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            Win32.TranslateMessage(ref msg);
            Win32.DispatchMessage(ref msg);
        }
        Win32.UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
    }

    public void Stop()
    {
        if (_threadId != 0) Win32.PostThreadMessage(_threadId, Win32.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    }

    private IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var info = Marshal.PtrToStructure<Win32.KBDLLHOOKSTRUCT>(lParam);
            bool injected = (info.flags & Win32.LLKHF_INJECTED) != 0;
            if (!injected)
            {
                int msg = (int)wParam;
                bool keyDown = msg == Win32.WM_KEYDOWN || msg == Win32.WM_SYSKEYDOWN;
                bool keyUp = msg == Win32.WM_KEYUP || msg == Win32.WM_SYSKEYUP;
                int vk = info.vkCode == Win32.VK_CONTROL
                    ? (info.flags & Win32.LLKHF_EXTENDED) != 0 ? 0xA3 : 0xA2
                    : (int)info.vkCode;

                if (vk == 0x1B && _armCancel)
                {
                    if (keyDown && !_escapeLatched)
                    {
                        _escapeLatched = true;
                        _emit("esc");
                    }
                    else if (keyUp)
                        _escapeLatched = false;
                    return (IntPtr)1;
                }

                if (vk == Win32.VK_LCONTROL && keyUp && _activeWinVk != 0 && _down)
                {
                    _down = false;
                    _emit("up");
                }

                if (vk == _activeWinVk)
                {
                    if (keyUp)
                    {
                        _activeWinVk = 0;
                        if (_down) { _down = false; _emit("up"); }
                    }
                    return (IntPtr)1;
                }

                if (vk == _activeSingleVk)
                {
                    if (keyUp)
                    {
                        _activeSingleVk = 0;
                        if (_down) { _down = false; _emit("up"); }
                    }
                    return (IntPtr)1;
                }

                if (_hotkeyVk == LeftCtrlWin)
                {
                    // The real key state, not a remembered flag: a key-up on the secure desktop (UAC,
                    // Ctrl+Alt+Del) never reaches the hook and would leave Win swallowed for good.
                    if (keyDown && (vk == 0x5B || vk == 0x5C) && (Win32.GetAsyncKeyState(Win32.VK_LCONTROL) & 0x8000) != 0)
                    {
                        _activeWinVk = vk;
                        _down = true;
                        _emit("down");
                        return (IntPtr)1;
                    }
                }
                else if (vk == _hotkeyVk && keyDown)
                {
                    _activeSingleVk = vk;
                    _down = true;
                    _emit("down");
                    return (IntPtr)1;
                }
            }
        }
        return Win32.CallNextHookEx(_hook, nCode, wParam, lParam);
    }
}
