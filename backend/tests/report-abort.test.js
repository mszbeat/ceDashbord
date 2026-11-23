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

/**
 * P6/6: ساخت کندِ شبیه‌سازی شده + قطع اتصال کلاینت وسط کار.
 * ساخت باید در پس‌زمینه تکمیل شود و درخواست بعدی از کش (cache: fresh) پاسخ گیرد.
 */
test('reportCache: ساخت کند + cut اتصال کلاینت → ساخت کامل شده و درخواست بعدی cache: fresh', async () => {
  const { createReportCache } = require('../services/report/report-cache');
  let now = 1_000_000;
  const cache = createReportCache({ ttlMs: 10_000, staleMs: 10_000, now: () => now });

  let buildStarted = false;
  let buildCompleted = false;
  const buildPromise = new Promise((resolve) => {
    setTimeout(() => {
      buildStarted = true;
      resolve('html-slow-build');
    }, 50);
  });

  const buildFn = async () => {
    const html = await buildPromise;
    buildCompleted = true;
    return html;
  };

  const controller = new AbortController();
  const { signal } = controller;

  // درخواست اول: cut Connection بعد از ۲۰ms (قبل از تکمیل ساخت در ۵۰ms)
  setTimeout(() => controller.abort(), 20);

  const first = await cache.getOrBuild('slow-key', buildFn, { signal });
  assert.equal(first.fromCache, 'detached', 'اولین درخواست detached باید باشد');
  assert.equal(first.html, null, 'html برای درخواست cut شده null است');

  // ساخت در پس‌زمینه ادامه می‌یابد و تکمیل می‌شود
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(buildStarted, 'ساخت شروع شده باشد');
  assert.ok(buildCompleted, 'ساخت تکمیل شده باشد (در پس‌زمینه)');

  // درخواست دوم: باید از کش fresh باشد
  now += 1000;
  const second = await cache.getOrBuild('slow-key', buildFn);
  assert.equal(second.fromCache, 'fresh', 'درخواست دوم باید از کش fresh باشد');
  assert.equal(second.html, 'html-slow-build', 'html باید از کش برگردد');
});

/**
 * P6/6: دو کلاینت هم‌زمان، یکی قطع می‌شود. دیگری باید نتیجه-building را بگیرد.
 */
test('reportCache: دو درخواست هم‌زمان، یکی cut → دیگری نتیجه می‌گیرد و ساخت یک‌بار اجرا می‌شود', async () => {
  const { createReportCache } = require('../services/report/report-cache');
  let now = 1_000_000;
  const cache = createReportCache({ ttlMs: 10_000, staleMs: 10_000, now: () => now });

  let builds = 0;
  const buildFn = async () => {
    builds += 1;
    await new Promise((r) => setTimeout(r, 30));
    return `html-${builds}`;
  };

  const controller = new AbortController();
  const { signal } = controller;
  setTimeout(() => controller.abort(), 10); // کلاینت اول زودتر cut می‌شود

  // درخواست اول با signal (cut)، درخواست دوم بدون signal
  const [first, second] = await Promise.all([
    cache.getOrBuild('shared-key', buildFn, { signal }),
    cache.getOrBuild('shared-key', buildFn),
  ]);

  // ساخت فقط یک‌بار اجرا شده باشد (تکی‌پرواز)
  assert.equal(builds, 1, `ساخت فقط یک‌بار اجرا شود، بود=${builds}`);

  // یکی detached (cut شده)، دیگری miss/joined با html
  const modes = [first.fromCache, second.fromCache].sort();
  assert.ok(modes.includes('detached'), 'یک درخواست detached باشد');
  assert.ok(modes.includes('miss') || modes.includes('joined'), 'یک درخواست miss/joined باشد');

  // درخواست بعدی: fresh از کش
  now += 1000;
  const third = await cache.getOrBuild('shared-key', buildFn);
  assert.equal(third.fromCache, 'fresh', 'طلب بعدی باید fresh باشد');
  assert.equal(builds, 1, 'ساخت هنوز یک‌بار باشد (kez fresh استفاده می‌شود)');
});
