'use strict';

/**
 * P6: abort-aware گزارش — وقتی کلاینت قطع می‌شود، حلقهٔ cursorPage متوقف می‌شود
 * و اتصال آزاد می‌گردد (بدون بازنویسی جزئی در کش).
 */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SummaryService } = require('../services/summary/summary.service');

/** دایلیكت قشری: هر بار cursorPage صدا زده شود، شمارنده را بیشتر و یک ردیف باز می‌دهد */
function makeDialect({ pages = 3, pageDelayMs = 0 } = {}) {
  let calls = 0;
  return {
    name: 'mock',
    onSerial(db) { return this; },
    async countRange() { return { rows: [{ total: 0 }], rowCount: 1 }; },
    async days() { return { rows: [], rowCount: 0 }; },
    async runsRange() { return { rows: [], rowCount: 0 }; },
    async serviceDiscovery() { return { rows: [], rowCount: 0 }; },
    async cursorPage() {
      calls += 1;
      if (pageDelayMs) await new Promise((r) => setTimeout(r, pageDelayMs));
      const done = calls >= pages;
      const pageSize = 1000;
      const rows = done
        ? []
        : Array.from({ length: pageSize }, (_, i) => ({
            day: '1405-08-01',
            stamp_key: `s${calls}-${i}`,
            request_id: `id-${calls}-${i}`,
          }));
      return { rows, rowCount: rows.length };
    },
    get calls() { return calls; },
    reset() { calls = 0; },
  };
}

function makeService(dialect) {
  const db = { query: async () => ({ rows: [], rowCount: 0 }), exec: async () => {} };
  const evaluator = {
    getBank: () => ({
      key: 'tavan_mellat',
      expectedServices: [], paths: [], flags: [], categories: [], cross: [],
      counters: [], metrics: [], lists: [], service: [], topics: [],
      catById: {},
    }),
    specs: () => [],
  };
  return new SummaryService(db, evaluator, { dialect });
}

test('buildDashboard: سیگنال ابort قبل از شروع → خطا AbortError و بدون فراخوانی cursorPage', async () => {
  const dialect = makeDialect({ pages: 10 });
  const service = makeService(dialect);

  const controller = new AbortController();
  controller.abort(); // قبل از صدا زدن buildDashboard

  await assert.rejects(
    service.buildDashboard('tavan_mellat', '1405-08-01', '1405-08-31', 100, { signal: controller.signal }),
    (error) => error.name === 'AbortError' && error.code === 'ABORTED',
    'باید با AbortError/ABORTED خطا دهد'
  );

  assert.equal(dialect.calls, 0, 'هیچ صفحهٔ cursorPage اجرا نشده باشد');
});

test('buildDashboard: ابort در حین پیمایش → اسکن متوقف می‌شود (صفحات کمتر از سقف)', async () => {
  const dialect = makeDialect({ pages: 10, pageDelayMs: 5 });
  const service = makeService(dialect);

  const controller = new AbortController();
  // بعد از ۳۰ms ابort کنیم — تا Pages چند اجرا شده باشند
  const abortTimer = setTimeout(() => controller.abort(), 30);

  await assert.rejects(
    service.buildDashboard('tavan_mellat', '1405-08-01', '1405-08-31', 100, { signal: controller.signal }),
    (error) => error.name === 'AbortError' && error.code === 'ABORTED',
    'باید با AbortError/ABORTED خطا دهد'
  );
  clearTimeout(abortTimer);

  // فراخوانی‌ها باید بین ۱ و ۹ باشد (اسکن متوقف شده، همه ۱۰ اجرا نشده‌اند)
  assert.ok(dialect.calls >= 1 && dialect.calls < 10,
    `اسکن باید متوقف شود (فراخوان=${dialect.calls}, سقف=10)`);
});

test('buildDashboard: بدون سیگنال، توت صفحات اجرا می‌شود', async () => {
  const dialect = makeDialect({ pages: 4 });
  const service = makeService(dialect);

  const built = await service.buildDashboard('tavan_mellat', '1405-08-01', '1405-08-31', 100);
  assert.equal(dialect.calls, 4, `تoutes صفحات اجرا شده باشند، بود=${dialect.calls}`);
  assert.ok(built.data, 'دیتا برگردانده شده باشد');
});
