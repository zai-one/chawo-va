// Asks Windows not to idle-sleep this PC. Does not block the user from
// shutting down by hand. Cleared when the checkbox is off or the listener stops.

using System.Runtime.InteropServices;

namespace ChawoVA.App;

internal static class KeepAwake
{
    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint esFlags);

    public static void PreventSleep() => SetThreadExecutionState(EsContinuous | EsSystemRequired);

    public static void AllowSleep() => SetThreadExecutionState(EsContinuous);
}
