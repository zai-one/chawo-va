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
| App/TextInserter.cs, SelectionReader.cs, Native.cs | native helper + clipboard | ⏳ (takes are copied to the clipboard and shown on the page for now) |
| App/HermesServer.cs | src/main/network/hermesServer.ts (Node `http`, no framework) | ✅ ported + tests (health, raw/multipart POST, 400/403/404/503, Content-Length rules, ephemeral port) |
| App.HermesTranscribe | src/main/network/hermesTranscribe.ts (reuses DictationSession's recognizer, opens it from disk if needed, piece by piece, «model unloaded» on swap) | ✅ ported + tests |
| App/HermesFirewall.cs | src/main/network/hermesFirewall.ts | ✅ Windows: same netsh script + one elevated powershell (exit code decides), WF.msc console; elsewhere a no-op (the page says the OS firewall is the user's call) + tests |
| App/RemoteSpeech.cs (RemoteHostException, TryEndpoint, Transcribe, TranscribeBytes, Check) | src/main/network/remoteSpeech.ts (injectable fetch) | ✅ ported + tests (fake fetch and against a real HermesServer) |
| App/SalesRag.cs | src/main/sales/salesRag.ts | 🟡 SuggestDictionary + helpers ported + tests; FindSnippet waits for the sales card |
| App/Sales*.cs (catalog, card, rest) | src/main/sales/ | ⏳ |
| App/KeepAwake.cs | src/main/network/keepAwake.ts (Electron `powerSaveBlocker` 'prevent-app-suspension'; no-op outside Electron) | ✅ ported + tests |
| App/Updater.cs, Autostart.cs | src/main/system/ | ⏳ |
| SettingsWindow, SalesCardWindow, Download/Update windows, BrainServerPanel | src/renderer/ pages | 🟡 «Диктовка», «Расшифровка файла», «Распознавание», «Словарь», «Мозг» and «Сеть» pages work (DownloadWindow folded into the page as a progress card); «Продажи» is a placeholder |
| SettingsWindow network page (Role_Changed, Remote_LostFocus, CheckHost_Click, Lan_Click), App.StartHermes / RestartHermes / ApplyKeepAwake / HermesStatusText / LanUrls / ToggleLanAsync | src/main/network/networkPage.ts (NetworkController), src/main/networkIpc.ts, preload `network:`, renderer `renderNetwork` | ✅ ported + tests |
| App/OverlayWindow.xaml(.cs) | src/main/overlay/overlayModel.ts (state, Tail, hint/caption timers, placement), overlayWindow.ts (frameless transparent always-on-top, never focused, drag → OverlayX/Y), overlayPreload.ts, src/renderer/overlay.html/.css/.ts (13 bars, ripple, live line) | ✅ listening / recognizing / status / hint / live draft + tests; caret placement (Win32) and Unpin button ⏳ |
| SettingsWindow speech page, App.SpeechStatusText / DownloadSpeechAsync / DeleteSpeechModelAsync | src/main/speech/speechPage.ts (SpeechController), src/main/speechIpc.ts | ✅ ported + tests (live session line comes from DictationSession; GPU warmup ⏳) |
| SettingsWindow dictionary page (FillDictionaryRows / PersistDictionary / SuggestDictionary_Click / AddSuggestion_Click) | src/main/dictionary/dictionaryPage.ts (DictionaryController), src/main/dictionaryIpc.ts | ✅ ported + tests |
| SettingsWindow dictation page (Localize dictation block, FillStartCard, Mode/Hotkey/Insert/Overlay/Mic handlers, SetPhase), App.SetPhase | src/main/dictation/dictationPage.ts (DictationController), src/main/dictationIpc.ts | ✅ ported + tests (language box, copy-to-clipboard options, autostart, updates, unpin not on this page yet) |
| App.HandlePressAsync / HandleReleaseAsync / RunBrainAsync / RequestStop / StartPartials / PartialTickAsync / ReloadSpeechAsync / SpeechStatusText | src/main/dictation/dictationSession.ts (DictationSession) | ✅ local or Client (RemoteSpeech) take → dictionary → Brain (every take / «Чаво, …») → simple syntax → clipboard, live drafts on the pill (remote too), cancel aborts the Brain / the host request + tests; Brain on a selection, ConfirmBrainMemory, sales card ⏳ |
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
