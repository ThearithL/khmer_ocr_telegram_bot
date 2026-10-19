import os
from http.server import BaseHTTPRequestHandler

from api._common import BOT_TOKEN, PUBLIC_URL, json_response, telegram_api


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        expected = os.getenv("SETUP_SECRET", "").strip()
        received = self.headers.get("X-Setup-Secret", "")
        if not expected or received != expected:
            json_response(self, 401, {"ok": False, "detail": "Invalid setup secret"})
            return
        if not BOT_TOKEN or not PUBLIC_URL:
            json_response(self, 500, {"ok": False, "detail": "BOT_TOKEN or PUBLIC_URL missing"})
            return

        webhook_secret = os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()
        payload = {
            "url": f"{PUBLIC_URL}/api/webhook",
            "allowed_updates": ["message"],
            "drop_pending_updates": True,
        }
        if webhook_secret:
            payload["secret_token"] = webhook_secret

        try:
            result = telegram_api("setWebhook", payload)
            json_response(self, 200, {"ok": True, "webhook": f"{PUBLIC_URL}/api/webhook", "result": result})
        except Exception as exc:
            print("Setup error:", repr(exc))
            json_response(self, 500, {"ok": False, "detail": str(exc)})
