#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_PATH="${NODE_PATH:-/home/user/bench/node_modules}"
PORT=4571 SMOKE_MODE=v1 PER_BANK=120 node smoke/server-v2.js >/tmp/s1.log 2>&1 &
P1=$!
PORT=4572 SMOKE_MODE=v2 PER_BANK=120 node smoke/server-v2.js >/tmp/s2.log 2>&1 &
P2=$!
cleanup(){ kill $P1 $P2 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 60); do
  grep -q "smoke server" /tmp/s1.log 2>/dev/null && grep -q "smoke server" /tmp/s2.log 2>/dev/null && break
  sleep 1
done
node smoke/compare.js
