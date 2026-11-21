# اسکیمای v2 — طراحی، اجرا، برابری، مهاجرت

هدف: کاهش اندازهٔ جدول‌های نمونه، حذف ایندکس‌های تکراری/GIN، و آماده‌سازی تجمیع سمت
دیتابیس — **بدون هیچ تغییر رفتاری** در `/api/summary`، `/api/list`، `/api/report`
و `/api/sample/:id`.

## یک نگاه

| ویژگی | v1 (فعلی) | v2 |
|---|---|---|
| ایندکس ثانویه | ۱۳ (ملت) / ۲۱ (رسالت، پست‌بانک) با کپی و GIN | **۲** |
| `display_extras` | ~۱٫۳–۱٫۸ KB در هر ردیف | حذف؛ جزئیات اسپارس در `sample_detail` |
| `day` | `text` شمسی | `date` (پارتیشن ماهانه) |
| `stamp_key` | `text` ۱۷ رقمی | `bigint` epoch-ms |
| flags | jsonb کلید‌دار | `bigint` بیت‌ماسک |
| metrics/counters | jsonb | ستون typed `m_*` / `c_*` |
| cats/paths/services | jsonb متنی | کد `smallint[]`/بیت‌ماسک + دیکشنری‌ها |
| کاتالوگ رشته‌ها | تکرار در هر ردیف | `value_dict` (`smallint`) |
| **حجم هر ردیف** | ۶٫۹–۱۲٫۰ KB | **۰٫۵۴–۰٫۵۸ KB** |

## فایل‌ها

| فایل | نقش |
|---|---|
| `services/db/schema-v2.sql` | جداول ثابت: registry، دیکشنری‌ها، `sample_detail`، rollup، jobها |
| `services/db/schema-v2-builder.js` | DDL داینامیک per-bank (ستون‌های typed، پارتیشن، ایندکس) + seed رجیستری/لیست‌ها + `createCatDict` |
| `services/db/indicator-registry.js` | ترتیب پایدار شاخص‌ها، ماسک بیت، کد/رمز سرویس و مسیر |
| `services/db/row-mapper-v2.js` | نگاشت دوطرفهٔ ردیف v1 ⇄ v2 |
| `services/db/ingest-v2.js` | مسیر نوشتن (`V2Writer`) با پارتیشن‌بندی و دیکشنری |
| `services/db/dialect-v1.js` + `dialect-v1-session.js` | قرارداد دسترسی v1 (همان SQL قبلی، بیرون‌کشیده‌شده) |
| `services/db/dialect-v2.js` | همان قرارداد روی v2 |
| `services/db/value-dict.js` | دیکشنری رشته‌های کم‌تنوع با کش و `NOTIFY` |
| `services/db/uuid-map.js` | نگاشت پایدار شناسهٔ غیر-UUID → UUID (v5) |
| `services/db/migrate-v2.js` | مهاجرت داده v1→v2 + `rollback` |
| `services/db/schema-registry.js` | ساخت runtime رجیستری از evaluator |
| `scripts/migrate-v2.js` | CLI: `npm run migrate:v2 [--dry-run \| --rollback]` |

## معماری: یک «dialect» به‌جای دو نسخهٔ سرویس

`SummaryService` قبلاً SQL را مستقیم می‌ساخت و اجرا می‌کرد. اکنون همان SQL به یک
قرارداد صریح تبدیل شده است:

```js
// dialect-v1-session.js  (پیش‌فرض؛ رفتار عیناً قبلی)
new SummaryService(db, evaluator)
// dialect-v2.js
new SummaryService(db, evaluator, { dialect: new V2Dialect(db, { registry, listSpecs }) })
```

متدهای قرارداد: `serviceDiscovery`, `countRange`, `days`, `cursorPage`, `list`,
`byRequestId`, `runs`, `runsRange`, `stampRange`.

مزیت: منطق تجمیع (`consumeRow`/`bump`) و تولید HTML **دست‌نخورده** می‌ماند، فقط
منبع داده عوض می‌شود. به همین دلیل برابری خروجی قابل اثبات است.

انتخاب با متغیر محیطی:

```bash
CE_DB_SCHEMA=v1   # پیش‌فرض
CE_DB_SCHEMA=v2
```

`services/container.js` در حالت `v2` هم `V2Dialect` (خواندن) و هم `V2Writer`
(نوشتن) را می‌سازد و به `SummaryService` / `IngestionService` تزریق می‌کند.

## اندازه‌گیری (۳۰۰۰ ردیف در هر بانک، خروجی واقعی evaluator، PG18)

| جدول | v1/ردیف | v2/ردیف | کاهش | TOAST v1 → v2 |
|---|---|---|---|---|
| samples_mellat | 6 914 B | **543 B** | ۱۲٫۷× | 4 936 KB → 32 KB |
| samples_resalat | 12 034 B | **543 B** | ۲۲٫۲× | 8 200 KB → 32 KB |
| samples_postbank | 10 554 B | **579 B** | ۱۸٫۳× | 6 136 KB → 32 KB |

- سهم ایندکس از ۴۶–۶۳٪ به ۲۷–۲۹٪.
- دادهٔ خام: `bench/phase2-v2-results.json` (بازتولید: `PER_BANK=3000 node parity2.js`).

## برابری (parity) — اثبات، نه ادعا

### الف) برابری تابع تجمیع
همان ۳۰۰۰ ردیف در v1 و v2 ریخته شد و `bump` واقعی روی ردیف‌های بازخوانی‌شده اجرا شد:

```
tavan_mellat   diffs: []   total v1=3000 v2=3000
tavan_resalat  diffs: []   total v1=3000 v2=3000
tavan_postbank diffs: []   total v1=3000 v2=3000
```
مقایسه‌ها: `total`، `byStatus`، `flags`، `counters`، `cats`، `catTotals`، `catSplit`،
`catAlerts`، `cross`، `services`، `paths` و تمام مقادیر metricها.

### ب) برابری مسیرهای واقعی API
`bench/golden.js` همان `SummaryService` را یک‌بار روی v1 و یک‌بار روی v2 اجرا می‌کند:

| بررسی | mellat | resalat | postbank |
|---|---|---|---|
| `summary()` (کل آبجکت) | ۰ اختلاف | ۰ اختلاف | ۰ اختلاف |
| `buildDashboard()` | ۰ اختلاف | ۰ اختلاف | ۰ اختلاف |
| `list()` — ۹ حالت (flag/cat/metric/service/slow/creditAlert/all/صفحه‌بندی/وضعیت) | ۹/۹ یکسان | ۹/۹ یکسان | ۹/۹ یکسان |
| `report()` — HTML کامل | **بایت‌به‌بایت یکسان** | یکسان | یکسان |

### ج) برابری پس از مهاجرت واقعی
`bench/migrate-test.js`: دیتابیس v1 پر شد → `V1ToV2Migration.execute()` → خروجی‌ها
دوباره مقایسه شد (summary/list/report) → سپس `rollback()` و اثبات اینکه v1 دست‌نخورده
کار می‌کند:

```
summary: true  list: true  report: true   (هر سه بانک)
rollback restored: mellat, resalat, postbank, day_runs
v1 works after rollback: true
```

## تأخیر مسیرهای خواندن — اندازه‌گیری صادقانه

`bench/bench-latency.js` هر حالت را در یک **پروسهٔ جدا** اجرا می‌کند (هر PGlite ≈ ۵۰۰ MB؛
سندباکس ۲ GB است) و میانهٔ ۵ اجرا را می‌دهد. بازتولید:

```bash
cd bench
MODE=v1 PER_BANK=500 node bench-latency.js   # → latency-v1.json
MODE=v2 PER_BANK=500 node bench-latency.js   # → latency-v2.json
```

۵۰۰ ردیف در هر بانک (میانه، میلی‌ثانیه):

| مسیر | mellat v1 → v2 | resalat v1 → v2 | postbank v1 → v2 |
|---|---|---|---|
| `summary()` | ۱۶۹٫۴ → **۲۰۱٫۵** | ۱۸۴٫۰ → **۱۷۵٫۲** | ۱۹۳٫۷ → **۱۵۸٫۹** |
| `list(type=all)` | ۸٫۸ → **۱۴٫۷** | ۸٫۵ → **۱۶٫۲** | ۸٫۴ → **۱۶٫۹** |
| `list` با پرچم | ۷٫۷ → **۱۵٫۰** | ۲٫۰ → **۱٫۸** | ۸٫۴ → **۱۶٫۶** |
| `list` با metric | ۱۰٫۴ → **۱۳٫۱** | ۴٫۲ → **۱٫۶** | ۱۲٫۶ → **۱۷٫۰** |
| `report()` | ۴۳۲٫۵ → **۴۴۷٫۳** | ۲۸۴٫۰ → **۳۰۹٫۸** | ۴۶۶٫۸ → **۴۳۷٫۷** |

جمع‌بندی بی‌تعارف:

- **فضا برندهٔ اصلی است، نه تأخیر.** ۱۲ تا ۲۲ برابر کوچک‌تر شدن ردیف و حذف ۱۹ ایندکس
  تکراری، هزینهٔ İ/O و backup را در مقیاس واقعی می‌شکند؛ در ۵۰۰ ردیف اثری ندارد.
- **`/api/list` در v2 حدود ۸ میلی‌ثانیه کندتر است** (۸→۱۶). علت دقیق، اندازه‌گیری‌شده است:
  خواندن ۲۲ ستون typed از PGlite~۲ برابر خواندن ۹ ستون `text`+`jsonb` هزینه دارد
  (۹ms در برابر ۴ms) — سرباری در لایهٔ JS/WASM، نه در SQL. با حذف join به `sample_detail`
  و حذف hydration، این عدد از ۳۴ms به ۱۵ms رسید؛ باقی، هزینهٔ decode است.
- **`report()` و `summary()` عملاً برابرند** (±۱۰٪، در دو بانک v2 کمی سریع‌تر) چون گلوگاه
  آن‌ها منطق JS است نه پلن SQL.
- **در ۳۰۰۰ ردیف، v2 در همین سندباکس با `MODE=v2` کامل نشد** (OOM در PGlite، exit ۱۳۷)؛
  پس هیچ عدد ۳۰۰۰-ردیفی برای v2 گزارش نمی‌کنم. عدد v1 ۳۰۰۰-ردیفی موجود است
  (`bench/latency-v1.json`: summary ۹۴۸ms، report ۱٫۶ ثانیه) و روند خطی است.

## آزمون دودی HTTP (۱۹ پاسخ، دو سرور واقعی)

`bench/smoke/` دو سرور JSON با همان `SummaryService` بالا می‌آورد — یکی روی v1 (پورت ۴۵۷۱)
و یکی روی v2 (۴۵۷۲)، هر دو PGlite با ۱۲۰ ردیف در هر بانک — و پاسخ‌ها را بایت‌به‌بایت
(پس از نرمال‌سازی کلیدهای زمانی مثل `updated_at`/`generatedAt`) مقایسه می‌کند:

```bash
bash bench/smoke/run.sh        # → «همهٔ پاسخ‌های HTTP یکسان»
```

پوشش: `/api/summary` ×۳ بانک، `/api/list` ×۶ حالت ×۳ بانک، `/api/banks` = **۱۹ پاسخ**.

## پنج دام واقعی که این آزمون‌ها لو دادند

1. **مقدار سرویس رشته است، نه `{kind}`** → همهٔ سرویس‌ها `missingService` می‌شدند.
2. **`unpackServiceKinds` کلید/مقدار را برعکس می‌خواند** → خروجی همیشه `{}`.
3. **فهرست سرویس‌ها `expectedServices ∪ SERVICE_FA` است**، نه فقط `expectedServices`.
4. **ترتیب کلیدهای `jsonb`** ترتیب ستون‌های گزارش HTML را تعیین می‌کند
   (اول طول، بعد بایت‌به‌بایت)؛ بازسازی ساده‌لوحانه، ستون‌ها را جابه‌جا می‌کند.
5. **`request_id` نوع `text` است** و به `uuid` تبدیل می‌شود → شناسه‌های غیر-UUID باید
   نگاشت شوند و مقدار اصلی برگردد (`external_id` + UUIDv5).

همچنین `CREATE INDEX … ON samples_x (day, ts, …)` روی جدول v1 (که `ts` ندارد) شکست
می‌خورد؛ `applySchemaV2` حالا این وضعیت را **صریح** تشخیص می‌دهد و پیام می‌دهد، نه
خطای مبهم. (همان کلاس باگی که در v1 ایندکس تکراری می‌ساخت.)

## راهنمای عملیات

```bash
# ۱) اسکیمای v1 (اگر تازه‌سازی)
npm run migrate

# ۲) دیدن نقشهٔ مهاجرت بدون تغییر
npm run migrate:v2:dry

# ۳) مهاجرت (پشتیبان‌گیری خودکار از samples_* و day_runs)
npm run migrate:v2

# ۴) فعال‌سازی v2 برای API و ingest
CE_DB_SCHEMA=v2 npm start

# بازگشت اضطراری
npm run migrate:v2:rollback
```

مهاجرت **غیرمخرب** است: جدول‌های v1 به `samples_*_v1_backup` و `day_runs_v1_backup`
تغییر نام می‌دهند و حذف نمی‌شوند. پس از اطمینان، پشتیبان‌ها را دستی حذف کن.

## آزمون‌ها

- `npm test` → ۴۷ آزمون (۱۰ آزمون جدید در `tests/schema-v2.test.js`، بدون نیاز به DB).
- `bench/golden.js` → برابری API/v2.
- `bench/migrate-test.js` → مهاجرت + rollback.
- `bench/parity2.js` → برابری تجمیع + اندازه‌گیری.
- `bench/smoke/run.sh` → برابری HTTP دو سرور v1/v2.
- `bench/bench-latency.js` → تأخیر (یک حالت در هر پروسه).
- بررسی ادعاهای ممیزی: `docs/audit-claims-review.md`.

## کار باقی‌مانده (فاز ۳)

1. انتقال `summary` به تجمیع SQL روی `day_rollup` و حذف تدریجی مسیر بازسازی.
2. سیاست نگهداشت پارتیشن (حذف ماه‌های قدیمی + بایگانی) و اجرای `ensureMonthlyPartitions` از cron.
3. سقف `row_cap` برای `sample_detail` در ingestion واقعی (اکنون همهٔ ردیف‌های دارای
   جزئیات ذخیره می‌شوند؛ در گزارش حداکثر ۱۰۰ نمایش داده می‌شود).
