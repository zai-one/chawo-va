// Progress window for one-time downloads: the speech model on first run, the local Brain on request.

using System.Windows;
using GigaPisar.Core;

namespace GigaPisar.App;

public partial class DownloadWindow : Window
{
    private CancellationTokenSource? _cts;
    private TaskCompletionSource<bool>? _done;
    private readonly Func<IProgress<ModelDownloader.Progress>, CancellationToken, Task> _work;
    private readonly string _spaceNeeded;
    private readonly bool _manualStart;

    /// <summary>Speech-model download. When manualStart is set, nothing is fetched until the button is pressed.</summary>
    public DownloadWindow(SpeechModelKind kind, bool manualStart)
        : this(L.T("Модель распознавания", "Speech model"),
               kind == SpeechModelKind.V3E2eRnnt
                   ? L.T("GigaAM v3 e2e RNN-T, русский, с пунктуацией, около 220 МБ. Звук остаётся на этом компьютере. Само ничего не скачивается.",
                         "GigaAM v3 e2e RNN-T, Russian, with punctuation, about 220 MB. Audio stays on this computer. Nothing downloads by itself.")
                   : L.T("GigaAM Multilingual Large CTC, 600 миллионов параметров, русский и английский, около 2,4 ГБ. Звук остаётся на этом компьютере. Само ничего не скачивается.",
                         "GigaAM Multilingual Large CTC, 600 million parameters, Russian and English, about 2.4 GB. Audio stays on this computer. Nothing downloads by itself."),
               (progress, ct) => ModelDownloader.DownloadAsync(kind, Settings.ModelDirectory(kind), progress, ct),
               kind == SpeechModelKind.V3E2eRnnt ? L.T("1 ГБ", "1 GB") : L.T("4 ГБ", "4 GB"),
               manualStart)
    {
    }

    public DownloadWindow(string heading, string intro, Func<IProgress<ModelDownloader.Progress>, CancellationToken, Task> work,
        string spaceNeeded, bool manualStart = false)
    {
        _work = work;
        _spaceNeeded = spaceNeeded;
        _manualStart = manualStart;
        InitializeComponent();
        Title = L.T("Chawo VA", "Chawo VA");
        Heading.Text = heading;
        Intro.Text = intro;
        DownloadButton.Content = L.T("Скачать", "Download");
        RetryButton.Content = L.T("Повторить", "Retry");
        CancelButton.Content = manualStart ? L.T("Не сейчас", "Not now") : L.T("Отмена", "Cancel");
        if (manualStart) DownloadButton.Visibility = Visibility.Visible;
    }

    /// <summary>Shows the window. Downloads immediately unless this is the button-first speech prompt.</summary>
    public Task<bool> RunAsync()
    {
        _done = new TaskCompletionSource<bool>();
        Closed += (_, _) => _done.TrySetResult(false);
        Show();
        if (_manualStart)
            Status.Text = L.T("Нажмите «Скачать». Пока кнопка не нажата, в сеть ничего не уходит.",
                              "Press Download. Nothing goes out on the network until you do.");
        else
            _ = StartAsync();
        return _done.Task;
    }

    private void Download_Click(object sender, RoutedEventArgs e)
    {
        DownloadButton.Visibility = Visibility.Collapsed;
        CancelButton.Content = L.T("Отмена", "Cancel");
        _ = StartAsync();
    }

    private async Task StartAsync()
    {
        RetryButton.Visibility = Visibility.Collapsed;
        Bar.IsIndeterminate = true;
        Status.Text = L.T("Соединяюсь…", "Connecting…");
        _cts = new CancellationTokenSource();
        var progress = new Progress<ModelDownloader.Progress>(p =>
        {
            switch (p.Stage)
            {
                case "download":
                    Bar.IsIndeterminate = p.Total <= 0;
                    if (p.Total > 0)
                    {
                        Bar.Value = 100.0 * p.Received / p.Total;
                        Status.Text = L.T($"Скачано {p.Received / 1048576} из {p.Total / 1048576} МБ", $"Downloaded {p.Received / 1048576} of {p.Total / 1048576} MB");
                    }
                    else Status.Text = L.T($"Скачано {p.Received / 1048576} МБ", $"Downloaded {p.Received / 1048576} MB");
                    break;
                case "unpack":
                    Bar.IsIndeterminate = true;
                    Status.Text = L.T("Распаковываю…", "Unpacking…");
                    break;
                case "verify":
                    Bar.IsIndeterminate = true;
                    Status.Text = L.T("Проверяю файл…", "Checking the file…");
                    break;
            }
        });
        try
        {
            await _work(progress, _cts.Token);
            _done?.TrySetResult(true);
            Close();
        }
        catch (OperationCanceledException)
        {
            _done?.TrySetResult(false);
            Close();
        }
        catch (Exception e)
        {
            Log.Write($"download failed: {e}");
            Bar.IsIndeterminate = false;
            var kind = (e as ModelDownloadException)?.Kind ?? DownloadFailure.Network;
            Status.Text = kind switch
            {
                DownloadFailure.NoSpace => L.T($"Мало места на диске: нужно около {_spaceNeeded} свободных. Освободите место и повторите.",
                                               $"Not enough disk space: about {_spaceNeeded} is needed. Free some space and retry."),
                DownloadFailure.Corrupt => L.T("Скачанный архив повреждён или подменён. Попробуйте ещё раз позже.",
                                               "The downloaded archive is damaged or does not match. Try again later."),
                DownloadFailure.Rejected => e.Message,
                _ => L.T("Не получилось скачать. Проверьте интернет и попробуйте ещё раз.",
                         "Download failed. Check your connection and try again."),
            };
            RetryButton.Visibility = Visibility.Visible;
        }
    }

    private void Retry_Click(object sender, RoutedEventArgs e) => _ = StartAsync();

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
        _done?.TrySetResult(false);
        Close();
    }
}
