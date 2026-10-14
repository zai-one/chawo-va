# Справочник CLI — `chawo-va`

Командная строка того же приложения: на Windows — `chawo-va.cmd` рядом с `ChawoVoiceAssistant.exe`
(свой Node не нужен), из исходников — `node ts/dist/cli.js` после `npm run build`. Настройки читаются
из `settings.json` приложения (только чтение); всё, что не задано флагом, берётся оттуда.
Модели CLI **не скачивает** — сначала скачайте их в приложении (или укажите `--model-dir`).

## Команды

| Команда | Что делает | Пишет |
|---------|-----------|-------|
| `transcribe <файлы/папки/ссылки…>` | Расшифровка локально или на сервере (`--server`) | `.txt` + выбранные `-f` |
| `brain <расшифровки.txt…>` | «Прогнать через мозг» | `.brain.txt` |
| `brief <расшифровки.txt…>` | «Кратко и задачи» | `.brief.txt` |
| `translate <тексты.txt…> [--to язык]` | Перевод через Мозг | `.translate.txt` |
| `history [слова…]` | История диктовки, новые сверху (только чтение) | stdout |
| `segments <.txt/.srt/.json…>` | Фразы со временем из готовой расшифровки | stdout |
| `snippets list\|add\|remove` | Сниппеты для «вставь …» при диктовке (тот же `snippets.json`, что на «Словаре») | stdout / `snippets.json` |
| `dictionary list\|suggest\|accept\|dismiss\|learn\|auto` | Словарь замен и «Из исправлений» (тот же `learned-words.json`, что на «Словаре») | stdout / `learned-words.json` |
| `serve` | Headless CPU-сервер расшифровки ([linux-server.md](linux-server.md)) | — |
| `--help`, `--version` | Справка / версия (`chawo-va 2.0.0`) | stdout |

## Флаги

### Общие

| Флаг | Значение |
|------|----------|
| `--lang ru\|en` | Язык сообщений (можно и перед командой: `chawo-va --lang en …`) |
| `-q`, `--quiet` | Без прогресса и итоговых строк |
| `-h`, `--help` / `-v`, `--version` | Справка / версия |

### `transcribe`

| Флаг | Значение |
|------|----------|
| `-f`, `--format txt,srt,vtt,json,md,docx` | Какие файлы писать (по умолчанию `txt`), через запятую |
| `-o`, `--out <папка>` | Куда писать (по умолчанию рядом с исходным) |
| `-t`, `--timestamps` / `--no-timestamps` | Метки `[чч:мм:сс]` в `.txt` |
| `--stdout` | Текст в stdout вместо файлов (только с `txt`) |
| `--skip-existing` | Пропускать файлы, у которых уже есть `.txt` |
| `--model v3\|ctc` | Модель распознавания |
| `--device cpu\|gpu` | Устройство |
| `-j`, `--threads auto\|1\|2\|4\|max` | Параллельность длинных записей |
| `--script auto\|ru\|en` | Алфавит для модели `ctc` |
| `--model-dir <папка>` | Папка с моделью |
| `--post-script «команда»` / `--no-post-script` | Свой скрипт пост-обработки `.txt` |
| `--vad` / `--no-vad` | Резать по паузам Silero VAD / по громкости |
| `--diarize` / `--no-diarize` | Разделять спикеров |
| `--brain` / `--no-brain` | Ещё и `.brain.txt` |
| `--brief` / `--no-brief` | Ещё и `.brief.txt` (`--instruction` — свой формат) |
| `--server <URL>` | Расшифровать на удалённом `chawo-va serve` (job API, без локальной модели) |
| `--token <секрет>` | Bearer для `--server` (или `CHAWO_SERVE_TOKEN`) |

**С `--server`:** файл отправляется в `POST /v1/jobs`, клиент опрашивает `GET /v1/jobs/{id}`.
Сервер возвращает фразы с метками времени (`segments`), поэтому `-f srt,vtt,json,md,docx` и
`--timestamps` дают те же файлы, что и локальный запуск. Если сервер старый и фраз не вернул,
пишется только `.txt` с пометкой. Ссылки с `--server` не принимаются (скачайте файл заранее);
`--brain/--brief/--diarize/--post-script` в этом режиме не выполняются.

### `brain`

`-t`/`--no-timestamps` (по умолчанию — как в исходном `.txt`), `--stdout`, `-o/--out`, `--lang`, `-q`.

### `brief`

`--template <имя>`, `--instruction «…»`, `--stdout`, `-o/--out`, `--lang`, `-q`.

Шаблоны «Кратко и задачи» (те же, что на странице «Расшифровка файла»):

| `--template` | Синонимы | Что получится |
|---|---|---|
| `standard` | `default`, `кратко` | Кратко + Задачи (как раньше) |
| `sales-call` | `sales`, `call`, `продажи`, `звонок` | Разбор звонка продаж: потребность, бюджет, ЛПР, возражения, следующий шаг |
| `minutes` | `protocol`, `протокол` | Протокол встречи: повестка, решения, поручения «кто — что — срок» |
| `summary` | `резюме` | Краткое резюме: суть + 3–5 пунктов |
| имя своего шаблона | — | свой шаблон из `brief-templates.json` (регистр и «ё» не важны) |

`chawo-va brief --template list` печатает все шаблоны. Без `--template` берётся шаблон, выбранный в
приложении; `--template` и `--instruction` вместе нельзя; неизвестное имя → код 2 и список имён.
`transcribe --brief --template sales-call` тоже работает.

### `translate`

`--to <язык>` (`en`, `ru`, `de`, … или название — «немецкий»; без `--to` — из настроек, иначе
русский → английский, остальное → русский), `--stdout`, `-o/--out`, `--lang`, `-q`.

### `segments`

`--json` (JSON Lines: `start`, `end`, `text`, `speaker?`), `-q`.

### `snippets`

- `snippets list [--json]` — показать: `фраза<TAB>текст` (переводы строк как `\n`) или JSON `[{trigger, text}]`.
- `snippets add <фраза> <текст…>` — добавить или заменить (та же фраза без учёта регистра/«ё»). Текст `-` —
  читать из stdin, так удобно для многострочной подписи: `chawo-va snippets add подпись - < sign.txt`.
- `snippets remove <фраза>` — удалить; нет такой — код 1.

Работает, даже когда приложение открыто: страница «Словарь» подхватит изменения при следующем показе,
диктовка — на следующей фразе.

### `dictionary`

Словарь замен со страницы «Словарь» и предложения «Из исправлений».

- `dictionary list [--json]` — правила в силе: `как слышно<TAB>как писать` (JSON `[{from, to}]`).
- `dictionary learn <было.txt> <стало.txt> [--json]` — сравнить текст до и после ваших правок (например,
  расшифровку и её исправленную копию) и запомнить заменённые слова. Печатает найденные правки;
  `--json` — `{fixes, added, suggested}`. Та же логика, что у «История» → «Исправить».
- `dictionary suggest [--json]` — правки, встреченные 2+ раза и ещё не в словаре:
  `как слышно<TAB>как писать<TAB>сколько` (JSON `[{from, to, count}]`).
- `dictionary accept <как слышно> [как писать]` — в словарь; без второго слова берётся из предложения.
  Строка с тем же «как слышно» заменяется. Нет предложения и не указано «как писать» — код 1.
- `dictionary dismiss <как слышно>` — скрыть предложение; нет такого — код 1.
- `dictionary auto on|off` — «Добавлять в словарь сами» (по умолчанию off).

`settings.json` CLI не переписывает: принятые строки ставятся в очередь в `learned-words.json`, а
приложение переносит их в «Словарь» само — при следующей фразе диктовки или открытии страницы.
`dictionary list` уже показывает их. Пример:

```
chawo-va dictionary learn meeting.txt meeting.fixed.txt
chawo-va dictionary suggest
chawo-va dictionary accept гигачад
```

### `history`

`слова…` (поиск, ё = е), `-n/--limit <N|all>` (по умолчанию 20), `--json` (JSON Lines: `id, ts,
seconds, final, raw, command, brain, brainFailed`), `--raw`, `-q`.

### `serve`

| Флаг | Значение |
|------|----------|
| `--host <адрес>` | `127.0.0.1` без токена; с токеном по умолчанию `0.0.0.0` |
| `--port <N>` | Порт, по умолчанию 17831 |
| `--token <секрет>` | Обязателен для не-localhost (или `CHAWO_SERVE_TOKEN`) |
| `--data-dir <папка>` | Задания (TTL 2 ч); иначе `CHAWO_SERVE_DATA_DIR`, `$XDG_DATA_HOME/chawo-serve`, `~/.local/share/chawo-serve` |
| `--model`, `--model-dir`, `-j/--threads`, `--script` | Как у `transcribe`; устройство всегда CPU |

`serve` не принимает `--format/--out/--stdout/--timestamps/--skip-existing` (код 2).

## Коды выхода

| Код | Смысл |
|-----|-------|
| 0 | Всё готово |
| 1 | Часть файлов не удалась |
| 2 | Ошибка параметров |
| 3 | Нет модели / Мозга / yt-dlp |
| 130 | Прервано (Ctrl+C) |

## Переменные окружения

`CHAWO_APPDATA`, `CHAWO_LOCALAPPDATA`, `CHAWO_MODEL_DIR` — где настройки и модели;
`CHAWO_SERVE_TOKEN`, `CHAWO_SERVE_DATA_DIR` — для `serve` и `--server`.

## Примеры

```bash
chawo-va transcribe talk.m4a -f txt,srt
chawo-va transcribe ./recordings -o ./out -f txt,docx --skip-existing
chawo-va transcribe "https://www.youtube.com/watch?v=…" -f srt
chawo-va transcribe long.wav --server http://host:17831 --token "$CHAWO_SERVE_TOKEN" -f srt,vtt,json,md,docx
chawo-va brain talk.txt && chawo-va brief talk.txt
chawo-va translate talk.txt --to de --stdout
chawo-va segments talk.srt --json
chawo-va history счёт -n all
```

## Полный вывод `chawo-va --lang ru --help` (v2.0.0)

```
Chawo Voice Assistant — расшифровка файлов, «Кратко и задачи», перевод и история диктовки из командной строки. Всё локально, ничего не отправляется (по ссылке — только скачивание).

Использование:
  chawo-va transcribe <файлы, папки или ссылки…> [параметры]
  chawo-va brain <расшифровки.txt…> [параметры]
  chawo-va brief <расшифровки.txt…> [параметры]
  chawo-va translate <тексты.txt…> [--to язык] [параметры]
  chawo-va history [слова для поиска…] [-n 20|all] [--json] [--raw]
  chawo-va segments <файлы.txt|.srt|.json…> [--json]
  chawo-va snippets list [--json] | add <фраза> <текст|-> | remove <фраза>
  chawo-va dictionary list|suggest [--json] | accept <как слышно> [как писать] | dismiss <как слышно>
  chawo-va dictionary learn <было.txt> <стало.txt> [--json] | auto on|off
  chawo-va serve [--host 127.0.0.1|0.0.0.0] [--port 17831] [--token …] [--data-dir …]

Параметры:
  -f, --format txt,srt,vtt,json,md,docx
                         какие файлы писать (по умолчанию txt), можно несколько через запятую
  -o, --out <папка>      куда писать (по умолчанию рядом с исходным файлом)
  -t, --timestamps       [чч:мм:сс] в начале строк txt; --no-timestamps — без них
      --stdout           печатать текст в stdout вместо файлов
      --skip-existing    пропускать файлы, у которых уже есть .txt
      --model v3|ctc     модель распознавания
      --device cpu|gpu   устройство
  -j, --threads auto|1|2|4|max   параллельность длинных записей
      --script auto|ru|en        алфавит для модели ctc
      --model-dir <папка>        папка с моделью (иначе — где её скачало приложение)
      --post-script «команда»  свой скрипт: текст на stdin, что напечатает — в .txt / stdout
                         (иначе — из настроек, если там включено «и для файлов»);
      --no-post-script   без скрипта
      --vad / --no-vad   резать длинные записи по паузам Silero VAD (если модель VAD скачана
                         в приложении) или по громкости; по умолчанию — из настроек
      --diarize / --no-diarize
                         разделять спикеров («Спикер 1: …» в txt/srt/…); по умолчанию — из
                         настроек «Разделять спикеров». Модели спикеров (~47 МБ) скачиваются
                         в приложении; без них — расшифровка без спикеров, с пометкой
      --brain / --no-brain
                         ещё и «Прогнать через мозг» → .brain.txt (убрать слова-паразиты +
                         «Кратко»); по умолчанию — из настроек
      --brief / --no-brief
                         ещё и «Кратко и задачи» → .brief.txt (--template / --instruction — формат);
                         по умолчанию — из настроек. Сбой Мозга — пометка, .txt всё равно пишется
      --server <URL>     расшифровать на удалённом 'chawo-va serve' (job API; локальной модели нет)
      --token <секрет>   Bearer для --server / для serve (или CHAWO_SERVE_TOKEN)
      --lang ru|en       язык сообщений
  -q, --quiet            без прогресса
  -h, --help / -v, --version

Параметры serve (headless CPU-сервер, без GUI):
      --host <адрес>     127.0.0.1 без токена; с --token можно 0.0.0.0
      --port <N>         порт (по умолчанию 17831)
      --token <секрет>   обязателен, чтобы слушать не-localhost (или CHAWO_SERVE_TOKEN)
      --data-dir <папка> задания и txt (TTL 2 ч); иначе ~/.local/share/chawo-serve или /tmp/chawo-serve
      --model / --model-dir / -j --threads / --script — как у transcribe; устройство всегда CPU

Параметры brain (то же, что «Прогнать через мозг» на странице):
  -t / --no-timestamps   [чч:мм:сс] в .brain.txt (по умолчанию — как в исходном .txt)
      --stdout           печатать в stdout вместо .brain.txt
  -o, --out <папка>      куда писать .brain.txt
      --lang ru|en       язык сообщений
  -q, --quiet

Параметры brief:
      --template <имя>   шаблон: standard, sales-call (разбор звонка продаж), minutes (протокол встречи),
                         summary (краткое резюме) или имя своего шаблона; --template list — показать все
      --instruction «…»  своя инструкция формата (иначе — шаблон из настроек / встроенная)
      --stdout           печатать карточку в stdout вместо .brief.txt
  -o, --out <папка>      куда писать .brief.txt
      --lang ru|en       язык сообщений
  -q, --quiet

Параметры translate:
      --to <язык>        на какой язык: en, ru, de, fr, es, zh, … или название
                         («английский», «немецкий», «суахили»). Без --to — из настроек,
                         иначе авто: русский текст → английский, остальной → русский
      --stdout           печатать перевод в stdout вместо .translate.txt
  -o, --out <папка>      куда писать .translate.txt
      --lang ru|en       язык сообщений (не язык перевода)
  -q, --quiet

Параметры segments (фразы со временем из готовой расшифровки, только чтение):
  файлы…             .txt (с метками или рядом .srt/.json), .srt или .json
      --json             JSON: start, end, text, speaker?
  -q, --quiet            без строки «N фраз»

Параметры snippets (сниппеты для «вставь <фраза>» при диктовке, тот же snippets.json, что на странице «Словарь»):
      list [--json]      показать (JSON: [{trigger, text}])
      add <фраза> <текст> добавить или заменить; текст «-» — читать из stdin (несколько строк)
      remove <фраза>     удалить

Параметры dictionary (словарь замен «Словаря» и «Из исправлений», learned-words.json; settings.json
только читается — принятые строки приложение перенесёт в «Словарь» само):
      list [--json]      правила: как слышно<TAB>как писать
      suggest [--json]   исправления, повторённые 2+ раза: как слышно<TAB>как писать<TAB>сколько
      accept <как слышно> [как писать]  в словарь (без «как писать» — из предложения)
      dismiss <как слышно>              больше не предлагать
      learn <было.txt> <стало.txt>      запомнить ваши правки слов (--json: fixes, added, suggested)
      auto on|off        добавлять повторённые исправления в словарь сами (по умолчанию off)

Параметры history (история диктовки, только чтение, новые сверху):
      слова…             поиск: каждое слово должно встретиться (ё = е), как на странице
  -n, --limit <N|all>    сколько записей (по умолчанию 20)
      --json             JSON Lines: id, ts, seconds, final, raw, command, brain, brainFailed
      --raw              ещё и текст до Мозга, если он отличается
  -q, --quiet            без строки «Найдено …»

Чего нет в параметрах, берётся из настроек приложения (settings.json, только чтение).
Модели не скачиваются (речь, VAD, спикеры): сначала скачайте их в приложении.
WAV и Ogg/Opus читаются сами, остальные форматы (MP3, M4A, FLAC, …) — через ffmpeg.
Папки — без подпапок, как в приложении.
Ссылки http(s)://… (YouTube и другие сайты) скачиваются через yt-dlp, как «По ссылке» в приложении:
звук — в «Загрузки/Chawo» (или в -o), дальше обычная локальная расшифровка. Через сеть идёт только
скачивание. yt-dlp CLI не скачивает: кнопка «Скачать yt-dlp» в приложении или yt-dlp в PATH.
brain читает готовый .txt и пишет .brain.txt: абзацы без слов-паразитов и «Кратко».
brief читает готовый .txt (рядом с записью или .brain.txt) и пишет .brief.txt через Мозг.
translate переводит готовый .txt через Мозг (локальный по умолчанию) и пишет .translate.txt.
segments печатает фразы со временем (как карточка «Расшифровка»): .srt → .json → метки в .txt.

Коды выхода: 0 — всё готово, 1 — часть файлов не удалась, 2 — ошибка параметров,
3 — нет модели / Мозга / yt-dlp, 130 — прервано (Ctrl+C).
```
