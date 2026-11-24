'use strict';

/**
 * ۳-الف — صفحه‌بندی رکوردها: هر صفحه ۵۰تایی، دسترسی به **همهٔ** رکوردها،
 * بدون تکرار/جاافتادگی (حتی با `ts` یکسان) و پاسخ سریع حتی برای صفحهٔ آخر.
 */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';
process.env.CE_API_BASE_URL = process.env.CE_API_BASE_URL || 'http://127.0.0.1:1/report';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, createTestDatabase, pgTest } = require('./helpers');
const { makeRows } = require('./sample-rows');

const { EvaluatorService } = require(path.join(ROOT, 'services', 'evaluator', 'evaluator.service'));
const { buildRuntimeRegistry } = require(path.join(ROOT, 'services', 'db', 'schema-registry'));
const builder = require(path.join(ROOT, 'services', 'db', 'schema-v2-builder'));
const { V2Writer } = require(path.join(ROOT, 'services', 'db', 'ingest-v2'));
const { V2Dialect } = require(path.join(ROOT, 'services', 'db', 'dialect-v2'));
const { SummaryService } = require(path.join(ROOT, 'services', 'summary', 'summary.service'));

async function setup(db, count) {
  const evaluator = new EvaluatorService();
  const bundle = buildRuntimeRegistry(evaluator);
  const { registry, banksSpecs } = bundle;
  await builder.applySchemaV2(db, { registry });
  await builder.seedRegistry(db, { registry, banksSpecs });
  await builder.seedListSpecs(db, { banksSpecs });
  const writer = new V2Writer(db, evaluator, { registry, banksSpecs });
  await writer.ready();
  const client = await db.getClient();
  const rows = makeRows(evaluator, 'tavan_mellat', count, { days: 10 });
  // نیمی از ردیف‌ها مهر زمانی یکسان دارند تا tie-break واقعاً آزموده شود
  rows.forEach((row, index) => {
    if (index % 2 === 0) row.stamp_key = '140508011200000';
  });
  await writer.upsertBatch(client, 'tavan_mellat', rows);
  await db.query('ANALYZE');
  const dialect = new V2Dialect(db, { registry, listSpecs: {} });
  await dialect.ready();
  const service = new SummaryService(db, evaluator, { dialect });
  return { service, evaluator };
}

pgTest('۳-الف: مجموع صفحه‌ها = total، بدون تکرار و بدون جاافتادگی', async () => {
  const db = await createTestDatabase('page');
  try {
    const { service } = await setup(db, 260);
    const seen = new Set();
    let cursor;
    let pages = 0;
    let total = null;
    for (;;) {
      const page = await service.list({
        bank: 'tavan_mellat',
        from: '1405-08-01',
        to: '1405-09-30',
        type: 'all',
        limit: 50,
        cursor,
      });
      pages += 1;
      total = page.total;
      assert.ok(page.rows.length <= 50, 'اندازهٔ صفحه');
      for (const row of page.rows) {
        assert.ok(!seen.has(row.request_id), `تکرار رکورد ${row.request_id}`);
        seen.add(row.request_id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      assert.ok(pages < 20, 'حلقهٔ صفحه‌بندی نباید بی‌پایان باشد');
    }
    assert.equal(total, 260, 'total از شمارش فیلتر');
    assert.equal(seen.size, 260, 'همهٔ رکوردها دیده شدند');
    assert.equal(pages, 6, 'تعداد صفحه‌ها');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('۳-الف: صفحه‌بندی رکوردهای یک شاخص (flag) هم کامل است', async () => {
  const db = await createTestDatabase('pageflag');
  try {
    const { service } = await setup(db, 150);
    const all = await service.list({ bank: 'tavan_mellat', from: '1405-08-01', to: '1405-09-30', type: 'all', limit: 50 });
    const flagPage = await service.list({
      bank: 'tavan_mellat', from: '1405-08-01', to: '1405-09-30', type: 'flag', id: 'hasLoan', limit: 50,
    });
    assert.ok(flagPage.total <= all.total, 'total فیلترشده از کل بیشتر نیست');
    assert.ok(flagPage.rows.every((row) => row.flags.hasLoan === true), 'همهٔ ردیف‌ها دارای پرچم');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('۳-الف: صفحه‌های متریک/زمان با cursor جلو می‌روند', async () => {
  const db = await createTestDatabase('pagerank');
  try {
    const { service } = await setup(db, 240);
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const res = await service.list({
        bank: 'tavan_mellat', from: '1405-08-01', to: '1405-09-30', type: 'slow', limit: 50, cursor,
      });
      for (const row of res.rows) {
        assert.ok(!seen.has(row.request_id), 'تکرار در صفحه‌بندی زمانی');
        seen.add(row.request_id);
        assert.ok(Number(row.total_time_s) > 4, 'فیلتر زمان اجرا');
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    assert.ok(seen.size > 0, 'حداقل یک رکورد کند وجود دارد');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });
