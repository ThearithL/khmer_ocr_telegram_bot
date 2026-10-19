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
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite").strip()

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


def send_long_message(chat_id: int, text: str):
    text = text.strip()
    if not text:
        return
    max_len = 3500
    remaining = text
    chunks = []
    while remaining:
        if len(remaining) <= max_len:
            chunks.append(remaining)
            break
        cut = remaining.rfind("\n", 0, max_len)
        if cut < max_len // 2:
            cut = remaining.rfind(" ", 0, max_len)
        if cut < max_len // 2:
            cut = max_len
        chunks.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    for i, chunk in enumerate(chunks, 1):
        prefix = f"✅ OCR Result ({i}/{len(chunks)}):\n\n" if len(chunks) > 1 else "✅ OCR Result:\n\n"
        send_message(chat_id, prefix + chunk)


def app_keyboard(url: str | None = None):
    app_url = url or PUBLIC_URL
    return {
        "keyboard": [[{"text": "📷 Open Khmer OCR", "web_app": {"url": app_url}}]],
        "resize_keyboard": True,
        "is_persistent": True,
    }


def parse_init_data(init_data: str) -> dict | None:
    if not BOT_TOKEN or not init_data:
        return None
    try:
        data = dict(parse_qsl(init_data, keep_blank_values=True))
        received_hash = data.pop("hash", None)
        if not received_hash:
            return None
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated_hash, received_hash):
            return None
        return data
    except Exception:
        return None


def validate_init_data(init_data: str) -> bool:
    return parse_init_data(init_data) is not None


def gemini_request(parts: list[dict]) -> tuple[str, str]:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not configured")

    models = [GEMINI_MODEL]
    if GEMINI_MODEL != "gemini-2.5-flash-lite":
        models.append("gemini-2.5-flash-lite")

    last_error = None
    for model in models:
        try:
            response = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
                json={
                    "contents": [{"role": "user", "parts": parts}],
                    "generationConfig": {"temperature": 0.0, "maxOutputTokens": 16384},
                },
                timeout=75,
            )
            data = response.json() if response.content else {}
            if not response.ok:
                detail = data.get("error", {}).get("message") or f"Gemini HTTP {response.status_code}"
                raise RuntimeError(detail)
            candidates = data.get("candidates") or []
            if not candidates:
                raise RuntimeError("Gemini returned no text")
            out = "".join(
                str(p.get("text", ""))
                for p in candidates[0].get("content", {}).get("parts", [])
            ).strip()
            if not out:
                raise RuntimeError("Gemini returned empty text")
            return out, model
        except Exception as exc:
            last_error = exc
            msg = str(exc).lower()
            if "404" not in msg and "not found" not in msg and "not supported" not in msg:
                break
    raise RuntimeError(str(last_error or "Gemini request failed"))


def handle_update(update: dict):
    message = update.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    if not chat_id:
        return

    text = message.get("text", "")
    if text.startswith("/start"):
        send_message(
            chat_id,
            "🇰🇭 Khmer OCR Bot\n\nផ្ញើរូបភាពមក Bot ឬបើក Mini App ដើម្បីបម្លែងរូបភាពទៅជាអត្ថបទខ្មែរ។\n\nSend a photo or open the Mini App to convert an image to Khmer text.",
            app_keyboard(),
        )
        return

    if message.get("photo"):
        file_id = message["photo"][-1].get("file_id")
        url = f"{PUBLIC_URL}/?file_id={quote(file_id, safe='')}"
        send_message(
            chat_id,
            "📷 រូបភាពបានទទួល។ ចុចប៊ូតុងខាងក្រោមដើម្បីអានអក្សរខ្មែរ។\nPhoto received. Open the Mini App to scan it.",
            app_keyboard(url),
        )
        return

    wad = message.get("web_app_data")
    if wad:
        try:
            data = json.loads(wad.get("data", "{}"))
            ocr_text = str(data.get("text", "")).strip()
            if ocr_text:
                send_long_message(chat_id, ocr_text)
        except Exception:
            send_message(chat_id, "⚠️ Could not read Mini App result.")
        return

    send_message(chat_id, "📷 Send an image or tap Open Khmer OCR.", app_keyboard())


@app.get("/")
def home():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/health")
def health():
    return {
        "ok": True,
        "bot_configured": bool(BOT_TOKEN),
        "public_url": bool(PUBLIC_URL),
        "ocr_mode": "free-browser-tesseract",
        "ai_fix": bool(GEMINI_API_KEY),
        "ai_image_verify": bool(GEMINI_API_KEY),
        "ai_model": GEMINI_MODEL if GEMINI_API_KEY else None,
    }


@app.get("/api/webhook")
def webhook_health():
    return {"ok": True, "service": "telegram-webhook"}


@app.post("/api/webhook")
async def webhook(request: Request, x_telegram_bot_api_secret_token: str | None = Header(default=None)):
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
    result = telegram_api("setWebhook", payload)
    return {"ok": True, "webhook": f"{PUBLIC_URL}/api/webhook", "result": result}


@app.post("/api/ai-fix")
async def ai_fix(request: Request):
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="AI Fix is not configured. Add GEMINI_API_KEY in Vercel Production env and redeploy.")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    text = str(body.get("text", "")).strip()
    language = str(body.get("language", "khm")).strip()
    image_b64 = str(body.get("image", "")).strip() or None
    image_mime = str(body.get("image_mime", "")).strip() or None
    if not text:
        raise HTTPException(status_code=400, detail="OCR text is empty")
    if len(text) > 60000:
        raise HTTPException(status_code=413, detail="Text is too long")

    language_note = {
        "khm": "The document is primarily Khmer.",
        "khm+eng": "The document may contain Khmer and English.",
        "eng": "The document is primarily English.",
    }.get(language, "The document is primarily Khmer.")

    prompt = (
        "You are a high-accuracy document transcription verifier. The ORIGINAL IMAGE is the source of truth. "
        "Compare the OCR draft against the image line by line. Return a complete corrected transcription containing only text visibly present in the image. "
        "Correct Khmer character, vowel/diacritic, punctuation, spacing, number, and OCR-garbage errors only when supported by the image. "
        "Preserve paragraph order, headings, names, dates, numbers, and abbreviations. Do not summarize, translate, paraphrase, or invent text. "
        f"{language_note} Return ONLY corrected document text.\n\nOCR DRAFT:\n{text}"
    )
    parts = [{"text": prompt}]
    image_used = False
    if image_b64:
        if image_mime not in {"image/jpeg", "image/png", "image/webp"}:
            raise HTTPException(status_code=400, detail="Unsupported image type")
        try:
            decoded = base64.b64decode(image_b64, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid image data")
        if len(decoded) > 7 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image is too large")
        parts = [{"inline_data": {"mime_type": image_mime, "data": image_b64}}, {"text": prompt}]
        image_used = True

    try:
        corrected, model = gemini_request(parts)
        return {"ok": True, "text": corrected, "model": model, "image_verified": image_used}
    except Exception as exc:
        print("AI Fix error:", repr(exc))
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/send-text")
async def send_text_to_user(request: Request, x_telegram_init_data: str | None = Header(default=None)):
    init_data = parse_init_data(x_telegram_init_data or "")
    if not init_data:
        raise HTTPException(status_code=401, detail="Open this Mini App from Telegram")
    try:
        user = json.loads(init_data.get("user", "{}"))
        chat_id = int(user.get("id"))
        body = await request.json()
        text = str(body.get("text", "")).strip()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request")
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty")
    send_long_message(chat_id, text)
    return {"ok": True, "characters": len(text)}


@app.get("/api/telegram-image")
def telegram_image(file_id: str = Query(...), x_telegram_init_data: str | None = Header(default=None)):
    if not validate_init_data(x_telegram_init_data or ""):
        raise HTTPException(status_code=401, detail="Open this Mini App from Telegram")
    try:
        info = telegram_api("getFile", {"file_id": file_id})
        file_path = info.get("file_path")
        if not file_path:
            raise RuntimeError("Telegram did not return a file path")
        response = requests.get(f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}", timeout=25)
        response.raise_for_status()
        return Response(
            content=response.content,
            media_type=response.headers.get("Content-Type", "image/jpeg"),
            headers={"Cache-Control": "private, max-age=60"},
        )
    except Exception as exc:
        print("Telegram image error:", repr(exc))
        raise HTTPException(status_code=500, detail="Could not load Telegram image")
