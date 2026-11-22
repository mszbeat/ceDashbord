# گزارش بخش ۹ — بازبینی دور دوم (باگ‌ها، فازهای ۳/۳‑الف/۴/۵، فرانت‌اند F1–F10)

تاریخ: ۱۴۰۵‑۰۸‑۲۳ (2026‑11‑14) · شاخه: `main` · آخرین کامیت: `ce3caff`

همهٔ اعداد این گزارش از اجرای واقعی روی همین ماشین آمده‌اند (PostgreSQL 17 روی پورت ۵۴۳۳،
Node 20، PGlite برای golden). هرجا چیزی اندازه‌گیری نشده، صریح نوشته شده است.

---

## ۱) وضعیت هر آیتم

| آیتم | خواسته | وضعیت | شاهد |
|---|---|---|---|
| B1 | `day_runs` پشت dialect با ستون یکسان؛ `distinct_stored`؛ تفکیک «رد مجاز»/«خطا» | ✅ | integration «B1: updateRun در v2 ستون skipped_count…» (pass) |
| B2 | rebuild در v2 چیزی پاک‌نشده می‌ماند؛ یک تابع Jalali→Gregorian؛ حذف `sample_detail`/`day_rollup` در همان تراکنش | ✅ | integration «B2: rebuild روز شمسی ۱۰ → ۷» (pass) |
| B3 | DDL پارتیشن پیش از `BEGIN` | ✅ | integration B3 (pass) |
| B4 | حذف `external_id`/`uuid-map`/`COALESCE`؛ رد `request_id` غیر‑UUID؛ keyset `(day, ts, request_id)`؛ EXPLAIN بدون Sort | ✅ | ۳ تست B4 (pass) |
| B5 | بدون bloat در بازنویسی؛ fillfactor/autovacuum؛ رانبوک VACUUM/repack | ✅ | integration «B5: بازنویسی بدون تغییر، tuple مرده نمی‌سازد» + `docs/RUNBOOK.md §۴` |
| B6 | سنجش روی PG واقعی + توضیح OOM در PGlite | ✅ | اعداد فاز ۳ در جدول ۲ |
| B7 | تست انتها‑به‑انتها ingestion→summary→rebuild→resume با برابری v1 | ✅ | integration «B7…» (pass) |
| ۳ | سرعت/حافظه داشبورد، تجمیع در SQL، rollup، کش single-flight، سقف ۴۱۳/۴۲۹ | ✅ | جدول ۲ |
| ۳‑الف | صفحه ۱۰۰تایی با دسترسی به همهٔ رکوردها، `items/total/nextCursor`، keyset، `total` از rollup | ✅ | ۳ تست صفحه‌بندی (pass) + `frontend/lib/pager.mjs` |
| ۴ | `complete` فقط با برابری تعداد یکتا، قفل روز، SIGTERM→interrupted، retry/backoff | ✅ | ۴ تست فاز ۴ (pass) |
| ۵ | D1…D6، نگهداشت، healthz/readyz، متریک، CI، fail-fast، رانبوک | ✅ | `a5757ce`+`ef9eaf4`+`965ffe0` |
| F1 | پروکسی گزارش: مهلت + جریان | ✅ | جدول ۳ (۱۰٬۴۸۵ms → ۱۴۲ms) |
| F2 | حذف probe تکراری | ✅ | جدول ۴ (۲ → ۱) |
| F3 | متن خام خطا به کاربر نرود | ✅ | `tests/proxy-rules.test.mjs` |
| F4 | `sanitizeNextPath` با `URL` و same-origin | ✅ | ۴ تست، ۱۹ حملهٔ open redirect رد می‌شود |
| F5 | keepalive/lock، بدون نشتی تایمر | ✅ | ۵ تست polling |
| F6 | شکستن `AdminClient.tsx` | ✅ | ۱۵۰۸ → ۱۳۶۱ خط + `format.tsx` (۹۶) + `JobsMonitor.tsx` (۱۳۶) |
| F7 | polling با abort/توقف/backoff | ✅ | ۵ تست polling + `AbortController` در overview |
| F8 | اعتبارسنجی + خطای پروکسی | ✅ | ۷ تست api/proxy |
| F9 | کلیدهای تم، a11y، بازبینی XSS | ✅ | ۷ تست امنیت/a11y |
| F10 | تست‌ها + Next پچ‌شده | ✅ | ۴۵ → **۵۷** تست؛ Next `14.2.35` |

**هیچ آیتمی «انجام‌نشده» نمانده است؛** موارد بازِ باقی‌مانده در بخش ۶ فهرست شده‌اند (ریسک، نه کار ناتمام).

---

## ۲) اعداد پایه و نهایی (بک‌اند، ۱٫۲ میلیون ردیف)

| سنجه | قبل (مسیر قدیمی) | بعد | یادداشت |
|---|---|---|---|
| summary سرد p50 / p95 | **60٬569 ms** | **59 ms / 77.9 ms** | تجمیع در SQL + rollup |
| summary گرم (کش) p50 / p95 | — | **1.8 / 2.1 ms** | کش کلید `(bank, range, filters, version, rebuild)` |
| تعداد کوئری هر درخواست | ۶۰ | **۴** | متریک‌ها در یک کوئری |
| list p50 / p95 | — | **50.2 / 63.1 ms** | keyset، بدون Sort |
| RSS پروسه | ۶۵ MB | ۶۵ → ۸۳ → ۸۶ MB (پایدار) | مستقل از تعداد ردیف |
| heap | ۱۵ MB | ۱۵ → ۲۰ MB | — |
| حجم جداول (v2) | — | ۲۹۰ / ۲۵۵ / ۲۳۵ MB | `pg_total_relation_size` |
| ساخت rollup / seed / amplify | — | ۹۴s / ۱۳s / ۳۰s | یک‌بار در روز |

اعدام PGlite در ۳۰۰۰ ردیف: محدودیت حافظهٔ WASM (`OOM`) بود، نه کد؛ روی PG واقعی همان مسیر بی‌خطا اجرا شد
و تست‌های integration همه با `max-old-space-size` پیش‌فرض پاس می‌شوند.

---

## ۳) فرانت‌اند — قبل/بعد اندازه‌گیری‌شده

### F1: مسیر داشبورد (`/` → `app/route.ts`)
بک‌اند قلابی آرام: ۲ MiB با ۸ KiB هر ۴۰ms (کل بدنه ~۱۰٫۳ ثانیه). ابزار: `bench-front/clean-measure.sh`
(هر نسخه در کپی جدا، `.next` پاک، **تأیید باندل** که همان نسخه است).

| نسخه | اولین بایت | پایان بدنه | پخش بدنه | حکم |
|---|---|---|---|---|
| قبل (`await response.text()`) | **۱۰٬۴۸۵ ms** | ۱۰٬۴۸۹ ms | ۴ ms | بافر: کاربر ۱۰ ثانیه صفحهٔ سفید می‌دید |
| بعد (`new Response(response.body)`) | **۱۴۲ ms** | ۱۰٬۴۴۲ ms | ۱۰٬۳۰۰ ms | جریان: صفحه بلافاصله شروع می‌شود |

همچنین: مهلت اتصال/هدرها (`CE_REPORT_HEADERS_TIMEOUT_MS`, پیش‌فرض ۳۰s) و نگهبان سکون جریان.

> **یافتهٔ مهم:** در مرورگر، `/api/report` به‌خاطر `rewrites` در `next.config.js` مستقیم به بک‌اند
> می‌رود و از `route.ts` عبور نمی‌کند؛ مسیر واقعی داشبورد `/` است. سه سنجش اول من روی `/api/report`
> بود و به همین دلیل «قبل/بعد یکسان» درمی‌آمد — همان پوششِ rewrite، نه جریان‌بودن کد. تصحیح شد.

### F2: پرس‌وجوی تکراری نشست (`/admin`)

| نسخه | فراخوانی `/api/auth/me` به‌ازای هر بازدید |
|---|---|
| قبل | **۲** (یک middleware + یک صفحهٔ سروری) |
| بعد | **۱** (نشست امضاشده با HMAC از middleware به صفحه؛ اعتبارسنجی در همان صفحه) |

بدون `CE_SESSION_HANDOFF_SECRET` رفتار قبلی برمی‌گردد (سرویس متوقف نمی‌شود).

---

## ۴) برابری خروجی (snapshot طلایی) و شمار تست‌ها

`cd bench && PER_BANK=60 node golden.js` — هر سه بانک:

```
## tavan_mellat    summary equal: true | dashboard equal: true | report equal: true | list: all equal
## tavan_resalat   summary equal: true | dashboard equal: true | report equal: true | list: all equal
## tavan_postbank  summary equal: true | dashboard equal: true | report equal: true | list: all equal
```

۹ بررسی برابری، **diff صفر**. مقایسه روی مقدار خام است (مثلاً PD دقیقاً 0.5).

| مجموعه | پایه (شروع دور ۲) | نهایی |
|---|---|---|
| تست واحد بک‌اند | — | **۵۶/۵۶** |
| تست یکپارچه (PG واقعی) | ۱۳ | **۲۲/۲۲** |
| تست فرانت‌اند | ۲۰ | **۵۷/۵۷** |
| golden | ۳ بانک | **۳ بانک، ۹ بررسی equal** |
| `tsc --noEmit` (فرانت) | — | **پاک** |
| `next build` | — | **موفق** |
| `node scripts/secret-scan.js` | — | **پاک** |

---

## ۵) فهرست کامیت‌ها و روش برگشت

| کامیت | موضوع | برگشت |
|---|---|---|
| `ce3caff` | رفع دو باگ واقعی ارتقا (`day_runs` و `schema_migrations`) | `git revert ce3caff` — مهاجرت ۰۰۵ فقط افزایشی است؛ برای برگشت نوع `day` به text باید دستی `ALTER` شود (در RUNBOOK §۱۰) |
| `965ffe0` | CI فرانت‌اند (تست/تایپ‌چک/بیلد/audit) | `git revert 965ffe0` |
| `ef9eaf4` | `migrate` نسخه‌دار، `migrate:status`، `assertEnv`، چرخش TLS | `git revert ef9eaf4` |
| `f4e5d79` | فرانت‌اند F1–F10 + Next 14.2.35 | `git revert f4e5d79` (وابستگی: `npm ci`) |
| `a5757ce` | فاز ۵ | `git revert a5757ce` |
| `c7eb89c` | فاز ۴ | `git revert c7eb89c` |
| `79db319` | فاز ۳ | `git revert 79db319` |
| `87a1aeb` | ۳‑الف (صفحه‌بندی) | `git revert 87a1aeb` |
| `d77970e` | تجمیع SQL + rollup + کش | `git revert d77970e` |
| `9c9e0f6` | B4/B5 | `git revert 9c9e0f6` |
| `5e63c56` | فاز ۲‑ب (B1/B2/B3) | `git revert 5e63c56` |
| `067c193` | schema v2 + dialect + مهاجرت | `git revert 067c193` + `npm run migrate:v2:rollback` |

قاعدهٔ کلی برگشت: `git revert <sha>` (کامیت جدید می‌سازد، تاریخچه دست‌نخورده) و سپس `npm run migrate`.
برای برگشت **داده** از v2 به v1: `npm run migrate:v2:rollback` (روی دیتابیس آزمایشی بررسی شد).

---

## ۶) تصمیم دربارهٔ مقدار پیش‌فرض `CE_DB_SCHEMA`

**تصمیم: پیش‌فرض روی `v1` می‌مانَد.** دلیل، شاهد و شرط تغییر:

معیار اعلام‌شده: «فقط اگر همهٔ معیارهای ردیف ۱ پاس شوند». وضعیت:

| معیار | نتیجه |
|---|---|
| برابری summary/dashboard/report در هر سه بانک | ✅ diff صفر |
| برابری فهرست‌ها (۳‑الف) در هر سه بانک | ✅ `list: all equal` |
| تست یکپارچه روی PG واقعی برای مسیرهای v2 | ✅ ۲۲/۲۲ |
| مهاجرت/برگشت غیرمخرب قابل اجرا | ✅ (migrate:v2 + rollback، هر سه بانک) |
| **بوت واقعی سرویس با `CE_DB_SCHEMA=v2` روی دیتابیس موجود** | ❌ **دو باگ مسدودکننده پیدا شد** |

باگ‌ها در همین بازبینی پیدا و رفع شدند (`ce3caff`)، اما **خروجی نهایی روی داده واقعی شما اجرا نشده است**:
داده‌های این ماشین ساختگی‌اند (۳۰ ردیف در هر بانک) و شمارش‌های واقعی شما را نمایندگی نمی‌کنند.
قاعدهٔ خودتان: «هر ادعا با شاهد؛ اگر اندازه‌گیری نشد، عدد جعل نشود».

**شرط تغییر پیش‌فرض به `v2` (چک‌لیست قابل اجرا):**

```bash
cd backend
npm run migrate && npm run migrate:v2         # ۱) مهاجرت غیرمخرب
CE_DB_SCHEMA=v2 npm start                     # ۲) بوت با v2
curl -s localhost:3000/api/readyz             # ۳) باید 200 ready بدهد
curl -s "localhost:3000/api/summary?bank=tavan_mellat&from=...&to=..." > /tmp/v2.json
CE_DB_SCHEMA=v1 ... (نمونهٔ v1)               # ۴) مقایسهٔ خروجی همان بازه با v1
# ۵) سپس در .env: CE_DB_SCHEMA=v2
```
اگر مرحلهٔ ۴ diff صفر داد ⇒ پیش‌فرض را `v2` کنید. برای برگشت کافی است `CE_DB_SCHEMA=v1` شود.

---

## ۷) باگ‌هایی که در همین بازبینی پیدا و رفع شدند (غیر از فهرست اولیه)

1. **`day_runs` از v1 ارتقا نمی‌یافت** — `CREATE TABLE IF NOT EXISTS` در `002` جدول موجود را
   تغییر نمی‌دهد؛ نتیجه: `day` متن می‌ماند، `distinct_stored` اضافه نمی‌شود و `CE_DB_SCHEMA=v2`
   با «column "distinct_stored" does not exist» و سپس «operator does not exist: text >= date» می‌شکست.
   → مهاجرت `005-v2-day-runs-upgrade.sql` + تست دائمی.
2. **`schema_migrations` دو مالک داشت** — رانر نسخه‌دار (`name/checksum NOT NULL`) و
   `schema-v2.sql`/`migrate-v2.js` (فقط `version`) ⇒ «null value in column "name"».
   → رانر ستون‌ها را با `ALTER` اضافه می‌کند؛ builder/migrate-v2 ردیف سازگار می‌نویسند.
3. **جداول typed در بوت ساخته نمی‌شدند** — با `CE_DB_SCHEMA=v2` هیچ‌جا `applySchemaV2` صدا زده
   نمی‌شد؛ سرویس بالا می‌آمد و اولین کوئری می‌شکست. → تضمین در `container.init()` با خطای
   راهنمادار `V2_SCHEMA_NOT_READY`.
4. **`normalizeRows` در `summary.service` قبل از تعریف استفاده می‌شد** (خطای رانتایم در list).
5. **`migrate:status` شکل خروجی `migrationStatus` را اشتباه فرض کرده بود** (آرایه، نه شیء).
6. **اندازه‌گیری‌های اولیهٔ F1/F2 بی‌اعتبار بودند** (مسیر اشتباه `/api/report`، بیلد کهنه،
   سرور باقی‌مانده روی پورت). سنجش‌ها با تأیید باندل و پورت تصادفی بازانجام شد.

---

## ۸) ریسک‌ها و پرسش‌های باز

1. **Next 14.2.35 = آخرین پچ ۱۴٫۲ است** و `npm audit` همچنان ۱ مورد critical روی Next 14.x
   گزارش می‌کند (رفع در ۱۵/۱۶). سطح حمله محدود شد (`images` تعریف نشده، `next/image` استفاده
   نمی‌شود، `remotePatterns` نداریم، `poweredByHeader:false`) و `postcss` داخلی Next با
   `overrides` به ۸٫۵٫۳۳ پچ شد. **مهاجرت به Next 15/16 یک تغییر ناسازگار است و باید جداگانه
   برنامه‌ریزی شود** (اولین گام پیشنهادی: Next 15 با `codemod` و اجرای همان ۵۷ تست).
2. **`middleware.ts` برای `/api/*` اجرا نمی‌شود** (matcher). یعنی `/api/report` در مرورگر از
   لایهٔ BFF `route.ts` عبور نمی‌کند و مستقیم به بک‌اند می‌رود؛ محافظت واقعی همان گارد خود بک‌اند
   است. اگر می‌خواهید هدرهای BFF روی `/api/*` هم اعمال شوند، باید `source` را در `rewrites` به
   route داخلی تغییر داد — این تصمیم محصولی است و بدون تأیید شما انجام نشد.
3. **`day_runs.day` اکنون `date` است** (نتیجهٔ مهاجرت ۰۰۵). مسیر v1 تست شد و سالم است، اما هر
   ابزار بیرونی که `day` را متن فرض کرده باشد (اسکریپت گزارش‌گیری، BI) باید بازبینی شود.
4. **ستون `skipped_count` حذف نشد** (عملیات مخرب بود)؛ در v2 نام رسمی `skipped_other_method`
   است. کدِ قدیمی می‌تواند `skipped_count` را ببیند و صفر بماند — اگر لازم است آینه شود، بگویید.
5. **داده واقعی هنوز روی v2 اجرا نشده** (بخش ۶). تا اجرای چک‌لیست، اعداد کارایی v2 فقط روی
   داده ساختگی است.
6. **`CE_SESSION_HANDOFF_SECRET` در production الزامی است** وگرنه F2 بی‌اثر می‌شود (بی‌خطر، ولی
   دو بار `/me`). در `frontend/.env.example` مستند شد؛ در `docs/RUNBOOK.md` پیشنهاد می‌شود به
   چک‌لیست استقرار اضافه شود.

---

## ۹) دستورهای تکرارپذیر (برای بازبینی)

```bash
# بک‌اند
cd backend
NODE_PATH=/home/user/bench/node_modules node --test tests/*.test.js                       # 56/56
CE_TEST_PG=1 PGPORT=5433 NODE_PATH=/home/user/bench/node_modules \
  node --test tests/integration/*.test.js                                                # 22/22
cd ../bench && PER_BANK=60 NODE_PATH=/home/user/bench/node_modules node golden.js          # 9 × equal
cd .. && node scripts/secret-scan.js                                                      # پاک

# فرانت‌اند
cd frontend
npm test                                                                                  # 57/57
npx tsc --noEmit && npm run build

# سنجش F1 (قبل/بعد)
cd /home/user/bench-front && ./clean-measure.sh before && ./clean-measure.sh after
# سنجش F2
./measure-probe.sh before && ./measure-probe.sh after
```

فایل‌های شاهد سنجش: `bench-front/RESULTS.md`، `/tmp/before-slow.json`، `/tmp/after-slow.json`.
