#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d .next ]; then npm run build; fi
echo "=== اجرای فرانتاند روی پورت 3001 ==="
npm run start
