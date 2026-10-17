// Win32 interop for the helper. Same declarations as src/App/Native.cs in the WPF app.

using System;
using System.Runtime.InteropServices;

namespace ChawoNative;

internal static class Win32
{
    public const int WH_KEYBOARD_LL = 13;
    public const int WH_MOUSE_LL = 14;
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_LBUTTONUP = 0x0202;
    public const uint LLMHF_INJECTED = 0x01;
    public const int SM_CXDOUBLECLK = 36;
    public const int SM_CYDOUBLECLK = 37;
    public const int SM_CXDRAG = 68;
    public const int SM_CYDRAG = 69;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_KEYUP = 0x0101;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int WM_SYSKEYUP = 0x0105;
    public const uint WM_QUIT = 0x0012;
    public const uint LLKHF_INJECTED = 0x10;
    public const uint LLKHF_EXTENDED = 0x01;

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const ushort VK_CONTROL = 0x11;
    public const ushort VK_LCONTROL = 0xA2;
    public const ushort VK_RETURN = 0x0D;
    public const ushort VK_V = 0x56;
    public const ushort VK_C = 0x43;

    public const uint CF_UNICODETEXT = 13;
    public const uint GMEM_MOVEABLE = 0x0002;
    public const uint PM_REMOVE = 0x0001;
    public const uint QS_ALLINPUT = 0x04FF;
    public const uint WAIT_OBJECT_0 = 0;
    public const uint WAIT_TIMEOUT = 0x102;
    public static readonly IntPtr HWND_MESSAGE = new(-3);

    public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;   // never used, but it sets the union size (INPUT is 40 bytes on x64)
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowsHookEx")]
    public static extern IntPtr SetWindowsHookExMouse(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    public static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandle(string? lpModuleName);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    public static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);
    [DllImport("user32.dll")]
    public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    public static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint MsgWaitForMultipleObjects(uint nCount, IntPtr[] pHandles, bool bWaitAll, uint dwMilliseconds, uint dwWakeMask);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style,
        int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")]
    public static extern bool CloseClipboard();
    [DllImport("user32.dll")]
    public static extern bool EmptyClipboard();
    [DllImport("user32.dll")]
    public static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll")]
    public static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetClipboardData(uint format, IntPtr hMem);
    [DllImport("user32.dll")]
    public static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern uint RegisterClipboardFormat(string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GlobalFree(IntPtr hMem);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")]
    public static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll")]
    public static extern UIntPtr GlobalSize(IntPtr hMem);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
