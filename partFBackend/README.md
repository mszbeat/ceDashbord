# partFBackend — CE Dashboard Backend (Powered by `partFramework`)

نسخهٔ کامل بکاند داشبورد پایش اعتبارسنجی بانکی بر پایهٔ معماری استاندارد `partFramework` (`controller-package`) با `needProtocolRef: false`، تزریق مستقیم پارامترها از `config.js` (`params: [...]`)، دیکشنری استاندارد خطاها در کلید `error` هر کنترلر، مدیریت سشن با `SessionManager`، تخصیص و خواندن نقش با `SamadService` و اصالت‌سنجی با `partAuthenticationInterface`.

---

## کنترلرها و مسیرها

| بخش / سطح دسترسی | کنترلر در `partFBackend/controllers/` | مسیرها |
|---|---|---|
| **اصالت‌سنجی، سشن و نقش سمد** | `auth` (`auth.service.js`, `samad.service.js`, `session-manager.js`) | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/role`, `GET /api/auth/role`, `POST /api/auth/remove` |
| **۱. کاربر عادی** | `summaryController` | `GET /api/health`, `GET /api/banks`, `GET /api/specs`, `GET /api/report`, `GET /api/diagnostics`, `GET /api/summary`, `GET /api/list`, `GET /api/runs` |
| **۲. مشاهدهٔ جزئیات گزارش (`creditEvaluation` و `admin`)** | `creditEvaluationController` | `GET /api/sample/:requestId` |
| **۳. مدیریت سامانه (فقط `admin`)** | `adminController` | `GET /api/admin/overview`, `GET /api/admin/cron`, `PUT /api/admin/cron`, `POST /api/admin/cron/run-now`, `POST /api/admin/runs/check`, `POST /api/admin/runs/start`, `GET /api/admin/jobs`, `GET /api/admin/jobs/:id`, `POST /api/admin/runs`, `POST /api/runs` |

---

## ساختار یکپارچهٔ خطاها در کانفیگ کنترلرها (`config.error`)

در فایل `controllers/*/config.js` (و بازتاب آن در `configs/*.config.js`) خطاهای مختص همان کنترلر داخل کلید `error` با قالب استاندارد پارت (`{ meta: errorInfo(...), data: { message: { fa, en } }, statusCode }`) تعریف شدهاند تا کد سرویسها بدون آبجکتهای خطای توکار و تمیز باقی بماند.

---

## نصب و اجرا

```bash
cd partFBackend
npm install
cp .env.example .env
npm run migrate
npm start
```

اجرای تستهای واحد و یکپارچه:

```bash
cd partFBackend
npm test
```
