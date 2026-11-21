'use strict';
const BACKEND = process.env.CE_BACKEND || require('node:path').join(__dirname, '..', 'backend');
/**
 * تأخیر واقعی مسیرهای خواندن: v1 (jsonb) در برابر v2 (typed + پارتیشن).
 * هر حالت در یک پروسهٔ جدا اجرا می‌شود (حافظهٔ محدود سندباکس؛ هر PGlite ~۵۰۰MB).
 *   MODE=v1 PER_BANK=3000 node bench-latency.js
 *   MODE=v2 PER_BANK=3000 node bench-latency.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const common = require('./common');
const { loadEvaluator, readSamples, makeRows, TABLES, UPSERT_COLUMNS, dbAdapter } = common;
const { buildRuntimeRegistry } = require(BACKEND + '/services/db/schema-registry');
const builder = require(BACKEND + '/services/db/schema-v2-builder');
const { V2Writer } = require(BACKEND + '/services/db/ingest-v2');
const { V2Dialect } = require(BACKEND + '/services/db/dialect-v2');
const { SummaryService } = require(BACKEND + '/services/summary/summary.service');

const MODE = process.env.MODE || 'v1';
const PER = Number(process.env.PER_BANK || 3000);
const RUNS = Number(process.env.RUNS || 5);
const JSON_COLS = new Set(['flags','cats','counters','metrics','paths','services','credit_alerts','display_extras']);
const RANGE = ['1405-08-01', '1405-09-30'];
const KEEP = process.env.KEEP_ALIVE === '1';

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
async function timeIt(fn) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const start = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { median: Math.round(median(times) * 10) / 10, min: Math.round(Math.min(...times) * 10) / 10 };
}

async function buildV1(ev, rowsByBank) {
  const db = new PGlite();
  await db.exec(fs.readFileSync(BACKEND + '/services/db/schema.sql', 'utf8'));
  for (const [bank, rows] of Object.entries(rowsByBank)) {
    const table = TABLES[bank];
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200); const values = []; const params = [];
      chunk.forEach((row, ri) => {
        values.push(`(${UPSERT_COLUMNS.map((_, c) => `$${ri * UPSERT_COLUMNS.length + c + 1}`).join(',')})`);
        for (const col of UPSERT_COLUMNS) {
          const v = row[col];
          params.push(JSON_COLS.has(col) && v != null ? JSON.stringify(v) : v);
        }
      });
      await db.query(`INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
    }
    await db.query(`INSERT INTO day_runs(bank,day,mode,status,updated_at)
      SELECT $1::text, day, 'nightly', 'complete', now() FROM (SELECT DISTINCT day FROM ${table}) d ON CONFLICT DO NOTHING`, [bank]);
  }
  await db.query('ANALYZE');
  return { db, service: new SummaryService(dbAdapter(db), ev) };
}

async function buildV2(ev, registry, banksSpecs, rowsByBank) {
  const db = new PGlite();
  const adapter = { query: (s, p) => db.query(s, p), exec: (s) => db.exec(s) };
  await builder.applySchemaV2(adapter, { registry });
  await builder.seedRegistry(adapter, { registry, banksSpecs });
  await builder.seedListSpecs(adapter, { banksSpecs });
  const writer = new V2Writer(adapter, ev, { registry, banksSpecs, chunkSize: 100 });
  for (const [bank, rows] of Object.entries(rowsByBank)) {
    await writer.upsertBatch(adapter, bank, rows);
    await db.query(`INSERT INTO day_runs(bank,day,status)
      SELECT $1::text, day::date, 'complete' FROM (SELECT DISTINCT day FROM ${TABLES[bank]}) d ON CONFLICT DO NOTHING`, [bank]);
  }
  await db.query('ANALYZE');
  const listSpecs = {};
  for (const bank of Object.keys(registry)) listSpecs[bank] = (ev.getBank(bank).lists || []).map((l) => l.title);
  const dialect = new V2Dialect(adapter, { registry, listSpecs });
  await dialect.ready();
  return { db, service: new SummaryService(adapter, ev, { dialect }) };
}

async function sizesOf(db) {
  const r = await db.query(`SELECT c.relname n, pg_total_relation_size(c.oid) b
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname='public' AND c.relkind='r'`);
  const map = {};
  for (const row of r.rows) map[row.n] = Math.round(Number(row.b) / 1024);
  return map;
}

(async () => {
  const ev = loadEvaluator();
  const { registry, banksSpecs } = buildRuntimeRegistry(ev);
  const samples = readSamples();
  const rowsByBank = {};
  for (const [bank, base] of Object.entries(samples)) {
    rowsByBank[bank] = makeRows(ev, bank, base, PER).map((row) => {
      if (row.display_extras?.base) row.display_extras.base['وضعیت'] = row.is_success ? 'موفق' : 'ناموفق';
      return row;
    });
  }

  const { db, service } = MODE === 'v2'
    ? await buildV2(ev, registry, banksSpecs, rowsByBank)
    : await buildV1(ev, rowsByBank);

  const out = { mode: MODE, perBank: PER, runs: RUNS, banks: {} };
  for (const bank of Object.keys(samples)) {
    const [from, to] = RANGE;
    out.banks[bank] = {
      summary: await timeIt(() => service.summary(bank, from, to)),
      listAll: await timeIt(() => service.list({ bank, from, to, type: 'all', limit: 100 })),
      listFlag: await timeIt(() => service.list({ bank, from, to, type: 'flag', id: registry[bank].flag[0] })),
      listMetric: await timeIt(() => service.list({ bank, from, to, type: 'metric', id: registry[bank].metric[0] })),
      report: await timeIt(() => service.report(bank, from, to, 100)),
    };
  }
  out.sizes = await sizesOf(db);
  if (!KEEP) {
    // آزادسازی حافظهٔ موتور قبل از خروج (سندباکس ۲GB)
    await db.close().catch(() => {});
  }
  fs.writeFileSync(`latency-${MODE}.json`, JSON.stringify(out, null, 2));
  console.log(`${MODE} done:`, JSON.stringify(out.banks.tavan_mellat));
  console.log('sizes:', JSON.stringify(out.sizes).slice(0, 400));
})().catch((e) => { console.error('ERR', e.message, e.stack?.split('\n').slice(0, 4).join('\n')); process.exit(1); });
