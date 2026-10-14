# Linux-сервер расшифровки — `chawo-va serve`

Headless CPU-сервер транскрипции на том же Node/TS + ONNX стеке, что CLI `chawo-va transcribe`. **Никуда не деплоим из этого репозитория** — хостинг выбираете сами (VPS / своя машина).

## Согласованные решения

| Тема | Решение |
|------|---------|
| Железо | Linux, **только CPU** (без GPU) |
| Нагрузка | 1–5 человек **и** несколько длинных файлов параллельно (очередь + пул воркеров) |
| API | Hermes HTTP `/v1/health`, `/v1/transcribe` — **та же JSON-форма**, что Windows Hermes; плюс async Job API |
| CLI | На сервере: `chawo-va serve`; с клиента: `chawo-va transcribe --server URL --token …` |
| Доступ | **Токен обязателен**, чтобы слушать не-localhost (`--token` / `CHAWO_SERVE_TOKEN`) |
| Хранение | Артефакты заданий на диске **2 часа**, затем автоудаление |
| Мозг / Telegram / OpenAI SaaS | **Вне scope** |
| Стек | Node 20+ / TypeScript / `onnxruntime-node` (не Python, не .NET) |
| Модель по умолчанию | `v3_e2e_rnnt` (как CLI), CPU |
| Токен | Только `Authorization: Bearer …` (не query) |
| Форматы | Hermes POST: raw WAV/Ogg как раньше; jobs: тот же decode chain, что CLI (WAV/Ogg native, ffmpeg при наличии) |
| Порт | **17831** (как Hermes), переопределяется `--port` |

## Установка

Нужны Linux x64, **Node.js 20+**, `git`; для MP3/M4A/… в заданиях — `ffmpeg` (WAV/Ogg читаются без него).

```bash
sudo apt-get install -y nodejs npm ffmpeg   # или Node 20 из nodesource / nvm
git clone https://github.com/zai-one/chawo-va.git /opt/chawo-va
cd /opt/chawo-va/ts
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci     # Electron серверу не нужен
npm run build
node dist/cli.js --version                  # chawo-va 2.0.0
```

### Модель

Сервер **не скачивает** веса. Нужна папка с `v3_e2e_rnnt_encoder.onnx`, `v3_e2e_rnnt_decoder.onnx`,
`v3_e2e_rnnt_joint.onnx`, `v3_e2e_rnnt_tokenizer.model`, `v3_e2e_rnnt.yaml` — та же, что скачивает приложение
(`%LOCALAPPDATA%\ChawoVoiceAssistant\models\v3-e2e-rnnt` на Windows). Скопируйте её на сервер и
укажите `--model-dir`, либо задайте `CHAWO_MODEL_DIR` (каталог моделей). Для большой модели —
`--model ctc`.

### Только localhost (без токена)

```bash
node dist/cli.js serve --port 17831 --model-dir /var/lib/chawo-va/models/v3-e2e-rnnt
# Слушаю 127.0.0.1:17831 · модель v3_e2e_rnnt · CPU · воркеров N · данные … · только localhost (без токена)
```

### Наружу / LAN (токен обязателен)

```bash
export CHAWO_SERVE_TOKEN="$(openssl rand -hex 32)"
node dist/cli.js serve --host 0.0.0.0 --port 17831 --model-dir /var/lib/chawo-va/models/v3-e2e-rnnt
```

С токеном `--host` по умолчанию `0.0.0.0`. Без токена процесс **откажется** слушать не-loopback
(код 2). Токен — только в `Authorization: Bearer …`, не в URL. Для доступа из интернета ставьте
перед сервером TLS-прокси (nginx/Caddy): сам сервер говорит только HTTP.

### Токен

- Источник: `--token` или `CHAWO_SERVE_TOKEN` (флаг важнее).
- Запросы с loopback (`127.0.0.1`, `::1`) проходят без заголовка.
- Остальные: без/с неверным токеном — `401 {"error":"unauthorized"}`.
- Если токена нет, а запрос пришёл не с loopback — `403 {"error":"localhost_only"}`.
- Сменить токен = перезапустить сервис с новым значением.

### Данные и TTL

- Каталог: `--data-dir` → `CHAWO_SERVE_DATA_DIR` → `$XDG_DATA_HOME/chawo-serve` → `~/.local/share/chawo-serve` → `/tmp/chawo-serve`.
- `jobs/<id>/`: исходное аудио, `meta.json`, `result.txt`.
- **TTL 2 часа** от создания задания (любой статус); проверка раз в минуту; `ttl_ms` есть в ответе.
- После перезапуска незавершённые задания снова встают в очередь, просроченные удаляются.
- `DELETE /v1/jobs/{id}` удаляет сразу (и прерывает идущее).

### Лимиты

| Что | Значение |
|-----|----------|
| Размер тела POST | до 1 800 000 000 байт; нужен `Content-Length` (chunked → 400) |
| Воркеры заданий | 1–5, по ядрам/RAM/`--threads` (видно в `/v1/health` → `jobs.workers`) |
| Синхронный `/v1/transcribe` | последовательно, одна общая модель; для длинных файлов — задания |
| Заголовки | до 64 КБ, таймаут заголовков 60 с; тело без таймаута |
| Форматы | `/v1/transcribe`: WAV, Ogg/Opus; задания: + всё, что умеет ffmpeg |
| Устройство | только CPU |

### systemd

Пример юнита: [`packaging/systemd/chawo-va-serve.service`](../packaging/systemd/chawo-va-serve.service).

```bash
sudo useradd --system --home /var/lib/chawo-va --shell /usr/sbin/nologin chawo
sudo mkdir -p /var/lib/chawo-va/{models,serve} /etc/chawo-va
sudo cp -r v3-e2e-rnnt /var/lib/chawo-va/models/
sudo chown -R chawo:chawo /var/lib/chawo-va
echo "CHAWO_SERVE_TOKEN=$(openssl rand -hex 32)" | sudo tee /etc/chawo-va/serve.env
sudo chmod 600 /etc/chawo-va/serve.env
sudo cp packaging/systemd/chawo-va-serve.service /etc/systemd/system/
# в юните: поправьте --model-dir, уберите Environment=CHAWO_SERVE_TOKEN=change-me,
# раскомментируйте EnvironmentFile=-/etc/chawo-va/serve.env
sudo systemctl daemon-reload
sudo systemctl enable --now chawo-va-serve
journalctl -u chawo-va-serve -f
```

## HTTP API

Полная спецификация: **[`openapi.yaml`](openapi.yaml)** (OpenAPI 3.1, проверяется тестом
`ts/test/openapi.test.ts`: валидность и совпадение со списком маршрутов в коде).
Каждый путь `/v1/…` доступен и без префикса (`/health`, `/transcribe`, `/jobs`, `/jobs/{id}`).
Все ответы — JSON. Неизвестный маршрут — `404 {"error":"not_found"}`.

| Метод | Путь | Ответ |
|-------|------|-------|
| `GET` | `/v1/health` | 200 — статус и очередь |
| `POST` | `/v1/transcribe` | 200 — текст (синхронно, Hermes) |
| `POST` | `/v1/jobs` | 201 — задание `queued` |
| `GET` | `/v1/jobs/{id}` | 200 — статус, текст, `segments` / 404 |
| `DELETE` | `/v1/jobs/{id}` | 200 `{ok, id}` / 404 |

Ошибки: `400` (`empty_body`, `bad_audio`, `bad_request` + `detail`), `401 unauthorized`,
`403 localhost_only`, `404 not_found`, `503 model_not_loaded`.

### Примеры curl

```bash
S=http://127.0.0.1:17831
AUTH="Authorization: Bearer $CHAWO_SERVE_TOKEN"   # с loopback можно не передавать

curl -s -H "$AUTH" $S/v1/health
# {"ok":true,"model_loaded":true,"model":"v3_e2e_rnnt","device":"cpu","provider":"cpu",
#  "port":17831,"listen":"0.0.0.0","jobs":{"workers":4,"queued":0,"active":0}}

# Синхронно (короткие WAV/Ogg)
curl -s -H "$AUTH" -H 'Content-Type: audio/wav' --data-binary @short.wav $S/v1/transcribe
# {"text":"…","model":"v3_e2e_rnnt","device":"cpu","provider":"cpu","sample_rate":16000,"seconds":1.23}

# То же multipart (как Telegram-бот)
curl -s -H "$AUTH" -F file=@voice.ogg $S/v1/transcribe

# Задание для длинного файла
ID=$(curl -s -H "$AUTH" -H 'Content-Type: application/octet-stream' \
  -H 'Content-Disposition: attachment; filename="meeting.mp3"' \
  --data-binary @meeting.mp3 $S/v1/jobs | jq -r .id)
curl -s -H "$AUTH" $S/v1/jobs/$ID | jq '{status, seconds, text, segments: (.segments|length)}'
# status: queued → running → done | error
curl -s -H "$AUTH" -X DELETE $S/v1/jobs/$ID
# {"ok":true,"id":"…"}
```

Готовое задание:

```json
{ "id": "3f2a…", "status": "done", "created_at": "2026-10-13T18:00:00.000Z", "updated_at": "…",
  "filename": "meeting.mp3", "bytes": 3200044, "text": "Привет.\nЭто проверка.", "result_path": "result.txt",
  "error": null, "seconds": 100, "model": "v3_e2e_rnnt", "device": "cpu",
  "segments": [ { "start": 0, "end": 1.2, "text": "Привет." }, { "start": 1.5, "end": 3.1, "text": "Это проверка." } ],
  "ttl_ms": 7200000 }
```

## Клиент

```bash
chawo-va transcribe запись.wav --server http://127.0.0.1:17831
chawo-va transcribe длинный.mp3 --server http://host:17831 --token "$CHAWO_SERVE_TOKEN" \
  -o /tmp/out -f txt,srt,vtt,json,md,docx --timestamps
```

Клиент шлёт файл в `POST /v1/jobs`, опрашивает `GET /v1/jobs/{id}` и по `segments` пишет те же
форматы, что и локальный запуск. Без `--server` CLI работает как раньше (локальная модель).

## Вне scope

- Деплой на конкретный хостинг
- GPU, облачный ASR, платный OpenAI-совместимый SaaS
- Облачный «мозг», Telegram-бот на сервере
- TLS внутри процесса (используйте обратный прокси)
