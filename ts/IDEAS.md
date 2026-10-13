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
- Источник: [Handy](https://github.com/cjpais/Handy), [OpenWhispr](https://github.com/OpenWhispr/openwhispr), [voxtype](https://github.com/peteonrails/voxtype).
- Зачем: доводит текущую задачу «вставка в другие приложения»; пользователь не теряет свой буфер.
- Реализация: `src/main/dictation/insert.ts`: снапшот `clipboard.readText/readHTML/readImage` → `writeText(result)` → эмуляция Ctrl+V (Windows: `SendInput` через маленький native helper/ PowerShell-фоллбэк) → через ~150–300 мс восстановить снапшот, если буфер не менялся (сравнить `clipboard` до восстановления). Фоллбэк: оставить текст в буфере + уведомление в overlay. Одна настройка «Вставлять автоматически» (без дублей).
- Тесты: unit с моком `clipboard` и инжектором (порядок вызовов, восстановление, не трогать если пользователь скопировал новое); ручной: Notepad, Word, Chrome, Telegram.

### 2. ⭐ DO NEXT — VAD (Silero ONNX): обрезка тишины + авто-стоп (M)
- Источник: [Handy](https://github.com/cjpais/Handy), [whisper-writer](https://github.com/savbell/whisper-writer), [vibe](https://github.com/thewh1teagle/vibe).
- Зачем: меньше галлюцинаций/«пустых» фраз GigaAM на тишине, быстрее; разрезка длинных файлов по паузам вместо фиксированных чанков (лучше границы в `fileParallel.ts`).
- Реализация: `src/core/vad.ts` — Silero VAD v5 ONNX через уже имеющийся onnxruntime-node (16 кГц, окна 512, state-тензор), API `segments(pcm): {start,end}[]`. Подключить: (а) в диктовке — тримминг до/после; (б) опциональный авто-стоп после N мс тишины для toggle-режима; (в) в `fileParallel.ts` — резать по паузам ближе к целевой длине чанка. Модель — через существующий загрузчик моделей.
- Тесты: фикстуры (тишина, речь+тишина, шум) → ожидаемые сегменты ±50 мс; регрессия `fileParallel.test.ts`: склейка текста без потерь слов на границах.

### 3. ⭐ DO NEXT — История диктовок с поиском и повтором (M)
- Источник: [Whispering/epicenter](https://github.com/EpicenterHQ/epicenter), [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (notes), [Buzz](https://github.com/chidiwilliams/buzz).
- Зачем: восстановить текст, если вставка не удалась; сравнить сырой текст и результат Brain.
- Реализация: `src/main/history/` — JSONL или SQLite (better-sqlite3 + FTS5) в userData: `{ts, raw, final, brainCommand, app, durationMs, audioPath?}`. Хранение аудио — выкл. по умолчанию, ретенция (N дней/записей). Страница «История» в renderer: поиск, копировать, «вставить снова», «прогнать Brain заново», удалить/очистить всё.
- Тесты: unit на хранилище (добавление, поиск по кириллице, ретенция); IPC-тест; страница по образцу `dictationPage.test.ts`.

### 4. ⭐ DO NEXT — Режимы по приложению (per-app modes/prompts) (M)
- Источник: [VoiceInk Power Modes](https://github.com/Beingpax/VoiceInk), [OpenWhispr](https://github.com/OpenWhispr/openwhispr).
- Зачем: в мессенджере — без Brain, в почте — формальный стиль, в IDE — без автокапитализации.
- Реализация: при старте записи получить активное окно (Windows: `GetForegroundWindow` → exe-имя; npm `active-win`/`get-windows` или свой helper). `settings.modes: [{match:{exe|title}, brain: off|prompt, replacements?:bool}]`. Применяется в `dictationBrain`. UI — один список в разделе Brain (не дублировать глобальные настройки, режим лишь переопределяет).
- Тесты: unit матчинга правил и выбора промпта; тест, что без правил поведение прежнее.

### 5. ⭐ DO NEXT — Команда над выделенным текстом («Чаво, переведи/сократи это») (M)
- Источник: [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (highlighted text is edited in place), [VoiceInk](https://github.com/Beingpax/VoiceInk).
- Зачем: естественное расширение «Чаво, …»-команд.
- Реализация: при нажатии hotkey — Ctrl+C с сохранением/восстановлением буфера (переиспользует п.1) → если выделение есть, передать в Brain как `context.selection`; результат заменяет выделение вставкой.
- Тесты: unit сборки промпта с selection; e2e-ручной в Notepad/Word.

### 6. ⭐ DO NEXT — Экспорт VTT/JSON/DOCX/MD + редактор транскрипта (S→M)
- Источник: [vibe](https://github.com/thewh1teagle/vibe), [Buzz](https://github.com/chidiwilliams/buzz).
- Зачем: сейчас txt/srt/timestamps; VTT нужен для веба, JSON — для интеграций, DOCX — для офисных пользователей.
- Реализация: расширить `src/core/transcriptFormat.ts` форматтерами `toVtt`, `toJson` (сегменты+слова), `toMarkdown`; DOCX через `docx` npm (лениво). Выбор форматов — тот же селектор, что сейчас для txt/srt.
- Тесты: снапшот-тесты форматтеров на фикстуре сегментов (экранирование, `HH:MM:SS.mmm` для VTT).

### 7. ⭐ DO NEXT — Индикатор уровня микрофона + звуковые сигналы + пауза медиа (S)
- Источник: [voxtype](https://github.com/peteonrails/voxtype) (waveform OSD, audio cues, MPRIS pause), [VoiceInk](https://github.com/Beingpax/VoiceInk).
- Зачем: пользователь видит, что микрофон пишет; сигнал старта важен для hold-hotkey.
- Реализация: RMS уже доступен в `mic-processor.js` → IPC в overlay (полоска/волна) и в иконку трея (3–4 состояния). Короткие WAV-сигналы в renderer (вкл/выкл одной галкой). Пауза медиа на Windows: `VK_MEDIA_PLAY_PAUSE` только если что-то играет (GSMTC через helper) — опционально, отдельный шаг.
- Тесты: unit расчёта уровня/троттлинга; `overlayModel.test.ts` — состояние уровня.

### 8. ⭐ DO NEXT — CLI для файловой транскрипции (S)
- Источник: [vibe](https://github.com/thewh1teagle/vibe) (`--help`), [Buzz](https://github.com/chidiwilliams/buzz), [voxtype](https://github.com/peteonrails/voxtype).
- Зачем: пакетная обработка, скрипты, CI-проверка качества распознавания.
- Реализация: `src/cli.ts` поверх `core/fileJob.ts` + `fileParallel.ts` (ядро уже без Electron): `chawo-va transcribe <files…> --format srt,txt --out dir --threads N`. Декодирование: ffmpeg при наличии, иначе ограничиться wav/ogg (встроенный декодер завязан на Chromium). `bin` в package.json.
- Тесты: vitest запускает CLI на фикстуре wav, сверяет выход; коды возврата при ошибках.

### 9. Голосовая пунктуация и числа (S)
- Источник: [voxtype](https://github.com/peteonrails/voxtype), [nerd-dictation](https://github.com/ideasman42/nerd-dictation).
- Реализация: правила в `wordReplace.ts`: «запятая»→«,», «новая строка»→`\n`, «точка»; числительные→цифры (ITN для русского, словарь + простой парсер). Вкл. одной настройкой в словаре.
- Тесты: таблица вход/выход.

### 10. Транскрипция системного звука / встреч (L)
- Источник: [OpenWhispr](https://github.com/OpenWhispr/openwhispr), [vibe](https://github.com/thewh1teagle/vibe), [voxtype](https://github.com/peteonrails/voxtype) meeting mode.
- Реализация: Electron `desktopCapturer` + `setDisplayMediaRequestHandler({audio:'loopback'})` на Windows; микс mic+loopback в renderer; запись в файл → существующая файловая очередь, либо чанки по VAD в реальном времени.
- Тесты: ручные (Zoom/YouTube); unit микшера.

### 11. Диаризация спикеров (L)
- Источник: [OpenWhispr](https://github.com/OpenWhispr/openwhispr), [vibe](https://github.com/thewh1teagle/vibe), [Buzz](https://github.com/chidiwilliams/buzz).
- Реализация: sherpa-onnx модели (pyannote segmentation ONNX + speaker embedding, напр. 3D-Speaker/WeSpeaker) через onnxruntime-node; кластеризация эмбеддингов; поле `speaker` в сегментах → «Спикер 1:» в txt/srt.
- Тесты: фикстура с 2 голосами; DER-грубая проверка.

### 12. Импорт по URL (YouTube и т.п.) (M)
- Источник: [vibe](https://github.com/thewh1teagle/vibe), [OpenWhispr](https://github.com/OpenWhispr/openwhispr).
- Реализация: опциональный yt-dlp (скачивается по запросу, как модели) → файл в очередь. Явное предупреждение о сети.

### 13. Выгрузка моделей при простое (S)
- Источник: [voxtype](https://github.com/peteonrails/voxtype).
- Реализация: таймер в `speech/` и local Brain: освобождать InferenceSession/llama-server через N минут; ленивый прогрев при hotkey.
- Тесты: unit таймера с fake timers.

### 14. Deep-link установки моделей `chawo://download?url=` (S)
- Источник: [vibe](https://github.com/thewh1teagle/vibe). `app.setAsDefaultProtocolClient`, подтверждение пользователем, проверка sha256.

### 15. Офлайн-перевод диктовки (M)
- Источник: [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (translation hotkey), [Speech Note](https://github.com/mkiol/dsnote).
- Реализация: проще всего — пресет команды Brain «Чаво, по-английски …» (без отдельной настройки/хоткея, чтобы не плодить UI).

### 16. Пользовательский скрипт пост-обработки (S)
- Источник: [nerd-dictation](https://github.com/ideasman42/nerd-dictation), [voxtype](https://github.com/peteonrails/voxtype) (pipe через shell).
- Реализация: путь к скрипту в расширенных настройках; stdin→stdout с таймаутом. Для продвинутых.
