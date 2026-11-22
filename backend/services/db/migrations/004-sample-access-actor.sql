-- D2 — ستون‌های مسئولیت‌پذیری در لاگ دسترسی به گزارش خام.
--
-- چرا مهاجرت جدا لازم است: `002-v2-schema.sql` از `CREATE TABLE IF NOT EXISTS` استفاده
-- می‌کند و روی دیتابیسی که جدول را از نسخهٔ ۱ دارد، **هیچ کاری نمی‌کند** — یعنی `actor` و
-- `roles` هرگز ساخته نمی‌شدند و درج لاگ دسترسی بی‌صدا شکست می‌خورد.
ALTER TABLE sample_access_logs ADD COLUMN IF NOT EXISTS actor text;
ALTER TABLE sample_access_logs ADD COLUMN IF NOT EXISTS roles jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_sample_access_logs_actor ON sample_access_logs(actor, accessed_at DESC);
