# Chawo Voice Assistant

Local voice assistant for Windows: dictation, file transcription, an optional Brain, and a sales trial card.
Speech stays on this computer by default. Executable `ChawoVoiceAssistant.exe`; releases ship an installer and a portable zip. The short form **Chawo VA** is used only where space is tight (tray tooltip with a status).

**Current shipping app is 2.0** (Electron + TypeScript in `ts/`). Legacy WPF sources remain in `src/` for reference; they are not the product you install.

This repository is a standalone public copy of work that began as a fork of
[moznoazachem/giga-pisar-win](https://github.com/moznoazachem/giga-pisar-win)
(upstream tip used: 1.0.7). Upstream license: **MIT** (see `LICENSE`). Copyright (c) 2026 giga-pisar contributors; original authors [@moznoazachem](https://github.com/moznoazachem). GigaAM model weights remain under their own MIT notice in that file.

Brand colors, mark and icon come from [chawo.ai](https://chawo.ai) (`/icon.svg` and site CSS). The site font **DIN Pro** is not bundled; the UI uses **Arial** then Segoe UI.

On startup the settings window opens. Models are **not** downloaded on startup.
Closing the window hides it; the app stays in the tray until **Quit**.
**Check for updates** asks only
`https://api.github.com/repos/zai-one/chawo-va/releases/latest` and does not download the archive.


## Установка (2.0)

С [релизов GitHub](https://github.com/zai-one/chawo-va/releases/tag/v2.0.0):

- **Установщик** — `ChawoVoiceAssistant-2.0.0-Setup.exe` (на пользователя, папку можно сменить; удаление не трогает настройки и модели).
- **Портативный zip** — `ChawoVoiceAssistant-2.0.0-win-x64.zip` (распаковать и запустить `ChawoVoiceAssistant.exe`).

В обоих пакетах рядом с программой лежит **`chawo-va.cmd`** — тот же CLI без отдельного Node. Веса речи и Мозга в архив не входят: приложение скачивает их при первом использовании.

```
chawo-va --version
chawo-va transcribe talk.m4a -f txt,srt
chawo-va history
chawo-va brain note.txt
```

Проверка обновлений — кнопка **«Проверить обновления»** на странице «Диктовка»: только этот репозиторий, архив сам не скачивается. При наличии новой версии предлагается открыть страницу релиза в браузере.


## По-русски: что умеет 2.0

- **Диктовка** — удержание клавиши (Windows: ChawoNative) или кнопки в окне; плашка с волной и черновиком; звуковые сигналы; слово-активатор «Чаво»; вставка с клавиатуры или через буфер.
- **Расшифровка файла** — очередь файлов и папок, перетаскивание, метки времени, `.srt` / `.vtt` / `.json` / `.md` / `.docx`, параллель для длинных записей, опционально Мозг и «Кратко и задачи», перевод, диаризация спикеров, VAD (обрезка тишины), ссылки через yt-dlp, редактор транскрипта с проигрыванием по фразе.
- **Мозг** — локальный (llama.cpp / GGUF) или облачный провайдер; инструкция; правила «для отдельных программ»; «Свой скрипт» пост-обработки.
- **Словарь** — замены «как слышно → как писать»; голосовая пунктуация и числа словами.
- **Сеть (Hermes)** — этот ПК хост или клиент; приём звука с других машин; брандмауэр Windows.
- **Продажи** — местный каталог, папка материалов, стенд звонка и карточка поверх окон.
- **История** — поиск по диктовкам, копирование, «Мозг заново».
- **Запись встречи** — микрофон + звук компьютера (Windows/Linux loopback).
- **Приватность** — тёмная тема только, без телеметрии, ключи не в репозитории, локально по умолчанию (рендерер без сети). ORT не пишет device id.

План будущего Linux-сервера расшифровки (только план): [`docs/linux-server.md`](docs/linux-server.md).


## Speech model

Two published Sber GigaAM graphs (downloaded on demand, not in the zip):

| Choice | What it is | Download |
| --- | --- | --- |
| **v3 e2e RNN-T** (default) | Smaller Russian end-to-end model with punctuation (int8). | about 220 MB |
| **Multilingual Large CTC** | Larger ASR ONNX (`multilingual_large_ctc`, ~600M, fp32). Russian, English and other languages in that vocabulary. No punctuation model. | about 2.4 GB |

Device: CPU or GPU (DirectML on Windows). CPU thread count is configurable. Audio is not uploaded unless you choose a cloud Brain or Client role.


## Brain (optional, off by default)

Local GGUF via `llama-server`, or a cloud provider (DeepSeek, OpenRouter, OpenAI, Groq, Gemini, Anthropic, Xiaomi MiMo, custom URL). Keys use OS secret storage when available and are never committed. Empty instruction = drop filler without shortening; a custom instruction overrides that.


## Hermes (network)

**Host** — this PC recognizes and can accept connections on port 17831 (localhost until you open the firewall). **Client** — audio goes to another PC; no local speech model. A stdlib Telegram bot under `tools/hermes-telegram-bot` can forward voice notes to the same `/v1/transcribe` endpoint.


## What the app does on your machine

- Writes settings under `%APPDATA%\ChawoVoiceAssistant` and models/logs under `%LOCALAPPDATA%\ChawoVoiceAssistant` (overridable with `CHAWO_APPDATA` / `CHAWO_LOCALAPPDATA` / `CHAWO_MODEL_DIR`).
- Keeps speech and Brain weights out of the installer; downloads only when you ask.
- Does **not** check the upstream repository for updates. A manual **Check for updates** button asks GitHub for the latest release of `zai-one/chawo-va` only, shows the page URL, and does not download it. There is no timer.


## Layout

```
ts/                 Electron + TypeScript app (shipping 2.0)
src/                Legacy WPF/.NET sources (1.x; not the installer)
docs/               Plans and design notes
tools/              Helpers (Telegram bot, icons, …)
.github/workflows/  CI: Windows package, e2e smoke, legacy WPF builds
```


## Build

```
cd ts
npm ci
npm test
npm start          # build + run Electron
npm run dist:win   # Setup.exe + portable zip (Windows CI / Windows host)
```

GitHub Actions: `.github/workflows/ts-windows.yml` builds on `main`, `ts-port`, `ts/**` and on `v*` tags; tag builds attach Setup.exe and the portable zip to the GitHub Release. No model weights in the artifacts. Unsigned.


## Code signing policy

Builds are unsigned. Windows SmartScreen may warn on first run; that is expected until a certificate is configured.


## Privacy

- Dark theme only (no light theme).
- No telemetry.
- No API keys in the repository.
- Local by default: the sandboxed renderer cannot reach the network; network features go through the main process when you enable them.
- Update check talks only to `api.github.com` for this repository and does not download the installer.


## License

MIT.


## Attribution

Based on [moznoazachem/giga-pisar-win](https://github.com/moznoazachem/giga-pisar-win), MIT License.
Copyright (c) 2026 giga-pisar contributors. Original work by [@moznoazachem](https://github.com/moznoazachem).
