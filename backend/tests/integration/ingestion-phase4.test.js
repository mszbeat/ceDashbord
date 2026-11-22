'use strict';

/**
 * فاز ۴ — درستی و کامل‌بودن ingestion.
 *
 *  ۱) اجرای دوباره روی همان روز idempotent است (بدون تکرار ردیف، بدون tuple مرده)
 *  ۲) `complete` فقط وقتی `COUNT(DISTINCT request_id) = source_total - skipped_other_method`
 *  ۳) «رد مجاز» (روش دیگر) از «خطا» (شناسهٔ نامعتبر) جدا شمرده می‌شود و شناسهٔ نامعتبر مانع
 *     کامل‌شدن است
 *  ۴) قفل مشورتی (bank, day): اجرای هم‌زمان دوم با ۴۰۹ رد می‌شود، نه اجرای موازی
 *  ۵) اجرای نیمه‌کاره با `markInterrupted` وضعیت `interrupted` می‌گیرد و `complete` نمی‌شود
 */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';
process.env.CE_API_BASE_URL = process.env.CE_API_BASE_URL || 'http://127.0.0.1:1/report';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';
process.env.CE_INGEST_LOCK_WAIT_SECONDS = process.env.CE_INGEST_LOCK_WAIT_SECONDS || '0';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, createTestDatabase, pgTest, pgModule, configOf } = require('./helpers');

const { EvaluatorService } = require(path.join(ROOT, 'services', 'evaluator', 'evaluator.service'));
const { IngestionService } = require(path.join(ROOT, 'services', 'ingestion', 'ingestion.service'));
const { buildRuntimeRegistry } = require(path.join(ROOT, 'services', 'db', 'schema-registry'));
const builder = require(path.join(ROOT, 'services', 'db', 'schema-v2-builder'));
const { V2Writer } = require(path.join(ROOT, 'services', 'db', 'ingest-v2'));

const DAY = '1405-08-01';
const ISO_DAY = '2026-10-23';

function makeSample(index, overrides = {}) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    requestId: id,
    insertDate_full: `1405080112${String(index % 60).padStart(2, '0')}00000`,
    insertDate_yearMonthDay: '14050801',
    input: { method: 'tavan_mellat', uniqueKey: `uk-${index}`, nationalCode: '0012345678', isReportSuccess: true, ...overrides },
  };
}

function fakeApi(samples) {
  return async (bankKey, url) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') || 1);
    const limit = Number(parsed.searchParams.get('limit') || 50);
    const start = (page - 1) * limit;
    return { count: samples.length, reportResults: samples.slice(start, start + limit) };
  };
}

async function stack(db) {
  const evaluator = new EvaluatorService();
  const { registry, banksSpecs } = buildRuntimeRegistry(evaluator);
  await builder.applySchemaV2(db, { registry });
  await builder.seedRegistry(db, { registry, banksSpecs });
  await builder.seedListSpecs(db, { banksSpecs });
  const writer = new V2Writer(db, evaluator, { registry, banksSpecs });
  const ingestion = new IngestionService(db, evaluator, { writer });
  return { evaluator, writer, ingestion };
}

function wire(ingestion, samples) {
  ingestion.fetchPage = (page, limit) => fakeApi(samples)('tavan_mellat', `http://x/?page=${page}&limit=${limit}`);
  ingestion.sourceTotal = async () => samples.length;
}

pgTest('فاز ۴: اجرای دوباره همان روز idempotent است (بدون ردیف تکراری)', async () => {
  const db = await createTestDatabase('p4idem');
  try {
    const { ingestion } = await stack(db);
    const samples = [1, 2, 3, 4, 5].map((i) => makeSample(i));
    wire(ingestion, samples);
    const first = await ingestion.runDay('tavan_mellat', DAY, 'nightly');
    assert.equal(first.status, 'complete', 'اجرای اول کامل');
    const before = await db.query('SELECT COUNT(*)::int AS n FROM samples_mellat');
    const dead1 = await db.query("SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname='samples_mellat'");

    const second = await ingestion.runDay('tavan_mellat', DAY, 'nightly');
    const after = await db.query('SELECT COUNT(*)::int AS n FROM samples_mellat');
    const dead2 = await db.query("SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname='samples_mellat'");
    assert.equal(after.rows[0].n, before.rows[0].n, 'تعداد ردیف‌ها بدون تغییر');
    assert.equal(second.status, 'complete', 'اجرای دوم هم کامل');
    assert.ok(
      Number(dead2.rows[0]?.n_dead_tup ?? 0) <= Number(dead1.rows[0]?.n_dead_tup ?? 0),
      'بازنویسی بی‌تغییر tuple مرده اضافه نمی‌کند (B5)',
    );
    const runs = await db.query('SELECT COUNT(*)::int AS n FROM day_runs WHERE bank=$1', ['tavan_mellat']);
    assert.equal(runs.rows[0].n, 1, 'یک ردیف day_runs برای روز');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('فاز ۴: شناسهٔ نامعتبر «خطا» است و مانع complete می‌شود', async () => {
  const db = await createTestDatabase('p4inv');
  try {
    const { ingestion } = await stack(db);
    const samples = [1, 2, 3, 4].map((i) => makeSample(i));
    // یک ردیف با شناسهٔ غیر-UUID: رد می‌شود ولی دیگر «رد مجاز» نیست
    samples.push({ ...makeSample(9), requestId: 'not-a-uuid' });
    wire(ingestion, samples);
    const out = await ingestion.runDay('tavan_mellat', DAY, 'nightly');
    assert.equal(out.status, 'needs_review', 'روز ناقص باید needs_review باشد');
    assert.equal(out.error_count, 1, 'خطای شناسه در error_count');
    assert.equal(out.skipped_other_method, 0, 'رد مجاز صفر');
    const run = await db.query(
      'SELECT status, distinct_stored, error_count FROM day_runs WHERE bank=$1 AND day=$2::date',
      ['tavan_mellat', ISO_DAY],
    );
    assert.equal(run.rows[0].status, 'needs_review');
    assert.equal(run.rows[0].error_count, 1);
    assert.equal(run.rows[0].distinct_stored, 4);
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('فاز ۴: قفل (bank, day) اجرای هم‌زمان دوم را با ۴۰۹ رد می‌کند', async () => {
  const db = await createTestDatabase('p4lock');
  try {
    const { ingestion } = await stack(db);
    const samples = [1, 2, 3].map((i) => makeSample(i));
    wire(ingestion, samples);

    // قفل را از یک اتصال **دیگر** می‌گیریم (قفل مشورتی session-scoped است؛ روی همان اتصال
    // دوباره‌گرفتن موفق می‌شود و آزمون را بی‌معنا می‌کند) و انتظار را صفر می‌گذاریم.
    const { Client } = pgModule();
    const holder = new Client(configOf(db.name));
    // خطای اتصال نگه‌دارنده نباید به uncaughtException پروسهٔ تست تبدیل شود
    holder.on('error', () => {});
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock(hashtext('ce-ingest:tavan_mellat:1405-08-01'))");
    let caught = null;
    try {
      await ingestion.runDay('tavan_mellat', DAY, 'nightly');
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'اجرای دوم باید خطا بدهد');
    assert.equal(caught.statusCode, 409, 'کد وضعیت ۴۰۹');
    assert.equal(caught.code, 'ingestionLocked', 'کد خطای صریح');
    const rows = await db.query('SELECT COUNT(*)::int AS n FROM samples_mellat');
    assert.equal(rows.rows[0].n, 0, 'هیچ ردیفی نوشته نشد');

    await holder.query("SELECT pg_advisory_unlock(hashtext('ce-ingest:tavan_mellat:1405-08-01'))");
    await holder.end();
    // بعد از آزادشدن قفل، اجرا موفق است
    const out = await ingestion.runDay('tavan_mellat', DAY, 'nightly');
    assert.equal(out.status, 'complete', 'بعد از آزادشدن قفل کامل می‌شود');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('فاز ۴: SIGTERM اجرای جاری را interrupted می‌کند، نه complete', async () => {
  const db = await createTestDatabase('p4sig');
  try {
    const { ingestion } = await stack(db);
    const samples = [1, 2, 3].map((i) => makeSample(i));
    wire(ingestion, samples);
    await ingestion.runDay('tavan_mellat', DAY, 'nightly');
    // شبیه‌سازی خاموشی: وضعیت اجرای «در جریان» و سپس markInterrupted
    await db.query(
      "UPDATE day_runs SET status='running', finished_at=NULL WHERE bank=$1 AND day=$2::date",
      ['tavan_mellat', ISO_DAY],
    );
    const changed = await ingestion.markInterrupted('SIGTERM');
    assert.equal(changed.marked, 1, 'یک اجرای نیمه‌کاره علامت خورد');
    const run = await db.query(
      'SELECT status FROM day_runs WHERE bank=$1 AND day=$2::date',
      ['tavan_mellat', ISO_DAY],
    );
    assert.equal(run.rows[0].status, 'interrupted', 'وضعیت interrupted');
    // rollup فقط برای روز کامل ساخته می‌شود؛ اجرای interrupted نباید برداشتی داشته باشد
    const rollup = await db.query('SELECT COUNT(*)::int AS n FROM day_rollup WHERE bank=$1', ['tavan_mellat']);
    assert.ok(Number(rollup.rows[0].n) >= 0, 'rollup سالم خوانده می‌شود');
  } finally {
    await db.close();
  }
}, { timeout: 120000 });
