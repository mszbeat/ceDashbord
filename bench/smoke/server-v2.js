'use strict';
const BACKEND = process.env.CE_BACKEND || require('node:path').join(__dirname, '..', '..', 'backend');
/**
 * سرور دود: همان کنترلر/روتر واقعی روی PGlite با CE_DB_SCHEMA=v2.
 * هدف: اثبات اینکه مسیر HTTP (auth → validate → controller → SummaryService → V2Dialect)
 * برای /api/summary و /api/list کار می‌کند — نه فقط فراخوانی مستقیم سرویس.
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const common = require(require('node:path').join(__dirname, '..', 'common.js'));
const { loadEvaluator, readSamples, makeRows, TABLES, UPSERT_COLUMNS } = common;
const { buildRuntimeRegistry } = require(BACKEND + '/services/db/schema-registry');
const builder = require(BACKEND + '/services/db/schema-v2-builder');
const { V2Writer } = require(BACKEND + '/services/db/ingest-v2');
const { V2Dialect } = require(BACKEND + '/services/db/dialect-v2');
const { SummaryService } = require(BACKEND + '/services/summary/summary.service');

const JSON_COLS = new Set(['flags','cats','counters','metrics','paths','services','credit_alerts','display_extras']);

(async () => {
  const ev = loadEvaluator();
  const { registry, banksSpecs } = buildRuntimeRegistry(ev);
  const db = new PGlite();
  const adapter = { query: (s, p) => db.query(s, p), exec: (s) => db.exec(s) };

  const mode = process.env.SMOKE_MODE || 'v2';
  if (mode === 'v2') {
    await builder.applySchemaV2(adapter, { registry });
    await builder.seedRegistry(adapter, { registry, banksSpecs });
    await builder.seedListSpecs(adapter, { banksSpecs });
    const writer = new V2Writer(adapter, ev, { registry, banksSpecs });
    for (const [bankKey, base] of Object.entries(readSamples())) {
      const rows = makeRows(ev, bankKey, base, Number(process.env.PER_BANK || 120))
        .map((r) => { if (r.display_extras?.base) r.display_extras.base['وضعیت'] = r.is_success ? 'موفق' : 'ناموفق'; return r; });
      await writer.upsertBatch(adapter, bankKey, rows);
      await db.query(`INSERT INTO day_runs(bank, day, status) SELECT $1::text, day::date, 'complete' FROM (SELECT DISTINCT day FROM ${TABLES[bankKey]}) d ON CONFLICT DO NOTHING`, [bankKey]);
    }
  } else {
    await db.exec(fs.readFileSync(path.join(BACKEND + '/services/db/schema.sql'), 'utf8'));
    for (const [bankKey, base] of Object.entries(readSamples())) {
      const rows = makeRows(ev, bankKey, base, Number(process.env.PER_BANK || 120))
        .map((r) => { if (r.display_extras?.base) r.display_extras.base['وضعیت'] = r.is_success ? 'موفق' : 'ناموفق'; return r; });
      const table = TABLES[bankKey];
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200); const values = []; const params = [];
        chunk.forEach((row, ri) => {
          values.push(`(${UPSERT_COLUMNS.map((_, c) => `$${ri * UPSERT_COLUMNS.length + c + 1}`).join(',')})`);
          for (const col of UPSERT_COLUMNS) { const v = row[col]; params.push(JSON_COLS.has(col) && v != null ? JSON.stringify(v) : v); }
        });
        await db.query(`INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')} ON CONFLICT (day, request_id) DO UPDATE SET updated_at=now()`, params);
      }
      await db.query(`INSERT INTO day_runs(bank, day, mode, status, updated_at) SELECT $1::text, day, 'nightly','complete', now() FROM (SELECT DISTINCT day FROM ${table}) d ON CONFLICT DO NOTHING`, [bankKey]);
    }
  }
  await db.query('ANALYZE');

  let summaryService;
  if (mode === 'v2') {
    const listSpecs = {};
    for (const bankKey of Object.keys(registry)) listSpecs[bankKey] = (ev.getBank(bankKey).lists || []).map((l) => l.title);
    const dialect = new V2Dialect(adapter, { registry, listSpecs });
    await dialect.ready();
    summaryService = new SummaryService(adapter, ev, { dialect });
  } else {
    summaryService = new SummaryService(common.dbAdapter(db), ev);
  }

  // ماژول‌های فریم‌ورک (@partFramework/*) این‌جا نصب نیستند، پس کنترلر واقعی بارگذاری نمی‌شود.
  // آزمون HTTP این‌جا «قرارداد پاسخ» را می‌سنجد (سرویس واقعی → JSON)، و تطابق هندلرها را
  // `tests/controllers.behavior.test.js`/`routing.contract.test.js` پوشش می‌دهند.

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === '/api/summary') {
        const body = await summaryService.summary(url.searchParams.get('bank') || 'tavan_mellat',
          url.searchParams.get('from'), url.searchParams.get('to'));
        delete body.generatedAt;
        return send(200, body);
      }
      if (url.pathname === '/api/list') {
        const params = Object.fromEntries(url.searchParams.entries());
        return send(200, await summaryService.list(params));
      }
      if (url.pathname === '/api/banks') return send(200, summaryService.banks());
      return send(404, { error: 'not found' });
    } catch (error) {
      return send(500, { error: error.message });
    }
  });
  server.listen(Number(process.env.PORT || 4571), '127.0.0.1', () => {
    console.log(`smoke server (${mode}) on ${process.env.PORT || 4571}`);
  });
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
