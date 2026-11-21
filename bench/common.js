'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const BACKEND = process.env.CE_BACKEND || path.join(__dirname, '..', 'backend');
const SAMPLES = process.env.CE_SAMPLES || path.join(__dirname, '..', '..', 'ref', 'samples');
process.env.CE_API_BASE_URL = process.env.CE_API_BASE_URL || 'http://127.0.0.1/unused';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';

const TABLES = { tavan_mellat: 'samples_mellat', tavan_resalat: 'samples_resalat', tavan_postbank: 'samples_postbank' };

const UPSERT_COLUMNS = [
  'request_id','day','inserted_at','stamp_key','unique_key','is_success','model_name','status_code','error_code','message_key',
  'total_time_s','pd','suggested_amount','amount_kind','score_req','credit_basket','avg36',
  'ln_avg_installments','rotbe','flags','cats','counters','metrics','paths','services',
  'credit_alerts','display_extras','analysis_version',
];
const JSON_COLUMNS = new Set(['flags','cats','counters','metrics','paths','services','credit_alerts','display_extras']);

function makeRows(ev, bankKey, base, count, { days = 30, startDay = 1 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const sample = JSON.parse(JSON.stringify(base));
    const dayIdx = i % days;
    const dd = String(((startDay - 1 + dayIdx) % 28) + 1).padStart(2, '0');
    const mm = dayIdx + startDay > 28 ? '09' : '08';
    sample.requestId = `${bankKey.slice(6, 8)}${String(i).padStart(6, '0')}-c392-4e34-aca3-4778cea7e8b9`;
    sample.insertDate_yearMonthDay = `1405${mm}${dd}`;
    sample.insertDate_full = `1405${mm}${dd}${String(i % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}${String(i % 60).padStart(2, '0')}000`;
    if (sample.input) sample.input.uniqueKey = `uk-${i}`;
    const norm = ev.normalizeSample(sample, { fromApi: true });
    const day = `1405-${mm}-${dd}`;
    const row = ev.evaluate(norm, ev.isReportSuccess(norm), day, bankKey);
    // تنوع محسوس: pd/is_success متفاوت برای اینکه آمار واقعی‌تر شود
    if (i % 7 === 0) { row.pd = 0.5; row.is_success = false; }
    if (i % 11 === 0) { row.total_time_s = 5 + (i % 13); }
    rows.push(row);
  }
  return rows;
}

async function bulkInsert(db, table, rows, chunkSize = 200) {
  const updates = UPSERT_COLUMNS.filter((c) => c !== 'request_id' && c !== 'day')
    .map((c) => `${c}=EXCLUDED.${c}`).concat('updated_at=now()').join(', ');
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values = []; const params = [];
    chunk.forEach((row, rIdx) => {
      const offset = rIdx * UPSERT_COLUMNS.length;
      values.push(`(${UPSERT_COLUMNS.map((_, c) => `$${offset + c + 1}`).join(',')})`);
      for (const col of UPSERT_COLUMNS) {
        const v = row[col];
        params.push(JSON_COLUMNS.has(col) && v != null ? JSON.stringify(v) : v);
      }
    });
    await db.query(
      `INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (day, request_id) DO UPDATE SET ${updates}`, params);
  }
}

/** آداپتور db برای سرویس‌های واقعی که با pool کار می‌کنند */
function dbAdapter(pg) {
  let queue = Promise.resolve();
  const run = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  return {
    query(text, params = []) { return run(async () => { const r = await pg.query(text, params); const rows = r.rows || []; return { rows, rowCount: /^\s*select/i.test(text) ? rows.length : (r.affectedRows ?? rows.length) }; }); },
    async getClient() {
      let release; const prev = queue;
      queue = new Promise((res) => { release = res; });
      await prev;
      return {
        async query(text, params = []) { const r = await pg.query(text, params); return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows || []).length }; },
        release() { release(); },
      };
    },
    async close() { await pg.close(); },
  };
}

function loadEvaluator() {
  const { EvaluatorService } = require(path.join(BACKEND, 'services/evaluator/evaluator.service'));
  return new EvaluatorService();
}

function readSamples() {
  return {
    tavan_mellat: JSON.parse(fs.readFileSync(path.join(SAMPLES, 'mellat.json'), 'utf8')),
    tavan_resalat: JSON.parse(fs.readFileSync(path.join(SAMPLES, 's.json'), 'utf8')),
    tavan_postbank: JSON.parse(fs.readFileSync(path.join(SAMPLES, 'postbank.json'), 'utf8')),
  };
}

async function buildV1(perBank) {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(BACKEND, 'services/db/schema.sql'), 'utf8'));
  const ev = loadEvaluator();
  const samples = readSamples();
  const rowsByBank = {};
  for (const [bankKey, base] of Object.entries(samples)) {
    const rows = makeRows(ev, bankKey, base, perBank);
    rowsByBank[bankKey] = rows;
    await bulkInsert(db, TABLES[bankKey], rows);
    await db.query(`INSERT INTO day_runs(bank, day, mode, status, updated_at) SELECT $1, day, 'nightly', 'complete', now() FROM (SELECT DISTINCT day FROM ${TABLES[bankKey]}) d`, [bankKey]);
  }
  await db.query('ANALYZE');
  return { db, ev, rowsByBank };
}

module.exports = { buildV1, makeRows, bulkInsert, dbAdapter, loadEvaluator, readSamples, TABLES, UPSERT_COLUMNS, PGlite, BACKEND, SAMPLES };
