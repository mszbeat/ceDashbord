#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -f dist/main.js ]; then npm run build; fi
echo "=== اجرای بکاند روی پورت ${BACKEND_PORT:-3000} ==="
npm run start:prod
