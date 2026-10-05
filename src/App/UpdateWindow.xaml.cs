// "A new version is out": notes and a button that opens the release page.
// Nothing is downloaded or installed from here.

using System.Diagnostics;
using System.Windows;

namespace ChawoVA.App;

public partial class UpdateWindow : Window
{
    private readonly UpdateInfo _info;

    public UpdateWindow(UpdateInfo info, Action quit)
    {
        _info = info;
        _ = quit;
        InitializeComponent();
        Title = ChawoApp.ProductName;
        Heading.Text = L.T($"Вышла версия {info.Version}", $"Version {info.Version} is out");
        var notes = L.Russian || string.IsNullOrWhiteSpace(info.NotesEn) ? info.Notes : info.NotesEn;
        Notes.Text = string.IsNullOrWhiteSpace(notes)
            ? L.T($"У вас {ChawoApp.Version}. Новую версию программа сама не скачивает.",
                  $"You have {ChawoApp.Version}. The app does not download the new version.")
            : notes.Trim();
        Notes.Text += L.T($"\n\nСтраница: {info.Url}\nПрограмма сама ничего не скачивает и не устанавливает.",
                          $"\n\nPage: {info.Url}\nThe app does not download or install it.");
        LaterButton.Content = L.T("Позже", "Later");
        UpdateButton.Content = L.T("Открыть страницу релиза", "Open the release page");
    }

    private void Update_Click(object sender, RoutedEventArgs e)
    {
        try { Process.Start(new ProcessStartInfo(_info.Url) { UseShellExecute = true }); }
        catch { }
        Close();
    }

    private void Later_Click(object sender, RoutedEventArgs e) => Close();
}
