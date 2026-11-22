'use strict';

/** فاز ۳ — گیت هم‌زمانی: بالاتر از سقف ۴۲۹ (نه صف بی‌پایان)، و شمارش درست. */

const assert = require('node:assert/strict');
const test = require('node:test');
const { ConcurrencyGate } = require('../services/http/concurrency-gate');

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('گیت: درخواست اضافه ۴۲۹ می‌گیرد و بعد از آزادشدن دوباره راه می‌دهد', async () => {
  const gate = new ConcurrencyGate({ max: 2 });
  const tasks = [1, 2, 3].map((id) =>
    gate.run(async () => {
      await delay(20);
      return id;
    }, { route: 'summary' }),
  );
  const results = await Promise.allSettled(tasks);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 2, 'دو درخواست اول قبول');
  assert.equal(rejected.length, 1, 'سومی رد');
  assert.equal(rejected[0].reason.statusCode, 429);
  assert.equal(rejected[0].reason.code, 'tooManyRequests');
  assert.equal(rejected[0].reason.retryAfter, 1);
  assert.deepEqual(gate.stats(), { active: 0, peak: 2, rejected: 1, max: 2 });

  // بعد از آزادشدن، ظرفیت برمی‌گردد
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('گیت: خطای تابع، شمارندهٔ فعال را آزاد می‌کند (بدون نشتی)', async () => {
  const gate = new ConcurrencyGate({ max: 1 });
  await assert.rejects(() => gate.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(gate.stats().active, 0);
});

test('گیت: CE_MAX_CONCURRENT_READS=0 یعنی بی‌سقف', async () => {
  const gate = new ConcurrencyGate({ max: 0 });
  const out = await Promise.all([1, 2, 3, 4, 5].map((id) => gate.run(async () => id)));
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
  assert.equal(gate.stats().rejected, 0);
});
