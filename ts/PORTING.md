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
| App/SimpleSyntax.cs | src/core/simpleSyntax.ts (`applySimpleSyntax`) | ✅ ported + tests |
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
| App/ModelDownloader.cs | src/main/models/modelDownloader.ts, tarGz.ts | ✅ ported + tests (no network); real v3 download verified on the box; `fetchResumable` (HTTP Range) + `verifyShaAsync` + `unpackTarGzTree` (folders, modes, sibling symlinks) for the Brain |
| App/FileTranscript.cs, FileQueue.cs, FfmpegTool.cs | src/main/file/ (+ zip.ts) | ✅ ported + tests (system ffmpeg mp3 decode) |
| App/BrainProviders.cs, SpeechCleanup.cs, Brain.cs, FileBrain.cs, LocalBrain.cs | src/main/brain/ | ✅ providers/cleanup/Brain/FileBrain + tests; LocalBrain helpers ✅, download (Range resume, mirrors, SHA, engine unpack) ✅, llama-server process (start/health/GPU→CPU fallback/idle stop/kill on exit) ✅ + tests; Windows job object ⏳ |
| App/Recorder.cs | src/core/takeBuffer.ts (accumulator, adaptive VU meter, 5-min cap, take checks) + src/renderer/mic-processor.js (AudioWorklet, 16 kHz mono, 40 ms chunks) | ✅ ported + tests; waveIn/WASAPI replaced by getUserMedia |
| App/KeyboardHook.cs | native helper (see «Hold-to-talk hotkey» below); in-window hold button meanwhile | ⏳ designed, not built |
| App/TextInserter.cs, SelectionReader.cs, Native.cs | native helper + clipboard | ⏳ (takes are copied to the clipboard and shown on the page for now); SelectionReader ✅ `native/win/SelectionReader.cs` (`selread`) + `NativeHelper.readSelection` (branch `ts/feat-selection`) |
| App/HermesServer.cs | src/main/network/hermesServer.ts (Node `http`, no framework) | ✅ ported + tests (health, raw/multipart POST, 400/403/404/503, Content-Length rules, ephemeral port) |
| App.HermesTranscribe | src/main/network/hermesTranscribe.ts (reuses DictationSession's recognizer, opens it from disk if needed, piece by piece, «model unloaded» on swap) | ✅ ported + tests |
| App/HermesFirewall.cs | src/main/network/hermesFirewall.ts | ✅ Windows: same netsh script + one elevated powershell (exit code decides), WF.msc console; elsewhere a no-op (the page says the OS firewall is the user's call) + tests |
| App/RemoteSpeech.cs (RemoteHostException, TryEndpoint, Transcribe, TranscribeBytes, Check) | src/main/network/remoteSpeech.ts (injectable fetch) | ✅ ported + tests (fake fetch and against a real HermesServer) |
| App/SalesRag.cs | src/main/sales/salesRag.ts | ✅ SuggestDictionary + FindSnippet (word-against-word matching, see tick log) + tests |
| App/SalesCatalog.cs, SalesFlow.cs, SalesCardWindow, App.ShowSales/PresentCall/PaintCall | src/main/sales/ (salesCatalog, salesFlow, salesCard, salesCardWindow, salesPage) + salesIpc.ts | ✅ catalog match, call stand-in, CRM boundary (always none), always-on-top card + tests |
| App/KeepAwake.cs | src/main/network/keepAwake.ts (Electron `powerSaveBlocker` 'prevent-app-suspension'; no-op outside Electron) | ✅ ported + tests |
| App/Updater.cs, Autostart.cs | src/main/system/ | ⏳ |
| SettingsWindow, SalesCardWindow, Download/Update windows, BrainServerPanel | src/renderer/ pages | 🟡 all seven pages work (DownloadWindow folded into the page as a progress card); SalesCardWindow is `salesCard.html` |
| SettingsWindow network page (Role_Changed, Remote_LostFocus, CheckHost_Click, Lan_Click), App.StartHermes / RestartHermes / ApplyKeepAwake / HermesStatusText / LanUrls / ToggleLanAsync | src/main/network/networkPage.ts (NetworkController), src/main/networkIpc.ts, preload `network:`, renderer `renderNetwork` | ✅ ported + tests |
| App/OverlayWindow.xaml(.cs) | src/main/overlay/overlayModel.ts (state, Tail, hint/caption timers, placement), overlayWindow.ts (frameless transparent always-on-top, never focused, drag → OverlayX/Y), overlayPreload.ts, src/renderer/overlay.html/.css/.ts (13 bars, ripple, live line) | ✅ listening / recognizing / status / hint / live draft + tests; caret placement (Win32) and Unpin button ⏳ |
| SettingsWindow speech page, App.SpeechStatusText / DownloadSpeechAsync / DeleteSpeechModelAsync | src/main/speech/speechPage.ts (SpeechController), src/main/speechIpc.ts | ✅ ported + tests (live session line comes from DictationSession; GPU warmup ⏳) |
| SettingsWindow dictionary page (FillDictionaryRows / PersistDictionary / SuggestDictionary_Click / AddSuggestion_Click) | src/main/dictionary/dictionaryPage.ts (DictionaryController), src/main/dictionaryIpc.ts | ✅ ported + tests |
| SettingsWindow dictation page (Localize dictation block, FillStartCard, Mode/Hotkey/Insert/Overlay/Mic handlers, SetPhase), App.SetPhase | src/main/dictation/dictationPage.ts (DictationController), src/main/dictationIpc.ts | ✅ ported + tests (language box, copy-to-clipboard options, autostart, updates, unpin not on this page yet) |
| App.HandlePressAsync / HandleReleaseAsync / RunBrainAsync / RequestStop / StartPartials / PartialTickAsync / ReloadSpeechAsync / SpeechStatusText | src/main/dictation/dictationSession.ts (DictationSession) | ✅ local or Client (RemoteSpeech) take → dictionary → Brain (every take / «Чаво, …») → simple syntax → clipboard, live drafts on the pill (remote too), cancel aborts the Brain / the host request + tests; Brain on a selection ✅ (`ts/feat-selection`); ConfirmBrainMemory, sales card ⏳ |
| App.HandlePressAsync / HandleReleaseAsync / RunBrainAsync / RequestStop / StartPartials / PartialTickAsync / ReloadSpeechAsync / SpeechStatusText | src/main/dictation/dictationSession.ts (DictationSession) | ✅ local or Client (RemoteSpeech) take → dictionary → Brain (every take / «Чаво, …») → simple syntax → clipboard, live drafts on the pill (remote too), cancel aborts the Brain / the host request + tests; sales card fed by drafts + the take in «Продажи» mode (drafts run with the pill off); Brain on a selection, ConfirmBrainMemory ⏳ |
| SettingsWindow brain page (Localize brain part / UpdateBrainTexts / FillBrainModelRows), BrainServerPanel, App.SelectBrainAsync | src/main/brain/brainPage.ts (BrainController), src/main/brainIpc.ts | ✅ ported + tests; «Скачать» / «Скачать движок» on the rows + in-page «Скачиваю Мозг» card (progress, cancel, retry) ✅ |
| App.RunFileQueueAsync / RunQueue / RunOneFile / TranscribeLocal / TranscribeRemote | src/main/file/fileRunner.ts, localTranscriber.ts, remoteTranscriber.ts, src/main/fileIpc.ts | ✅ local and Client paths + Brain hook (cloud and local FileBrain); a host error ends the run like WPF |
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
  injectable `PlatformDecoder` (`src/main/chromiumDecoder.ts`: hidden sandboxed renderer with
  `decodeAudioData` at 16 kHz, covers MP3/AAC/M4A/FLAC/Vorbis/Opus-WebM/float WAV, files ≤ 400 MB), then ffmpeg. ffmpeg decodes straight to s16le on
  stdout (no temp WAV). The pinned BtbN zip download is offered only on Windows; Linux uses PATH.

## Hold-to-talk hotkey (design, tick 11)

- WPF holds the dictation key with a low-level keyboard hook (`KeyboardHook.cs`, WH_KEYBOARD_LL):
  it sees key-down and key-up of bare modifiers (Right Ctrl, Right Alt, Right Shift, Left Ctrl+Win),
  swallows them, and arms Escape as cancel while a take runs.
- Electron `globalShortcut` cannot do this: it registers accelerators (a modifier plus a key), fires
  once on press with no release event, and cannot bind a bare modifier like Right Ctrl. Faking hold
  with auto-repeat or timers would give stuck or chopped takes, so it is not used.
- Plan: a small native helper process per OS that reports `down`/`up`/`escape` for the chosen key on
  stdin/stdout JSON lines, started by main only while the app runs (no network, no admin).
  Windows first: a tiny C/C# (NativeAOT) or Rust exe with WH_KEYBOARD_LL, same key table as
  `HOTKEY_CHOICES` (0xA3, 0x10000 = Left Ctrl+Win, 0xA5, 0xA1, 0x14, 0x91, 0x2D). The same helper
  later hosts TextInserter (SendInput / Ctrl+V with clipboard restore) and SelectionReader (UI
  Automation). macOS: CGEventTap (needs the Accessibility permission). Linux: X11 XRecord or
  evdev/libinput for Wayland (input group), still TBD. No robotjs / iohook dependency.
- Main maps helper `down` → `DictationSession.startTake()` and asks the renderer to open the mic
  (the renderer owns getUserMedia even when the window is hidden), `up` → stop, `escape` → cancel.
- Until then the «Диктовка» page has an in-window hold button (mouse, touch, Space/Enter) that
  drives the same session, so capture → recognition can be tested end to end.

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

- 2026-10-13 tick 5: file transcription is usable end to end in the Electron shell. `fileRunner.ts`
  (queue loop with decode-ahead of the next file, per-file skip on error, Stop → running row
  Stopped and the rest stays queued, .txt/.srt beside the source, «Готово N, пропуск M», tray
  notification after runs ≥ 60 s). `localTranscriber.ts` opens a FileJob per file from the model
  on disk (never downloads) and streams the WPF progress line. `fileIpc.ts` + preload bridge:
  pick files/folder, drag-and-drop (via `webUtils.getPathForFile`), remove/clear, run/stop,
  reveal in folder, options (timestamps, .srt, «Скорость длинных записей»), ffmpeg status and
  Windows-only download. Renderer page follows the main-process UI language (Auto = OS locale).
  `scripts/smoke-shot.cjs` boots the built app under xvfb and saves a screenshot. Brain post-edit
  and the remote host path are not ported yet: with «через мозг» on, the row says so and the raw
  .txt is still written. 74 tests green.
  Found: the real GigaAM v3 int8 model on the box returns an empty transcript for
  `bench_3min.wav`; that clip may not contain speech, so the recognizer still needs a check on a
  real Russian voice sample before trusting the port. Next: that check, then the Chromium platform
  decoder (hidden renderer `decodeAudioData`) and the «Диктовка» page (model download + status).

- 2026-10-13 tick 6: recognizer verified on real Russian speech (Wikimedia Commons spoken article
  «Русский язык», CC BY-SA, not committed): correct text with punctuation, 3:44 Vorbis file in
  16.6 s wall on the box CPU (3 workers). `bench_3min.wav` gives an empty transcript because it
  has no speech, not because of a bug. Opt-in test `test/recognizer.speech.test.ts`
  (CHAWO_TEST_MODEL_DIR + CHAWO_TEST_SPEECH). Chromium platform decoder done: hidden 1×1 sandboxed
  window, bytes over IPC, `OfflineAudioContext(16 kHz).decodeAudioData`, mono back, idle close after
  60 s, abort kills the renderer. Verified MP3/M4A/FLAC/WebM-Opus/float WAV/Vorbis decode, and the
  full app path MP3 → .txt with ffmpeg hidden from PATH. ffmpeg hints now say it is only needed for
  AMR, WMA, MKV/MOV and files over 400 MB. `scripts/smoke-decode.cjs`, `SMOKE_WAIT=1` for
  smoke-shot. 75 tests green. Next: «Диктовка» page (model status + download with progress, device
  choice), then microphone capture and the global hotkey.

- 2026-10-13 tick 7: «Распознавание» page. `SpeechController` (no Electron imports, unit-tested
  with fake hooks): both model rows with selection, on-disk badge, Download / Delete, WPF progress
  and failure texts (noSpace / corrupt / rejected / network), cancel, retry, client role never
  downloads, already-on-disk is not fetched again, delete is refused while files are transcribing
  and goes through a native confirmation box listing the exact paths. Device choice says DirectML
  on Windows and CUDA elsewhere (what onnxruntime-node actually uses); CPU threads only on CPU.
  The download card replaces the separate WPF DownloadWindow. Sidebar now has all 7 WPF sections
  (Диктовка, Расшифровка файла, Распознавание, Словарь, Продажи, Мозг, Сеть). File transcription's
  "no model" hint points to «Распознавание». Real end-to-end check on the box: v3 downloaded from
  the GitHub release, unpacked, all SHA-256 matched, temp archive removed, page shows «на диске».
  83 tests green. Next: «Словарь» page (rules editor over wordReplace + settings), then microphone
  capture (getUserMedia → AudioWorklet → main) and the hold-to-talk hotkey design.

- 2026-10-13 tick 8: «Словарь» page. `salesRag.ts` ports SalesRag.SuggestDictionary with
  ExtractLatinBrands / ExtractCyrillic / NearEnough / TranslitHint / Fold / Letters / SharedLetters /
  ReadFiles (.txt/.md/.markdown, recursive, ≤ 200 files, ≤ 512000 bytes each, BOM dropped, ≤ 40
  suggestions; brands or Russian words already in the dictionary are skipped, case-insensitive).
  `DictionaryController` (no Electron imports): rows with stable ids loaded from
  `dictionaryRows(settings)` (blank field → DEFAULT_RULES), saved on every edit/delete through
  `saveDictionary` + `Settings.save` only when the formatted rules differ from what is in force
  (WPF PersistDictionary compare); an empty list stores `#`; an empty new row is not saved. Rows are
  not reloaded after our own save (ids and the caret stay put); a rules value changed elsewhere
  reloads them, and a changed materials folder clears the suggestions like WPF. «Подсказать из
  материалов» never writes; «В словарь» appends that row, saves, and drops it from the list. Hints
  are the WPF texts (no folder / nothing found / «Предложено N…» / idle). IPC `dict:*`, preload
  `chawo.dict`, renderer grid with dark inputs; «Добавить» focuses the new heard field. Smoke on
  the box under xvfb: suggest → «В словарь» → «Добавить» → typing all land in settings.json.
  Note (faithful to WPF): the loose 2-shared-letters rule takes the first Russian word on the line,
  so «Наш бренд таптайн Taptain» suggests «наш → Taptain»; worth tightening in both apps later.
  102 tests green (83 before). Next: microphone capture (getUserMedia → AudioWorklet → main) and
  the hold-to-talk hotkey design, or the Brain modules.

- 2026-10-13 tick 9: Brain stack under `src/main/brain/`. Full BrainProviders (FromKey/FromUrl/
  ChatModels/PickDefault), SpeechCleanup (CleanAsync with injectable fetch, reasoning_effort
  drop-on-reject, Xiaomi thinking disabled, AnswerAfterThink, DescribeFailure, Probe/GetModels),
  Brain (ParseCommand/StripAddress with Unicode word edges, TransformAsync, refusal/length
  guards), FileBrain (paragraphs/summary/faithfulness, injectable ask), LocalBrain helpers
  (GGUF paths, IsReady, HF URL parse, injectable LocalBrainRuntime — process start/download
  deferred). Compatibility re-export from `brainProviders.ts`. fileRunner writes `.brain.txt`
  via optional `runBrain`; fileIpc wires cloud FileBrain.RunAsync. 128 tests green (102 before).
  Next: mic capture / hold-to-talk design, or Brain page UI, or LocalBrain process start.

- 2026-10-13 tick 10: «Мозг» page. `BrainController` (no Electron imports, fake fetch + fake timer
  in tests) ports the Brain part of SettingsWindow, the whole BrainServerPanel and
  App.SelectBrainAsync: source Off / На компьютере / В облаке (leaving Local stops the engine hook),
  every-take, instruction (shown only when rewriting), edit-selection, local model rows with on-disk
  badge and stray .gguf rows, custom Hugging Face link with the WPF error text, CPU/Vulkan device,
  .gguf delete behind a native confirm (only files listed in the brain folder). Server panel: each
  service keeps its own key and model, a pasted key picks its service, model list loads after a
  600 ms pause, chat models only, default model picked, saved only as a usable set, then a one-word
  probe; rejected key / no answer / http-outside-home-network texts match WPF (the http warning is
  now kept after a good probe instead of being overwritten). The saved key never goes to the
  renderer, only «ключ сохранён»; «Где взять ключ» opens only the fixed https provider page.
  Fixed a port bug: `getModelsAsync` asked `/v1/chat/models`; now `/v1/models` like C#
  `new Uri(completions, "../models")`. End-to-end check under xvfb against a fake local
  OpenAI-compatible server: «Свой сервер» + address → GET /v1/models → model picked → POST
  /v1/chat/completions → «Всё работает, сохранено», settings.json updated. While the local
  download is not ported, the not-on-disk line says to download in the WPF app or drop a .gguf in.
  139 tests green (128 before). Next: microphone capture (getUserMedia → AudioWorklet → main) and
  the hold-to-talk hotkey design, or LocalBrain download + llama-server start.

- 2026-10-13 tick 11: «Диктовка» page, microphone capture and an in-window hold-to-talk take.
  `src/core/takeBuffer.ts` ports the Recorder.cs accumulator (16 kHz, 10 s storage blocks,
  snapshot / stop / clear, takePeak, consume-on-read level with the adaptive meter 15 / 0.2 / 0.4 dB,
  TakeTooLong once at 5 minutes) plus App's take checks (MinTakeSamples 0.25 s, SilenceFloor,
  HasSpeechDynamics, quiet-take gain to 0.5 capped at 200). Capture: renderer getUserMedia (raw: no
  echo cancel / noise suppression / AGC) → AudioContext at 16 kHz (Chromium resamples; the worklet
  box-filter decimates if a 16 kHz context is refused) → `mic-processor.js` AudioWorklet → 640-sample
  chunks over `ipcRenderer.send` (ordered before the stop). The mic opens per take and closes after,
  so the OS indicator is off between takes. CSP and the file://-only request filter are unchanged
  (the worklet is a bundled file loaded under script-src 'self'). `DictationController` (no Electron
  imports): mode with the WPF sales hint, the seven WPF hotkeys + HotkeyTitle («клавиша XX» for
  others), Type/Paste, overlay checkbox, microphone list with a «По умолчанию Windows — name» row,
  «С чего начать» card with page links and «Больше не показывать» (StartHintDismissed), App.SetPhase
  texts, Stop (and Escape) enabled while listening/recognizing, no-model hint linking to
  «Распознавание». Chromium device ids differ from WASAPI ids and settings.json is shared with WPF,
  so a mic picked here is stored as `web:<deviceId>`; a WPF id is left alone (default device used
  here); a vanished `web:` id is cleared like WPF, but only on a non-empty device list.
  `DictationSession`: opens the recognizer on page show or first take (never downloads), keeps it
  until speech settings change (SpeechController.changed), closes it before a model delete; on stop:
  silence / short / not-made-out messages as in WPF, KeepLastRecording WAV, gain, owned cancelable
  recognition, dictionary, final text shown on the page and copied to the clipboard (IPC layer). The
  «Распознавание» status now shows the live session line («Загружена v3_e2e_rnnt, считает на …»).
  End-to-end on the box under xvfb with Chromium's fake mic fed from a Russian speech WAV: real mouse
  hold 8 s → meter moves → «Русский язык. Русский язык — это один из восточнославянских языков,
  национальный» on the page and on the clipboard (`scripts/smoke-dictation.cjs`). No-model press
  shows the hint and does not record. 186 tests green (139 before). Gaps: global hold key (design
  above), TextInserter / SelectionReader, OverlayWindow with live drafts, Brain / simple syntax /
  sales card on a take, remote host, GPU warmup. Next: the native hold-to-talk helper (Windows) with
  TextInserter + SelectionReader and the OverlayWindow, or LocalBrain download + llama-server start.

- 2026-10-13 tick 12: a dictation take now follows the WPF path end to end: recognize → dictionary →
  Brain → simple syntax → page + clipboard, with the floating pill. `src/core/simpleSyntax.ts` ports
  SimpleSyntax.Apply (single sentence: drop the closing period, lowercase a leading capital unless the
  first word is all caps; inner sentence end, newline or empty → untouched). `DictationSession` runs
  App.RunBrainAsync when App.BrainUsable (Local: model on disk via the LocalBrain runtime; Server:
  url + model + key unless custom) and the take has a «Чаво, …» command (parseCommand) or
  BrainEveryTake is on; reuses `brain.transformAsync` (now takes an injectable fetch) so prompts,
  refusal/length checks and the action labels («Причёсываю…», «Перевожу…») are the ported ones. The
  action label is the page status and a status on the pill while the Brain works. Failure: the
  dictation goes in as recognized without the command and the reason is shown («Мозг не справился:
  … В буфере обмена текст без правки.», clipboard instead of WPF's insert wording); an empty answer is
  a failure; network error / timeout / 401 texts come from SpeechCleanup. Stop/Escape during the
  Brain aborts the request (AbortController per take) and drops the take silently. Simple syntax
  skips Brain command answers like WPF. Local Brain with a model on disk fails gracefully with
  «локальный сервер мозга ещё не запускается в этой сборке» until the llama-server start is ported;
  ConfirmBrainMemory is skipped for the same reason. Brain on a selection waits for SelectionReader.
  OverlayWindow: `OverlayModel` (pure, tests) + `OverlayWindow` (Electron): frameless transparent
  always-on-top, focusable:false + showInactive so it never steals focus, skipTaskbar, dark pill
  #F2171717 / #42FEE9CE border, 13 gradient bars driven by the same level read as the page meter,
  ripple while recognizing, live draft (last 280 chars) under the bars, hints hide after 2.2 s,
  statuses stay; size reported by the renderer; bottom centre of the screen under the mouse (the
  Win32 caret lookup is not portable), dragged position saved to OverlayX/Y like WPF. Honors
  ShowOverlay (unchecking hides it). Live drafts: a pass over the audio so far every 1 s while the
  pill is on (≥ 0.6 s, speech dynamics, silence floor, gain), skipped while one runs, cancelled and
  awaited before the final pass. End-to-end on the box under xvfb (`scripts/smoke-brain-take.cjs`:
  fake OpenAI-compatible server on 127.0.0.1, fake mic from a Russian WAV, real mouse hold): pill
  shows bars + «Русский язык. Русский язык — это один из восточных» while holding, «Причёсываю…»
  during the Brain, page status «Причёсываю…», server got the recognized phrase, clipboard has the
  Brain answer, pill hidden after. 218 tests green (186 before).
  Next: LocalBrain download + llama-server start (so «На этом компьютере» works on takes and files),
  then the Windows native helper (hold key, TextInserter, SelectionReader → Brain on a selection,
  caret placement for the pill); remote host / Hermes; «Продажи» card.

- 2026-10-13 tick 13: LocalBrain download + llama-server start, so «На этом компьютере» works for
  dictation takes and the file Brain once the engine and model are on disk. `downloadAsync` ports
  DownloadAsync: Stop, free-space check (minus the `.part`), engine first, then the GGUF through
  `fetchResumable` (new in modelDownloader.ts, C# FetchAsync: `Range: bytes=N-`, 416 → complete, a
  200 to a Range restarts, size cap = expected or MaxCustomBytes for a custom link, 60 s idle →
  «download stalled», the `.part` survives errors and cancel), Qwen3 GitHub mirror → Hugging Face
  fallback, SHA-256 (`verifyShaAsync`, streamed so a 2 GB hash does not block the main process) or
  the GGUF header for a custom link (non-GGUF → rejected, `.part` removed), rename into place;
  failures map to network / noSpace / corrupt / rejected like WPF. `ensureEngine`: b10701 for the
  device; Windows zip with the WPF SHAs, Linux ubuntu x64/arm64 tar.gz (CPU and Vulkan) pinned to
  the GitHub release digests; unpacked keeping folders + sibling symlinks (`libllama.so.0 ->
  libllama.so.0.3.0`), the folder holding `llama-server(.exe)` becomes `engine-b10701[-vulkan]`,
  chmod +x. `hasGgufMagic` now reads 4 bytes instead of the whole file. `LlamaServerRuntime` replaces
  the throwing stub: isReady first (clear «модель Мозга не скачана» / «движок мозга не скачан»),
  free loopback port, random 16-byte hex key, the WPF argument list (+ `-ngl 99` on Vulkan),
  stdout/stderr to brain.log, /health polled (2 s per try, 400 ms apart, 90 s cap, ticks from 3 s),
  crash/timeout → BrainException with the WPF texts, Vulkan failure → CPU engine + DeviceNote (and
  no new GPU try on every phrase until Stop), 15-minute idle stop, Stop kills (SIGKILL after 2 s),
  concurrent callers share one start, killed on before-quit and on process exit. Module `stop()`,
  `deleteGguf()` (inside the brain folder, .gguf only, not next to the program, with its .part),
  `deleteModel()`, `deviceNote()`. brainIpc: `stopLocal` → LocalBrain.stop, deletes through
  LocalBrain.deleteGguf, `brain:download` / `brain:cancelDownload` / `brain:dismissDownload`.
  «Мозг» page: «Скачать» on rows not on disk («Скачать движок» on the selected row when only the
  device's engine is missing), the WPF «Скачиваю Мозг» card with progress / cancel / retry / hide,
  WPF «Файла ещё нет. Нажмите кнопку…» status, DeviceNote after the path; nothing downloads by
  itself. Tests: in-memory Range-aware fake fetch (resume, drop + resume, 416, ignored Range, caps,
  stall, cancel), zip and nested tar.gz engine unpack with path-escape attempts, mirror fallback,
  checksum/noSpace/cancel, delete guards; runtime against `test/fixtures/fake-llama-server.cjs`
  (args, key, reuse, restart on model change, shared start, GPU crash → CPU, crash/timeout texts,
  ticks, idle stop, abort); BrainController download state machine. 254 tests green (218 before).
  Smoke on the box: the real ubuntu-x64 engine (16 MB) downloaded, SHA-checked and unpacked by
  `ensureEngine`, `llama-server --version` → build 10701; with a 1 MB stories260K GGUF as a custom
  model `ensureStarted` came up in 70 ms, /v1/chat/completions answered with the key, a wrong key got
  401, Stop left no process; `FileBrain.runAsync` on Local (fileIpc no longer short-circuits Local)
  ran paragraphs + «Кратко» through the same server. No multi-GB model was downloaded.
  Next: the Windows native helper (hold key, TextInserter, SelectionReader → Brain on a selection,
  caret placement, job object for llama-server), then remote host / Hermes, then the «Продажи» card.

- 2026-10-13 tick 14: Hermes host + RemoteSpeech client + the «Сеть» page; the Client role works for
  dictation takes and file transcription. `src/main/network/hermesServer.ts` ports HermesServer on
  Node's `http` module: 127.0.0.1 or 0.0.0.0, a non-loopback peer without LAN → 403
  `localhost_only`, GET `/v1/health`|`/health` (transcribe(empty) → model_loaded/model/device/
  provider + port/listen), POST `/v1/transcribe`|`/transcribe` with a raw body or the first
  multipart part (same FirstFilePart rules), empty → 400 `empty_body`, no model → 503, decode
  error → 400 `bad_audio`, any throw → 400 `bad_request`; POST needs Content-Length (chunked → 400),
  over MaxBytes → 400; no request timeout (two-hour files), keep-alive on, Connection: close.
  `hermesTranscribe.ts` = App.HermesTranscribe: reuses `DictationSession.current()` (new accessor:
  the open recognizer for the current settings), opens it from disk through `ensureLoaded` when it
  is not open (health waits up to 3 s for that; never downloads), decode16k → pieceRanges →
  transcribePiece one at a time (dictation can run between pieces), swapped/closed session mid-
  request → «model unloaded» (503). `remoteSpeech.ts` ports RemoteSpeech + RemoteHostException with
  the same Russian/English texts: TryEndpoint (bare host, IPv6 in brackets, full http URL; https
  refused; a full URL without a port means 80 like .NET `Uri.Port` — kept as in WPF), Transcribe
  (resample to 16 kHz, WAV, 90 s), TranscribeBytes (as-is, no timeout, MaxBytes cap), Check (GET
  /v1/health, 5 s, Russian-only lines like WPF), caller abort → AbortError, everything else a short
  «Хост не отвечает…»; redirects not followed; fetch injectable. `hermesFirewall.ts`: the WPF netsh
  script + one elevated powershell on Windows; on Linux/macOS nothing is run (binding 0.0.0.0 needs no
  admin) and the page says the OS firewall is the user's call. `keepAwake.ts`: powerSaveBlocker.
  `networkPage.ts` (NetworkController) + `networkIpc.ts` + preload `network:` + renderer
  `renderNetwork`: role (Host/Client, WPF labels), host panel (WPF HostNote, «Приём звука от других
  компьютеров», HermesStatusText with LanUrls, LAN toggle with the WPF yes/no text — a Linux/macOS
  variant without the Windows-firewall sentence — Windows firewall rule → console + warning on
  failure, RestartHermes with the 127.0.0.1 fallback that clears HermesOnLan), keep-awake checkbox
  (WPF has no switch and clears the flag on load; here it is for this run only — settings.json still
  stores false), client panel (address, port with the 17831 fallback, saved on blur/Enter,
  «Проверить хост» → «Проверяю хост…» → the Check line). Unlike WPF, Hermes runs only while this PC
  is the host (WPF also listens as a client, with no model to serve). Main: Hermes starts after the
  window when Host; role switch → session.speechChanged (drops the local recognizer on Client);
  quit disposes Hermes and releases keep-awake; the speech page counts a Hermes request as busy.
  Client dictation: press checks only TryEndpoint (no model needed; WPF hint on a bad address),
  release posts the normalized take via RemoteSpeech.transcribe (AbortController per take, Stop
  aborts it), RemoteHostException → the page status/pill hint with the WPF text, live drafts post to
  the host too (aborted on release, errors only logged, like PartialTickAsync); the hold hint says
  the take goes to the host; «Распознавание» status shows «Клиент. Звук уходит на http://…». Client
  files: `remoteTranscriber.ts` = TranscribeRemote (whole file as one WAV, or one WAV per pause-split
  piece when timestamps/.srt are on, offsets kept), `remotePrepare` checks only the address,
  FileRunner got `fatal` (a host error fails the current file, ends the run with that line, the rest
  stays queued) and `prefetch` (off on Client like WPF). Tests: hermesServer (11), remoteSpeech (13,
  incl. against a real HermesServer), hermesTranscribe (6), networkPage + firewall + keepAwake (16),
  fileRemote (5), dictationSession client cases (5 replacing 1), speechPage client status.
  309 tests green (254 before). Smoke on the box under xvfb
  (`scripts/smoke-network.cjs`): Hermes on 127.0.0.1:17831 answered health (v3_e2e_rnnt on cpu) and
  transcribed a 30 s Russian WAV in 1.4 s; LAN toggle → health via 172.30.0.2:17831 with listen
  0.0.0.0, back to 127.0.0.1; a second Hermes on 17832 with its own Recognizer as the «other PC»;
  the app as Client: «Проверить хост» → «Хост отвечает, модель загружена.», a queued 30 s file →
  `[00:00:00] Русский язык. …` .txt beside it, a fake-mic hold take → «Русский язык. Русский язык —
  это один из восточно-славянский» on the page and clipboard, host stopped → «The host did not
  answer…» on the next take; own Hermes down while Client, up again after Host.
  Gaps: Sales partials without the pill (with the sales card); GPU warmup; Windows firewall path is
  unit-tested with a fake spawn only (needs a Windows run). Next: the Windows native helper (hold
  key, TextInserter, SelectionReader, caret placement, job object), the «Продажи» card, then
  Updater/Autostart.

- 2026-10-13 tick (branch `ts/feat-url-transcribe`, IDEAS.md №12, approved batch 2 п.4): расшифровка по
  ссылке через yt-dlp. `src/core/mediaUrl.ts` (pure): `parseMediaUrl` (только http/https, ссылка без
  схемы → https, file:/data:/javascript:/ftp: и длиннее 2048 — отказ), `ytDlpArgs` (`--ignore-config`,
  `--no-playlist`, `-f bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best`, `-P <папка>`,
  `-o "%(title).90B [%(id)s].%(ext)s"`, `--windows-filenames`, свои теги прогресса и пути через
  `--progress-template`/`--print after_move:`, `--no-simulate`, `--ffmpeg-location` при наличии,
  `--js-runtimes node:<electron>`, URL после `--`), `parseYtDlpLine`, `ytDlpAsset` (yt-dlp.exe /
  yt-dlp_macos / yt-dlp_linux / yt-dlp_linux_aarch64), `shaFromSums`, `ytDlpError`.
  `src/main/file/ytDlpTool.ts`: find (свой в `tools/yt-dlp`, затем PATH), statusLine, downloadAsync
  (SHA2-256SUMS → бинарь через fetchFile → sha256 → chmod → `--version` → rename; старая сборка
  остаётся при несовпадении), fetchAudio (spawn в своей группе процессов, Stop/таймаут 30 мин убивают
  дерево — POSIX `kill(-pid)`, Windows `taskkill /T /F`; при Electron `ELECTRON_RUN_AS_NODE=1`, чтобы
  yt-dlp решал JS-челленджи YouTube самим Electron). `urlImport.ts` (UrlImport, без Electron): одна
  ссылка за раз, статусы «Скачиваю звук с <host>… N%», «Скачано: … Расшифровываю локально.»,
  ошибки «Не скачалось: <ERROR-строка yt-dlp>», стоп → «Скачивание по ссылке остановлено.»; файл
  уходит в FileQueue и запускает прогон (идущий прогон подхватит сам). fileIpc: `file:url`,
  `file:ytdlpDownload`, `url` в FileStateDto (line/canDownload/installed/managed/busy/folder =
  Downloads/Chawo), «Остановить» гасит и скачивание; статус очереди снова главный, когда она
  заговорит. Renderer: fieldset «По ссылке» (поле сохраняет текст/фокус/курсор при перерисовке,
  Enter = запуск), строка о сети, строка yt-dlp, «Скачать yt-dlp»/«Обновить yt-dlp». Новых настроек нет.
  Тесты: mediaUrl (21), urlImport (4), ytDlpTool (8: fake fetch + /bin/sh fake yt-dlp — sha, mismatch
  сохраняет старую сборку, аргументы после `--`, прогресс, ERROR, abort/таймаут). 342 теста зелёные
  (309 до). Smoke под xvfb (`scripts/smoke-url.cjs`): кнопка скачала настоящий yt-dlp 2026.08.19 c
  GitHub (sha ок) за 4 с; `file:///etc/passwd` → «нужна ссылка http(s)»; MP3 с 127.0.0.1 (generic
  extractor) → `Downloads/Chawo/lecture [lecture].mp3` → `[00:00:00] Русский язык. Русский язык —
  это один из восточнославянских языков…` за 6.8 с; YouTube «Me at the zoo» → `.m4a` 19 с →
  .txt (английская речь, русская модель текста не дала — ожидаемо) за 9 с, с Electron как
  JS-рантаймом. Gaps: CLI (`chawo-va transcribe <url>`) не трогал — CLI в отдельной ветке; Windows-
  путь taskkill проверен только кодом.
- 2026-10-13 tick (branch `ts/feat-diarization`, IDEAS.md №11): локальная диаризация спикеров после
  файловой расшифровки. `src/core/diarize.ts` (pure): `assignSpeakers(transcript, diarSpans)` —
  max time-overlap, remap id по первому появлению в транскрипте; `speakerPrefix` → «Спикер N:»
  (1-based, всегда по-русски). `TranscriptSegment.speaker?`; `toTxt`/`toSrt` добавляют префикс,
  когда хотя бы у одного сегмента есть speaker. Runtime: `sherpa-onnx-node` `OfflineSpeakerDiarization`
  (lazy `require`, тесты без native addon), конфиг clustering `numClusters: -1`, `threshold: 0.5`,
  `minDurationOn: 0.2`, `minDurationOff: 0.5`; float32 mono 16 kHz. Модели по запросу в
  `models/diarization/` (pyannote segmentation tar.bz2 → `model.onnx` + 3D-Speaker embedding onnx,
  ~47 МБ; unpack через python3 bz2). Настройка `FileDiarize` (default false). `FileRunner.runDiarize`
  после локальных сегментов: нет моделей → заметка в note, очередь не падает; есть → assign + «спикеры».
  UI: чекбокс «Разделять спикеров» + «Скачать модели (~47 МБ)» на «Расшифровка файла». Тесты:
  diarize, diarizeRuntime (fake fetch + tar.bz2), fileRunner (3), settings FileDiarize, formats.
  Smoke: `scripts/smoke-diarize.cjs` (skip-friendly). Gap: remote/Client path не диаризует на хосте
  (только локальный PCM); DER-метрика не считается автоматически.
- 2026-10-13 tick (branch `ts/feat-meeting`, IDEAS.md №10 = approved batch 2 item 2): meeting recording
  with the computer sound. «Расшифровка файла» got a «Встреча» box: «Записать встречу» → «● Запись
  чч:мм:сс · микрофон ▮▮▮ · компьютер ▮▮▮» with «Остановить и расшифровать» / «Отменить»; one
  checkbox «Со звуком компьютера (собеседники в Zoom, Teams, Telegram)» (`MeetingSystemAudio`, true;
  hidden on macOS) and a hint that the file stays on this PC. Renderer: mic via getUserMedia (the
  dictation mic, default fallback, raw), computer sound via getDisplayMedia with AEC/NS/AGC off (with
  AGC on Chromium turned the Pulse monitor volume down to 8%), video track stopped at once;
  `meeting-processor.js` worklet, 2 inputs → mono each → 16 kHz → interleaved stereo 4000-frame
  chunks (an unconnected input = silence) → `meeting:pcm`. Main: `meetingIpc.ts` answers the display
  request with the first screen + `audio: 'loopback'` only while a start is armed (once; others get
  `{}`), Windows and Linux (Chromium hides monitor sources from getUserMedia on Linux, loopback reads
  the default output's monitor); `meeting/meetingRecorder.ts` streams 16-bit stereo WAV (L = mic,
  R = computer) to `<Documents>/Chawo VA/Встречи/Встреча YYYY-MM-DD HH-MM.wav` (« (2)» on a clash,
  `CHAWO_MEETINGS_DIR` override), ~0.5 s per write, header patched every 5 s, < 1 s → deleted;
  `repairUnfinished` fixes stale headers left by a crash on the next start; quit finalizes the file.
  `meetingController.ts`: start/systemOpened(fallback to mic only with a note)/stop → `files.enqueue`
  (queue.add + run, or joins the running run)/cancel (deletes)/failed (mic). `readWav` now averages
  all channels (was: first channel only), so the file pipeline and Hermes hear both sides.
  Tests: `meeting.test.ts` (18: stereo readWav, naming, L/R layout, clamping, crash-safe header,
  short/cancel, repair, per-OS mode, controller flows RU/EN, worklet at 16/48 kHz with fake
  AudioWorklet globals), `meetingIpc.test.ts` (3, mocked Electron: loopback only when armed and once,
  pcm size cap, no screen → refused, macOS mic only). 330 green + 1 skipped (309 on ts-port).
  Real run on the box (`scripts/smoke-meeting.cjs`, Electron under Xvfb, PulseAudio with null sinks
  `speakers` (default output) and `micsink` + `module-remap-source` as the default mic, real v3 e2e
  int8 on CPU): click «Записать встречу», piper «Добрый день. Меня зовут Александр…» into the mic sink,
  then «Здравствуйте. Нам нужно двести метров медного кабеля…» into the speakers; live meters moved
  on the right side each time; stop → 12.5 s stereo WAV (first half L 0.148 RMS / R 0.020, second half
  L 0.000 / R 0.097) → queue «готово» → `.txt` beside it: «[00:00:00] Добрый день. Меня зовут
  Александр. Я менеджер по продажам компании Чава. Здравствуйте. Нам нужно 200 м медного кабеля до
  пятницы. Пришлите счёт.» Gaps: Windows loopback is not run for real here (same Chromium path,
  needs a Windows run); on Wayland the screen-source request may show the portal picker; echo from
  speakers lands on both channels (headphones advised); no live (during-the-call) transcript yet;
  the L/R split is ready for «Я / Собеседник» in the diarization item.
- 2026-10-13 tick (branch `ts/feat-voice-punct`, IDEAS.md №9 = approved batch 2 item 1): voice punctuation
  and spoken numbers. `src/core/spokenText.ts` (no Electron): `applySpokenPunctuation` — one regex of
  all commands (longest first, ё/е and case ignored, a comma allowed inside two-word commands as the
  model writes «точка, с запятой»); kinds close (, . ; : ? ! …), open ( « , closer ) », dash « —»,
  hyphen (glues), line (\n / \n\n); the model's own marks on both sides of the command are swallowed
  (a closer keeps a mark after it); sentence ends and new lines capitalize the next letter, a comma
  after a model-made sentence end lowers the model's capital (acronyms kept); «точка» stays a word
  before «зрения/доступа/продаж…» or after an -ая/-яя adjective or «эта/наша/каждая…». Text with no
  command comes back as the same string. `applySpokenNumbers` — tokens, a run of number words split
  by single spaces, Russian place order (hundreds → tens/teens → units → scale, scale only after
  digits and descending), all cardinal case forms (no «семью», it is «family»), a multi-word run may
  end with an ordinal → `-е/-го/-й/-м/…` suffix; left alone: lone «один…», lone scale words
  («тысячи людей»), lone ordinals («пятое октября»); digits untouched; output is plain digits (no
  thousand separators). `applySpoken(text, {SpokenPunctuation, SpokenNumbers})` runs punctuation then
  numbers. Settings `SpokenPunctuation`, `SpokenNumbers` (both false). Session: after the dictionary
  rules, before the Brain/«Чаво, …» and simple syntax; log line `spoken marks/numbers: N -> M chars`
  (counts only). Page: two checkboxes with one hint line each under the «Словарь» table
  (`dict:setSpoken`, saved only on a real change). Files and the live draft are not touched.
  Tests: `test/spokenText.test.ts` (51: punctuation table incl. model marks around commands, nouns
  kept, numbers table incl. cases/ordinals/phone-like runs, switches, settings round trip + junk,
  page switches RU/EN, three dictation takes off/on/on+simple syntax, the real model output below).
  360 green + 1 skipped (309 on ts-port). Real run on the box: piper `ru_RU-irina-medium` speech
  «Встреча в пять запятая в офисе точка. Бюджет двадцать пять тысяч рублей вопросительный знак. Новая
  строка. Скидка открыть скобку до конца месяца закрыть скобку десять процентов.» (espeak-ng gives
  GigaAM nothing) → Electron under xvfb with the fake mic (`scripts/smoke-spoken.cjs`, real v3 e2e
  int8): switches off → «Встреча 5, в офисе. Бюджет 25 000 ₽, вопросительный знак, новая строка.
  Скидка: открыть скобку до конца месяца закрыть скобку 10%.»; both checkboxes clicked on the page →
  settings.json true/true → «Встреча в 5, в офисе. Бюджет 25 000 ₽?\nСкидка: (до конца месяца) 10%.».
  Note: v3 e2e already normalizes numbers and sometimes turns a spoken «запятая/точка» into the mark
  itself, so «Числа цифрами» matters mostly for v3_ctc/v2. Gaps: English commands («comma») are not
  supported (the model writes English in Cyrillic anyway); no thousands separators; «два/три» alone
  become digits when numbers are on.
- 2026-10-13 tick (branch `ts/feat-app-modes`, IDEAS.md №4): per-app modes. `src/core/appRules.ts` (no
  Electron): `AppRule {Match, Edit: Default|Off|Custom, Instruction, SimpleSyntax: Default|On|Off}`,
  `parseAppRules` (junk dropped, unknown → Default, ≤50 rules), `exeKey`, `ruleMatches` (program name
  exact with/without .exe, or a ≥2-char piece of the window title, case-insensitive, ё = е; tokens split
  on , ;), `findRule` (first active from the top), `applyRule` (returns a copy with BrainEveryTake /
  BrainInstruction / SimpleSyntax overridden; Off keeps «Чаво, …» commands working).
  `src/main/foreground/foregroundApp.ts`: `detectForeground` — Windows: one hidden PowerShell call with
  GetForegroundWindow + GetWindowThreadProcessId (fallback until the native helper's `fg` from
  `ts/feat-win-native` is merged; wire it then), Linux: `xprop -root _NET_ACTIVE_WINDOW` → `xprop -id`
  pid/WM_CLASS/_NET_WM_NAME (C-escaped UTF-8 decoded) → `/proc/<pid>/exe`, macOS: osascript frontmost
  process; our own window (electron / Chawo exe) → null; any failure → null; 2.5 s timeout. Settings:
  `AppRules` (default []). Session: `foreground` is asked at key press only while `AppRules` is not
  empty (an empty row counts, so the page can offer «Добавить для …»), awaited after recognition (≤3 s,
  no added latency in practice), the rule's copy of the settings drives the Brain and simple syntax;
  log line `app mode N for <exe>` (exe only, never the title); `onApp` → main keeps the last program
  in memory and pushes the «Мозг» state. Page: «Для отдельных программ» at the bottom of «Мозг» —
  one card per rule (match field, rewrite select hidden while the Brain is off, chat-style select,
  instruction box only for «Переписывать по своей инструкции», ↑ to raise, «Удалить»), the line
  «Последняя программа при диктовке: … Сработало правило N.», «Добавить правило» and «Добавить для
  <exe>». IPC `brain:addRule/updateRule/removeRule/raiseRule` (patch fields validated in main).
  Tests: `test/appRules.test.ts` (23: core, settings round trip, xprop/PowerShell/osascript parsing with
  a fake exec, session with a fake focus — no rules → not asked, Custom → own instruction, Off → no
  rewrite but commands work, chat-style both ways, failing detection → globals, page add/edit/raise/
  remove/save counts, last-program lines RU/EN, cap). 332 green + 1 skipped (309 on ts-port).
  Electron smoke on a real X11 session (`scripts/smoke-app-rules.cjs`: Xvfb :77 + xfwm4, an xmessage
  window «Telegram — чат» focused with xdotool, fake mic from ru30.wav, real v3 model, fake
  OpenAI-compatible server, global rewrite OFF, rule «xmessage → своя инструкция»): take 1 → the server
  got system «APPMODE: пиши как в чате.», clipboard «по правилу: Русский язык. Русский язык», log
  `app mode 1 for xmessage: edit=Custom simple=On`, page «Последняя программа при диктовке: xmessage.
  Сработало правило 1.»; take 2 with the Chawo window focused → no server call, text as recognized,
  page «…в фокусе было окно Chawo…»; «Добавить правило» → second rule in settings.json.
  Gaps: Windows path is unit-tested with a fake exec only (needs a run on zai-redmibook; PowerShell
  start costs ~0.3–1 s per take but runs while the key is held); Wayland-native windows are not
  visible to xprop (XWayland ones are); switch Windows to the helper's `fg` after PR #1 merges.
- 2026-10-13 tick (branch `ts/feat-mic-level`, IDEAS.md №7): sound cues + tray take state. The mic level
  was already ported (pill bars and the page meter). `src/core/cues.ts` (no Electron):
  `cueForTransition` (→Listening = start, Listening→Recognizing = stop, Listening→Idle/NoModel =
  cancel, Recognizing→Idle = quiet), `cueTones` (two-tone rising fifth 660→990 Hz for start, falling
  for stop, one 330 Hz tone for cancel; ≤0.1 gain, ≤0.3 s, so the start tone barely reaches the mic),
  `CueTracker` (first phase is the baseline: no beep at app start; reads the setting on every change),
  `trayStateFor`/`trayTooltip`. `src/core/trayDot.ts`: `paintDot` paints an anti-aliased dot with a dark
  ring bottom-right on the BGRA bitmap from `nativeImage.toBitmap()` — red #EF5143 recording, amber
  #FFB261 recognizing — so no new icon files (the iconset belongs to WPF). Wire-up: `dictationIpc`'s
  `push` observes `session.phase`, sends `dictation:cue` {kind, tones} to the main page when
  `SoundCues` is on and calls `opts.phase` → `main.ts` `showTrayPhase` (setImage + tooltip «… — идёт
  запись / распознаю»; images cached per state, cleared on nativeTheme `updated`). The page synthesises
  the tones with an OscillatorNode + 8 ms gain ramps (values clamped again in the page). New setting
  `SoundCues` (default false) and one checkbox «Звуковые сигналы начала и конца записи» under the pill
  checkbox on «Диктовка». Tests: `test/cues.test.ts` (22: transition table, tone limits/shape, tracker,
  tray state/tooltips RU/EN, paintDot pixels/scaling/short buffer, settings round-trip, controller,
  a real DictationSession take → start/stop, Escape → cancel, off → silent but the tray follows).
  331 green + 1 skipped (309 on ts-port). Electron under xvfb (`scripts/smoke-cues.cjs`, fake mic from
  ru30.wav, real v3 model): checkbox ticked → settings.json SoundCues true; hold 4 s → cue 1 start
  (AudioContext running), release → 2 stop, text «Русский язык. Русский язык»; second press + Escape →
  3 start, 4 cancel; tray tooltips idle → «идёт запись» → «распознаю» → idle → «идёт запись» → idle,
  tray bitmap at the dot BGRA 67,81,239 (red) / 97,178,255 (amber) / plain glyph when idle.
  Gaps: media pause (needs the Windows helper + GSMTC); cues are not heard through a real speaker
  on the box (no audio device), and whether the start tone leaks into a take on laptop speakers
  needs a check on zai-redmibook.
- 2026-10-13 tick (branch `ts/feat-vad`, IDEAS.md №2): Silero VAD. `src/core/vad.ts` (no Electron):
  Silero v5 window plumbing — 16 kHz, 512 new samples + 64 of context (576 in), state [2,B,128],
  `input`/`state`/`sr` → `output`/`stateN` (`sileroScorer` wraps any ORT-like session); the scorer is
  injected, so unit tests use a deterministic fake and never need weights. `speechProbabilities`
  scores long audio as up to 16 contiguous «lanes» in one batch (1 per minute; each lane starts with
  a fresh state) — 300 s in ~0.6 s on the box CPU, ~5 s per hour. `probsToSegments` = silero-vad
  `get_speech_timestamps` (0.5/0.35, 250 ms min speech, 100 ms min silence, 30 ms pad); `segments`,
  `trimSpeech` (100 ms kept, original audio when nothing is found), `pauseMidpoints`/`gapMidpoints`
  (midpoints of ≥0.3 s gaps, a drop-in for `silences()` in `chunkBounds`), the `Vad` class (Silero
  with a scorer, energy without), `energyProbabilities` (pure JS: window loudness vs the take's own
  10th-percentile floor + 12 dB, kept in −50…−25 dBFS) and `SilenceWatch` (streaming energy
  trailing-silence detector for auto-stop). `src/main/vad/vadModel.ts`: the 2 MB file at
  `%LOCALAPPDATA%\ChawoVoiceAssistant\models\silero-vad\silero_vad.onnx` (or CHAWO_VAD_MODEL /
  CHAWO_MODEL_DIR), downloaded only on a user action from the pinned official URL
  (snakers4/silero-vad v5.1.2) with a SHA-256 check (.part removed on failure); `VadRuntime` loads
  one CPU session lazily and shares it, a failed load is remembered per file+mtime and gives the
  energy Vad — never a broken take. Wire-up: `Recognizer.splitRanges/pieceRanges(samples, rate,
  pauses?)` — given pauses replace `silences()`, without them the split is byte-for-byte the old one;
  `filePauses` feeds it for long files in the local and Client file paths («Ищу паузы в речи…») and
  in Hermes (>25 s); no model, VAD off, an error or no speech at all → undefined → energy split.
  Dictation: `stopTake` trims the take after `normalizeQuietTake` (silence/short-take checks and
  KeepLastRecording still see the full take; the Client role posts the trimmed one; cancel during the
  trim drops the take); without the model the take is untouched. New settings `VadEnabled` (default
  true) and `VadAutoStopMs` (default 0 = off, clamped 0…60000, settings.json only until the toggle
  mode exists): >0 → `SilenceWatch` on every appended chunk stops the take after that much silence
  following speech. UI: one checkbox «Обрезать тишину (VAD)» on «Распознавание» with a status line
  and «Скачать (2 МБ)» while the file is missing; a speech-model download the user starts brings the
  VAD file along when VAD is on. Tests: vad (22 + 1 real-model case behind CHAWO_VAD_TEST_MODEL),
  vadModel (9), dictationSession VAD (7), speechPage VAD (5), settings (1), hermes pauses (2),
  fileRemote VAD split (1). 356 green + 2 skipped (309 on ts-port). Checks on the box with real
  weights: ru30 Silero 14 segments vs energy 14; a synthetic noise file (bench_3min) → Silero 0
  segments, energy 27; long300 (clean) energy vs VAD split → both 510/510 words; the first 120 s of it
  with −30 dBFS hiss → energy finds 0 pauses and hard-cuts at 24/48/72/96 s losing a word, VAD cuts at
  22.35/44.10/67.14/90.53/112.32 s with 204/204 words. Electron under xvfb (`scripts/smoke-vad.cjs`):
  the checkbox and «Скачать (2 МБ)» on «Распознавание», a real download landed with the right SHA-256,
  the line switched to «Silero VAD на диске…», unticking saved `VadEnabled: false`;
  `smoke-dictation.cjs` with a 2 s silence + 5 s speech + 3 s silence fake mic → log «vad trim 7.94s →
  2.85–7.20s», text on the clipboard. Gaps: auto-stop has no UI (waits for the toggle hotkey mode);
  live drafts are not trimmed; dictation >25 s still splits inside the recognizer by energy.
- 2026-10-13 tick (branch `ts/feat-history`, IDEAS.md №3): «История» — the dictation history page.
  `src/main/history/historyStore.ts`: one JSON line per finished take in
  `%LOCALAPPDATA%\ChawoVoiceAssistant\history.jsonl` (mode 0600, text only, no audio):
  `{id, ts, raw, final, command, brain, brainFailed, seconds}` — `raw` is the recognition after the
  dictionary and before the Brain (with the «Чаво, …» command if said), `final` what went to the
  clipboard. A broken/half-written line is skipped; edits rewrite through a .tmp + rename. Search:
  every word, case-insensitive, ё = е, over final + raw + command. New setting `HistoryKeep`
  (Off / Day / Week (default) / Month / Forever; unknown values fall back to Week), plus a hard cap
  of 2000 entries; pruning on every add and whenever the page is drawn; switching to «Не хранить»
  deletes the file at once and nothing is recorded after that. `historyPage.ts` (HistoryController,
  no Electron): newest first, 200 rows drawn (search reaches all), «сегодня/вчера HH:MM» stamps,
  tags «Мозг» / «Мозг не справился», «Копировать», «Копировать без мозга» (only when the text
  differs), «Мозг заново» (re-parses a «Чаво, …» command from `raw`, else the usual cleanup; the
  answer replaces `final` and goes to the clipboard; a failure or empty answer leaves the entry; one
  run at a time; deleting the entry mid-run aborts it), «Удалить», «Очистить всё» behind a yes/no
  box. DictationSession got a `record` hook (errors in it never touch the take; silence and
  cancelled takes are not recorded); `historyIpc.ts` + preload + the renderer page (a typed search
  redraws only the list, so the caret stays). Tests: historyStore (9), historyPage (14),
  dictationBrain history cases (4). 336 green (309 on ts-port). Smoke under xvfb
  (`scripts/smoke-history.cjs`, fake mic + a fake OpenAI-compatible Brain on 127.0.0.1): a real
  v3_e2e_rnnt take → «сегодня 20:33 · 4,9 с | Русский язык. Русский язык — это», one line in the
  file; «Копировать» → clipboard; search «РУССКИЙ» → «Найдено 1 из 1.» with focus kept, a missing
  word → «Ничего не нашлось.»; «Мозг заново» → the server got the raw text, the entry shows «Мозг»,
  the new text and «Распознано: …», clipboard updated; a second take → 2 entries; «Не хранить» →
  «История выключена, удалено записей: 2.», file gone, and a take after that writes nothing.
  Gaps: «Вставить снова» waits for `ts/feat-win-native` (from the Chawo window the focus is on
  Chawo anyway, so copy is the honest action); Sales-mode takes are not recorded (Sales has its own
  card); no audio replay (batch 2 п.10 is for files).
- 2026-10-13 tick (branch `ts/feat-cli`, IDEAS.md №8): `chawo-va transcribe` — the file queue without
  the window. `src/cli/args.ts` parses (`-f/--format txt,srt`, `-o/--out`, `-t/--timestamps` /
  `--no-timestamps`, `--model v3|ctc`, `--device cpu|gpu`, `-j/--threads auto|1|2|4|max`,
  `--script auto|ru|en`, `--model-dir`, `--stdout`, `--skip-existing`, `--lang ru|en`, `-q`,
  `--help`, `--version`; `--opt=value` too; `--` ends options; stdin refused) and holds the bilingual
  help. `src/cli/run.ts` (`runCli`, everything injected): folders expand without recursion like the
  app, duplicates drop, missing inputs fail only themselves; output collisions under `--out` and
  `--skip-existing` are settled before any model loads (nothing left → no model load); the model is
  looked up the app's way (`findComplete`, `CHAWO_MODEL_DIR`) or taken from `--model-dir` if it
  looks complete, never downloaded (exit 3 otherwise); one FileJob for the whole run (the app opens
  one per file); progress redraws one stderr line with the app's `progressLine` only on a TTY;
  per-file «Готово: path (00:05:00 · .srt · 17.2 с)»; `--stdout` prints the txt (`==> file <==`
  headers for several); Ctrl+C aborts the job (second Ctrl+C exits) → «Прервано.», 130, nothing
  half-written. `src/cli.ts` is the `bin` (`#!/usr/bin/env node`): settings.json is read with
  `fromJsonObject` only (settings `load()` may migrate and save — the CLI must not touch the app's
  file), WAV/Ogg-Opus natively, the rest via ffmpeg (no Chromium decoder outside Electron).
  Tests: cliArgs (11), cli (19 incl. readDefaults leaves settings.json byte-identical), opt-in
  cli.speech (real model). 340 green (309 on ts-port). Real runs on the box (v3_e2e_rnnt, CPU,
  8 cores): a folder with two WAVs and an MP3 → `-f txt,srt -o out` six files, 1.4–1.6 s per 30 s
  file, text matches the app; 5-min WAV in 17.2 s («Авто → 4× CPU»); `--stdout -q` pipes 707 bytes;
  `--skip-existing` skips all three without loading the model; SIGINT 4 s into a 5-min file → 130,
  no output; no model → 3 with the Russian hint; `--format pdf` → 2. Gaps: .vtt/.json/.md/.docx in
  the CLI once `ts/feat-export-formats` lands; the packaged app has no CLI entry yet (run with
  Node, or `ELECTRON_RUN_AS_NODE=1` against the app's `dist/cli.js`); no remote `--host` mode.
- 2026-10-13 tick (branch `ts/feat-export-formats`, IDEAS.md №6, export part): extra transcript
  files beside name.txt. `core/transcriptFormat.ts` gained `toVtt` (WEBVTT header, numbered cues,
  `HH:MM:SS.mmm`, & < > escaped, 0.5 s minimum like .srt), `toJson` (`chawo-transcript` v1: source,
  duration, joined text, segments with ms-rounded times — the shape a server backend would store),
  `toMarkdown` (file name as heading, a paragraph per piece, `**[hh:mm:ss]**` when timestamps are on,
  Markdown specials and leading list/heading markers escaped) and `needsTimings`. `core/
  transcriptDocx.ts` builds a minimal WordprocessingML package (title, a paragraph per piece, grey
  time mark, XML-invalid characters dropped) with no dependency; `main/file/transcriptExport.ts` zips
  it with the existing `buildZip` (deflate) and writes the chosen formats (one failing format is noted
  on the row, the others still land). Setting `FileExtraFormats` (vtt/json/md/docx, default none,
  unknown names dropped; .srt keeps its WPF `FileSrt`); the page shows one row «Ещё сохранять рядом:
  .srt .vtt .json .md .docx» replacing the old .srt box (no duplicate setting). Client role: a timed
  format (.vtt/.json, or .md/.docx with timestamps) posts piece by piece like .srt. Tests:
  transcriptExport (14) + a remote case; 323 green (309 on ts-port). Real run
  (`scripts/smoke-export.cjs`, xvfb, real v3_e2e_rnnt on CPU, `ru30.wav`): the four boxes clicked →
  settings.json `FileExtraFormats: ["vtt","json","md","docx"]`, the queue row «00:00:30 · .srt · .vtt
  · .json · .md · .docx» in 6.4 s, all six files beside the WAV; ffprobe reads the .vtt as webvtt and
  ffmpeg converts it to .srt, LibreOffice opens the .docx and its text matches the .txt. Gaps: the
  transcript editor (click a phrase to play) is batch 2 item 10; Brain output stays .brain.txt only.
- 2026-10-13 tick (branch `ts/feat-sales`): «Продажи». `salesCatalog.ts` = SalesCatalog (exact code as
  its own word, longest wins → similar code → nearest name by shared letters ≥ 0.6; HasToken,
  NameIsClose, WithRag). Deviation: WPF scored the nearest name on unfolded letters, so a capitalised
  catalog name («Таптайн») never shared its capital with the lower-case transcript; the name is folded
  now, like NameIsClose already did. `salesRag.ts` gained FindSnippet (SplitBlocks, Clip 220, file
  name as source) and the file count for the page. Deviation: WPF counted a spoken word as present
  when ≥4 of its letters occurred anywhere in the paragraph, so long paragraphs matched every word and
  a short unrelated one won on size; now a word counts when it is a substring of the paragraph or
  looks like one of its words (same first two letters, ≤3 letters length apart, ≥75 % shared).
  `salesFlow.ts` = SalesFlow (TelephonyEvent/HandsetBinding/CrmClient shapes, Resolve, StandIn,
  LookupClient always null, Compose, PreferSpokenHistory, who/script lines verbatim). `salesCard.ts`:
  SalesCardModel (ShowModel/HideNow with the "same as shown" check) and SalesSession (App.ShowSales /
  PresentCall / PaintCall and the ApplySettings branch: leaving Sales closes the call and hides the
  card; a catalog edit repaints an open call). `salesCardWindow.ts` + `salesCard.html/css/ts` +
  `salesCardPreload.ts`: frameless, transparent, always on top, focusable:false + showInactive, no
  taskbar, bottom-right of the primary work area 12 px in (SalesCardWindow.Place), dark only, size
  reported by the renderer. Addition: a small × on the card (WPF had no way to hide it except leaving
  the mode); it hides the card and ends the stand-in call. `salesPage.ts` (SalesPageController) +
  `salesIpc.ts` + preload `sales:` + renderer `renderSales`: catalog rows (code/name/line/similar
  code, saved on every edit, empty rows not stored, outside changes reload), materials folder with the
  WPF status lines and a native folder dialog, call stand-in (extension/number/manager kept for this
  run only, WPF status lines). A one-line note says whether Sales mode is on; the mode itself stays on
  «Диктовка» (no duplicate setting). DictationSession: live drafts run when ShowOverlay OR Mode=Sales;
  in Sales mode each draft and the recognized take (before the dictionary, like WPF) go to the card,
  Client role included; a throwing card is logged and the take goes on. Tests: salesCatalog (10),
  salesFlow + card model + session (8), salesPage (8), session Sales cases (4); 339 green (309 on
  ts-port). Real run (`scripts/smoke-sales.cjs`, xvfb, real v3_e2e_rnnt on CPU, fake mic with a 30 s
  Russian WAV): rows typed into the page are saved to settings.json, folder picked → «Файлов
  .txt/.md: 2.»; pill off + Dictation mode → no card; Sales mode → card at 2 s of holding with
  «похоже · русский язык · Курс русского… · из материалов · Русский язык для взрослых…», window
  focusable=false, always on top, x+width = screen − 12; stand-in without a manager → the WPF
  "no binding" line and no card; with 101/+7…/Анна → «звонок · Анна · трубка 101 · … · клиент по
  номеру не найден · скрипт стадии: нет данных», a take then adds the hit under it; × hides; back to
  Dictation mode hides the card. Gaps: the card sits on the primary display only (like WPF); no
  real CRM or telephony (boundary only, as in WPF). Next: approved batch 2 / top-8 ideas.

- 2026-10-13 tick 15 (branch `ts/feat-win-native`): the Windows native helper — global hold key +
  inserting the phrase into the focused app. Electron has no low-level keyboard hook and no key-up for
  global shortcuts, so `native/win/ChawoNative.exe` (C#, .NET Framework 4.8 — built into Windows
  10/11, 21 KB, no runtime to install, builds on Linux with the .NET SDK via `npm run build:native`;
  the exe is not committed) ports KeyboardHook (hook thread with its own message loop, injected keys
  ignored, Right/Left Ctrl split by LLKHF_EXTENDED, Left Ctrl + Win = 0x10000 with the real
  GetAsyncKeyState check, Escape swallowed only while armed) and TextInserter (Paste: snapshot of
  every HGLOBAL clipboard format → phrase with the three no-history/no-cloud formats → Ctrl+V →
  800 ms → previous clipboard back if nobody copied meanwhile; Type: KEYEVENTF_UNICODE in batches of
  8 with 8 ms pauses, \n → Enter; SendInput refused → Blocked; CopySelection = Ctrl+C + read +
  restore; foreground process name for per-app modes later). One worker thread owns a message-only
  window as clipboard owner and pumps messages while waiting (other apps SendMessage the owner), and
  serialises clipboard work like the WPF ClipboardGate. Difference from WPF: no WinRT clipboard-history
  API in .NET Framework, so «keep the phrase in Win+V» with restore waits 1.2 s when history is on
  (registry) and leaves the phrase current when it is off. Protocol: stdin/stdout lines, text in
  base64 (`src/main/native/helperProtocol.ts`); the helper exits on stdin EOF. `nativeHelper.ts`:
  spawn, ready timeout, request ids + timeouts, hotkey/arm re-sent after a restart, crash while the
  key is held → treated as release, ≤3 restarts a minute then «failed». Wiring: `dictationIpc`
  hotDown → `session.startTake('hotkey')` → the window opens the mic (`dictation:hot` start), hotUp →
  the window stops the mic and calls stop (3 s fallback: recognize what arrived), Escape → cancel +
  drop the mic; Escape is armed while the take listens/recognizes; a hotkey change goes to the
  helper. `DictationSession`: hotkey takes go through the inserter (InsertMode, CopyPhraseToClipboard,
  RestoreClipboardAfterCopy) with the WPF hints (admin window, Brain failure «Вставлен текст без
  правки»), helper gone → clipboard + hint, Type+Blocked also copies (so «текст лежит в буфере» is
  true); the in-window button still copies. Page: WPF intro/step 2 when the key works, one note line
  when it is starting/failed/missing/not Windows; the main window keeps `backgroundThrottling: false`
  so a take from the tray records. Tests: helperProtocol (3), nativeHelper against a fake helper
  script (13), dictationHotkey with a mocked ipcMain (7), session hotkey takes (8), page states (2);
  342 green (309 before). Real run: `scripts/smoke-native-wine.cjs` — the real ChawoNative.exe under
  Wine 10 + wine-mono on Xvfb through the same NativeHelper client: ready in ~0.3 s with the hook
  installed, Type of «Привет, мир 👋\nвторая строка» into a focused WinForms text box, Paste appended
  with the previous clipboard («OLD clipboard») back afterwards, foreground = InsertTarget,
  copySelection read the select-all text and restored the clipboard, keep-phrase mode left the phrase
  current with history off — all PASS. UI shot of «Диктовка» renders. Gaps: the hold key press itself
  is not exercised for real (the hook ignores injected keys; needs a Windows keyboard), clipboard
  history wait is the registry approximation, SelectionReader (UI Automation first) + Brain on a
  selection, caret-placed pill and the llama-server job object are the next native pieces.

- 2026-10-13 tick (branch `ts/feat-selection`, stacked on `ts/feat-win-native` because it needs the
  helper; IDEAS.md №5 = top-8 «Команда над выделенным текстом»): port of SelectionReader + the
  selection branch of HandleReleaseAsync + HintSelectionAsync. Helper: new `selread <id>` → `sel <id>
  <b64|->` (`native/win/SelectionReader.cs`): foreground terminal classes skipped, UI Automation
  (`AutomationElement.FocusedElement` → TextPattern.GetSelection, ≤ 20 000 chars) on its own MTA thread
  with a 1.2 s wait and a hung-read guard; «nothing selected» from UIA is believed (VS Code), Ctrl+C
  with the clipboard put back only for apps that do not expose TextPattern, never for spreadsheets
  (XLMAIN, LibreOffice/OpenOffice/WPS Calc). `Read()` is NoInlining inside a try, so a missing
  UIAutomationClient (Wine) logs «UI Automation unavailable» instead of killing the helper (it did
  exit with code 1 before that fix in the Wine run). App: `NativeHelper.readSelection()` (never
  rejects; null on nothing/blank/helper down/1.8 s timeout; a second read is not sent while one
  hangs). DictationSession: a global-key take with `BrainOnSelection` on and the Brain usable starts
  the read at key-down; when it lands while listening the pill shows «Выделено N знаков. Скажите, что с
  ними сделать» (the page status without the pill); at release, after the dictionary, a selection
  makes the take a Brain command on it (`stripAddress`, so «Чаво,» is optional; `transform(...,
  selection=true)` = the WPF SelectionPrompt / LocalSelection), simple syntax skipped, the answer
  pasted over the selection with «Готово. Вернуть как было: Ctrl+Z»; a Brain failure or an empty answer
  inserts nothing («Мозг не справился: … Выделенный текст не тронут.»); Escape while reading drops it.
  The in-window button never reads a selection. The «Мозг» checkbox for it is now shown only on Windows.
  Tests: `dictationSelection.test.ts` (13), nativeHelper readSelection (3: text/none/blank, hang +
  no pile-up + helper still answers, slow-in-time + not started), protocol encode, brainPage
  visibility; 359 green + 1 skipped (342 on `ts/feat-win-native`). Real run (`scripts/smoke-native-wine.cjs`,
  real ChawoNative.exe under Wine + Xvfb, WinForms target got `selectfirst n` / `deselect`): first 6
  chars selected → readSelection «Привет» via the Ctrl+C fallback, clipboard back to «OLD clipboard»,
  Paste of «Здравствуйте» replaced exactly the selection; nothing selected → null and the clipboard
  untouched; the whole take through the real DictationSession (fake recognizer «Чаво, сделай
  заглавными.», fake Brain) → Brain got {body «Здравствуйте», command «сделай заглавными», selection}
  → «ЗДРАВСТВУЙТЕ, мир 👋…» in the target, Ctrl+Z hint, clipboard restored — ALL PASS. Gaps: the UI
  Automation path needs a real Windows run (wine-mono has no UIAutomationClient), so do Word / Chrome /
  VS Code / Excel (must be skipped) by hand there; the read races the user's still-held hold key (same
  as WPF: Ctrl+C is sent while Right Ctrl is down).

- 2026-10-13 tick (branch `ts/feat-idle-unload`, IDEAS.md №13, approved batch 2 п.5): выгрузка моделей при
  простое. `src/core/idleTimer.ts` (pure, инжектируемые часы): `IdleTimer` (touch/cancel, задержка
  читается при каждом взводе, busy в момент срабатывания → ждём ещё полный срок, 0 = никогда),
  `IDLE_UNLOAD_MINUTES` = 0/5/15/30/60, `normalizeIdleMinutes`. Настройка `IdleUnloadMinutes`
  (по умолчанию 15 — столько раньше было зашито для llama-server). DictationSession: таймер
  взводится после загрузки модели и после каждой фразы; не выгружает во время записи/распознавания/
  загрузки и пока Hermes держит запрос (`idleBusy` = `hermesTranscribe.inFlight() > 0`, `used` после
  каждого запроса Hermes); после выгрузки строка статуса «Выгружена из памяти после простоя,
  загрузится при следующей диктовке.»; нажатие клавиши (startTake → ensureLoaded) грузит модель,
  пока человек говорит. LocalBrain: `idleStopMs` может быть геттером, `touch()` после каждого ответа
  (brain.ts и fileBrain.ts, в finally), `setIdleSource`/`idleChanged` из main. UI: один select
  «Выгружать модели при простое» на «Распознавании» под VAD + подсказка; смена сразу перевзводит оба
  таймера. Новых пунктов меню нет. CLI не трогал: процесс и так закрывается после задания.
  Тесты: idleTimer (5, fake timers), dictationSession (+4: выгрузка и ленивая перезагрузка, 0 = никогда,
  ожидание записи и Hermes, touchIdle/release), localBrainRuntime (+1: геттер, 0, touch от конца
  ответа), hermesTranscribe (+1), speechPage (+1), pathsSettings (+1). 620 тестов зелёные (607 до).
  Smoke под xvfb (`scripts/smoke-idle.cjs`, настоящая v3_e2e_rnnt на CPU, фейковый микрофон
  ru30.wav): выбор «Через 5 мин» через change у select → settings.json `IdleUnloadMinutes: 5`;
  фраза 1 «Русский язык — это один из восточнославянских языков.» за 7.6 с от нажатия, RSS главного
  процесса 597 МБ; через 5 мин в логе «speech model idle for 5 min, releasing memory», RSS 266 МБ,
  статус «Unloaded from memory after being idle; it loads again on the next take.» (второй прогон, после
  добавления этой строки; RSS 601 → 267 МБ); фраза 2 снова тот же текст за 7.3–7.5 с от нажатия
  (перезагрузка спряталась за речью), RSS 600 МБ. Gaps: Silero VAD (2 МБ) не выгружается — не стоит; настоящий llama-server на
  боксе не гонял (проверен фейковым сервером в тестах).

