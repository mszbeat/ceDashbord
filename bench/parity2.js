'use strict';
/** parity ساده و صریح: همان ردیف‌ها را به v1 و v2 بریز و summary را با هم مقایسه کن */
const path = require('node:path');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const common = require('./common');
const { loadEvaluator, readSamples, makeRows, TABLES, UPSERT_COLUMNS, JSON_COLUMNS, dbAdapter } = common;
const JSON_COL_SET = new Set(['flags','cats','counters','metrics','paths','services','credit_alerts','display_extras']);
function uuidFor(i) { return `${String(i).padStart(8, '0')}-c392-4e34-aca3-4778cea7e8b9`; }
const BACKEND = process.env.CE_BACKEND || require('node:path').join(__dirname, '..', 'backend');
const { buildRegistry, KIND, columnName, flagMasks } = require(BACKEND + '/services/db/indicator-registry');
const builder = require(BACKEND + '/services/db/schema-v2-builder');
const { toV2Row, toDateIso } = require(BACKEND + '/services/db/row-mapper-v2');

process.env.CE_API_BASE_URL = process.env.CE_API_BASE_URL || 'http://127.0.0.1/unused';

const V2_BASE_COLS = ['day','request_id','ts','unique_key','is_success','model_code','status_code','error_code','message_code',
  'total_time_s','pd','suggested_amount','score_req','avg36','ln_avg_installments','rotbe_code','flags',
  'has_overdue','overdue_count','overdue_amount','has_cheque','cheque_count','cheque_amount','service_kinds','path_bits','cat_codes','analysis_version'];

async function insertV2(db, table, bankKey, rows, registry, messageCodes, catDict, v2index = 0) {
  const metricCols = registry.metric.map((id) => columnName(KIND.METRIC, id));
  const counterCols = registry.counter.map((id) => columnName(KIND.COUNTER, id));
  const allCols = [...V2_BASE_COLS, ...metricCols, ...counterCols];
  const ctx = {
    registry,
    flagMasks: flagMasks(registry),
    codes: {
      model: {}, status: {}, error: {},
      rotbe: { missing: 1, null: 2, emptyArray: 3, emptyObject: 4, allKeysNull: 5 },
      metricColumns: Object.fromEntries(registry.metric.map((id) => [id, columnName(KIND.METRIC, id)])),
      counterColumns: Object.fromEntries(registry.counter.map((id) => [id, columnName(KIND.COUNTER, id)])),
    },
    messageCodes,
    catDict: { codeOf: (catId, value) => catDict.codeOf(bankKey, catId, value) },
    registryBankKey: bankKey,
    analysisVersionCode: 1,
  };
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = []; const params = [];
    chunk.forEach((r, localIdx) => {
      const ri = localIdx;
      const { sampleRow } = toV2Row(r, { ...ctx, registry: { ...registry, __bank: bankKey } });
      sampleRow.day = toDateIso(r.day);
      sampleRow.request_id = uuidFor(i + localIdx + v2index);
      if (r.message_key && !sampleRow.message_code) {
        const known = messageCodes.get(r.message_key);
        if (known) sampleRow.message_code = known;
        else { const fake = 900 + messageCodes.size; messageCodes.set(r.message_key, fake); sampleRow.message_code = fake; }
      }
      values.push(`(${allCols.map((_, ci) => `$${ri * allCols.length + ci + 1}`).join(',')})`);
      for (const col of allCols) { const v = sampleRow[col]; params.push(v === undefined ? null : v); }
    });
    try {
      await db.query(`INSERT INTO ${table} (${allCols.join(',')}) VALUES ${values.join(',')} ON CONFLICT (day, request_id) DO NOTHING`, params);
    } catch (e) {
      console.error('insertV2 fail table=', table, 'cols=', allCols.length, 'params=', params.length);
      throw e;
    }
  }
}

async function insertV1(db, table, rows, v1index = 0) {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = []; const params = [];
    chunk.forEach((row0, ri) => {
      const row = { ...row0, request_id: uuidFor(i + ri + v1index) };
      values.push(`(${UPSERT_COLUMNS.map((_, ci) => `$${ri * UPSERT_COLUMNS.length + ci + 1}`).join(',')})`);
      for (const col of UPSERT_COLUMNS) {
        const v = row[col];
        params.push(JSON_COL_SET.has(col) && v != null ? JSON.stringify(v) : v);
      }
    });
    await db.query(`INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}`, params);
  }
}

(async () => {
  const perBank = Number(process.env.PER_BANK || 300);
  const ev = loadEvaluator();
  const samples = readSamples();
  const banksSpecs = {}; for (const k of ev.keys()) banksSpecs[k] = { ...ev.specs(k), selectedServices: ev.getSelectedServices(k) };
  const registry = buildRegistry(banksSpecs);
  const rowsByBank = {};
  for (const [bankKey, base] of Object.entries(samples)) rowsByBank[bankKey] = makeRows(ev, bankKey, base, perBank);

  // v1
  const v1db = new PGlite();
  await v1db.exec(fs.readFileSync(path.join(BACKEND, 'services/db/schema.sql'), 'utf8'));
  for (const [bankKey, rows] of Object.entries(rowsByBank)) {
    await insertV1(v1db, TABLES[bankKey], rows);
    await v1db.query(`INSERT INTO day_runs(bank, day, mode, status) SELECT $1::text, day, 'nightly', 'complete' FROM (SELECT DISTINCT day FROM ${TABLES[bankKey]}) d ON CONFLICT DO NOTHING`, [bankKey]);
  }

  console.error('[stage] v1 done');
  // v2
  const v2db = new PGlite();
  const adapter = { query: (s, p) => v2db.query(s, p), exec: (s) => v2db.exec(s) };
  await builder.applySchemaV2(adapter, { registry });
  await builder.seedRegistry(adapter, { registry, banksSpecs });
  console.error('[stage] v2 schema+seed done');
  const messageCodes = new Map();
  const catDict = builder.createCatDict(adapter);
  await catDict.load();
  for (const [bankKey, rows] of Object.entries(rowsByBank)) {
    await insertV2(v2db, TABLES[bankKey], bankKey, rows, registry[bankKey], messageCodes, catDict);
    for (const catId of registry[bankKey].cat) await catDict.flush(bankKey, catId, catId);
    console.error('flushed bank', bankKey, 'known keys:', catDict.debugSize ? catDict.debugSize() : 'n/a');
  }
  console.error('[stage] v2 inserts done');
  if (process.env.DBG) {
    const probe = await v2db.query('SELECT flags, service_kinds, path_bits, cat_codes FROM samples_mellat LIMIT 2');
    console.log('probe v2 rows:', JSON.stringify(probe.rows));
    console.log('registry service order:', JSON.stringify(registry.tavan_mellat.service));
    const cdRows = await v2db.query('SELECT bank, COUNT(*)::int AS n FROM cat_dict GROUP BY bank');
    console.log('cat_dict:', JSON.stringify(cdRows.rows));
  }
  await v2db.query('ANALYZE');

  // اندازه‌ها (v1)
  await v1db.query('ANALYZE');
  const sizesV1 = {};
  for (const table of Object.values(TABLES)) {
    const s1 = await v1db.query(`SELECT pg_total_relation_size('${table}') AS total, pg_relation_size('${table}') AS heap, pg_table_size('${table}') AS tsize, pg_indexes_size('${table}') AS idx, (SELECT COUNT(*)::int FROM ${table}) AS rows`);
    const a = s1.rows[0];
    sizesV1[table] = { rows: Number(a.rows), totalKB: Math.round(Number(a.total)/1024), heapKB: Math.round(Number(a.heap)/1024), toastKB: Math.round((Number(a.tsize)-Number(a.heap))/1024), idxKB: Math.round(Number(a.idx)/1024), perRow: Number(a.rows) ? Math.round(Number(a.total)/Number(a.rows)) : 0 };
  }
  // اندازه‌ها (v2)
  const sizes = {};
  for (const table of Object.values(TABLES)) {
    // جداول پارتیشن‌شده: اندازهٔ خود جدول والد صفر است؛ باید روی پارتیشن‌ها جمع زد
    const r = await v2db.query(`SELECT
        COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS total,
        COALESCE(SUM(pg_relation_size(c.oid)), 0) AS heap,
        COALESCE(SUM(pg_table_size(c.oid) - pg_relation_size(c.oid)), 0) AS toast,
        COALESCE(SUM(pg_indexes_size(c.oid)), 0) AS idx,
        (SELECT COUNT(*)::int FROM ${table}) AS rows,
        (SELECT COUNT(*)::int FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = '${table}') AS partitions
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p2 ON p2.oid = i.inhparent WHERE p2.relname = '${table}'`);
    const s = r.rows[0];
    sizes[table] = { rows: Number(s.rows), partitions: Number(s.partitions), totalKB: Math.round(Number(s.total)/1024), heapKB: Math.round(Number(s.heap)/1024), toastKB: Math.round(Number(s.toast)/1024), idxKB: Math.round(Number(s.idx)/1024), perRow: Number(s.rows) ? Math.round(Number(s.total)/Number(s.rows)) : 0 };
  }

  // parity روی bump (منطق اصلی تجمیع) با بازسازی result از ردیف v1 و v2
  const { newStats, bump } = require(path.join(BACKEND, 'services/evaluator/legacy/src/analyze'));
  const { fromV1RowForBump } = require('./parity-lib');
  const fromV2RowForBumpV2 = (row, reg) => {
    const lib = require('./parity-lib');
    const categories = row.cat_values || {};
    const base = lib.fromV2RowForBump(row, reg);
    base.categories = categories;
    return base;
  };
  const parity = {};
  for (const bankKey of Object.keys(samples)) {
    const table = TABLES[bankKey];
    const bank = ev.getBank(bankKey);
    const selectedServices = ev.getSelectedServices(bankKey).slice();
    const stats = { v1: newStats(), v2: newStats() };
    const rowsV1 = (await v1db.query(`SELECT * FROM ${table}`)).rows;
    const rowsV2 = (await v2db.query(`SELECT * FROM ${table}`)).rows;
    const reg = registry[bankKey];
    const catLookup = new Map();
    for (const r of (await v2db.query('SELECT cat_code, value_code, value FROM cat_dict WHERE bank=$1', [bankKey])).rows) {
      catLookup.set(`${r.cat_code}:${r.value_code}`, r.value);
    }
    for (const row of rowsV1) bump(stats.v1, bank, fromV1RowForBump(row), row.is_success ? 'success' : 'fail', selectedServices, false);
    for (const row of rowsV2) {
      // مقدار هر کد cat را از دیکشنری درجا می‌خوانیم (منبع حقیقت: cat_dict)
      const catValues = {};
      (row.cat_codes || []).forEach((code, index) => {
        const id = reg.cat[index];
        if (!id || !code) return;
        const found = catLookup.get(`${index + 1}:${code}`);
        catValues[id] = found === undefined ? String(code) : found;
      });
      const v2Row = { ...row, cat_values: catValues };
      bump(stats.v2, bank, fromV2RowForBumpV2(v2Row, reg), row.is_success ? 'success' : 'fail', selectedServices, false);
    }
    const diffs = [];
    // مقایسهٔ مستقل از ترتیب کلیدها (ترتیب رجیستری، نه محتوا)
    const stable = (v) => JSON.stringify(v, (k, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.fromEntries(Object.keys(val).sort().map((key) => [key, val[key]]));
      }
      return val;
    });
    const cmp = (a, b, label) => { if (stable(a) !== stable(b)) diffs.push(label); };
    cmp(stats.v1.total, stats.v2.total, 'total');
    cmp(stats.v1.cross, stats.v2.cross, 'cross');
    cmp(stats.v1.catAlerts, stats.v2.catAlerts, 'catAlerts');
    cmp(stats.v1.byStatus, stats.v2.byStatus, 'byStatus');
    cmp(stats.v1.flags, stats.v2.flags, 'flags');
    cmp(stats.v1.counters, stats.v2.counters, 'counters');
    cmp(stats.v1.cats, stats.v2.cats, 'cats');
    cmp(stats.v1.catTotals, stats.v2.catTotals, 'catTotals');
    cmp(stats.v1.catSplit, stats.v2.catSplit, 'catSplit');
    cmp(stats.v1.services, stats.v2.services, 'services');
    cmp(stats.v1.paths, stats.v2.paths, 'paths');
    cmp(Object.keys(stats.v1.metrics).sort(), Object.keys(stats.v2.metrics).sort(), 'metricKeys');
    const metricDiff = [];
    for (const id of Object.keys(stats.v1.metrics)) {
      const a = [...stats.v1.metrics[id]].sort((x, y) => x - y).join(',');
      const b = [...(stats.v2.metrics[id] || [])].sort((x, y) => x - y).join(',');
      if (a !== b) metricDiff.push(id);
    }
    if (process.env.DBG) {
      console.log('---', bankKey);
      for (const [label, a, b] of [['flags', stats.v1.flags, stats.v2.flags], ['cats', stats.v1.cats, stats.v2.cats],
        ['catTotals', stats.v1.catTotals, stats.v2.catTotals], ['services', stats.v1.services, stats.v2.services]]) {
        if (stable(a) === stable(b)) continue;
        console.log(`DIFF ${label}:`);
        for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
          if (stable(a?.[k]) !== stable(b?.[k])) console.log(' ', k, '| v1:', JSON.stringify(a?.[k])?.slice(0, 120), '| v2:', JSON.stringify(b?.[k])?.slice(0, 120));
        }
      }
    }
    parity[bankKey] = { diffs, metricDiff, totals: { v1: stats.v1.total, v2: stats.v2.total } };
  }

  console.log(JSON.stringify({ sizesV1, sizes, parity }, null, 2));
  require('fs').writeFileSync('parity-v2.json', JSON.stringify({ sizesV1, sizes, parity, perBank }, null, 2));
})().catch(e => { console.error('ERR', e.message, e.stack?.split('\n').slice(0,5).join('\n')); process.exit(1); });
