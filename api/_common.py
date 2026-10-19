import hashlib
import hmac
import json
import os
from urllib.parse import parse_qsl

import requests

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")


def telegram_api(method: str, payload: dict | None = None, timeout: int = 20):
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is not configured")
    response = requests.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
        json=payload or {},
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("description", "Telegram API error"))
    return data.get("result")


def send_message(chat_id: int, text: str, reply_markup: dict | None = None):
    payload = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return telegram_api("sendMessage", payload)


def app_keyboard(url: str | None = None):
    app_url = url or PUBLIC_URL
    return {
        "keyboard": [[{"text": "📷 Open Khmer OCR", "web_app": {"url": app_url}}]],
        "resize_keyboard": True,
        "is_persistent": True,
    }


def validate_init_data(init_data: str) -> bool:
    if not BOT_TOKEN or not init_data:
        return False
    try:
        data = dict(parse_qsl(init_data, keep_blank_values=True))
        received_hash = data.pop("hash", None)
        if not received_hash:
            return False
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(calculated_hash, received_hash)
    except Exception:
        return False


def json_response(handler, status: int, payload: dict):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)
