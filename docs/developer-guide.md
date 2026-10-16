# Руководство разработчика

Поставляемое приложение 2.0 — Electron + TypeScript (pnpm-монорепозиторий: `apps/`, `packages/`).
Старые исходники WPF/.NET (1.x) лежат в `legacy/wpf/` только для справки. План модернизации —
[MODERNIZATION.md](MODERNIZATION.md).

## Структура

Монорепозиторий на pnpm workspaces.

```
apps/desktop/     приложение Electron: main (окна, IPC), preload, renderer (интерфейс), упаковка,
                  ChawoNative (native/win), e2e и smoke-скрипты (scripts/)
apps/cli/         chawo-va: разбор флагов, команды, serve и клиент --server; собирается в пакет
                  приложения как out/main/cli.js и запускается тем же exe (ELECTRON_RUN_AS_NODE)
packages/core/    @chawo/core — логика без Electron (распознавание, VAD, форматы, строки)
packages/engine/  @chawo/engine — сервисы на Node без Electron, общие для приложения и CLI: настройки,
                  очередь файлов, модели, Мозг, сеть (Hermes, serve), CRM, история, MCP, встречи
packages/ipc/     @chawo/ipc — контракт IPC окна и главного процесса (каналы, аргументы, ответы, события)
fixtures/         общие тестовые файлы (транскрипты, фейковые сервер Мозга и помощник ChawoNative)
docs/             документация, openapi.yaml, план модернизации
legacy/wpf/       старое приложение WPF/.NET (1.x), только для справки
tools/            Telegram-бот для Hermes
```

Пакеты подключаются из исходников (`"exports": { "./*": "./src/*.ts" }`), отдельной сборки у них нет:
приложение и CLI собирает electron-vite, тесты гоняет Vitest. Импорт между пакетами — только через
имя пакета (`@chawo/engine/settings`), внутри пакета — относительный. Electron импортирует только
`apps/desktop`.

## Сборка

Нужны Node.js 24+ и pnpm (версия закреплена в `packageManager`, проще всего `corepack enable`).

```bash
pnpm install               # из корня; бинарник Electron скачается при первом запуске
pnpm typecheck             # tsc по всем пакетам, включая тесты
pnpm lint                  # ESLint с проверкой по типам (необработанные промисы и т.п.)
pnpm knip                  # неиспользуемые файлы, экспорты, зависимости
pnpm check                 # всё сразу: типы, линтер, Knip, тесты
pnpm dev                   # electron-vite dev: интерфейс с горячей перезагрузкой
pnpm build                 # electron-vite build → apps/desktop/out
pnpm start                 # build + запуск Electron
pnpm cli --help            # CLI из сборки (node apps/desktop/out/main/cli.js)
pnpm --filter @chawo/desktop build:native   # ChawoNative.exe (нужен .NET SDK)
pnpm dist:win              # Setup.exe + портативный zip (Windows)
pnpm dist:dir              # распакованная сборка без установщика
```

Сборка (`apps/desktop/electron.vite.config.ts`): main и CLI — CommonJS, один файл на исходный модуль
(`out/main/<путь в репозитории>.js`, точки входа — `out/main/main.js` и `out/main/cli.js`); четыре
sandbox-preload — по одному файлу; страницы интерфейса — `out/renderer/*.html`. Версия приложения
(`__CHAWO_VERSION__`) подставляется при сборке из `apps/desktop/package.json`.

pnpm ставит релиз пакета, только когда ему исполнилось сутки (`minimumReleaseAge`), а install-скрипты
разрешены явно (`allowBuilds` в `pnpm-workspace.yaml`).

## IPC

Все каналы между окном и главным процессом описаны один раз — в `packages/ipc/src/contract.ts`:
`InvokeMap` (запрос → ответ), `SendMap` (поток звука из окна), `EventMap` (что main присылает окну).

- Окно вызывает `invoke('file:run')`, `send('dictation:pcm', chunk)`, `on('file:state', fn)` из
  `apps/desktop/src/renderer/bridge.ts` — с проверкой типов аргументов и ответа.
- preload пропускает только каналы из контракта (списки `INVOKE_CHANNELS` и др.).
- main регистрирует обработчики через `handle` / `onSend` / `emit` из `apps/desktop/src/main/ipc.ts`:
  тип ответа сверяется с контрактом, а вызов принимается только от страницы самого приложения
  (`out/renderer/index.html` или dev-сервер). Аргументы в main — `unknown`: каждый обработчик сам
  проверяет то, что пришло из окна.
- `packages/ipc/test/contract.test.ts` следит, чтобы каждому каналу контракта соответствовал ровно один
  обработчик в main и наоборот.

Новый канал: строка в `InvokeMap` и в `INVOKE_CHANNELS`, обработчик через `handle(...)`, вызов через `invoke(...)`.

## Тесты

```bash
pnpm test                  # vitest run — все юнит-тесты, проекты core / engine / cli / desktop
pnpm vitest --project engine
pnpm vitest run packages/engine/test/openapi.test.ts packages/engine/test/serveServer.test.ts apps/cli/test/serveClient.test.ts
```

- `packages/engine/test/openapi.test.ts` — `docs/openapi.yaml` валиден (`@apidevtools/swagger-parser`),
  список маршрутов в спеке совпадает с маршрутами в `packages/engine/src/network/serveServer.ts`
  (в обе стороны), живые ответы сервера содержат обязательные поля схем. **Добавили маршрут — обновите спеку.**
- `packages/engine/test/serveServer.test.ts`, `apps/cli/test/serveClient.test.ts` — сервер и клиент
  `--server` (форматы из `segments`).

## E2E

```bash
pnpm e2e                                  # build + apps/desktop/scripts/e2e-smoke.cjs
pnpm e2e --shots e2e-shots                # со скриншотами (в apps/desktop/e2e-shots)
CHAWO_SMOKE_MODEL_DIR=/path/v3-e2e-rnnt CHAWO_SMOKE_AUDIO=/path/a.wav pnpm e2e   # + реальная расшифровка
```

Смоук прогоняет все команды `chawo-va` и GUI (на Linux — под xvfb) во временном профиле с фейковым
Мозгом на 127.0.0.1; без весов случаи с реальной расшифровкой пропускаются.

Ручная проверка сервера:

```bash
pnpm cli serve --port 17899 --model-dir /path/v3-e2e-rnnt &
pnpm cli transcribe a.wav --server http://127.0.0.1:17899 -f txt,srt,vtt,json,md,docx -o /tmp/out
```

## CI

| Workflow | Когда | Что |
|----------|-------|-----|
| `ts-e2e.yml` | push в `main`, `ts-port`, `ts/**`; PR в `main`/`ts-port` (пути `apps/**`, `packages/**`, …) | типы, ESLint, Knip, юнит-тесты, e2e под xvfb |
| `ts-windows.yml` | push в `main`, `ts-port`, `ts/**`, теги `v*`, PR | Windows-пакет, смоук пакета; на теге — вложения релиза |
| `legacy-wpf-installer.yml`, `legacy-wpf-zip.yml` | вручную | старая WPF-сборка |

## Релиз

1. Поднимите `version` в `apps/desktop/package.json` (одна версия для приложения и CLI) и упоминания версии в README/доках.
2. PR в `main`, дождитесь зелёного CI, merge commit.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` — `ts-windows.yml` соберёт
   `ChawoVoiceAssistant-X.Y.Z-Setup.exe` и `…-win-x64.zip` и приложит к GitHub Release.
4. Веса моделей в артефакты не входят; сборки не подписаны.

## Правила

Только тёмная тема, без телеметрии, ключей в репозитории нет, локально по умолчанию, короткие меню.
Подробная карта переноса с WPF: [`PORTING.md`](PORTING.md).
