'use strict';
/**
 * فاز ۳ — اندازه‌گیری مسیر خواندن روی PostgreSQL واقعی با ≥۱ میلیون ردیف.
 *
 *   TARGET_PER_BANK=350000 node --max-old-space-size=1500 pg-phase3.js
 *
 * چه چیزی اندازه‌گیری می‌شود:
 *  * p50/p95 خلاصهٔ SQL (سرد و کش‌شده) و مقایسه با مسیر قدیمی روی همان داده
 *  * تعداد کوئری هر درخواست + RSS/heap قبل و بعد از خواندن‌های تکراری
 *  * صفحه‌بندی cursor (صفحهٔ اول/عمیق) و هزینهٔ offset
 *  * اثر rollup روزهای کامل
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('/home/user/bench/node_modules/pg');
const common = require('./common');

const BACKEND = '/home/user/ceDashbord/backend';
const { buildRuntimeRegistry } = require(BACKEND + '/services/db/schema-registry');
const builder = require(BACKEND + '/services/db/schema-v2-builder');
const { V2Writer } = require(BACKEND + '/services/db/ingest-v2');
const { V2Dialect } = require(BACKEND + '/services/db/dialect-v2');
const { SummaryService } = require(BACKEND + '/services/summary/summary.service');
const { buildDayRollup } = require(BACKEND + '/services/rollup/rollup.service');

const BANKS = (process.env.PGBANKS || 'tavan_mellat,tavan_resalat,tavan_postbank').split(',');
const TARGET = Number(process.env.TARGET_PER_BANK || 350000);
const SEED = Number(process.env.SEED_PER_BANK || 3000);
const DB = process.env.PGDATABASE || 'ce_p3';
const RANGE = ['1405-08-01', '1405-09-30'];
const DAYS = 30;
const TABLES = { tavan_mellat: 'samples_mellat', tavan_resalat: 'samples_resalat', tavan_postbank: 'samples_postbank' };

const cfg = (database) => ({ host: '127.0.0.1', port: Number(process.env.PGPORT || 5433), user: 'postgres', database });
const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const heap = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10; };
const med = (xs) => pct(xs, 0.5);

async function freshDb() {
  const admin = new Client(cfg('postgres'));
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  const client = new Client(cfg(DB));
  await client.connect();
  return client;
}

function adapter(client, counter) {
  const run = async (text, params = []) => {
    if (counter) counter.n += 1;
    const r = await client.query(text, params);
    return { rows: r.rows || [], rowCount: r.rowCount ?? (r.rows || []).length };
  };
  return {
    query: run,
    exec: (t) => client.query(t),
    getClient: async () => ({ query: run, release() {} }),
    close: () => client.end(),
  };
}

/** بزرگ‌نمایی داده با SQL: کپی ردیف‌ها با شناسهٔ تازه، تا رسیدن به هدف */
async function amplify(db, table, target) {
  let { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  let n = Number(rows[0].n);
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='${table}' AND column_name IN ('request_id') `,
  )).rows.length;
  void cols;
  while (n < target) {
    const before = n;
    await db.query(
      `INSERT INTO ${table} (${(await db.query(
        `SELECT string_agg(column_name, ',' ORDER BY ordinal_position) AS c
           FROM information_schema.columns
          WHERE table_name = '${table}' AND column_name NOT IN ('request_id','created_at')`,
      )).rows[0].c}, request_id)
       SELECT ${(await db.query(
        `SELECT string_agg(column_name, ',' ORDER BY ordinal_position) AS c
           FROM information_schema.columns
          WHERE table_name = '${table}' AND column_name NOT IN ('request_id','created_at')`,
      )).rows[0].c}, gen_random_uuid() FROM ${table} WHERE request_id IS NOT NULL`,
    );
    ({ rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`));
    n = Number(rows[0].n);
    if (n === before) break;
  }
  // حذف مازاد (کپی آخر بزرگ است)
  await db.query(
    `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} OFFSET ${target})`,
  );
  await db.query(`SELECT COUNT(*) FROM ${table}`);
  return target;
}

(async () => {
  const reuse = process.env.REUSE === '1';
  const client = reuse ? new Client(cfg(DB)) : await freshDb();
  if (reuse) await client.connect();
  const counter = { n: 0 };
  const db = adapter(client, counter);
  const ev = common.loadEvaluator();
  const bundle = buildRuntimeRegistry(ev);
  const { registry, banksSpecs } = bundle;
  if (!reuse) {
    await builder.applySchemaV2(db, { registry });
    await builder.seedRegistry(db, { registry, banksSpecs });
    await builder.seedListSpecs(db, { registry, banksSpecs });
  }
  const writer = new V2Writer(db, ev, { registry, banksSpecs });
  await writer.ready();
  const seedClient = await db.getClient();

  const rssStart = rss();
  const t0 = Date.now();
  if (!reuse) for (const bank of BANKS) {
    const rows = common.makeRows(ev, bank, common.readSamples()[bank], SEED, { days: DAYS });
    await writer.upsertBatch(seedClient, bank, rows);
  }
  const seedMs = Date.now() - t0;

  const ampStart = Date.now();
  if (!reuse) for (const bank of BANKS) await amplify(db, TABLES[bank], TARGET);
  const ampMs = Date.now() - ampStart;

  await db.query('ANALYZE');
  // همهٔ روزها «کامل» اعلام می‌شوند و rollup ساخته می‌شود (مسیر روزهای کامل)
  for (const bank of BANKS) {
    await db.query(
      `INSERT INTO day_runs(bank, day, mode, status, source_total, distinct_stored, ingested_count)
       SELECT $1, day, 'nightly', 'complete', COUNT(*), COUNT(DISTINCT request_id), COUNT(*)
         FROM ${TABLES[bank]} GROUP BY day
       ON CONFLICT (bank, day) DO UPDATE SET status='complete',
         source_total=EXCLUDED.source_total, distinct_stored=EXCLUDED.distinct_stored,
         ingested_count=EXCLUDED.ingested_count, updated_at=now()`,
      [bank],
    );
  }
  const rollupStart = Date.now();
  for (const bank of BANKS) {
    const days = (await db.query(`SELECT DISTINCT to_char(day,'YYYY-MM-DD') AS day FROM ${TABLES[bank]} ORDER BY day`)).rows.map((r) => r.day);
    for (const day of days) {
      await buildDayRollup(db, { bankKey: bank, day, evaluator: ev, registryBundle: bundle });
    }
  }
  const rollupMs = Date.now() - rollupStart;

  const counts = {};
  for (const bank of BANKS) {
    counts[bank] = Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${TABLES[bank]}`)).rows[0].n);
  }

  const dialect = new V2Dialect(db, { registry, listSpecs: {} });
  await dialect.ready();
  // کش با TTL عادی؛ برای «سرد» صریحاً clear می‌شود (ttlMs:0 کل کش را بی‌اثر می‌کرد)
  const service = new SummaryService(db, ev, { dialect });
  const dialectLegacy = new V2Dialect(db, { registry, listSpecs: {} });
  await dialectLegacy.ready();
  const legacy = new SummaryService(db, ev, { dialect: dialectLegacy });

  const bank = BANKS[0];
  const rssBeforeRead = rss();
  const heapBeforeRead = heap();

  // سرد (کش خالی) — هر بار کش دور زده می‌شود
  const coldTimes = [];
  const coldQueries = [];
  for (let i = 0; i < 5; i += 1) {
    service.cache.clear();
    counter.n = 0;
    const s = process.hrtime.bigint();
    await service.summary(bank, ...RANGE);
    coldTimes.push(Number(process.hrtime.bigint() - s) / 1e6);
    coldQueries.push(counter.n);
  }
  // گرم (کش)
  const warmTimes = [];
  for (let i = 0; i < 5; i += 1) {
    const s = process.hrtime.bigint();
    await service.summary(bank, ...RANGE);
    warmTimes.push(Number(process.hrtime.bigint() - s) / 1e6);
  }

  const rssAfterRead = rss();
  const heapAfterRead = heap();

  // مسیر قدیمی روی همان داده (پرهزینه) — یک‌بار
  const legacyStart = process.hrtime.bigint();
  const legacyOut = await legacy.legacySummary(bank, ...RANGE);
  const legacyMs = Number(process.hrtime.bigint() - legacyStart) / 1e6;

  // صفحه‌بندی
  const pageTimes = [];
  let cursor = null;
  let total = 0;
  let pages = 0;
  const seen = new Set();
  const pageStart = process.hrtime.bigint();
  for (;;) {
    const t = process.hrtime.bigint();
    const page = await service.list({ bank, from: RANGE[0], to: RANGE[1], type: 'all', limit: 100, cursor });
    pageTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
    total = page.total;
    pages += 1;
    page.rows.forEach((r) => seen.add(r.request_id));
    if (!page.nextCursor || pages >= 200) break;
    cursor = page.nextCursor;
  }
  const allPagesMs = Number(process.hrtime.bigint() - pageStart) / 1e6;

  const deepOffset = [];
  for (const off of [0, 50000, 250000]) {
    const t = process.hrtime.bigint();
    await service.list({ bank, from: RANGE[0], to: RANGE[1], type: 'all', limit: 100, offset: off });
    deepOffset.push({ offset: off, ms: Math.round(Number(process.hrtime.bigint() - t) / 1e6 * 10) / 10 });
  }

  const sizes = (await db.query(
    `SELECT p.relname, SUM(pg_total_relation_size(c.oid))::bigint AS total
       FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent
      WHERE p.relname = ANY($1::text[]) GROUP BY p.relname`,
    [Object.values(TABLES)],
  )).rows;

  const out = {
    engine: (await db.query('SHOW server_version')).rows[0].server_version,
    rowsPerBank: counts,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
    sizing: {
      seedSeconds: Math.round(seedMs / 1000),
      amplifySeconds: Math.round(ampMs / 1000),
      rollupSeconds: Math.round(rollupMs / 1000),
      tableMb: Object.fromEntries(sizes.map((s) => [s.relname, Math.round(Number(s.total) / 1024 / 1024)])),
    },
    summary: {
      bank,
      coldMs: { p50: med(coldTimes), p95: pct(coldTimes, 0.95), runs: coldTimes.map((x) => Math.round(x)) },
      warmMs: { p50: med(warmTimes), p95: pct(warmTimes, 0.95), runs: warmTimes.map((x) => Math.round(x)) },
      queriesPerRequest: coldQueries,
      legacyMs: Math.round(legacyMs),
      legacyTotal: legacyOut.stats.total,
      sqlTotal: (await service.summary(bank, ...RANGE)).stats.total,
    },
    pagination: {
      pages,
      total,
      uniqueSeen: seen.size,
      pageMs: { p50: med(pageTimes), p95: pct(pageTimes, 0.95), max: Math.round(Math.max(...pageTimes)) },
      allPagesSeconds: Math.round(allPagesMs / 1000),
      offsetCost: deepOffset,
    },
    memory: {
      rssMb: { start: rssStart, beforeRead: rssBeforeRead, afterRead: rssAfterRead },
      heapMb: { beforeRead: heapBeforeRead, afterRead: heapAfterRead },
    },
  };
  fs.writeFileSync(path.join('/home/user/bench', `pg-phase3-${out.totalRows}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await db.close();
})().catch((e) => { console.error('FAIL', e.message, e.stack?.split('\n').slice(0, 4).join('\n')); process.exit(1); });
