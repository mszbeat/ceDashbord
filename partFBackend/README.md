# partFBackend — CE Dashboard Backend (Powered by `partFramework`)

نسخهٔ کامل بکاند داشبورد پایش اعتبارسنجی بانکی بر پایهٔ معماری استاندارد `partFramework` (`controller-package`) با `needProtocolRef: false` و تزریق مستقیم پارامترها از `config.js` (`params: [...]`)، آماده برای اعمال گاردهای سمد (Samad) روی هر کنترلر یا مسیر.

---

## تفکیک کنترلرها بر اساس ۳ سطح دسترسی (برای اتصال به سمد)

| سطح دسترسی | نقشهای هدف در سمد | کنترلر در `partFBackend/controllers/` | مسیرها |
|---|---|---|---|
| **۱. کاربر عادی** | عمومی / کاربر عادی | `summaryController` | `GET /api/health`, `GET /api/banks`, `GET /api/specs`, `GET /api/report`, `GET /api/diagnostics`, `GET /api/summary`, `GET /api/list`, `GET /api/runs` |
| **۲. مشاهدهٔ جزئیات گزارش** | `creditEvaluation` و `admin` | `creditEvaluationController` | `GET /api/sample/:requestId` |
| **۳. مدیریت سامانه** | فقط `admin` | `adminController` | `GET /api/admin/overview`, `GET /api/admin/cron`, `PUT /api/admin/cron`, `POST /api/admin/cron/run-now`, `POST /api/admin/runs/check`, `POST /api/admin/runs/start`, `GET /api/admin/jobs`, `GET /api/admin/jobs/:id`, `POST /api/admin/runs`, `POST /api/runs` |

---

## ورودیهای تزریقشدهٔ هندلرها (`needProtocolRef: false`)

در فایلهای `controllers/*/config.js` بهجای ارسال کل `protocolRef` (`needProtocolRef: true`)، در تمام هندلرها `needProtocolRef: false` تنظیم شده و فقط مقادیر مورد نیاز به ترتیب در `params` معرفی شدهاند:
- `'_protocolRef.request.queryString'` برای پارامترهای Query در مسیرهای `GET`
- `'_protocolRef.request.data'` برای بدنهٔ درخواست در مسیرهای `POST` و `PUT`
- `'_protocolRef.request'` و `'_inputData'` برای پارامترهای مسیر (`:requestId` و `:id`) و مشخصات کلاینت
- `'_protocolRef.response'` برای تنظیم کد وضعیت HTTP و هدرها

در زمان اضافه کردن گارد سمد کافی است در `params` هر هندلر در صورت نیاز `'_session'` یا `'_trackingHeaders'` را نیز اضافه کنید.

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
