// Settings window, laid out like Windows 11 Settings: sections on the left
// (Dictation, Brain, About), the chosen section on the right. Every change is
// applied and saved immediately, the server Brain included.

using System.Diagnostics;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Controls;
using System.Windows.Navigation;
using ChawoVA.Core;

namespace ChawoVA.App;

public partial class SettingsWindow : Window
{
    private readonly Settings _settings;
    private readonly Action _apply;
    private readonly Action _unpin;
    private readonly Func<BrainSource, Task> _selectBrain;
    private readonly Func<Task>? _downloadSpeech;
    private readonly Action? _speechChanged;
    private readonly Func<string>? _speechStatus;
    private readonly Func<string>? _hermesStatus;
    private readonly Func<Task>? _toggleLan;
    private readonly Action? _checkUpdates;
    private readonly Action? _stop;
    private readonly Func<SpeechModelKind, Task>? _deleteSpeech;
    private readonly Func<Task>? _toggleGpuWarmup;
    private readonly Func<bool>? _gpuWarmed;
    private readonly Action? _networkChanged;
    private readonly Func<IReadOnlyList<string>, Task>? _transcribeFiles;
    private readonly Action? _cancelFile;
    private readonly Func<string, string, string, string>? _showCall;
    private readonly Func<Task>? _downloadFfmpeg;
    private readonly Func<string>? _ffmpegStatus;
    private string _phaseText = "";
    private bool _stopEnabled;
    private bool _loading = true;
    private bool _warmupBusy;
    private string _fileLine = "";
    private bool _fileRunning;
    /// <summary>Last open section, kept while the app runs.</summary>
    private static int _lastPage;

    public enum Page { Dictation, File, Speech, Dictionary, Sales, Brain, Network }

    public SettingsWindow(Settings settings, Action apply, Action unpin, Func<BrainSource, Task> selectBrain,
        Func<Task>? downloadSpeech = null, Action? speechChanged = null, Func<string>? speechStatus = null,
        Func<string>? hermesStatus = null, Func<Task>? toggleLan = null,
        Action? checkUpdates = null, Action? stop = null, Func<SpeechModelKind, Task>? deleteSpeech = null,
        Func<Task>? toggleGpuWarmup = null, Func<bool>? gpuWarmed = null, Action? networkChanged = null,
        Func<IReadOnlyList<string>, Task>? transcribeFiles = null, Action? cancelFile = null,
        Func<string, string, string, string>? showCall = null,
        Func<Task>? downloadFfmpeg = null, Func<string>? ffmpegStatus = null)
    {
        _settings = settings;
        _apply = apply;
        _unpin = unpin;
        _selectBrain = selectBrain;
        _downloadSpeech = downloadSpeech;
        _speechChanged = speechChanged;
        _speechStatus = speechStatus;
        _hermesStatus = hermesStatus;
        _toggleLan = toggleLan;
        _checkUpdates = checkUpdates;
        _stop = stop;
        _deleteSpeech = deleteSpeech;
        _toggleGpuWarmup = toggleGpuWarmup;
        _gpuWarmed = gpuWarmed;
        _networkChanged = networkChanged;
        _transcribeFiles = transcribeFiles;
        _cancelFile = cancelFile;
        _showCall = showCall;
        _downloadFfmpeg = downloadFfmpeg;
        _ffmpegStatus = ffmpegStatus;
        InitializeComponent();
        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            Native.UseImmersiveDarkMode(hwnd);
        };
        if (Application.Current is ChawoApp app) app.AttachWindowIcon(this);
        ServerPanel.Saved += UpdateBrainTexts;   // the panel has already applied and saved
        Localize();
        Nav.SelectedIndex = _lastPage;
    }

    public void ShowPage(Page page) => Nav.SelectedIndex = (int)page;

    private void Nav_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (Nav.SelectedIndex < 0) { Nav.SelectedIndex = _lastPage; return; }
        _lastPage = Nav.SelectedIndex;
        if (_lastPage > (int)Page.Network) _lastPage = 0;
        UIElement[] pages = { DictationPage, FilePage, SpeechPage, DictionaryPage, SalesPage, BrainPage, NetworkPage };
        for (int i = 0; i < pages.Length; i++)
            pages[i].Visibility = i == _lastPage ? Visibility.Visible : Visibility.Collapsed;
        if (_lastPage == (int)Page.Brain && _settings.Brain == BrainSource.Server) ServerPanel.FocusKey();
    }

    /// <summary>Fills every text in the current UI language; called again when the language changes.</summary>
    public void Localize()
    {
        _loading = true;
        Title = L.T($"{ChawoApp.ProductName} {ChawoApp.Version}", $"{ChawoApp.ProductName} {ChawoApp.Version}");
        NavDictation.Text = L.T("Диктовка", "Dictation");
        NavFile.Text = L.T("Расшифровка файла", "File transcription");
        NavSpeech.Text = L.T("Распознавание", "Speech");
        NavDictionary.Text = L.T("Словарь", "Dictionary");
        NavSales.Text = "Продажи";
        NavBrain.Text = L.T("Мозг", "Brain");
        NavNetwork.Text = L.T("Сеть", "Network");
        Heading.Text = L.T("Диктовка", "Dictation");
        Intro.Text = L.T("Курсор в любой текст, зажмите клавишу и говорите. Отпустите, и текст появится сам.",
                         "Cursor in any text, hold the key and speak. Release and the text appears by itself.");
        ModeLabel.Text = L.T("Режим", "Mode");
        ModeBox.Items.Clear();
        ModeBox.Items.Add(new ComboBoxItem { Content = "Диктовка", Tag = AppMode.Dictation });
        ModeBox.Items.Add(new ComboBoxItem { Content = "Продажи", Tag = AppMode.Sales });
        foreach (ComboBoxItem it in ModeBox.Items)
            if ((AppMode)it.Tag == _settings.Mode) ModeBox.SelectedItem = it;
        ModeHint.Text = _settings.Mode == AppMode.Sales
            ? L.T("Карточка из каталога и, если кода нет, фрагмент из папки материалов. Сеть и модель для неё не нужны. Диктовка вставляет текст как раньше.",
                  "The card comes from the catalog and, when the code is missing, a snippet from the materials folder. It needs no network and no model. Dictation still inserts text as before.")
            : L.T("Обычная диктовка. Карточка продаж не показывается.",
                  "Ordinary dictation. The sales card stays hidden.");
        HotkeyLabel.Text = L.T("Клавиша диктовки", "Dictation key");
        InsertLabel.Text = L.T("Как вставлять текст", "How to insert text");
        LanguageLabel.Text = L.T("Язык интерфейса", "Interface language");

        HotkeyBox.Items.Clear();
        foreach (var (vk, ru, en) in Settings.HotkeyChoices)
            HotkeyBox.Items.Add(new ComboBoxItem { Content = L.T(ru, en), Tag = vk });
        HotkeyBox.SelectedIndex = Math.Max(0, Array.FindIndex(Settings.HotkeyChoices, c => c.vk == _settings.HotkeyVk));

        InsertBox.Items.Clear();
        InsertBox.Items.Add(new ComboBoxItem { Content = L.T("Печатать как с клавиатуры", "Type like a keyboard") });
        InsertBox.Items.Add(new ComboBoxItem { Content = L.T("Через буфер обмена (Ctrl+V)", "Through the clipboard (Ctrl+V)") });
        InsertBox.SelectedIndex = _settings.InsertMode == InsertMode.Paste ? 1 : 0;

        LanguageBox.Items.Clear();
        LanguageBox.Items.Add(new ComboBoxItem { Content = L.T("Как в системе", "Same as system"), Tag = UiLanguage.Auto });
        LanguageBox.Items.Add(new ComboBoxItem { Content = "Русский", Tag = UiLanguage.Russian });
        LanguageBox.Items.Add(new ComboBoxItem { Content = "English", Tag = UiLanguage.English });
        LanguageBox.SelectedIndex = (int)_settings.Language;

        MicLabel.Text = L.T("Микрофон", "Microphone");
        MicHint.Text = L.T("По умолчанию — то устройство, которое Windows считает основным. Если входов несколько, они перечислены ниже, можно выбрать свой.",
                           "Default is whichever device Windows treats as the main one. If there are more inputs, they are listed and you can pick one.");
        MicBox.Items.Clear();
        MicBox.Items.Add(new ComboBoxItem
        {
            Content = L.T("По умолчанию Windows", "Windows default") + " — " + Recorder.DefaultDeviceName(),
            Tag = "",
        });
        foreach (var device in Recorder.InputDevices())
            MicBox.Items.Add(new ComboBoxItem { Content = device.Name, Tag = device.Id });
        int micIndex = 0;
        for (int i = 0; i < MicBox.Items.Count; i++)
            if (MicBox.Items[i] is ComboBoxItem it && (string)it.Tag == _settings.MicrophoneId) micIndex = i;
        if (micIndex == 0 && _settings.MicrophoneId.Length > 0)
        {
            _settings.MicrophoneId = "";
            _settings.Save();
        }
        MicBox.SelectedIndex = micIndex;

        OverlayBox.Content = L.T("Показывать плашку: волна и черновик текста", "Show the pill: wave and the draft text");
        StopButton.Content = L.T("Стоп", "Stop");
        StopButton.IsEnabled = _stopEnabled;
        StopButton.ToolTip = L.T("Остановить запись или распознавание. То же делает Escape. Готовая фраза при этом не вставляется.",
                                 "Stop recording or recognition. Escape does the same. The phrase is not inserted.");
        if (_phaseText.Length > 0) PhaseLine.Text = _phaseText;
        else PhaseLine.Text = L.T("Сейчас: …", "Now: …");
        CopyClipBox.Content = L.T("Копировать готовую фразу в буфер", "Copy the finished phrase to the clipboard");
        CopyClipBox.IsChecked = _settings.CopyPhraseToClipboard;
        CopyClipHint.Text = L.T("Выключено, пока сами не включите. Тогда фразу можно вставить Ctrl+V, если поле промахнулось.",
                                "Off until you turn it on. Then you can paste the phrase with Ctrl+V if the field missed it.");
        RestoreClipBox.Content = L.T("После копирования вернуть прежний буфер, фразу оставить в Win+V",
                                     "After copying, restore the previous clipboard and keep the phrase in Win+V");
        RestoreClipBox.IsChecked = _settings.RestoreClipboardAfterCopy;
        RestoreClipBox.Visibility = _settings.CopyPhraseToClipboard ? Visibility.Visible : Visibility.Collapsed;
        AutostartBox.Content = L.T("Запускать при входе в Windows", "Start when I sign in to Windows");
        TrayHint.Text = L.T("Крестик прячет окно. Выход — пункт «Выход» в трее.",
                            "The close button hides the window. Quit is in the tray menu.");
        OverlayBox.IsChecked = _settings.ShowOverlay;
        OverlayBox.ToolTip = L.T("Пока клавиша зажата, на плашке волна и черновик. Вставляется не он, а окончательный проход после отпускания. Плашку можно перетащить мышью.",
                                 "While the key is held the pill shows the wave and a draft. What is inserted is the final pass after release, not the draft. Drag the pill to pin it.");
        UnpinButton.Content = L.T("Вернуть к курсору", "Back to the caret");
        UnpinButton.ToolTip = L.T("Плашка снова будет появляться у курсора", "The pill follows the caret again");
        UnpinButton.IsEnabled = _settings.OverlayX != null;
        AutostartBox.IsChecked = Autostart.IsEnabled();
        CheckUpdatesButton.Content = L.T("Проверить обновления", "Check for updates");

        SpeechHeading.Text = L.T("Распознавание", "Speech");
        SpeechIntro.Text = _settings.NetworkRole == NetworkRole.Client
            ? L.T("Сейчас этот ПК — клиент. Речевая модель здесь не скачивается и не запускается. Адрес хоста — в разделе «Сеть».",
                  "This PC is a client. The speech model is not downloaded or started here. The host address is under Network.")
            : L.T("Модель, которая слушает микрофон. Сама ничего не скачивает: кнопка в строке модели.",
                  "The model that listens to the microphone. Nothing downloads until you press the button on that model's row.");
        ModelLabel.Text = L.T("Речевые модели", "Speech models");
        ModelNote.Text = L.T("Русская v3 ставит запятые и заглавные. Большая пишет слова без знаков.",
                             "Russian v3 adds commas and capitals. The large model writes words without punctuation.");
        DeviceLabel.Text = L.T("Где считать речь", "Where speech runs");
        DeviceBox.Items.Clear();
        DeviceBox.Items.Add(new ComboBoxItem { Content = L.T("Видеокарта (DirectML)", "Video card (DirectML)"), Tag = SpeechDeviceKind.Gpu });
        DeviceBox.Items.Add(new ComboBoxItem { Content = L.T("Процессор (CPU)", "Processor (CPU)"), Tag = SpeechDeviceKind.Cpu });
        foreach (ComboBoxItem it in DeviceBox.Items)
            if ((SpeechDeviceKind)it.Tag == _settings.SpeechDevice) DeviceBox.SelectedItem = it;
        int cores = Math.Max(1, Environment.ProcessorCount);
        ThreadsLabel.Text = L.T("Потоки процессора", "Processor threads");
        ThreadsHint.Text = L.T($"Список виден только на процессоре. «Все ядра» — это {cores}. На видеокарте потоки не меняются.",
                                $"Shown only for the processor. All cores means {cores}. The video card ignores this.");
        ThreadsPanel.Visibility = _settings.SpeechDevice == SpeechDeviceKind.Cpu ? Visibility.Visible : Visibility.Collapsed;
        bool gpu = _settings.SpeechDevice == SpeechDeviceKind.Gpu;
        WarmupPanel.Visibility = gpu ? Visibility.Visible : Visibility.Collapsed;
        WarmupLabel.Text = L.T("Прогрев видеокарты", "Video card warmup");
        WarmupHint.Text = L.T("Держит выбранную речевую модель на видеокарте и один раз прогоняет короткий тихий звук, чтобы первая фраза не ждала компиляцию DirectML. Мозг не трогает. Если модели нет на диске, ничего не качает.",
                               "Keeps the selected speech model on the video card and runs one short silent pass so the first phrase does not wait for DirectML to compile. The Brain is not touched. If the model is not on disk, nothing is downloaded.");
        bool warmed = gpu && _gpuWarmed?.Invoke() == true;
        WarmupButton.Content = warmed ? L.T("Остановить", "Stop") : L.T("Запустить прогрев", "Start warmup");
        WarmupButton.IsEnabled = !_warmupBusy;
        WarmupStatus.Text = warmed
            ? L.T("Прогрев включён: сессия речи на видеокарте.", "Warmup is on: the speech session is on the video card.")
            : L.T("Прогрев выключен.", "Warmup is off.");
        ThreadsBox.Items.Clear();
        ThreadsBox.Items.Add(new ComboBoxItem { Content = L.T($"Все ядра ({cores})", $"All cores ({cores})"), Tag = 0 });
        for (int n = 1; n <= cores; n++)
            ThreadsBox.Items.Add(new ComboBoxItem { Content = n.ToString(), Tag = n });
        int want = _settings.CpuThreads <= 0 || _settings.CpuThreads > cores ? 0 : _settings.CpuThreads;
        foreach (ComboBoxItem it in ThreadsBox.Items)
            if ((int)it.Tag == want) ThreadsBox.SelectedItem = it;
        SpeechStatus.Text = _speechStatus?.Invoke()
            ?? L.T("Модель не скачана. Нажмите «Скачать» в её строке.",
                   "The model is not downloaded. Press Download on its row.");
        FillSpeechModelRows();
        DictionaryHeading.Text = L.T("Словарь", "Dictionary");
        DictionaryIntro.Text = L.T("Готовая фраза после распознавания и до мозга. Черновик на плашке не меняется. Пустая строка не считается.",
                                   "The finished phrase, after recognition and before the Brain. The live draft is left alone. An empty row does nothing.");
        HeardHeader.Text = L.T("Как слышно", "Heard");
        WrittenHeader.Text = L.T("Как писать", "Written");
        AddDictionaryButton.Content = L.T("Добавить", "Add");
        SuggestDictionaryButton.Content = L.T("Подсказать из материалов", "Suggest from materials");
        SuggestDictionaryHint.Text = L.T("Берёт латинские бренды и соседние русские слова из папки материалов на вкладке «Продажи». В словарь само не пишет — только предлагает строки.",
                                         "Takes Latin brands and neighboring Russian words from the materials folder on the Sales tab. Nothing is written into the dictionary until you add a row.");
        FillDictionaryRows();
        FillSuggestDictionaryRows(clear: true);
        SalesHeading.Text = "Продажи";
        SalesIntro.Text = L.T(
            "Каталог на этом компьютере. Код в живом черновике открывает карточку с короткой строкой. Если кода нет, берётся ближайшее название по буквам и на карточке пишется «похоже». Ниже — папка материалов (.txt / .md): из неё подставляется короткий фрагмент под карточкой, когда точного кода нет. Облака нет. Панель ниже — только стенд: в SaaS добавочный не печатают в момент звонка, компьютер привязан заранее.",
            "A catalog on this PC. A code in the live draft opens a card with the short line. If the code is missing, the nearest name by letters is shown and the card says «похоже». Below is a materials folder (.txt / .md): a short snippet from it appears under the card when the exact code is missing. No cloud. The panel below is only a stand-in: in SaaS nobody types an extension at popup time; the PC is bound beforehand.");
        CallHeading.Text = L.T("Звонок (стенд)", "Call (stand-in)");
        CallIntro.Text = L.T(
            "Стенд, не продукт. В сервисе добавочный берётся из привязки ПК или из события телефонии / softphone / клавиши. Здесь поля заполняют руками, чтобы открыть ту же карточку без сети. Пустой добавочный или пустое имя — привязки нет, карточки нет. Номер можно не заполнять.",
            "A stand-in, not the product. In the service the extension comes from the PC binding or from a telephony / softphone / hotkey event. Here the fields are typed by hand so the same card opens with no network. An empty extension or an empty name means no binding, so no card. The number may be left blank.");
        CallExtensionHeader.Text = L.T("Добавочный", "Extension");
        CallNumberHeader.Text = L.T("Номер", "Number");
        CallManagerHeader.Text = L.T("Менеджер", "Manager");
        ShowCallButton.Content = L.T("Показать карточку", "Show card");
        CodeHeader.Text = L.T("Код", "Code");
        NameHeader.Text = L.T("Название", "Name");
        LineHeader.Text = L.T("Строка", "Line");
        SimilarHeader.Text = L.T("Похожий код", "Similar code");
        AddSalesButton.Content = L.T("Добавить", "Add");
        RagHeading.Text = L.T("Материалы (локальный RAG)", "Materials (local RAG)");
        RagIntro.Text = L.T("Папка с текстовыми и markdown-файлами на этом компьютере. Никуда не загружается. В режиме «Продажи», если кода нет, на карточке под строкой каталога показывается ближайший фрагмент.",
                            "A folder of text and markdown files on this PC. Nothing is uploaded. In Sales mode, when the code is missing, the nearest snippet appears on the card under the catalog line.");
        RagPickButton.Content = L.T("Выбрать папку", "Choose folder");
        RagClearButton.Content = L.T("Убрать", "Clear");
        RefreshRagFolderUi();
        FillSalesRows();


        NetworkHeading.Text = L.T("Сеть", "Network");
        NetworkIntro.Text = L.T("Хост распознаёт на этом компьютере и принимает подключения. Клиент отправляет звук на другой компьютер и модель не скачивает.",
                                "The host recognizes on this PC and accepts connections. A client sends audio to another PC and does not download a model.");
        RoleLabel.Text = L.T("Роль", "Role");
        RoleBox.Items.Clear();
        RoleBox.Items.Add(new ComboBoxItem { Content = L.T("Хост: этот компьютер распознаёт сам и принимает подключения", "Host: this PC recognizes on its own and accepts connections"), Tag = NetworkRole.Host });
        RoleBox.Items.Add(new ComboBoxItem { Content = L.T("Клиент: звук уходит на другой компьютер", "Client: audio goes to another PC"), Tag = NetworkRole.Client });
        foreach (ComboBoxItem it in RoleBox.Items)
            if ((NetworkRole)it.Tag == _settings.NetworkRole) RoleBox.SelectedItem = it;
        bool client = _settings.NetworkRole == NetworkRole.Client;
        HostPanel.Visibility = client ? Visibility.Collapsed : Visibility.Visible;
        ClientPanel.Visibility = client ? Visibility.Visible : Visibility.Collapsed;
        HostNote.Text = L.T(
            $"Этот компьютер распознаёт сам и принимает подключения. Диктовка здесь не выключается. Порт {SpeechModels.HermesPort}. Пока кнопку ниже не нажать, подключения только с этого компьютера (127.0.0.1). После кнопки — со всех адресов (0.0.0.0), тот же порт.",
            $"This PC recognizes on its own and accepts connections. Dictation stays on. Port {SpeechModels.HermesPort}. Until you press the button below, connections are from this PC only (127.0.0.1). After the button, every address (0.0.0.0), same port.");
        HermesHeading.Text = L.T("Порт расшифровки", "Transcription port");
        HermesListenStatus.Text = _hermesStatus?.Invoke()
            ?? L.T($"Сейчас только этот компьютер, порт {SpeechModels.HermesPort}.",
                   $"This computer only right now, port {SpeechModels.HermesPort}.");
        LanButton.Content = _settings.HermesOnLan
            ? L.T("Снова слушать только этот компьютер", "Listen on this PC only again")
            : L.T("Открыть порт в брандмауэре и слушать сеть", "Open the firewall port and listen on the network");
        ClientNote.Text = L.T(
            "Звук уходит на другой компьютер: http://адрес:порт/v1/transcribe. Местная речевая модель не запускается и не скачивается. Если хост молчит, будет короткая ошибка.",
            "Audio goes to another PC: http://address:port/v1/transcribe. The local speech model is not started and is not downloaded. If the host is down, you get a short error.");
        RemoteHostLabel.Text = L.T("Адрес хоста", "Host address");
        RemotePortLabel.Text = L.T("Порт", "Port");
        RemoteHostBox.Text = _settings.RemoteHost;
        int port = _settings.RemotePort is >= 1 and <= 65535 ? _settings.RemotePort : SpeechModels.HermesPort;
        RemotePortBox.Text = port.ToString();
        CheckHostButton.Content = L.T("Проверить хост", "Check the host");
        if (string.IsNullOrWhiteSpace(HostCheckStatus.Text))
            HostCheckStatus.Text = L.T("Проверка только спрашивает /v1/health. Модель не скачивается.",
                                       "The check only asks /v1/health. No model is downloaded.");
                FileHeading.Text = L.T("Расшифровка файла", "File transcription");
        FileNote.Text = L.T(
            "Файл или папка на этом компьютере. WAV, MP3, M4A/AAC, MP4/MOV/MKV/WebM, FLAC, WMA, AMR, Ogg/Opus и другие, что умеют Media Foundation или ffmpeg. Длинная запись режется на куски не длиннее 24 секунд. Рядом с каждым файлом пишется .txt. Если модель на диске, но ещё не в памяти — загрузится сама (как при диктовке). В режиме клиента звук уходит на хост после декодирования здесь. Веса речи сами не скачиваются.",
            "A file or folder on this PC. WAV, MP3, M4A/AAC, MP4/MOV/MKV/WebM, FLAC, WMA, AMR, Ogg/Opus and anything Media Foundation or ffmpeg can decode. Long audio is split into pieces of at most 24 seconds. A .txt is written beside each file. If the model is on disk but not in memory yet, it loads on demand (same as dictation). In client mode audio is decoded here then sent to the host. Speech weights are not downloaded by themselves.");
        FilePickButton.Content = L.T("Обзор…", "Browse…");
        FileFolderButton.Content = L.T("Папка…", "Folder…");
        FileRunButton.Content = L.T("Расшифровать", "Transcribe");
        FileStopButton.Content = L.T("Остановить", "Stop");
        FileSpeedLabel.Text = L.T("Скорость длинных записей", "Speed for long recordings");
        FileSpeedHint.Text = L.T(
            "Сколько кусков распознаётся одновременно. Больше — быстрее, но нужно больше памяти. Диктовку не замедляет.",
            "How many pieces are recognized at once. More is faster, but needs more memory. Does not slow dictation.");
        FillFileSpeedBox();
        FileFfmpegButton.Content = L.T("Скачать ffmpeg", "Download ffmpeg");
        FilePickButton.IsEnabled = !_fileRunning;
        FileFolderButton.IsEnabled = !_fileRunning;
        FileRunButton.IsEnabled = !_fileRunning;
        FileFfmpegButton.IsEnabled = !_fileRunning && _downloadFfmpeg != null;
        FilePathBox.IsEnabled = !_fileRunning;
        FileSpeedBox.IsEnabled = !_fileRunning;
        FileStopButton.Visibility = _fileRunning ? Visibility.Visible : Visibility.Collapsed;
        FileStatus.Text = _fileLine.Length > 0
            ? _fileLine
            : L.T("Текст ляжет рядом с записью: то же имя, расширение .txt. Можно выбрать несколько файлов или папку.",
                  "The text is written beside the recording: same name, .txt extension. You can pick several files or a folder.");
        FileFfmpegStatus.Text = _ffmpegStatus?.Invoke() ?? FfmpegTool.StatusLine();

        CleanupHeading.Text = L.T("Мозг", "Brain");
        CleanupHint.Text = L.T("Выключен: текст вставляется как распознан. Можно сказать «Чаво, исправь». Чтобы править каждую фразу, включите переписывание ниже.",
                               "Off: text is inserted as recognized. You can say \"Chawo, fix it\". Turn on rewrite below to edit every phrase.");
        BrainLabel.Text = L.T("Где думает", "Runs on");
        BrainBox.Items.Clear();
        BrainBox.Items.Add(new ComboBoxItem { Content = L.T("Выключен", "Off"), Tag = BrainSource.Off });
        if (LocalBrain.Offered || _settings.Brain == BrainSource.Local)
            BrainBox.Items.Add(new ComboBoxItem
            {
                Content = LocalBrain.IsReady(_settings)
                    ? L.T($"На компьютере ({LocalBrain.Title(_settings)})", $"On this computer ({LocalBrain.Title(_settings)})")
                    : L.T("На компьютере", "On this computer"),
                Tag = BrainSource.Local,
            });
        BrainBox.Items.Add(new ComboBoxItem { Content = L.T("В облаке", "In the cloud"), Tag = BrainSource.Server });
        foreach (ComboBoxItem it in BrainBox.Items)
            if ((BrainSource)it.Tag == _settings.Brain) BrainBox.SelectedItem = it;
        ServerPanel.Bind(_settings, _apply);
        BrainModelLabel.Text = L.T("Модель на компьютере", "Model on this computer");
        FillBrainModelRows();
        BrainUrlLabel.Text = L.T("Ссылка Hugging Face", "Hugging Face link");
        BrainUrlBox.Text = _settings.BrainCustomUrl;
        BrainUrlBox.ToolTip = L.T("Страница файла .gguf или прямая ссылка resolve. Скачивается только по кнопке ниже.",
                                  "A .gguf file page or a resolve link. Downloaded only by the button below.");
        InstructionLabel.Text = L.T("Как переписывать", "How to rewrite");
        InstructionBox.Text = _settings.BrainInstruction;
        InstructionHint.Text = L.T("Пусто: убрать повторы, слова-паразиты и чужой разговор. Смысл не сокращать и слова не добавлять. Написали своё: выполняется только этот текст.",
                                   "Empty: drop repeats, filler, and someone else's conversation. Do not cut the meaning or add words. Your text: only that is followed.");
        BrainDeviceLabel.Text = L.T("Где считает", "Where it runs");
        BrainDeviceHint.Text = L.T("Процессор уже в программе. Видеокарта качает сборку Vulkan отдельно, в архив программы она не входит.",
                                   "The processor engine is the normal one. The video card downloads a Vulkan build; it is not inside the app.");
        BrainDeviceBox.Items.Clear();
        BrainDeviceBox.Items.Add(new ComboBoxItem { Content = L.T("Процессор (CPU)", "Processor (CPU)"), Tag = BrainDeviceKind.Cpu });
        BrainDeviceBox.Items.Add(new ComboBoxItem { Content = L.T("Видеокарта (Vulkan)", "Video card (Vulkan)"), Tag = BrainDeviceKind.Gpu });
        foreach (ComboBoxItem it in BrainDeviceBox.Items)
            if ((BrainDeviceKind)it.Tag == _settings.BrainDevice) BrainDeviceBox.SelectedItem = it;
        SelectionBox.Content = L.T("Править выделенный текст голосом", "Edit selected text by voice");
        SelectionBox.IsChecked = _settings.BrainOnSelection;
        SelectionHint.Text = L.T("Выделите текст, зажмите клавишу и скажите, что сделать. Выключите, если хотите диктовать поверх выделения.",
                                 "Select text, hold the key, and say what to do. Turn off to dictate over a selection.");
        EveryTakeLabel.Text = L.T("Переписывать фразу", "Rewrite the phrase");
        EveryTakeBox.Items.Clear();
        EveryTakeBox.Items.Add(new ComboBoxItem { Content = L.T("Выключено", "Off"), Tag = false });
        EveryTakeBox.Items.Add(new ComboBoxItem { Content = L.T("Переписывать каждую фразу", "Rewrite each phrase"), Tag = true });
        EveryTakeBox.SelectedIndex = _settings.BrainEveryTake ? 1 : 0;
        EveryTakeHint.Text = L.T("Включите, и ниже будет, как именно переписывать. Выключено: фраза как распознана, пока не скажете «Чаво, …».",
                                 "Turn on, and the box below is how to rewrite. Off: the phrase is inserted as recognized until you say \"Chawo, …\".");
        UpdateBrainTexts();
        _loading = false;
    }

    private void Hotkey_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || HotkeyBox.SelectedItem is not ComboBoxItem item) return;
        _settings.HotkeyVk = (int)item.Tag;
        _apply();
    }

    private void Insert_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading) return;
        _settings.InsertMode = InsertBox.SelectedIndex == 1 ? InsertMode.Paste : InsertMode.Type;
        _apply();
    }

    private void Language_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || LanguageBox.SelectedItem is not ComboBoxItem item) return;
        _settings.Language = (UiLanguage)item.Tag;
        _apply();
    }

    private void Overlay_Click(object sender, RoutedEventArgs e)
    {
        _settings.ShowOverlay = OverlayBox.IsChecked == true;
        _apply();
    }

    private void CopyClip_Click(object sender, RoutedEventArgs e)
    {
        _settings.CopyPhraseToClipboard = CopyClipBox.IsChecked == true;
        RestoreClipBox.Visibility = _settings.CopyPhraseToClipboard ? Visibility.Visible : Visibility.Collapsed;
        _apply();
    }

    private void RestoreClip_Click(object sender, RoutedEventArgs e)
    {
        _settings.RestoreClipboardAfterCopy = RestoreClipBox.IsChecked == true;
        _apply();
    }

    private void Stop_Click(object sender, RoutedEventArgs e) => _stop?.Invoke();

    /// <summary>Idle / listening / recognizing, and whether Stop should be clickable.</summary>
    public void SetPhase(string text, bool stopEnabled)
    {
        _phaseText = text;
        _stopEnabled = stopEnabled;
        PhaseLine.Text = text;
        StopButton.IsEnabled = stopEnabled;
    }

    private void Autostart_Click(object sender, RoutedEventArgs e) => Autostart.Set(AutostartBox.IsChecked == true);

    private void CheckUpdates_Click(object sender, RoutedEventArgs e) => _checkUpdates?.Invoke();

    /// <summary>The close button hides the window. The process stays in the tray until Quit.</summary>
    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (!ChawoApp.IsQuitting)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnClosing(e);
    }

    private void SpeechDevice_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || DeviceBox.SelectedItem is not ComboBoxItem item) return;
        var device = (SpeechDeviceKind)item.Tag;
        if (device == _settings.SpeechDevice) return;
        _settings.SpeechDevice = device;
        ThreadsPanel.Visibility = device == SpeechDeviceKind.Cpu ? Visibility.Visible : Visibility.Collapsed;
        WarmupPanel.Visibility = device == SpeechDeviceKind.Gpu ? Visibility.Visible : Visibility.Collapsed;
        _apply();
        _speechChanged?.Invoke();
    }

    private async void Warmup_Click(object sender, RoutedEventArgs e)
    {
        if (_toggleGpuWarmup == null || _warmupBusy) return;
        _warmupBusy = true;
        WarmupButton.IsEnabled = false;
        try { await _toggleGpuWarmup(); }
        finally
        {
            _warmupBusy = false;
            Localize();
        }
    }

    private void CpuThreads_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || ThreadsBox.SelectedItem is not ComboBoxItem item) return;
        int n = (int)item.Tag;
        if (n == _settings.CpuThreads) return;
        _settings.CpuThreads = n;
        _apply();
        _speechChanged?.Invoke();
    }

    private void Role_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || RoleBox.SelectedItem is not ComboBoxItem item) return;
        var role = (NetworkRole)item.Tag;
        if (role == _settings.NetworkRole) return;
        _settings.NetworkRole = role;
        _apply();
        _networkChanged?.Invoke();
        Localize();
    }

    private void Remote_LostFocus(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var host = RemoteHostBox.Text.Trim();
        if (!int.TryParse(RemotePortBox.Text.Trim(), out int port) || port is < 1 or > 65535)
            port = SpeechModels.HermesPort;
        RemotePortBox.Text = port.ToString();
        if (host == _settings.RemoteHost && port == _settings.RemotePort) return;
        _settings.RemoteHost = host;
        _settings.RemotePort = port;
        _apply();
    }

    public void SetFileStatus(string text, bool running)
    {
        _fileLine = text;
        _fileRunning = running;
        if (!IsLoaded) return;
        FileStatus.Text = text;
        FilePickButton.IsEnabled = !running;
        FileFolderButton.IsEnabled = !running;
        FileRunButton.IsEnabled = !running;
        FileFfmpegButton.IsEnabled = !running && _downloadFfmpeg != null;
        FilePathBox.IsEnabled = !running;
        FileSpeedBox.IsEnabled = !running;
        FileStopButton.Visibility = running ? Visibility.Visible : Visibility.Collapsed;
        if (!running) FileFfmpegStatus.Text = _ffmpegStatus?.Invoke() ?? FfmpegTool.StatusLine();
    }

    private void FillFileSpeedBox()
    {
        var keep = _settings.FileParallelism;
        FileSpeedBox.Items.Clear();
        FileSpeedBox.Items.Add(new ComboBoxItem { Content = L.T("Авто", "Auto"), Tag = FileParallelismKind.Auto });
        FileSpeedBox.Items.Add(new ComboBoxItem { Content = L.T("Бережно — 1 поток", "Gentle — 1 thread"), Tag = FileParallelismKind.Gentle1 });
        FileSpeedBox.Items.Add(new ComboBoxItem { Content = L.T("2 потока", "2 threads"), Tag = FileParallelismKind.Two });
        FileSpeedBox.Items.Add(new ComboBoxItem { Content = L.T("4 потока", "4 threads"), Tag = FileParallelismKind.Four });
        FileSpeedBox.Items.Add(new ComboBoxItem { Content = L.T("Максимум", "Maximum"), Tag = FileParallelismKind.Max });
        foreach (ComboBoxItem it in FileSpeedBox.Items)
            if ((FileParallelismKind)it.Tag! == keep) FileSpeedBox.SelectedItem = it;
        if (FileSpeedBox.SelectedItem == null) FileSpeedBox.SelectedIndex = 0;
    }

    private void FileSpeed_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || FileSpeedBox.SelectedItem is not ComboBoxItem it || it.Tag is not FileParallelismKind kind)
            return;
        if (_settings.FileParallelism == kind) return;
        _settings.FileParallelism = kind;
        _apply();
    }

    private void FilePick_Click(object sender, RoutedEventArgs e)
    {
        if (_fileRunning) return;
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Title = L.T("Обзор", "Browse"),
            Filter = FileTranscript.OpenFilter,
            CheckFileExists = true,
            Multiselect = true,
        };
        if (dlg.ShowDialog(this) != true || dlg.FileNames.Length == 0) return;
        FilePathBox.Text = dlg.FileNames.Length == 1
            ? dlg.FileName
            : string.Join(";", dlg.FileNames);
    }

    private void FileFolder_Click(object sender, RoutedEventArgs e)
    {
        if (_fileRunning) return;
        var dlg = new Microsoft.Win32.OpenFolderDialog
        {
            Title = L.T("Папка с записями", "Folder with recordings"),
        };
        if (dlg.ShowDialog(this) != true || string.IsNullOrWhiteSpace(dlg.FolderName)) return;
        FilePathBox.Text = dlg.FolderName;
    }

    private void FileRun_Click(object sender, RoutedEventArgs e)
    {
        if (_fileRunning || _transcribeFiles == null) return;
        var raw = (FilePathBox.Text ?? "").Trim().Trim('"');
        if (raw.Length == 0)
        {
            FileStatus.Text = L.T("Укажите путь к файлу, несколько файлов через «;», или папку.",
                                  "Enter a file path, several files separated by ';', or a folder.");
            return;
        }
        var list = new List<string>();
        if (Directory.Exists(raw))
        {
            list.AddRange(FileTranscript.CollectFromFolder(raw));
            if (list.Count == 0)
            {
                FileStatus.Text = L.T("В папке нет поддерживаемых аудиофайлов.",
                                      "No supported audio files in that folder.");
                return;
            }
        }
        else
        {
            foreach (var part in raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var p = part.Trim().Trim('"');
                if (p.Length == 0) continue;
                if (Directory.Exists(p)) list.AddRange(FileTranscript.CollectFromFolder(p));
                else list.Add(p);
            }
        }
        if (list.Count == 0)
        {
            FileStatus.Text = L.T("Укажите путь к файлу или нажмите «Обзор».",
                                  "Enter a file path or press Browse.");
            return;
        }
        _ = _transcribeFiles(list);
    }

    private void FileFfmpeg_Click(object sender, RoutedEventArgs e)
    {
        if (_fileRunning || _downloadFfmpeg == null) return;
        _ = _downloadFfmpeg();
    }

    private void FileStop_Click(object sender, RoutedEventArgs e) => _cancelFile?.Invoke();

    private async void CheckHost_Click(object sender, RoutedEventArgs e)
    {
        Remote_LostFocus(sender, e);
        CheckHostButton.IsEnabled = false;
        HostCheckStatus.Text = L.T("Проверяю хост…", "Checking the host…");
        try
        {
            var line = await Task.Run(() => RemoteSpeech.Check(_settings));
            HostCheckStatus.Text = line;
        }
        finally { CheckHostButton.IsEnabled = true; }
    }

    private async void Lan_Click(object sender, RoutedEventArgs e)
    {
        if (_toggleLan == null) return;
        LanButton.IsEnabled = false;
        try { await _toggleLan(); }
        finally
        {
            LanButton.IsEnabled = true;
            Localize();
        }
    }

    private void Unpin_Click(object sender, RoutedEventArgs e)
    {
        _unpin();
        UnpinButton.IsEnabled = false;
    }

    /// <summary>Shows only what the chosen Brain needs: the server fields, the delete button, the every-take option.</summary>
    private void UpdateBrainTexts()
    {
        var b = _settings.Brain;
        BrainStatus.Text = b switch
        {
            BrainSource.Local => L.T("Работает без интернета и без ключей. Медленнее облака: фраза правится за несколько секунд, на обычном ноутбуке дольше. Пока нужен, занимает около 2,5 ГБ памяти, через 15 минут без дела выгружается.",
                                     "Works offline, no keys. Slower than the cloud: a phrase takes a few seconds, longer on an ordinary laptop. Takes about 2.5 GB of memory while needed, unloads after 15 idle minutes."),
            BrainSource.Off => L.T("Текст вставляется как распознан.", "Text is inserted as recognized."),
            _ => "",
        };
        BrainStatus.Visibility = BrainStatus.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        ServerPanel.Visibility = b == BrainSource.Server ? Visibility.Visible : Visibility.Collapsed;
        bool local = b == BrainSource.Local;
        var localVis = local ? Visibility.Visible : Visibility.Collapsed;
        BrainModelLabel.Visibility = localVis;
        BrainModelRows.Visibility = localVis;
        BrainFileStatus.Visibility = localVis;
        BrainDeviceLabel.Visibility = localVis;
        BrainDeviceBox.Visibility = localVis;
        BrainDeviceHint.Visibility = localVis;
        bool custom = local && _settings.BrainModel == LocalBrainKind.Custom;
        var urlVis = custom ? Visibility.Visible : Visibility.Collapsed;
        BrainUrlLabel.Visibility = urlVis;
        BrainUrlBox.Visibility = urlVis;
        var rewrite = b != BrainSource.Off && _settings.BrainEveryTake ? Visibility.Visible : Visibility.Collapsed;
        InstructionLabel.Visibility = rewrite;
        InstructionBox.Visibility = rewrite;
        InstructionHint.Visibility = rewrite;
        var select = b == BrainSource.Off ? Visibility.Collapsed : Visibility.Visible;
        SelectionBox.Visibility = select;
        SelectionHint.Visibility = select;
        bool readyLocal = LocalBrain.IsReady(_settings);
        string fileStatus;
        if (!local)
            fileStatus = "";
        else if (_settings.BrainModel == LocalBrainKind.Custom && !LocalBrain.TryParseCustomUrl(_settings.BrainCustomUrl, out _, out _, out var urlError))
            fileStatus = urlError;
        else if (readyLocal)
            fileStatus = L.T("Уже на диске: ", "Already on disk: ") + LocalBrain.ModelPath(_settings)
                + (LocalBrain.DeviceNote == null ? "" : " " + LocalBrain.DeviceNote);
        else
            fileStatus = L.T("Файла ещё нет. Нажмите кнопку, сама модель не скачивается.", "Not on disk yet. Press the button. It does not download by itself.");
        BrainFileStatus.Text = fileStatus;
        var every = b == BrainSource.Off ? Visibility.Collapsed : Visibility.Visible;
        EveryTakeLabel.Visibility = every;
        EveryTakeBox.Visibility = every;
        EveryTakeHint.Visibility = every;
    }

    private async void Brain_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || BrainBox.SelectedItem is not ComboBoxItem item) return;
        var source = (BrainSource)item.Tag;
        if (source == _settings.Brain) return;
        await _selectBrain(source);
        Localize();   // the choice may have been cancelled (download declined)
        if (source == BrainSource.Server) ServerPanel.FocusKey();
    }

    private void Selection_Click(object sender, RoutedEventArgs e)
    {
        _settings.BrainOnSelection = SelectionBox.IsChecked == true;
        _apply();
    }

    private void EveryTake_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || EveryTakeBox.SelectedItem is not ComboBoxItem item) return;
        bool on = item.Tag is bool b && b;
        if (on == _settings.BrainEveryTake) return;
        _settings.BrainEveryTake = on;
        _apply();
        UpdateBrainTexts();
    }

    private void BrainDevice_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || BrainDeviceBox.SelectedItem is not ComboBoxItem item) return;
        var device = (BrainDeviceKind)item.Tag;
        if (device == _settings.BrainDevice) return;
        _settings.BrainDevice = device;
        LocalBrain.Stop();
        _apply();
        UpdateBrainTexts();
    }

    private void Mic_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || MicBox.SelectedItem is not ComboBoxItem item) return;
        var id = (string)item.Tag;
        if (id == _settings.MicrophoneId) return;
        _settings.MicrophoneId = id;
        _apply();
    }

    private void Mode_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || ModeBox.SelectedItem is not ComboBoxItem item) return;
        var mode = (AppMode)item.Tag;
        if (mode == _settings.Mode) return;
        _settings.Mode = mode;
        _apply();
        ModeHint.Text = mode == AppMode.Sales
            ? L.T("Карточка из каталога и, если кода нет, фрагмент из папки материалов. Сеть и модель для неё не нужны. Диктовка вставляет текст как раньше.",
                  "The card comes from the catalog and, when the code is missing, a snippet from the materials folder. It needs no network and no model. Dictation still inserts text as before.")
            : L.T("Обычная диктовка. Карточка продаж не показывается.",
                  "Ordinary dictation. The sales card stays hidden.");
    }

    private readonly List<(TextBox Code, TextBox Name, TextBox Line, TextBox Similar)> _salesRows = new();

    private void FillSalesRows()
    {
        SalesRows.Children.Clear();
        _salesRows.Clear();
        foreach (var item in _settings.SalesCatalog)
            AddSalesRow(item.Code, item.Name, item.Line, item.SimilarCode, focus: false);
    }

    private void AddSalesRow(string code, string name, string line, string similar, bool focus)
    {
        var grid = new Grid { Margin = new Thickness(0, 4, 0, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(90) });
        TextBox Box(string text, int col)
        {
            var box = new TextBox
            {
                Text = text,
                Padding = new Thickness(7, 5, 7, 5),
                Margin = new Thickness(0, 0, 8, 0),
                VerticalContentAlignment = VerticalAlignment.Center,
            };
            Grid.SetColumn(box, col);
            box.TextChanged += SalesField_Changed;
            grid.Children.Add(box);
            return box;
        }
        var codeBox = Box(code, 0);
        var nameBox = Box(name, 1);
        var lineBox = Box(line, 2);
        var similarBox = Box(similar, 3);
        var delete = new Button
        {
            Content = L.T("Удалить", "Delete"),
            Padding = new Thickness(8, 4, 8, 4),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(delete, 4);
        delete.Click += DeleteSales_Click;
        grid.Children.Add(delete);
        SalesRows.Children.Add(grid);
        _salesRows.Add((codeBox, nameBox, lineBox, similarBox));
        if (focus) codeBox.Focus();
    }

    private void AddSales_Click(object sender, RoutedEventArgs e) => AddSalesRow("", "", "", "", focus: true);

    private void ShowCall_Click(object sender, RoutedEventArgs e)
    {
        if (_showCall == null)
        {
            CallStatus.Text = L.T("Карточка из этого окна недоступна.", "The card cannot be opened from this window.");
            return;
        }
        CallStatus.Text = _showCall(CallExtensionBox.Text, CallNumberBox.Text, CallManagerBox.Text);
    }

    private void DeleteSales_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Parent is not Grid grid) return;
        int at = SalesRows.Children.IndexOf(grid);
        if (at < 0 || at >= _salesRows.Count) return;
        SalesRows.Children.RemoveAt(at);
        _salesRows.RemoveAt(at);
        PersistSales();
    }

    private void SalesField_Changed(object sender, TextChangedEventArgs e)
    {
        if (_loading) return;
        PersistSales();
    }

    private void PersistSales()
    {
        var rows = _salesRows
            .Select(r => new SalesCatalogItem
            {
                Code = r.Code.Text.Trim(),
                Name = r.Name.Text.Trim(),
                Line = r.Line.Text.Trim(),
                SimilarCode = r.Similar.Text.Trim(),
            })
            .Where(r => r.Code.Length > 0 || r.Name.Length > 0 || r.Line.Length > 0 || r.SimilarCode.Length > 0)
            .ToList();
        if (SameCatalog(rows, _settings.SalesCatalog)) return;
        _settings.SalesCatalog = rows;
        _apply();
    }

    private static bool SameCatalog(List<SalesCatalogItem> a, List<SalesCatalogItem> b)
    {
        if (a.Count != b.Count) return false;
        for (int i = 0; i < a.Count; i++)
        {
            if (a[i].Code != b[i].Code || a[i].Name != b[i].Name || a[i].Line != b[i].Line || a[i].SimilarCode != b[i].SimilarCode)
                return false;
        }
        return true;
    }

    private readonly List<(TextBox Heard, TextBox Written)> _dictRows = new();

    private void FillDictionaryRows()
    {
        DictionaryRows.Children.Clear();
        _dictRows.Clear();
        foreach (var pair in _settings.DictionaryRows)
            AddDictionaryRow(pair.From, pair.To, focus: false);
    }

    private void AddDictionaryRow(string from, string to, bool focus)
    {
        var grid = new Grid { Margin = new Thickness(0, 4, 0, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) });
        var heard = new TextBox { Text = from, Padding = new Thickness(7, 5, 7, 5), Margin = new Thickness(0, 0, 8, 0), VerticalContentAlignment = VerticalAlignment.Center };
        var written = new TextBox { Text = to, Padding = new Thickness(7, 5, 7, 5), Margin = new Thickness(0, 0, 8, 0), VerticalContentAlignment = VerticalAlignment.Center };
        Grid.SetColumn(written, 1);
        var delete = new Button
        {
            Content = L.T("Удалить", "Delete"),
            Padding = new Thickness(10, 4, 10, 4),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(delete, 2);
        delete.Click += DeleteDictionary_Click;
        heard.TextChanged += DictionaryField_Changed;
        written.TextChanged += DictionaryField_Changed;
        grid.Children.Add(heard);
        grid.Children.Add(written);
        grid.Children.Add(delete);
        DictionaryRows.Children.Add(grid);
        _dictRows.Add((heard, written));
        if (focus) heard.Focus();
    }

    private void AddDictionary_Click(object sender, RoutedEventArgs e) => AddDictionaryRow("", "", focus: true);

    private void DeleteDictionary_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Parent is not Grid grid) return;
        int at = DictionaryRows.Children.IndexOf(grid);
        if (at < 0 || at >= _dictRows.Count) return;
        DictionaryRows.Children.RemoveAt(at);
        _dictRows.RemoveAt(at);
        PersistDictionary();
    }

    private void DictionaryField_Changed(object sender, TextChangedEventArgs e)
    {
        if (_loading) return;
        PersistDictionary();
    }

    private void PersistDictionary()
    {
        var rows = _dictRows
            .Select(r => new WordReplace.Pair(r.Heard.Text.Trim(), r.Written.Text.Trim()))
            .Where(r => r.From.Length > 0 || r.To.Length > 0)
            .ToArray();
        var next = rows.Length == 0 ? "#" : WordReplace.Format(rows);
        var current = string.IsNullOrWhiteSpace(_settings.WordReplacementRules)
            ? WordReplace.DefaultRules
            : _settings.WordReplacementRules;
        if (next.Trim() == current.Trim()) return;
        _settings.SaveDictionary(rows);
        _apply();
    }

    private void RefreshRagFolderUi()
    {
        string folder = (_settings.RagFolder ?? "").Trim();
        RagFolderBox.Text = folder.Length == 0
            ? L.T("Папка не выбрана", "No folder chosen")
            : folder;
        RagClearButton.IsEnabled = folder.Length > 0;
        if (folder.Length == 0)
            RagStatus.Text = L.T("Без папки карточка показывает только каталог.", "Without a folder the card shows only the catalog.");
        else if (!System.IO.Directory.Exists(folder))
            RagStatus.Text = L.T("Папка не найдена на диске.", "The folder is not on disk.");
        else
        {
            int n = 0;
            try
            {
                n = System.IO.Directory.EnumerateFiles(folder, "*.*", System.IO.SearchOption.AllDirectories)
                    .Count(p =>
                    {
                        string ext = System.IO.Path.GetExtension(p).ToLowerInvariant();
                        return ext is ".txt" or ".md" or ".markdown";
                    });
            }
            catch { /* status only */ }
            RagStatus.Text = L.T($"Файлов .txt/.md: {n}.", $".txt/.md files: {n}.");
        }
    }

    private void RagPick_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new Microsoft.Win32.OpenFolderDialog
        {
            Title = L.T("Папка материалов для продаж", "Sales materials folder"),
        };
        string current = (_settings.RagFolder ?? "").Trim();
        if (current.Length > 0 && System.IO.Directory.Exists(current))
            dlg.InitialDirectory = current;
        if (dlg.ShowDialog(this) != true) return;
        string path = (dlg.FolderName ?? "").Trim();
        if (path.Length == 0 || path == _settings.RagFolder) return;
        _settings.RagFolder = path;
        _apply();
        RefreshRagFolderUi();
        FillSuggestDictionaryRows(clear: true);
    }

    private void RagClear_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_settings.RagFolder)) return;
        _settings.RagFolder = "";
        _apply();
        RefreshRagFolderUi();
        FillSuggestDictionaryRows(clear: true);
    }

    private void SuggestDictionary_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_settings.RagFolder) || !System.IO.Directory.Exists(_settings.RagFolder))
        {
            SuggestDictionaryHint.Text = L.T("Сначала выберите папку материалов на вкладке «Продажи».",
                                             "Choose a materials folder on the Sales tab first.");
            FillSuggestDictionaryRows(clear: true);
            return;
        }
        var suggestions = SalesRag.SuggestDictionary(_settings.RagFolder, _settings.DictionaryRows);
        FillSuggestDictionaryRows(clear: false, suggestions);
        SuggestDictionaryHint.Text = suggestions.Count == 0
            ? L.T("В материалах не нашлось пар «русское рядом с латинским брендом».",
                  "No Russian-next-to-Latin-brand pairs were found in the materials.")
            : L.T($"Предложено {suggestions.Count}. Нажмите «В словарь», чтобы добавить строку. Само ничего не пишется.",
                  $"Suggested {suggestions.Count}. Press Add to dictionary to insert a row. Nothing is written by itself.");
    }

    private void FillSuggestDictionaryRows(bool clear, IReadOnlyList<DictSuggestion>? suggestions = null)
    {
        SuggestDictionaryRows.Children.Clear();
        if (clear || suggestions == null || suggestions.Count == 0) return;
        foreach (var s in suggestions)
        {
            var grid = new Grid { Margin = new Thickness(0, 4, 0, 0) };
            grid.ColumnDefinitions.Add(new ColumnDefinition());
            grid.ColumnDefinitions.Add(new ColumnDefinition());
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(120) });
            var heard = new TextBlock
            {
                Text = s.Heard,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 8, 0),
                TextWrapping = TextWrapping.Wrap,
            };
            var written = new TextBlock
            {
                Text = s.Written + (s.Source.Length > 0 ? $"  ({s.Source})" : ""),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 8, 0),
                Opacity = 0.85,
                TextWrapping = TextWrapping.Wrap,
            };
            Grid.SetColumn(written, 1);
            var add = new Button
            {
                Content = L.T("В словарь", "Add"),
                Padding = new Thickness(10, 4, 10, 4),
                Tag = s,
                VerticalAlignment = VerticalAlignment.Center,
            };
            Grid.SetColumn(add, 2);
            add.Click += AddSuggestion_Click;
            grid.Children.Add(heard);
            grid.Children.Add(written);
            grid.Children.Add(add);
            SuggestDictionaryRows.Children.Add(grid);
        }
    }

    private void AddSuggestion_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Tag is not DictSuggestion s) return;
        // Do not auto-write elsewhere: only when the user clicks.
        AddDictionaryRow(s.Heard, s.Written, focus: false);
        PersistDictionary();
        if (button.Parent is Grid grid)
            SuggestDictionaryRows.Children.Remove(grid);
    }

    private void FillSpeechModelRows()
    {
        SpeechModelRows.Children.Clear();
        foreach (var kind in new[] { SpeechModelKind.V3E2eRnnt, SpeechModelKind.MultilingualLargeCtc })
        {
            bool onDisk = SpeechModelStore.FindComplete(kind) != null;
            bool canDelete = SpeechModelStore.HasDeletable(kind);
            var row = new DockPanel { Margin = new Thickness(0, 6, 0, 0), LastChildFill = true };
            var buttons = new StackPanel { Orientation = Orientation.Horizontal };
            DockPanel.SetDock(buttons, Dock.Right);
            var download = new Button
            {
                Content = onDisk ? L.T("На диске", "On disk") : L.T("Скачать", "Download"),
                Tag = kind,
                Padding = new Thickness(12, 4, 12, 4),
                Margin = new Thickness(8, 0, 0, 0),
                IsEnabled = !onDisk,
            };
            download.IsEnabled = download.IsEnabled && _settings.NetworkRole != NetworkRole.Client;
            if (_settings.NetworkRole == NetworkRole.Client)
                download.ToolTip = L.T("Клиент не скачивает модель.", "A client does not download a model.");
            download.Click += DownloadSpeechRow_Click;
            buttons.Children.Add(download);
            var delete = new Button
            {
                Content = L.T("Удалить", "Delete"),
                Tag = kind,
                Padding = new Thickness(12, 4, 12, 4),
                Margin = new Thickness(8, 0, 0, 0),
                Visibility = canDelete ? Visibility.Visible : Visibility.Collapsed,
                ToolTip = SpeechModelStore.DeleteButtonLabel(kind),
            };
            delete.Click += DeleteSpeech_Click;
            buttons.Children.Add(delete);
            var radio = new RadioButton
            {
                Content = kind == SpeechModelKind.V3E2eRnnt
                    ? L.T("Русская v3: запятые и заглавные, около 220 МБ", "Russian v3: commas and capitals, about 220 MB")
                    : L.T("Большая: русский и английский без знаков, около 2,4 ГБ", "Large: Russian and English, no punctuation, about 2.4 GB"),
                Tag = kind,
                GroupName = "SpeechModel",
                IsChecked = _settings.SpeechModel == kind,
                VerticalAlignment = VerticalAlignment.Center,
            };
            radio.Checked += SpeechRadio_Checked;
            row.Children.Add(buttons);
            row.Children.Add(radio);
            SpeechModelRows.Children.Add(row);
        }
    }

    private void SpeechRadio_Checked(object sender, RoutedEventArgs e)
    {
        if (_loading || sender is not RadioButton radio || radio.IsChecked != true || radio.Tag is not SpeechModelKind kind) return;
        if (kind == _settings.SpeechModel) return;
        _settings.SpeechModel = kind;
        _apply();
        _speechChanged?.Invoke();
    }

    private async void DownloadSpeechRow_Click(object sender, RoutedEventArgs e)
    {
        if (_downloadSpeech == null || sender is not Button button || button.Tag is not SpeechModelKind kind) return;
        if (kind != _settings.SpeechModel)
        {
            _settings.SpeechModel = kind;
            _apply();
        }
        button.IsEnabled = false;
        try { await _downloadSpeech(); }
        finally { Localize(); }
    }

    private async void DeleteSpeech_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Tag is not SpeechModelKind kind) return;
        var paths = string.Join("\n", SpeechModelStore.DeletableTargets(kind));
        var yes = System.Windows.MessageBox.Show(
            L.T($"Удалить эту модель с диска?\n\n{SpeechModelStore.DeleteButtonLabel(kind)}\n\n{paths}\n\nСама программа не удаляется.",
                $"Delete this model from disk?\n\n{paths}\n\nThe program itself stays."),
            L.T("Удалить модель", "Delete model"),
            MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (yes != MessageBoxResult.Yes) return;
        button.IsEnabled = false;
        try
        {
            if (_deleteSpeech != null) await _deleteSpeech(kind);
            else SpeechModelStore.DeleteInstalled(kind);
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(ex.Message, L.T("Удалить модель", "Delete model"), MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        Localize();
    }

    private void FillBrainModelRows()
    {
        BrainModelRows.Children.Clear();
        var files = LocalBrain.InstalledGgufs();
        var claimed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kind in new[] { LocalBrainKind.Qwen3, LocalBrainKind.Qwen35, LocalBrainKind.Custom })
        {
            string? path = BrainFileFor(kind, files);
            if (path != null) claimed.Add(path);
            bool ready = path != null && kind == _settings.BrainModel ? LocalBrain.IsReady(_settings) : path != null && kind != LocalBrainKind.Custom;
            if (kind == LocalBrainKind.Custom)
                ready = path != null;
            AddBrainRow(LocalBrain.ChoiceLabel(kind), kind, path, ready);
        }
        foreach (var file in files)
        {
            if (claimed.Contains(file.Path)) continue;
            AddBrainRow(file.Label, null, file.Path, true);
        }
    }

    private string? BrainFileFor(LocalBrainKind kind, IReadOnlyList<LocalBrain.InstalledGguf> files)
    {
        foreach (var file in files)
        {
            var name = Path.GetFileName(file.Path);
            if (kind == LocalBrainKind.Qwen3 && name.Equals(LocalBrain.ModelFile, StringComparison.OrdinalIgnoreCase)) return file.Path;
            if (kind == LocalBrainKind.Qwen35 && name.Equals(LocalBrain.Qwen35File, StringComparison.OrdinalIgnoreCase)) return file.Path;
            if (kind == LocalBrainKind.Custom && LocalBrain.TryParseCustomUrl(_settings.BrainCustomUrl, out _, out var leaf, out _)
                && name.Equals(leaf, StringComparison.OrdinalIgnoreCase)
                && !name.Equals(LocalBrain.ModelFile, StringComparison.OrdinalIgnoreCase)
                && !name.Equals(LocalBrain.Qwen35File, StringComparison.OrdinalIgnoreCase))
                return file.Path;
        }
        if (kind == LocalBrainKind.Custom && LocalBrain.TryParseCustomUrl(_settings.BrainCustomUrl, out _, out var custom, out _))
        {
            foreach (var file in files)
                if (Path.GetFileName(file.Path).Equals(custom, StringComparison.OrdinalIgnoreCase)) return file.Path;
        }
        return null;
    }

    private void AddBrainRow(string label, LocalBrainKind? kind, string? path, bool onDisk)
    {
        var row = new DockPanel { Margin = new Thickness(0, 6, 0, 0), LastChildFill = true };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal };
        DockPanel.SetDock(buttons, Dock.Right);
        if (kind != null)
        {
            var download = new Button
            {
                Content = onDisk ? L.T("На диске", "On disk") : L.T("Скачать", "Download"),
                Tag = kind,
                Padding = new Thickness(12, 4, 12, 4),
                Margin = new Thickness(8, 0, 0, 0),
                IsEnabled = !onDisk,
            };
            download.Click += BrainRowDownload_Click;
            buttons.Children.Add(download);
        }
        if (path != null)
        {
            var delete = new Button
            {
                Content = L.T("Удалить", "Delete"),
                Tag = path,
                Padding = new Thickness(12, 4, 12, 4),
                Margin = new Thickness(8, 0, 0, 0),
            };
            delete.Click += DeleteGguf_Click;
            buttons.Children.Add(delete);
        }
        row.Children.Add(buttons);
        if (kind == null)
        {
            row.Children.Add(new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap });
        }
        else
        {
            var radio = new RadioButton
            {
                Content = label,
                Tag = kind,
                GroupName = "BrainModel",
                IsChecked = _settings.BrainModel == kind,
                VerticalAlignment = VerticalAlignment.Center,
            };
            radio.Checked += BrainRadio_Checked;
            row.Children.Add(radio);
        }
        BrainModelRows.Children.Add(row);
    }

    private void BrainRadio_Checked(object sender, RoutedEventArgs e)
    {
        if (_loading || sender is not RadioButton radio || radio.IsChecked != true || radio.Tag is not LocalBrainKind kind) return;
        if (kind == _settings.BrainModel) return;
        _settings.BrainModel = kind;
        LocalBrain.Stop();
        _apply();
        UpdateBrainTexts();
    }

    private async void BrainRowDownload_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Tag is not LocalBrainKind kind) return;
        if (kind != _settings.BrainModel)
        {
            _settings.BrainModel = kind;
            LocalBrain.Stop();
            _apply();
        }
        button.IsEnabled = false;
        try { await DownloadBrainAsync(); }
        finally { Localize(); }
    }

    private void DeleteGguf_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Tag is not string path) return;
        var name = Path.GetFileName(path);
        var yes = System.Windows.MessageBox.Show(
            L.T($"Удалить модель мозга «{name}»?\n\n{path}\n\nПрограмма и движок llama.cpp не удаляются.",
                $"Delete the brain model \"{name}\"?\n\n{path}\n\nThe program and the llama.cpp engine stay."),
            L.T("Удалить модель", "Delete model"),
            MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (yes != MessageBoxResult.Yes) return;
        try { LocalBrain.DeleteGguf(path); }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(ex.Message, L.T("Удалить модель", "Delete model"), MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        Localize();
    }

    private void BrainUrl_LostFocus(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var text = BrainUrlBox.Text.Trim();
        if (text == _settings.BrainCustomUrl) return;
        _settings.BrainCustomUrl = text;
        if (_settings.BrainModel == LocalBrainKind.Custom) LocalBrain.Stop();
        _apply();
        UpdateBrainTexts();
    }

    private void Instruction_LostFocus(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var text = InstructionBox.Text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
        if (text == _settings.BrainInstruction.Trim()) return;
        _settings.BrainInstruction = text;
        _apply();
    }

    private async void BrainDownload_Click(object sender, RoutedEventArgs e) => await DownloadBrainAsync();

    private async Task DownloadBrainAsync()
    {
        SaveBrainUrl();
        if (_settings.BrainModel == LocalBrainKind.Custom &&
            !LocalBrain.TryParseCustomUrl(_settings.BrainCustomUrl, out _, out _, out var error))
        {
            System.Windows.MessageBox.Show(error, L.T("Мозг", "Brain"), MessageBoxButton.OK, MessageBoxImage.Information);
            UpdateBrainTexts();
            return;
        }
        if (LocalBrain.IsReady(_settings))
        {
            System.Windows.MessageBox.Show(
                L.T($"Эта модель уже на диске.\n\n{LocalBrain.ModelPath(_settings)}",
                    $"This model is already on disk.\n\n{LocalBrain.ModelPath(_settings)}"),
                L.T("Мозг", "Brain"), MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var gb = LocalBrain.Gb(LocalBrain.MemoryNeeded(_settings));
        var window = new DownloadWindow(
            L.T("Скачиваю Мозг", "Downloading the Brain"),
            L.T($"Нейросеть {LocalBrain.Title(_settings)} и движок llama.cpp. Если связь оборвётся, скачивание продолжится с того же места. Файл не запускается как программа.",
                $"The {LocalBrain.Title(_settings)} model and the llama.cpp engine. If the connection drops, the download resumes. The file is not run as a program."),
            (progress, ct) => LocalBrain.DownloadAsync(_settings, progress, ct),
            gb + L.T(" ГБ", " GB"));
        await window.RunAsync();
    }

    private void SaveBrainUrl()
    {
        var text = BrainUrlBox.Text.Trim();
        if (text == _settings.BrainCustomUrl) return;
        _settings.BrainCustomUrl = text;
        _apply();
    }

}
