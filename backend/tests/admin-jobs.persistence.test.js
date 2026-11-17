'use strict';

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { AdminService } = require(path.join(ROOT, 'services', 'admin', 'admin.service'));

class FakeJobsDb {
  constructor() {
    this.rows = new Map();
    this.queries = [];
  }

  async query(text, params = []) {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    this.queries.push({ sql, params });

    if (/^CREATE TABLE IF NOT EXISTS admin_jobs/i.test(sql) || /^CREATE INDEX IF NOT EXISTS idx_admin_jobs_created_at/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    if (/^INSERT INTO admin_jobs/i.test(sql)) {
      const [id, source, status, createdAt, finishedAt, payload] = params;
      this.rows.set(id, {
        id,
        source,
        status,
        created_at: createdAt,
        finished_at: finishedAt,
        payload,
        updated_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (/^SELECT id, payload, updated_at FROM admin_jobs WHERE status = 'running'/i.test(sql)) {
      return {
        rows: [...this.rows.values()]
          .filter((r) => r.status === 'running')
          .map((r) => ({ ...r })),
        rowCount: 0,
      };
    }

    if (/^SELECT \* FROM admin_jobs WHERE id = \$1/i.test(sql)) {
      const row = this.rows.get(params[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    if (/^SELECT \* FROM admin_jobs ORDER BY created_at DESC LIMIT \$1/i.test(sql)) {
      const limit = Number(params[0] || 15);
      const rows = [...this.rows.values()]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }

    if (/^SELECT 1 FROM admin_jobs WHERE status = 'running'/i.test(sql)) {
      const active = [...this.rows.values()].filter(
        (r) => r.status === 'running' && (r.source === 'cron' || r.source === 'cron_manual'),
      );
      return { rows: active.map(() => ({ '?column?': 1 })), rowCount: active.length };
    }

    if (/^DELETE FROM admin_jobs/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    if (/FROM day_runs/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }
}

const ingestionStub = {
  async runDay() {
    return {
      source_total: 2,
      processed: 2,
      success: 2,
      fail: 0,
      skipped: 0,
      deleted: 0,
      rebuild: false,
    };
  },
  async runFilteredLookup() {
    return { day: '1405-08-20' };
  },
};

test('تاریخچهٔ job های ادمین در PostgreSQL ذخیره و پس از restart بازیابی میشود', async () => {
  const db = new FakeJobsDb();
  const first = new AdminService(db, ingestionStub);

  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const job = await first.enqueueJob({
    source: 'manual',
    actor: 'test-admin',
    dateScope: 'single',
    mode: 'nightly',
    conflictStrategy: 'upsert',
    banks: ['tavan_mellat'],
    days: ['1405-08-20'],
    filters: { status: 'success', nationalCode: '0099887766' },
    onFinish: async () => resolveDone(),
  });

  await done;
  assert.equal(job.status, 'completed');

  const stored = db.rows.get(job.id);
  assert.ok(stored, 'job must be written to admin_jobs');
  assert.equal(stored.status, 'completed');
  assert.doesNotMatch(stored.payload, /0099887766/, 'nationalCode must not be persisted');

  // شبیهسازی restart: سرویس جدید، همان دیتابیس، Map حافظه خالی
  const restarted = new AdminService(db, ingestionStub);
  const jobs = await restarted.listJobs(10);
  assert.equal(jobs.some((j) => j.id === job.id), true, 'history must survive restart');
  const restored = await restarted.getJob(job.id);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.steps[0].status, 'done');
});
