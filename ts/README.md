# Chawo Voice Assistant — TypeScript / Electron (shipping 2.0)

This folder is the **shipping app** from v2.0.0. Installers and the portable zip come from
[GitHub Releases](https://github.com/zai-one/chawo-va/releases); see the [root README](../README.md).
Legacy WPF sources stay in `../src` for reference and are not what the release packages.

```
ts/
  src/core/      platform-neutral logic (no Electron) — reused by the CLI
  src/main/      Electron main process and preload bridge
  src/renderer/  dark-only UI (sandboxed, strict CSP, no network)
  native/win/    ChawoNative.exe: Windows hold key + inserting text (.NET Framework 4.8)
  test/          vitest unit tests; fixtures/
```

```
npm install          # ELECTRON_SKIP_BINARY_DOWNLOAD=1 on headless CI
npm test
npm start            # build + run Electron
npm run build:native # Windows helper; needs the .NET SDK (any OS)
npm run dist:win     # Setup.exe + portable zip (Windows)
```

Without `ChawoNative.exe` the app still runs on Windows; only the global hold key and inserting
into other apps are off (the page says so).

## Windows build

`.github/workflows/ts-windows.yml` builds the helper, runs `npm run dist:win` and uploads
`ChawoVoiceAssistant-<version>-Setup.exe` and `ChawoVoiceAssistant-<version>-win-x64.zip`.
On a `v*` tag the same files are attached to the GitHub Release. Both carry `chawo-va.cmd`.
No model weights are packaged. The workflow smoke-tests the package (no weights, CLI, native
modules, window + ChawoNative).

## End-to-end smoke

`npm run e2e` — see scripts and `.github/workflows/ts-e2e.yml`.

## Command line

```
npm run build
node dist/cli.js transcribe talk.m4a ./recordings -f txt,srt -o ./out
# or chawo-va.cmd next to the installed / portable exe
```

Rules: dark theme only, no telemetry, no keys in the repo, local by default, short menus.
Progress and the module map: [PORTING.md](PORTING.md).
