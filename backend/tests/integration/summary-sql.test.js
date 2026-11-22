'use strict';

/**
 * فاز ۳ — برابری مسیر SQL با مسیر قدیمی (bump) و رفتار کش/single-flight.
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
const { SummaryService } = require(path.join(ROOT, 'services', 'summary', 'summary.service'));
const { buildDayRollup } = require(path.join(ROOT, 'services', 'rollup', 'rollup.service'));
const { makeRows } = require('./sample-rows');

async function stack(db, rowsPerBank = 120) {
  const evaluator = new EvaluatorService();
  const bundle = buildRuntimeRegistry(evaluator);
  const { registry, banksSpecs } = bundle;
  await builder.applySchemaV2(db, { registry });
  await builder.seedRegistry(db, { registry, banksSpecs });
  await builder.seedListSpecs(db, { banksSpecs });
  const writer = new V2Writer(db, evaluator, { registry, banksSpecs });
  await writer.ready();
  const dialect = new V2Dialect(db, { registry, listSpecs: {} });
  await dialect.ready();
  const service = new SummaryService(db, evaluator, { dialect });
  return { evaluator, bundle, writer, dialect, service, registry, banksSpecs };
}

pgTest('فاز ۳: summary مسیر SQL با مسیر bump برابر است (هر سه بانک)', async () => {
  const db = await createTestDatabase('sumsql');
  try {
    const { service, writer, evaluator } = await stack(db);
    const client = await db.getClient();
    for (const bankKey of ['tavan_mellat', 'tavan_resalat', 'tavan_postbank']) {
      const rows = makeRows(evaluator, bankKey, 90, { days: 9 });
      await writer.upsertBatch(client, bankKey, rows);
      await db.query(
        `INSERT INTO day_runs(bank, day, status, mode) SELECT $1, day, 'complete', 'nightly'
           FROM (SELECT DISTINCT day FROM ${bankKey === 'tavan_mellat' ? 'samples_mellat' : bankKey === 'tavan_resalat' ? 'samples_resalat' : 'samples_postbank'}) d
         ON CONFLICT (bank, day) DO UPDATE SET status='complete'`,
        [bankKey],
      );
    }
    await db.query('ANALYZE');
    for (const bankKey of ['tavan_mellat', 'tavan_resalat', 'tavan_postbank']) {
      // مسیر قدیمی = همان `buildDashboard` + `bump` روی ردیف‌های v2 (dialect-v2.cursorPage)
      const legacy = await service.legacySummary(bankKey, '1405-08-01', '1405-09-30');
      const sql = await service.summary(bankKey, '1405-08-01', '1405-09-30');
      const strip = (value) => {
        const copy = JSON.parse(JSON.stringify(value));
        delete copy.runs;
        delete copy.generatedAt;
        delete copy.source;
        return copy;
      };
      assert.deepEqual(strip(sql), strip(legacy), `برابری summary بانک ${bankKey}`);
    }
  } finally {
    await db.close();
  }
}, { timeout: 180000 });

pgTest('فاز ۳: کش single-flight — چند درخواست هم‌کلید یک محاسبه', async () => {
  const db = await createTestDatabase('sumcache');
  try {
    const { service, writer, evaluator } = await stack(db);
    const client = await db.getClient();
    await writer.upsertBatch(client, 'tavan_mellat', makeRows(evaluator, 'tavan_mellat', 60, { days: 6 }));
    await db.query('ANALYZE');

    const before = service.cache.stats();
    const producerRuns = { count: 0 };
    const original = service.cache.remember.bind(service.cache);
    service.cache.remember = (key, producer, ttl) => original(key, async () => {
      if (key.startsWith('["summary"')) producerRuns.count += 1;
      return producer();
    }, ttl);
    await Promise.all([
      service.summary('tavan_mellat', '1405-08-01', '1405-09-30'),
      service.summary('tavan_mellat', '1405-08-01', '1405-09-30'),
      service.summary('tavan_mellat', '1405-08-01', '1405-09-30'),
      service.summary('tavan_mellat', '1405-08-01', '1405-09-30'),
    ]);
    const stats = service.cache.stats();
    assert.equal(producerRuns.count, 1, `تعداد محاسبهٔ تجمیع: ${producerRuns.count}`);
    assert.ok(stats.coalesced - before.coalesced >= 3, `درخواست‌های ادغام‌شده: ${stats.coalesced - before.coalesced}`);
    // بار دوم از کش می‌آید
    const hitBefore = service.cache.stats().hits;
    await service.summary('tavan_mellat', '1405-08-01', '1405-09-30');
    assert.ok(service.cache.stats().hits > hitBefore, 'بار دوم باید از کش بیاید');
  } finally {
    await db.close();
  }
}, { timeout: 180000 });

pgTest('فاز ۳: rollup روز ساخته و در بازه استفاده می‌شود', async () => {
  const db = await createTestDatabase('sumrollup');
  try {
    const { service, writer, evaluator, bundle } = await stack(db);
    const client = await db.getClient();
    await writer.upsertBatch(client, 'tavan_mellat', makeRows(evaluator, 'tavan_mellat', 40, { days: 4 }));
    await db.query('ANALYZE');
    const days = await db.query('SELECT DISTINCT day FROM samples_mellat ORDER BY day');
    for (const row of days.rows) {
      const iso = row.day.toISOString().slice(0, 10);
      await buildDayRollup(db, { bankKey: 'tavan_mellat', day: iso, evaluator, registryBundle: bundle });
    }
    const rollups = await db.query('SELECT COUNT(*)::int AS n FROM day_rollup');
    assert.equal(rollups.rows[0].n, days.rows.length, 'rollup برای هر روز');
    // مسیر SQL (با rollup) باید همان اعداد را بدهد
    const withRollup = await service.summary('tavan_mellat', '1405-08-01', '1405-09-30');
    const legacy = await service.summary('tavan_mellat', '1405-08-01', '1405-09-30', { useSql: false });
    assert.equal(withRollup.stats.total, legacy.stats.total, 'total با rollup');
    assert.deepEqual(withRollup.flags, legacy.flags, 'flags با rollup');
  } finally {
    await db.close();
  }
}, { timeout: 180000 });
