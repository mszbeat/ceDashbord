#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "############################################################"
echo "# نصب CE Dashboard Server (بدون Docker)                    #"
echo "# پیشفرض: Node.js و PostgreSQL روی سرور نصب هستند          #"
echo "############################################################"
chmod +x backend/install.sh frontend/install.sh
./backend/install.sh
./frontend/install.sh
echo ""
echo "✅ نصب تمام شد."
echo "   cp backend/.env.example backend/.env  → سپس مقادیر را تنظیم کن"
echo "   ./migrate.sh"
echo "   ./start.sh        # بکاند :3000 + فرانتاند :3001"
echo "   ./ingest.sh --mode=nightly"
