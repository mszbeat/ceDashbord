# CE Dashboard Server — نسخه سروری

پیادهسازی صفر تا صد PRD `CE-Dashboard-Server-PRD.md` با ساختار `frontend/` + `backend/`، **بدون Docker**. نصب Node.js و PostgreSQL بر عهده شماست؛ اسکریپتها فقط پروژه را نصب، مایگریشن، اجرا و Ingestion میکنند.

> خروجی یک **صفحهٔ زنده آنلاین** است، نه فایل HTML برای دانلود. ظاهر، چینش، کارتها، جداول، نمودارها، RTL، تعاملات، Scope موفق/ناموفق و تب جزئیات دقیقاً همان `report.html` قدیمی است؛ منبع داده بهجای پوشهٔ `reports/`، دیتابیس جانبی و API اصلی است.
>
> فایل `report.html` موجود در ریپو نمونهٔ **بانک رسالت** است. ظاهر برای هر سه بانک یکسان است و شاخصها مستقیماً از `banks/*.js` خوانده میشوند؛ یعنی انتخاب رسالت همان ۱۲ بخش قدیمی (شامل «خروجی مدل») را میدهد و ملت/پستبانک همان موتور را با بخشها و شاخصهای مخصوص خودشان اجرا میکنند.

---

## تصمیمهای ثبتشده

| موضوع | انتخاب |
|---|---|
| فرانتاند | Next.js 14 + React 18 + Tailwind ( dependencyها حفظ شد؛ `app/route.ts` صفحهٔ legacy را زنده سرو میکند ) |
| بکاند | NestJS 10 + PostgreSQL (`pg`) |
| بانکها | ملت، رسالت، پستبانک — همگی از رجیستری قدیمی `banks/*.js` |
| تجمیع | `legacy_bump`: همان `newStats()`/`bump()` قدیمی؛ SQL فقط فهرست/صفحهبندی/روزها |
| کنترلها | نوار باریک legacy-styled: بانک / از / تا / بروزرسانی |
| جزئیات | همان `viewer.js` در تب جدید، ولی داده از `/api/sample/{requestId}` |
| احراز هویت | فعلاً ندارد؛ بعداً با سرویس بومی شرکت وصل میشود |
| اجرا | `install.sh` / `start.sh` / `migrate.sh` / `ingest.sh` در ریشه و هر پوشه |
| Push | همین ریپو، برنچ `main` با Deploy Key (بعداً انتقال به ریپوی سازمانی) |
| Docker Compose | حذف شد |

---

## ساختار

```text
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
│   ├── scripts/
│   │   ├── parity-smoke.js     # تست تطبیق خروجی زنده هر سه بانک
│   │   └── pglite-preview.js   # پیشنمایش زنده بدون PostgreSQL سرور (PGlite)
│   └── src/
│       ├── main.ts
│       ├── config.ts
│       ├── message-dict.ts
│       ├── db/                 # schema.sql + migrate.js + DatabaseService
│       ├── evaluator/
│       │   ├── legacy/         # کپی banks/* و src/* قدیمی (قواعد دستنخورده)
│       │   ├── legacy-report/  # buildAiInput.js + aiInputKeyMaps.js از report/
│       │   ├── evaluator.service.ts  # createEvaluator برای هر سه بانک
│       │   └── evaluator.test.ts     # تست تطبیق M0/M1
│       ├── ingestion/         # Worker صفحهای + checkpoint + advisory lock
│       ├── summary/           # /api/report + Web API + پروکسی جزئیات
│       ├── legacy-report/     # render.js/charts.js/common.js/style.css/client.js/viewer.js/viewer.css
│       │   └── report-builder.js  # buildHtml قدیمی + نوار کنترل زنده
│       └── utils/date.ts
└── frontend/
    ├── install.sh
    ├── start.sh
    ├── .env.example
    ├── app/
    │   ├── layout.tsx         # RTL / فارسی
    │   ├── route.ts           # صفحهٔ زنده: GET / → GET /api/report بکاند
    │   ├── globals.css
    │   └── api.ts
    ├── tailwind-page.tsx.bak  # نسخهٔ قبلی Tailwind، فقط بایگانی
    ├── next.config.js         # پروکسی /api به بکاند
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

> هدرهای `gateway-system` و `gateway-token` دقیقاً مثل `report/src/config.js` قدیمی ارسال میشوند. توکن داخل کد نیست.

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

جداول: `day_runs`، `samples_mellat`، `samples_resalat`، `samples_postbank`، `message_dict`، `sample_access_logs`.

### ۵) اجرا

```bash
./start.sh
```

- بکاند: `http://localhost:3000/api/health`
- فرانتاند / صفحهٔ زنده: `http://localhost:3001/?bank=tavan_resalat&from=1405-08-18&to=1405-08-18`
- مرورگر فقط `/api/...` را صدا میزند؛ `next.config.js` آن را به بکاند پروکسی میکند.

لاگها در `logs/backend.log` و `logs/frontend.log`. حالت توسعه: `./dev.sh`.

---

## معماری خروجی زنده

1. `GET /` توسط `frontend/app/route.ts` به `GET /api/report?bank=&from=&to=&rowsCap=` بکاند پروکسی میشود و همان HTML را در لحظه برمیگرداند؛ هیچ فایل HTML نوشته نمیشود.
2. بکاند ردیفهای تحلیلشده را از `samples_<bank>` با keyset pagination میخواند.
3. گروهها، چارکها، درصدها، کراسها، کارتها و سطرهای فهرست دقیقاً با `newStats()`/`bump()` قدیمی ساخته میشوند. `percentile_cont`/SQL دیگر منبع حقیقت نیست.
4. `src/legacy-report/render.js` همان `buildHtml` قدیمی صدا زده میشود؛ `charts.js`، `style.css`، `client.js`، `viewer.js` و `viewer.css` عیناً همان فایلهای قدیمیاند.
5. فقط متنهای وابسته به «پوشهٔ reports» و «فایل خصوصی جزئیات» به API زنده تغییر کردهاند: `sid` همان `request_id` است و کلیک ردیف `fetch('/api/sample/{requestId}')` میکند و همان viewer را در تب جدید میسازد.
6. نوار باریک بالای صفحه، بانک/از/تا/بروزرسانی را با همان متغیرهای رنگی legacy اضافه میکند.

---

## Ingestion

```bash
./ingest.sh --mode=nightly                         # دیروز، پیشفرض
./ingest.sh --mode=intraday                        # میانروز، partial
./ingest.sh --day=1405-08-18 --mode=nightly
./ingest.sh --bank=tavan_resalat --days=7
./ingest.sh --bank=tavan_postbank --mode=nightly
./ingest.sh --bank=tavan_mellat --day=1405-08-19 --rebuild   # پاک کردن کامل و ساخت دوبارهٔ همان روز
./ingest.sh --days=7 --rebuild                               # بازسازی کامل ۷ روز
./ingest.sh --help                                           # راهنمای همهٔ گزینهها
```

### `--rebuild` چیست و کی لازم است؟

بدون آن، ingest فقط `UPSERT` میکند: ردیفهایی که در پاسخ جدید API **نباشند**،
همچنان در دیتابیس میمانند (مثلاً ردیفهای تحلیلشده با نسخهٔ قدیمی کد، یا
تکراریهایی که API دیگر برنمیگرداند). همین میتواند باعث شود آمار یک روز با
`report.html` قدیمی چند واحد فرق کند.

با `--rebuild`، پیش از ورود، **تمام** ردیفهای آن `(bank, day)` و ردیف
`day_runs`اش حذف میشوند و روز از صفر ساخته میشود:

```bash
# مستقیم از ریشه
./ingest.sh --bank=tavan_mellat --day=1405-08-19 --rebuild

# یا از پوشهٔ backend
cd backend
npm run ingest -- --bank=tavan_mellat --day=1405-08-19 --rebuild

# همان فایلهای reports/ قدیمی را (بدون خواندن دوبارهٔ API) از صفر وارد کن
node scripts/import-legacy-reports.js /path/to/reports tavan_mellat --rebuild

# یا از طریق API بکاند
curl -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{"bank":"tavan_mellat","day":"1405-08-19","mode":"nightly","rebuild":true}'
```

محافظها:

- **`--day` یا `--days` اجباری است**؛ `--rebuild` بدون روز صریح رد میشود تا
  دیروز بهطور ناخواسته پاک نشود. (API هم `day` صریح میخواهد.)
- پیش از هر حذف، `page=1&limit=1` چک میشود؛ اگر API هیچ رکوردی برنگرداند،
  اجرا **لغو** میشود و چیزی پاک نمیشود.
- حذف و ورود مجدد **در یک تراکنش** است. اگر API وسط کار قطع شود،
  `ROLLBACK` میشود و ردیفها و `day_runs` قدیمی دقیقاً سالم میمانند؛ خطا در
  خروجی CLI چاپ میشود.
- `message_dict` و `sample_access_logs` دستنخورده میمانند (پیامهای قالبی و
  لاگ دسترسی تاریخچهایاند، وابسته به یک روز نیستند).
- خروجی موفق شامل `"rebuild": true, "deleted": N` است.

تست اتوماتیک رفتار بالا (شامل ROLLBACK و لغو پیش از حذف):

```bash
cd backend && npm run test:rebuild
```

رفتار معمولی (بدون rebuild):

1. قفل `pg_advisory_lock` روی `(bank, day)`.
2. `source_total` از `page=1&limit=1`.
3. صفحهها با `limit=50` پشتسرهم.
4. نرمالسازی با همان `buildAiInput.js`؛ موفق/ناموفق دقیقاً با همان چهار پیام انگلیسی `isReportSuccess`.
5. `createEvaluator` هر بانک اجرا میشود و فقط ردیف تحلیلشده با `ON CONFLICT(request_id) DO UPDATE` ذخیره میشود. **گزارش خام، کد ملی، متن آزاد پیام و نام شعبه ذخیره نمیشود.**
6. `flags/cats/counters/metrics/paths/services/credit_alerts/display_extras` بهصورت JSONB ذخیره میشوند تا رندر زنده دقیقاً همان سطرهای قدیمی را بسازد.
7. بعد از هر صفحه `checkpoint`؛ شبانه `complete`/`needs_review`، میانروز `partial`.

### cron پیشنهادی (Tehran)

```cron
30 0 * * *  cd /path/ce-dashboard-server && ./ingest.sh --mode=nightly >> logs/cron-nightly.log 2>&1
*/30 8-20 * * * cd /path/ce-dashboard-server && ./ingest.sh --mode=intraday >> logs/cron-intraday.log 2>&1
```

---

## API بکاند

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/health` | سلامت سرویس |
| GET | `/api/diagnostics` | وضعیت اتصال، جداول، تعداد ردیفها، پوشش `insertDate_full` و نسخههای `analysis_version` هر بانک، بدون افشای رمز/توکن |
| GET | `/api/banks` | بانکهای فعال |
| GET | `/api/specs?bank=tavan_resalat` | تعریف شاخصها، دستهها، متریکها، موضوعات همان بانک |
| GET | `/api/report?bank=&from=&to=&rowsCap=100` | **صفحهٔ HTML زنده** با همان `buildHtml` قدیمی |
| GET | `/api/summary?bank=&from=&to=` | آمار JSON با همان `bump` قدیمی |
| GET | `/api/list?bank=&from=&to=&type=flag&id=rotbeNull&limit=100&offset=0` | فهرست حداکثر ۱۰۰تایی + `COUNT(*) OVER()` |
| GET | `/api/list?...&type=metric&id=totalTime` | مرتبسازی بر مقدار عددی |
| GET | `/api/list?...&type=cat&id=scoreCategory&value=...` | فیلتر روی مقدار دسته |
| GET | `/api/list?...&type=slow` | گزارشهای کندتر از ۴ ثانیه |
| GET | `/api/sample/{requestId}` | پروکسی لحظهای به API اصلی؛ `no-store` + لاگ ممیزی |
| GET | `/api/runs` | وضعیت اجراها |
| POST | `/api/runs` | اجرای دستی `{ "bank", "day", "mode" }` |

`from`/`to` شمسی `YYYY-MM-DD` یا `YYYY/MM/DD` قبول میکند. پیشفرض ۳۰ روز اخیر تهران است.

---

## نکات طراحی مهم

- **همان قواعد، همان تجمیع:** تصمیم `legacy_bump` یعنی شمارشها/چارکها/درصدها با توابع قدیمی روی ردیفهای DB ساخته میشوند؛ SQL فقط لیست و صفحهبندی است.
- **پیامها:** `messageSuccess`/`messageFail` به کلید پایدار تبدیل میشوند. متن کامل پیامهای قالبی شناختهشده در `message_dict` نگهداری میشود تا جدول پیامها دقیقاً مثل `report.html` دوباره رندر شود؛ پیام ناشناخته فقط هش کوتاه میگیرد و متنش ذخیره نمیشود.
- **PD دقیقاً ۰٫۵:** مقدار خام و بدون گردکردن ذخیره میشود و ردیف مستقل «دقیقاً ۰٫۵۰» حفظ میشود.
- **ملت:** `output.Credit_Basket` توان بازپرداخت (ریال) است؛ `amount_kind=repayment_capacity`.
- **رسالت/پستبانک:** `output.suggested_tavan_bazpardakht` خوانده میشود؛ `viewer` اختصاصی، `sanitizeSample` رسالت و ستونهای `امتیاز`/`آستانهٔ نکول` از همان `banks/*.js` میآیند.
- **نمونه کامل:** فقط با کلیک روی `request_id` و از API اصلی گرفته میشود؛ پاسخ `Cache-Control: no-store` دارد، `sourceIp` حذف میشود، کد ملی در دیتابیس جانبی ذخیره نمیشود ولی در همان پاسخ لحظهای برای viewer رسالت/پستبانک قابل نمایش است. فقط یک ردیف ممیزی در `sample_access_logs` ثبت میشود.
- **احراز هویت:** فعلاً `POST /api/runs` و مشاهده جزئیات باز هستند. بعداً Guard سرویس بومی شرکت اضافه میشود.

---

## تست تطبیق

```bash
cd backend
npm test              # parity ارزیاب M0/M1
npm run build
npm run test:parity   # parity صفحهٔ زنده هر سه بانک
```

`test:parity` بررسی میکند که:

- ساختار `<!doctype html>`، استایل، `viewer.js`، `client.js`، نوار کنترل و حالت `api` وجود دارند؛
- خبری از `__CE_DASHBOARD_PRIVATE__`، `reports/_ce-dashboard-private` و متنهای آفلاین `MAX_ROWS` نیست؛
- `data-sid` همان `request_id` است؛
- ترتیب بخشهای **رسالت** دقیقاً با `report.html` یکی است، شامل `features`؛
- هر سه بانک خروجی زنده میسازند.

خروجی نمونه تست ارزیاب:

```text
✅ evaluator parity test passed: { requestId: ..., flags: 10, metrics: 27, cats: 7, paths: 4, services: 5 }
```

### پیشنمایش بدون PostgreSQL سرور

برای دیدن سریع صفحهٔ زنده در محیطهای بدون Postgres، PGlite (PostgreSQL در WASM) پشت همان اپ NestJS قرار میگیرد:

```bash
cd backend
npm install
npm run build
npm run preview:pglite
# سپس frontend را با BACKEND_URL=http://127.0.0.1:3000 اجرا کن
```

این فقط previews است؛ مسیر production همان PostgreSQL واقعی و `./migrate.sh` است.

---

## موارد باز (از PRD)

- **D-01:** ترتیب/کرسر API برای میانروز قطعی نیست. فعلاً گزینه B: میانروز کل روز جاری را از صفحه ۱ بازخوانی میکند و `upsert` تکراری ایجاد نمیکند.
- **D-02..D-12:** rollup، retention، SSO، autoBank، سطح جزئیات و سقف نهایی ستونها همچنان تصمیمگیری نشدهاند. پیشفرضها: لیست حداکثر ۱۰۰، بدون rollup جداگانه، بدون retention خودکار، بدون SSO، بدون autoBank.
- **پارتیشن ماهانه:** `schema.sql` فعلاً unpartitioned است؛ قبل از production باید اضافه شود.
- **uniqueKey:** برخلاف نسخهٔ اولیه، برای parity دقیق `unique_key` در `samples_*` ذخیره میشود (شناسهٔ نمونه، نه دادهٔ حساس).
- **M5:** رسالت و پستبانک از رجیستری قدیمی اضافه شدند؛ بکفیل کامل و سختسازی باقی است.
- **Sepah:** طبق PRD خارج از v1.

---

## Push با Deploy Key

1. کلید عمومی در `Settings → Deploy keys` ریپو با **Allow write access** ست شده است.
2. کلید خصوصی بیرون ریپو (`~/.ce-deploy/id_ed25519`) است و هرگز کامیت نمیشود.
3. دسترسی SSH تست و کامیتها روی `main` پوش شدند؛ `GET /repos/mszbeat/ceDashbord/branches/main` نشان داد `protected:false`.
4. محدودیت Deploy Key: فقط همین ریپو؛ بعد از انتقال به ریپوی سازمانی حتماً Rotate شود.
5. هیچ `.env` و هیچ توکنی کامیت نمیشود.

---

## ممیزی کامل اختلاف اعداد

گزارش کامل «صفر تا صد» مقایسهٔ دو خط لولهٔ تحلیل (هش تکتک فایلها، شش فایل
تغییریافته، فرمولها، تست A/B و تحلیل الگوی اختلاف اسکرینشاتها) در
[`docs/analysis-parity-audit.md`](docs/analysis-parity-audit.md) است.

ابزارهای قطعی:

```bash
cd backend
npm run test:ab-parity                                  # تست اتوماتیک روی ۱۲۰ نمونه
node scripts/ab-parity.js /path/to/reports             # مقایسهٔ همان پوشهٔ reports/ از هر دو مسیر
node scripts/import-legacy-reports.js /path/to/reports # وارد کردن همان اسنپشاپ به PostgreSQL
```

`ab-parity` هر دو خروجی را با **یک رندرر** میسازد و جداول تجمیعی را سلولبهسلول
مقایسه میکند؛ نتیجهٔ موفق `identical: true` یعنی اختلاف اعداد دو اجرای واقعی
از **اسنپشاپ متفاوت API** آمده، نه از کد تحلیل.

## بررسی تطبیق عددی قدیم / جدید

اسکریپت `backend/scripts/numeric-parity.js` همان نمونهها را یکبار از مسیر قدیمی
(`scan → analyzeOne → bump`) و یکبار از مسیر زنده
(`normalizeSample → evaluate → جدول samples_* → consumeRow → bump`) عبور میدهد و
**تکتک شاخصهای عددی** (count/min/p25/median/mean/p75/max)، فلگها، دستهها،
شمارندهها، سرویسها، مسیرها، وضعیت موفق/ناموفق و اولین/آخرین درخواست را مقایسه میکند:

```bash
cd backend
npm run test:numeric-parity
# خروجی موفق: "problems": []   (پیشفرض ۱۲۰ نمونه؛ PARITY_N=1000 برای تست سنگینتر)
```

نتیجهٔ این تست: موتور تحلیل عددی (`newStats`/`bump`/`quantile`/`histogram`/`banks/*.js`)
بین دو نسخه **هیچ تفاوتی ندارد**. اختلافهای جزئی اعداد در دو اجرای واقعی، از
**ردیفهای ورودی** میآیند، نه از کد تحلیل، چون نسخهٔ زنده شاخصها را هنگام
**Ingestion** محاسبه و ذخیره میکند و گزارش فقط همان مقادیر ذخیرهشده را `bump` میکند.
اگر ingestion در زمان دیگری از API زنده اجرا شود، یا صفحهبندی API پایدار نباشد
(PRD D-01)، یا ردیفها با نسخهٔ قدیمیتر کد ذخیره شدهباشند، چند ردیف نزدیک مرز
بازهها جابهجا میشوند و میانگین/چارکها کمی تغییر میکند. برای قضاوت دقیق، هر دو
خروجی باید از **یک اسنپشاپ یکسان** ساخته شوند.

### تفاوتهای کد که برطرف شدند

| مورد | نسخهٔ قدیمی | نسخهٔ زنده (قبل از این اصلاح) | الان |
|---|---|---|---|
| اولین/آخرین درخواست | `stampOf(sample, day)` مستقیم از `insertDate_full` → تاریخ + `HH:MM:SS` | فقط `display_extras.stamp`؛ اگر خالی/نامعتبر بود، فقط تاریخ | بازسازی از `inserted_at`/`stamp_key`، پذیرش ارقام فارسی و ۱۷+ رقم |
| `selectedServices` | از روی کلیدهای واقعی `ai_input` در `scan.js` | لیست ثابت همهٔ `SERVICE_FA` | همان union پویا، ذخیرهشده در `serviceKeys` |
| وضعیت سرویسها | شیء `{kind,reason,value}` | ستون `services` رشته بود و `consumeRow` آنها را `missingService` میخواند | هر دو شکل پذیرفته میشود |
| متن پیام قالبی | `fa + "\n" + en` همان نمونه | متن ثابت `message_dict` که گاهی با متن خام فرق داشت | متن دقیق پیامهای شناختهشده یکبار در `message_dict` بهروز میشود؛ متن آزاد هر نمونه هرگز ذخیره نمیشود |
| پیام ناشناخته | متن خام پیام | «سایر پیامها» | همان «سایر پیامها» (قانون حریم خصوصی PRD §12 / D-05؛ تفاوت عمدی باقی است) |
| ترتیب ردیفها | ترتیب فایلها در پوشه | `(day, stamp_key, request_id)` | همان ترتیب دیتابیس؛ فقط ترتیب ۱۰۰ ردیف جدول جزئیات را عوض میکند، نه آمار را |

برای بررسی اینکه ردیفها با کدام نسخه تحلیل ساخته شدهاند یا زمان ثبت دارند:

```text
/api/diagnostics → bankDiagnostics[bank].analysisVersions / rowsWithoutTime
```

اگر `analysisVersions` بیش از یک نسخه داشت یا `rowsWithoutTime > 0`، بعد از
`git pull` آن روز را **از صفر** بسازید:

```bash
./ingest.sh --bank=tavan_mellat --day=1405-08-19 --rebuild
```

`--rebuild` برخلاف ingest معمولی، ردیفهایی را که دیگر در پاسخ API نیستند هم
حذف میکند؛ بنابراین همهٔ شاخصها با یک نسخه و یک اسنپشاپ ساخته میشوند.

## عیبیابی کوتاه

| خطا | بررسی |
|---|---|
| `DATABASE_URL تنظیم نشده` | `backend/.env` ساخته نشده |
| `relation "samples_resalat" does not exist` | `./migrate.sh` اجرا نشده |
| `دریافت صفحه ... ناموفق بود` | `CE_GATEWAY_TOKEN` / دسترسی شبکهای به API اصلی |
| فرانتاند صفحه نشان نمیدهد | بکاند بالا نیست یا `BACKEND_URL` در `frontend/.env.local` اشتباه است |
| `{"statusCode":500,...}` در مرورگر | نسخهٔ قدیمی frontend خطای خام بکاند را نشان میداد؛ بعد از آخرین کامیت صفحهٔ خطای فارسی و لینک `/api/diagnostics` میآید. اصل مشکل معمولاً `DATABASE_URL` تنظیم نشده یا `./migrate.sh` اجرا نشده است |
| `partial` همیشه میماند | طبیعی است؛ حالت میانروز است. شبانه `complete` میشود |
| `needs_review` | مغایرت `source_total` با پردازش یا وجود نمونه پرشده؛ `day_runs.error` و لاگ Ingestion را ببین |
