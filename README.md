# Khmer OCR Telegram Bot + Mini App

A Python Telegram bot and Telegram Mini App for **Khmer/English image-to-text OCR**.

## Features

- 🇰🇭 Khmer OCR (`khm`)
- 🇬🇧 English OCR (`eng`)
- Khmer + English mixed OCR (`khm+eng`)
- Telegram Mini App image upload + preview
- Direct image scanning inside Telegram bot chat
- Copy / clear / send result to bot
- OpenCV preprocessing for clearer OCR
- Telegram Mini App `initData` validation
- Docker setup with Tesseract Khmer language pack
- `/health` endpoint for hosting health checks

## 1. Create your Telegram bot

1. Open **@BotFather** in Telegram.
2. Run `/newbot`.
3. Copy your bot token.
4. Keep it secret.

## 2. Run locally

Docker is recommended because Khmer Tesseract must be installed.

```bash
docker build -t khmer-ocr-bot .
docker run --rm -p 8000:8000 \
  -e BOT_TOKEN="YOUR_TOKEN" \
  -e PUBLIC_URL="https://YOUR_HTTPS_URL" \
  -e DEV_MODE=1 \
  khmer-ocr-bot
```

Open `http://localhost:8000` for browser testing. `DEV_MODE=1` bypasses Telegram Mini App authentication and should only be used locally.

## 3. Deploy to Render

1. Push this project to GitHub.
2. In Render choose **New → Web Service**.
3. Connect the repository.
4. Render will detect the `Dockerfile`.
5. Add environment variables:

```text
BOT_TOKEN=your_bot_token
PUBLIC_URL=https://your-service.onrender.com
DEV_MODE=0
```

6. Deploy.
7. Update `PUBLIC_URL` to the final Render URL if necessary and redeploy.

## 4. Configure the Mini App in BotFather

For the persistent Mini App button, you can configure your bot's menu button in BotFather using your HTTPS `PUBLIC_URL`.

The bot also shows a Telegram Web App keyboard button after `/start`.

## Important security notes

- Never commit your `.env` or bot token.
- Keep `DEV_MODE=0` in production.
- The OCR API validates Telegram `initData` in production.
- Default maximum image size is 10 MB.

## Improve Khmer OCR accuracy

Use:

- Sharp, high-resolution photos
- Straight documents
- Good lighting
- Dark text on a light background
- Minimal shadows

The included preprocessing converts the image to grayscale and adaptive thresholding before OCR.
"# khmer_ocr_telegram_bot" 
