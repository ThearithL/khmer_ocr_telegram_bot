import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
from urllib.parse import parse_qsl, quote

import requests
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")
TELEGRAM_WEBHOOK_SECRET = os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()
SETUP_SECRET = os.getenv("SETUP_SECRET", "").strip()
GOOGLE_VISION_API_KEY = os.getenv("GOOGLE_VISION_API_KEY", "").strip()

app = FastAPI(title="Khmer OCR Telegram Bot")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


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


def google_vision_ocr(image_bytes: bytes, language: str = "khm") -> str:
    if not GOOGLE_VISION_API_KEY:
        raise RuntimeError("GOOGLE_VISION_API_KEY is not configured")

    language_hints = {
        "khm": ["km"],
        "khm+eng": ["km", "en"],
        "eng": ["en"],
    }.get(language, ["km"])

    payload = {
        "requests": [
            {
                "image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
                "imageContext": {"languageHints": language_hints},
            }
        ]
    }

    response = requests.post(
        "https://vision.googleapis.com/v1/images:annotate",
        params={"key": GOOGLE_VISION_API_KEY},
        json=payload,
        timeout=45,
    )

    try:
        data = response.json()
    except Exception:
        data = {}

    if not response.ok:
        detail = data.get("error", {}).get("message") or f"Google Vision HTTP {response.status_code}"
        raise RuntimeError(detail)

    item = (data.get("responses") or [{}])[0]
    if item.get("error"):
        raise RuntimeError(item["error"].get("message", "Google Vision OCR failed"))

    annotation = item.get("fullTextAnnotation") or {}
    text = str(annotation.get("text") or "").strip()
    if text:
        return text

    text_annotations = item.get("textAnnotations") or []
    if text_annotations:
        return str(text_annotations[0].get("description") or "").strip()

    return ""


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


@app.get("/")
def home():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/health")
def health():
    return {
        "ok": True,
        "bot_configured": bool(BOT_TOKEN),
        "public_url": bool(PUBLIC_URL),
        "google_vision": bool(GOOGLE_VISION_API_KEY),
    }


@app.get("/api/webhook")
def webhook_health():
    return {"ok": True, "service": "telegram-webhook"}


@app.post("/api/webhook")
async def webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
):
    if TELEGRAM_WEBHOOK_SECRET and x_telegram_bot_api_secret_token != TELEGRAM_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    try:
        update = await request.json()
        handle_update(update)
        return {"ok": True}
    except Exception as exc:
        print("Webhook error:", repr(exc))
        return JSONResponse(status_code=200, content={"ok": False, "error": "handler failure"})


@app.post("/api/setup")
def setup(x_setup_secret: str | None = Header(default=None)):
    if not SETUP_SECRET or x_setup_secret != SETUP_SECRET:
        raise HTTPException(status_code=401, detail="Invalid setup secret")
    if not BOT_TOKEN or not PUBLIC_URL:
        raise HTTPException(status_code=500, detail="BOT_TOKEN or PUBLIC_URL missing")

    payload = {
        "url": f"{PUBLIC_URL}/api/webhook",
        "allowed_updates": ["message"],
        "drop_pending_updates": True,
    }
    if TELEGRAM_WEBHOOK_SECRET:
        payload["secret_token"] = TELEGRAM_WEBHOOK_SECRET

    try:
        result = telegram_api("setWebhook", payload)
        return {"ok": True, "webhook": f"{PUBLIC_URL}/api/webhook", "result": result}
    except Exception as exc:
        print("Setup error:", repr(exc))
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/ocr")
async def ocr(request: Request, language: str = Query(default="khm")):
    if not GOOGLE_VISION_API_KEY:
        raise HTTPException(status_code=503, detail="Google Vision OCR is not configured")

    content_type = (request.headers.get("content-type") or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Send an image as the request body")

    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image is empty")
    if len(image_bytes) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image is too large")

    try:
        text = google_vision_ocr(image_bytes, language)
        return {"ok": True, "provider": "google-vision", "text": text}
    except Exception as exc:
        print("Google Vision OCR error:", repr(exc))
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/telegram-image")
def telegram_image(
    file_id: str = Query(...),
    x_telegram_init_data: str | None = Header(default=None),
):
    if not validate_init_data(x_telegram_init_data or ""):
        raise HTTPException(status_code=401, detail="Open this Mini App from Telegram")

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
        return Response(
            content=response.content,
            media_type=response.headers.get("Content-Type", "image/jpeg"),
            headers={"Cache-Control": "private, max-age=60"},
        )
    except HTTPException:
        raise
    except Exception as exc:
        print("Telegram image error:", repr(exc))
        raise HTTPException(status_code=500, detail="Could not load Telegram image")
