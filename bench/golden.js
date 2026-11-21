'use strict';
/**
 * اسنپ‌شات طلایی: خروجی واقعی SummaryService روی v1 در برابر V2Reader/V2Writer روی v2.
 * پوشش: summary(bank, from, to) برای هر سه بانک + list (flag/cat/metric/service/slow/creditAlert/all)
 *        + report (HTML) + buildDashboard.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const common = require('./common');
const { loadEvaluator, readSamples, makeRows, TABLES, UPSERT_COLUMNS, dbAdapter } = common;
const BACKEND = process.env.CE_BACKEND || require('node:path').join(__dirname, '..', 'backend');
const { buildRegistry } = require(BACKEND + '/services/db/indicator-registry');
const builder = require(BACKEND + '/services/db/schema-v2-builder');
const { V2Writer } = require(BACKEND + '/services/db/ingest-v2');
const { V2Dialect } = require(BACKEND + '/services/db/dialect-v2');
const { SummaryService } = require(BACKEND + '/services/summary/summary.service');

const JSON_COL_SET = new Set(['flags','cats','counters','metrics','paths','services','credit_alerts','display_extras']);
const perBank = Number(process.env.PER_BANK || 400);

const stable = (value) => JSON.stringify(value, (k, v) => (
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]]))
    : v));

function hash(value) { return crypto.createHash('sha1').update(stable(value)).digest('hex').slice(0, 16); }

function diff(a, b, label, out = [], depth = 0) {
  if (out.length > 40) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-9) out.push(`${label}: ${a} != ${b}`);
    return out;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const norm = (s) => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>');
    if (norm(a) !== norm(b)) out.push(`${label}: ${a.slice(0, 80)} != ${b.slice(0, 80)}`);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) diff(a[key], b[key], `${label}.${key}`, out, depth + 1);
    return out;
  }
  if (stable(a) !== stable(b)) out.push(`${label}: ${stable(a)?.slice(0, 80)} != ${stable(b)?.slice(0, 80)}`);
  return out;
}

(async () => {
  const ev = loadEvaluator();
  const samples = readSamples();
  const banksSpecs = {};
  for (const k of ev.keys()) banksSpecs[k] = { ...ev.specs(k), selectedServices: ev.getSelectedServices(k) };
  const registry = buildRegistry(banksSpecs);

  // ── v1 ──
  const v1db = new PGlite();
  await v1db.exec(fs.readFileSync(path.join(BACKEND, 'services/db/schema.sql'), 'utf8'));
  const rowsByBank = {};
  for (const [bankKey, base] of Object.entries(samples)) {
    // شناسه‌ها عمداً غیر-UUID می‌مانند تا مسیر uuid5 + external_id هم آزموده شود
    const rows = makeRows(ev, bankKey, base, perBank).map((row) => {
      // makeRows بعد از evaluate وضعیت را عوض می‌کند؛ base ذخیره‌شده باید همان را نشان دهد
      if (row.display_extras?.base) {
        row.display_extras.base['وضعیت'] = row.is_success ? 'موفق' : 'ناموفق';
      }
      return row;
    });
    const table = TABLES[bankKey];
    // request_id واقعی یکتاست؛ برای اینکه هر سه بانک در یک دیتابیس ناسازگاری نداشته باشند، دست نمی‌زنیم
    rowsByBank[bankKey] = rows;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const values = []; const params = [];
      chunk.forEach((row, ri) => {
        values.push(`(${UPSERT_COLUMNS.map((_, c) => `$${ri * UPSERT_COLUMNS.length + c + 1}`).join(',')})`);
        for (const col of UPSERT_COLUMNS) {
          const v = row[col];
          params.push(JSON_COL_SET.has(col) && v != null ? JSON.stringify(v) : v);
        }
      });
      await v1db.query(`INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')} ON CONFLICT (day, request_id) DO UPDATE SET updated_at=now()`, params);
    }
    await v1db.query(`INSERT INTO day_runs(bank, day, mode, status, updated_at)
      SELECT $1::text, day, 'nightly', 'complete', now() FROM (SELECT DISTINCT day FROM ${table}) d ON CONFLICT DO NOTHING`, [bankKey]);
  }
  await v1db.query('ANALYZE');
  const summaryV1 = new SummaryService(dbAdapter(v1db), ev);

  // ── v2 ──
  const v2db = new PGlite();
  const adapter = { query: (s, p) => v2db.query(s, p), exec: (s) => v2db.exec(s) };
  await builder.applySchemaV2(adapter, { registry });
  await builder.seedRegistry(adapter, { registry, banksSpecs });
  await builder.seedListSpecs(adapter, { banksSpecs });
  const writer = new V2Writer(adapter, ev, { registry, banksSpecs, analysisVersions: { tavan_mellat: 1, tavan_resalat: 1, tavan_postbank: 1 } });
  for (const [bankKey, rows] of Object.entries(rowsByBank)) {
    await writer.upsertBatch(adapter, bankKey, rows);
    await v2db.query(`INSERT INTO day_runs(bank, day, mode, status, updated_at)
      SELECT $1::text, day, 'nightly', 'complete', now() FROM (SELECT DISTINCT day FROM ${TABLES[bankKey]}) d ON CONFLICT DO NOTHING`, [bankKey]);
  }
  await v2db.query('ANALYZE');

  const listSpecs = {};
  for (const bankKey of Object.keys(banksSpecs)) listSpecs[bankKey] = (ev.getBank(bankKey).lists || []).map((l) => l.title);
  const dialectV2 = new V2Dialect(adapter, { registry, listSpecs });
  await dialectV2.ready();
  const summaryV2 = new SummaryService(adapter, ev, { dialect: dialectV2 });

  const report = { perBank, banks: {}, v2Sizes: {} };
  const range = { from: '1405-08-01', to: '1405-09-30' };

  for (const bankKey of Object.keys(samples)) {
    const entry = { summary: {}, list: {}, dashboard: {}, report: {} };
    // summary
    const a = await summaryV1.summary(bankKey, range.from, range.to);
    const b = await summaryV2.summary(bankKey, range.from, range.to);
    entry.summary = { diffs: diff(a, b, 'summary').slice(0, 20), hashV1: hash(a), hashV2: hash(b), equal: hash(a) === hash(b) };

    // list: هر نوع فیلتر
    const flagId = registry[bankKey].flag[0];
    const catId = registry[bankKey].cat[0];
    const metricId = registry[bankKey].metric[0];
    const serviceId = registry[bankKey].service[0];
    const queries = [
      { type: 'all' }, { type: 'slow' }, { type: 'creditAlert' },
      { type: 'flag', id: flagId }, { type: 'cat', id: catId, value: null },
      { type: 'metric', id: metricId }, { type: 'service', id: serviceId },
      { type: 'flag', id: flagId, status: 'success' },
      { type: 'all', limit: 5, offset: 3 },
    ];
    for (const q of queries) {
      const params = { bank: bankKey, from: range.from, to: range.to, ...q };
      let av; let bv; let errA = null; let errB = null;
      try { av = await summaryV1.list(params); } catch (e) { errA = e.message; }
      try { bv = await summaryV2.list(params); } catch (e) { errB = e.message; }
      const label = `${q.type}:${q.id || ''}${q.status ? ':' + q.status : ''}${q.value !== undefined ? ':' + q.value : ''}${q.limit ? ':p' + q.limit + '-' + q.offset : ''}`;
      if (errA || errB) { entry.list[label] = { errA, errB }; continue; }
      const cleaned = (v) => ({ ...v, rows: v.rows.map(({ total_count, ...rest }) => rest) });
      entry.list[label] = { total: av.total, hashV1: hash(cleaned(av)), hashV2: hash(cleaned(bv)), diffs: diff(cleaned(av), cleaned(bv), label).slice(0, 8) };
    }

    // dashboard (کشف سرویس‌ها + شمارش)
    const d1 = await summaryV1.buildDashboard(bankKey, range.from, range.to, 20);
    const d2 = await summaryV2.buildDashboard(bankKey, range.from, range.to, 20);
    entry.dashboard = { diffs: diff(d1, d2, 'dash').slice(0, 20), equal: hash(d1) === hash(d2) };

    // report HTML
    const r1 = await summaryV1.report(bankKey, range.from, range.to, 20);
    const r2 = await summaryV2.report(bankKey, range.from, range.to, 20);
    const html1 = typeof r1 === 'string' ? r1 : JSON.stringify(r1);
    const html2 = typeof r2 === 'string' ? r2 : JSON.stringify(r2);
    const norm = (s) => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>');
    entry.report = { lenV1: html1.length, lenV2: html2.length, equalNormalized: norm(html1) === norm(html2) };
    if (!entry.report.equalNormalized) {
      // یک‌بار نرمال‌سازی و یک‌بار اسکن (نه در هر کاراکتر)
      const n1 = norm(html1);
      const n2 = norm(html2);
      let i = 0;
      const limit = Math.min(n1.length, n2.length);
      while (i < limit && n1.charCodeAt(i) === n2.charCodeAt(i)) i++;
      entry.report.firstDiff = { at: i, v1: n1.slice(Math.max(0, i - 120), i + 200), v2: n2.slice(Math.max(0, i - 120), i + 200) };
    }

    report.banks[bankKey] = entry;
  }

  report.v2Sizes = (await v2db.query(`SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 2 DESC`)).rows
    .reduce((acc, r) => { acc[r.name] = Math.round(Number(r.bytes)/1024) + ' KB'; return acc; }, {});

  fs.writeFileSync('golden-report.json', JSON.stringify(report, null, 2));
  // خلاصهٔ خوانا
  for (const [bankKey, entry] of Object.entries(report.banks)) {
    const listFails = Object.entries(entry.list).filter(([, v]) => v.diffs?.length || v.errA || v.errB);
    console.log(`\n## ${bankKey}`);
    console.log(' summary equal:', entry.summary.equal, '| diffs:', entry.summary.diffs.slice(0, 3));
    console.log(' dashboard equal:', entry.dashboard.equal, '| diffs:', entry.dashboard.diffs.slice(0, 3));
    console.log(' report equal:', entry.report.equalNormalized, entry.report.firstDiff ? JSON.stringify(entry.report.firstDiff).slice(0, 300) : '');
    console.log(' list:', listFails.length ? JSON.stringify(listFails.map(([k, v]) => [k, v.errB || v.diffs?.slice(0, 2)])).slice(0, 800) : 'all equal');
  }
})().catch((e) => { console.error('ERR', e.message, e.stack?.split('\n').slice(0, 6).join('\n')); process.exit(1); });
