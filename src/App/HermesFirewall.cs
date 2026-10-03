// One elevated command that allows inbound TCP for the Hermes port.
// Windows shows the usual UAC prompt. The rule is named so it can be found
// in Windows Defender Firewall.

using System.Diagnostics;

namespace GigaPisar.App;

public static class HermesFirewall
{
    public const string RuleName = "Giga Pisar Hermes";

    /// <summary>Adds an inbound allow rule for every profile. Returns false if UAC is cancelled or netsh fails.</summary>
    public static bool TryOpenPort(int port, out string error)
    {
        var bat = Path.Combine(Path.GetTempPath(), "giga-pisar-hermes-firewall.cmd");
        // delete is best-effort (it fails when the rule is not there yet). add decides the exit code.
        File.WriteAllText(bat,
            "@echo off\r\n" +
            $"netsh advfirewall firewall delete rule name=\"{RuleName}\" protocol=TCP localport={port} >nul 2>&1\r\n" +
            $"netsh advfirewall firewall add rule name=\"{RuleName}\" dir=in action=allow protocol=TCP localport={port}\r\n" +
            "exit /b %ERRORLEVEL%\r\n");
        try
        {
            // One UAC prompt. -Wait so we know whether the rule landed before we bind.
            string script =
                "$p = Start-Process -FilePath cmd.exe -ArgumentList @('/c', " + PsQuote(bat) + ") " +
                "-Verb RunAs -WindowStyle Hidden -Wait -PassThru; " +
                "if ($null -eq $p) { exit 1 }; exit $p.ExitCode";
            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -Command " + PsQuote(script),
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var process = Process.Start(psi);
            if (process == null)
            {
                error = "powershell did not start";
                return false;
            }
            if (!process.WaitForExit(120_000))
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                error = "timed out waiting for the firewall prompt";
                return false;
            }
            if (process.ExitCode != 0)
            {
                error = "netsh exit " + process.ExitCode;
                return false;
            }
            error = "";
            return true;
        }
        catch (Exception e)
        {
            error = e.Message;
            return false;
        }
    }

    /// <summary>Opens the Windows Firewall console so the rule can be checked by hand.</summary>
    public static void OpenConsole()
    {
        try { Process.Start(new ProcessStartInfo("WF.msc") { UseShellExecute = true }); }
        catch (Exception e) { Log.Write($"firewall console: {e.Message}"); }
    }

    private static string PsQuote(string text) => "'" + text.Replace("'", "''") + "'";
}
