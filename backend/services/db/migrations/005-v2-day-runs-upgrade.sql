-- 005 — آماده‌سازی افزایشی day_runs برای v2 (بدون دست‌زدن به داده)
--
-- ⚠️ اصلاحیه: نسخهٔ اول این فایل `day` را با `USING day::date` به date تبدیل می‌کرد.
-- آن کار روی دادهٔ واقعی **خرابکاری خاموش** بود: `day` در v1 متنِ **شمسی** است
-- ('1405-08-01')، و Postgres آن را به‌عنوان تاریخ میلادی می‌پذیرد (۱۴۰۵ میلادی = 784 شمسی).
-- نتیجه: مقدار در دیتابیس ظاهراً سالم می‌ماند ولی API آن را «784-05-10» می‌خواند.
-- آزمایش واقعی: بعد از آن مهاجرت، `toJalaliDay('1405-08-01')` مقدار «784-05-10» داد.
--
-- تصمیم درست:
--   * این مهاجرت فقط **ستون‌های گم‌شده را اضافه می‌کند** (افزایشی و بی‌خطر برای v1).
--   * تبدیل نوع و تبدیل دادهٔ شمسی→میلادی کارِ `npm run migrate:v2` است که ردیف‌ها را با
--     مبدل JS تست‌شده (`toDateIso`) منتقل می‌کند و جدول قدیمی را `*_v1_backup` می‌نامَد.
--   * اگر کسی با `CE_DB_SCHEMA=v2` روی دیتابیس ارتقایافته‌نشده بوت کند، سرویس با
--     `V2_SCHEMA_NOT_READY` و پیام راهنما متوقف می‌شود (نه با دادهٔ اشتباه).

ALTER TABLE day_runs ADD COLUMN IF NOT EXISTS distinct_stored integer;
ALTER TABLE day_runs ADD COLUMN IF NOT EXISTS skipped_other_method integer NOT NULL DEFAULT 0;
ALTER TABLE day_runs ADD COLUMN IF NOT EXISTS error_count integer NOT NULL DEFAULT 0;

-- v1 ستون skipped_count دارد و v2 نام آن skipped_other_method است؛ ستون قدیمی حذف نمی‌شود
-- (حذف ستون = عملیات مخرب). مقدارها به‌صورت یک‌طرفه آینه می‌شوند تا هر دو مسیر درست بخوانند.
UPDATE day_runs SET skipped_other_method = skipped_count
WHERE skipped_other_method = 0 AND skipped_count <> 0;
