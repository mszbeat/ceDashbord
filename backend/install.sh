#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "=== backend: نصب وابستگی‌ها (partFramework) ==="
npm install
echo ""
echo "✅ backend آماده است: ./start.sh"
