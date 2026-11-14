#!/usr/bin/env bash
# مثال:
#   ./ingest.sh --mode=nightly
#   ./ingest.sh --mode=intraday
#   ./ingest.sh --day=1405-08-18 --mode=nightly
#   ./ingest.sh --days=7
#   ./ingest.sh --bank=tavan_mellat --day=1405-08-19 --rebuild  (پاک کردن و ساخت دوبارهٔ همان روز)
#   ./ingest.sh --help
set -e
cd "$(dirname "$0")/backend"
npm run ingest -- "$@"
