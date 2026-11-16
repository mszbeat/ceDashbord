#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "############################################################"
echo "# نصب CE Dashboard Server (partFramework + Next.js)        #"
echo "# پیشفرض: Node.js، PostgreSQL و Redis روی سرور نصب هستند   #"
echo "############################################################"
chmod +x backend/install.sh frontend/install.sh
./backend/install.sh
./frontend/install.sh
echo ""
echo "✅ نصب تمام شد."
echo "   cp backend/.env.example backend/.env  → سپس مقادیر را تنظیم کن"
echo "   ./migrate.sh"
echo "   (cd backend && npm run samad:assign)  # تخصیص دسترسی‌های routes.js در سمد"
echo "   ./start.sh        # بکاند :3000 + فرانتاند :3001"
echo "   ./ingest.sh --mode=nightly"
