-- CE Dashboard Server - PostgreSQL Schema
-- بانکهای نسخه ۱: ملت، رسالت، پستبانک (همان رجیستری banks/*.js)
-- اصل PRD: کد ملی، متن آزاد پیام، نام شعبه و گزارش خام ذخیره نمیشود.
-- پیامهای قالبی فقط در message_dict نگهداری میشوند تا خروجی دقیقاً مثل report.html باشد.

CREATE TABLE IF NOT EXISTS day_runs (
  bank TEXT NOT NULL,
  day TEXT NOT NULL, -- شمسی YYYY-MM-DD
  mode TEXT NOT NULL DEFAULT 'nightly', -- nightly/intraday
  status TEXT NOT NULL DEFAULT 'pending', -- pending/running/partial/complete/needs_review/failed
  source_total INTEGER,
  ingested_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  analysis_version TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bank, day)
);

CREATE TABLE IF NOT EXISTS samples_mellat (
  request_id TEXT NOT NULL,
  day TEXT NOT NULL,
  inserted_at TEXT,
  stamp_key TEXT,
  unique_key TEXT,
  is_success BOOLEAN NOT NULL,
  model_name TEXT,
  status_code TEXT,
  error_code TEXT,
  message_key TEXT,
  total_time_s DOUBLE PRECISION,
  pd DOUBLE PRECISION,
  suggested_amount NUMERIC(20,0),
  amount_kind TEXT,
  score_req DOUBLE PRECISION,
  credit_basket NUMERIC(20,0),
  avg36 DOUBLE PRECISION,
  ln_avg_installments DOUBLE PRECISION,
  rotbe TEXT,
  flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  cats JSONB NOT NULL DEFAULT '{}'::jsonb,
  counters JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  paths JSONB NOT NULL DEFAULT '{}'::jsonb,
  services JSONB NOT NULL DEFAULT '{}'::jsonb,
  credit_alerts JSONB,
  display_extras JSONB NOT NULL DEFAULT '{}'::jsonb,
  analysis_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, request_id)
);

-- ستونهای نسخه «تطابق دقیق» (برای دیتابیسهای از قبل ساختهشده)
ALTER TABLE samples_mellat ADD COLUMN IF NOT EXISTS stamp_key TEXT;
ALTER TABLE samples_mellat ADD COLUMN IF NOT EXISTS unique_key TEXT;
ALTER TABLE samples_mellat ADD COLUMN IF NOT EXISTS display_extras JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_samples_mellat_request_id ON samples_mellat(request_id);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_day ON samples_mellat(day);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_day_success ON samples_mellat(day, is_success);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_stamp ON samples_mellat(day, stamp_key, request_id);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_cursor ON samples_mellat(day, COALESCE(stamp_key, ''), request_id);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_model ON samples_mellat(model_name);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_flags ON samples_mellat USING GIN(flags);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_cats ON samples_mellat USING GIN(cats);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_metrics ON samples_mellat USING GIN(metrics);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_total_time ON samples_mellat(total_time_s DESC) WHERE total_time_s IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_samples_mellat_pd ON samples_mellat(pd) WHERE pd IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mellat_rotbe_null ON samples_mellat(day) WHERE (flags->>'rotbeNull') = 'true';

-- دو جدول دیگر همان ساختار و ایندکسها را از جدول ملت میگیرند.
CREATE TABLE IF NOT EXISTS samples_resalat (LIKE samples_mellat INCLUDING ALL);
CREATE TABLE IF NOT EXISTS samples_postbank (LIKE samples_mellat INCLUDING ALL);

ALTER TABLE samples_resalat ADD COLUMN IF NOT EXISTS stamp_key TEXT;
ALTER TABLE samples_resalat ADD COLUMN IF NOT EXISTS unique_key TEXT;
ALTER TABLE samples_resalat ADD COLUMN IF NOT EXISTS display_extras JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE samples_postbank ADD COLUMN IF NOT EXISTS stamp_key TEXT;
ALTER TABLE samples_postbank ADD COLUMN IF NOT EXISTS unique_key TEXT;
ALTER TABLE samples_postbank ADD COLUMN IF NOT EXISTS display_extras JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ارتقای دیتابیسهای قدیمی که کلید اصلی را فقط روی (request_id) ساخته بودند به (day, request_id)
-- تا تکرار یک request_id در روز دیگر آمار روزهای قبلی را جابهجا نکند.
DO $$
DECLARE
  tbl TEXT;
  pk_name TEXT;
  pk_cols TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['samples_mellat', 'samples_resalat', 'samples_postbank'] LOOP
    SELECT c.conname,
           (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum)
      INTO pk_name, pk_cols
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = tbl AND c.contype = 'p';
    IF pk_cols IS DISTINCT FROM 'day,request_id' THEN
      IF pk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, pk_name);
      END IF;
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (day, request_id)', tbl);
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_samples_resalat_request_id ON samples_resalat(request_id);
CREATE INDEX IF NOT EXISTS idx_samples_resalat_day ON samples_resalat(day);
CREATE INDEX IF NOT EXISTS idx_samples_resalat_day_success ON samples_resalat(day, is_success);
CREATE INDEX IF NOT EXISTS idx_samples_resalat_stamp ON samples_resalat(day, stamp_key, request_id);
CREATE INDEX IF NOT EXISTS idx_samples_resalat_cursor ON samples_resalat(day, COALESCE(stamp_key, ''), request_id);
CREATE INDEX IF NOT EXISTS idx_samples_resalat_flags ON samples_resalat USING GIN(flags);
CREATE INDEX IF NOT EXISTS idx_samples_resalat_cats ON samples_resalat USING GIN(cats);
CREATE INDEX IF NOT EXISTS idx_samples_resalat_metrics ON samples_resalat USING GIN(metrics);

CREATE INDEX IF NOT EXISTS idx_samples_postbank_request_id ON samples_postbank(request_id);
CREATE INDEX IF NOT EXISTS idx_samples_postbank_day ON samples_postbank(day);
CREATE INDEX IF NOT EXISTS idx_samples_postbank_day_success ON samples_postbank(day, is_success);
CREATE INDEX IF NOT EXISTS idx_samples_postbank_stamp ON samples_postbank(day, stamp_key, request_id);
CREATE INDEX IF NOT EXISTS idx_samples_postbank_cursor ON samples_postbank(day, COALESCE(stamp_key, ''), request_id);
CREATE INDEX IF NOT EXISTS idx_samples_postbank_flags ON samples_postbank USING GIN(flags);
CREATE INDEX IF NOT EXISTS idx_samples_postbank_cats ON samples_postbank USING GIN(cats);
CREATE INDEX IF NOT EXISTS idx_samples_postbank_metrics ON samples_postbank USING GIN(metrics);

CREATE TABLE IF NOT EXISTS message_dict (
  message_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  topic TEXT NOT NULL
);
ALTER TABLE message_dict ADD COLUMN IF NOT EXISTS message_text TEXT;

INSERT INTO message_dict(message_key, label, topic, message_text) VALUES
  ('MSG_VALIDATION_SUCCESS', 'اعتبارسنجی موفق', 'success', E'درخواست اعتبارسنجی با موفقیت انجام شد.\nValidation was successful.'),
  ('MSG_HISTORY_NOT_ENOUGH', 'سابقه اعتباری کافی نیست', 'success', E'اطلاعات تاریخچه اعتباری شما کافی نیست.\nYour historical data is not enough.'),
  ('MSG_OVERDUE_DEBT', 'بدهی معوق', 'success', E'شما در حال حاضر بدهی معوق دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.\nYou currently have overdue debt.please improve your credit behavior and try again.'),
  ('MSG_BOUNCED_CHECK', 'چک برگشتی', 'success', E'شما همچنان چک برگشتی دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.\nYou still have bounced check. please improve your credit behavior and try again.'),
  ('MSG_DUPLICATE_UNIQUE_KEY', 'شناسه یکتا تکراری', 'fail', E'شناسه یکتا تکراری است!\nduplicate UniqueKey!'),
  ('MSG_NO_MESSAGE', 'پیامی ثبت نشده است', 'other', 'پیامی ثبت نشده است'),
  ('MSG_UNKNOWN', 'سایر پیامها', 'other', 'سایر پیامها')
ON CONFLICT (message_key) DO UPDATE SET label=EXCLUDED.label, topic=EXCLUDED.topic, message_text=EXCLUDED.message_text;

CREATE TABLE IF NOT EXISTS sample_access_logs (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sample_access_logs_request ON sample_access_logs(request_id, accessed_at DESC);
