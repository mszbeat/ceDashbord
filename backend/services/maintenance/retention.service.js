'use strict';

/**
 * D6/D8 — نگهداشت داده: پاک‌سازی دوره‌ای لاگ‌های کهنه.
 *
 * چه چیزی پاک می‌شود (فقط جداول لاگ/دسترسی — **هرگز** `samples_*` یا `day_rollup`):
 *  * `sample_access_logs` قدیمی‌تر از `CE_RETENTION_ACCESS_DAYS` (پیش‌فرض ۱۸۰)
 *  * `backend_action_logs` قدیمی‌تر از `CE_RETENTION_ACTION_DAYS` (پیش‌فرض ۹۰)
 *
 * اجرا: `node services/maintenance/retention.service.js` یا از cron.
 * هر دسته حداکثر `CE_RETENTION_BATCH` ردیف (پیش‌فرض ۱۰۰۰۰) تا قفل طولانی/bloat ندهد.
 */
const BATCH = Math.max(100, Number(process.env.CE_RETENTION_BATCH || 10000));

async function pruneTable(db, table, column, days) {
  const total = { table, column, days, deleted: 0, batches: 0 };
  for (;;) {
    const res = await db.query(
      `WITH doomed AS (
         SELECT ctid FROM ${table}
          WHERE ${column} < now() - ($1 || ' days')::interval
          LIMIT ${BATCH}
       )
       DELETE FROM ${table} t USING doomed d WHERE t.ctid = d.ctid`,
      [String(days)],
    );
    const removed = Number(res.rowCount || 0);
    total.deleted += removed;
    total.batches += 1;
    if (removed === 0 || total.batches > 500) break;
  }
  return total;
}

async function runRetention(db) {
  const accessDays = Number(process.env.CE_RETENTION_ACCESS_DAYS || 180);
  const actionDays = Number(process.env.CE_RETENTION_ACTION_DAYS || 90);
  const results = [];
  const tables = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])",
    [['sample_access_logs', 'backend_action_logs']],
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  if (present.has('sample_access_logs')) {
    results.push(await pruneTable(db, 'sample_access_logs', 'accessed_at', accessDays));
  }
  if (present.has('backend_action_logs')) {
    const cols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='backend_action_logs'",
    );
    const names = new Set(cols.rows.map((row) => row.column_name));
    const stamp = ['created_at', 'occurred_at', 'logged_at'].find((name) => names.has(name));
    if (stamp) results.push(await pruneTable(db, 'backend_action_logs', stamp, actionDays));
  }
  return {
    ranAt: new Date().toISOString(),
    batch: BATCH,
    results,
    totalDeleted: results.reduce((sum, row) => sum + row.deleted, 0),
  };
}

module.exports = { runRetention, pruneTable };

if (require.main === module) {
  (async () => {
    const { DatabaseService } = require('../db/database.service');
    const db = new DatabaseService(undefined, { role: 'write' });
    try {
      console.log(JSON.stringify(await runRetention(db), null, 2));
    } catch (error) {
      console.error('❌', error.message);
      process.exitCode = 1;
    } finally {
      await db.close();
    }
  })();
}
