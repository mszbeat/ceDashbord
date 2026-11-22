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
 * 005 — `day_runs` در v1 متنِ **شمسی** است و نباید با `::date` به date تبدیل شود.
 *
 * باگی که با آزمایش واقعی پیدا شد: `USING day::date` مقدار «1405-08-01» را به‌عنوان
 * تاریخ **میلادی** ۱۴۰۵ می‌پذیرد (۷۸۴ شمسی) و دادهٔ روز بی‌صدا خراب می‌شود.
 * این تست همان فاجعه را قفل می‌کند: مهاجرت ۰۰۵ باید فقط ستون اضافه کند.
 */
pgTest('005: مهاجرت day را text نگه می‌دارد و ستون‌های v2 را اضافه می‌کند', async () => {
  const { createTestDatabase: createDb } = require('./helpers');
  const fs = require('node:fs');
  const db = await createDb('mig005');
  try {
    const v1Sql = fs.readFileSync(path.join(ROOT, 'services', 'db', 'migrations', '001-v1-baseline.sql'), 'utf8');
    await db.query(v1Sql);
    // دادهٔ واقعی: روز شمسی + شمارش ردشده
    await db.query(
      `INSERT INTO day_runs(bank, day, status, skipped_count) VALUES ('tavan_mellat','1405-08-01','complete',3)`,
    );

    await runMigrations(db);

    const after = await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='day_runs'",
    );
    const byName = Object.fromEntries(after.rows.map((r) => [r.column_name, r.data_type]));
    assert.equal(byName.day, 'text', 'day نباید به date تبدیل شود (دادهٔ شمسی است)');
    assert.ok('distinct_stored' in byName, 'distinct_stored اضافه شد');
    assert.ok('skipped_other_method' in byName, 'skipped_other_method اضافه شد');

    const row = await db.query('SELECT day, skipped_other_method FROM day_runs');
    assert.equal(row.rows[0].day, '1405-08-01', 'مقدار روز شمسی دست‌نخورده ماند');
    assert.equal(row.rows[0].skipped_other_method, 3, 'skipped_count به skipped_other_method آینه شد');

    // و همان نگهبان بوت: با day غیر date، v2 باید صریح رد شود
    const { toDateIso } = require(path.join(ROOT, 'services', 'db', 'row-mapper-v2'));
    assert.equal(toDateIso(row.rows[0].day), '2026-10-23', 'مبدل درست، شمسی را میلادی می‌کند');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });
