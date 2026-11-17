# CE Dashboard Backend (`partFramework`)

بک‌اند داشبورد پایش اعتبارسنجی بانکی بر پایهٔ معماری `partFramework` و الگوی `samplePF`:

- **روتر مرکزی**: همهٔ ۲۷ مسیر در `routes.js` (بدون دکوراتور `@Route`/`@HTTP`)
- **کنترلرهای بدون دکوراتور**: `exports.controller = class ... extends BaseController` + `exports.introduceToLoader = BaseController.exportedProperties(schema, config)`
- **`needProtocolRef: false`** با `params` مرتب در `config.js` هر کنترلر
- **`exception.handler`** مخصوص هر کنترلر برای نگاشت خطا به ساختار استاندارد پارت
- **`checkAccess(true)`** روی مسیرهای نیازمند `_session` و کنترل دسترسی سمد (`accessControl` فعال در `project-config/dev/routerConf.js`)
- **`SessionManager` + `RefreshTokenService` + `SamadService` + `AuthenticationService`** به‌صورت وابستگی‌های تزریقی (`Program.js`) و پشتیبانی از رفرش‌توکن چرخشی (`auth_refresh_tokens`)

---

## ساختار

```text
backend/
├── index.js                     # نقطهٔ ورود (MODE=dev|prod|test)
├── Program.js                   # بوت‌استرپ partFramework + تزریق وابستگی‌ها
├── routes.js                    # ۲۷ روت مرکزی + validate + checkAccess
├── project-config/
│   ├── index.js
│   ├── dev/                     # routerConf (با accessControl), servers, loaderConf, ...
│   ├── prod/  test/             # → dev
├── configs/                     # تنظیمات global/instance پکیج‌های پارت و error configها
├── controllers/
│   ├── auth/                    # auth-controller: ورود/خروج/ثبت‌نام/رفرش‌توکن/نقش سمد
│   ├── summaryController/       # summary-controller: سطح ۱ (صفحهٔ اول، تحلیل‌ها و HTML گزارش)
│   ├── creditEvaluationController/  # credit-evaluation-controller: سطح ۲ (جزئیات نمونه)
│   └── adminController/         # admin-controller: سطح ۳ (فقط admin)
├── services/                    # دامنه: db, evaluator, ingestion, summary, admin, http helpers
├── scripts/check-env.js         # راستیآزمایی متغیرهای محیطی پیش از اجرا
├── scripts/verify-pd2.js        # تست سرتاسری PGlite + بررسی ساختار
└── tests/                       # node --test (قرارداد روتر + رفتار کنترلرها + لایهٔ auth/refresh)
```

---

## مسیرها و سطوح دسترسی

| سطح | کنترلر | مسیرها | checkAccess |
|---|---|---|---|
| ۰ — اصالت‌سنجی | `auth-controller` | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST\|GET /api/auth/role`, `POST /api/auth/remove` | ✅ همه |
| ۱ — کاربر عادی | `summary-controller` | `GET /api/health`, `/api/banks`, `/api/specs`, `/api/report`, `/api/diagnostics`, `/api/summary`, `/api/list`, `/api/runs` | ✅ به‌جز `health` |
| ۲ — `creditEvaluation` + `admin` | `credit-evaluation-controller` | `GET /api/sample?requestId=…` | ✅ |
| ۳ — فقط `admin` | `admin-controller` | `GET /api/admin/overview`, `GET\|PUT /api/admin/cron`, `POST /api/admin/cron/run-now`, `POST /api/admin/runs/check`, `POST /api/admin/runs/start`, `GET /api/admin/jobs`, `GET /api/admin/jobs?id=…`, `POST /api/admin/runs`, `POST /api/runs` | ✅ همه |

قاعدهٔ کلیدی: **هر هندلری که `_session` می‌گیرد، باید در `routes.js` با `.checkAccess(true)` ثبت شده باشد**؛ در غیر این صورت `_session` تزریق نمی‌شود.

---

## نصب و اجرا

```bash
cd backend
npm install                   # از رجیستری سازمانی پارت + PostgreSQL driver
cp .env.example .env          # تنظیم DATABASE_URL / SAMAD_* / PART_AUTH_* / CE_API_*
npm run check:env             # existence/placeholder check for required env vars
npm run migrate               # ساخت جداول PostgreSQL (شامل auth_refresh_tokens و admin_jobs)
npm start                     # http://0.0.0.0:3000/api
```

تست‌ها (بدون نیاز به رجیستری پارت — پکیج‌های فریم‌ورک mock می‌شوند):

```bash
npm test                      # node --test + scripts/verify-pd2.js (بخش PGlite در صورت نصب)
```
