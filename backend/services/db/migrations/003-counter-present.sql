-- counter_present: کدام شمارنده‌ها در ردیف حاضر بودند (حتی با مقدار ۰).
-- مسیر قدیمی (`bump`) کلید شمارنده را با مقدار ۰ هم می‌ساخت؛ برای برابری خروجی، حضور
-- باید ذخیره شود (فاز ۳). مقدار پیش‌فرض ۰ برای ردیف‌های قبلی است و در اولین rebuild/ingest
-- پر می‌شود.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('samples_mellat','samples_resalat','samples_postbank')
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS counter_present bigint NOT NULL DEFAULT 0', t);
  END LOOP;
END $$;
