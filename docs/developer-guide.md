# Руководство разработчика

Поставляемое приложение 2.0 — Electron + TypeScript (pnpm-монорепозиторий: `apps/`, `packages/`).
Старое WPF-приложение (1.x) удалено, оно есть в истории git. План модернизации —
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
pnpm --filter @chawo/desktop check:fuses release/win-unpacked/ChawoVoiceAssistant.exe
node apps/desktop/scripts/check-packaged.mjs <exe>      # окно собранного пакета (Playwright по CDP)
```

Сборка (`apps/desktop/electron.vite.config.ts`): main и CLI — CommonJS, один файл на исходный модуль
(`out/main/<путь в репозитории>.js`, точки входа — `out/main/main.js` и `out/main/cli.js`); четыре
sandbox-preload — по одному файлу; страницы интерфейса — `out/renderer/*.html`. Версия приложения
(`__CHAWO_VERSION__`) подставляется при сборке из `apps/desktop/package.json`.

Страницы открываются не с `file://`, а со своей схемы `chawo-app://bundle/<страница>.html`
(`src/main/appProtocol.ts`): отдаются только файлы из `out/renderer`, у страниц настоящий origin
(`'self'` в CSP — ровно сборка) и защищённый контекст (микрофон, AudioWorklet). В `pnpm dev` — по-прежнему
dev-сервер на localhost.

### Fuses

В пакете выключено всё, чем можно запустить в приложении чужой код (`build.electronFuses` в
`apps/desktop/package.json`, ставит electron-builder):

| Fuse | | Зачем |
|---|---|---|
| `RunAsNode` | вкл. | `chawo-va.cmd` запускает CLI тем же exe (`ELECTRON_RUN_AS_NODE`) |
| `EnableNodeOptionsEnvironmentVariable` | выкл. | `NODE_OPTIONS` не подмешивает модули |
| `EnableNodeCliInspectArguments` | выкл. | нет `--inspect` (поэтому Playwright `_electron` не запускает пакет — для него `check-packaged.mjs` по CDP) |
| `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` | вкл. | код только из `app.asar`, подмена файла в нём ломает запуск |
| `GrantFileProtocolExtraPrivileges` | выкл. | у `file://` нет лишних прав (страницы и так на `chawo-app://`) |
| `EnableCookieEncryption` | вкл. | cookies на диске шифруются |

CI (`ts-windows.yml`) сверяет fuses собранного exe (`scripts/check-fuses.mjs`) и запускает его окно
(`scripts/check-packaged.mjs`). Сценарии Playwright можно прогнать на Electron с теми же fuses:
`CHAWO_E2E_ELECTRON=<копия electron с перевёрнутыми fuses> pnpm exec playwright test` (кроме
`OnlyLoadAppFromAsar` и `--inspect`, без которых несобранное приложение не запустить).

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
  `Status`, `Card`, `Row`, `Progress`, `Icon` (иконки Product UI: Lucide 0.577, обводка 1.75) и
  `ChawoLogo`/`ChawoMark` (знак бренда как есть, без перерисовки).
- Дизайн берётся из бренд-системы ZAI (`zai-one/zai-brand`): Chawo — один из трёх брендов, приложение —
  тёмная тема Product UI Core. Значения `tokens.css` скопированы из `tokens/product-ui.css`: песочный
  акцент — главное действие и выбранное, красный (`--danger`) — только то, что ждёт действия человека,
  граница контрола `--control-border` держит 3:1. DIN Pro — гарнитура бренда, но в установщик не
  входит (лицензия шрифта): стек падает на системный шрифт, если DIN Pro не установлен.
- Меню слева — паттерн SideNav из Product UI: иконка и название, свёрнутое — полоса иконок с
  подсказками (`app/navState.ts`, Ctrl+B). Свёрнутость — предпочтение этого компьютера (localStorage),
  нечитаемое значение открывает меню.
- Поля ввода неуправляемые и работают на нативных событиях: `onInput` — каждое нажатие, `onCommit` —
  потеря фокуса или Enter. Значение из main не затирает поле, пока в нём печатают.
- Плашка, карточка продаж, плеер озвучки и кнопка «Озвучить» (отдельные маленькие окна) — без React:
  короткий TS. У каждого свой preload и свои каналы (`player:*`, `pill:*`) с проверкой отправителя в main.
- e2e опирается на `data-*`, id и классы разметки — при переделке страниц их нужно сохранять.

## Данные и секреты

- `chawo.db` (в локальной папке данных) — SQLite через встроенный `node:sqlite`: история диктовок и журнал
  «В CRM». WAL (приложение пишет, CLI читает), миграции по `PRAGMA user_version`, `secure_delete` и
  усечение WAL после удаления — стёртый текст не остаётся в файле. Старые `history.jsonl` и
  `crm-sent.json` импортируются при первом запуске: история (текст диктовок) сразу удаляется,
  журнал CRM остаётся рядом как `.bak`.
- «Место на диске» (`packages/engine/src/cleanup/`): `scan()` ищет известные остатки только в папках
  приложения и старых версий, `remove(ids)` сканирует заново и удаляет лишь найденное. Используемое
  (выбранные модели, движок, файл, который пишется последние 10 минут) не предлагается; записи и
  скачанное — только с расшифровкой рядом. Страница — `CleanupBox.tsx` на «Распознавании»
  (`cleanup:*` в контракте), CLI — `chawo-va cleanup`.
- Секреты (ключи облачного Мозга, токены CRM) — в системном хранилище ключей через `@napi-rs/keyring`,
  общем для приложения и CLI. Где его нет — `secrets.json` рядом с настройками (0600);
  `CHAWO_SECRETS=file` включает этот режим явно (портативная установка, e2e). Ключи, запечатанные
  прежней версией в `settings.json` (safeStorage), переносятся в хранилище при первом запуске.
- Озвучка (`packages/engine/src/tts/`): `ttsProviders.ts` — пресеты сервисов, `ttsClient.ts` — три вида
  запроса (OpenAI-совместимый `/audio/speech`, Xiaomi MiMo `chat/completions` с `audio`, Gemini
  `generateContent` с AUDIO), нарезка длинного текста и склейка WAV/MP3; `voicePage.ts` — страница «Голос».
  HTTP идёт из main (`apps/desktop/src/main/voiceIpc.ts`), звук уходит в окно плеера байтами и играет из Blob.
  Скорость меняет плеер (`playbackRate`), сервису она не передаётся. Ключ — `ProviderKeys[id]`, общий с Мозгом.
  Кнопка у выделения: ChawoNative по `selwatch 1` ставит мышиный хук и шлёт `mup x y` после выделения
  мышью; main спрашивает выделение через `selprobe` (только UI Automation) и показывает кнопку у курсора.
  Клавиша — `ttskey <vk>`, событие `tts`.
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
| `ts-windows.yml` | push в `main`, `ts-port`, `ts/**`, теги `v*`, PR | Windows-пакет, подпись (если настроена), fuses, смоук пакета и его окна; на теге — вложения релиза |

Dependabot (`.github/dependabot.yml`) раз в неделю предлагает обновления npm-пакетов и actions —
группами (Electron, React, инструменты, прочее), минорные и патчи; мажорные — по одному. Релиз
должен быть не моложе трёх дней. TypeScript 7 не предлагается, пока его не поддержит typescript-eslint.

## Релиз

1. Поднимите `version` в `apps/desktop/package.json` (одна версия для приложения и CLI) и упоминания версии в README/доках;
   заметки к релизу — `docs/releases/vX.Y.Z.md` (CI подставит их в GitHub Release).
2. PR в `main`, дождитесь зелёного CI, merge commit.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` — `ts-windows.yml` соберёт
   `ChawoVoiceAssistant-X.Y.Z-Setup.exe` и `…-win-x64.zip` и приложит к GitHub Release.
   Без права пушить теги — то же вручную: Actions → TS Windows → Run workflow на `main`, поле
   `release` = `vX.Y.Z` (тег создаётся на этом коммите; должен совпадать с версией в package.json).
4. Веса моделей в артефакты не входят.

### Подпись

Сборка подписывается сама, как только в репозитории появятся данные для подписи (Settings → Secrets and
variables → Actions); в репозитории ключей нет. `scripts/signing-config.mjs` выбирает способ:

- **Azure Trusted Signing** — secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` и
  variables `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER`;
- **сертификат .pfx** — secrets `WIN_CSC_LINK` (base64 файла) и `WIN_CSC_KEY_PASSWORD`; SHA-256 и
  метка времени RFC 3161;
- ничего не задано — сборка без подписи, как раньше.

При включённой подписи CI проверяет подписи `Setup.exe` и `ChawoVoiceAssistant.exe`. Автообновление
(`electron-updater`) имеет смысл включать только после подписи.

## Правила

Только тёмная тема, без телеметрии, ключей в репозитории нет, локально по умолчанию, короткие меню.
