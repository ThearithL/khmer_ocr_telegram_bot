# Khmer OCR Telegram Bot — Vercel Edition

Telegram bot + Telegram Mini App for Khmer image-to-text OCR.

This Vercel build uses Telegram webhooks instead of polling and runs OCR in the browser with Tesseract.js, so it does not require Docker or a native Tesseract package.

## Features
- Khmer / English / Khmer+English OCR
- Telegram Mini App
- Upload JPG, PNG, WEBP
- OCR progress
- Copy and send result back to Telegram
- Send a photo to the bot, then open it in the Mini App
- Python webhook endpoints on Vercel

## Required environment variables
- `BOT_TOKEN`
- `PUBLIC_URL`
- `TELEGRAM_WEBHOOK_SECRET`
- `SETUP_SECRET`

## Deploy
1. Import this repository into Vercel.
2. Add the environment variables above.
3. Deploy.
4. Register the webhook with `POST /api/setup` and header `X-Setup-Secret`.

Never commit real secrets to GitHub.
