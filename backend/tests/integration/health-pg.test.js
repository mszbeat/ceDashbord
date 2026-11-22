'use strict';

/** D8 — `/api/readyz`: آماده در حالت سالم، ۵۰۳ وقتی جدول اصلی نیست یا روز ناقص گیرکرده. */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, createTestDatabase, pgTest } = require('./helpers');
const { readyz, healthz } = require(path.join(ROOT, 'services', 'health'));
const { runMigrations } = require(path.join(ROOT, 'services', 'db', 'migrations'));

pgTest('D8: healthz زنده است و readyz آماده وقتی جداول موجودند', async () => {
  const db = await createTestDatabase('health');
  try {
    await runMigrations(db);
    const live = await healthz();
    assert.equal(live.ok, true);
    assert.equal(live.status, 'live');
    assert.ok(live.uptimeSeconds >= 0);

    const ready = await readyz(db, { schema: 'v2' });
    assert.equal(ready.ok, true, JSON.stringify(ready.checks));
    assert.equal(ready.status, 'ready');
    assert.equal(ready.checks.database.ok, true);
    assert.equal(ready.checks.tables.ok, true);
    assert.equal(ready.checks.incompleteDays.stale, 0);
    assert.ok(ready.durationMs >= 0);
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('D8: readyz با روز گیرکرده ۵۰۳ (degraded) می‌شود', async () => {
  const db = await createTestDatabase('health2');
  try {
    await runMigrations(db);
    await db.query(
      `INSERT INTO day_runs(bank, day, status, mode, updated_at)
       VALUES('tavan_mellat', '2026-10-23', 'running', 'nightly', now() - interval '9 hours')`,
    );
    const ready = await readyz(db, { schema: 'v2' });
    assert.equal(ready.ok, false, 'نباید آماده باشد');
    assert.equal(ready.status, 'degraded');
    assert.equal(ready.checks.incompleteDays.stale, 1);
  } finally {
    await db.close();
  }
}, { timeout: 120000 });
