#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "=== اجرای بکاند partFramework روی پورت ${BACKEND_PORT:-3000} ==="
npm start
