#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "=== اجرای pd2 (partFramework) روی پورت ${BACKEND_PORT:-3000} ==="
npm start
