'use strict';

/**
 * آزمون یکپارچهٔ ingestion روی v2 (B1, B2, B7).
 *
 * اثبات باگ‌ها:
 *  * B1 — `updateRun` ستون `skipped_count` را می‌نویسد ولی `day_runs` v2 آن را ندارد → 500.
 *  * B2 — rebuild روز شمسی `DELETE ... WHERE day=$1` هیچ ردیفی را پاک نمی‌کند (تاریخ ۱۴۰۵ میلادی).
 */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';
process.env.CE_API_BASE_URL = process.env.CE_API_BASE_URL || 'http://127.0.0.1:1/report';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';

const path = require('node:path');
const { ENABLED, ROOT, createTestDatabase, pgTest } = require('./helpers');

const { EvaluatorService } = require(path.join(ROOT, 'services', 'evaluator', 'evaluator.service'));
const { IngestionService } = require(path.join(ROOT, 'services', 'ingestion', 'ingestion.service'));
const { buildRuntimeRegistry } = require(path.join(ROOT, 'services', 'db', 'schema-registry'));
const builder = require(path.join(ROOT, 'services', 'db', 'schema-v2-builder'));
const { V2Writer } = require(path.join(ROOT, 'services', 'db', 'ingest-v2'));
const { V2Dialect } = require(path.join(ROOT, 'services', 'db', 'dialect-v2'));

const DAY = '1405-08-01';

/** حداقل نمونهٔ سازگار با API بانک (همان شکلی که evaluator می‌شناسد) */
function makeSample(index, overrides = {}) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    requestId: id,
    insertDate_full: '1405080112' + String(index % 60).padStart(2, '0') + '00000',
    insertDate_yearMonthDay: '14050801',
    input: {
      method: 'tavan_mellat',
      uniqueKey: `uk-${index}`,
      nationalCode: '0012345678',
      isReportSuccess: true,
      ...overrides,
    },
  };
}

async function makeStack(db) {
  const evaluator = new EvaluatorService();
  const { registry, banksSpecs } = buildRuntimeRegistry(evaluator);
  await builder.applySchemaV2(db, { registry });
  await builder.seedRegistry(db, { registry, banksSpecs });
  await builder.seedListSpecs(db, { banksSpecs });
  const writer = new V2Writer(db, evaluator, { registry, banksSpecs });
  const ingestion = new IngestionService(db, evaluator, { writer });
  const dialect = new V2Dialect(db, { registry, listSpecs: {} });
  return { evaluator, registry, banksSpecs, writer, ingestion, dialect };
}

/** API جعلی بانک: nPage صفحه که هر کدام pageSize نمونه برمی‌گرداند */
function fakeApi(samples) {
  const calls = [];
  const fetchImpl = async (bankKey, url) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') || 1);
    const limit = Number(parsed.searchParams.get('limit') || 50);
    calls.push({ page, limit });
    const start = (page - 1) * limit;
    return {
      count: samples.length,
      reportResults: samples.slice(start, start + limit),
    };
  };
  return { fetchImpl, calls };
}

pgTest('B1: updateRun در v2 ستون skipped_count را می‌نویسد و نمی‌شکند', async () => {
  const db = await createTestDatabase('b1');
  try {
    const stack = await makeStack(db);
    const method = 'tavan_mellat';
    // یک روز با ۶ ردیف معتبر و ۲ ردیف با متد دیگر (skip مجاز)
    const samples = [
      ...[1, 2, 3, 4, 5, 6].map((i) => makeSample(i)),
      makeSample(7, { method: 'other_method' }),
      makeSample(8, { method: 'other_method' }),
    ];
    const api = fakeApi(samples);
    stack.ingestion.fetchPage = (page, limit) => api.fetchImpl(method, `http://x/?page=${page}&limit=${limit}`);
    stack.ingestion.sourceTotal = async () => samples.length;

    const out = await stack.ingestion.runDay(method, DAY, 'nightly');
    const run = await db.query(
      'SELECT status, source_total, distinct_stored, skipped_other_method, error_count, ingested_count FROM day_runs WHERE bank=$1 AND day=$2::date',
      [method, '2026-10-23'],
    );
    const row = run.rows[0];
    // skip مجاز (روش دیگر) نباید مانع complete شود و باید جدا شمرده شود
    assertOk(row, 'day_runs row');
    assertEqual(out.skipped_other_method, 2, 'skipped_other_method');
    assertEqual(out.error_count, 0, 'error_count');
    assertEqual(row.distinct_stored, 6, 'distinct_stored = COUNT(DISTINCT request_id)');
    assertEqual(row.status, 'complete', 'status');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('B2: rebuild روز شمسی ردیف‌ها را واقعاً پاک می‌کند (۱۰ → ۷)', async () => {
  const db = await createTestDatabase('b2');
  try {
    const stack = await makeStack(db);
    const method = 'tavan_mellat';
    const first = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => makeSample(i));
    const api1 = fakeApi(first);
    stack.ingestion.fetchPage = (page, limit) => api1.fetchImpl(method, `http://x/?page=${page}&limit=${limit}`);
    stack.ingestion.sourceTotal = async () => first.length;
    await stack.ingestion.runDay(method, DAY, 'nightly');

    const api2 = fakeApi([1, 2, 3, 4, 5, 6, 7].map((i) => makeSample(i)));
    stack.ingestion.fetchPage = (page, limit) => api2.fetchImpl(method, `http://x/?page=${page}&limit=${limit}`);
    stack.ingestion.sourceTotal = async () => 7;
    const out = await stack.ingestion.runDay(method, DAY, 'nightly', { rebuild: true });
    assertEqual(out.deleted, 10, 'ردیف‌های حذف‌شده در rebuild');

    const remaining = await db.query('SELECT COUNT(*)::int AS n FROM samples_mellat');
    assertEqual(remaining.rows[0].n, 7, 'ردیف باقی‌مانده');
    const details = await db.query('SELECT COUNT(*)::int AS n FROM sample_detail');
    assertEqual(details.rows[0].n, 7, 'sample_detail روز هم پاک/بازسازی شد');
    const rollup = await db.query('SELECT COUNT(*)::int AS n FROM day_rollup');
    assertEqual(rollup.rows[0].n, 1, 'rollup روز بازسازی شد');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('B7: ingestion کامل یک روز → summary → rebuild → resume با برابری', async () => {
  const db = await createTestDatabase('b7');
  try {
    const stack = await makeStack(db);
    const method = 'tavan_mellat';
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => makeSample(i));
    const api = fakeApi(samples);
    stack.ingestion.fetchPage = (page, limit) => api.fetchImpl(method, `http://x/?page=${page}&limit=${limit}`);
    stack.ingestion.sourceTotal = async () => samples.length;
    const out = await stack.ingestion.runDay(method, DAY, 'nightly');
    assertEqual(out.status, 'complete', 'روز کامل شد');

    // قطع در میانه: صفحهٔ دوم خطا می‌دهد → checkpoint باید حفظ شود
    // pageSize از طریق فیلترها خوانده می‌شود؛ قطع روی صفحهٔ دوم
    let calls = 0;
    const flaky = async (page, limit) => {
      calls += 1;
      if (calls === 2) throw new Error('شبکه قطع شد');
      return api.fetchImpl(method, `http://x/?page=${page}&limit=${limit}`);
    };
    stack.ingestion.fetchPage = (page, limit) => flaky(page, limit);
    stack.ingestion.sourceTotal = async () => samples.length;
    await stack.ingestion.runDay(method, DAY, 'nightly', { rebuild: true, filters: { pageSize: 5 } })
      .then(() => { throw new Error('باید شکست می‌خورد'); })
      .catch((error) => {
        if (/باید شکست می‌خورد/.test(error.message)) throw error;
      });
    const failed = await db.query('SELECT status, checkpoint FROM day_runs WHERE bank=$1 AND day=$2::date', [method, '2026-10-23']);
    assertEqual(failed.rows[0].status, 'interrupted', 'وضعیت پس از قطع');
    // تراکنش rebuild اتمیک است: دادهٔ قبلی دست‌نخورده ماند
    const intact = await db.query('SELECT COUNT(*)::int AS n FROM samples_mellat');
    assertEqual(intact.rows[0].n, samples.length, 'دادهٔ روز پس از rebuild ناموفق دست‌نخورده');

    // resume: ادامه از checkpoint، بدون rebuild
    stack.ingestion.fetchPage = (page, limit) => api.fetchImpl(method, `http://x/?page=${page}&limit=${limit}`);
    stack.ingestion.sourceTotal = async () => samples.length;
    const resumed = await stack.ingestion.runDay(method, DAY, 'nightly');
    const count = await db.query('SELECT COUNT(*)::int AS n FROM samples_mellat');
    assertEqual(count.rows[0].n, samples.length, 'همهٔ ردیف‌ها بعد از resume');
    assertEqual(resumed.status, 'complete', 'resume به complete رسید');
  } finally {
    await db.close();
  }
}, { timeout: 180000 });

// ── کمک‌تابع‌های assert با پیام فارسی (node:assert هم استفاده می‌شود)
const assert = require('node:assert/strict');
function assertOk(value, label) {
  assert.ok(value, `${label} باید موجود باشد`);
}
function assertEqual(actual, expected, label) {
  assert.equal(actual, expected, `${label}: انتظار ${expected}، دریافت ${actual}`);
}
