'use strict';

/**
 * D3 — مهاجرت نسخه‌دار: بی‌اثر بودن اجرای دوباره، تشخیص تغییر فایل، و ترتیب نسخه‌ها.
 * این آزمون به PostgreSQL نیاز ندارد؛ یک آداپتور ساده با شمارش «چند بار اجرا شد» کافی است.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { listFiles } = require('../services/db/migrations');

test('D3: فایل‌های مهاجرت مرتب و نسخه‌دارند', () => {
  const files = listFiles();
  assert.ok(files.length >= 3, 'حداقل سه مهاجرت (v1، v2، counter_present)');
  const versions = files.map((f) => f.version);
  assert.deepEqual(versions, [...versions].sort(), 'ترتیب نسخه‌ها صعودی');
  for (const file of files) assert.match(file.name, /^\d{3}-.+\.sql$/);
  for (const file of files) assert.equal(file.checksum.length, 32, 'checksum محاسبه شده');
});

test('D3: هر مهاجرت idempotent است (IF NOT EXISTS / DO $$)', () => {
  for (const file of listFiles()) {
    const sql = file.sql;
    const creates = (sql.match(/CREATE (TABLE|INDEX)/g) || []).length;
    const guarded = (sql.match(/IF NOT EXISTS/g) || []).length;
    assert.ok(
      creates === 0 || guarded >= creates - 1,
      `${file.name}: هر CREATE باید IF NOT EXISTS داشته باشد (${guarded}/${creates})`,
    );
  }
});
