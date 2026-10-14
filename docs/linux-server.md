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

## Установка (кратко)

```bash
git clone https://github.com/zai-one/chawo-va.git
cd chawo-va/ts
npm ci
npm run build
# Модель v3 скачайте в приложении или положите в каталог и укажите --model-dir / CHAWO_MODEL_DIR
```

### Только localhost (без токена)

```bash
node dist/cli.js serve --port 17831 --model-dir /path/to/v3_e2e_rnnt
# слушает 127.0.0.1:17831
```

### Наружу / LAN (токен обязателен)

```bash
export CHAWO_SERVE_TOKEN='замените-на-длинный-секрет'
node dist/cli.js serve --host 0.0.0.0 --port 17831 --token "$CHAWO_SERVE_TOKEN" --model-dir /path/to/v3_e2e_rnnt
```

Без токена процесс **откажется** биндиться на `0.0.0.0`.

### Данные и TTL

- Каталог: `--data-dir` / `CHAWO_SERVE_DATA_DIR`, иначе `~/.local/share/chawo-serve` (или `/tmp/chawo-serve`).
- Подкаталог `jobs/<id>/`: исходное аудио, `meta.json`, `result.txt`.
- Через **2 часа** после создания задания файлы удаляются фоновым sweeper.

### systemd

Юнит-пример: [`packaging/systemd/chawo-va-serve.service`](../packaging/systemd/chawo-va-serve.service).

```bash
sudo cp packaging/systemd/chawo-va-serve.service /etc/systemd/system/
# поправьте пути, User=, CHAWO_SERVE_TOKEN (лучше EnvironmentFile)
sudo systemctl daemon-reload
sudo systemctl enable --now chawo-va-serve
```

## HTTP API

### `GET /v1/health` (и `/health`)

```json
{ "ok": true, "model_loaded": true, "model": "v3_e2e_rnnt", "device": "cpu", "provider": "cpu",
  "port": 17831, "listen": "127.0.0.1", "jobs": { "workers": 2, "queued": 0, "active": 0 } }
```

### `POST /v1/transcribe` (и `/transcribe`)

Как Hermes: тело — raw WAV/Ogg или первый part `multipart/form-data`, нужен `Content-Length`. Ответ:

```json
{ "text": "…", "model": "v3_e2e_rnnt", "device": "cpu", "provider": "cpu", "sample_rate": 16000, "seconds": 1.23 }
```

### Job API (длинные файлы)

| Метод | Путь | Смысл |
|-------|------|--------|
| `POST` | `/v1/jobs` | Загрузить аудио → `{ id, status: "queued", … }` (201) |
| `GET` | `/v1/jobs/:id` | Статус / текст / ошибка |
| `DELETE` | `/v1/jobs/:id` | Удалить задание и файлы |

Статусы: `queued` → `running` → `done` | `error`.

### Авторизация

- Запросы с **не-loopback** адреса: нужен `Authorization: Bearer <token>` (если токен задан; без токена наружу сервер не слушает).
- **Loopback** (`127.0.0.1` / `::1`): без заголовка можно (удобно для локальной проверки).

## Клиент

```bash
chawo-va transcribe запись.wav --server http://127.0.0.1:17831
chawo-va transcribe длинный.mp3 --server http://host:17831 --token "$CHAWO_SERVE_TOKEN" -o /tmp/out
```

Без `--server` поведение CLI как раньше (локальная модель).

## Проверка

```bash
curl -s http://127.0.0.1:17831/v1/health
curl -s -X POST http://127.0.0.1:17831/v1/transcribe \
  -H 'Content-Type: audio/wav' --data-binary @short.wav
```

## Вне scope (по-прежнему)

- Деплой на конкретный хостинг / bump до 2.1.0
- GPU, облачный ASR, платный OpenAI-совместимый SaaS
- Облачный «мозг», Telegram-бот на сервере
- Полная OpenAPI-спека (можно добавить позже)
