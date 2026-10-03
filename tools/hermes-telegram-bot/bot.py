#!/usr/bin/env python3
"""Forward a Telegram voice note to Giga Pisar Hermes and reply with the text.

Run this on the Windows host (or any PC that can reach it). The phone only
forwards a voice message to the bot. Nothing here downloads a speech model.
Qwen is not started: a phone cannot carry Qwen 3.5, and this bot does not
either. The brain stays in Giga Pisar on the PC.

Stdlib only. Python 3.9+.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "bot-config.json"
API = "https://api.telegram.org/bot{token}/{method}"


def load_config() -> tuple[str, str]:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    hermes = os.environ.get("HERMES_URL", "").strip()
    if CONFIG.exists():
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
        token = token or str(data.get("telegram_bot_token", "")).strip()
        hermes = hermes or str(data.get("hermes_url", "")).strip()
    if not hermes:
        hermes = "http://127.0.0.1:17831"
    hermes = hermes.rstrip("/")
    if not token or token.startswith("PASTE_"):
        print("Нет токена. Скопируйте bot-config.example.json в bot-config.json и вставьте токен BotFather.", file=sys.stderr)
        sys.exit(2)
    return token, hermes


def call(token: str, method: str, payload: dict | None = None, timeout: int = 70) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API.format(token=token, method=method),
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    if not body.get("ok"):
        raise RuntimeError(body.get("description") or method)
    return body["result"]


def download_file(token: str, file_id: str) -> tuple[bytes, str]:
    info = call(token, "getFile", {"file_id": file_id}, timeout=30)
    path = info["file_path"]
    url = f"https://api.telegram.org/file/bot{token}/{path}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        blob = resp.read()
    kind = "audio/ogg" if path.endswith(".ogg") or path.endswith(".opus") else "application/octet-stream"
    return blob, kind


def transcribe(hermes: str, blob: bytes, kind: str) -> str:
    url = hermes + "/v1/transcribe"
    req = urllib.request.Request(url, data=blob, method="POST", headers={"Content-Type": kind})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as ex:
        detail = ex.read().decode("utf-8", "replace")
        if ex.code == 503:
            raise RuntimeError("Хост на связи, но модель там не загружена.")
        raise RuntimeError(f"Хост ответил {ex.code}. {detail[:180]}")
    except urllib.error.URLError:
        raise RuntimeError("Хост не отвечает. Проверьте адрес и что Писарь запущен, а порт открыт.")
    text = payload.get("text")
    if not isinstance(text, str):
        raise RuntimeError("Хост ответил не текстом.")
    return text.strip()


def voice_id(msg: dict) -> str | None:
    voice = msg.get("voice") or msg.get("audio")
    if isinstance(voice, dict) and voice.get("file_id"):
        return voice["file_id"]
    doc = msg.get("document")
    if isinstance(doc, dict) and str(doc.get("mime_type", "")).startswith("audio/") and doc.get("file_id"):
        return doc["file_id"]
    return None


def reply(token: str, chat_id: int, text: str) -> None:
    call(token, "sendMessage", {"chat_id": chat_id, "text": text[:4000]}, timeout=30)


def main() -> None:
    token, hermes = load_config()
    print(f"Бот слушает Telegram. Расшифровка: {hermes}/v1/transcribe", flush=True)
    offset = 0
    while True:
        try:
            updates = call(token, "getUpdates", {"timeout": 50, "offset": offset}, timeout=70)
        except Exception as ex:
            print(f"telegram: {ex}", flush=True)
            time.sleep(3)
            continue
        for upd in updates:
            offset = int(upd["update_id"]) + 1
            msg = upd.get("message") or upd.get("channel_post") or {}
            chat = msg.get("chat") or {}
            chat_id = chat.get("id")
            if chat_id is None:
                continue
            fid = voice_id(msg)
            if not fid:
                if msg.get("text"):
                    reply(token, chat_id, "Пришлите или перешлите голосовое. Текст придёт ответом. Модель на телефоне не качается.")
                continue
            try:
                blob, kind = download_file(token, fid)
                text = transcribe(hermes, blob, kind)
                reply(token, chat_id, text or "Пусто. На записи не разобрал речь.")
            except Exception as ex:
                reply(token, chat_id, str(ex))


if __name__ == "__main__":
    main()
