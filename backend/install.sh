#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "=== backend: نصب وابستگیها ==="
npm install
echo "=== backend: build NestJS ==="
npm run build
echo ""
echo "✅ backend آماده است."
echo "   ۱) .env.example را به .env کپی و DATABASE_URL / CE_GATEWAY_TOKEN را تنظیم کن"
echo "   ۲) npm run migrate"
echo "   ۳) npm run ingest   (یا ./start.sh برای اجرای سرویس)"
