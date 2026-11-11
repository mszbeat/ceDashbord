-- CE Dashboard Server - PostgreSQL Schema (M2/M3)
-- بانک فعال نسخه ۱: ملت (samples_mellat)
-- اصل PRD: کد ملی، متن آزاد پیام، نام شعبه و گزارش خام ذخیره نمی‌شود.

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
  request_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  inserted_at TEXT,
  is_success BOOLEAN NOT NULL,
  model_name TEXT,
  status_code TEXT,
  error_code TEXT,
  message_key TEXT,
  total_time_s DOUBLE PRECISION,
  pd DOUBLE PRECISION, -- مقدار خام، بدون گرد کردن (برای تفکیک دقیقاً ۰٫۵)
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
  analysis_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_samples_mellat_day ON samples_mellat(day);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_day_success ON samples_mellat(day, is_success);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_model ON samples_mellat(model_name);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_flags ON samples_mellat USING GIN(flags);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_cats ON samples_mellat USING GIN(cats);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_metrics ON samples_mellat USING GIN(metrics);
CREATE INDEX IF NOT EXISTS idx_samples_mellat_total_time ON samples_mellat(total_time_s DESC) WHERE total_time_s IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_samples_mellat_pd ON samples_mellat(pd) WHERE pd IS NOT NULL;
-- نمونه ایندکس partial برای پرتکرارترین فهرست؛ بعد از اندازهگیری روی سرور بقیه اضافه میشود
CREATE INDEX IF NOT EXISTS idx_mellat_rotbe_null ON samples_mellat(day) WHERE (flags->>'rotbeNull') = 'true';

CREATE TABLE IF NOT EXISTS message_dict (
  message_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  topic TEXT NOT NULL
);

INSERT INTO message_dict(message_key, label, topic) VALUES
  ('MSG_VALIDATION_SUCCESS', 'اعتبارسنجی موفق', 'success'),
  ('MSG_HISTORY_NOT_ENOUGH', 'سابقه اعتباری کافی نیست', 'success'),
  ('MSG_OVERDUE_DEBT', 'بدهی معوق', 'success'),
  ('MSG_BOUNCED_CHECK', 'چک برگشتی', 'success'),
  ('MSG_UNKNOWN', 'پیام طبقهبندی نشده', 'other')
ON CONFLICT (message_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS sample_access_logs (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sample_access_logs_request ON sample_access_logs(request_id, accessed_at DESC);
