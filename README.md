# Giga Pisar for Windows (zai-one fork)

Push-to-talk dictation for Windows 10/11. Speech stays on this computer.
This fork (`gpu-mimo-hermes`) changes three things relative to
[moznoazachem/giga-pisar-win](https://github.com/moznoazachem/giga-pisar-win) 1.0.7:

- a choice of GigaAM model and of CPU or the video card
- an optional Xiaomi MiMo brain (off until you turn it on)
- a localhost HTTP decoder for Hermes

The model is **not** downloaded on startup. Settings and the tray have a
**Download the selected model** button. Until you press it, the app does not
fetch weights.


## По-русски: что добавлено и зачем

Это форк обычного Гига Писаря для Windows (ветка `gpu-mimo-hermes`). Ниже не список галочек, а зачем каждая правка.

**Выбор модели и кнопка «Скачать».** В оригинале модель качается сама при первом запуске, и это одна русская GigaAM v3. Здесь две модели, и файл не уходит в сеть, пока вы сами не нажмёте кнопку. Большая — Multilingual Large CTC, около 600 миллионов параметров: это самая крупная модель Сбера, у которой есть готовый ONNX и которая умеет именно распознавать речь (русский, английский и ещё языки из её словаря). Ещё крупнее опубликован только энкодер `large_ssl`, им нельзя диктовать: у него нет головы распознавания. RNN-T на 600M в ONNX никто не выложил. Вторая модель — прежняя v3 e2e RNN-T: меньше, только русский, зато сама ставит точки и запятые. Кнопка нужна, чтобы свежая установка ничего не скачивала молча: веса большие (у большой модели около 2,4 ГБ), и вы сами решаете, когда и какую брать.

**Процессор или видеокарта.** Оригинал всегда считает на CPU. Здесь можно выбрать видеокарту. Это DirectML, а не отдельный CUDA: библиотека лежит рядом с программой и использует карту NVIDIA (в том числе RTX 3070), AMD или Intel без установки CUDA. Если карта не поднялась, распознавание само переходит на процессор и пишет об этом. Звук при этом всё равно остаётся на компьютере. fp32, а не int8, потому что целочисленную модель видеокарта часто не принимает.

**Мозг Xiaomi MiMo, Сингапур, выключен.** Мозг — это правка уже распознанного текста, не звука. Он по-прежнему выключен, пока вы сами не выберете сервис. Добавлен Xiaomi Token Plan Singapore: адрес `https://token-plan-sgp.xiaomimimo.com/v1`, модель `mimo-v2.6-flash`. Свой ключ вставляете вы, в репозитории ключа нет, на диске он лежит в DPAPI, как и остальные ключи. Уходит только текст. Так можно пользоваться своим тарифом MiMo и не платить за распознавание: звук считает локальная GigaAM.

**Hermes, HTTP-расшифровщик.** Писарь с самого запуска слушает только `127.0.0.1`, порт **17831**. Другая программа на этом же компьютере (Hermes) может прислать `POST /v1/transcribe` с файлом wav или ogg/opus и получить JSON с текстом. Звук никуда не загружается: его разбирает эта же программа. Порт по умолчанию не торчит в сеть, чтобы расшифровка не была доступна соседям по Wi‑Fi без вашего решения.

**Кнопка «Открыть порт в брандмауэре и слушать сеть».** Если этот ПК должен быть расшифровщиком для других машин, кнопка делает две вещи. Windows спрашивает права администратора и добавляет входящее правило брандмауэра на TCP **17831** (имя правила `Giga Pisar Hermes`), затем открывает консоль брандмауэра, чтобы правило было видно. После этого Писарь слушает **0.0.0.0:17831**, то есть все свои сетевые адреса, не только localhost. Другой компьютер в локальной сети шлёт тот же `POST http://<адрес-этого-ПК>:17831/v1/transcribe`. Это уже доступ к расшифровке из локальной сети: кто угодно в ней может прислать запись. В интернет программа запись не отправляет. Пока кнопку не нажали, снаружи порт закрыт. Кнопка «снова только этот компьютер» возвращает прослушивание на 127.0.0.1.

**Галочка «не давать компьютеру уснуть».** Пока Писарь слушает и галочка включена, вызывается `SetThreadExecutionState`: Windows не усыпляет ПК от простоя, иначе расшифровщик замолчит посреди очереди голосовых. Ручное выключение это не блокирует. Сняли галочку или закрыли программу (слушатель остановился) — запрет сна снимается.

Проверок обновлений с репозитория автора оригинала нет.

## Speech model

Two published Sber GigaAM graphs:

| Choice | What it is | Download |
| --- | --- | --- |
| **Multilingual Large CTC** (default) | Largest GigaAM **ASR** with a usable ONNX file: `multilingual_large_ctc`, about 600M parameters, fp32. Russian, English and the other languages in that vocabulary. No punctuation model. | about 2.4 GB from [istupakov/gigaam-multilingual-large-ctc-onnx](https://huggingface.co/istupakov/gigaam-multilingual-large-ctc-onnx) |
| **v3 e2e RNN-T** | Smaller Russian end-to-end model with punctuation (the original Pisar weights, int8). | about 220 MB |

Why not something larger: Sber's `multilingual_large` line is the 600M model.
`multilingual_large_ssl` is an encoder only, not a speech-to-text head, so it
cannot dictate. There is no published RNN-T ONNX for the 600M model. The fp32
CTC graph is the one a video card can run; the int8 copy of the same model is
smaller but a poor fit for DirectML, so this fork downloads fp32. Each file is
checked against a known SHA-256 before it is kept.

## CPU or video card

Settings → Dictation → **Where it runs**:

- **Video card (DirectML)** — ONNX Runtime's DirectML provider. On an NVIDIA
  card (including an RTX 3070) this is the GPU path. DirectML is what ships
  inside the app: it does not need a separate CUDA or cuDNN install. AMD and
  Intel DX12 GPUs can use the same switch.
- **Processor (CPU)** — never touches the GPU.

If you pick the video card and DirectML fails to start, recognition falls
back to the CPU and Settings says so. Audio is still not uploaded.

CUDA was not bundled. The CUDA build of ONNX Runtime replaces the DirectML
one and expects a CUDA 12 runtime on the machine. DirectML is the GPU path
that actually travels with the EXE.

## Brain (optional, off by default)

Same behaviour as upstream: the address word "Писарь" (or "edit on the fly")
sends **text**, never audio. The key is stored with Windows DPAPI and is not
written into the repo.

Services: DeepSeek, OpenRouter, OpenAI, Groq, Gemini, Anthropic, and
**Xiaomi MiMo**. Xiaomi is the Singapore Token Plan:

- base URL `https://token-plan-sgp.xiaomimimo.com/v1`
- chat completions `POST /v1/chat/completions`
- model `mimo-v2.6-flash`
- paste your own Token Plan key (`tp-…`). It is not included in the build.

The request sends `Authorization: Bearer` and the `api-key` header Xiaomi's
Token Plan examples use, and sets `thinking` to `disabled` so Flash does not
spend the answer on a reasoning trace. The brain stays **off** until you
select a service in Settings.

## Hermes

While Pisar is running it listens on `127.0.0.1:17831` only. Audio posted
there is decoded in this process and is not uploaded.

**Open the firewall port and listen on the network** (Settings → Dictation)
asks Windows (UAC) to allow inbound TCP **17831** (rule name `Giga Pisar Hermes`),
opens the firewall console, and rebinds to **0.0.0.0:17831**. Other machines
on the LAN can then `POST http://<this-pc>:17831/v1/transcribe`. That exposes
transcription to the local network. It stays off until you press the button.
**Listen on this PC only again** returns the bind to 127.0.0.1.

**Keep the PC awake while transcription is listening** calls
`SetThreadExecutionState` so Windows does not idle-sleep while the listener
is up. It does not block a manual shutdown. Clear the box or quit Pisar
(the listener stops) and sleep is allowed again.

`GET /v1/health`

```json
{"ok":true,"model_loaded":true,"model":"multilingual_large_ctc","device":"gpu","provider":"directml","port":17831}
```

`POST /v1/transcribe`

- `Content-Type: audio/wav`, `audio/ogg`, `audio/opus`, or `application/octet-stream`,
  with a `Content-Length` and the raw file as the body
- or `multipart/form-data` with one file part (a field named `file` or `audio` is fine;
  the first file part is used)
- WAV must be 16-bit PCM. Ogg/Opus (Telegram voice notes) is decoded to 16 kHz mono.

`200` response:

```json
{"text":"...","model":"multilingual_large_ctc","device":"gpu","provider":"directml","sample_rate":16000,"seconds":1.2}
```

`503` `{"error":"model_not_loaded"}` until you download a model.
`400` `{"error":"bad_audio","detail":"..."}` when the bytes are not wav or ogg/opus.

Until you press the LAN button, only programs on this PC can call it.
After that, anyone on the local network can.

## What the app does on your machine

- Installs a global low-level keyboard hook to see the dictation key before
  other apps do. It compares every key event with the configured key and
  swallows only that key; nothing is stored or logged.
- Captures the default microphone only while the key is held.
- Holds the recognition weights under `%LOCALAPPDATA%\GigaPisar\models\`.
  The download runs only after you press the button.
- Keeps settings in `%APPDATA%\GigaPisar\settings.json` and a small log
  (take lengths, levels, errors; never text or audio) in
  `%LOCALAPPDATA%\GigaPisar\pisar.log`.
  A Brain API key is stored there encrypted with Windows DPAPI for the current user.
- Optionally keeps the last take as `last.wav` in the same folder for
  troubleshooting (off by default; deleted when the option is turned off).
- Does **not** check `moznoazachem/giga-pisar-win` (or anywhere else) for updates.

## Layout

- `src/Core`: recognition engine: log-mel features, ONNX Runtime sessions
  (DirectML or CPU), CTC greedy decoding for the large multilingual model,
  RNN-T decoding for v3. Ogg/Opus decoding for Hermes.
- `src/App`: tray application (WPF + WinForms tray icon): microphone capture,
  keyboard hook on its own message-loop thread, text insertion, overlay,
  settings, model download.
- `installer/setup.iss`: Inno Setup script (Russian and English wizard).
- `tools/make_icon.py`: builds `app.ico` from the macOS iconset.
- `build.sh`: cross-build from macOS over SSH to a Windows machine
  (settings in an untracked `build.local`, see the script header).

## Build

Release installers are built by GitHub Actions on GitHub's Windows runners,
from this repository only: see [`.github/workflows/build.yml`](.github/workflows/build.yml)
and the build logs under Actions. Every build prints the installer's SHA-256.

To build locally you need the .NET 10 SDK and Inno Setup 6 on Windows.

```
cd src
dotnet publish -c Release -o ..\dist\app
cd ..\installer
ISCC.exe setup.iss
```

Headless check of the engine against a WAV file:

```
set PISAR_MODEL=large
set PISAR_DEVICE=gpu
set PISAR_MODEL_DIR=C:\path\to\model
GigaPisar.exe --transcribe input.wav result.txt
```

`PISAR_MODEL=v3` selects the RNN-T weights. `PISAR_DEVICE=cpu` forces the CPU.
`PISAR_MODEL_DIR` is honoured by this headless mode only; the tray app uses
`%LOCALAPPDATA%\GigaPisar\models\<model>`.

## Code signing policy

Release installers are to be signed through SignPath Foundation (application
in progress; this section will name the certificate once signing is active).

- Only installers built by the GitHub Actions workflow above, from a tagged
  commit of this repository, are submitted for signing; nothing built on a
  personal machine is signed.
- Every signing request is approved by hand before the signed installer is
  published.

Team roles:

- Authors, committers and reviewers: [@moznoazachem](https://github.com/moznoazachem).
  Changes from anyone else come as pull requests and are reviewed before merge.
- Approver of releases: [@moznoazachem](https://github.com/moznoazachem).

All team members use multi-factor authentication on GitHub.

## Privacy

This fork collects no telemetry. It does not check for updates. Speech is
recognized on your computer; audio never leaves it, including audio posted to
the Hermes port. That port is `127.0.0.1` until you open it for the LAN
(`0.0.0.0:17831`).

Network traffic happens only when you ask for it:

- you press **Download the selected model** (Hugging Face for the large CTC
  weights, or the original giga-pisar-cli release for v3);
- you turn the Brain on and choose a cloud service. Then the recognized text
  (or the selected text, for a command on a selection) goes to that service.
  Xiaomi's Singapore Token Plan is `token-plan-sgp.xiaomimimo.com`. The Brain
  is off by default. No API key is in the source tree.

Settings and the log stay in your user profile and are removed by the
uninstaller.

## License

MIT.
