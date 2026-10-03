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

## Hermes (localhost decoder)

While Pisar is running it listens only on `127.0.0.1:17831`. Nothing is bound
to a LAN address. The body is decoded in this process and is not uploaded.

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

Any program on this PC can call it. It is not exposed off the machine.

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
the Hermes port (that port is `127.0.0.1` only).

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
