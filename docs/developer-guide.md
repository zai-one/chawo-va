# Руководство разработчика

Поставляемое приложение 2.0 — Electron + TypeScript в `ts/`. Старые исходники WPF/.NET (1.x) лежат
в `src/` только для справки.

## Структура

```
ts/src/core/      логика без Electron (распознавание, VAD, форматы) — её же использует CLI
ts/src/main/      главный процесс Electron, IPC, сеть (Hermes, serve), Мозг, история
ts/src/renderer/  интерфейс (тёмная тема, sandbox, строгий CSP, без сети)
ts/src/cli/       chawo-va: разбор флагов, команды, serve и клиент --server
ts/native/win/    ChawoNative.exe — клавиша удержания и вставка текста (.NET Framework 4.8)
ts/test/          vitest; fixtures/
ts/scripts/       сборка статики, e2e и smoke-скрипты
docs/             документация, openapi.yaml
packaging/        systemd-юнит для serve
```

## Сборка

Нужен Node.js 20+.

```bash
cd ts
npm ci                     # на headless CI: ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci (без GUI/e2e)
npm run typecheck
npm run build              # tsc + копирование статики в dist/
npm start                  # build + запуск Electron
node dist/cli.js --help    # CLI из исходников
npm run build:native       # ChawoNative.exe (нужен .NET SDK)
npm run dist:win           # Setup.exe + портативный zip (Windows)
npm run dist:dir           # распакованная сборка без установщика
```

## Тесты

```bash
npm test                   # vitest run — все юнит-тесты
npx vitest run test/openapi.test.ts test/serveServer.test.ts test/serveClient.test.ts
```

- `test/openapi.test.ts` — `docs/openapi.yaml` валиден (`@apidevtools/swagger-parser`), список
  маршрутов в спеке совпадает с маршрутами в `src/main/network/serveServer.ts` (в обе стороны),
  живые ответы сервера содержат обязательные поля схем. **Добавили маршрут — обновите спеку.**
- `test/serveServer.test.ts`, `test/serveClient.test.ts` — сервер и клиент `--server` (форматы из `segments`).

## E2E

```bash
npm run e2e                               # build + scripts/e2e-smoke.cjs
xvfb-run -a npm run e2e                   # на Linux без дисплея
npm run e2e -- --shots e2e-shots          # со скриншотами
CHAWO_SMOKE_MODEL_DIR=/path/v3-e2e-rnnt CHAWO_SMOKE_AUDIO=/path/a.wav npm run e2e   # + реальная расшифровка
```

Смоук прогоняет все команды `chawo-va` и GUI во временном профиле с фейковым Мозгом на 127.0.0.1;
без весов случаи с реальной расшифровкой пропускаются.

Ручная проверка сервера:

```bash
node dist/cli.js serve --port 17899 --model-dir /path/v3-e2e-rnnt &
node dist/cli.js transcribe a.wav --server http://127.0.0.1:17899 -f txt,srt,vtt,json,md,docx -o /tmp/out
```

## CI

| Workflow | Когда | Что |
|----------|-------|-----|
| `ts-e2e.yml` | push в `ts-port`, `ts/**`; PR в `main`/`ts-port` (пути `ts/**`, `docs/openapi.yaml`) | `npm ci`, `npm test`, e2e под xvfb |
| `ts-windows.yml` | push в `main`, `ts-port`, `ts/**`, теги `v*`, PR | Windows-пакет, смоук пакета; на теге — вложения релиза |
| `build.yml`, `zip.yml` | теги / вручную | старая WPF-сборка |

## Релиз

1. Поднимите `version` в `ts/package.json` (и упоминания версии в README/доках).
2. PR в `main`, дождитесь зелёного CI, merge commit.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` — `ts-windows.yml` соберёт
   `ChawoVoiceAssistant-X.Y.Z-Setup.exe` и `…-win-x64.zip` и приложит к GitHub Release.
4. Веса моделей в артефакты не входят; сборки не подписаны.

## Правила

Только тёмная тема, без телеметрии, ключей в репозитории нет, локально по умолчанию, короткие меню.
Подробная карта переноса: [`ts/PORTING.md`](../ts/PORTING.md).
