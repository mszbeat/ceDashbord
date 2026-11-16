# pd2 — CE Dashboard Backend v2 (`partFramework@10.2.0`)

نسخهٔ جدید بک‌اند داشبورد پایش اعتبارسنجی بانکی، **از صفر** و بر پایهٔ معماری مرجع `samplePF`:

- **روتر مرکزی**: همهٔ مسیرها در `routes.js` (نه دکوراتور `@Route`/`@HTTP`)
- **کنترلرهای بدون دکوراتور**: `exports.controller = class ... extends BaseController` + `exports.introduceToLoader = BaseController.exportedProperties(schema, config)`
- **`needProtocolRef: false`** با `params` مرتب در `config.js` هر کنترلر
- **`exception.handler`** مخصوص هر کنترلر برای نگاشت خطا به ساختار استاندارد پارت
- **`checkAccess(true)`** روی هر روتی که هندلرش `_session` می‌گیرد (با `accessControl` فعال در `routerConf.js`)
- **`SessionManager` + `SamadService` + لایهٔ اصالت‌سنجی** به‌صورت وابستگی‌های تزریقی (`Program.js`)

> `partFBackend/` (نسخهٔ قبلی) دست‌نخورده باقی مانده است؛ این پوشه نسخهٔ بازنویسی‌شده است.

---

## ساختار

```
pd2/
├── index.js                     # نقطهٔ ورود (MODE=dev|prod|test)
├── Program.js                   # بوت‌استرپ partFramework + تزریق وابستگی‌ها
├── routes.js                    # ۲۶ روت مرکزی + validate + checkAccess
├── project-config/
│   ├── index.js
│   ├── dev/                     # routerConf (با accessControl), servers, loaderConf, ...
│   ├── prod/  test/             # → dev
├── controllers/
│   ├── auth/                    # auth-controller: اصالت‌سنجی، سشن، نقش سمد
│   ├── summaryController/       # summary-controller: سطح ۱ (کاربر عادی)
│   ├── creditEvaluationController/  # credit-evaluation-controller: سطح ۲
│   └── adminController/         # admin-controller: سطح ۳ (فقط admin)
├── services/                    # دامنه: db, evaluator, ingestion, summary, admin, http helpers
├── scripts/verify-pd2.js        # تست سرتاسری PGlite + بررسی ساختار
└── tests/                       # node --test (معماری + رفتار کنترلرها + لایهٔ auth)
```

هر پوشهٔ کنترلر شامل: `main.js`, `config.js`, `schema.js`, `exceptions/<name>Exception.js`, [`helpers.js`] و `package.json`.

---

## مسیرها و سطوح دسترسی

| سطح | کنترلر | مسیرها | checkAccess |
|---|---|---|---|
| ۰ — اصالت‌سنجی | `auth-controller` | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST|GET /api/auth/role`, `POST /api/auth/remove` | ✅ همه |
| ۱ — کاربر عادی | `summary-controller` | `GET /api/health`, `/api/banks`, `/api/specs`, `/api/report`, `/api/diagnostics`, `/api/summary`, `/api/list`, `/api/runs` | ✅ به‌جز `health` |
| ۲ — `creditEvaluation` + `admin` | `credit-evaluation-controller` | `GET /api/sample/:requestId` | ✅ |
| ۳ — فقط `admin` | `admin-controller` | `GET /api/admin/overview`, `GET|PUT /api/admin/cron`, `POST /api/admin/cron/run-now`, `POST /api/admin/runs/check`, `POST /api/admin/runs/start`, `GET /api/admin/jobs`, `GET /api/admin/jobs/:id`, `POST /api/admin/runs`, `POST /api/runs` | ✅ همه |

قاعدهٔ کلیدی: **هر هندلری که `_session` می‌گیرد، باید در `routes.js` با `.checkAccess(true)` ثبت شده باشد**؛ در غیر این صورت `_session` تزریق نمی‌شود. این قاعده در `tests/routing.contract.test.js` و `scripts/verify-pd2.js` به‌صورت خودکار بررسی می‌شود.

---

## نصب و اجرا

```bash
cd pd2
npm install            # از رجیستری سازمانی پارت
cp .env.example .env   # مقادیر DATABASE_URL / SAMAD_* / PART_AUTH_* / CE_API_*
npm run migrate        # ساخت جداول PostgreSQL
npm start              # http://0.0.0.0:3000/api
```

تست‌ها (بدون نیاز به رجیستری پارت — پکیج‌های فریم‌ورک mock می‌شوند):

```bash
npm test               # node --test + scripts/verify-pd2.js (PGlite)
```

متغیرهای محیطی مهم: `DATABASE_URL`, `BACKEND_PORT`, `BACKEND_HOST`, `SAMAD_ORG`, `SAMAD_SERVICE_URL`, `SAMAD_USER`, `SAMAD_PASS`, `PART_AUTH_USERNAME`, `PART_AUTH_PASS`, `PART_AUTH_SYSTEM`, `CE_API_BASE_URL`, `CE_GATEWAY_TOKEN`.

---

## نکات پیاده‌سازی

- **قالب پاسخ**: مقدار بازگشتی سادهٔ هندلرها توسط `@partFramework/http` در `{ "data": ... }` پیچیده می‌شود؛ فرانت‌اند همین را باز می‌کند. برای HTML زندهٔ گزارش (`/api/report`) از `HttpResult` با `Content-Type: text/html` و `Cache-Control: no-store` استفاده می‌شود (`services/http/result.js`).
- **خطاها**: هر کنترلر دیکشنری خطای خودش را زیر کلید `error` در `config.js` دارد و `exceptions/*Exception.js` آن را به `{ statusCode, meta, data }` نگاشت می‌کند.
- **حریم خصوصی**: `nationalCode` هرگز در دیتابیس یا پاسخ جاب‌ها ذخیره/بازتاب نمی‌شود (فقط به‌عنوان فیلتر ارسالی به سرویس مبدأ).
- **کران**: زمان‌بند شبانه بر مبنای `Asia/Tehran` و از طریق `services/admin/cron-scheduler.service.js` (توسط `Program.js` راه‌اندازی می‌شود).
