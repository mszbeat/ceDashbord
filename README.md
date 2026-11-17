# CE Dashboard Server — نسخه سروری

پیادهسازی صفر تا صد PRD `CE-Dashboard-Server-PRD.md` با ساختار `frontend/` + `backend/`، **بدون Docker**. نصب Node.js و PostgreSQL بر عهده شماست؛ اسکریپتها فقط پروژه را نصب، مایگریشن، اجرا و Ingestion میکنند.

> خروجی یک **صفحهٔ زنده آنلاین** است، نه فایل HTML برای دانلود. چینش، کارتها، جداول، نمودارها، RTL، تعاملات، Scope موفق/ناموفق و تب جزئیات بر اساس همان رندرر قدیمی `report.html` بازسازی شدهاند؛ منبع داده بهجای پوشهٔ `reports/`، دیتابیس جانبی و API اصلی است.
>
> `report.html` و ابزارهای A/B قدیمی در این checkout وجود ندارند؛ `README.legacy.md` فقط سند تاریخی نسخهٔ پیشین است. رجیستری تحلیل هر سه بانک در `backend/services/evaluator/legacy/src/banks/*.js` نگهداری میشود. پوستهٔ بصری اکنون شیشهای/مدرن است، بدون تغییر در منطق یا دادههای تحلیل.

---

## پیشنیازهای محیطی

این ریپو فقط کد است؛ وابستگیهای زیر باید خارج از آن فراهم شوند:

- Node.js 20+ و PostgreSQL (دیتابیس جانبی `DATABASE_URL`).
- رجیستری خصوصی پارت برای `@partFramework/*`, `partAuthenticationInterface` و سایر پکیجها.
- دسترسی شبکهای به سرویس سمد و هاستهای `*.partdp.ir` / گیتوی هر بانک.
- فایل `backend/.env` ساختهشده از `backend/.env.example` با مقادیر واقعی (هیچ رمز/توکن/کلید خصوصی کامیت نمیشود).
- `frontend/.env.local` فقط در صورتی که `BACKEND_URL` غیر از `http://127.0.0.1:3000` باشد.

راستیآزمایی سریع پیش از اجرا:

```bash
cd backend && npm run check:env
```

> محیط توسعهٔ این Agent فاقد PostgreSQL، رجیستری خصوصی پارت و هاستهای داخلی است؛
> بنابراین بکاند واقعی اینجا اجرا نشد و صحت جریان رفرش/UI با بکاند mock و تستهای
> واحد/ساختاری بررسی شد. جزئیات امنیتی در [`docs/SECURITY.md`](docs/SECURITY.md).

---

## تصمیمهای ثبتشده

| موضوع | انتخاب |
|---|---|
| فرانتاند | Next.js 14 + React 18 + Tailwind (`app/route.ts` صفحهٔ legacy را زنده سرو میکند + `/login` و `/admin`) |
| بکاند | `partFramework` (`@partFramework/http`, `@partFramework/router`, `partSessionManager`, `partSecurity`) + PostgreSQL (`pg`) |
| بانکها | ملت، رسالت، پستبانک — همگی از رجیستری قدیمی `banks/*.js` |
| تجمیع | `legacy_bump`: همان `newStats()`/`bump()` قدیمی؛ SQL فقط فهرست/صفحهبندی/روزها |
| کنترلها | نوار باریک legacy-styled: بانک / از / تا / بروزرسانی + وضعیت احراز هویت و ورود/خروج |
| جزئیات | همان `viewer.js` در تب جدید، ولی داده از `/api/sample?requestId={requestId}` (نقش `creditEvaluation` یا `admin`) |
| احراز هویت | `partAuthenticationInterface` + سمد (`partSamadInterface` + `partSessionManager`) + رفرش‌توکن چرخشی (`auth_refresh_tokens`) |
| اجرا | `install.sh` / `start.sh` / `dev.sh` / `migrate.sh` / `ingest.sh` در ریشه و هر پوشه |
| Push | همین ریپو، برنچ `main` با Deploy Key |
| Docker Compose | حذف شد |

---

## ساختار

```text
ceDashbord/
├── install.sh              # نصب هر دو پوشه (backend + frontend)
├── start.sh                # اجرای بکاند :3000 + فرانتاند :3001
├── dev.sh                  # حالت توسعه (node --watch در بکاند + next dev در فرانتاند)
├── migrate.sh              # ساخت جداول PostgreSQL
├── ingest.sh               # اجرای Ingestion (شبانه / میانروز / بکفیل)
├── backend/
│   ├── install.sh
│   ├── start.sh
│   ├── .env.example
│   ├── package.json
│   ├── index.js            # نقطهٔ ورود (MODE=dev|prod|test)
│   ├── Program.js          # بوت‌استرپ partFramework + تزریق وابستگی‌ها
│   ├── routes.js           # ۲۷ روت مرکزی + validate + checkAccess
│   ├── project-config/     # routerConf (accessControl), servers, dependencies
│   ├── configs/            # تنظیمات global/instance پارت و error configها
│   ├── controllers/        # auth, summaryController, creditEvaluationController, adminController
│   ├── scripts/check-env.js  # راستیآزمایی متغیرهای محیطی پیش از اجرا
│   ├── scripts/verify-pd2.js  # تست سرتاسری + بررسی ساختار (با PGlite در صورت نصب)
│   ├── tests/              # تست‌های واحد و قرارداد معماری (node --test)
│   └── services/
│       ├── config.js
│       ├── container.js
│       ├── db/             # schema.sql (شامل auth_refresh_tokens) + migrate.js + DatabaseService
│       ├── evaluator/      # legacy/* + legacy-report/* + EvaluatorService
│       ├── http/           # request.js + result.js
│       ├── ingestion/      # Worker صفحه‌ای + checkpoint + advisory lock + run-ingest.js
│       ├── summary/        # SummaryService (/api/report, /api/summary, /api/list, ...)
│       ├── admin/          # AdminService + CronSchedulerService
│       └── legacy-report/  # render.js/charts.js/common.js/assets/* + report-builder.js
├── docs/                   # ممیزی تطبیق عددی و چکلیست امنیتی
└── frontend/
    ├── install.sh
    ├── start.sh
    ├── .env.example
    ├── lib/auth-client.ts  # نشست، رفرش‌توکن خودکار (single-flight) و همگام‌سازی تب‌ها
    ├── public/images/login-hero.webp  # هیر بهینهشده صفحهٔ ورود (کیفیت بالا، حجم کم)
    ├── app/
    │   ├── layout.tsx      # RTL / فارسی
    │   ├── route.ts        # صفحهٔ زنده: GET / → GET /api/report بکاند
    │   ├── login/          # پنل ورود فارسی RTL (/login)
    │   ├── admin/          # پنل مدیریت و زمان‌بندی کران (/admin)
    │   ├── globals.css
    │   └── api.ts
    ├── next.config.js      # پروکسی /api به بکاند
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

### ۴) ساخت جداول و راستیآزمایی محیط

```bash
cp backend/.env.example backend/.env   # سپس مقادیر واقعی را وارد کنید
cd backend && npm run check:env
./migrate.sh
```

جداول: `day_runs`، `samples_mellat`، `samples_resalat`، `samples_postbank`، `message_dict`، `sample_access_logs`، `cron_configs`، `auth_refresh_tokens` و `admin_jobs` (تاریخچهٔ اجراهای پنل مدیریت که پس از restart هم باقی میماند).

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
4. `backend/services/legacy-report/render.js` همان `buildHtml` قدیمی صدا زده میشود؛ `charts.js`، `client.js`، `viewer.js` ساختار و منطق قدیمی را حفظ میکنند و `style.css` / `viewer.css` فقط پوستهٔ بصری شیشهای/مدرن گرفتهاند.
5. فقط متنهای وابسته به «پوشهٔ reports» و «فایل خصوصی جزئیات» به API زنده تغییر کردهاند: `sid` همان `request_id` است و کلیک ردیف `fetch('/api/sample?requestId={requestId}')` میکند و همان viewer را در تب جدید میسازد.
6. نوار باریک بالای صفحه، بانک/از/تا/بروزرسانی را با همان متغیرهای رنگی legacy اضافه میکند.

---

## توکن گیت‌وی و تمدید نشست

- **توکن هر بانک پیش از درخواست داده کنترل می‌شود:** `GatewayTokenManager` برای هر بانک
  (ملت و پست‌بانک؛ رسالت بدون گیت‌وی است) توکن را همراه `issuedAt`/`expiresAt` نگه می‌دارد.
  اگر توکن منقضی شده یا در پنجرهٔ پیش‌تمدید باشد (`CE_GATEWAY_TOKEN_REFRESH_SKEW`، پیش‌فرض ۱۵ ثانیه)،
  **قبل از** درخواست `GET /creditEvaluation@2/report` توکن تازه از `POST /service/gateway@3/token`
  گرفته می‌شود و درخواست داده با توکن جدید ارسال می‌گردد.
- عمر توکن از `CE_GATEWAY_TOKEN_TTL` (پیش‌فرض ۶۰ ثانیه) خوانده می‌شود؛ اگر پاسخ گیت‌وی
  `expiresIn` / `expires_in` / `ttl` / `exp` بدهد، همان مقدار مبنا قرار می‌گیرد.
- اگر سرور پاسخ دهد «توکن ارتباط با gateway معتبر نیست»، کش توکن همان بانک دور ریخته و
  درخواست با توکن تازه تکرار می‌شود (حداکثر ۲ بار، بدون حلقهٔ بی‌پایان).
- درخواست‌های همزمان هر بانک با single-flight یکی می‌شوند؛ بانک‌ها کش مستقل دارند.
- **نشست کاربر:** با انقضای اکسس‌توکن، `middleware`/`BFF`/کلاینت به‌جای رفتن به `/login`
  ابتدا `POST /api/auth/refresh` می‌زنند (وجود کوکی `ce_refresh` کافی است) و درخواست اصلی با
  توکن تازه تکرار می‌شود؛ فقط وقتی رفرش‌توکن هم نامعتبر باشد کاربر به صفحهٔ ورود هدایت می‌شود.

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

# یا از طریق API بکاند (با دسترسی admin)
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
| GET | `/api/sample?requestId={requestId}` | پروکسی لحظهای به API اصلی؛ `no-store` + لاگ ممیزی |
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
- **احراز هویت و دسترسی:** با `partAuthenticationInterface`، `partSessionManager` و سمد (`partSamadInterface`) محافظت میشود؛ همراه با رفرش‌توکن چرخشی (`POST /api/auth/refresh`) و کوکی HttpOnly `ce_refresh` در کنار توکن نشست کوتاه‌عمر.

---

## تست تطبیق و سلامت

```bash
cd backend
npm run check:env     # فقط در محیط واقعی؛ وجود .env و مقادیر لازم
npm test              # تست‌های واحد، امنیت پیشفرضها، persistence jobها، روتر، کنترلرها، auth/refresh و verify-pd2.js
npm run verify        # همان بررسی ساختاری؛ بخش PGlite در صورت نصب اجرا میشود

cd ../frontend
npm test              # سیاست تمدید رفرش توکن در middleware / BFF / کلاینتها
npx tsc --noEmit      # بررسی تایپ TypeScript
```

برای اجرای پیشنمایش محلی بدون نیاز به PostgreSQL سرور، در صورت نصب بودن `@electric-sql/pglite`، اسکریپت `npm run verify` تست سرتاسری دیتابیس + رندر HTML هر سه بانک و ذخیرهٔ `admin_jobs` را نیز اجرا میکند.

`verify-pd2.js` بررسی میکند که:

- ساختار `<!doctype html>`، استایل، `viewer.js`، `client.js`، نوار کنترل و حالت `api` وجود دارند؛
- خبری از `__CE_DASHBOARD_PRIVATE__` و فایل‌های خصوصی آفلاین نیست؛
- `data-sid` همان `request_id` است و رفرش‌توکن/احراز هویت مطابق انتظار کار میکنند.

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
5. هیچ `.env`، توکن، رمز یا کلید خصوصی TLS کامیت نمیشود؛ چکلیست کامل در [`docs/SECURITY.md`](docs/SECURITY.md).

---

## ممیزی تطبیق عددی

خلاصهٔ وضعیت واقعی ابزارهای تطبیق و محدودیتهای این checkout در
[`docs/analysis-parity-audit.md`](docs/analysis-parity-audit.md) مستند شده است.

در این ریپو `report.html`، `backend/scripts/ab-parity.js`،
`backend/scripts/numeric-parity.js`، `backend/scripts/import-legacy-reports.js`
و اسکریپتهای npm مربوطه وجود **ندارند**؛ بنابراین هیچ دستور/لینکی به آنها اجرا
نمیشود. تستهای موجود همان قرارداد روتر، کنترلرها، موتور ارزیابی، حذف کد ملی،
لایهٔ auth/refresh و ساختار HTML زنده را پوشش میدهند.

نتیجهٔ مهم: موتور تحلیل عددی (`newStats`/`bump`/`quantile`/`histogram`/`banks/*.js`)
بین دو نسخه تفاوتی ندارد. اختلاف جزئی اعداد دو اجرای واقعی، از **ردیفهای ورودی**
میآید، نه از کد تحلیل، چون نسخهٔ زنده شاخصها را هنگام **Ingestion** محاسبه و
ذخیره میکند و گزارش فقط همان مقادیر ذخیرهشده را `bump` میکند. برای قضاوت دقیق،
هر دو خروجی باید از **یک اسنپشاپ یکسان** ساخته شوند.

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
