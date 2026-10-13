# Porting log: WPF/.NET → Electron + TypeScript

Branch `ts-port`, folder `ts/`. The WPF app in `../src` stays untouched and keeps shipping (1.19.0).

Structure reference: the user's taptain-desktop / zai-brand projects are on GitLab, but the GitLab
token is expired, so this started as a plain Electron + TypeScript skeleton (tsc, no bundler, vitest).
Re-align folder names and tooling with taptain-desktop once its layout is readable.

## Module map

| WPF source | TS target | Status |
|---|---|---|
| Core/TranscriptFormat.cs | src/core/transcriptFormat.ts | ✅ ported + tests |
| App/WordReplace.cs | src/core/wordReplace.ts | ✅ ported + tests |
| Core/SpeechModels.cs | src/core/speechModels.ts | ✅ ported |
| Core/CtcScriptDecoder.cs | src/core/ctcScriptDecoder.ts | ✅ ported + tests |
| Core/Tokenizer.cs | src/core/tokenizer.ts | ✅ ported + tests (synthetic protobuf) |
| Core/ModelConfig.cs | src/core/modelConfig.ts | ✅ ported + tests |
| Core/Features.cs | src/core/features.ts | ✅ ported; matches independent numpy rfft log-mel within 2e-3 |
| Core/AudioUtils.cs | src/core/audio.ts | ✅ ported + tests |
| Core/FileParallel.cs | src/core/fileParallel.ts | ✅ ported + tests |
| Core/Recognizer.cs | src/core/recognizer.ts (onnxruntime-node) | ✅ ported + unit tests (no real weights) |
| Core/FileJob.cs | src/core/fileJob.ts (Promise pool of Recognizers) | ✅ ported + mocked Open/Run tests |
| Core/OggOpus.cs | src/core/oggOpus.ts (opus-decoder) | ✅ demux + decode; demux tests |
| App/Settings.cs, Log | src/main/settings.ts, paths.ts, log.ts | ✅ ported + tests |
| App/DataMigration.cs | src/main/dataMigration.ts | ✅ ported + tests |
| App/SpeechModelStore.cs | src/main/models/speechModelStore.ts | ✅ ported + tests |
| App/ModelDownloader.cs | src/main/models/modelDownloader.ts, tarGz.ts | ✅ ported + tests (no network) |
| App/FileTranscript.cs, FileQueue.cs, FfmpegTool.cs | src/main/file/ (+ zip.ts) | ✅ ported + tests (system ffmpeg mp3 decode) |
| App/Brain*.cs, LocalBrain.cs, FileBrain.cs, SpeechCleanup.cs | src/main/brain/ | ⏳ |
| App/Recorder.cs | renderer getUserMedia → AudioWorklet → main | ⏳ |
| App/KeyboardHook.cs, TextInserter.cs, SelectionReader.cs, Native.cs | native helper / globalShortcut + clipboard | ⏳ needs design (hold-to-talk hotkey) |
| App/HermesServer.cs, HermesFirewall.cs, RemoteSpeech.cs | src/main/network/ | ⏳ |
| App/Sales*.cs | src/main/sales/ | ⏳ |
| App/Updater.cs, Autostart.cs, KeepAwake.cs | src/main/system/ | ⏳ |
| SettingsWindow, OverlayWindow, SalesCardWindow, Download/Update windows, BrainServerPanel | src/renderer/ pages | ⏳ (shell with 4 sections exists) |
| App/Strings.cs | src/core/strings.ts (ru/en `t()`) | ✅ ported |

## Notes

- `features.ts` accumulates dot products in double then rounds to float32 (C# used SIMD float32).
  Difference is below float noise on meaningful bins; verify against the real model once the
  recognizer is ported.
- The renderer is sandboxed with `connect-src 'none'` and the main session cancels every non-`file://`
  request; network features will go through the main process only when the user enables them.
- Settings JSON uses PascalCase string enums (WPF `JsonStringEnumConverter`). Secrets use
  `electron.safeStorage` when available; otherwise protected fields are omitted (never plaintext).
  Tests inject a reversible protect hook. Paths honor `CHAWO_APPDATA` / `CHAWO_LOCALAPPDATA` /
  `CHAWO_MODEL_DIR` (and legacy `PISAR_*`).

- No Media Foundation outside WPF. `fileTranscript.load16k` decodes WAV/Ogg-Opus natively, then an
  injectable `PlatformDecoder` (planned: hidden sandboxed renderer with `decodeAudioData`, which
  covers MP3/AAC/M4A/Opus-WebM/FLAC in Chromium), then ffmpeg. ffmpeg decodes straight to s16le on
  stdout (no temp WAV). The pinned BtbN zip download is offered only on Windows; Linux uses PATH.

## Log

- 2026-10-13 tick 1: created `ts-port` branch and `ts/` skeleton (Electron 38, TS 5.9, vitest 3).
  Ported all pure Core helpers (format, word replace, tokenizer, CTC script choice, model config,
  log-mel features, WAV/resample/pause split, file parallel plan). 23 tests green. Electron shell:
  dark-only window, tray with Открыть/Выход, single instance, sidebar with the 4 WPF sections.
  Next: Recognizer on onnxruntime-node (CTC + RNN-T decode), then FileJob with worker_threads.

- 2026-10-13 tick 2: Recognizer on onnxruntime-node (CTC + RNN-T decode, batch paths, cancel
  flags). GPU prefers CUDA on Linux / DirectML (dml) on Windows, falls back to CPU with
  deviceNote. RunOptions.terminate is WASM-only in the JS binding, so CancelRun/CancelOwned are
  best-effort kill flags. FileJob mirrors Open/Run/Cancel/Dispose with a Promise pool of separate
  Recognizer instances (not worker_threads). OggOpus demux matches C#; DecodeTo16kMono uses
  opus-decoder at 16 kHz mono with OpusHead preskip scaled 48k→16k. Added onnxruntime-node and
  opus-decoder. Unit tests for CtcVocab, modelExists, SplitRanges, Ogg demux, FileJob plan wiring.
  Next: SpeechModelStore / ModelDownloader, settings migration, file transcription UI wiring.

- 2026-10-13 tick 3: Settings + paths + Log (JSON roundtrip, PascalCase enums, CheckUpdates /
  KeepAwake forced off, dictionary via wordReplace, secret protect via safeStorage or omit).
  DataMigration (GigaPisar → ChawoVoiceAssistant, staging `*.migrating`, local move / roaming copy
  skipping model(s), settings path rewrite). SpeechModelStore (FindComplete / LooksComplete size
  gates, candidates, deletable under LocalDataDir only). ModelDownloader (URLs, SHA-256, ApproxBytes,
  streaming fetch, idle timeout, minimal ustar+gzip unpack for v3; no real downloads in tests).
  Minimal BrainProviders.FromUrl for legacy key layout. 57 tests green. Next: FileTranscript /
  FileQueue / FfmpegTool, then wire download + file transcription into the main/renderer shell.


- 2026-10-13 tick 4: file transcription backend. `strings.ts` (ru/en `t()`, Auto follows locale).
  `fileTranscript.ts` (extensions, Electron dialog filters, .txt beside source, folder collect,
  size cap, native → platform hook → ffmpeg decode chain, downmix helper). `fileQueue.ts` (ids
  instead of object refs, change listeners, dedup pending, replace finished, take/peek/finish/
  stop; path compare case-insensitive except on Linux). `ffmpegTool.ts` (find in tools dir / PATH,
  status line, Windows-only pinned download with ±2% size gate via fetchFile, dependency-free
  `zip.ts` extractor, `-version` smoke, stdout PCM decode with 3 h cap). 69 tests green.
  Next: file runner (queue → FileJob → transcript format → .txt, decode-ahead), Chromium platform
  decoder, and IPC + renderer for the «Расшифровка файла» page.
