# CE Dashboard Server — نسخه سروری

پیادهسازی صفر تا صد PRD `CE-Dashboard-Server-PRD.md` با ساختار `frontend/` + `backend/`، **بدون Docker**. نصب Node.js و PostgreSQL بر عهده شماست؛ اسکریپتها فقط پروژه را نصب، مایگریشن، اجرا و Ingestion میکنند.

> نسخه ۱ فقط **بانک ملت (`tavan_mellat`)** فعال است. رسالت و پستبانک بعد از تست تطبیق اضافه میشوند؛ سپاه خارج از دامنه v1 است.

---

## تصمیمهای ثبتشده

| موضوع | انتخاب |
|---|---|
| فرانتاند | Next.js 14 + React 18 + Tailwind CSS |
| بکاند | NestJS 10 + PostgreSQL (`pg`) |
| اولین بانک | ملت |
| احراز هویت | فعلاً ندارد؛ بعداً با سرویس بومی شرکت وصل میشود |
| اجرا | `install.sh` / `start.sh` / `migrate.sh` / `ingest.sh` در ریشه و هر پوشه |
| Push | همین ریپو، برنچ `main` با Deploy Key (بعداً انتقال به ریپوی سازمانی) |
| Docker Compose | حذف شد |

---

## ساختار

```
ce-dashboard-server/
├── install.sh              # نصب هر دو پوشه
├── start.sh                # اجرای بکاند :3000 + فرانتاند :3001
├── dev.sh                  # حالت توسعه با watch
├── migrate.sh              # ساخت جداول PostgreSQL
├── ingest.sh               # اجرای Ingestion (شبانه / میانروز / بکفیل)
├── backend/
│   ├── install.sh
│   ├── start.sh
│   ├── .env.example
│   ├── package.json
│   ├── src/
│   │   ├── main.ts
│   │   ├── config.ts
│   │   ├── db/               # schema.sql + migrate.js + DatabaseService
│   │   ├── evaluator/
│   │   │   ├── legacy/       # کپی banks/* و src/* از ریپو قدیمی (قواعد دستنخورده)
│   │   │   ├── legacy-report/# buildAiInput.js + aiInputKeyMaps.js از report/
│   │   │   ├── evaluator.service.ts   # استخراج analyzeOne بهعنوان کتابخانه (M1)
│   │   │   └── evaluator.test.ts      # تست تطبیق روی نمونه ملت
│   │   ├── ingestion/        # Worker صفحهای + checkpoint + advisory lock
│   │   ├── summary/          # Web API فقطخواندنی + پروکسی جزئیات
│   │   └── utils/date.ts     # تاریخ شمسی با timezone Asia/Tehran
│   └── test-data/mellat-sample.json
└── frontend/
    ├── install.sh
    ├── start.sh
    ├── .env.example
    ├── app/
    │   ├── layout.tsx        # RTL / فارسی
    │   ├── page.tsx          # داشبورد کامل
    │   ├── api.ts
    │   └── globals.css
    ├── next.config.js        # پروکسی /api به بکاند
    └── tailwind.config.js
```

---

## M0 — باگهایی که قبل از هر کاری رفع شد

همانطور که PRD §1.3 گفته بود، یک جایگزینی متنی سراسری کد قدیمی را خراب کرده بود:

| فایل | قبل | بعد |
|---|---|---|
| `banks/resalat.js` | `rotbce-dashboardta` | `rotbeData` |
| `banks/postbank.js` | `rotbce-dashboardta` | `rotbeData` |
| `src/data-monitoring.js` | `approvce-dashboardmount` | `approvedAmount` |
| `src/credit-alerts.js` | `chequCEdashboardte` | `chequeDate` |

الان `node --check` روی همه فایلهای legacy پاس میشود و `loadBanks()` هر سه بانک را لود میکند. قواعد تحلیل **بازنویسی نشدهاند**؛ فقط `analyzeOne` از `src/analyze.js` به یک تابع قابل فراخوانی (`createEvaluator`) استخراج شده است.

---

## نصب و اجرا

### ۱) پیشنیازها (با خودتان)

```bash
node -v        # >= 18، پیشنهاد 20
psql --version # PostgreSQL 14+ 
createdb ce_dashboard
# یا:
# sudo -u postgres psql -c "CREATE USER ce_user WITH PASSWORD 'ce_pass';"
# sudo -u postgres psql -c "CREATE DATABASE ce_dashboard OWNER ce_user;"
```

### ۲) تنظیم متغیرها

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

`backend/.env` مهمترین مقادیر:

```env
DATABASE_URL=postgres://ce_user:ce_pass@localhost:5432/ce_dashboard
CE_API_BASE_URL=http://creditevaluation-v2.ara.partdp.ir/creditEvaluation@2/report
CE_GATEWAY_TOKEN=توکن_واقعی
BACKEND_PORT=3000
```

> هدرهای `gateway-system` و `gateway-token` دقیقاً مثل `report/src/config.js` قدیمی ارسال میشوند. توکن دیگر داخل کد نیست.

### ۳) نصب

```bash
./install.sh
# یا جداگانه:
./backend/install.sh
./frontend/install.sh
```

### ۴) ساخت جداول

```bash
./migrate.sh
```

جداول: `day_runs`، `samples_mellat`، `message_dict`، `sample_access_logs`.

### ۵) اجرا

```bash
./start.sh
```

- بکاند: `http://localhost:3000/api/health`
- فرانتاند: `http://localhost:3001`
- مرورگر فقط `/api/...` را صدا میزند؛ `next.config.js` آن را به بکاند پروکسی میکند (پس در محیط Preview هم `localhost` مرورگر مشکلی ایجاد نمیکند).

لاگها در `logs/backend.log` و `logs/frontend.log`.

حالت توسعه:

```bash
./dev.sh
```

---

## Ingestion

```bash
# نهاییسازی خودکار دیروز (پیشفرض)
./ingest.sh --mode=nightly

# میانروز: بازخوانی کامل روز جاری، وضعیت partial
./ingest.sh --mode=intraday

# یک روز مشخص
./ingest.sh --day=1405-08-18 --mode=nightly

# بکفیل ۷ روز قبل تا دیروز
./ingest.sh --days=7
```

رفتار:

1. قفل `pg_advisory_lock` روی `(bank, day)` تا دو اجرا همزمان نشوند.
2. `source_total` از `page=1&limit=1` خوانده میشود.
3. صفحهها با `limit=50` پشتسرهم گرفته میشوند.
4. هر گزارش با همان `buildAiInput.js` نرمال میشود؛ موفق/ناموفق دقیقاً با همان چهار پیام انگلیسی `isReportSuccess` مشخص میشود.
5. `analyzeOne` قدیمی اجرا میشود و فقط ردیف تحلیلشده با `ON CONFLICT(request_id) DO UPDATE` در PostgreSQL ذخیره میشود. **گزارش خام، کد ملی، متن آزاد پیام و نام شعبه ذخیره نمیشود.**
6. بعد از هر صفحه `checkpoint` در `day_runs` بهروز میشود؛ اجرای بعدی از همانجا ادامه پیدا میکند.
7. شبانه: `complete` (یا `needs_review` اگر مغایرت/پرش باشد). میانروز: همیشه `partial`.

### زمانبندی پیشنهادی (cron روی سرور، timezone Tehran)

```cron
30 0 * * *  cd /path/ce-dashboard-server && ./ingest.sh --mode=nightly >> logs/cron-nightly.log 2>&1
*/30 8-20 * * * cd /path/ce-dashboard-server && ./ingest.sh --mode=intraday >> logs/cron-intraday.log 2>&1
```

---

## API بکاند

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/health` | سلامت سرویس |
| GET | `/api/banks` | بانکهای فعال |
| GET | `/api/specs?bank=tavan_mellat` | تعریف شاخصها، دستهها، متریکها، موضوعات |
| GET | `/api/summary?bank=&from=&to=` | آمار کامل: KPI، `percentile_cont`، هیستوگرام،flags،دستهها،سرویسها،کیفیت داده،روند روزانه،اجراها |
| GET | `/api/list?bank=&from=&to=&type=flag&id=rotbeNull&limit=100&offset=0` | فهرست حداکثر ۱۰۰تایی + `COUNT(*) OVER()` |
| GET | `/api/list?...&type=metric&id=totalTime` | مرتبسازی بر مقدار عددی در SQL |
| GET | `/api/list?...&type=cat&id=depositLength&value=empty` | فیلتر روی مقدار دسته |
| GET | `/api/list?...&type=slow` | گزارشهای کندتر از ۴ ثانیه |
| GET | `/api/sample/{requestId}` | پروکسی لحظهای به API اصلی؛ `no-store` + لاگ ممیزی |
| GET | `/api/runs` | وضعیت اجراها |
| POST | `/api/runs` | اجرای دستی `{ "bank", "day", "mode" }` |

`from`/`to` شمسی `YYYY-MM-DD` یا `YYYY/MM/DD` قبول میکند. پیشفرض ۳۰ روز اخیر تهران است.

---

## نکات طراحی مهم

- **همان قواعد، تجمیع متفاوت:** بهجای `stats.metrics[id].push(...)` در RAM، مقادیر در `metrics JSONB` ذخیره و چارکها با `percentile_cont` در SQL گرفته میشوند.
- **پیامها:** `messageSuccess` / `messageFail` قدیمی متن آزاد پیام را نگه میداشتند. اینجا به کلید پایدار (`MSG_VALIDATION_SUCCESS` و …) تبدیل میشوند؛ برچسب فارسی آنها در `message_dict` است. پیام ناشناخته فقط هش کوتاه میگیرد، متنش ذخیره نمیشود.
- **PD دقیقاً ۰٫۵:** مقدار خام و بدون گردکردن ذخیره میشود و هیستوگرام PD ردیف مستقل «دقیقاً ۰٫۵۰» دارد.
- **ملت:** طبق `overviewNote` قدیمی، `output.Credit_Basket` توان بازپرداخت (ریال) است؛ `amount_kind=repayment_capacity` گذاشته شده تا با سبد ردهای `Tavan_Baz_Pardakht` اشتباه نشود.
- **نمونه کامل:** فقط با کلیک روی `request_id` و با فیلتر همان شناسه از API اصلی گرفته میشود؛ پاسخ `Cache-Control: no-store` دارد، کد ملی/`sourceIp` از پاسخ حذف میشود و فقط یک ردیف ممیزی در `sample_access_logs` ثبت میشود.
- **احراز هویت:** فعلاً `POST /api/runs` و مشاهده جزئیات باز هستند. ساختار طوری است که بعداً یک Guard سرویس بومی شرکت به `SummaryController` / `IngestionController` اضافه شود.

---

## تست تطبیق

```bash
cd backend
npm test
```

خروجی نمونه:

```
✅ evaluator parity test passed: { requestId: ..., flags: 10, metrics: 27, cats: 7, paths: 4, services: 5 }
```

این تست روی `test-data/mellat-sample.json` بررسی میکند که `requestId`، `PD=0.5`، `total_time=0.04`، ۱۰ فلگ فعال، وضعیت سرویس `iran=failed` و حذف متن پیام/کد ملی با کد قدیمی همخوانی دارد.

---

## موارد باز (از PRD)

- **D-01:** ترتیب/کرسر API برای میانروز قطعی نیست. فعلاً گزینه B پیاده شده: میانروز کل روز جاری را از صفحه ۱ بازخوانی میکند و چون `upsert` است تکراری ایجاد نمیشود. اگر API ترتیب پایدار دارد، بعداً به گزینه A (ادامه از checkpoint) تغییر میدهیم.
- **D-02..D-12:** نوع آرایه فلگها، حداکثر لیست، rollup، قالب پیام، زمانبندی دقیق، retention، SSO، autoBank، سطح جزئیات و ذخیره `uniqueKey` همچنان در PRD باز هستند. تصمیمهای پیشفرض این نسخه: لیست حداکثر ۱۰۰، بدون rollup جداگانه (SQL مستقیم)، بدون retention خودکار، بدون SSO، بدون autoBank، `uniqueKey` ذخیره نمیشود.
- **M5:** اضافهشدن رسالت و پستبانک، بکفیل کامل و سختسازی باقی مانده است.
- **Sepah:** طبق PRD خارج از v1.

---

## Push با Deploy Key

1. در گیتاب: `Settings → Deploy keys → Add deploy key`، تیک **Allow write access** را بزن.
2. کلید خصوصی را به من بده/آپلود کن؛ کلون SSH میشود (`git@github.com:mszbeat/ceDashbord.git`).
3. کامیت روی `main` Push میشود. اگر Branch Protection روی `main` فعال باشد، Push مستقیم رد میشود — در آن صورت یا موقتاً برداشته شود یا یک برنچ `server-dashboard` استفاده شود.
4. محدودیت Deploy Key: فقط همین ریپو؛ امکان PR / Issue / Release / تنظیمات ریپو ندارد. بعد از تحویل حتماً Rotate کن.
5. هیچ کلید خصوصی و هیچ توکنی کامیت نمیشود؛ `.env` در `.gitignore` است.

---

## عیبیابی کوتاه

| خطا | بررسی |
|---|---|
| `DATABASE_URL تنظیم نشده` | `backend/.env` ساخته نشده |
| `relation "samples_mellat" does not exist` | `./migrate.sh` اجرا نشده |
| `دریافت صفحه ... ناموفق بود` | `CE_GATEWAY_TOKEN` / دسترسی شبکهای به API اصلی |
| فرانتاند داده نشان نمیدهد | بکاند بالا نیست یا `BACKEND_URL` در `frontend/.env.local` اشتباه است |
| `partial` همیشه میماند | طبیعی است؛ حالت میانروز است. شبانه `complete` میشود |
| `needs_review` | مغایرت `source_total` با پردازش یا وجود نمونه پرشده؛ `day_runs.error` و لاگ Ingestion را ببین |
