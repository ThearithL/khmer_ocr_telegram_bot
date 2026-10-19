import hashlib
import hmac
import json
import logging
import os
from contextlib import asynccontextmanager
from urllib.parse import parse_qsl

import cv2
import numpy as np
import pytesseract
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from telegram import KeyboardButton, ReplyKeyboardMarkup, Update, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
PUBLIC_URL = os.getenv("PUBLIC_URL", "http://localhost:8000").rstrip("/")
DEV_MODE = os.getenv("DEV_MODE", "0") == "1"
MAX_FILE_BYTES = int(os.getenv("MAX_FILE_BYTES", str(10 * 1024 * 1024)))

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("khmer-ocr-bot")

telegram_app: Application | None = None


def validate_init_data(init_data: str) -> bool:
    """Validate Telegram Mini App initData using the bot token."""
    if DEV_MODE:
        return True
    if not BOT_TOKEN or not init_data:
        return False

    try:
        data = dict(parse_qsl(init_data, keep_blank_values=True))
        received_hash = data.pop("hash", None)
        if not received_hash:
            return False

        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(calculated_hash, received_hash)
    except Exception:
        logger.exception("Failed to validate Telegram initData")
        return False


def preprocess_image(raw: bytes) -> np.ndarray:
    arr = np.frombuffer(raw, np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Unsupported or damaged image")

    # Keep OCR fast on very large phone photos.
    h, w = image.shape[:2]
    longest = max(h, w)
    if longest > 2200:
        scale = 2200 / longest
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.bilateralFilter(gray, 7, 45, 45)
    thresholded = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31,
        11,
    )
    return thresholded


def run_ocr(image: np.ndarray, language: str) -> str:
    lang_map = {
        "khm": "khm",
        "eng": "eng",
        "khm+eng": "khm+eng",
    }
    lang = lang_map.get(language, "khm+eng")
    text = pytesseract.image_to_string(image, lang=lang, config="--psm 6")
    return text.strip()


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return

    keyboard = ReplyKeyboardMarkup(
        [[KeyboardButton("📷 Open Khmer OCR", web_app=WebAppInfo(url=PUBLIC_URL))]],
        resize_keyboard=True,
        is_persistent=True,
    )

    await update.message.reply_text(
        "🇰🇭 Khmer OCR Bot\n\n"
        "ផ្ញើរូបភាពដោយផ្ទាល់មក Bot ឬចុចប៊ូតុងខាងក្រោមដើម្បីប្រើ Mini App។\n\n"
        "Send an image directly, or open the Mini App below.",
        reply_markup=keyboard,
    )


async def image_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.photo:
        return

    status = await update.message.reply_text("⏳ កំពុងអានអក្សរ... / Reading text...")
    try:
        photo = update.message.photo[-1]
        tg_file = await context.bot.get_file(photo.file_id)
        data = bytes(await tg_file.download_as_bytearray())
        image = preprocess_image(data)
        text = run_ocr(image, "khm+eng")

        if not text:
            await status.edit_text(
                "⚠️ មិនអាចរកឃើញអក្សរ។ សូមផ្ញើរូបភាពច្បាស់ជាងនេះ។\n"
                "No text detected. Try a clearer image."
            )
            return

        await status.delete()
        if len(text) <= 3900:
            await update.message.reply_text(f"✅ OCR Result:\n\n{text}")
        else:
            payload = text.encode("utf-8")
            from io import BytesIO

            f = BytesIO(payload)
            f.name = "ocr-result.txt"
            await update.message.reply_document(f, caption="✅ OCR result is too long, so I sent it as a text file.")
    except Exception as exc:
        logger.exception("Direct image OCR failed")
        await status.edit_text(f"❌ OCR failed: {exc}")


async def web_app_data(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.web_app_data:
        return
    try:
        data = json.loads(update.message.web_app_data.data)
        text = str(data.get("text", "")).strip()
        if text:
            await update.message.reply_text(f"📥 Text from Mini App:\n\n{text[:3900]}")
    except Exception:
        await update.message.reply_text("⚠️ Could not read Mini App data.")


async def start_bot() -> None:
    global telegram_app
    if not BOT_TOKEN:
        logger.warning("BOT_TOKEN is missing; web app will run without Telegram polling")
        return

    telegram_app = Application.builder().token(BOT_TOKEN).build()
    telegram_app.add_handler(CommandHandler("start", start_command))
    telegram_app.add_handler(MessageHandler(filters.PHOTO, image_message))
    telegram_app.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, web_app_data))

    await telegram_app.initialize()
    await telegram_app.start()
    if telegram_app.updater:
        await telegram_app.updater.start_polling(drop_pending_updates=True)
    logger.info("Telegram bot polling started")


async def stop_bot() -> None:
    global telegram_app
    if not telegram_app:
        return
    if telegram_app.updater:
        await telegram_app.updater.stop()
    await telegram_app.stop()
    await telegram_app.shutdown()
    telegram_app = None
    logger.info("Telegram bot stopped")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await start_bot()
    yield
    await stop_bot()


app = FastAPI(title="Khmer OCR Telegram Bot", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def home():
    with open("static/index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/health")
async def health():
    return {"ok": True, "bot_enabled": bool(BOT_TOKEN)}


@app.post("/api/ocr")
async def ocr_endpoint(
    image: UploadFile = File(...),
    x_telegram_init_data: str = Header(default=""),
    x_ocr_language: str = Header(default="khm+eng"),
):
    if not validate_init_data(x_telegram_init_data):
        raise HTTPException(status_code=401, detail="Open this Mini App from Telegram")

    if image.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="Use JPG, PNG, or WEBP")

    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty image")
    if len(raw) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large")

    try:
        processed = preprocess_image(raw)
        text = run_ocr(processed, x_ocr_language)
        return {"ok": True, "text": text, "language": x_ocr_language}
    except Exception as exc:
        logger.exception("Mini App OCR failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
