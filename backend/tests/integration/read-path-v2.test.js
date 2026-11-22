'use strict';

/**
 * B4 — مسیر خواندن v2: keyset روی ایندکس، بدون Sort node.
 * B5 — ON CONFLICT ... WHERE IS DISTINCT FROM: ردیف بدون تغییر بازنویسی نمی‌شود.
 */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';
process.env.CE_API_BASE_URL = process.env.CE_API_BASE_URL || 'http://127.0.0.1:1/report';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, createTestDatabase, pgTest } = require('./helpers');

const { EvaluatorService } = require(path.join(ROOT, 'services', 'evaluator', 'evaluator.service'));
const { buildRuntimeRegistry } = require(path.join(ROOT, 'services', 'db', 'schema-registry'));
const builder = require(path.join(ROOT, 'services', 'db', 'schema-v2-builder'));
const { V2Writer } = require(path.join(ROOT, 'services', 'db', 'ingest-v2'));
const { V2Dialect } = require(path.join(ROOT, 'services', 'db', 'dialect-v2'));

function row(index, bankKey = 'tavan_mellat') {
  const id = `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`;
  return {
    request_id: id,
    day: '1405-08-01',
    inserted_at: `1405080112${String(index % 60).padStart(2, '0')}00000`,
    stamp_key: `1405080112${String(index % 60).padStart(2, '0')}00000`,
    unique_key: `uk-${index}`,
    is_success: index % 3 !== 0,
    total_time_s: index % 5 === 0 ? 6.5 : 1.2,
    pd: 0.5,
    flags: { noLoan: index % 2 === 0 },
    cats: {},
    metrics: {},
    counters: {},
    paths: {},
    services: {},
    credit_alerts: index % 7 === 0 ? { overdue: { bool: true, count: 1, totalAmount: '1000' } } : null,
    display_extras: { stamp: { key: `1405080112${String(index % 60).padStart(2, '0')}00000`, display: '1405/08/01 12:00:00' }, base: {} },
    analysis_version: 1,
    bankKey,
  };
}

async function stack(db, count = 400) {
  const evaluator = new EvaluatorService();
  const { registry, banksSpecs } = buildRuntimeRegistry(evaluator);
  await builder.applySchemaV2(db, { registry });
  await builder.seedRegistry(db, { registry, banksSpecs });
  await builder.seedListSpecs(db, { banksSpecs });
  const writer = new V2Writer(db, evaluator, { registry, banksSpecs });
  const client = await db.getClient();
  await writer.upsertBatch(client, 'tavan_mellat', Array.from({ length: count }, (_, i) => row(i + 1)));
  await db.query('ANALYZE samples_mellat');
  const dialect = new V2Dialect(db, { registry, listSpecs: {} });
  await dialect.ready();
  return { evaluator, dialect, writer };
}

pgTest('B4: keyset (day, ts, request_id) بدون Sort node و بدون COALESCE', async () => {
  const db = await createTestDatabase('b4');
  try {
    await stack(db, 500);
    const plan = await db.query(
      `EXPLAIN (FORMAT JSON) SELECT request_id FROM samples_mellat s
        WHERE s.day BETWEEN $1::date AND $2::date
          AND (s.day, s.ts, s.request_id) > ($1::date, 0::bigint, '00000000-0000-4000-9000-000000000000'::uuid)
        ORDER BY s.day, s.ts, s.request_id LIMIT 100`,
      ['2026-10-23', '2026-10-23'],
    );
    const text = JSON.stringify(plan.rows[0]);
    assert.ok(!/"Node Type":"Sort"/.test(text), `پلن نباید Sort داشته باشد: ${text.slice(0, 400)}`);
    // نام ایندکسِ پارتیشن با پیشوند پارتیشن ساخته می‌شود: idx_mellat_day_ts → …_day_ts_request_id_idx
    assert.ok(
      /day_ts_index|idx_mellat_day_ts|Index Only Scan|Index Scan/.test(text),
      `باید از ایندکس استفاده کند: ${text.slice(0, 400)}`,
    );
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('B4: شناسهٔ غیر-UUID در خواندن با خطای شفاف رد می‌شود', async () => {
  const db = await createTestDatabase('b4b');
  try {
    const { dialect } = await stack(db, 5);
    await assert.rejects(
      () => dialect.byRequestId('samples_mellat', 'me000000-1'),
      /UUID/,
    );
    const ok = await dialect.byRequestId('samples_mellat', '00000000-0000-4000-9000-000000000001');
    assert.equal(ok.rows.length, 1);
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('B4: صفحه‌بندی cursor با روز شمسی جلو می‌رود (رجیون باگ حلقهٔ بی‌پایان)', async () => {
  const db = await createTestDatabase('b4c');
  try {
    const { dialect } = await stack(db, 1200);
    let cursor = ['', '', ''];
    let pages = 0;
    let total = 0;
    for (;;) {
      const batch = await dialect.cursorPage('samples_mellat', '1405-08-01', '1405-08-01', cursor, 500);
      pages += 1;
      total += batch.rows.length;
      if (!batch.rows.length) break;
      const last = batch.rows[batch.rows.length - 1];
      cursor = [String(last.day || ''), String(last.stamp_key || ''), String(last.request_id || '')];
      if (batch.rows.length < 500) break;
      assert.ok(pages < 20, 'صفحه‌بندی نباید تکرار شود');
    }
    assert.equal(total, 1200, 'جمع ردیف‌های همهٔ صفحه‌ها');
    assert.ok(pages >= 3, `تعداد صفحه‌ها: ${pages}`);
  } finally {
    await db.close();
  }
}, { timeout: 120000 });

pgTest('B5: بازنویسی ردیف بدون تغییر، tuple مرده نمی‌سازد', async () => {
  const db = await createTestDatabase('b5');
  try {
    const { writer } = await stack(db, 50);
    const before = await db.query(
      "SELECT n_dead_tup, n_tup_upd FROM pg_stat_user_tables WHERE relname='samples_mellat'",
    );
    const client = await db.getClient();
    // همان داده‌ها دوباره نوشته می‌شوند (سناریوی rebuild)
    for (let i = 0; i < 3; i++) {
      await writer.upsertBatch(client, 'tavan_mellat', Array.from({ length: 50 }, (_, k) => row(k + 1)));
    }
    await db.query('ANALYZE samples_mellat');
    const after = await db.query(
      "SELECT n_dead_tup, n_tup_upd FROM pg_stat_user_tables WHERE relname='samples_mellat'",
    );
    const updates = Number(after.rows[0].n_tup_upd) - Number(before.rows[0].n_tup_upd);
    // با گارد IS DISTINCT FROM، ۳ بار بازنویسی دادهٔ یکسان هیچ UPDATE‌ای ایجاد نمی‌کند
    assert.equal(updates, 0, `تعداد UPDATE در بازنویسی بدون تغییر: ${updates}`);
  } finally {
    await db.close();
  }
}, { timeout: 120000 });
