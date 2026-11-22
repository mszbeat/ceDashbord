'use strict';

/** D6 — نگهداشت: فقط لاگ‌های کهنه پاک می‌شوند، دادهٔ نمونه‌ها دست‌نخورده می‌ماند. */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, createTestDatabase, pgTest } = require('./helpers');
const { runMigrations } = require(path.join(ROOT, 'services', 'db', 'migrations'));
const { runRetention } = require(path.join(ROOT, 'services', 'maintenance', 'retention.service'));

pgTest('D6: نگهداشت لاگ‌های قدیمی را پاک می‌کند و به نمونه‌ها کاری ندارد', async () => {
  const db = await createTestDatabase('retn');
  try {
    await runMigrations(db);
    const day = '2026-10-23';
    // اسکیمای v1 (مهاجرت ۰۰۱) — ردیف نمونه از راه upsert واقعی سرویس نوشته نمی‌شود تا
    // آزمون به استک کامل وابسته نباشد؛ فقط وجود/نبود جدول بررسی می‌شود.
    const sampleTable = (await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name='samples_mellat'",
    )).rows[0].table_name;
    assert.equal(sampleTable, 'samples_mellat');
    void day;
    await db.query(
      `INSERT INTO sample_access_logs(request_id, accessed_at, actor, roles)
       VALUES ('00000000-0000-4000-8000-000000000001', now() - interval '400 days', 'old', '[]'),
              ('00000000-0000-4000-8000-000000000001', now(), 'fresh', '["admin"]')`,
    );
    const out = await runRetention(db);
    assert.ok(out.totalDeleted >= 1, 'لاگ کهنه پاک شد');
    const logs = await db.query('SELECT actor FROM sample_access_logs ORDER BY accessed_at');
    assert.deepEqual(logs.rows.map((row) => row.actor), ['fresh'], 'فقط لاگ تازه مانده');
    const samples = await db.query('SELECT COUNT(*)::int AS n FROM samples_mellat');
    assert.equal(samples.rows[0].n, 0, 'نگهداشت هیچ ردیفی از نمونه‌ها را پاک نکرد (و چیزی هم ننوشت)');
    const rollupTables = await db.query(
      "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name='day_rollup'",
    );
    assert.equal(rollupTables.rows[0].n, 1, 'day_rollup حتی لمس هم نشد');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });
