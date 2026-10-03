// Application entry: tray icon, push-to-talk wiring, model bootstrap.
//
// Flow: single-instance check -> tray icon -> settings window (always) ->
// recognizer only if the chosen model is already on disk -> keyboard hook.
// Closing the window hides it. Quit is the tray menu item.
// Hold the key: record. Release: recognize and insert the text where the caret is.

using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Windows;
using Forms = System.Windows.Forms;

namespace GigaPisar.App;

public partial class PisarApp : Application
{
    public static readonly string Version = ReadVersion();
    public const string SiteUrl = "https://gigapisar.github.io";
    public const string RepoUrl = "https://github.com/zai-one/giga-pisar-win";

    private static Mutex? _instanceMutex;
    /// <summary>A second launch (Start menu, desktop shortcut) signals the running instance to open Settings.</summary>
    private static EventWaitHandle? _showSettingsSignal;
    private const string ShowSettingsSignalName = "GigaPisar.ShowSettings";
    private static bool JustUpdated;

    /// <summary>Peak below this (about -75 dBFS) is digital silence: nothing reached the input at all.</summary>
    private const float SilenceFloor = 0.0002f;

    /// <summary>Quiet takes are scaled up to this peak before recognition; the model expects normal speech levels.</summary>
    private const float TargetPeak = 0.5f;
    private const float MaxGain = 200f;

    /// <summary>Takes shorter than this are treated as an accidental key press.</summary>
    private const int MinTakeSamples = Recorder.SampleRate / 4;

    /// <summary>Set only for a real exit (tray Quit, session end). Closing the window hides it instead.</summary>
    public static bool IsQuitting { get; private set; }

    private Settings _settings = new();
    private Forms.NotifyIcon? _tray;
    private System.Drawing.Icon? _iconIdle;
    private System.Drawing.Icon? _iconBusy;
    private IntPtr _busyIconHandle;
    private Core.Recognizer? _recognizer;
    private readonly object _recogLock = new();
    private string _speechNote = "";
    private HermesServer? _hermes;
    private KeyboardHook? _hook;
    private readonly Recorder _recorder = new();
    private OverlayWindow? _overlay;
    private SettingsWindow? _settingsWindow;
    private readonly CancellationTokenSource _lifetime = new();
    private bool _busy;
    /// <summary>Text selected when the key went down (read in the background); a take with a selection is a command on it.</summary>
    private Task<string?>? _selectionAtPress;

    /// <summary>The Brain can work right now: chosen, and set up (downloaded or configured).</summary>
    private bool BrainUsable => _settings.Brain switch
    {
        BrainSource.Local => LocalBrain.Downloaded,
        BrainSource.Server => Brain.ServerConfigured(_settings),
        _ => false,
    };

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length >= 3 && args[0] == "--transcribe")
            return CliTranscribe(args[1], args[2]);
        if (args.Length >= 1 && args[0] == "--overlay-demo")
            return OverlayDemo();
        if (args.Length >= 2 && args[0] == "--mic-test")
            return MicTest(args[1]);
        if (args.Length >= 3 && args[0] == "--brain-test")
            return BrainTest(args[1], args[2]);
        if (args.Length >= 2 && args[0] == "--brain-download")
            return BrainDownload(args[1]);
        if (args.Length >= 2 && args[0] == "--selection-test")
        {
            // Diagnostics: what UI Automation reports as selected in the foreground app.
            var sel = SelectionReader.TryGetAsync().GetAwaiter().GetResult();
            File.WriteAllText(args[1], sel == null ? "(no selection)\n" : $"{sel.Length} chars:\n{sel}\n");
            return 0;
        }
        if (args.Length >= 3 && args[0] == "--shot")
            return WindowShot(args[1], args[2], args.Length >= 4 ? args[3] : "ru", args.Length >= 5 ? args[4] : null);
        JustUpdated = args.Length >= 1 && args[0] == "--updated";

        _instanceMutex = new Mutex(true, "GigaPisar.SingleInstance", out bool first);
        if (!first)
        {
            try
            {
                // We were started by the user and may take the foreground; pass that right on to the running instance.
                Native.AllowSetForegroundWindow(Native.ASFW_ANY);
                if (EventWaitHandle.TryOpenExisting(ShowSettingsSignalName, out var signal)) signal.Set();
            }
            catch { }
            return 0;
        }
        _showSettingsSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowSettingsSignalName);

        var app = new PisarApp();
        app.InitializeComponent();
        app.DispatcherUnhandledException += (_, e) =>
        {
            Log.Write($"unhandled: {e.Exception}");
            e.Handled = true;
        };
        app.Startup += app.OnStartup;
        return app.Run();
    }

    private static string ReadVersion()
    {
        var info = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
        int plus = info.IndexOf('+');
        return plus > 0 ? info[..plus] : info;
    }

    /// <summary>Diagnostics: records two seconds from the default microphone and writes backend, sample count and peak to a file.</summary>
    private static int MicTest(string outPath)
    {
        try
        {
            var rec = new Recorder();
            rec.StartAsync().GetAwaiter().GetResult();
            Thread.Sleep(2000);
            var samples = rec.StopAsync().GetAwaiter().GetResult();
            File.WriteAllText(outPath, $"backend={rec.Backend} devices={Recorder.DeviceCount} default={Recorder.DefaultDeviceName()} samples={samples.Length} seconds={samples.Length / (double)Recorder.SampleRate:F2} peak={20 * Math.Log10(Math.Max(rec.TakePeak, 1e-9)):F0}dBFS\n");
            return 0;
        }
        catch (Exception e)
        {
            File.WriteAllText(outPath, "ERROR: " + e);
            return 1;
        }
    }

    /// <summary>Diagnostics: runs the saved Brain settings on the text of <paramref name="inPath"/>.</summary>
    private static int BrainTest(string inPath, string outPath)
    {
        try
        {
            var s = Settings.Load();
            s.Save();   // rewrites the file, so a plain-text key from the first Brain build gets encrypted
            var sw = Stopwatch.StartNew();
            var input = File.ReadAllText(inPath).Trim();
            var cmd = Brain.ParseCommand(input);
            var log = new StringBuilder();
            var cleaned = Brain.TransformAsync(s, cmd?.body ?? input, cmd?.command,
                status => log.Append($"[{sw.ElapsedMilliseconds} ms] {status}\n"), CancellationToken.None).GetAwaiter().GetResult();
            File.WriteAllText(outPath, $"brain={s.Brain} server={SpeechCleanup.HostOf(s.CleanupEndpointUrl)} command={cmd?.command ?? "(every take)"} ms={sw.ElapsedMilliseconds}\n{log}{cleaned}\n");
            LocalBrain.Stop();
            return 0;
        }
        catch (Exception e)
        {
            File.WriteAllText(outPath, "ERROR: " + e);
            return 1;
        }
    }

    /// <summary>
    /// Screenshots for articles: opens Settings on a section with example values (nothing is saved),
    /// captures exactly its frame from the screen and exits. Needs the display on.
    /// kind: settings | brain (alias server) | about. keyFile, if given, holds a real key so the
    /// key field shows its true length in dots; the file is the caller's to delete.
    /// </summary>
    private static int WindowShot(string kind, string outPath, string lang, string? keyFile)
    {
        var app = new PisarApp();
        app.InitializeComponent();
        app.Startup += async (_, _) =>
        {
            L.Apply(lang == "en" ? UiLanguage.English : UiLanguage.Russian);
            var s = new Settings
            {
                Brain = BrainSource.Server,
                CleanupEndpointUrl = "https://api.deepseek.com/v1",
                CleanupApiKey = keyFile != null && File.Exists(keyFile) ? File.ReadAllText(keyFile).Trim() : "sk-00000000000000000000000000000000",
                CleanupModel = "deepseek-flash",
            };
            var sw = new SettingsWindow(s, () => { }, () => { }, _ => Task.CompletedTask);
            sw.ShowPage(kind switch { "brain" or "server" => SettingsWindow.Page.Brain, "about" => SettingsWindow.Page.About, "edit" => SettingsWindow.Page.Edit, _ => SettingsWindow.Page.Dictation });
            Window w = sw;
            w.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            w.Topmost = true;
            w.Show();
            w.Activate();
            await Task.Delay(1500);
            var hwnd = new System.Windows.Interop.WindowInteropHelper(w).Handle;
            if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out var r, System.Runtime.InteropServices.Marshal.SizeOf<Native.RECT>()) != 0)
                Native.GetWindowRect(hwnd, out r);
            using (var bmp = new System.Drawing.Bitmap(r.Right - r.Left, r.Bottom - r.Top))
            {
                using (var g = System.Drawing.Graphics.FromImage(bmp))
                    g.CopyFromScreen(r.Left, r.Top, 0, 0, bmp.Size);
                bmp.Save(outPath, System.Drawing.Imaging.ImageFormat.Png);
            }
            app.Shutdown();
        };
        return app.Run();
    }

    /// <summary>Diagnostics: the local Brain download without the window, progress written to <paramref name="outPath"/>.</summary>
    private static int BrainDownload(string outPath)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            int lastPercent = -1;
            var progress = new SyncProgress(p =>
            {
                int pct = p.Total > 0 ? (int)(100 * p.Received / p.Total) : -1;
                if (p.Stage != "download" || pct / 10 != lastPercent / 10)
                {
                    lastPercent = pct;
                    File.AppendAllText(outPath, $"[{sw.Elapsed.TotalSeconds:F0}s] {p.Stage} {pct}%\n");
                }
            });
            LocalBrain.DownloadAsync(progress, CancellationToken.None).GetAwaiter().GetResult();
            File.AppendAllText(outPath, $"OK in {sw.Elapsed.TotalSeconds:F0}s, downloaded={LocalBrain.Downloaded}\n");
            return 0;
        }
        catch (Exception e)
        {
            File.AppendAllText(outPath, "ERROR: " + e + "\n");
            return 1;
        }
    }

    private sealed class SyncProgress(Action<ModelDownloader.Progress> report) : IProgress<ModelDownloader.Progress>
    {
        public void Report(ModelDownloader.Progress value) => report(value);
    }

    /// <summary>Design aid: shows the overlay with synthetic levels for a few seconds, then the "recognizing" state.</summary>
    private static int OverlayDemo()
    {
        var app = new PisarApp();
        app.InitializeComponent();
        app.Startup += async (_, _) =>
        {
            L.Apply(UiLanguage.Russian);
            var overlay = new OverlayWindow(new Settings(), () => { });
            overlay.ShowListening(null, demo: true);
            await Task.Delay(6000);
            overlay.ShowRecognizing();
            await Task.Delay(3000);
            overlay.ShowHint(L.T("Тишина на входе. Проверьте микрофон", "Silence on input. Check the microphone"));
            await Task.Delay(3000);
            app.Shutdown();
        };
        return app.Run();
    }

    /// <summary>Headless mode for testing: recognize a WAV file, write the text to a file.</summary>
    private static int CliTranscribe(string wavPath, string outPath)
    {
        try
        {
            var kind = Environment.GetEnvironmentVariable("PISAR_MODEL") == "v3"
                ? Core.SpeechModelKind.V3E2eRnnt : Core.SpeechModelKind.MultilingualLargeCtc;
            var device = Environment.GetEnvironmentVariable("PISAR_DEVICE") == "cpu"
                ? Core.SpeechDeviceKind.Cpu : Core.SpeechDeviceKind.Gpu;
            var modelDir = Environment.GetEnvironmentVariable("PISAR_MODEL_DIR") is { Length: > 0 } env ? env : Settings.ModelDirectory(kind);
            var sw = Stopwatch.StartNew();
            using var rec = new Core.Recognizer(modelDir, kind, device);
            var load = sw.Elapsed.TotalSeconds;
            var (samples, rate) = Core.AudioUtils.ReadWav(wavPath);
            sw.Restart();
            var text = rec.Transcribe(samples, rate);
            var run = sw.Elapsed.TotalSeconds;
            File.WriteAllText(outPath,
                $"load={load:F2}s recognize={run:F2}s audio={(double)samples.Length / rate:F1}s device={rec.DeviceActual} provider={rec.Provider} model={rec.ModelId} rss={Process.GetCurrentProcess().WorkingSet64 / 1048576}MB\n{text}\n");
            return 0;
        }
        catch (Exception e)
        {
            File.WriteAllText(outPath, "ERROR: " + e);
            return 1;
        }
    }

    private async void OnStartup(object sender, StartupEventArgs e)
    {
        _settings = Settings.Load();
        L.Apply(_settings.Language);
        Log.Write($"start v{Version}");

        _iconIdle = LoadIcon();
        _iconBusy = MakeBusyIcon(_iconIdle, out _busyIconHandle);
        _tray = new Forms.NotifyIcon
        {
            Icon = _iconIdle,
            Text = L.T("Гига Писарь", "Giga Pisar"),
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _tray.DoubleClick += (_, _) => ShowSettings();
        new Thread(() =>
        {
            while (_showSettingsSignal!.WaitOne() && !_lifetime.IsCancellationRequested)
                Dispatcher.BeginInvoke(ShowSettings);
        }) { IsBackground = true, Name = "show-settings-signal" }.Start();

        SessionEnding += (_, _) =>
        {
            IsQuitting = true;
            KeepAwake.AllowSleep();
        };

        // Window first. Model files are loaded only if they are already on disk.
        ShowSettings();
        await ReloadSpeechAsync();
        StartHermes();

        _recorder.TakeTooLong += () => Dispatcher.BeginInvoke(() => _ = HandleReleaseAsync());
        try
        {
            _hook = new KeyboardHook(_settings.HotkeyVk);
            _hook.Pressed += () => Dispatcher.BeginInvoke(() => _ = HandlePressAsync());
            _hook.Released += () => Dispatcher.BeginInvoke(() => _ = HandleReleaseAsync());
        }
        catch (Exception ex)
        {
            Log.Write($"hook failed: {ex}");
        }

        SetStatus(null);
        if (JustUpdated)
        {
            Updater.Cleanup();
            _tray.ShowBalloonTip(6000, L.T($"Гига Писарь обновлён до {Version}", $"Giga Pisar updated to {Version}"),
                L.T("Всё готово, можно диктовать.", "All set, dictate away."), Forms.ToolTipIcon.None);
        }
        // No update check on a timer. The tray and About have a manual button for this fork's releases.
        if (!_settings.FirstRunDone)
        {
            _settings.FirstRunDone = true;
            _settings.Save();
            if (_recognizer == null)
                _tray.ShowBalloonTip(8000, L.T("Модель не скачана", "Speech model is not downloaded"),
                    L.T("Откройте настройки и нажмите «Скачать выбранную модель». Сама она не скачивается.",
                        "Open Settings and press Download the selected model. It does not download by itself."),
                    Forms.ToolTipIcon.None);
            else
            _tray.ShowBalloonTip(8000, L.T("Гига Писарь готов", "Giga Pisar is ready"),
                L.T($"Поставьте курсор в любой текст, зажмите {Settings.HotkeyTitle(_settings.HotkeyVk)} и говорите. Отпустите, и текст появится сам.",
                    $"Put the cursor in any text, hold {Settings.HotkeyTitle(_settings.HotkeyVk)} and speak. Release, and the text appears by itself."),
                Forms.ToolTipIcon.None);
        }
    }

    // ── updates ──────────────────────────────────────────────────

    /// <summary>Manual check of this fork's GitHub releases. Never downloads or installs. Not called on a timer.</summary>
    private async Task CheckForUpdatesAsync(bool silent)
    {
        try
        {
            var info = await Updater.CheckAsync(_lifetime.Token);
            if (info == null)
            {
                if (!silent)
                    System.Windows.MessageBox.Show(
                        L.T($"У вас последняя версия, {Version}.\n\nПроверено: {Updater.ReleasesPage}",
                            $"You have the latest version, {Version}.\n\nChecked: {Updater.ReleasesPage}"),
                        L.T($"Гига Писарь {Version}", $"Giga Pisar {Version}"),
                        System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Information);
                return;
            }
            string notes = (L.Russian || string.IsNullOrWhiteSpace(info.NotesEn) ? info.Notes : info.NotesEn).Trim();
            if (notes.Length > 500) notes = notes[..500] + "…";
            string extra = notes.Length == 0 ? "" : notes + "\n\n";
            var open = System.Windows.MessageBox.Show(
                L.T($"Есть версия {info.Version}. У вас {Version}.\nПрограмма сама ничего не скачивает и не устанавливает.\n\n{extra}Страница:\n{info.Url}\n\nОткрыть её в браузере?",
                    $"Version {info.Version} is out. You have {Version}.\nThe app does not download or install it.\n\n{extra}Page:\n{info.Url}\n\nOpen it in the browser?"),
                L.T("Есть обновление", "Update available"),
                System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Information);
            if (open == System.Windows.MessageBoxResult.Yes) Open(info.Url);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Log.Write($"update check failed: {ex.Message}");
            if (!silent)
                System.Windows.MessageBox.Show(
                    L.T($"Не удалось проверить обновления.\n{Updater.ReleasesPage}\n{ex.Message}",
                        $"Could not check for updates.\n{Updater.ReleasesPage}\n{ex.Message}"),
                    L.T($"Гига Писарь {Version}", $"Giga Pisar {Version}"),
                    System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
        }
    }

    // ── push-to-talk ─────────────────────────────────────────────

    /// <summary>As on macOS: once the selection is read, say how much is selected and what to do.</summary>
    private async Task HintSelectionAsync(Task<string?> read)
    {
        var selected = await read;
        if (selected == null || !_recorder.IsRecording) return;
        string text = L.T($"Выделено {selected.Length} знаков. Скажите, что с ними сделать",
                          $"{selected.Length} characters selected. Say what to do with them");
        if (_settings.ShowOverlay) _overlay?.ShowCaption(text);
        else _tray?.ShowBalloonTip(2500, L.T("Гига Писарь", "Giga Pisar"), text, Forms.ToolTipIcon.None);
    }

    private async Task HandlePressAsync()
    {
        if (_busy || _recognizer == null || _recorder.IsRecording) return;
        _selectionAtPress = BrainUsable && _settings.BrainOnSelection ? SelectionReader.TryGetAsync(_lifetime.Token) : null;
        if (_selectionAtPress != null) _ = HintSelectionAsync(_selectionAtPress);
        try
        {
            await _recorder.StartAsync();
        }
        catch (Exception ex)
        {
            Log.Write($"mic failed: {ex.GetType().Name}: {ex.Message} (devices: {Recorder.DeviceCount})");
            string why = Recorder.DeviceCount == 0
                ? L.T("Windows не видит ни одного устройства записи. Подключите микрофон или включите его в Параметрах звука, раздел «Ввод».",
                      "Windows sees no recording device. Connect a microphone or enable one in Sound settings, Input.")
                : ex is UnauthorizedAccessException || ex.Message.Contains("0x80070005") || ex.Message.Contains("denied", StringComparison.OrdinalIgnoreCase)
                ? L.T("Windows не даёт доступ к микрофону. Параметры → Конфиденциальность и защита → Микрофон: включите «Доступ к микрофону» и «Разрешить классическим приложениям доступ к микрофону».",
                      "Windows denies microphone access. Settings, Privacy and security, Microphone: turn on microphone access and let desktop apps use the microphone.")
                : L.T($"Не удалось открыть микрофон: {ex.Message}", $"Could not open the microphone: {ex.Message}");
            _tray?.ShowBalloonTip(8000, L.T("Микрофон недоступен", "Microphone unavailable"), why, Forms.ToolTipIcon.Warning);
            return;
        }
        if (_tray != null) _tray.Icon = _iconBusy;
        if (_settings.ShowOverlay)
        {
            _overlay ??= new OverlayWindow(_settings, _settings.Save);
            _overlay.ShowListening(_recorder);
        }
    }

    /// <summary>Peaks of 0–0.5 s, 0.5–1 s and the rest, in dBFS: shows whether a quick re-press loses the start of a take.</summary>
    private static string PartPeaks(float[] samples)
    {
        int half = Recorder.SampleRate / 2;
        static string Db(float[] a, int from, int to)
        {
            float p = 0;
            for (int i = Math.Max(0, from); i < Math.Min(a.Length, to); i++) p = Math.Max(p, Math.Abs(a[i]));
            return p == 0 ? "-" : (20 * Math.Log10(p)).ToString("F0");
        }
        return $"{Db(samples, 0, half)}/{Db(samples, half, 2 * half)}/{Db(samples, 2 * half, samples.Length)}";
    }

    private async Task HandleReleaseAsync()
    {
        if (!_recorder.IsRecording || _busy) return;
        _busy = true;
        var overlay = _settings.ShowOverlay ? _overlay : null;
        try
        {
            var samples = await _recorder.StopAsync();
            overlay?.ShowRecognizing();

            float peak = _recorder.TakePeak;
            // The model invents words when fed silence or flat noise. Absolute level is a poor
            // test (a line-level receiver on a mic jack sits 50 dB down), so we look for speech
            // dynamics: loud stretches well above the quiet ones.
            bool silent = peak < SilenceFloor || !HasSpeechDynamics(samples);
            Log.Write($"take {samples.Length / (double)Recorder.SampleRate:F1}s peak {20 * Math.Log10(Math.Max(peak, 1e-9)):F0} dBFS silent={silent}"
                      + $" gap {_recorder.GapMs:F0}ms via {_recorder.Backend} parts {PartPeaks(samples)}");

            string text = "";
            string? brainFailure = null;
            bool editedSelection = false;
            bool brainCommand = false;
            if (!silent && samples.Length > MinTakeSamples)
            {
                if (_settings.KeepLastRecording)
                    Core.AudioUtils.WriteWav(samples, Recorder.SampleRate, Settings.LastTakePath);

                // Windows input levels vary wildly (a line-level receiver on a mic jack can sit
                // 50 dB down). Normalize quiet takes so the model sees ordinary speech.
                if (peak < TargetPeak)
                {
                    float gain = Math.Min(TargetPeak / peak, MaxGain);
                    for (int i = 0; i < samples.Length; i++) samples[i] *= gain;
                }
                text = await Task.Run(() => _recognizer!.Transcribe(samples, Recorder.SampleRate));
                string? selected = _selectionAtPress != null && text.Length > 0 ? await _selectionAtPress : null;
                _selectionAtPress = null;
                if (selected != null)
                {
                    // Selected text + speech = a command on the selection ("make it shorter", "translate").
                    // The answer is pasted over the selection; Ctrl+Z in the app brings the original back.
                    Log.Write($"brain on selection, {selected.Length} chars");
                    var (answer, failure) = await RunBrainAsync(selected, Brain.StripAddress(text), selection: true, overlay);
                    if (_lifetime.IsCancellationRequested) return;
                    if (answer == null)
                    {
                        Hint(L.T($"Мозг не справился: {failure}. Выделенный текст не тронут.",
                                 $"The Brain failed: {failure}. The selection is untouched."));
                        return;   // never paste the spoken command over the user's text
                    }
                    text = answer;
                    editedSelection = true;
                }
                else if (text.Length > 0 && BrainUsable)
                {
                    var cmd = Brain.ParseCommand(text);
                    if (cmd != null || _settings.BrainEveryTake)
                    {
                        string body = cmd?.body ?? text;
                        if (cmd != null) Log.Write($"brain command, {body.Length} chars");
                        brainCommand = cmd != null;
                        var (answer, failure) = await RunBrainAsync(body, cmd?.command, selection: false, overlay);
                        if (_lifetime.IsCancellationRequested) return;
                        brainFailure = failure;
                        text = answer ?? body;   // on failure the dictation goes in as recognized, without the command
                    }
                }
            }

            // Simple syntax is for dictation only: a Brain answer to a command or an edited selection goes in as is.
            if (text.Length > 0 && _settings.SimpleSyntax && !editedSelection && !brainCommand)
            {
                var simple = SimpleSyntax.Apply(text);
                Log.Write($"simple syntax: {(simple == text ? "unchanged" : "applied")}, {text.Length} chars");
                text = simple;
            }
            else if (text.Length > 0)
                Log.Write($"insert as is: simple={_settings.SimpleSyntax} selection={editedSelection} command={brainCommand}");

            if (text.Length > 0)
            {
                overlay?.HideNow();
                var mode = _settings.InsertMode;
                var result = await Task.Run(() => TextInserter.Insert(text, mode, _lifetime.Token));
                if (result == InsertResult.Blocked)
                    Hint(L.T("Это окно запущено от администратора, вставить туда нельзя. Текст лежит в буфере обмена.",
                             "That window runs as administrator; typing into it is blocked. The text is on the clipboard."));
                else if (brainFailure != null)
                    Hint(L.T($"Мозг не справился: {brainFailure}. Вставлен текст без правки.",
                             $"The Brain failed: {brainFailure}. Inserted the text as recognized."));
                else if (editedSelection)
                    Hint(L.T("Готово. Вернуть как было: Ctrl+Z", "Done. Undo with Ctrl+Z"));
            }
            else if (samples.Length <= MinTakeSamples)
            {
                overlay?.HideNow();
            }
            else
            {
                Hint(silent
                    ? L.T("Тишина на входе. Проверьте микрофон и его громкость: " + Recorder.DefaultDeviceName(),
                          "Silence on input. Check the microphone and its level: " + Recorder.DefaultDeviceName())
                    : L.T("Не разобрал. Попробуйте ещё раз ближе к микрофону.",
                          "Could not make it out. Try again closer to the microphone."));
            }
        }
        catch (Exception ex)
        {
            Log.Write($"take failed: {ex}");
            overlay?.HideNow();
        }
        finally
        {
            _busy = false;
            if (_tray != null) _tray.Icon = _iconIdle;
        }
    }

    /// <summary>
    /// Runs the Brain on a text with the pill showing progress. Returns the answer, or null and a human reason.
    /// An empty answer counts as a failure: the dictation must never silently vanish or wipe a selection.
    /// </summary>
    private async Task<(string? answer, string? failure)> RunBrainAsync(string body, string? command, bool selection, OverlayWindow? overlay)
    {
        try
        {
            if (!ConfirmBrainMemory())
                return (null, L.T("мало свободной памяти, запуск отменён", "not enough free memory, start cancelled"));
            var answer = await Brain.TransformAsync(_settings, body, command,
                status => { overlay?.ShowStatus(status); SetStatus(status); }, _lifetime.Token, selection);
            return answer.Trim().Length > 0 ? (answer, null) : (null, L.T("нейросеть вернула пустой ответ", "the model returned an empty answer"));
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { return (null, null); }
        catch (Exception ex)
        {
            Log.Write($"brain failed: {ex.GetType().Name}: {ex.Message}");
            return (null, ex is BrainException ? ex.Message
                : _settings.Brain == BrainSource.Server ? L.T("сервер не ответил", "the server did not answer")
                : L.T("нейронка не ответила", "the Brain did not answer"));
        }
        finally { SetStatus(null); }
    }

    /// <summary>
    /// Before a cold start of the local Brain: if the model will not fit into free memory,
    /// Windows starts paging and the start drags on for minutes. Better to ask first.
    /// </summary>
    private bool ConfirmBrainMemory()
    {
        if (_settings.Brain != BrainSource.Local || LocalBrain.Running) return true;
        var (_, free) = LocalBrain.Memory();
        ulong need = LocalBrain.MemoryNeeded;
        if (free == 0 || free >= need) return true;
        var answer = System.Windows.MessageBox.Show(
            L.T($"Свободно {LocalBrain.Gb(free)} ГБ памяти, а Мозгу нужно около {LocalBrain.Gb(need)} ГБ. Он всё равно запустится, но Windows начнёт выгружать другие программы на диск, и ждать можно несколько минут. Закройте тяжёлые программы и попробуйте снова, или запускайте так.",
                $"{LocalBrain.Gb(free)} GB of memory is free and the Brain needs about {LocalBrain.Gb(need)} GB. It will still start, but Windows will page other apps to disk and it may take minutes. Close heavy apps and try again, or go ahead anyway."),
            L.T("Памяти впритык", "Memory is tight"), System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Warning);
        return answer == System.Windows.MessageBoxResult.Yes;
    }

    /// <summary>Switches the Brain; for the local one, downloads engine and model first (asking before 2 GB).</summary>
    public async Task SelectBrainAsync(BrainSource source)
    {
        if (source == BrainSource.Server && !Brain.ServerConfigured(_settings))
        {
            // Nothing to ask here: the service, key and model are filled in right in Settings.
            if (_settings.Brain == BrainSource.Local) LocalBrain.Stop();
            _settings.Brain = BrainSource.Server;
            ApplySettings();
            ShowSettings();
            _settingsWindow?.ShowPage(SettingsWindow.Page.Brain);
            _settingsWindow?.Localize();
            return;
        }
        if (source == BrainSource.Local && !LocalBrain.Downloaded)
        {
            var (total, _) = LocalBrain.Memory();
            string ram = total > 0 && total < LocalBrain.RecommendedRamBytes
                ? L.T($"\n\nВ этом компьютере {LocalBrain.Gb(total)} ГБ памяти, а Мозгу комфортно от 8 ГБ. Работать будет, но медленно и тесно.",
                      $"\n\nThis computer has {LocalBrain.Gb(total)} GB of memory; the Brain is comfortable from 8 GB. It will work, but slowly and tightly.")
                : "";
            var ok = System.Windows.MessageBox.Show(
                L.T($"Мозг на компьютере: нейросеть {LocalBrain.ModelTitle} и движок llama.cpp, около 2 ГБ. Скачиваются один раз, потом всё работает без интернета.\n\nПока Мозг работает, он занимает около 2,5 ГБ памяти и сам выгружается через 15 минут без дела. Правка фразы на обычном ноутбуке занимает от нескольких секунд до десяти.{ram}\n\nСкачать?",
                    $"The Brain on this computer: the {LocalBrain.ModelTitle} model and the llama.cpp engine, about 2 GB. Downloaded once, then everything works offline.\n\nWhile working it takes about 2.5 GB of memory and unloads itself after 15 idle minutes. Editing a phrase takes a few seconds up to ten on an ordinary laptop.{ram}\n\nDownload?"),
                L.T("Мозг на компьютере", "Brain on this computer"), System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Question);
            if (ok != System.Windows.MessageBoxResult.Yes) return;
            var window = new DownloadWindow(
                L.T("Скачиваю Мозг", "Downloading the Brain"),
                L.T($"Нейросеть {LocalBrain.ModelTitle} и движок llama.cpp, около 2 ГБ. Если связь оборвётся, скачивание продолжится с того же места.",
                    $"The {LocalBrain.ModelTitle} model and the llama.cpp engine, about 2 GB. If the connection drops, the download resumes where it stopped."),
                LocalBrain.DownloadAsync,
                L.T("2,5 ГБ", "2.5 GB"));
            if (!await window.RunAsync()) return;
        }
        if (source != BrainSource.Local) LocalBrain.Stop();
        _settings.Brain = source;
        ApplySettings();
        _settingsWindow?.Localize();
        if (source != BrainSource.Off)
            _tray?.ShowBalloonTip(6000, L.T("Мозг включён", "Brain is on"),
                L.T("Скажите в конце фразы: «Писарь, исправь», «Писарь, сократи» или «Писарь, переведи на английский».",
                    "End a phrase with \"Pisar, fix it\", \"Pisar, make it shorter\" or \"Pisar, translate into English\" (in Russian)."),
                Forms.ToolTipIcon.None);
    }

    /// <summary>Short feedback for the user: on the overlay when it is enabled, otherwise as a balloon.</summary>
    private void Hint(string text)
    {
        if (_settings.ShowOverlay)
        {
            _overlay ??= new OverlayWindow(_settings, _settings.Save);
            _overlay.ShowHint(text);
        }
        else
        {
            _tray?.ShowBalloonTip(4000, L.T("Гига Писарь", "Giga Pisar"), text, Forms.ToolTipIcon.None);
        }
    }

    /// <summary>True when the take has bursts (speech) rather than a flat floor (silence or hum).</summary>
    private static bool HasSpeechDynamics(float[] samples)
    {
        const int window = Recorder.SampleRate / 10;   // 100 ms
        const double minLoudToQuietRatio = 2;          // permissive on purpose: a wrong "silence" verdict hides real speech
        int n = samples.Length / window;
        if (n < 3) return true;   // too short to judge; let the model decide
        var rms = new double[n];
        for (int w = 0; w < n; w++)
        {
            double sum = 0;
            for (int i = w * window; i < (w + 1) * window; i++) sum += samples[i] * samples[i];
            rms[w] = Math.Sqrt(sum / window);
        }
        Array.Sort(rms);
        double quiet = rms[n / 4] + 1e-7;          // lower quartile: the floor
        double loud = rms[n - 1 - n / 20];         // near the top, ignoring one-off clicks
        return loud / quiet > minLoudToQuietRatio;
    }

    // ── tray ─────────────────────────────────────────────────────

    private Forms.ContextMenuStrip BuildMenu()
    {
        var menu = new Forms.ContextMenuStrip();
        var title = new Forms.ToolStripMenuItem(L.T($"Гига Писарь {Version}", $"Giga Pisar {Version}")) { Enabled = false };
        var hint = new Forms.ToolStripMenuItem("") { Enabled = false };
        menu.Items.Add(title);
        menu.Items.Add(hint);
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(L.T("Открыть окно", "Open window"), null, (_, _) => ShowSettings());
        menu.Items.Add(L.T("Свернуть в трей", "Hide to tray"), null, (_, _) => _settingsWindow?.Hide());
        menu.Items.Add(L.T("Настройки…", "Settings…"), null, (_, _) => ShowSettings());
        // Always visible, so it is clear whether text leaves the computer.
        var brain = new Forms.ToolStripMenuItem("");
        var brainOff = new Forms.ToolStripMenuItem(L.T("Выключен", "Off"));
        var brainLocal = new Forms.ToolStripMenuItem("");
        var brainServer = new Forms.ToolStripMenuItem("");
        brainOff.Click += (_, _) => _ = SelectBrainAsync(BrainSource.Off);
        brainLocal.Click += (_, _) => _ = SelectBrainAsync(BrainSource.Local);
        brainServer.Click += (_, _) => _ = SelectBrainAsync(BrainSource.Server);
        brain.DropDownItems.Add(brainOff);
        if (LocalBrain.Offered || _settings.Brain == BrainSource.Local) brain.DropDownItems.Add(brainLocal);
        brain.DropDownItems.Add(brainServer);
        menu.Items.Add(brain);
        var editSel = new Forms.ToolStripMenuItem(L.T("Правка выделенного голосом", "Edit selection by voice")) { CheckOnClick = true };
        editSel.Click += (_, _) => { _settings.BrainOnSelection = editSel.Checked; ApplySettings(); _settingsWindow?.Localize(); };
        menu.Items.Add(editSel);
        var autostart = new Forms.ToolStripMenuItem(L.T("Запускать при входе в Windows", "Start when I sign in")) { CheckOnClick = true };
        autostart.Click += (_, _) => Autostart.Set(autostart.Checked);
        menu.Items.Add(autostart);

        var language = new Forms.ToolStripMenuItem(L.T("Язык", "Language"));
        foreach (var (choice, name) in new[] { (UiLanguage.Auto, L.T("Как в системе", "Same as system")), (UiLanguage.Russian, "Русский"), (UiLanguage.English, "English") })
        {
            var item = new Forms.ToolStripMenuItem(name) { Checked = _settings.Language == choice };
            item.Click += (_, _) => { _settings.Language = choice; ApplySettings(); };
            language.DropDownItems.Add(item);
        }
        menu.Items.Add(language);

        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(L.T("Скачать модель распознавания…", "Download the speech model…"), null, (_, _) => _ = DownloadSpeechAsync(manualStart: false));
        menu.Items.Add(L.T("Сайт проекта", "Project website"), null, (_, _) => Open(SiteUrl));
        menu.Items.Add(L.T("Исходный код", "Source code"), null, (_, _) => Open(RepoUrl));
        menu.Items.Add(L.T("Проверить обновления", "Check for updates"), null, (_, _) => _ = CheckForUpdatesAsync(silent: false));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(L.T("Выход", "Quit"), null, (_, _) => Quit());
        menu.Opening += (_, _) =>
        {
            autostart.Checked = Autostart.IsEnabled();
            string host = SpeechCleanup.HostOf(_settings.CleanupEndpointUrl);
            brain.Text = _settings.Brain switch
            {
                BrainSource.Local => L.T("Мозг: на компьютере", "Brain: on this computer"),
                BrainSource.Server => L.T($"Мозг: в облаке ({host})", $"Brain: in the cloud ({host})"),
                _ => L.T("Мозг: выключен", "Brain: off"),
            };
            editSel.Checked = _settings.BrainOnSelection;
            editSel.Enabled = BrainUsable;
            brainOff.Checked = _settings.Brain == BrainSource.Off;
            brainLocal.Checked = _settings.Brain == BrainSource.Local;
            brainServer.Checked = _settings.Brain == BrainSource.Server;
            brainLocal.Text = LocalBrain.Downloaded
                ? L.T($"На компьютере ({LocalBrain.ModelTitle})", $"On this computer ({LocalBrain.ModelTitle})")
                : L.T("На компьютере (скачать 2 ГБ)…", "On this computer (download 2 GB)…");
            brainServer.Text = Brain.ServerConfigured(_settings)
                ? L.T($"В облаке ({host})", $"In the cloud ({host})")
                : L.T("В облаке…", "In the cloud…");
            hint.Text = _recognizer == null ? L.T("Модель не скачана", "Speech model is not downloaded")
                : L.T($"Зажмите {Settings.HotkeyTitle(_settings.HotkeyVk)} и говорите ({_recognizer.DeviceActual})",
                      $"Hold {Settings.HotkeyTitle(_settings.HotkeyVk)} and speak ({_recognizer.DeviceActual})");
        };
        return menu;
    }

    private Task DownloadSpeechAsync(bool manualStart)
    {
        var window = new DownloadWindow(_settings.SpeechModel, manualStart);
        return DownloadAndReloadAsync(window);
    }

    private async Task DownloadAndReloadAsync(DownloadWindow window)
    {
        if (!await window.RunAsync()) return;
        await ReloadSpeechAsync();
        _settingsWindow?.Localize();
    }

    private async Task ReloadSpeechAsync()
    {
        var kind = _settings.SpeechModel;
        var device = _settings.SpeechDevice;
        var dir = Settings.ModelDirectory(kind);
        Core.Recognizer? next = null;
        string note = "";
        if (Core.Recognizer.ModelExists(dir, kind))
        {
            SetStatus(L.T("Загружаю модель…", "Loading the model…"));
            try
            {
                next = await Task.Run(() => new Core.Recognizer(dir, kind, device));
                if (next.DeviceNote != null)
                    note = next.DeviceActual == "cpu"
                        ? L.T("Видеокарта не поднялась, считаю на процессоре.", "The video card did not start, running on the processor.")
                        : "";
                Log.Write($"model {next.ModelId} on {next.DeviceActual}/{next.Provider}" + (next.DeviceNote == null ? "" : $" note={next.DeviceNote}"));
            }
            catch (Exception ex)
            {
                Log.Write($"model load failed: {ex}");
                note = ex.Message;
                next = null;
            }
        }
        else note = "";
        Core.Recognizer? old;
        lock (_recogLock)
        {
            old = _recognizer;
            _recognizer = next;
            _speechNote = note;
        }
        old?.Dispose();
        SetStatus(null);
        _settingsWindow?.Localize();
    }

    private string SpeechStatusText()
    {
        var kind = _settings.SpeechModel;
        var dir = Settings.ModelDirectory(kind);
        if (!Core.Recognizer.ModelExists(dir, kind))
            return L.T("Эта модель ещё не скачана. Нажмите кнопку ниже. Пока не нажмёте, в сеть ничего не уходит.",
                       "This model is not downloaded yet. Press the button below. Nothing goes out on the network until you do.");
        Core.Recognizer? rec;
        string note;
        lock (_recogLock) { rec = _recognizer; note = _speechNote; }
        if (rec == null || rec.Kind != kind)
            return L.T("Файлы на месте, но модель не загрузилась. ", "The files are there, but the model did not load. ") + note;
        string where = rec.DeviceActual == "gpu"
            ? L.T("видеокарте (DirectML)", "the video card (DirectML)")
            : L.T("процессоре", "the processor");
        return L.T($"Загружена {rec.ModelId}, считает на {where}. ", $"Loaded {rec.ModelId}, running on {where}. ") + note;
    }

    private void StartHermes() => RestartHermes(_settings.HermesOnLan);

    private void RestartHermes(bool lan)
    {
        try
        {
            _hermes?.Dispose();
            _hermes = null;
            _hermes = new HermesServer(Core.SpeechModels.HermesPort, HermesTranscribe, lan);
            _hermes.Start();
        }
        catch (Exception ex)
        {
            Log.Write($"hermes failed: {ex.Message}");
            _hermes = null;
            if (lan)
            {
                try
                {
                    _hermes = new HermesServer(Core.SpeechModels.HermesPort, HermesTranscribe, false);
                    _hermes.Start();
                    _settings.HermesOnLan = false;
                    _settings.Save();
                }
                catch (Exception again)
                {
                    Log.Write($"hermes localhost failed: {again.Message}");
                }
            }
        }
        ApplyKeepAwake();
    }

    private void ApplyKeepAwake()
    {
        if (_settings.KeepAwakeWhileListening && _hermes != null) KeepAwake.PreventSleep();
        else KeepAwake.AllowSleep();
    }

    private string HermesStatusText()
    {
        int port = Core.SpeechModels.HermesPort;
        if (_hermes == null)
            return L.T("Расшифровщик не запущен.", "The decoder is not running.");
        if (!_hermes.ListenOnLan)
            return L.T($"Слушаю только этот компьютер: http://127.0.0.1:{port}/v1/transcribe. Другие машины сюда не попадут, пока вы не откроете порт.",
                       $"Listening on this PC only: http://127.0.0.1:{port}/v1/transcribe. Other machines cannot reach it until you open the port.");
        return L.T($"Слушаю всю локальную сеть, порт {port} (адрес 0.0.0.0). С других компьютеров: {LanUrls(port)}. Звук приходит сюда и здесь же расшифровывается, в интернет он не уходит. Любой в этой сети может прислать запись.",
                   $"Listening on the local network, port {port} (0.0.0.0). From another computer: {LanUrls(port)}. Audio is transcribed here and is not uploaded. Anyone on this network can send a recording.");
    }

    private static string LanUrls(int port)
    {
        try
        {
            var ips = System.Net.Dns.GetHostAddresses(System.Net.Dns.GetHostName())
                .Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && !System.Net.IPAddress.IsLoopback(a))
                .Select(a => $"http://{a}:{port}/v1/transcribe")
                .ToArray();
            if (ips.Length > 0) return string.Join(", ", ips);
        }
        catch { }
        return $"http://<адрес-этого-ПК>:{port}/v1/transcribe";
    }

    private async Task ToggleLanAsync()
    {
        if (_hermes?.ListenOnLan == true)
        {
            _settings.HermesOnLan = false;
            _settings.Save();
            RestartHermes(false);
            return;
        }
        var yes = System.Windows.MessageBox.Show(
            L.T($"Порт {Core.SpeechModels.HermesPort} откроется в брандмауэре Windows (система спросит разрешение администратора), и Писарь начнёт принимать записи со всех компьютеров в локальной сети. Адрес 0.0.0.0. В интернет звук не отправляется, но любой в этой сети сможет прислать файл на расшифровку. Продолжить?",
                $"Port {Core.SpeechModels.HermesPort} will be opened in Windows Firewall (Windows will ask for administrator permission) and Pisar will accept recordings from every computer on the local network, on 0.0.0.0. Audio is not uploaded, but anyone on this network can send a file to transcribe. Continue?"),
            L.T("Слушать сеть", "Listen on the network"),
            System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Warning);
        if (yes != System.Windows.MessageBoxResult.Yes) return;
        var (opened, error) = await Task.Run(() =>
        {
            bool ok = HermesFirewall.TryOpenPort(Core.SpeechModels.HermesPort, out var err);
            return (ok, err);
        });
        if (!opened)
        {
            Log.Write($"firewall rule failed: {error}");
            HermesFirewall.OpenConsole();
            System.Windows.MessageBox.Show(
                L.T($"Правило брандмауэра не добавилось ({error}). Открыл консоль брандмауэра: разрешите входящий TCP {Core.SpeechModels.HermesPort}. Слушать сеть всё равно пробую.",
                    $"The firewall rule was not added ({error}). The firewall console is open: allow inbound TCP {Core.SpeechModels.HermesPort}. Trying to listen on the network anyway."),
                L.T("Брандмауэр", "Firewall"), System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
        }
        else HermesFirewall.OpenConsole();
        _settings.HermesOnLan = true;
        _settings.Save();
        RestartHermes(true);
    }

    private HermesResult HermesTranscribe(byte[] audio)
    {
        lock (_recogLock)
        {
            var rec = _recognizer;
            if (audio.Length == 0)
                return new HermesResult(rec != null, null, rec?.ModelId ?? _settings.SpeechModel.ToString(), rec?.DeviceActual ?? "", rec?.Provider ?? "", 0, null);
            if (rec == null)
                return new HermesResult(false, null, "", "", "", 0, null);
            try
            {
                float[] samples;
                int rate;
                if (audio.Length >= 4 && audio[0] == (byte)'R' && audio[1] == (byte)'I' && audio[2] == (byte)'F' && audio[3] == (byte)'F')
                    (samples, rate) = Core.AudioUtils.ReadWav(audio);
                else if (audio.Length >= 4 && audio[0] == (byte)'O' && audio[1] == (byte)'g' && audio[2] == (byte)'g' && audio[3] == (byte)'S')
                {
                    samples = Core.OggOpus.DecodeTo16kMono(audio);
                    rate = 16000;
                }
                else
                    return new HermesResult(true, null, rec.ModelId, rec.DeviceActual, rec.Provider, 0, "need a wav or ogg/opus file");
                if (rate != 16000) samples = Core.AudioUtils.Resample(samples, rate, 16000);
                var text = rec.Transcribe(samples, 16000);
                Log.Write($"hermes {samples.Length / 16000.0:F1}s -> {text.Length} chars");
                return new HermesResult(true, text, rec.ModelId, rec.DeviceActual, rec.Provider, samples.Length / 16000.0, null);
            }
            catch (Exception ex)
            {
                Log.Write($"hermes decode failed: {ex.GetType().Name}");
                return new HermesResult(true, null, rec.ModelId, rec.DeviceActual, rec.Provider, 0, ex.Message);
            }
        }
    }

    private void SetStatus(string? status)
    {
        if (_tray == null) return;
        _tray.Text = status == null ? L.T("Гига Писарь", "Giga Pisar") : L.T($"Гига Писарь: {status}", $"Giga Pisar: {status}");
    }

    public void ShowSettings()
    {
        if (_settingsWindow == null)
        {
            _settingsWindow = new SettingsWindow(_settings, ApplySettings, () => { _overlay?.Unpin(); _settings.OverlayX = null; _settings.OverlayY = null; _settings.Save(); }, SelectBrainAsync,
                () => DownloadSpeechAsync(manualStart: false), () => _ = ReloadSpeechAsync(), SpeechStatusText,
                HermesStatusText, ToggleLanAsync, ApplyKeepAwake,
                () => _ = CheckForUpdatesAsync(silent: false));
            _settingsWindow.Closed += (_, _) => _settingsWindow = null;
        }
        _settingsWindow.Show();
        if (_settingsWindow.WindowState == WindowState.Minimized) _settingsWindow.WindowState = WindowState.Normal;
        // Windows may refuse the foreground to a tray app; a topmost blink still brings the window above the rest.
        _settingsWindow.Topmost = true;
        _settingsWindow.Activate();
        _settingsWindow.Topmost = false;
    }

    private void ApplySettings()
    {
        _settings.Save();
        if (_hook != null) _hook.HotkeyVk = _settings.HotkeyVk;
        if (!_settings.ShowOverlay) _overlay?.HideNow();

        bool wasRussian = L.Russian;
        L.Apply(_settings.Language);
        if (wasRussian != L.Russian)
        {
            // Language changed: rebuild everything that carries text.
            if (_tray != null) { _tray.ContextMenuStrip?.Dispose(); _tray.ContextMenuStrip = BuildMenu(); }
            SetStatus(null);
            _settingsWindow?.Localize();
        }
    }

    private static void Open(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    private void Quit()
    {
        IsQuitting = true;
        _lifetime.Cancel();
        _hermes?.Dispose();
        _hermes = null;
        KeepAwake.AllowSleep();
        LocalBrain.Stop();
        _hook?.Dispose();
        _recorder.Dispose();
        _overlay?.Close();
        if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
        _recognizer?.Dispose();
        _iconBusy?.Dispose();
        if (_busyIconHandle != IntPtr.Zero) Native.DestroyIcon(_busyIconHandle);
        _iconIdle?.Dispose();
        Shutdown();
    }

    // ── icons ────────────────────────────────────────────────────

    private static System.Drawing.Icon LoadIcon()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "app.ico");
        if (File.Exists(path)) return new System.Drawing.Icon(path, 32, 32);
        return System.Drawing.SystemIcons.Application;
    }

    /// <summary>Same icon with a red dot: "listening". The HICON must be destroyed by the caller.</summary>
    private static System.Drawing.Icon MakeBusyIcon(System.Drawing.Icon idle, out IntPtr handle)
    {
        using var bmp = idle.ToBitmap();
        using var g = System.Drawing.Graphics.FromImage(bmp);
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        int d = bmp.Width * 7 / 16;
        using var brush = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(255, 226, 61, 61));
        using var pen = new System.Drawing.Pen(System.Drawing.Color.White, Math.Max(1, bmp.Width / 16));
        g.FillEllipse(brush, bmp.Width - d, bmp.Height - d, d - 1, d - 1);
        g.DrawEllipse(pen, bmp.Width - d, bmp.Height - d, d - 1, d - 1);
        handle = bmp.GetHicon();
        return System.Drawing.Icon.FromHandle(handle);
    }
}
