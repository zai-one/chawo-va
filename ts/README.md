# Chawo Voice Assistant — TypeScript port

Electron + TypeScript port of the WPF app in `../src`. The WPF app stays the shipping
version until this one reaches parity; nothing here touches it.

```
ts/
  src/core/      platform-neutral logic (no Electron, no Windows APIs) — reused by a future CLI/server
  src/main/      Electron main process and preload bridge
  src/renderer/  dark-only UI (sandboxed, strict CSP, no network)
  native/win/    ChawoNative.exe: Windows hold key + inserting text (.NET Framework 4.8, built into Windows)
  test/          vitest unit tests; fixtures/ holds independent numpy references
```

```
npm install          # ELECTRON_SKIP_BINARY_DOWNLOAD=1 on headless CI
npm test
npm start            # build + run Electron
npm run build:native # Windows helper; needs the .NET SDK (any OS), output is copied into dist/native
```

Without `ChawoNative.exe` the app still runs on Windows; only the global hold key and inserting
into other apps are off (the page says so). `scripts/smoke-native-wine.cjs` runs the helper under
Wine + Xvfb on Linux against a test window (`native/win/test/InsertTarget`).

## Windows build

`.github/workflows/ts-windows.yml` (GitHub Actions, `windows-latest`) builds the helper, runs
`npm run dist:win` (electron-builder) and uploads two artifacts: `ChawoVoiceAssistant-<version>-Setup.exe`
(per-user installer, the folder can be changed, uninstall keeps settings and models) and a portable
`ChawoVoiceAssistant-<version>-win-x64.zip`. Both carry `chawo-va.cmd` next to the exe: the same CLI,
run by the app's own runtime (`ELECTRON_RUN_AS_NODE`), so `chawo-va.cmd transcribe talk.m4a` works
without Node. No model weights are packaged (the app downloads them); the build is unsigned. The
workflow smoke-tests the package: no weights, CLI `--version` / `segments`, native modules load, the
window starts with `ChawoNative.exe`. `npm run dist:dir` makes an unpacked build for the current OS.

## End-to-end smoke

`npm run e2e` builds and runs `scripts/e2e-smoke.cjs`: every `chawo-va` command (help, errors and exit
codes, `transcribe` with all formats / `--stdout` / `--skip-existing` / folders / `--post-script` /
`--brain --brief` / links, `segments`, `history`, `brain`, `brief`, `translate`) and the GUI (under
xvfb on Linux: every page renders, dark theme, every page state, history search, transcript editor,
brief and translation, a real file in the queue, clean quit). It runs in a temp profile with a fake
Brain on 127.0.0.1 and checks that no onnxruntime device id is written and settings.json is never
rewritten by the CLI. Real transcription needs `CHAWO_SMOKE_MODEL_DIR=<GigaAM v3 folder>` (else the
app's own download) and `CHAWO_SMOKE_AUDIO=<Russian recording>`; without a model those cases are skipped.
`--no-gui`, `--no-cli`, `--shots <dir>`, `--keep`, `--verbose`. CI: `.github/workflows/ts-e2e.yml`.

## Command line

File transcription without the window, same model and parallel plan as the app:

```
npm run build
node dist/cli.js transcribe talk.m4a ./recordings -f txt,srt -o ./out    # or `chawo-va` after npm link
node dist/cli.js transcribe call.wav --stdout --no-timestamps -q | less
node dist/cli.js --help
```

Local only: settings.json is read (model, device, parallelism, timestamps, language) and never
written, the model is never downloaded (use the app or `--model-dir`), WAV/Ogg-Opus are decoded
natively and everything else through ffmpeg on PATH. Exit codes: 0 done, 1 some files failed,
2 bad arguments, 3 no model, 130 Ctrl+C.

Rules carried over from the WPF app: dark theme only, no telemetry, no keys in the repo,
local by default (the renderer cannot reach the network), short menus.
Progress and the module map live in [PORTING.md](PORTING.md).
