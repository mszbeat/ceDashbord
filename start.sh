#!/usr/bin/env bash
# اجرای هر دو سرویس در پیشزمین (Ctrl+C هر دو را متوقف میکند)
set -e
cd "$(dirname "$0")"
mkdir -p logs

echo "▶ بکاند NestJS  → http://localhost:3000/api"
echo "▶ فرانتاند Next → http://localhost:3001"
echo "▶ لاگها: logs/backend.log و logs/frontend.log"

./backend/start.sh > logs/backend.log 2>&1 &
BACK_PID=$!
./frontend/start.sh > logs/frontend.log 2>&1 &
FRONT_PID=$!

cleanup() {
  kill "$BACK_PID" "$FRONT_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

wait
