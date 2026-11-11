#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/backend"
echo "=== اجرای migration روی PostgreSQL جانبی ==="
npm run migrate
