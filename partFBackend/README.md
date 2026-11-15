# partFBackend — CE Dashboard Backend (Powered by `partFramework`)

نسخهٔ کامل بکاند داشبورد پایش اعتبارسنجی بانکی بر پایهٔ معماری استاندارد `partFramework` (`controller-package`) با `needProtocolRef: false`، تزریق مستقیم پارامترها از `config.js` (`params: [...]`)، سرویس اصالت‌سنجی `partAuthenticationInterface` (`controllers/auth`) و کنترلرهای تفکیک‌شده برای اعمال گاردهای سمد (Samad).

---

## کنترلرها و سطوح دسترسی

| بخش / سطح دسترسی | کنترلر در `partFBackend/controllers/` | مسیرها |
|---|---|---|
| **اصالت‌سنجی (`partAuthenticationInterface`)** | `auth` (`auth.service.js`) | `POST /api/auth/register` (`addAuthEntry`), `POST /api/auth/login` (`authenticate`), `POST /api/auth/remove` (`removeUser`) |
| **۱. کاربر عادی** | `summaryController` | `GET /api/health`, `GET /api/banks`, `GET /api/specs`, `GET /api/report`, `GET /api/diagnostics`, `GET /api/summary`, `GET /api/list`, `GET /api/runs` |
| **۲. مشاهدهٔ جزئیات گزارش (`creditEvaluation` و `admin`)** | `creditEvaluationController` | `GET /api/sample/:requestId` |
| **۳. مدیریت سامانه (فقط `admin`)** | `adminController` | `GET /api/admin/overview`, `GET /api/admin/cron`, `PUT /api/admin/cron`, `POST /api/admin/cron/run-now`, `POST /api/admin/runs/check`, `POST /api/admin/runs/start`, `GET /api/admin/jobs`, `GET /api/admin/jobs/:id`, `POST /api/admin/runs`, `POST /api/runs` |

---

## ورودیهای تزریقشدهٔ هندلرها (`needProtocolRef: false`)

در فایلهای `controllers/*/config.js` در تمام هندلرها `needProtocolRef: false` تنظیم شده و فقط مقادیر مورد نیاز به ترتیب در `params` معرفی شدهاند:
- `'_protocolRef.request.postData'` و `'_trackingHeaders'` در مسیرهای `auth`
- `'_protocolRef.request.queryString'` برای پارامترهای Query در مسیرهای `GET`
- `'_protocolRef.request'` و `'_inputData'` برای بدنهٔ `POST`/`PUT` و پارامترهای مسیر (`:requestId` و `:id`)
- `'_protocolRef.response'` برای تنظیم کد وضعیت HTTP و هدرها

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
