#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "=== frontend: نصب وابستگیها ==="
npm install
echo "=== frontend: build Next.js ==="
npm run build
echo ""
echo "✅ frontend آماده است: ./start.sh"
