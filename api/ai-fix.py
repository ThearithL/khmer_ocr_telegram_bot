import json
import os
from http.server import BaseHTTPRequestHandler

import requests

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite").strip()


def _json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _prompt(text, language):
    note = {
        "khm": "The document is primarily Khmer.",
        "khm+eng": "The document may contain Khmer and English.",
        "eng": "The document is primarily English.",
    }.get(language, "The document is primarily Khmer.")
    return (
        "You are verifying OCR against the ORIGINAL document image. "
        "The image is the source of truth. Read it carefully and correct the OCR draft so the output matches the visible document. "
        "Correct Khmer letters, vowels, subscripts, spacing, punctuation, dates, numbers and official abbreviations only when supported by the image. "
        "Remove OCR garbage that is not visible in the image. Preserve headings, paragraph order and line structure as closely as practical. "
        "Do not summarize, translate, paraphrase, add facts, or invent missing text. If something is unclear, keep the OCR draft rather than guessing. "
        f"{note} Return ONLY the corrected document text, with no explanation.\n\nOCR DRAFT:\n{text}"
    )


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not GEMINI_API_KEY:
            return _json(self, 503, {"detail": "GEMINI_API_KEY is not configured"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 12_000_000:
                return _json(self, 413, {"detail": "Request is empty or too large"})
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return _json(self, 400, {"detail": "Invalid JSON request"})

        text = str(body.get("text", "")).strip()
        language = str(body.get("language", "khm")).strip()
        image = str(body.get("image", "")).strip()
        image_mime = str(body.get("image_mime", "image/jpeg")).strip() or "image/jpeg"

        if not text:
            return _json(self, 400, {"detail": "OCR text is empty"})
        if not image:
            return _json(self, 400, {"detail": "Original image is required for AI Check"})
        if len(text) > 60000:
            return _json(self, 413, {"detail": "OCR text is too long for one AI check"})

        payload = {
            "contents": [{
                "parts": [
                    {"text": _prompt(text, language)},
                    {"inline_data": {"mime_type": image_mime, "data": image}},
                ]
            }],
            "generationConfig": {
                "temperature": 0.05,
                "maxOutputTokens": 16384,
            },
        }

        try:
            response = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                params={"key": GEMINI_API_KEY},
                json=payload,
                timeout=70,
            )
            try:
                data = response.json()
            except Exception:
                data = {}

            if not response.ok:
                detail = data.get("error", {}).get("message") or f"Gemini HTTP {response.status_code}"
                return _json(self, 502, {"detail": detail, "gemini_status": response.status_code})

            candidates = data.get("candidates") or []
            if not candidates:
                return _json(self, 502, {"detail": "Gemini returned no corrected text"})
            parts = candidates[0].get("content", {}).get("parts", [])
            corrected = "".join(str(part.get("text", "")) for part in parts).strip()
            if not corrected:
                return _json(self, 502, {"detail": "Gemini returned empty corrected text"})

            return _json(self, 200, {
                "ok": True,
                "text": corrected,
                "model": GEMINI_MODEL,
                "image_verified": True,
            })
        except requests.Timeout:
            return _json(self, 504, {"detail": "AI request timed out. Try again."})
        except Exception as exc:
            return _json(self, 500, {"detail": f"AI server error: {exc}"})

    def do_GET(self):
        return _json(self, 200, {
            "ok": True,
            "service": "ai-fix",
            "configured": bool(GEMINI_API_KEY),
            "model": GEMINI_MODEL if GEMINI_API_KEY else None,
        })
