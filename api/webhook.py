import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import quote

from api._common import PUBLIC_URL, app_keyboard, json_response, send_message


def handle_update(update: dict):
    message = update.get("message") or {}
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if not chat_id:
        return

    text = message.get("text", "")
    if text.startswith("/start"):
        send_message(
            chat_id,
            "🇰🇭 Khmer OCR Bot\n\n"
            "ផ្ញើរូបភាពមក Bot ឬបើក Mini App ដើម្បីបម្លែងរូបភាពទៅជាអត្ថបទខ្មែរ។\n\n"
            "Send a photo or open the Mini App to convert an image to Khmer text.",
            app_keyboard(),
        )
        return

    if message.get("photo"):
        photo = message["photo"][-1]
        file_id = photo.get("file_id")
        url = f"{PUBLIC_URL}/?file_id={quote(file_id, safe='')}"
        send_message(
            chat_id,
            "📷 រូបភាពបានទទួល។ ចុចប៊ូតុងខាងក្រោមដើម្បីអានអក្សរខ្មែរ។\n"
            "Photo received. Open the Mini App to scan it.",
            app_keyboard(url),
        )
        return

    wad = message.get("web_app_data")
    if wad:
        try:
            data = json.loads(wad.get("data", "{}"))
            ocr_text = str(data.get("text", "")).strip()
            if ocr_text:
                send_message(chat_id, f"✅ OCR Result:\n\n{ocr_text[:3900]}")
            else:
                send_message(chat_id, "⚠️ No OCR text received.")
        except Exception:
            send_message(chat_id, "⚠️ Could not read Mini App result.")
        return

    send_message(chat_id, "📷 Send an image or tap “Open Khmer OCR”.", app_keyboard())


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        json_response(self, 200, {"ok": True, "service": "telegram-webhook"})

    def do_POST(self):
        expected = os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()
        received = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if expected and received != expected:
            json_response(self, 401, {"ok": False, "error": "invalid webhook secret"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            update = json.loads(self.rfile.read(length) or b"{}")
            handle_update(update)
            json_response(self, 200, {"ok": True})
        except Exception as exc:
            print("Webhook error:", repr(exc))
            json_response(self, 200, {"ok": False, "error": "handler failure"})
