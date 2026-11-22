# امنیت و تنظیمات محیطی

## کلید خصوصی TLS

فایلهای `backend/certificate/key.pem` و `key-cert.pem` که قبلاً کامیت شده بودند،
از درخت ریپو حذف و مسیر `backend/certificate/` به `.gitignore` اضافه شده است.
**چون این فایلها در تاریخچهٔ Git وجود داشتهاند، حذف از HEAD بهتنهایی کافی نیست:**

1. کلید خصوصی و گواهی مربوطه را در سرویس/deploy target باطل و Rotate کنید.
2. در صورت نیاز، تاریخچهٔ ریپو را با `git filter-repo` / BFG پاکسازی و force-push کنید
   (قبل از آن با تیم هماهنگ شود).
3. مسیر گواهی و کلید جدید را فقط از طریق متغیر محیطی / secret manager تزریق کنید؛
   نمونه در `backend/.env.example` (`TLS_CERT_PATH`, `TLS_KEY_PATH`).

## شناسههای پیشفرض

پیشفرضهای حاوی نام/رمز شخصی سرویس سمد حذف شدند. `SAMAD_USER`, `SAMAD_PASS`,
`SAMAD_ORG` و `PART_AUTH_*` باید در `backend/.env` تنظیم شوند؛ `npm run check:env`
پیش از اجرا آنها را راستیآزمایی میکند. در صورت نبود مقادیر، بکاند با خطای واضح
متوقف میشود و هیچ حساب پیشفرضی استفاده نمیشود.

## CORS

`Access-Control-Allow-Origin: *` با کوکیهای HttpOnly ناسازگار است. اکنون origin
مشخص از `CORS_ALLOWED_ORIGIN` خوانده میشود (پیشفرض `http://localhost:3001`) و
`Access-Control-Allow-Credentials: true` + `Vary: Origin` تنظیم شده است. مرورگر در
حالت عادی از پروکسی همOriginـهٔ Next.js (`/api/...`) استفاده میکند.

## رفرش توکن

لایهٔ BFF/میانware و کلاینتها دیگر به `canRefresh:false` پاسخ `/api/auth/me`
پس از انقضای اکسس توکن اعتماد نمیکنند؛ وقتی کوکی `ce_refresh` وجود دارد،
`POST /api/auth/refresh` امتحان میشود. نتیجهٔ نهایی فقط از endpoint تمدید گرفته
میشود. تست منبع: `frontend/tests/refresh-policy.test.mjs`.

## Deploy Key

کلید خصوصی deploy خارج از ریپو نگهداری میشود. بعد از انتقال ریپو یا مشاهدهٔ
هر گونه نشت، کلید را Rotate کنید.

## مرز دسترسی پنل ادمین (اصلاح ۲۰۲۶-۱۱-۲۲)

`.checkAccess(true)` در `routes.js` فقط «وجود سشن معتبر» را تضمین می‌کند، **نه نقش**.
همهٔ هندلرهای `adminController` پیش‌تر `requireAuthenticatedSession` صدا می‌زدند؛ در نتیجه
هر کاربر **ثبت‌نام‌شدهٔ عادی** (نقش `visitor`) می‌توانست:

- زمان‌بند کران شبانه را بخواند و **تغییر دهد** (`GET/PUT /api/admin/cron`)
- دریافت گزارش را **اجرا کند** (`POST /api/admin/runs`, `POST /api/runs`, `POST /api/admin/cron/run-now`)
- تاریخچه و جزئیات jobها را ببیند (`GET /api/admin/jobs`)

اکنون هر ده هندلر `requireAdminSession` هستند (نقش‌های مجاز از `CE_ADMIN_ROLES`، پیش‌فرض
`admin,ce-admin`) و در غیر آن **۴۰۳ با کد `adminRequired`** برمی‌گردد.
تست نگهبان: `backend/tests/controllers.behavior.test.js` → «SECURITY: هیچ هندلر پنل ادمین…».

> ⚠️ اگر کاربری در سامانه نقش `admin` ندارد اما باید به پنل دسترسی داشته باشد، نقشش را در
> سمد تنظیم کنید؛ دسترسی از طریق «فقط لاگین بودن» باز نمی‌شود.
