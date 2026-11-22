'use strict';

/** D3 — مهاجرت نسخه‌دار روی PostgreSQL واقعی: اجرای اول اعمال می‌کند، دومی هیچ‌چیز. */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, createTestDatabase, pgTest } = require('./helpers');
const { runMigrations, migrationStatus } = require(path.join(ROOT, 'services', 'db', 'migrations'));

pgTest('D3: اجرای مهاجرت‌ها یک‌بار اعمال و بار دوم کاملاً رد می‌شود', async () => {
  const db = await createTestDatabase('mig');
  try {
    const first = await runMigrations(db);
    assert.ok(first.applied.length >= 3, `اعمال‌شده‌ها: ${first.applied.join(',')}`);
    assert.equal(first.skipped.length, 0);

    const second = await runMigrations(db);
    assert.equal(second.applied.length, 0, 'اجرای دوم هیچ مهاجرتی اعمال نمی‌کند');
    assert.equal(second.skipped.length, first.applied.length, 'همه از قبل اعمال شده‌اند');

    const status = await migrationStatus(db);
    assert.ok(status.every((row) => row.applied), 'همه اعمال‌شده');
    assert.ok(status.every((row) => row.drift === false), 'هیچ انحرافی در checksum نیست');

    // ساختار ساخته شده است
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = tables.rows.map((row) => row.table_name);
    for (const expected of ['day_runs', 'samples_mellat', 'sample_detail', 'day_rollup', 'schema_migrations']) {
      assert.ok(names.includes(expected), `جدول ${expected} ساخته شد`);
    }
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

/**
 * 005 — ارتقای `day_runs` از شکل v1 به v2.
 *
 * باگ واقعی که در حین کار پیدا شد: روی دیتابیسی که `day_runs` نسخهٔ v1 دارد،
 * `CREATE TABLE IF NOT EXISTS` در `002` هیچ کاری نمی‌کند و ستون‌های v2 اضافه نمی‌شوند.
 * نتیجه: `CE_DB_SCHEMA=v2` با «column "distinct_stored" does not exist» می‌شکست و
 * `day` هم text می‌ماند (مقایسهٔ date در کوئری‌های v2 نامعتبر).
 *
 * این تست همان مسیر واقعی را بازسازی می‌کند: اول فقط مبنای v1، بعد کل مهاجرت‌ها.
 */
pgTest('005: ارتقای v1→v2 ستون date و distinct_stored را می‌آورد', async () => {
  const { createTestDatabase: createDb } = require('./helpers');
  const fs = require('node:fs');
  const db = await createDb('mig005');
  try {
    // فقط مبنای v1 (همان کاری که نصب قدیمی دارد)
    const baseline = await db.query('SELECT 1');
    assert.ok(baseline);
    const v1Sql = fs.readFileSync(path.join(ROOT, 'services', 'db', 'migrations', '001-v1-baseline.sql'), 'utf8');
    await db.query(v1Sql);

    const before = await db.query(
      "SELECT data_type FROM information_schema.columns WHERE table_name='day_runs' AND column_name='day'",
    );
    assert.equal(before.rows[0].data_type, 'text', 'پیش‌شرط: جدول با شکل v1 (text)');

    await runMigrations(db);

    const after = await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='day_runs'",
    );
    const byName = Object.fromEntries(after.rows.map((r) => [r.column_name, r.data_type]));
    assert.equal(byName.day, 'date', 'day به date تبدیل شد');
    assert.ok('distinct_stored' in byName, 'distinct_stored اضافه شد');
    assert.ok('skipped_other_method' in byName, 'skipped_other_method اضافه شد');

    // کوئری واقعی v2 که قبلاً می‌شکست
    const runs = await db.query(
      "SELECT bank, day FROM day_runs WHERE day BETWEEN $1::date AND $2::date",
      ['1405-08-01', '1405-08-23'],
    );
    assert.ok(Array.isArray(runs.rows), 'کوئری بازهٔ date بدون خطا اجرا شد');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });
