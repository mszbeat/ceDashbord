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
