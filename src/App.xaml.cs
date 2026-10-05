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
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace ChawoVA.App;

public enum DictatePhase { NoModel, Idle, Listening, Recognizing }

public partial class ChawoApp : Application
{
    public static readonly string Version = ReadVersion();
    public const string ProductName = "Chawo Voice Assistant";
    /// <summary>Short form, only where space is tight (tray tooltip with a status).</summary>
    public const string ProductShortName = "Chawo VA";
    public const string SiteUrl = "https://chawo.ai";
    public const string RepoUrl = "https://github.com/zai-one/chawo-va";

    private static Mutex? _instanceMutex;
    /// <summary>A second launch (Start menu, desktop shortcut) signals the running instance to open Settings.</summary>
    private static EventWaitHandle? _showSettingsSignal;
    private const string ShowSettingsSignalName = "ChawoVoiceAssistant.ShowSettings";
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
    /// <summary>True after a DirectML dummy pass on the recognizer that is still loaded.</summary>
    private bool _gpuWarmed;
    private HermesServer? _hermes;
    private KeyboardHook? _hook;
    private readonly Recorder _recorder = new();
    private OverlayWindow? _overlay;
    private SalesCardWindow? _salesCard;
    private TelephonyEvent? _openCall;
    private HandsetBinding? _openBinding;
    private string _salesTranscript = "";
    private SettingsWindow? _settingsWindow;
    private readonly CancellationTokenSource _lifetime = new();
    private bool _busy;
    private volatile bool _abandonTake;
    private int _partialEpoch;
    private int _partialBusy;
    private Task? _partialTask;
    private CancellationTokenSource? _remotePartialCts;
    private DispatcherTimer? _partialTimer;
    private CancellationTokenSource? _takeCts;
    private CancellationTokenSource? _fileCts;
    private int _fileBusy;
    private string _fileStatus = "";
    private DictatePhase _phase = DictatePhase.NoModel;
    /// <summary>Text selected when the key went down (read in the background); a take with a selection is a command on it.</summary>
    private Task<string?>? _selectionAtPress;

    /// <summary>The Brain can work right now: chosen, and set up (downloaded or configured).</summary>
    private bool SpeechIsRemote => _settings.NetworkRole == NetworkRole.Client;

    private DictatePhase ReadyPhase() =>
        SpeechIsRemote || _recognizer != null ? DictatePhase.Idle : DictatePhase.NoModel;

    private bool BrainUsable => _settings.Brain switch
    {
        BrainSource.Local => LocalBrain.IsReady(_settings),
        BrainSource.Server => Brain.ServerConfigured(_settings),
        _ => false,
    };

    [STAThread]
    public static int Main(string[] args)
    {
        // 1.17.0: the data folders were renamed. Move the old ones over before anything reads or logs.
        DataMigration.Run();
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

        _instanceMutex = new Mutex(true, "ChawoVoiceAssistant.SingleInstance", out bool first);
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

        var app = new ChawoApp();
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
        var app = new ChawoApp();
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
            sw.ShowPage(kind switch { "brain" or "server" or "edit" => SettingsWindow.Page.Brain, "speech" => SettingsWindow.Page.Speech, "network" => SettingsWindow.Page.Network, _ => SettingsWindow.Page.Dictation });
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
            var settings = Settings.Load();
            LocalBrain.DownloadAsync(settings, progress, CancellationToken.None).GetAwaiter().GetResult();
            File.AppendAllText(outPath, $"OK in {sw.Elapsed.TotalSeconds:F0}s, downloaded={LocalBrain.IsReady(settings)}\n");
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
        var app = new ChawoApp();
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
            var kind = DataMigration.Env("MODEL") == "v3"
                ? Core.SpeechModelKind.V3E2eRnnt : Core.SpeechModelKind.MultilingualLargeCtc;
            var device = DataMigration.Env("DEVICE") == "cpu"
                ? Core.SpeechDeviceKind.Cpu : Core.SpeechDeviceKind.Gpu;
            var modelDir = DataMigration.Env("MODEL_DIR") is { Length: > 0 } env ? env
                : SpeechModelStore.FindComplete(kind) ?? Settings.ModelDirectory(kind);
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
        DataMigration.FlushLog();
        Autostart.MigrateLegacy();

        _iconIdle = LoadIcon();
        _iconBusy = MakeBusyIcon(_iconIdle, out _busyIconHandle);
        _tray = new Forms.NotifyIcon
        {
            Icon = _iconIdle,
            Text = TrayText(null),
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
            _hook.CancelPressed += () => Dispatcher.BeginInvoke(RequestStop);
            SetPhase(_phase);
        }
        catch (Exception ex)
        {
            Log.Write($"hook failed: {ex}");
        }

        SetStatus(null);
        if (JustUpdated)
        {
            Updater.Cleanup();
            _tray.ShowBalloonTip(6000, L.T($"Chawo Voice Assistant обновлён до {Version}", $"Chawo Voice Assistant updated to {Version}"),
                L.T("Всё готово, можно диктовать.", "All set, dictate away."), Forms.ToolTipIcon.None);
        }
        // No update check on a timer. The tray and About have a manual button for this fork's releases.
        if (!_settings.FirstRunDone)
        {
            _settings.FirstRunDone = true;
            _settings.Save();
            if (SpeechIsRemote)
                _tray.ShowBalloonTip(8000, L.T("Chawo Voice Assistant — клиент", "Chawo Voice Assistant is a client"),
                    L.T("Укажите адрес хоста в разделе «Сеть». Модель на этом компьютере не скачивается.",
                        "Set the host address under Network. This PC does not download a model."),
                    Forms.ToolTipIcon.None);
            else if (_recognizer == null)
                _tray.ShowBalloonTip(8000, L.T("Модель не скачана", "Speech model is not downloaded"),
                    L.T("Откройте настройки и нажмите «Скачать выбранную модель». Сама она не скачивается.",
                        "Open Settings and press Download the selected model. It does not download by itself."),
                    Forms.ToolTipIcon.None);
            else
            _tray.ShowBalloonTip(8000, L.T("Chawo Voice Assistant готов", "Chawo Voice Assistant is ready"),
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
                        L.T($"{ProductName} {Version}", $"{ProductName} {Version}"),
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
                    L.T($"{ProductName} {Version}", $"{ProductName} {Version}"),
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
        else _tray?.ShowBalloonTip(2500, ProductName, text, Forms.ToolTipIcon.None);
    }

    private async Task HandlePressAsync()
    {
        if (_busy || _recorder.IsRecording) return;
        if (SpeechIsRemote)
        {
            if (!RemoteSpeech.TryEndpoint(_settings, out _, out var ru, out var en))
            {
                SetPhase(DictatePhase.Idle);
                Hint(L.T(ru, en));
                return;
            }
        }
        else if (_recognizer == null)
        {
            SetPhase(DictatePhase.NoModel);
            bool onDisk = SpeechModelStore.FindComplete(_settings.SpeechModel) != null;
            if (onDisk)
                Hint(L.T("Модель на диске, но сессия не загружена. На «Распознавании» нажмите «Запустить прогрев», если выбрана видеокарта. Веса сами не скачиваются.",
                         "The model is on disk, but the session is not loaded. On Speech, press Start warmup when the video card is selected. Weights are not downloaded by themselves."));
            else
                Hint(L.T("Модель не скачана. Откройте окно и нажмите «Скачать выбранную модель». Сама она не скачивается.",
                         "The model is not downloaded. Open the window and press Download the selected model. It does not download by itself."));
            return;
        }
        _abandonTake = false;
        _selectionAtPress = BrainUsable && _settings.BrainOnSelection ? SelectionReader.TryGetAsync(_lifetime.Token) : null;
        if (_selectionAtPress != null) _ = HintSelectionAsync(_selectionAtPress);
        try
        {
            await _recorder.StartAsync(_settings.MicrophoneId);
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
            SetPhase(ReadyPhase());
            return;
        }
        if (_tray != null) _tray.Icon = _iconBusy;
        if (_settings.ShowOverlay)
        {
            _overlay ??= new OverlayWindow(_settings, _settings.Save);
            _overlay.ShowListening(_recorder);
        }
        // Sales needs the live draft even when the pill is hidden. Dictation does not.
        if (_settings.ShowOverlay || _settings.Mode == AppMode.Sales)
            StartPartials();
        SetPhase(DictatePhase.Listening);
    }

    /// <summary>Escape or the Stop button. Drops the take: nothing is inserted.</summary>
    private void RequestStop()
    {
        if (!_recorder.IsRecording && !_busy) return;
        _abandonTake = true;
        Interlocked.Increment(ref _partialEpoch);
        try { _remotePartialCts?.Cancel(); } catch (ObjectDisposedException) { }
        _recognizer?.CancelOwned();
        try { _takeCts?.Cancel(); } catch (ObjectDisposedException) { }
        if (_recorder.IsRecording)
            _ = HandleReleaseAsync();
    }

    private void StartPartials()
    {
        StopPartials();
        _partialTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1000) };
        _partialTimer.Tick += (_, _) => _ = PartialTickAsync();
        _partialTimer.Start();
    }

    private void StopPartials()
    {
        if (_partialTimer == null) return;
        _partialTimer.Stop();
        _partialTimer = null;
    }

    /// <summary>
    /// One pass over the audio recorded so far. Skipped when the previous pass is still running,
    /// so the final pass is not queued behind a pile of drafts. The result is only shown.
    /// </summary>
    private async Task PartialTickAsync()
    {
        if (!_recorder.IsRecording) return;
        if (!_settings.ShowOverlay && _settings.Mode != AppMode.Sales) return;
        if (!SpeechIsRemote && _recognizer == null) return;
        if (Interlocked.CompareExchange(ref _partialBusy, 1, 0) != 0) return;
        int epoch = Volatile.Read(ref _partialEpoch);
        var rec = _recognizer;
        bool remote = SpeechIsRemote;
        var settings = _settings;
        var remoteCts = remote ? new CancellationTokenSource() : null;
        if (remote) _remotePartialCts = remoteCts;
        var task = Task.Run(() =>
        {
            if (Volatile.Read(ref _partialEpoch) != epoch || _abandonTake) return "";
            var samples = _recorder.Snapshot();
            if (samples.Length < Recorder.SampleRate * 6 / 10) return "";
            if (!HasSpeechDynamics(samples)) return "";
            float peak = 0;
            for (int i = 0; i < samples.Length; i++) peak = Math.Max(peak, Math.Abs(samples[i]));
            if (peak < SilenceFloor) return "";
            if (peak < TargetPeak)
            {
                float gain = Math.Min(TargetPeak / peak, MaxGain);
                for (int i = 0; i < samples.Length; i++) samples[i] *= gain;
            }
            if (Volatile.Read(ref _partialEpoch) != epoch || _abandonTake) return "";
            if (remote)
                return RemoteSpeech.Transcribe(settings, samples, Recorder.SampleRate, remoteCts!.Token);
            return rec!.TranscribeCancelable(samples, Recorder.SampleRate, () => Volatile.Read(ref _partialEpoch) == epoch && !_abandonTake);
        });
        _partialTask = task;
        try
        {
            string text = await task;
            if (epoch == Volatile.Read(ref _partialEpoch) && _recorder.IsRecording && !_abandonTake && text.Length > 0)
            {
                if (_settings.ShowOverlay) _overlay?.ShowPartial(text);
                if (_settings.Mode == AppMode.Sales) ShowSales(text);
            }
            if (text.Length > 0)
                Log.Write($"partial {text.Length} chars");
        }
        catch (RemoteHostException ex)
        {
            Log.Write($"partial remote: {ex.English}");
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Log.Write($"partial: {ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            if (remoteCts != null)
            {
                if (ReferenceEquals(_remotePartialCts, remoteCts)) _remotePartialCts = null;
                remoteCts.Dispose();
            }
            Interlocked.Exchange(ref _partialBusy, 0);
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
        bool abandon = _abandonTake;
        Interlocked.Increment(ref _partialEpoch);
        StopPartials();
        if (Volatile.Read(ref _partialBusy) != 0)
        {
            try { _remotePartialCts?.Cancel(); } catch (ObjectDisposedException) { }
            _recognizer?.CancelOwned();
        }
        var partialTask = _partialTask;
        _takeCts?.Dispose();
        _takeCts = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        if (abandon) _takeCts.Cancel();
        var overlay = _settings.ShowOverlay ? _overlay : null;
        try
        {
            var stopTask = _recorder.StopAsync();
            if (partialTask != null)
            {
                try { await partialTask; }
                catch (Exception ex) { Log.Write($"partial join: {ex.GetType().Name}"); }
            }
            var samples = await stopTask;
            if (abandon || _abandonTake)
            {
                overlay?.HideNow();
                Log.Write("take cancelled");
                return;
            }
            SetPhase(DictatePhase.Recognizing);
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
                if (SpeechIsRemote)
                {
                    try
                    {
                        text = await Task.Run(() => RemoteSpeech.Transcribe(_settings, samples, Recorder.SampleRate, _takeCts?.Token ?? CancellationToken.None));
                    }
                    catch (RemoteHostException ex)
                    {
                        overlay?.HideNow();
                        Log.Write("remote host: " + ex.English);
                        Hint(L.T(ex.Russian, ex.English));
                        return;
                    }
                }
                else
                    text = await Task.Run(() => _recognizer!.TranscribeCancelable(samples, Recorder.SampleRate, () => !_abandonTake));
                if (_abandonTake) { overlay?.HideNow(); Log.Write("recognize cancelled"); return; }
                if (text.Length > 0 && _settings.Mode == AppMode.Sales) ShowSales(text);
                // Dictionary on the finished recognition only, before the Brain sees the phrase. Not the live draft.
                if (text.Length > 0)
                {
                    var replaced = WordReplace.Apply(text, _settings.EffectiveWordReplacementRules);
                    if (!string.Equals(replaced, text, StringComparison.Ordinal))
                        Log.Write($"word replace before brain: {text.Length} -> {replaced.Length} chars");
                    text = replaced;
                }
                string? selected = _selectionAtPress != null && text.Length > 0 ? await _selectionAtPress : null;
                _selectionAtPress = null;
                if (selected != null)
                {
                    // Selected text + speech = a command on the selection ("make it shorter", "translate").
                    // The answer is pasted over the selection; Ctrl+Z in the app brings the original back.
                    Log.Write($"brain on selection, {selected.Length} chars");
                    var (answer, failure) = await RunBrainAsync(selected, Brain.StripAddress(text), selection: true, overlay);
                    if (_lifetime.IsCancellationRequested || _abandonTake) { overlay?.HideNow(); return; }
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
                        if (_lifetime.IsCancellationRequested || _abandonTake) { overlay?.HideNow(); return; }
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

            if (_abandonTake)
            {
                overlay?.HideNow();
                Log.Write("take cancelled before insert");
                return;
            }
            if (text.Length > 0)
            {
                overlay?.HideNow();
                var mode = _settings.InsertMode;
                var clip = new PhraseClipboardOptions(_settings.CopyPhraseToClipboard, _settings.RestoreClipboardAfterCopy);
                var result = await Task.Run(() => TextInserter.Insert(text, mode, _takeCts?.Token ?? _lifetime.Token, clip));
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
            _abandonTake = false;
            if (_tray != null) _tray.Icon = _iconIdle;
            SetPhase(ReadyPhase());
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
                status => { overlay?.ShowStatus(status); SetStatus(status); }, _takeCts?.Token ?? _lifetime.Token, selection);
            return answer.Trim().Length > 0 ? (answer, null) : (null, L.T("нейросеть вернула пустой ответ", "the model returned an empty answer"));
        }
        catch (OperationCanceledException) when (_abandonTake || _lifetime.IsCancellationRequested) { return (null, null); }
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
        ulong need = LocalBrain.MemoryNeeded(_settings);
        if (free == 0 || free >= need) return true;
        var answer = System.Windows.MessageBox.Show(
            L.T($"Свободно {LocalBrain.Gb(free)} ГБ памяти, а Мозгу нужно около {LocalBrain.Gb(need)} ГБ. Он всё равно запустится, но Windows начнёт выгружать другие программы на диск, и ждать можно несколько минут. Закройте тяжёлые программы и попробуйте снова, или запускайте так.",
                $"{LocalBrain.Gb(free)} GB of memory is free and the Brain needs about {LocalBrain.Gb(need)} GB. It will still start, but Windows will page other apps to disk and it may take minutes. Close heavy apps and try again, or go ahead anyway."),
            L.T("Памяти впритык", "Memory is tight"), System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Warning);
        return answer == System.Windows.MessageBoxResult.Yes;
    }

    /// <summary>Switches where the Brain runs. The local model is not downloaded here.</summary>
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
        if (source != BrainSource.Local) LocalBrain.Stop();
        _settings.Brain = source;
        ApplySettings();
        // Choosing "on this computer" must not download. The Brain tab button does that.
        if (source == BrainSource.Local && !LocalBrain.IsReady(_settings))
        {
            ShowSettings();
            _settingsWindow?.ShowPage(SettingsWindow.Page.Brain);
        }
        _settingsWindow?.Localize();
        if (source != BrainSource.Off && (source != BrainSource.Local || LocalBrain.IsReady(_settings)))
            _tray?.ShowBalloonTip(6000, L.T("Мозг включён", "Brain is on"),
                L.T("Скажите в конце фразы: «Чаво, исправь», «Чаво, сократи» или «Чаво, переведи на английский».",
                    "End a phrase with \"Chawo, fix it\", \"Chawo, make it shorter\" or \"Chawo, translate into English\" (in Russian)."),
                Forms.ToolTipIcon.None);
        await Task.CompletedTask;
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
            _tray?.ShowBalloonTip(4000, ProductName, text, Forms.ToolTipIcon.None);
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
        menu.Items.Add(L.T("Открыть окно", "Open window"), null, (_, _) => ShowSettings());
        menu.Items.Add(L.T("Выход", "Quit"), null, (_, _) => Quit());
        return menu;
    }

    private Task DownloadSpeechAsync(bool manualStart)
    {
        if (SpeechIsRemote)
        {
            System.Windows.MessageBox.Show(
                L.T("Этот компьютер — клиент. Речевая модель не скачивается. Адрес хоста задаётся в разделе «Сеть».",
                    "This PC is a client. The speech model is not downloaded. Set the host under Network."),
                L.T("Сеть", "Network"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Information);
            return Task.CompletedTask;
        }
        var existing = SpeechModelStore.FindComplete(_settings.SpeechModel);
        if (existing != null)
        {
            System.Windows.MessageBox.Show(
                L.T($"Эта модель уже на диске. Скачивать её снова не нужно.\n\n{existing}",
                    $"This model is already on disk. It will not be downloaded again.\n\n{existing}"),
                L.T("Модель уже на диске", "Model is already on disk"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Information);
            return ReloadSpeechAsync();
        }
        var window = new DownloadWindow(_settings.SpeechModel, manualStart);
        return DownloadAndReloadAsync(window);
    }

    private async Task DownloadAndReloadAsync(DownloadWindow window)
    {
        if (!await window.RunAsync()) return;
        await ReloadSpeechAsync();
        _settingsWindow?.Localize();
    }

    private async Task DeleteSpeechModelAsync(Core.SpeechModelKind kind)
    {
        Core.Recognizer? old = null;
        lock (_recogLock)
        {
            if (_recognizer != null && _recognizer.Kind == kind)
            {
                old = _recognizer;
                _recognizer = null;
            }
        }
        old?.Dispose();
        try
        {
            SpeechModelStore.DeleteInstalled(kind);
        }
        catch (Exception ex)
        {
            Log.Write($"speech delete failed: {ex.Message}");
            System.Windows.MessageBox.Show(
                L.T($"Не удалось удалить файлы. Если идёт распознавание, нажмите Стоп и попробуйте снова.\n\n{ex.Message}",
                    $"Could not delete the files. If recognition is running, press Stop and try again.\n\n{ex.Message}"),
                L.T("Удалить модель", "Delete model"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
        }
        await ReloadSpeechAsync();
    }

    private async Task ReloadSpeechAsync()
    {
        if (SpeechIsRemote)
        {
            Core.Recognizer? parked;
            lock (_recogLock)
            {
                parked = _recognizer;
                _recognizer = null;
                _speechNote = "";
                _gpuWarmed = false;
            }
            parked?.Dispose();
            SetStatus(null);
            SetPhase(DictatePhase.Idle);
            _settingsWindow?.Localize();
            return;
        }
        var kind = _settings.SpeechModel;
        var device = _settings.SpeechDevice;
        var dir = SpeechModelStore.FindComplete(kind);
        Core.Recognizer? next = null;
        string note = "";
        // A reloaded session has not had the dummy pass. The warmup button sets the flag after that.
        _gpuWarmed = false;
        if (dir != null)
        {
            SetStatus(L.T("Загружаю модель…", "Loading the model…"));
            try
            {
                var script = _settings.CtcScript;
                next = await Task.Run(() =>
                {
                    var rec = new Core.Recognizer(dir, kind, device, _settings.CpuThreads);
                    rec.Script = script;
                    return rec;
                });
                if (next.DeviceNote != null)
                    note = next.DeviceActual == "cpu"
                        ? L.T("Видеокарта не поднялась, считаю на процессоре.", "The video card did not start, running on the processor.")
                        : "";
                Log.Write($"model {next.ModelId} on {next.DeviceActual}/{next.Provider} intra={next.IntraOpThreads}" + (next.DeviceNote == null ? "" : $" note={next.DeviceNote}"));
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
            // The new session has not had the dummy pass, even if a warmup finished on the old one.
            _gpuWarmed = false;
        }
        old?.Dispose();
        SetStatus(null);
        SetPhase(ReadyPhase());
        _settingsWindow?.Localize();
    }

    private void SetPhase(DictatePhase phase)
    {
        _phase = phase;
        if (_hook != null)
            _hook.ArmCancel = phase is DictatePhase.Listening or DictatePhase.Recognizing;
        string text = phase switch
        {
            DictatePhase.NoModel => L.T("Сейчас: модель не загружена", "Now: the model is not loaded"),
            DictatePhase.Listening => L.T("Сейчас: слушаю…  отпустите клавишу, черновик на плашке", "Now: listening…  release the key, draft is on the pill"),
            DictatePhase.Recognizing => L.T("Сейчас: распознаю…  вставится окончательный текст", "Now: recognizing…  the final text will be inserted"),
            _ => L.T("Сейчас: готово, жду клавишу. Стоп — кнопка или Escape.", "Now: ready, waiting for the key. Stop is the button or Escape."),
        };
        _settingsWindow?.SetPhase(text, phase is DictatePhase.Listening or DictatePhase.Recognizing);
    }

    private string SpeechStatusText()
    {
        if (SpeechIsRemote)
        {
            if (!RemoteSpeech.TryEndpoint(_settings, out var uri, out var ru, out var en))
                return L.T(ru, en);
            return L.T($"Клиент. Звук уходит на {uri}. Местная речевая модель не запускается и не скачивается.",
                       $"Client. Audio goes to {uri}. The local speech model is not started and is not downloaded.");
        }
        var kind = _settings.SpeechModel;
        var found = SpeechModelStore.FindComplete(kind);
        if (found == null)
            return L.T("Эта модель на диске не найдена. Нажмите кнопку ниже, сама она не скачивается. Ищу в папках программы (и в папке прежней версии) и рядом с программой.",
                       "This model was not found on disk. Press the button below. It does not download by itself. The app's data folders (including the previous version's) and the folder next to the program are checked.");
        string whereFile = L.T($"Уже на диске: {found}. ", $"Already on disk: {found}. ");
        Core.Recognizer? rec;
        string note;
        lock (_recogLock) { rec = _recognizer; note = _speechNote; }
        if (rec == null || rec.Kind != kind)
            return whereFile + L.T("Файлы на месте, но сессия не загружена. ", "The files are there, but the session is not loaded. ") + note;
        string where = rec.DeviceActual == "gpu"
            ? L.T("видеокарте (DirectML)", "the video card (DirectML)")
            : L.T("процессоре", "the processor");
        string threads = rec.DeviceActual == "cpu"
            ? L.T($" Потоков процессора: {rec.IntraOpThreads}.", $" Processor threads: {rec.IntraOpThreads}.")
            : L.T(" Настройка потоков процессор не трогает, пока считает видеокарта.", " The processor-thread setting is idle while the video card runs.");
        string warm = "";
        if (rec.DeviceActual == "gpu")
            warm = _gpuWarmed
                ? L.T(" Прогрев включён.", " Warmup is on.")
                : L.T(" Прогрев не запускали.", " Warmup has not been run.");
        return whereFile + L.T($"Загружена {rec.ModelId}, считает на {where}. ", $"Loaded {rec.ModelId}, running on {where}. ") + note + threads + warm;
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
            L.T($"Порт {Core.SpeechModels.HermesPort} откроется в брандмауэре Windows (система спросит разрешение администратора), и Chawo Voice Assistant начнёт принимать записи со всех компьютеров в локальной сети. Адрес 0.0.0.0. В интернет звук не отправляется, но любой в этой сети сможет прислать файл на расшифровку. Продолжить?",
                $"Port {Core.SpeechModels.HermesPort} will be opened in Windows Firewall (Windows will ask for administrator permission) and Chawo Voice Assistant will accept recordings from every computer on the local network, on 0.0.0.0. Audio is not uploaded, but anyone on this network can send a file to transcribe. Continue?"),
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
        Core.Recognizer? rec;
        lock (_recogLock) rec = _recognizer;
        if (audio.Length == 0)
            return new HermesResult(rec != null, null, rec?.ModelId ?? _settings.SpeechModel.ToString(), rec?.DeviceActual ?? "", rec?.Provider ?? "", 0, null);
        if (rec == null)
            return new HermesResult(false, null, "", "", "", 0, null);
        try
        {
            float[] samples = FileTranscript.Decode16k(audio, "request");
            var ranges = rec.PieceRanges(samples);
            var parts = new List<string>(ranges.Count);
            foreach (var (from, to) in ranges)
            {
                lock (_recogLock)
                {
                    if (!ReferenceEquals(_recognizer, rec))
                        return new HermesResult(false, null, "", "", "", 0, "model unloaded");
                }
                var piece = new float[to - from];
                Array.Copy(samples, from, piece, 0, piece.Length);
                // One piece, then the session lock drops, so dictation on this PC can run between pieces.
                var bit = rec.TranscribePiece(piece);
                if (bit.Length > 0) parts.Add(bit);
            }
            string text = string.Join('\n', parts);
            Log.Write($"hermes {samples.Length / 16000.0:F1}s pieces={ranges.Count} -> {text.Length} chars");
            return new HermesResult(true, text, rec.ModelId, rec.DeviceActual, rec.Provider, samples.Length / 16000.0, null);
        }
        catch (Exception ex)
        {
            Log.Write($"hermes decode failed: {ex.GetType().Name}");
            return new HermesResult(true, null, rec.ModelId, rec.DeviceActual, rec.Provider, 0, ex.Message);
        }
    }

    /// <summary>Tray tooltip: the full name; the short form only when a status would not fit (Windows caps it at 127 chars).</summary>
    private static string TrayText(string? status)
    {
        if (string.IsNullOrEmpty(status)) return ProductName;
        var text = $"{ProductName}: {status}";
        if (text.Length > 127) text = $"{ProductShortName}: {status}";
        return text.Length > 127 ? text[..127] : text;
    }

    private void SetStatus(string? status)
    {
        if (_tray == null) return;
        _tray.Text = TrayText(status);
    }

    private bool GpuWarmActive()
    {
        lock (_recogLock)
            return _gpuWarmed && _recognizer != null && _recognizer.DeviceActual == "gpu" && _recognizer.Kind == _settings.SpeechModel;
    }

    /// <summary>Start keeps the speech session on DirectML and runs one tiny pass. Stop disposes it. The Brain is not touched.</summary>
    private async Task ToggleGpuWarmupAsync()
    {
        if (GpuWarmActive())
        {
            await StopGpuWarmupAsync();
            return;
        }
        await StartGpuWarmupAsync();
    }

    private async Task StartGpuWarmupAsync()
    {
        if (SpeechIsRemote)
        {
            System.Windows.MessageBox.Show(
                L.T("Этот компьютер — клиент. Местная модель не запускается и не скачивается.",
                    "This PC is a client. The local model is not started and is not downloaded."),
                L.T("Прогрев видеокарты", "Video card warmup"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Information);
            return;
        }
        if (_settings.SpeechDevice != Core.SpeechDeviceKind.Gpu)
            return;
        var kind = _settings.SpeechModel;
        var dir = SpeechModelStore.FindComplete(kind);
        if (dir == null)
        {
            _gpuWarmed = false;
            System.Windows.MessageBox.Show(
                L.T("Выбранная речевая модель на диске не найдена. Прогрев не запущен. Веса сами не скачиваются.",
                    "The selected speech model was not found on disk. Warmup did not start. Weights are not downloaded."),
                L.T("Прогрев видеокарты", "Video card warmup"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Information);
            _settingsWindow?.Localize();
            return;
        }
        if (_recorder.IsRecording || _busy)
        {
            System.Windows.MessageBox.Show(
                L.T("Сначала нажмите Стоп. Пока идёт диктовка, сессию не трогаю.",
                    "Press Stop first. The session is left alone while dictation is running."),
                L.T("Прогрев видеокарты", "Video card warmup"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Information);
            return;
        }
        Core.Recognizer? rec;
        lock (_recogLock) rec = _recognizer;
        bool reusable = rec != null && rec.Kind == kind && rec.DeviceActual == "gpu" && rec.ModelDir == dir;
        if (!reusable)
        {
            await ReloadSpeechAsync();
            lock (_recogLock) rec = _recognizer;
        }
        if (rec == null || rec.Kind != kind || rec.DeviceActual != "gpu")
        {
            _gpuWarmed = false;
            System.Windows.MessageBox.Show(
                L.T("Видеокарта не поднялась, прогрев не запущен.",
                    "The video card did not start, so warmup did not start."),
                L.T("Прогрев видеокарты", "Video card warmup"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
            _settingsWindow?.Localize();
            return;
        }
        SetStatus(L.T("Прогреваю видеокарту…", "Warming up the video card…"));
        try
        {
            await Task.Run(rec.Warmup);
            lock (_recogLock)
            {
                if (ReferenceEquals(_recognizer, rec) && rec.DeviceActual == "gpu" && rec.Kind == kind)
                    _gpuWarmed = true;
                else
                    _gpuWarmed = false;
            }
            Log.Write($"gpu warmup {(_gpuWarmed ? "ok" : "dropped")} model={rec.ModelId}");
        }
        catch (Exception ex)
        {
            _gpuWarmed = false;
            Log.Write($"gpu warmup failed: {ex.GetType().Name}: {ex.Message}");
            System.Windows.MessageBox.Show(
                L.T($"Прогрев не запущен.\n{ex.Message}", $"Warmup did not start.\n{ex.Message}"),
                L.T("Прогрев видеокарты", "Video card warmup"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
        }
        SetStatus(null);
        SetPhase(ReadyPhase());
        _settingsWindow?.Localize();
    }

    private Task StopGpuWarmupAsync()
    {
        if (_recorder.IsRecording || _busy)
        {
            System.Windows.MessageBox.Show(
                L.T("Сначала нажмите Стоп. Пока идёт диктовка, сессию не выгружаю.",
                    "Press Stop first. The session stays loaded while dictation is running."),
                L.T("Прогрев видеокарты", "Video card warmup"),
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Information);
            return Task.CompletedTask;
        }
        Core.Recognizer? old;
        lock (_recogLock)
        {
            old = _recognizer;
            _recognizer = null;
            _gpuWarmed = false;
        }
        old?.Dispose();
        Log.Write("gpu warmup stopped, speech session disposed");
        SetPhase(DictatePhase.NoModel);
        _settingsWindow?.Localize();
        return Task.CompletedTask;
    }

    private void CancelFile()
    {
        try { _fileCts?.Cancel(); } catch (ObjectDisposedException) { }
    }

    private async Task StartFileAsync(string path)
    {
        if (Interlocked.CompareExchange(ref _fileBusy, 1, 0) != 0)
        {
            SetFileStatus(L.T("Уже идёт другой файл.", "Another file is already running."));
            return;
        }
        var cts = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _fileCts = cts;
        SetFileStatus(L.T("Читаю файл…", "Reading the file…"));
        try
        {
            await Task.Run(() => RunFile(path, cts.Token));
        }
        catch (OperationCanceledException)
        {
            SetFileStatus(L.T("Остановлено. Текст не записан.", "Stopped. No text was written."));
        }
        catch (RemoteHostException ex)
        {
            Log.Write("file remote: " + ex.English);
            SetFileStatus(L.T(ex.Russian, ex.English));
        }
        catch (Exception ex)
        {
            Log.Write($"file: {ex.GetType().Name}: {ex.Message}");
            SetFileStatus(L.T("Не получилось прочитать файл. Ничего не скачиваю.",
                              "The file could not be read. Nothing is downloaded."));
        }
        finally
        {
            if (ReferenceEquals(_fileCts, cts)) _fileCts = null;
            cts.Dispose();
            Interlocked.Exchange(ref _fileBusy, 0);
            if (_settingsWindow != null)
                _ = Dispatcher.BeginInvoke(() => _settingsWindow?.SetFileStatus(_fileStatus, false));
        }
    }

    /// <summary>Local pieces, or one post to the host. Never downloads a model. Writes name.txt beside the source.</summary>
    private void RunFile(string path, CancellationToken cancel)
    {
        if (!File.Exists(path))
        {
            SetFileStatus(L.T("Такого файла нет. Ничего не скачиваю.", "That file is not there. Nothing is downloaded."));
            return;
        }
        long length;
        try { length = new FileInfo(path).Length; }
        catch (Exception)
        {
            SetFileStatus(L.T("Файл не открыть. Ничего не скачиваю.", "The file cannot be opened. Nothing is downloaded."));
            return;
        }
        if (length > FileTranscript.MaxBytes)
        {
            SetFileStatus(L.T("Файл больше примерно 1,7 ГБ. Ничего не скачиваю.",
                              "The file is over about 1.7 GB. Nothing is downloaded."));
            return;
        }
        string outPath = FileTranscript.OutputPath(path);
        if (SpeechIsRemote)
        {
            byte[] bytes;
            try { bytes = File.ReadAllBytes(path); }
            catch (Exception)
            {
                SetFileStatus(L.T("Файл не открыть. Ничего не скачиваю.", "The file cannot be opened. Nothing is downloaded."));
                return;
            }
            cancel.ThrowIfCancellationRequested();
            if (!FileTranscript.IsWav(bytes) && !FileTranscript.IsOgg(bytes))
            {
                SetFileStatus(L.T("Нужен файл WAV 16 бит или Ogg/Opus. Ничего не скачиваю.",
                                  "Need a 16-bit WAV or Ogg/Opus file. Nothing is downloaded."));
                return;
            }
            SetFileStatus(L.T("Отправляю файл на хост. Текст запишу здесь.",
                              "Sending the file to the host. The text will be written here."));
            string text = RemoteSpeech.TranscribeBytes(_settings, bytes, FileTranscript.IsOgg(bytes) ? "audio/ogg" : "audio/wav", cancel);
            cancel.ThrowIfCancellationRequested();
            File.WriteAllText(outPath, text);
            Log.Write($"file remote -> {outPath} {text.Length} chars");
            SetFileStatus(L.T($"Готово: {outPath}", $"Done: {outPath}"));
            return;
        }

        Core.Recognizer? rec;
        lock (_recogLock) rec = _recognizer;
        if (rec == null)
        {
            SetFileStatus(L.T("Модель не загружена. Файл не распознаю и ничего не скачиваю.",
                              "The model is not loaded. The file is not transcribed and nothing is downloaded."));
            return;
        }
        float[] samples;
        try { samples = FileTranscript.Load16k(path); }
        catch (InvalidDataException)
        {
            SetFileStatus(L.T("Нужен файл WAV 16 бит или Ogg/Opus. Ничего не скачиваю.",
                              "Need a 16-bit WAV or Ogg/Opus file. Nothing is downloaded."));
            return;
        }
        catch (Exception)
        {
            SetFileStatus(L.T("Файл не открыть. Ничего не скачиваю.", "The file cannot be opened. Nothing is downloaded."));
            return;
        }
        cancel.ThrowIfCancellationRequested();
        if (samples.Length == 0)
        {
            SetFileStatus(L.T("В файле нет звука. Текст не записан.", "The file has no audio. No text was written."));
            return;
        }
        var ranges = rec.PieceRanges(samples);
        var parts = new List<string>(ranges.Count);
        for (int i = 0; i < ranges.Count; i++)
        {
            cancel.ThrowIfCancellationRequested();
            SetFileStatus(L.T($"Кусок {i + 1} из {ranges.Count}", $"Piece {i + 1} of {ranges.Count}"));
            lock (_recogLock)
            {
                if (!ReferenceEquals(_recognizer, rec))
                {
                    SetFileStatus(L.T("Модель выгрузили посреди файла. Текст не записан. Ничего не скачиваю.",
                                      "The model was unloaded in the middle of the file. No text was written. Nothing is downloaded."));
                    return;
                }
            }
            var (from, to) = ranges[i];
            var piece = new float[to - from];
            Array.Copy(samples, from, piece, 0, piece.Length);
            string bit = rec.TranscribePiece(piece);
            if (bit.Length > 0) parts.Add(bit);
        }
        cancel.ThrowIfCancellationRequested();
        string all = string.Join('\n', parts);
        File.WriteAllText(outPath, all);
        Log.Write($"file local {samples.Length / 16000.0:F0}s pieces={ranges.Count} -> {outPath}");
        SetFileStatus(L.T($"Готово: {outPath}", $"Done: {outPath}"));
    }

    private void SetFileStatus(string text)
    {
        _fileStatus = text;
        _ = Dispatcher.BeginInvoke(() => _settingsWindow?.SetFileStatus(text, Volatile.Read(ref _fileBusy) != 0));
    }

    public void ShowSettings()
    {
        if (_settingsWindow == null)
        {
            _settingsWindow = new SettingsWindow(_settings, ApplySettings, () => { _overlay?.Unpin(); _settings.OverlayX = null; _settings.OverlayY = null; _settings.Save(); }, SelectBrainAsync,
                () => DownloadSpeechAsync(manualStart: false), () => _ = ReloadSpeechAsync(), SpeechStatusText,
                HermesStatusText, ToggleLanAsync,
                () => _ = CheckForUpdatesAsync(silent: false), RequestStop, DeleteSpeechModelAsync,
                ToggleGpuWarmupAsync, GpuWarmActive, () => _ = ReloadSpeechAsync(),
                StartFileAsync, CancelFile, PresentCall);
            SetPhase(_phase);
            if (_fileStatus.Length > 0 || Volatile.Read(ref _fileBusy) != 0)
                _settingsWindow.SetFileStatus(_fileStatus, Volatile.Read(ref _fileBusy) != 0);
            _settingsWindow.Closed += (_, _) => _settingsWindow = null;
        }
        _settingsWindow.Show();
        if (_settingsWindow.WindowState == WindowState.Minimized) _settingsWindow.WindowState = WindowState.Normal;
        // Windows may refuse the foreground to a tray app; a topmost blink still brings the window above the rest.
        _settingsWindow.Topmost = true;
        _settingsWindow.Activate();
        _settingsWindow.Topmost = false;
    }

    /// <summary>Local catalog card only. Does not download a model and does not call the network.</summary>
    private void ShowSales(string transcript)
    {
        if (_settings.Mode != AppMode.Sales) return;
        _salesTranscript = transcript;
        if (_openCall != null && _openBinding != null)
        {
            PaintCall();
            return;
        }
        var hit = SalesCatalog.Match(transcript, _settings.SalesCatalog);
        if (hit == null) return;
        var shown = hit.Value;
        // Exact code is enough. When the code is missing, also look in the local materials folder.
        if (shown.Kind == SalesHitKind.Similar)
        {
            var snip = SalesRag.FindSnippet(transcript, _settings.RagFolder);
            if (snip != null)
                shown = SalesCatalog.WithRag(shown, snip.Value.Text);
        }
        _salesCard ??= new SalesCardWindow();
        _salesCard.ShowHit(shown);
    }

    /// <summary>
    /// Hand-filled stand-in for a call event. No network.
    /// In SaaS the PC is bound once; a webhook / softphone / hotkey matches it.
    /// Empty extension or empty manager name is a missing binding: no card.
    /// </summary>
    private string PresentCall(string extension, string number, string manager)
    {
        if (_settings.Mode != AppMode.Sales)
            return L.T("Сначала включите режим «Продажи» на вкладке «Диктовка».",
                       "Turn on Sales mode on the Dictation tab first.");
        var stood = SalesFlow.StandIn(extension, number, manager);
        if (stood == null)
        {
            _openCall = null;
            _openBinding = null;
            _salesCard?.HideNow();
            return L.T("Стенд: нет привязки трубки к менеджеру. Карточка не показывается.",
                       "Stand-in: no handset-to-manager binding. No card.");
        }
        _openCall = stood.Value.Event;
        _openBinding = stood.Value.Binding;
        _salesTranscript = "";
        PaintCall();
        return L.T("Стенд: карточка на этом компьютере. CRM нет, сеть не используется.",
                   "Stand-in: card on this PC. No CRM, no network.");
    }

    private void PaintCall()
    {
        if (_openCall == null || _openBinding == null) return;
        var view = SalesFlow.Compose(_openCall.Value, _openBinding.Value, _salesTranscript, _settings.SalesCatalog, _settings.RagFolder);
        _salesCard ??= new SalesCardWindow();
        _salesCard.ShowModel(view);
    }

    private void ApplySettings()
    {
        _settings.Save();
        lock (_recogLock)
        {
            if (_recognizer != null) _recognizer.Script = _settings.CtcScript;
        }
        if (_hook != null) _hook.HotkeyVk = _settings.HotkeyVk;
        if (!_settings.ShowOverlay) _overlay?.HideNow();
        if (_settings.Mode != AppMode.Sales)
        {
            _openCall = null;
            _openBinding = null;
            _salesCard?.HideNow();
        }

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
        _salesCard?.Close();
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
