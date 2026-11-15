# partFBackend — CE Dashboard Backend (Powered by `partFramework`)

نسخهٔ کامل بکاند داشبورد پایش اعتبارسنجی بانکی، بازطراحی و پیادهسازیشده بر پایهٔ معماری استاندارد `partFramework` (`controller-package`).
این پوشه **۱۰۰٪ سازگار با فرانتاند Next.js (`frontend/`)** است و بدون نیاز به تغییر حتی یک خط در فرانتاند، جایگزین مستقیم `backend/` روی پورت `3000` میشود.

---

## ساختار پروژه

```text
partFBackend/
├── index.js                              # نقطهٔ ورود اصلی برنامه
├── Program.js                            # کلاس بوتاسترپ partFramework + راهافتادن سرویسها و زمانبند کران
├── package.json                          # وابستگیها و اسکریپتهای اجرایی
├── .env.example                          # نمونه تنظیمات محیطی
├── start.sh                              # اسکریپت اجرای سریع
├── project-config/                       # تنظیمات سرور HTTP، لاگر، کش و وابستگیهای فریمورک
│   ├── index.js
│   ├── dev/                              # پورت پیشفرض: BACKEND_PORT || 3000
│   ├── prod/
│   └── test/
├── configs/                              # فایلهای کانفیگ متناظر با هر کنترلرپکیج
│   ├── sampleController.config.js
│   ├── summaryController.config.js
│   ├── ingestionController.config.js
│   └── adminController.config.js
├── controllers/                          # کنترلرپکیجهای استاندارد partFramework (@Route / @HTTP)
│   ├── sampleController/                 # کنترلر نمونه فریمورک
│   ├── summaryController/                # گزارش HTML، آمار تجمیعی، دریلداون، مشخصات و عیبیابی
│   ├── ingestionController/              # اجرای مستقیم دریافت روزانه (POST /api/runs)
│   └── adminController/                  # پنل مدیریت، زمانبند خودکار کران تهران و اجرای دستی
├── services/                             # لایهٔ سرویسها، دیتابیس و موتور ارزیابی (CommonJS خالص)
│   ├── config.js                         # خواندن متغیرهای محیطی (.env)
│   ├── container.js                      # مدیریت یکپارچهٔ چرخهٔ حیات سرویسها (DI Container)
│   ├── http-adapter.js                   # آداپتور استاندارد protocolRef و HttpResult در partFramework
│   ├── message-dict.js                   # لغتنامهٔ پیامهای سامانه
│   ├── utils/date.js                     # ابزارهای تاریخ و ساعت به وقت Asia/Tehran
│   ├── db/                               # اتصال PostgreSQL، مایگریشن و schema.sql
│   ├── evaluator/                        # موتور ارزیابی همارز با نسخهٔ مرجع بانکی (ملت، رسالت، پستبانک)
│   ├── legacy-report/                    # قالب HTML/CSS/JS گزارش تحلیلی داشبورد
│   ├── ingestion/                        # دریافت صفحهبندیشده از گیتوی CE، ارزیابی، UPSERT و Rebuild اتمیک
│   ├── summary/                          # کوئریهای تجمیعی سریع SQL، کش گزارش و دریلداون نمونهها
│   └── admin/                            # مدیریت اجرای دستی فیلتردار، بررسی پیش از اجرا و زمانبند کران تهران
├── scripts/
│   ├── import-legacy-reports.js          # واردسازی پوشهٔ reports قدیمی به دیتابیس
│   └── verify-partfbackend.js            # تست یکپارچهٔ دیتابیس، موتور ارزیابی، کران و تمام ۱۸ مسیر API
├── postman/
│   ├── sampleController.postman_collection.json
│   └── ceDashboard.postman_collection.json
└── tests/
    ├── sampleController.test.js
    └── controllers.test.js
```

---

## نصب و راهاندازی (در شبکهٔ داخلی پارت)

1. نصب پکیجها (از رجیستری داخلی پارت `https://npm.partcorp.ir/`):

```bash
cd partFBackend
npm install
```

2. ساخت فایل `.env` از روی نمونه و تنظیم `DATABASE_URL` و `CE_GATEWAY_TOKEN`:

```bash
cp .env.example .env
```

3. اجرای مایگریشن دیتابیس PostgreSQL:

```bash
npm run migrate
```

4. اجرای سرور `partFramework` (بهصورت پیشفرض روی پورت `3000`):

```bash
npm start
# یا:
./start.sh
```

---

## فهرست مسیرهای API (۱۸ مسیر کامل تحت `/api`)

### ۱. `summaryController`
- `GET /api/health` — وضعیت سلامت سرویس
- `GET /api/banks` — فهرست بانکها (`tavan_mellat`, `tavan_resalat`, `tavan_postbank`)
- `GET /api/specs` — فرادادهٔ دستهها، فلگها، کارتهای آمار و دیکشنری پیامها
- `GET /api/report` — رندر مستقیم گزارش تحلیلی کامل HTML (`text/html; charset=utf-8`) با تمام نمودارها و مودال دریلداون سرور
- `GET /api/diagnostics` — عیبیابی پوشش تاریخها، صحت شمارش و نسخهٔ تحلیل
- `GET /api/summary` — خلاصهٔ تحلیلی بازهٔ زمانی (توزیع وضعیت، مدلها، علل رد، سبد اعتباری، دهکها، نمودار روزانه/ساعتی و...)
- `GET /api/list` — فهرست صفحهبندیشدهٔ رکوردها با فیلترهای ترکیبی (`cat`, `flag`, `flagVal`, `bucket`, `model`, `code`, `status`, `q`, ...)
- `GET /api/sample/:requestId` — جزئیات کامل یک رکورد اعتبارسنجی
- `GET /api/runs` — تاریخچهٔ اجراهای ثبتشده در جدول `day_runs`

### ۲. `ingestionController`
- `POST /api/runs` — اجرای دریافت یک روز مشخص (`nightly` یا `intraday` بههمراه پشتیبانی از `rebuild` اتمیک و `filters`)

### ۳. `adminController`
- `GET /api/admin/overview` — خلاصهٔ وضعیت سرور، وضعیت کران شبانه، کارهای اخیر و آمار هر بانک
- `GET /api/admin/cron` — دریافت تنظیمات زمانبند خودکار کران (به وقت تهران)
- `PUT /api/admin/cron` — ویرایش تنظیمات کران (فعال/غیرفعال، ساعت، دقیقه، حالت `nightly`/`intraday` و بانکهای هدف)
- `POST /api/admin/cron/run-now` — اجرای فوری کران شبانه در پسزمینه
- `POST /api/admin/runs/check` — بررسی وجود دادهٔ قبلی در دیتابیس پیش از اجرای دستی (برای نمایش انتخاب `Rebuild` / `Upsert` / `Cancel`)
- `POST /api/admin/runs/start` — شروع اجرای دستی پسزمینه (تکروز، بازهٔ تاریخ، یا بدون تاریخ با فیلترهای `status`, `requestId`, `uniqueKey`, `nationalCode`, `maxCount`, `pageSize` — بدون ذخیرهسازی کدملی)
- `GET /api/admin/jobs` — فهرست کارهای پسزمینهٔ اخیر
- `GET /api/admin/jobs/:id` — وضعیت لحظهای و پیشرفت یک کار پسزمینه

---

## دستورات خط فرمان (CLI) و تستها

```bash
# دریافت دستی از خط فرمان
npm run ingest -- --bank=tavan_mellat --day=2026-04-16 --mode=nightly
npm run ingest -- --bank=tavan_mellat --from=2026-04-10 --to=2026-04-16 --rebuild

# واردسازی فایلهای reports قدیمی
npm run import:legacy -- ../samples tavan_mellat

# اجرای تستهای واحد و یکپارچه
npm test
```
