// Settings window, laid out like Windows 11 Settings: sections on the left
// (Dictation, Brain, About), the chosen section on the right. Every change is
// applied and saved immediately, the server Brain included.

using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Navigation;
using GigaPisar.Core;

namespace GigaPisar.App;

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
    private readonly Action? _keepAwakeChanged;
    private readonly Action? _checkUpdates;
    private readonly Action? _stop;
    private string _phaseText = "";
    private bool _stopEnabled;
    private bool _loading = true;
    /// <summary>Last open section, kept while Pisar runs.</summary>
    private static int _lastPage;

    public enum Page { Dictation, Brain, Edit, About }

    public SettingsWindow(Settings settings, Action apply, Action unpin, Func<BrainSource, Task> selectBrain,
        Func<Task>? downloadSpeech = null, Action? speechChanged = null, Func<string>? speechStatus = null,
        Func<string>? hermesStatus = null, Func<Task>? toggleLan = null, Action? keepAwakeChanged = null,
        Action? checkUpdates = null, Action? stop = null)
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
        _keepAwakeChanged = keepAwakeChanged;
        _checkUpdates = checkUpdates;
        _stop = stop;
        InitializeComponent();
        ServerPanel.Saved += UpdateBrainTexts;   // the panel has already applied and saved
        Localize();
        Nav.SelectedIndex = _lastPage;
    }

    public void ShowPage(Page page) => Nav.SelectedIndex = (int)page;

    private void Nav_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (Nav.SelectedIndex < 0) { Nav.SelectedIndex = _lastPage; return; }
        _lastPage = Nav.SelectedIndex;
        DictationPage.Visibility = _lastPage == 0 ? Visibility.Visible : Visibility.Collapsed;
        BrainPage.Visibility = _lastPage == 1 ? Visibility.Visible : Visibility.Collapsed;
        EditPage.Visibility = _lastPage == 2 ? Visibility.Visible : Visibility.Collapsed;
        AboutPage.Visibility = _lastPage == 3 ? Visibility.Visible : Visibility.Collapsed;
        if (_lastPage == 1 && _settings.Brain == BrainSource.Server) ServerPanel.FocusKey();
    }

    /// <summary>Fills every text in the current UI language; called again when the language changes.</summary>
    public void Localize()
    {
        _loading = true;
        Title = L.T($"Гига Писарь {PisarApp.Version}", $"Giga Pisar {PisarApp.Version}");
        NavDictation.Text = L.T("Диктовка", "Dictation");
        NavBrain.Text = L.T("Мозг", "Brain");
        NavEdit.Text = L.T("Правка выделенного", "Edit selection");
        NavAbout.Text = L.T("О программе", "About");
        Heading.Text = L.T("Диктовка", "Dictation");
        Intro.Text = L.T("Курсор в любой текст, зажмите клавишу и говорите. Отпустите, и текст появится сам.",
                         "Cursor in any text, hold the key and speak. Release and the text appears by itself.");
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

        OverlayBox.Content = L.T("Показывать плашку: волна и черновик текста", "Show the pill: wave and the draft text");
        StopButton.Content = L.T("Стоп", "Stop");
        StopButton.IsEnabled = _stopEnabled;
        StopButton.ToolTip = L.T("Остановить запись или распознавание. То же делает Escape. Готовая фраза при этом не вставляется.",
                                 "Stop recording or recognition. Escape does the same. The phrase is not inserted.");
        if (_phaseText.Length > 0) PhaseLine.Text = _phaseText;
        else PhaseLine.Text = L.T("Сейчас: …", "Now: …");
        CopyClipBox.Content = L.T("Копировать готовую фразу в буфер", "Copy the finished phrase to the clipboard");
        CopyClipBox.IsChecked = _settings.CopyPhraseToClipboard;
        CopyClipBox.ToolTip = L.T("Окончательный текст, тот же что вставляется, ещё и кладётся в буфер. Если поле не поймало вставку, его можно вставить через Ctrl+V или найти в Win+V.",
                                  "The final text, the same one that is inserted, is also copied. If the field missed it, paste with Ctrl+V or find it in Win+V.");
        RestoreClipBox.Content = L.T("После копирования вернуть прежний буфер, фразу оставить в Win+V",
                                     "After copying, restore the previous clipboard and keep the phrase in Win+V");
        RestoreClipBox.IsChecked = _settings.RestoreClipboardAfterCopy;
        RestoreClipBox.IsEnabled = _settings.CopyPhraseToClipboard;
        RestoreClipBox.ToolTip = L.T("Сначала фраза становится текущим буфером, поэтому история Win+V её запоминает, если история включена. Потом возвращается то, что лежало раньше. Если история выключена или фраза из неё пропадёт, прежний буфер не возвращается: фраза остаётся текущей, чтобы не потеряться.",
                                     "The phrase is put on the clipboard first, so Win+V records it when history is on. Then the previous clipboard comes back. If history is off, or the phrase would leave history, the previous clipboard is not restored and the phrase stays current.");
        SimpleSyntaxBox.Content = L.T("Упрощать синтаксис: одно предложение без заглавной буквы и точки",
                                      "Simplify punctuation: a single sentence without a capital and a period");
        SimpleSyntaxBox.ToolTip = L.T("Как реплика в переписке: «ок, буду в пять». Вопрос и восклицательный знак остаются.",
                                      "Like a chat reply: \"ok, see you at five\". Question and exclamation marks stay.");
        SimpleSyntaxBox.IsChecked = _settings.SimpleSyntax;
        ReplaceBox.Content = L.T("Заменять слова в готовой фразе", "Replace words in the finished phrase");
        ReplaceBox.IsChecked = _settings.WordReplacements;
        ReplaceBox.ToolTip = L.T("Словарь нейросети так не поменять. Это обычная замена уже готового текста: цпу становится CPU. Черновик на плашке не трогается.",
                                 "The neural vocabulary cannot be edited. This replaces the finished text only, so цпу becomes CPU. The live draft is left alone.");
        ReplaceList.Text = _settings.EffectiveWordReplacementRules;
        ReplaceList.IsEnabled = _settings.WordReplacements;
        ReplaceList.ToolTip = L.T("Одна замена в строке: как слышится -> как писать. Пустой список вернёт встроенный набор после перезапуска окна, если стереть всё и оставить поле пустым при сохранении.",
                                 "One replacement per line: heard -> written.");
        AutostartBox.Content = L.T("Запускать при входе в Windows", "Start when I sign in to Windows");
        TrayHint.Text = L.T("Крестик не выключает программу: окно прячется, Писарь остаётся в трее у часов. Полный выход — пункт «Выход» в меню трея.",
                            "The close button does not quit: the window hides and Pisar stays by the clock. Quit is in the tray menu.");
        KeepBox.Content = L.T("Сохранять последнюю запись для разбора ошибок", "Keep the last recording for troubleshooting");
        OverlayBox.IsChecked = _settings.ShowOverlay;
        OverlayBox.ToolTip = L.T("Пока клавиша зажата, на плашке волна и черновик. Вставляется не он, а окончательный проход после отпускания. Плашку можно перетащить мышью.",
                                 "While the key is held the pill shows the wave and a draft. What is inserted is the final pass after release, not the draft. Drag the pill to pin it.");
        UnpinButton.Content = L.T("Вернуть к курсору", "Back to the caret");
        UnpinButton.ToolTip = L.T("Плашка снова будет появляться у курсора", "The pill follows the caret again");
        UnpinButton.IsEnabled = _settings.OverlayX != null;
        AutostartBox.IsChecked = Autostart.IsEnabled();
        KeepBox.IsChecked = _settings.KeepLastRecording;
        UpdatesBox.Content = L.T("Проверка обновлений отключена", "Update checks are off");
        UpdatesBox.IsChecked = false;
        UpdatesBox.IsEnabled = false;

        ModelLabel.Text = L.T("Модель распознавания", "Speech model");
        DeviceLabel.Text = L.T("Где считать", "Where it runs");
        ModelBox.Items.Clear();
        ModelBox.Items.Add(new ComboBoxItem
        {
            Content = L.T("GigaAM Multilingual Large CTC — 600M, русский и английский, ~2,4 ГБ",
                          "GigaAM Multilingual Large CTC — 600M, Russian and English, ~2.4 GB"),
            Tag = SpeechModelKind.MultilingualLargeCtc,
        });
        ModelBox.Items.Add(new ComboBoxItem
        {
            Content = L.T("GigaAM v3 e2e RNN-T — русский, с пунктуацией, ~220 МБ",
                          "GigaAM v3 e2e RNN-T — Russian, with punctuation, ~220 MB"),
            Tag = SpeechModelKind.V3E2eRnnt,
        });
        foreach (ComboBoxItem it in ModelBox.Items)
            if ((SpeechModelKind)it.Tag == _settings.SpeechModel) ModelBox.SelectedItem = it;
        ModelNote.Text = L.T("v3 e2e RNN-T ставит русские запятые, точки и заглавные. Большая мультиязычная модель этого не умеет: отдельной модели пунктуации нет. Список «Язык» ниже читает только она, и в граф язык не передаётся.",
                             "v3 e2e RNN-T adds Russian commas, periods and capitals. The large multilingual model does not: there is no separate punctuation model. The Language list below is read only by that model, and no language is passed into the graph.");
        ScriptLabel.Text = L.T("Язык большой модели", "Language of the large model");
        ScriptBox.Items.Clear();
        ScriptBox.Items.Add(new ComboBoxItem { Content = L.T("Авто (русский в приоритете)", "Auto (Russian first)"), Tag = CtcScript.Auto });
        ScriptBox.Items.Add(new ComboBoxItem { Content = L.T("Русский", "Russian"), Tag = CtcScript.Russian });
        ScriptBox.Items.Add(new ComboBoxItem { Content = "English", Tag = CtcScript.English });
        foreach (ComboBoxItem it in ScriptBox.Items)
            if ((CtcScript)it.Tag == _settings.CtcScript) ScriptBox.SelectedItem = it;
        ScriptHint.Text = L.T("В файл модели язык не входит. «English» при выборе буквы CTC пропускает кириллицу, «Русский» пропускает латиницу, пробел и апостроф остаются. «Авто» оставляет текст, если он уже латинский. Если он кириллический, второй проход по тем же оценкам берётся, только когда он почти не хуже: уверенное «хелло» не станет hello. На весах 2,4 ГБ это не проверялось. v3 список не читает.",
                              "The model file has no language input. English skips Cyrillic letters in the CTC choice, Russian skips Latin letters, and space and the apostrophe stay. Auto keeps text that is already Latin. If it is Cyrillic, a second pass on the same scores is used only when it is almost as good: a confident «хелло» does not become hello. This was not tried on the 2.4 GB weights. v3 does not read this list.");
        DeviceBox.Items.Clear();
        DeviceBox.Items.Add(new ComboBoxItem
        {
            Content = L.T("Видеокарта (DirectML)", "Video card (DirectML)"),
            Tag = SpeechDeviceKind.Gpu,
        });
        DeviceBox.Items.Add(new ComboBoxItem
        {
            Content = L.T("Процессор (CPU)", "Processor (CPU)"),
            Tag = SpeechDeviceKind.Cpu,
        });
        foreach (ComboBoxItem it in DeviceBox.Items)
            if ((SpeechDeviceKind)it.Tag == _settings.SpeechDevice) DeviceBox.SelectedItem = it;
        int cores = Math.Max(1, Environment.ProcessorCount);
        ThreadsLabel.Text = L.T("Потоки процессора", "Processor threads");
        ThreadsHint.Text = L.T($"Только когда считает процессор. «Все ядра» — это {cores}. На видеокарте выбор не действует: там по-прежнему не больше 4 потоков внутри ONNX. Раньше и процессор был ограничен четырьмя.",
                                $"Only when the processor does the work. All cores means {cores}. The video card ignores this and still uses at most 4 ONNX threads. The processor used to be capped at four as well.");
        ThreadsBox.Items.Clear();
        ThreadsBox.Items.Add(new ComboBoxItem { Content = L.T($"Все ядра ({cores})", $"All cores ({cores})"), Tag = 0 });
        for (int n = 1; n <= cores; n++)
            ThreadsBox.Items.Add(new ComboBoxItem { Content = n.ToString(), Tag = n });
        int want = _settings.CpuThreads <= 0 || _settings.CpuThreads > cores ? 0 : _settings.CpuThreads;
        foreach (ComboBoxItem it in ThreadsBox.Items)
            if ((int)it.Tag == want) ThreadsBox.SelectedItem = it;
        bool have = SpeechModelStore.FindComplete(_settings.SpeechModel) != null;
        DownloadModelButton.Content = have
            ? L.T("Уже на диске, не скачивать", "Already on disk, do not download")
            : L.T("Скачать выбранную модель", "Download the selected model");
        SpeechStatus.Text = _speechStatus?.Invoke()
            ?? (have
                ? L.T("Файлы модели на месте.", "The model files are on disk.")
                : L.T("Модель не скачана. Нажмите кнопку. Сама она не скачивается.",
                      "The model is not downloaded. Press the button. It does not download by itself."));
        HermesHeading.Text = L.T("Расшифровка для других компьютеров", "Transcription for other computers");
        HermesListenStatus.Text = _hermesStatus?.Invoke()
            ?? L.T($"Сейчас только этот компьютер, порт {SpeechModels.HermesPort}.",
                   $"This computer only right now, port {SpeechModels.HermesPort}.");
        LanButton.Content = _settings.HermesOnLan
            ? L.T("Снова слушать только этот компьютер", "Listen on this PC only again")
            : L.T("Открыть порт в брандмауэре и слушать сеть", "Open the firewall port and listen on the network");
        KeepAwakeBox.Content = L.T("Не давать компьютеру уснуть, пока идёт расшифровка",
                                   "Keep the PC awake while transcription is listening");
        KeepAwakeBox.ToolTip = L.T("Пока Писарь слушает порт, Windows не уйдёт в сон от простоя. Выключение руками по-прежнему работает. Снимите галочку или закройте Писаря, и сон снова разрешён.",
                                   "While Pisar is listening, Windows will not idle-sleep. You can still shut down by hand. Clear the box or quit Pisar and sleep is allowed again.");
        KeepAwakeBox.IsChecked = _settings.KeepAwakeWhileListening;

        CleanupHeading.Text = L.T("Мозг", "Brain");
        CleanupHint.Text = L.T("Нейросеть правит надиктованное по команде. Скажите в конце: «Писарь, исправь», «Писарь, сократи» или «Писарь, переведи на английский». Без обращения текст вставляется сразу.",
                               "An AI model edits the dictation on command. End with \"Pisar, fix it\", \"Pisar, make it shorter\" or \"Pisar, translate into English\" (said in Russian). Without the address the text goes in at once.");
        BrainLabel.Text = L.T("Где думает", "Runs on");
        BrainBox.Items.Clear();
        BrainBox.Items.Add(new ComboBoxItem { Content = L.T("Выключен", "Off"), Tag = BrainSource.Off });
        if (LocalBrain.Offered || _settings.Brain == BrainSource.Local)
            BrainBox.Items.Add(new ComboBoxItem
            {
                Content = LocalBrain.Downloaded ? L.T($"На компьютере ({LocalBrain.ModelTitle})", $"On this computer ({LocalBrain.ModelTitle})")
                                                : L.T("На компьютере (скачать 2 ГБ)", "On this computer (download 2 GB)"),
                Tag = BrainSource.Local,
            });
        BrainBox.Items.Add(new ComboBoxItem { Content = L.T("В облаке", "In the cloud"), Tag = BrainSource.Server });
        foreach (ComboBoxItem it in BrainBox.Items)
            if ((BrainSource)it.Tag == _settings.Brain) BrainBox.SelectedItem = it;
        ServerPanel.Bind(_settings, _apply);
        DeleteBrainButton.Content = L.T("Удалить модель с компьютера (2 ГБ)", "Delete the model from this computer (2 GB)");
        EditHeading.Text = L.T("Правка выделенного", "Edit selection");
        EditIntro.Text = L.T("Выделите текст в любой программе, зажмите клавишу диктовки и скажите, что с ним сделать. Результат встанет на место выделенного, а Ctrl+Z вернёт как было.",
                             "Select text in any app, hold the dictation key and say what to do with it. The result replaces the selection; Ctrl+Z brings the original back.");
        SelectionBox.Content = L.T("Править выделенный текст голосом", "Edit selected text by voice");
        SelectionBox.IsChecked = _settings.BrainOnSelection;
        SelectionHint.Text = L.T("Выключите, если хотите просто надиктовывать поверх выделенного: тогда выделение ни на что не влияет.",
                                 "Turn off to simply dictate over a selection: then selecting changes nothing.");
        ExamplesLabel.Text = L.T("Что можно сказать", "What you can say");
        Examples.Text = L.T("«сделай короче»  ·  «исправь ошибки»  ·  «перепиши вежливее»\n«переведи на английский»  ·  «сделай списком»  ·  «добавь заголовок»",
                            "\"make it shorter\"  ·  \"fix the mistakes\"  ·  \"make it more polite\"\n\"translate into English\"  ·  \"make it a list\"  ·  \"add a title\"\n(said in Russian)");
        EveryTakeBox.Content = L.T("Править на лету", "Edit on the fly");
        EveryTakeBox.IsChecked = _settings.BrainEveryTake;
        EveryTakeHint.Text = L.T("Нейросеть причёсывает каждую диктовку сама, без команды «Писарь, …». Удобно с быстрым облачным сервисом.",
                                 "The model tidies every take by itself, no \"Pisar, …\" needed. Handy with a fast cloud service.");
        PromptExpander.Header = L.T("Инструкция для этого режима", "Instructions for this mode");
        PromptBox.Text = _settings.EffectiveCleanupPrompt;
        UpdateBrainTexts();

        AboutHeading.Text = L.T("О программе", "About");
        About.Text = L.T($"Гига Писарь {PisarApp.Version}. Распознавание идёт на вашем компьютере моделью GigaAM от Сбера, звук никуда не отправляется.",
                         $"Giga Pisar {PisarApp.Version}. Speech is recognized on your computer by Sber's GigaAM model; audio never leaves it.");
        VersionLine.Text = L.T($"Версия {PisarApp.Version}. Кнопка ниже сравнивает её с последним релизом github.com/zai-one/giga-pisar-win. Другие адреса не спрашиваются, обновление само не скачивается.",
                               $"Version {PisarApp.Version}. The button below compares it with the latest release of github.com/zai-one/giga-pisar-win. No other address is asked, and the update is not downloaded.");
        CheckUpdatesButton.Content = L.T("Проверить обновления", "Check for updates");
        var onDisk = SpeechModelStore.FindComplete(_settings.SpeechModel);
        ModelPath.Text = onDisk == null
            ? L.T("Выбранная модель на диске не найдена. Смотрел здесь:\n", "The selected model was not found on disk. Looked here:\n") + SpeechModelStore.SearchSummary()
            : L.T("Модель уже на диске:\n", "Model is already on disk:\n") + onDisk;
        HermesLine.Text = _hermesStatus?.Invoke()
            ?? L.T($"Hermes: порт {SpeechModels.HermesPort}.", $"Hermes: port {SpeechModels.HermesPort}.");
        CodeLink.Text = L.T("исходный код", "source code");
        MicLine.Text = L.T("Микрофон: ", "Microphone: ") + Recorder.DefaultDeviceName();
        ModelLink.Text = L.T("модель GigaAM от Сбера", "GigaAM model by Sber");
        LogLink.Text = L.T("Открыть папку с журналом", "Open the log folder");
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
        RestoreClipBox.IsEnabled = _settings.CopyPhraseToClipboard;
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

    private void Updates_Click(object sender, RoutedEventArgs e)
    {
        UpdatesBox.IsChecked = false;
        _settings.CheckUpdates = false;
    }

    private void CheckUpdates_Click(object sender, RoutedEventArgs e) => _checkUpdates?.Invoke();

    /// <summary>The close button hides the window. The process stays in the tray until Quit.</summary>
    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (!PisarApp.IsQuitting)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnClosing(e);
    }

    private void SpeechModel_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || ModelBox.SelectedItem is not ComboBoxItem item) return;
        var kind = (SpeechModelKind)item.Tag;
        if (kind == _settings.SpeechModel) return;
        _settings.SpeechModel = kind;
        _apply();
        _speechChanged?.Invoke();
    }

    private void Script_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || ScriptBox.SelectedItem is not ComboBoxItem item) return;
        var script = (CtcScript)item.Tag;
        if (script == _settings.CtcScript) return;
        _settings.CtcScript = script;
        _apply();
    }

    private void SpeechDevice_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || DeviceBox.SelectedItem is not ComboBoxItem item) return;
        var device = (SpeechDeviceKind)item.Tag;
        if (device == _settings.SpeechDevice) return;
        _settings.SpeechDevice = device;
        _apply();
        _speechChanged?.Invoke();
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

    private async void DownloadModel_Click(object sender, RoutedEventArgs e)
    {
        if (_downloadSpeech == null) return;
        DownloadModelButton.IsEnabled = false;
        try { await _downloadSpeech(); }
        finally
        {
            DownloadModelButton.IsEnabled = true;
            Localize();
        }
    }

    private void KeepAwake_Click(object sender, RoutedEventArgs e)
    {
        _settings.KeepAwakeWhileListening = KeepAwakeBox.IsChecked == true;
        _apply();
        _keepAwakeChanged?.Invoke();
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

    private void SimpleSyntax_Click(object sender, RoutedEventArgs e)
    {
        _settings.SimpleSyntax = SimpleSyntaxBox.IsChecked == true;
        _apply();
    }

    private void Replace_Click(object sender, RoutedEventArgs e)
    {
        _settings.WordReplacements = ReplaceBox.IsChecked == true;
        ReplaceList.IsEnabled = _settings.WordReplacements;
        SaveReplaceList();
        _apply();
    }

    private void ReplaceList_LostFocus(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        SaveReplaceList();
        _apply();
    }

    private void SaveReplaceList()
    {
        var text = ReplaceList.Text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
        if (text.Length == 0) _settings.WordReplacementRules = "#";
        else if (text == WordReplace.DefaultRules.Trim()) _settings.WordReplacementRules = "";
        else _settings.WordReplacementRules = text + "\n";
    }

    private void Keep_Click(object sender, RoutedEventArgs e)
    {
        _settings.KeepLastRecording = KeepBox.IsChecked == true;
        if (!_settings.KeepLastRecording)
            try { File.Delete(Settings.LastTakePath); } catch { }
        _apply();
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
        DeleteBrainButton.Visibility = LocalBrain.Downloaded && b != BrainSource.Local ? Visibility.Visible : Visibility.Collapsed;
        var every = b == BrainSource.Off ? Visibility.Collapsed : Visibility.Visible;
        // Editing a selection is done by the Brain: say which one, or that it has to be turned on first.
        bool ready = b switch { BrainSource.Local => LocalBrain.Downloaded, BrainSource.Server => Brain.ServerConfigured(_settings), _ => false };
        string host = SpeechCleanup.HostOf(_settings.CleanupEndpointUrl);
        EditBrainLine.Text = !ready
            ? L.T("Текст переписывает нейросеть, поэтому для правки нужен Мозг. Сейчас он не настроен.",
                  "An AI model rewrites the text, so editing needs the Brain. It is not set up yet.")
            : b == BrainSource.Local
                ? L.T("Переписывает Мозг на этом компьютере, без интернета.", "Rewritten by the Brain on this computer, offline.")
                : L.T($"Переписывает Мозг в облаке: {host}. Выделенный текст уходит туда, звук нет.",
                      $"Rewritten by the Brain in the cloud: {host}. The selected text goes there, audio does not.");
        GoBrainButton.Content = ready ? L.T("Мозг…", "Brain…") : L.T("Настроить Мозг", "Set up the Brain");
        EveryTakeBox.Visibility = every;
        EveryTakeHint.Visibility = every;
        PromptExpander.Visibility = b != BrainSource.Off && _settings.BrainEveryTake ? Visibility.Visible : Visibility.Collapsed;
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

    private void Prompt_LostFocus(object sender, RoutedEventArgs e)
    {
        var prompt = PromptBox.Text.Trim();
        // Our default (in any language) is stored as empty, so it keeps following the interface language.
        _settings.CleanupPrompt = prompt.Length == 0 || SpeechCleanup.IsDefaultPrompt(prompt) ? "" : prompt;
        _apply();
    }

    private void GoBrain_Click(object sender, RoutedEventArgs e) => ShowPage(Page.Brain);

    private void Selection_Click(object sender, RoutedEventArgs e)
    {
        _settings.BrainOnSelection = SelectionBox.IsChecked == true;
        _apply();
    }

    private void EveryTake_Click(object sender, RoutedEventArgs e)
    {
        _settings.BrainEveryTake = EveryTakeBox.IsChecked == true;
        _apply();
        UpdateBrainTexts();
    }

    private void DeleteBrain_Click(object sender, RoutedEventArgs e)
    {
        LocalBrain.DeleteModel();
        Localize();
    }


    private void Link_Click(object sender, RequestNavigateEventArgs e)
    {
        try { Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true }); } catch { }
        e.Handled = true;
    }

    private void Log_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(Settings.LocalDataDir);
            Process.Start(new ProcessStartInfo("explorer.exe", Settings.LocalDataDir) { UseShellExecute = true });
        }
        catch { }
    }
}
