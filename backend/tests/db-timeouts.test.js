'use strict';

/**
 * «صفحه لود نمی‌شود» — ریشه: انتظار بی‌نهایت.
 *
 * `pg` برای گرفتن اتصال آزاد از استخر هیچ مهلتی ندارد. اگر همهٔ اتصال‌ها مشغول باشند،
 * `pool.query` هرگز settle نمی‌شود: هیچ خطایی، هیچ لاگی — فقط درخواست معلق.
 * نتیجه در UI: گزارش با ۵۰۲ «سرور پاسخ نداد» و پنل ادمین با اسپینر همیشگی.
 *
 * این تست همان شرایط را با یک Pool جعلی (بدون اتصال واقعی) بازسازی می‌کند.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Pool جعلی که هیچ‌وقت پاسخ نمی‌دهد (شبیه استخر تمام‌مشغول) */
class HangingPool {
  constructor() {
    this.options = { max: 1 };
    this.waitingCount = 1;
    this.totalCount = 1;
    this.idleCount = 0;
    this.on = () => {};
  }

  query() {
    return new Promise(() => {}); // هرگز settle نمی‌شود
  }

  connect() {
    return new Promise(() => {});
  }

  end() {
    return Promise.resolve();
  }
}

test('query() روی استخر تمام‌مشغول به‌جای انتظار بی‌نهایت، خطای صریح می‌دهد', async () => {
  const { DatabaseService } = require(path.join(ROOT, 'services', 'db', 'database.service.js'));
  const db = new DatabaseService(undefined, { role: 'read' });
  // جایگزینی استخر واقعی با نمونهٔ معلق
  db.pool = new HangingPool();

  const started = Date.now();
  process.env.CE_DB_POOL_ACQUIRE_TIMEOUT_MS = '150';
  try {
    await assert.rejects(
      () => db.query('SELECT 1'),
      (error) => {
        assert.equal(error.code, 'DB_POOL_ACQUIRE_TIMEOUT');
        assert.equal(error.statusCode, 503);
        assert.match(error.message, /اتصال آزادی از استخر/);
        assert.match(error.message, /CE_DB_POOL_MAX_READ/); // کارِ بعدی را می‌گوید
        return true;
      },
    );
  } finally {
    delete process.env.CE_DB_POOL_ACQUIRE_TIMEOUT_MS;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `باید سریع شکست بخورد، نه بی‌نهایت (${elapsed}ms)`);
});

test('getClient() هم مهلت دارد (مسیر ingest که اتصال را قرض می‌گیرد)', async () => {
  const { DatabaseService } = require(path.join(ROOT, 'services', 'db', 'database.service.js'));
  const db = new DatabaseService(undefined, { role: 'write' });
  db.pool = new HangingPool();
  process.env.CE_DB_POOL_ACQUIRE_TIMEOUT_MS = '120';
  try {
    await assert.rejects(() => db.getClient(), (e) => e.code === 'DB_POOL_ACQUIRE_TIMEOUT');
  } finally {
    delete process.env.CE_DB_POOL_ACQUIRE_TIMEOUT_MS;
  }
});

test('هنگام آزاد بودن اتصال، هیچ تأخیر اضافه‌ای تحمیل نمی‌شود', async () => {
  const { DatabaseService } = require(path.join(ROOT, 'services', 'db', 'database.service.js'));
  const db = new DatabaseService(undefined, { role: 'read' });
  db.pool = {
    options: { max: 10 },
    waitingCount: 0,
    on() {},
    query() { return Promise.resolve({ rows: [{ ok: 1 }] }); },
    connect() { return Promise.resolve({ release() {} }); },
    end() { return Promise.resolve(); },
  };
  const started = Date.now();
  const result = await db.query('SELECT 1');
  assert.equal(result.rows[0].ok, 1);
  assert.ok(Date.now() - started < 100, 'مسیر عادی نباید کند شود');
});
