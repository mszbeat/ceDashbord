'use strict';

/**
 * D8 — سلامت و آمادگی، جدا و بدون احراز هویت.
 *
 *  * `/healthz` — «پروسه زنده است» (liveness). هیچ وابستگی‌ای را چک نمی‌کند تا کندی
 *    دیتابیس باعث ری‌استارت بی‌پایان پاد نشود.
 *  * `/readyz` — «آمادهٔ سرویس‌دهی» (readiness): اتصال دیتابیس، وجود جداول اصلی و
 *    نبود روز ناقصِ قدیمی. اگر هرکدام مشکل داشته باشد 503 برمی‌گردد.
 *
 * خروجی هر دو JSON کوچک است و زمان پاسخ آن‌ها اندازه‌گیری می‌شود (برای مانیتورینگ).
 */
async function healthz() {
  return {
    ok: true,
    status: 'live',
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    version: process.env.CE_APP_VERSION || 'dev',
    time: new Date().toISOString(),
  };
}

async function readyz(db, { schema = 'v1' } = {}) {
  const started = process.hrtime.bigint();
  const checks = {};
  let ok = true;

  try {
    await db.query('SELECT 1');
    checks.database = { ok: true };
  } catch (error) {
    ok = false;
    checks.database = { ok: false, error: error?.code || error?.message };
  }

  if (checks.database.ok) {
    try {
      const tables = schema === 'v2'
        ? ['day_runs', 'samples_mellat', 'sample_detail']
        : ['day_runs', 'samples_mellat', 'message_dict'];
      const res = await db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
        [tables],
      );
      const found = new Set(res.rows.map((row) => row.table_name));
      const missing = tables.filter((table) => !found.has(table));
      checks.tables = { ok: missing.length === 0, missing };
      if (missing.length) ok = false;
    } catch (error) {
      ok = false;
      checks.tables = { ok: false, error: error?.code || error?.message };
    }

    try {
      // روزهایی که مدتی «در جریان» مانده‌اند = هشدار عملیاتی (D8)
      const res = await db.query(
        `SELECT COUNT(*)::int AS n FROM day_runs
          WHERE status IN ('running','partial') AND updated_at < now() - interval '6 hours'`,
      );
      const stale = Number(res.rows[0]?.n ?? 0);
      checks.incompleteDays = { ok: stale === 0, stale };
      if (stale > 0) ok = false;
    } catch (error) {
      // نبود `updated_at` در اسکیمای قدیمی مانع آمادگی نیست، ولی ثبت می‌شود
      checks.incompleteDays = { ok: true, skipped: error?.code || 'unavailable' };
    }
  }

  return {
    ok,
    status: ok ? 'ready' : 'degraded',
    schema,
    checks,
    durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6 * 10) / 10,
    time: new Date().toISOString(),
  };
}

module.exports = { healthz, readyz };
