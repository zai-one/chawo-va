# @chawo/desktop — Chawo Voice Assistant (Electron)

The shipping app from v2.0.0. Installers and the portable zip come from
[GitHub Releases](https://github.com/zai-one/chawo-va/releases); see the [root README](../../README.md)
and the [developer guide](../../docs/developer-guide.md).

```
src/main/       Electron main process: windows, tray, IPC handlers (logic lives in @chawo/engine)
src/preload/    sandboxed preload bridges (main window, overlay pill, sales card, audio decoder)
src/renderer/   dark-only UI (sandboxed, strict CSP, no network); public/ holds the AudioWorklets
resources/      icons packed into the app
native/win/     ChawoNative.exe: Windows hold key + inserting text (.NET Framework 4.8)
packaging/win/  chawo-va.cmd — the CLI next to the installed exe
scripts/        e2e and smoke scripts against the built app (out/)
test/           vitest tests of this package
```

From the repository root:

```
pnpm install
pnpm dev             # hot reload of the UI
pnpm start           # build + run
pnpm e2e             # build + scripts/e2e-smoke.cjs (xvfb on Linux)
pnpm dist:win        # Setup.exe + portable zip (Windows)
```

Without `ChawoNative.exe` the app still runs on Windows; only the global hold key and inserting
into other apps are off (the page says so). Build it with `pnpm --filter @chawo/desktop build:native`
(needs the .NET SDK).

## Windows build

`.github/workflows/ts-windows.yml` builds the helper, runs `pnpm dist:win` and uploads
`ChawoVoiceAssistant-<version>-Setup.exe` and `ChawoVoiceAssistant-<version>-win-x64.zip`.
On a `v*` tag the same files are attached to the GitHub Release. Both carry `chawo-va.cmd`.
No model weights are packaged. The workflow smoke-tests the package (no weights, CLI, native
modules, window + ChawoNative).

Rules: dark theme only, no telemetry, no keys in the repo, local by default, short menus.
