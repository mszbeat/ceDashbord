-- 005 — ارتقای day_runs از شکل v1 به v2 (B1/B2، فاز ۳ و ۴)
--
-- چرا لازم است: `002-v2-schema.sql` جدول را با `CREATE TABLE IF NOT EXISTS` می‌سازد.
-- روی نصب تازه، تعریف v2 ساخته می‌شود؛ ولی روی دیتابیسی که از قبل `day_runs` نسخهٔ v1
-- دارد، `IF NOT EXISTS` هیچ کاری نمی‌کند و جدولِ v1 باقی می‌مانَد:
--   * `day` از نوع text است (نه date) ⇒ همهٔ کوئری‌های v2 که روی بازهٔ date فیلتر می‌کنند
--     یا با پارتیشن‌ها join می‌شوند، مقایسهٔ اشتباه/خطای نوع می‌دهند،
--   * `distinct_stored` وجود ندارد ⇒ `dialect-v2.runs()` با
--     «column "distinct_stored" does not exist» می‌شکند (همان خطای مشاهده‌شده در
--     اجرای واقعی با CE_DB_SCHEMA=v2).
--
-- این مهاجرت افزایشی (additive) است: ستون‌ها اضافه می‌شوند و `day` به date تبدیل می‌شود.
-- تبدیل day با USING انجام می‌شود؛ اگر روزی دادهٔ شمسیِ نامعتبر در جدول باشد،
-- کل مهاجرت fail می‌شود (به‌جای دادهٔ خرابِ خاموش) — که در RUNBOOK هم توضیح داده شده.

ALTER TABLE day_runs ADD COLUMN IF NOT EXISTS distinct_stored integer;
ALTER TABLE day_runs ADD COLUMN IF NOT EXISTS skipped_other_method integer NOT NULL DEFAULT 0;
ALTER TABLE day_runs ADD COLUMN IF NOT EXISTS error_count integer NOT NULL DEFAULT 0;

-- v1 ستون skipped_count دارد؛ در v2 نام آن skipped_other_method است.
-- برای سازگاری خواندنِ کدِ قدیمی، skipped_count حفظ می‌شود (حذف ستون = عملیات مخرب).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'day_runs'
      AND column_name = 'day' AND data_type = 'text'
  ) THEN
    -- مقادیر باید YYYY-MM-DD شمسی باشند؛ قالبِ دیگر ⇒ خطای صریح
    IF EXISTS (
      SELECT 1 FROM day_runs WHERE day !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    ) THEN
      RAISE EXCEPTION 'day_runs.day شامل مقدار غیر YYYY-MM-DD است؛ پیش از مهاجرت پاک‌سازی لازم است';
    END IF;
    ALTER TABLE day_runs ALTER COLUMN day TYPE date USING day::date;
  END IF;
END $$;
