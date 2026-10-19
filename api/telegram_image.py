from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

from api._common import BOT_TOKEN, json_response, telegram_api, validate_init_data


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        init_data = self.headers.get("X-Telegram-Init-Data", "")
        if not validate_init_data(init_data):
            json_response(self, 401, {"ok": False, "detail": "Open this Mini App from Telegram"})
            return

        params = parse_qs(urlparse(self.path).query)
        file_id = (params.get("file_id") or [""])[0]
        if not file_id:
            json_response(self, 400, {"ok": False, "detail": "Missing file_id"})
            return

        try:
            info = telegram_api("getFile", {"file_id": file_id})
            file_path = info.get("file_path")
            if not file_path:
                raise RuntimeError("Telegram did not return a file path")
            response = requests.get(
                f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}",
                timeout=25,
            )
            response.raise_for_status()
            data = response.content
            content_type = response.headers.get("Content-Type", "image/jpeg")
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "private, max-age=60")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            print("Telegram image error:", repr(exc))
            json_response(self, 500, {"ok": False, "detail": "Could not load Telegram image"})
