// Usage: InsertTarget.exe <report file> <command file>
// Shows a focused text box, puts "OLD clipboard" on the clipboard, then every 100 ms writes
// "text\tclipboard" (base64 each) to the report file. Commands from the command file: "selectall".

using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class Program
{
    private static string B64(string s) => Convert.ToBase64String(Encoding.UTF8.GetBytes(s ?? ""));

    [STAThread]
    private static void Main(string[] args)
    {
        string report = args[0], commands = args[1];
        var form = new Form { Text = "InsertTarget", Width = 600, Height = 300, TopMost = true };
        var box = new TextBox { Multiline = true, Dock = DockStyle.Fill, AcceptsReturn = true };
        form.Controls.Add(box);
        Clipboard.SetText("OLD clipboard");
        var timer = new Timer { Interval = 100 };
        timer.Tick += (_, _) =>
        {
            if (File.Exists(commands))
            {
                var cmd = File.ReadAllText(commands).Trim();
                File.Delete(commands);
                if (cmd == "selectall") { box.Focus(); box.SelectAll(); }
            }
            string clip = "";
            try { clip = Clipboard.ContainsText() ? Clipboard.GetText() : "<none>"; } catch (Exception e) { clip = "<err " + e.Message + ">"; }
            File.WriteAllText(report + ".tmp", B64(box.Text) + "\t" + B64(clip) + "\t" + (Form.ActiveForm == form ? "active" : "inactive"));
            File.Copy(report + ".tmp", report, true);
        };
        form.Shown += (_, _) => { form.Activate(); box.Focus(); timer.Start(); };
        Application.Run(form);
    }
}
