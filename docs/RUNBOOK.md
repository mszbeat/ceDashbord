# کتابچهٔ اجرا (Runbook) — داشبورد CE

این سند کارهای روزمرهٔ عملیاتی را با فرمان‌های واقعی و روش برگشت توضیح می‌دهد.
فرض: PostgreSQL 17 و دسترسی `psql`؛ متغیرهای محیطی از `backend/.env` خوانده می‌شوند.

## ۱) سلامت سرویس

```bash
curl -s localhost:3000/api/healthz   # زنده بودن پروسه (بدون DB)
curl -s localhost:3000/api/readyz    # 200 آماده / 503 ناسالم (DB، جداول، روز گیرکرده)
curl -s localhost:3000/api/diagnostics -b 'cookie: ...'   # فقط ادمین: متریک‌ها و استخرها
```

`/api/readyz` سه چیز را چک می‌کند: اتصال دیتابیس، وجود جداول اصلی
(`day_runs`, `samples_*`, `sample_detail`) و نبود روزی که بیش از ۶ ساعت در وضعیت
`running/partial` مانده است (`CE_INCOMPLETE_STALE_HOURS`).

## ۲) مهاجرت ساختار (نسخه‌دار)

```bash
cd backend
npm run migrate:status    # چه چیزی اعمال شده، آیا checksum می‌خورد
npm run migrate           # اعمال مهاجرت‌های تازه (idempotent)
```

خروجی واقعی روی PostgreSQL (اجرای اول و دوم):

```
فایل‌های مهاجرت: 4
اعمال‌شده: 4 (آخرین: 004-sample-access-actor.sql)
در انتظار: 0
✅ اسکیما به‌روز است؛ مهاجرت جدیدی نبود.
```

* `schema_migrations` تنها منبع حقیقت است؛ `schema.sql` دیگر در هر شروع اجرا نمی‌شود.
* هر مهاجرت در یک تراکنش و زیر قفل مشورتی `ce-schema-migrations` اجرا می‌شود.
* **قاعده:** فایل اعمال‌شده را هرگز ویرایش نکنید؛ فایل جدید با شمارهٔ بعدی بسازید
  (اجرای بعدی به‌خاطر checksum خطا می‌دهد و این عمدی است).

## ۳) ورود داده (ingestion)

```bash
cd backend
npm run ingest:mellat                       # دیروز، همهٔ بانک‌ها/روز
node services/ingestion/run-ingest.js --bank=tavan_mellat --day=1405-08-01 --rebuild
```

* قفل per `(bank, day)` است؛ اجرای دوم تا `CE_INGEST_LOCK_WAIT_SECONDS` (۵ ثانیه) منتظر
  می‌ماند و بعد **۴۰۹ `ingestionLocked`** می‌دهد.
* `complete` فقط وقتی: همهٔ صفحه‌ها خوانده شده + `COUNT(DISTINCT request_id)` دقیقاً برابر
  `source_total − skipped_other_method` + `error_count = 0`. در غیر این صورت
  `needs_review` و هشدار `ingestion.day.needs_review`.
* خاموشی (SIGTERM/SIGINT): اجراهای در جریان `interrupted` می‌شوند؛ روز `interrupted`
  هرگز rollup نمی‌سازد.

### بازسازی یک روز

```bash
node services/ingestion/run-ingest.js --bank=tavan_resalat --day=1405-08-03 --rebuild
```

حذف ردیف‌های روز **داخل همان تراکنش** انجام می‌شود (`DELETE` ایندکس‌محور روی
`samples_*` و `sample_detail`؛ هرگز `DROP PARTITION`). اگر تراکنش برگشت بخورد، دادهٔ
قبلی دست‌نخورده می‌ماند.

## ۴) bloat و بازسازی فیزیکی

* `ON CONFLICT ... DO UPDATE ... WHERE ... IS DISTINCT FROM` باعث می‌شود بازنویسی ردیف
  بدون تغییر، tuple مرده نسازد.
* پایش: `SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;`
* اگر `n_dead_tup` بیش از ۲۰٪ `n_live_tup` شد:

```sql
VACUUM (VERBOSE, ANALYZE) samples_mellat;   -- بدون قفل مسدودکننده
-- یا بدون قفل جدی، برای یک پارتیشن خاص:
VACUUM (VERBOSE, ANALYZE) samples_mellat_2026_10_01_2026_11_01;
```

* برای جدول‌های بزرگ می‌توان `pg_repack` را جداگانه اجرا کرد (نیاز به افزونه دارد)؛
  پیش‌فرض پیشنهادی: `fillfactor=90` روی پارتیشن روز جاری و `autovacuum_vacuum_scale_factor=0.05`.

## ۵) نگهداشت داده

```bash
cd backend && node services/maintenance/retention.service.js
```

* پیش‌فرض: `sample_access_logs` بیش از ۱۸۰ روز، `backend_action_logs` بیش از ۹۰ روز.
* دسته‌ای و با `LIMIT` پاک می‌شود (`CE_RETENTION_BATCH`)، هرگز روی `samples_*` یا
  `day_rollup` دست نمی‌گذارد.

## ۶) پشتیبان‌گیری

```bash
pg_dump -Fc -f ce-$(date +%F).dump "$DATABASE_URL"
pg_restore -l ce-$(date +%F).dump | head          # فهرست محتوا
```

* بازگردانی روی دیتابیس تازه: `createdb ce_restore && pg_restore -d ce_restore ce-*.dump`
* پارتیشن‌ها با `pg_dump` عادی پوشش داده می‌شوند؛ نیازی به کار خاص نیست.

## ۷) برگشت (Rollback)

| تغییر | روش برگشت |
|---|---|
| `CE_DB_SCHEMA=v2` | `CE_DB_SCHEMA=v1` و ری‌استارت؛ دادهٔ v1 دست‌نخورده است |
| مهاجرت ساختار | مهاجرت‌ها فقط افزایشی‌اند؛ برای برگشت، فایل `005-...` با `ALTER ... DROP` بنویسید |
| دادهٔ یک روز | اجرای دوباره با `--rebuild` (تراکنشی) |
| پارتیشن | `DROP TABLE samples_x_YYYY_MM_DD_YYYY_MM_DD` فقط با تأیید صریح مالک داده |

## ۸) چرخش گواهی TLS

پروتکل `http` در production رد می‌شود (D5)؛ همهٔ ترافیک باید `https` باشد.
برای چرخش بدون قطعی:

1. گواهی جدید را در مسیر `CE_TLS_CERT_PATH` کنار گواهی فعلی قرار دهید (نه روی آن).
2. اگر پروکسی معکوس (nginx/آپ‌استریم) دارید: ابتدا آن را با گواهی جدید ری‌لود کنید
   (`nginx -t && nginx -s reload`) و با `curl -vI https://<host>` تاریخ `expire date` را ببینید.
3. سپس سرویس بک‌اند را ری‌استارت کنید: `systemctl restart ce-backend`
   (چون `CE_DB_SSL` و مسیر گواهی در بوت خوانده می‌شوند).
4. بررسی سلامت: `curl -s https://<host>/api/readyz` باید `ready` بدهد، نه `degraded`.
5. گواهی قدیمی را فقط بعد از یک چرخهٔ کامل ترافیک حذف کنید (rollback فوری ممکن بمانَد).

* اعتبار گواهی را هشدار دهید: `openssl x509 -enddate -noout -in <cert>` — کمتر از ۳۰ روز = اقدام.

## ۹) هشدارها

| هشدار | معنی | اقدام |
|---|---|---|
| `ingestion.incomplete_days` | روز ناقص بیش از ۶ ساعت | `/api/runs` و سپس rebuild همان روز |
| `summary_slow_total` | خلاصهٔ بیش از ۱٫۵ ثانیه | `/api/diagnostics` → `metrics`، بررسی `day_rollup` |
| `ingestionLocked` (۴۰۹) | اجرای موازی همان روز | پایان اجرای جاری و تلاش دوباره |
| `rangeTooLarge` (۴۱۳) | بازه بیش از `CE_MAX_RANGE_DAYS` | بازهٔ کوچک‌تر یا افزایش سقف |
| `tooManyRequests` (۴۲۹) | هم‌زمانی بیش از `CE_MAX_CONCURRENT_READS` | تلاش دوباره با `Retry-After` |
