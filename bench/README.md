# bench — آزمون‌های برابری و کارایی v1 ↔ v2

این اسکریپت‌ها بیرون از `backend/` اجرا می‌شوند و به `@electric-sql/pglite` نیاز دارند.

**fixtureها داخل ریپو نیستند** (نمونه‌های واقعی شامل کد ملی، موبایل، نام و `sourceIp` هستند و
طبق قواعد حریم خصوصی v1 نباید کامیت شوند). آن‌ها را از مسیر خارج ریپو بده:

```bash
export CE_SAMPLES=/path/to/samples    # شامل mellat.json، postbank.json، s.json
```

```bash
NODE_PATH=/home/user/bench/node_modules   # یا هر جا که pglite نصب است
```

| اسکریپت | کار |
|---|---|
| `common.js` | بارگذاری evaluator، fixtureها (`../ref/samples`)، ساخت ردیف و adapter دیتابیس |
| `parity2.js` | همان ۳۰۰۰ ردیف را در v1 و v2 می‌ریزد و نتیجهٔ تجمیع را بایت‌به‌بایت می‌سنجد + اندازه‌گیری حجم |
| `golden.js` | همان `SummaryService` را روی v1 و v2 اجرا می‌کند و `summary`/`dashboard`/`list` (۹ حالت)/`report` را مقایسه می‌کند |
| `migrate-test.js` | دیتابیس v1 → `V1ToV2Migration.execute()` → مقایسهٔ خروجی → `rollback()` → اثبات سالم بودن v1 |
| `bench-latency.js` | تأخیر مسیرهای خواندن؛ **هر حالت در یک پروسهٔ جدا** (`MODE=v1|v2`) |
| `smoke/run.sh` | دو سرور HTTP واقعی (v1 روی ۴۵۷۱، v2 روی ۴۵۷۲) و مقایسهٔ ۱۹ پاسخ |

نمونهٔ اجرا:

```bash
PER_BANK=150 node golden.js
PER_BANK=150 node migrate-test.js
MODE=v1 PER_BANK=500 node bench-latency.js
MODE=v2 PER_BANK=500 node bench-latency.js
bash smoke/run.sh
```

⚠️ سندباکس ~۲GB RAM دارد؛ هر PGlite حدود ۵۰۰MB می‌گیرد. **هرگز دو دیتابیس PGlite را در
یک پروسه بالا نیاور** (exit ۱۳۷). به همین دلیل `bench-latency.js` حالت‌ها را جدا اجرا می‌کند.

جزئیات طراحی و نتیجه‌ها: `../docs/schema-v2.md`.
