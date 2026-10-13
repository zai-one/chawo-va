# Chawo Voice Assistant — TypeScript port

Electron + TypeScript port of the WPF app in `../src`. The WPF app stays the shipping
version until this one reaches parity; nothing here touches it.

```
ts/
  src/core/      platform-neutral logic (no Electron, no Windows APIs) — reused by a future CLI/server
  src/main/      Electron main process and preload bridge
  src/renderer/  dark-only UI (sandboxed, strict CSP, no network)
  test/          vitest unit tests; fixtures/ holds independent numpy references
```

```
npm install          # ELECTRON_SKIP_BINARY_DOWNLOAD=1 on headless CI
npm test
npm start            # build + run Electron
```

Rules carried over from the WPF app: dark theme only, no telemetry, no keys in the repo,
local by default (the renderer cannot reach the network), short menus.
Progress and the module map live in [PORTING.md](PORTING.md).
