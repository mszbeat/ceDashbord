'use strict';

/** D5/D8 — اعتبارسنجی محیط: http در production ممنوع، اسکیمای نامعتبر و DATABASE_URL الزامی. */

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateEnv } = require('../services/config');

const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://db/ce', SESSION_SECRET: 'x', CE_DB_SCHEMA: 'v2' };

test('D5: پروتکل http در production رد می‌شود', () => {
  const out = validateEnv({ ...base, CE_REPORT_PROTOCOL: 'http' });
  assert.ok(out.errors.some((e) => e.includes('http')), 'خطای پروتکل');
});

test('D5: آدرس بانک با http در production رد می‌شود، https قبول', () => {
  assert.ok(validateEnv({ ...base, CE_API_BASE_URL: 'http://bank.local/report' }).errors.length > 0);
  assert.equal(validateEnv({ ...base, CE_API_BASE_URL: 'https://bank.local/report' }).errors.length, 0);
});

test('D8: CE_DB_SCHEMA نامعتبر و DATABASE_URL خالی مسدودکننده‌اند', () => {
  const out = validateEnv({ NODE_ENV: 'development', DATABASE_URL: '', CE_DB_SCHEMA: 'v3' });
  assert.ok(out.errors.some((e) => e.includes('CE_DB_SCHEMA')));
  assert.ok(out.errors.some((e) => e.includes('DATABASE_URL')));
});

test('D8: در محیط توسعه http مجاز است (با هشدار پیکربندی)', () => {
  const out = validateEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgres://db/ce', CE_REPORT_PROTOCOL: 'http' });
  assert.equal(out.errors.length, 0);
});
