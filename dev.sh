#!/usr/bin/env bash
# حالت توسعه: watch روی بکاند و Hot Reload روی فرانتاند
set -e
cd "$(dirname "$0")"
mkdir -p logs

( cd backend && npm run start:dev ) > logs/backend-dev.log 2>&1 &
BACK_PID=$!
( cd frontend && npm run dev ) > logs/frontend-dev.log 2>&1 &
FRONT_PID=$!

cleanup() { kill "$BACK_PID" "$FRONT_PID" 2>/dev/null || true; }
trap cleanup INT TERM EXIT
wait
