# Chawo VA — идеи из похожих open-source проектов

Дата: 2026-10-13. Только идеи, код не реализован. Ограничения: приватность (локально по умолчанию, без телеметрии), без API-ключей в репо, только тёмная тема, без дублей настроек, лаконичные меню.

## Изученные проекты

| Проект | ★ | Стек | Лицензия | Чем интересен |
|---|---|---|---|---|
| [cjpais/Handy](https://github.com/cjpais/Handy) | 33.7k | Tauri v2 / Rust | MIT | Silero VAD, Parakeet, push-to-talk, paste-вставка, Linux-фоллбэки ввода |
| [chidiwilliams/buzz](https://github.com/chidiwilliams/buzz) | 22k | Python/Qt | MIT | файловая транскрипция, редактор транскрипта, экспорт, CLI, перевод |
| [OpenWhispr/openwhispr](https://github.com/OpenWhispr/openwhispr) | 9.3k | Electron/JS | MIT | ближайший аналог по стеку: hotkey-assistant, правка выделенного текста, встречи, диаризация, заметки с поиском, URL-импорт, sherpa-onnx, llama.cpp |
| [thewh1teagle/vibe](https://github.com/thewh1teagle/vibe) | 7.8k | Tauri / TS+Rust | MIT | SRT/VTT/HTML/PDF/JSON/DOCX, системный звук, CLI, диаризация, VAD-стабильные таймкоды, `vibe://download` |
| [Beingpax/VoiceInk](https://github.com/Beingpax/VoiceInk) | 6.8k | Swift | GPL-3.0 | Power Modes (настройки по приложению/URL), контекст выделенного текста, пауза медиа |
| [EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter) (Whispering) | 4.8k | Tauri/Svelte/TS | см. репо | история записей, трансформации-пайплайны, VAD-режим |
| [ideasman42/nerd-dictation](https://github.com/ideasman42/nerd-dictation) | 1.9k | Python/VOSK | GPL-3.0 | hackable пользовательский скрипт пост-обработки, числа словами→цифры |
| [mkiol/dsnote](https://github.com/mkiol/dsnote) (Speech Note) | 1.7k | C++/Qt | MPL-2.0 | заметки, офлайн-перевод, TTS, много движков |
| [peteonrails/voxtype](https://github.com/peteonrails/voxtype) | 1.6k | Rust | MIT | spoken punctuation, звуковые сигналы, пауза музыки, toggle/hold, meeting-mode, idle-выгрузка моделей, цепочка фоллбэков ввода |
| [savbell/whisper-writer](https://github.com/savbell/whisper-writer) | 1.1k | Python | GPL-3.0 | режимы: hold / toggle / VAD auto-stop / continuous |

GPL-проекты — только как источник идей, код не копировать.

## Бэклог (приоритет сверху вниз)

### 1. ⭐ DO NEXT — Вставка с восстановлением буфера обмена (S)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-win-native`, PR #1): вставка в другие приложения через Windows native helper — снимок буфера, Ctrl+V, восстановление прежнего содержимого, если пользователь за это время ничего нового не скопировал.
- Источник: [Handy](https://github.com/cjpais/Handy), [OpenWhispr](https://github.com/OpenWhispr/openwhispr), [voxtype](https://github.com/peteonrails/voxtype).
- Зачем: доводит текущую задачу «вставка в другие приложения»; пользователь не теряет свой буфер.
- Реализация: `src/main/dictation/insert.ts`: снапшот `clipboard.readText/readHTML/readImage` → `writeText(result)` → эмуляция Ctrl+V (Windows: `SendInput` через маленький native helper/ PowerShell-фоллбэк) → через ~150–300 мс восстановить снапшот, если буфер не менялся (сравнить `clipboard` до восстановления). Фоллбэк: оставить текст в буфере + уведомление в overlay. Одна настройка «Вставлять автоматически» (без дублей).
- Тесты: unit с моком `clipboard` и инжектором (порядок вызовов, восстановление, не трогать если пользователь скопировал новое); ручной: Notepad, Word, Chrome, Telegram.

### 2. ⭐ DO NEXT — VAD (Silero ONNX): обрезка тишины + авто-стоп (M)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-vad`): `src/core/vad.ts` — Silero VAD v5 через onnxruntime-node (окно 512 + контекст 64, state [2,1,128], длинные файлы — до 16 параллельных «дорожек» в одном батче) и чистый JS-фоллбэк по громкости. Диктовка: тишина до и после фразы отрезается (100 мс запаса). Длинные файлы (локально, клиент, Hermes) режутся по паузам в речи, а не по громкости. Одна галка «Обрезать тишину (VAD)» в «Распознавании» (вкл. по умолчанию) и кнопка «Скачать (2 МБ)», пока модели нет; модель приходит и вместе с речевой моделью, которую скачивает пользователь. Без модели всё работает как раньше. Авто-стоп после N мс тишины — `VadAutoStopMs` в settings.json (0 = выкл.), без отдельного UI до toggle-режима.
- Источник: [Handy](https://github.com/cjpais/Handy), [whisper-writer](https://github.com/savbell/whisper-writer), [vibe](https://github.com/thewh1teagle/vibe).
- Зачем: меньше галлюцинаций/«пустых» фраз GigaAM на тишине, быстрее; разрезка длинных файлов по паузам вместо фиксированных чанков (лучше границы в `fileParallel.ts`).
- Реализация: `src/core/vad.ts` — Silero VAD v5 ONNX через уже имеющийся onnxruntime-node (16 кГц, окна 512, state-тензор), API `segments(pcm): {start,end}[]`. Подключить: (а) в диктовке — тримминг до/после; (б) опциональный авто-стоп после N мс тишины для toggle-режима; (в) в `fileParallel.ts` — резать по паузам ближе к целевой длине чанка. Модель — через существующий загрузчик моделей.
- Тесты: фикстуры (тишина, речь+тишина, шум) → ожидаемые сегменты ±50 мс; регрессия `fileParallel.test.ts`: склейка текста без потерь слов на границах.

### 3. ⭐ DO NEXT — История диктовок с поиском и повтором (M)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-history`): раздел «История» — текст до и после мозга, поиск (регистр и ё/е не важны), «Копировать», «Копировать без мозга», «Мозг заново», «Удалить», «Очистить всё». JSONL в %LOCALAPPDATA%, звук не хранится, срок хранения одной настройкой (Не хранить / Сутки / Неделю (по умолчанию) / Месяц / Пока не удалю сам), не больше 2000 записей. «Вставить снова» — после слияния `ts/feat-win-native` (из окна Chawo фокус всё равно у Chawo, поэтому пока — копирование).
- Источник: [Whispering/epicenter](https://github.com/EpicenterHQ/epicenter), [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (notes), [Buzz](https://github.com/chidiwilliams/buzz).
- Зачем: восстановить текст, если вставка не удалась; сравнить сырой текст и результат Brain.
- Реализация: `src/main/history/` — JSONL или SQLite (better-sqlite3 + FTS5) в userData: `{ts, raw, final, brainCommand, app, durationMs, audioPath?}`. Хранение аудио — выкл. по умолчанию, ретенция (N дней/записей). Страница «История» в renderer: поиск, копировать, «вставить снова», «прогнать Brain заново», удалить/очистить всё.
- Тесты: unit на хранилище (добавление, поиск по кириллице, ретенция); IPC-тест; страница по образцу `dictationPage.test.ts`.

### 4. ⭐ DO NEXT — Режимы по приложению (per-app modes/prompts) (M)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-app-modes`): раздел «Для отдельных программ» внизу «Мозга». Правило = имя программы (telegram, winword) или кусок заголовка окна, несколько через запятую; первое сверху выигрывает. Правка: как обычно / не переписывать («Чаво, …» работает) / переписывать по своей инструкции; плюс «как в чате» (простой синтаксис) вкл/выкл. Программа определяется при нажатии клавиши только на этом компьютере (Windows — PowerShell до слияния `ts/feat-win-native`, потом команда `fg` хелпера; Linux — xprop; macOS — osascript), заголовок окна не пишется ни в лог, ни на диск. Пока правил нет, программа даже не определяется. Кнопка «Добавить для <программа>» по последней диктовке.
- Источник: [VoiceInk Power Modes](https://github.com/Beingpax/VoiceInk), [OpenWhispr](https://github.com/OpenWhispr/openwhispr).
- Зачем: в мессенджере — без Brain, в почте — формальный стиль, в IDE — без автокапитализации.
- Реализация: при старте записи получить активное окно (Windows: `GetForegroundWindow` → exe-имя; npm `active-win`/`get-windows` или свой helper). `settings.modes: [{match:{exe|title}, brain: off|prompt, replacements?:bool}]`. Применяется в `dictationBrain`. UI — один список в разделе Brain (не дублировать глобальные настройки, режим лишь переопределяет).
- Тесты: unit матчинга правил и выбора промпта; тест, что без правил поведение прежнее.

### 5. ⭐ DO NEXT — Команда над выделенным текстом («Чаво, переведи/сократи это») (M)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-selection`, поверх `ts/feat-win-native`): выделите текст в любой программе, зажмите клавишу и скажите, что сделать («сделай короче», «переведи на английский», «Чаво,» не обязательно). Пока говорите, плашка пишет «Выделено N знаков». Ответ Мозга вставляется вместо выделения, вернуть — Ctrl+Z. Выделение читается через UI Automation (без побочных эффектов), Ctrl+C с возвратом буфера — только для программ, которые так не умеют; терминалы и таблицы (Excel, Calc) пропускаются. Если Мозг не справился — ничего не вставляется. Галка «Мозга» видна только в Windows.
- Источник: [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (highlighted text is edited in place), [VoiceInk](https://github.com/Beingpax/VoiceInk).
- Зачем: естественное расширение «Чаво, …»-команд.
- Реализация: при нажатии hotkey — Ctrl+C с сохранением/восстановлением буфера (переиспользует п.1) → если выделение есть, передать в Brain как `context.selection`; результат заменяет выделение вставкой.
- Тесты: unit сборки промпта с selection; e2e-ручной в Notepad/Word.

### 6. ⭐ DO NEXT — Экспорт VTT/JSON/DOCX/MD + редактор транскрипта (S→M)
- ✅ Экспорт сделан 2026-10-13 (ветка `ts/feat-export-formats`): .vtt/.json/.md/.docx рядом с .txt, одна строка галок «Ещё сохранять рядом». Редактор транскрипта — отдельной задачей (batch 2, п.10).
- Источник: [vibe](https://github.com/thewh1teagle/vibe), [Buzz](https://github.com/chidiwilliams/buzz).
- Зачем: сейчас txt/srt/timestamps; VTT нужен для веба, JSON — для интеграций, DOCX — для офисных пользователей.
- Реализация: расширить `src/core/transcriptFormat.ts` форматтерами `toVtt`, `toJson` (сегменты+слова), `toMarkdown`; DOCX через `docx` npm (лениво). Выбор форматов — тот же селектор, что сейчас для txt/srt.
- Тесты: снапшот-тесты форматтеров на фикстуре сегментов (экранирование, `HH:MM:SS.mmm` для VTT).

### 7. ⭐ DO NEXT — Индикатор уровня микрофона + звуковые сигналы + пауза медиа (S)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-mic-level`): уровень микрофона уже был (полоски на плашке и измеритель на «Диктовке»); добавлены тихие звуковые сигналы начала / конца / отмены записи (Web Audio, без файлов; одна галка «Звуковые сигналы начала и конца записи» на «Диктовке», по умолчанию выкл.) и состояние в трее: красная точка — идёт запись, янтарная — распознаю, подсказка трея меняется так же. Пауза медиа — ещё нет (нужен Windows helper с GSMTC, отдельный шаг).
- Источник: [voxtype](https://github.com/peteonrails/voxtype) (waveform OSD, audio cues, MPRIS pause), [VoiceInk](https://github.com/Beingpax/VoiceInk).
- Зачем: пользователь видит, что микрофон пишет; сигнал старта важен для hold-hotkey.
- Реализация: RMS уже доступен в `mic-processor.js` → IPC в overlay (полоска/волна) и в иконку трея (3–4 состояния). Короткие WAV-сигналы в renderer (вкл/выкл одной галкой). Пауза медиа на Windows: `VK_MEDIA_PLAY_PAUSE` только если что-то играет (GSMTC через helper) — опционально, отдельный шаг.
- Тесты: unit расчёта уровня/троттлинга; `overlayModel.test.ts` — состояние уровня.

### 8. ⭐ DO NEXT — CLI для файловой транскрипции (S)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-cli`): `chawo-va transcribe <файлы|папки> -f txt,srt -o dir -t -j N --stdout --skip-existing`, настройки приложения только читаются, коды выхода 0/1/2/3/130. Форматы .vtt/.json/.md/.docx добавятся в CLI после слияния `ts/feat-export-formats`.
- Источник: [vibe](https://github.com/thewh1teagle/vibe) (`--help`), [Buzz](https://github.com/chidiwilliams/buzz), [voxtype](https://github.com/peteonrails/voxtype).
- Зачем: пакетная обработка, скрипты, CI-проверка качества распознавания.
- Реализация: `src/cli.ts` поверх `core/fileJob.ts` + `fileParallel.ts` (ядро уже без Electron): `chawo-va transcribe <files…> --format srt,txt --out dir --threads N`. Декодирование: ffmpeg при наличии, иначе ограничиться wav/ogg (встроенный декодер завязан на Chromium). `bin` в package.json.
- Тесты: vitest запускает CLI на фикстуре wav, сверяет выход; коды возврата при ошибках.

### 9. Голосовая пунктуация и числа (S)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-voice-punct`, approved batch 2 п.1): две галки на «Словаре» — «Знаки препинания голосом» («запятая», «точка», «точка с запятой», «двоеточие», «вопросительный/восклицательный знак», «многоточие», «тире», «дефис», «открыть/закрыть скобку», «открыть/закрыть кавычки», «новая строка», «новый абзац»; знаки модели вокруг команды поглощаются; «точка зрения», «торговая точка» остаются словами) и «Числа цифрами» (количественные, в т.ч. в косвенных падежах; составное число с порядковым концом → «25-е», «2026-го»; одиночные «один», «тысячи», «пятое» не трогаются). Обе выкл. по умолчанию, только для диктовки: после словаря, до мозга. Модель v3 e2e уже сама пишет цифры («25 000 ₽», «10%»), так что «Числа цифрами» в основном для остальных моделей.
- Источник: [voxtype](https://github.com/peteonrails/voxtype), [nerd-dictation](https://github.com/ideasman42/nerd-dictation).
- Реализация: правила в `wordReplace.ts`: «запятая»→«,», «новая строка»→`\n`, «точка»; числительные→цифры (ITN для русского, словарь + простой парсер). Вкл. одной настройкой в словаре.
- Тесты: таблица вход/выход.

### 10. Транскрипция системного звука / встреч (L)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-meeting`, approved batch 2 п.2): блок «Встреча» на «Расшифровке файла» — «Записать встречу» пишет микрофон и звук компьютера (галка «Со звуком компьютера», вкл. по умолчанию) в стерео WAV 16 кГц (левый канал — микрофон, правый — компьютер, на будущее для «Я / Собеседник») в «Документы/Chawo VA/Встречи»; «Остановить и расшифровать» ставит файл в обычную очередь, .txt появляется рядом. Звук компьютера — loopback Chromium через getDisplayMedia (Windows WASAPI, Linux PulseAudio/PipeWire), видео экрана сразу отбрасывается; macOS пока только микрофон. Заголовок WAV обновляется каждые 5 с, после сбоя файл чинится при следующей записи. Всё локально.
- Источник: [OpenWhispr](https://github.com/OpenWhispr/openwhispr), [vibe](https://github.com/thewh1teagle/vibe), [voxtype](https://github.com/peteonrails/voxtype) meeting mode.
- Реализация: Electron `desktopCapturer` + `setDisplayMediaRequestHandler({audio:'loopback'})` на Windows; микс mic+loopback в renderer; запись в файл → существующая файловая очередь, либо чанки по VAD в реальном времени.
- Тесты: ручные (Zoom/YouTube); unit микшера.

### 11. ✅ DONE — Диаризация спикеров (L)
- Источник: [OpenWhispr](https://github.com/OpenWhispr/openwhispr), [vibe](https://github.com/thewh1teagle/vibe), [Buzz](https://github.com/chidiwilliams/buzz).
- Реализация (ветка `ts/feat-diarization`): `src/core/diarize.ts` — `assignSpeakers` по максимальному пересечению во времени + remap id по первому появлению; `TranscriptSegment.speaker?`; `toTxt`/`toSrt` префиксуют «Спикер N:» (1-based), когда хоть у одного сегмента есть speaker. Runtime: `sherpa-onnx-node` `OfflineSpeakerDiarization` (lazy require), модели pyannote segmentation + 3D-Speaker embedding в `%LOCALAPPDATA%/…/models/diarization/` (скачивание по кнопке, не в репо). Настройка `FileDiarize` (default false), чекбокс «Разделять спикеров» на «Расшифровка файла», после локальной расшифровки — diarize PCM → assign → запись; без моделей очередь не падает.
- Тесты: assignSpeakers/formats/settings/fileRunner (fake diarizer); smoke `scripts/smoke-diarize.cjs` (четыре спикера wav).


### 12. ✅ DONE — Импорт по URL (YouTube и т.п.) (M)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-url-transcribe`, approved batch 2 п.4): блок «По ссылке» на «Расшифровке файла» — поле ссылки + «Скачать и расшифровать». yt-dlp не входит в программу: кнопка «Скачать yt-dlp» берёт официальную сборку с GitHub (Windows/macOS/Linux x64/arm64) и сверяет sha256 с SHA2-256SUMS того же релиза; «Обновить yt-dlp» — то же поверх. yt-dlp из PATH тоже подходит. Только http(s), без плейлистов, без cookies и чужого конфига; звук в «Загрузки/Chawo», дальше обычная локальная очередь, .txt рядом. Через сеть идёт только скачивание (так и написано под полем). Для YouTube в роли JS-рантайма yt-dlp используется сам Electron (ELECTRON_RUN_AS_NODE), ставить deno/node не нужно.
- Источник: [vibe](https://github.com/thewh1teagle/vibe), [OpenWhispr](https://github.com/OpenWhispr/openwhispr).
- Реализация: опциональный yt-dlp (скачивается по запросу, как модели) → файл в очередь. Явное предупреждение о сети.

### 13. Выгрузка моделей при простое (S)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-idle-unload`, approved batch 2 п.5): один выбор «Выгружать модели при простое» на «Распознавании» — «Не выгружать / Через 5 мин / 15 мин / 30 мин / 1 час», по умолчанию 15 мин (как раньше было зашито для локального Мозга). Касается речевой модели диктовки (и Hermes-хоста, который её использует) и llama-server локального Мозга; отсчёт идёт от конца последней фразы/ответа, во время записи, распознавания или запроса Hermes не выгружается. Следующее нажатие клавиши снова загружает модель, пока человек говорит. CLI не нужен: он и так закрывается после задания.
- Источник: [voxtype](https://github.com/peteonrails/voxtype).
- Реализация: таймер в `speech/` и local Brain: освобождать InferenceSession/llama-server через N минут; ленивый прогрев при hotkey.
- Тесты: unit таймера с fake timers.

### 14. Deep-link установки моделей `chawo://download?url=` (S)
- Источник: [vibe](https://github.com/thewh1teagle/vibe). `app.setAsDefaultProtocolClient`, подтверждение пользователем, проверка sha256.

### 15. Офлайн-перевод диктовки (M)
- ✅ Сделано 2026-10-13 (ветка `ts/feat-translate`, approved batch 2 п.7): перевод через тот же Мозг (локальный llama по умолчанию или свой сервер), без сторонних API, без нового хоткея и без галки «включить перевод». В диктовке и над выделенным текстом: «Чаво, переведи на немецкий», «Чаво, по-английски», «translate to French» — свой промпт переводчика (только перевод, имена/числа/даты как есть, без комментариев) вместо общего промпта правки; пилюля «Перевожу…». Без языка в команде: русский текст → английский, остальной → русский; незнакомый язык после «на/to» уходит как есть («на суахили»). На «Расшифровке файла» блок «Перевод»: поле языка (список частых + свой текст, запоминается в `TranslateTarget`) и «Перевести последнюю расшифровку» → `name.translate.txt` рядом и карточка; для облака — подтверждение, как у других действий Мозга. CLI: `chawo-va translate <txt…> [--to язык] [--stdout] [-o папка]`.
- Источник: [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (translation hotkey), [Speech Note](https://github.com/mkiol/dsnote).
- Реализация: проще всего — пресет команды Brain «Чаво, по-английски …» (без отдельной настройки/хоткея, чтобы не плодить UI).

### 16. Пользовательский скрипт пост-обработки (S)
- Источник: [nerd-dictation](https://github.com/ideasman42/nerd-dictation), [voxtype](https://github.com/peteonrails/voxtype) (pipe через shell).
- Реализация: путь к скрипту в расширенных настройках; stdin→stdout с таймаутом. Для продвинутых.

## Approved batch 2 (одобрено пользователем 2026-10-13, порядок = приоритет после top-8)
1. Голосовая пунктуация + числа словами → цифры (см. №9) — ветка `ts/feat-voice-punct`.
2. Системный звук / встречи вместе с микрофоном (см. №10) — ветка `ts/feat-meeting`.
3. Диаризация спикеров локально через sherpa-onnx (см. №11) — ветка `ts/feat-diarization`.
4. ✅ Расшифровка по URL через yt-dlp (см. №12) — ветка `ts/feat-url-transcribe`.
1. Голосовая пунктуация + числа словами → цифры (см. №9).
2. ✅ Системный звук / встречи вместе с микрофоном (см. №10) — ветка `ts/feat-meeting`.
2. Системный звук / встречи вместе с микрофоном (см. №10).
3. Диаризация спикеров локально через sherpa-onnx (см. №11).
4. Расшифровка по URL через yt-dlp (см. №12).
5. ✅ Выгрузка моделей при простое (см. №13) — ветка `ts/feat-idle-unload`.
6. ✅ Карточка «Кратко и задачи» после встречи от Мозга — ветка `ts/feat-meeting-brief`: поле инструкции формата вывода (пользователь правит), `.brief.txt`, CLI `chawo-va brief`.
7. ✅ «Чаво, переведи на …» (см. №15) — ветка `ts/feat-translate`: свой промпт переводчика в диктовке/выделении, блок «Перевод» на «Расшифровке файла» → `.translate.txt`, CLI `chawo-va translate --to`.
8. Пользовательский скрипт пост-обработки (см. №16).
9. Локальное необязательное слово-активатор «Чаво» (по умолчанию выключено).
10. Редактор транскрипта: клик по фразе — воспроизведение аудио с этого места.

