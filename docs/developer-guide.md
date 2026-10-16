# Руководство разработчика

Поставляемое приложение 2.0 — Electron + TypeScript (pnpm-монорепозиторий: `apps/`, `packages/`).
Старые исходники WPF/.NET (1.x) лежат в `legacy/wpf/` только для справки. План модернизации —
[MODERNIZATION.md](MODERNIZATION.md).

## Структура

Монорепозиторий на pnpm workspaces.

```
apps/desktop/     приложение Electron: main (окна, IPC), preload, renderer (интерфейс), упаковка,
                  ChawoNative (native/win), сценарии Playwright (e2e/), e2e и smoke-скрипты (scripts/)
apps/cli/         chawo-va: разбор флагов, команды, serve и клиент --server; собирается в пакет
                  приложения как out/main/cli.js и запускается тем же exe (ELECTRON_RUN_AS_NODE)
packages/core/    @chawo/core — логика без Electron (распознавание, VAD, форматы, строки)
packages/engine/  @chawo/engine — сервисы на Node без Electron, общие для приложения и CLI: настройки,
                  очередь файлов, модели, Мозг, сеть (Hermes, serve), CRM, история, MCP, встречи
packages/ipc/     @chawo/ipc — контракт IPC окна и главного процесса (каналы, аргументы, ответы, события)
packages/ui/      @chawo/ui — CSS-токены (только тёмная тема) и компоненты React
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

## Интерфейс

React 19 с React Compiler (автоматическая мемоизация; правила проверяет `eslint-plugin-react-hooks`).

- `apps/desktop/src/renderer/App.tsx` — навигация и страницы (`pages/`); страница монтируется заново при
  каждом открытии (и повторном клике) и сама запрашивает своё состояние у main.
- `app/state.ts` — состояния страниц, как их присылает main (хранилища на `useSyncExternalStore`);
  `app/dictation.ts`, `app/meeting.ts` — микрофон и запись встречи вне React: живут дольше страницы.
- `@chawo/ui`: `tokens.css` (цвета, отступы, радиусы — на них строятся и страницы, сырых цветов нет),
  `base.css`, компоненты `Button`, `TextField`/`TextArea`, `Check`/`Radio`/`Select`, `Fieldset`, `Hint`,
  `Status`, `Card`, `Row`, `Progress`.
- Поля ввода неуправляемые и работают на нативных событиях: `onInput` — каждое нажатие, `onCommit` —
  потеря фокуса или Enter. Значение из main не затирает поле, пока в нём печатают.
- Плашка и карточка продаж (отдельные маленькие окна) — без React: короткий TS с анимацией.
- e2e опирается на `data-*`, id и классы разметки — при переделке страниц их нужно сохранять.

## Данные и секреты

- `chawo.db` (в локальной папке данных) — SQLite через встроенный `node:sqlite`: история диктовок и журнал
  «В CRM». WAL (приложение пишет, CLI читает), миграции по `PRAGMA user_version`, `secure_delete` и
  усечение WAL после удаления — стёртый текст не остаётся в файле. Старые `history.jsonl` и
  `crm-sent.json` импортируются при первом запуске и остаются рядом как `.bak`.
- Секреты (ключи облачного Мозга, токены CRM) — в системном хранилище ключей через `@napi-rs/keyring`,
  общем для приложения и CLI. Где его нет — `secrets.json` рядом с настройками (0600);
  `CHAWO_SECRETS=file` включает этот режим явно (портативная установка, e2e). Ключи, запечатанные
  прежней версией в `settings.json` (safeStorage), переносятся в хранилище при первом запуске.
- Тесты пользуются хранилищем в памяти (`fixtures/setup/vault.ts`) и не трогают настоящее.

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

### Playwright

```bash
pnpm e2e:pw                                            # build + playwright test (apps/desktop/e2e)
cd apps/desktop && xvfb-run -a pnpm exec playwright test   # Linux без дисплея, уже собранное приложение
pnpm --filter @chawo/desktop exec playwright test -g История --trace on
```

Сценарии ведут окно как пользователь — кликами, клавиатурой, вводом текста — через `_electron` из
`@playwright/test` (браузеры Playwright не нужны: запускается сам Electron). Каждый тест стартует
`out/main/main.js` в своём временном профиле (`e2e/fixtures.ts`): секреты в `secrets.json` профиля,
не в системном хранилище. Профиль заполняется до запуска:
`test.use({ seed: { settings: { Brain: 'Server' }, history: ['…'] } })`. Ошибка в консоли окна,
необработанное исключение или падение рендерера проваливают тест. При падении в
`apps/desktop/test-results` остаются трассировка (`npx playwright show-trace …/trace.zip`) и скриншот;
в CI они в артефакте `playwright-report`.

Что покрыто: запуск и тёмная тема, все страницы из меню (мышью и с клавиатуры), изоляция страницы
(нет Node/Electron, только API контракта, `contextIsolation`/`sandbox`), запрет сети и перехода на
внешние адреса, словарь после перезапуска, поиск и удаление в истории (в том числе из chawo.db),
«Контекст для Мозга» и его сохранение. Новые сценарии — сюда, длинные конвейеры с фейковыми
серверами — по-прежнему в `scripts/e2e-smoke.cjs`.

Ручная проверка сервера:

```bash
pnpm cli serve --port 17899 --model-dir /path/v3-e2e-rnnt &
pnpm cli transcribe a.wav --server http://127.0.0.1:17899 -f txt,srt,vtt,json,md,docx -o /tmp/out
```

## CI

| Workflow | Когда | Что |
|----------|-------|-----|
| `ts-e2e.yml` | push в `main`, `ts-port`, `ts/**`; PR в `main`/`ts-port` (пути `apps/**`, `packages/**`, …) | типы, ESLint, Knip, юнит-тесты, e2e-смоук и сценарии Playwright под xvfb |
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
