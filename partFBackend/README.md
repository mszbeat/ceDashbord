# partFBackend — CE Dashboard Backend (Powered by `partFramework`)

نسخهٔ کامل بکاند داشبورد پایش اعتبارسنجی بانکی بر پایهٔ معماری استاندارد `partFramework` (`controller-package`) بههمراه **جداسازی کامل مسیرها و کنترلرها بر اساس ۳ سطح دسترسی (`user` / `creditEvaluation` / `admin`)**.

---

## تفکیک مسیرها و کنترلرها بر اساس سطح دسترسی

| سطح دسترسی | نقشهای مجاز | کنترلر در `partFBackend/controllers/` | فایل کانفیگ دسترسی | امکانات و مسیرها |
|---|---|---|---|---|
| **۱. کاربر عادی** | همگانی (`user` / `visitor` / `creditEvaluation` / `admin`) | `summaryController` | `configs/summaryController.config.js` | مشاهدهٔ صفحهٔ اول داشبورد و تحلیلهای کلی (`GET /api/health`, `/api/auth/me`, `/api/banks`, `/api/specs`, `/api/report`, `/api/diagnostics`, `/api/summary`, `/api/list`, `/api/runs`) — **بدون دسترسی به جزئیات تکی گزارش یا پنل ادمین** |
| **۲. کارشناس اعتبارسنجی** | فقط `creditEvaluation` و `admin` | `creditEvaluationController` | `configs/creditEvaluationController.config.js` | دریافت و مشاهدهٔ اطلاعات کامل یک گزارش (`GET /api/sample/:requestId`) — **کاربر عادی با خطای `403 Forbidden` مسدود میشود و این نقش اجازهٔ ورود به پنل ادمین را ندارد** |
| **۳. مدیر سیستم** | فقط `admin` | `adminController` | `configs/adminController.config.js` | دسترسی کامل به همهٔ بخشها شامل پنل مدیریت، زمانبند کران شبانه و اجرای دریافت گزارشها (`GET/PUT/POST /api/admin/*` و `POST /api/runs`) — **کاربران عادی و `creditEvaluation` با خطای `403 Forbidden` مسدود میشوند** |

---

## نحوهٔ تشخیص نقش کاربر (`services/auth/role-guard.js`)

گارد نقشها (`requireRoles` در `services/auth/role-guard.js`) به ترتیب زیر نقشهای کاربر را استخراج میکند تا اتصال `partAuthenticationInterface` / `partSamadInterface` یا `partSessionManager` بدون تغییر کنترلرها انجام شود:

1. **قلاب سفارشی در `Program.js` (`setAuthResolver`)**: میتوانید مستقیماً خروجی سرویس احراز هویت پارت را به `{ username, roles }` نگاشت کنید.
2. **اشیاء فریمورک روی `protocolRef`**: فیلدهای `protocolRef.user`، `protocolRef.auth`، `protocolRef.request.user` یا `protocolRef.scope.user`.
3. **نشست `partSessionManager` (`protocolRef.session`)**: پشتیبانی خودکار از فیلد `session.roles` و متد `session.get(['roles', 'samadUsername'], callback)`.
4. **توکن `Bearer JWT`** (در صورت تنظیم `AUTH_JWT_SECRET` در `.env`).
5. **هدرهای گیتوی / تست محلی** (`x-user-role` / `x-user-roles` در صورت `AUTH_TRUST_ROLE_HEADERS=true`، یا متغیر `AUTH_DEV_DEFAULT_ROLE` در `.env`).

---

## نصب و اجرا

```bash
cd partFBackend
npm install
cp .env.example .env
npm run migrate
npm start
```

اجرای تستهای واحد، گاردهای سطح دسترسی (هر ۳ نقش `user`، `creditEvaluation` و `admin`) و تست یکپارچهٔ دیتابیس:

```bash
cd partFBackend
npm test
```
