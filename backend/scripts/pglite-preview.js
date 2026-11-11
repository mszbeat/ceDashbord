#!/usr/bin/env node
/**
 * پیشنمایش زنده بدون PostgreSQL سرور: NestJS همان اپلیکیشن اصلی است،
 * فقط DatabaseService با PGlite (PostgreSQL در WASM) جایگزین میشود.
 * برای اجرا: npm install --no-save @electric-sql/pglite && node scripts/pglite-preview.js
 */
require('reflect-metadata');
process.env.CE_API_BASE_URL = process.env.CE_API_BASE_URL || 'http://127.0.0.1:3000/api/mock-report';
process.env.CE_GATEWAY_TOKEN = process.env.CE_GATEWAY_TOKEN || '';

const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');
const { DatabaseService } = require('../dist/db/database.service');
const { EvaluatorService } = require('../dist/evaluator/evaluator.service');

const ROOT = path.join(__dirname, '..', '..', '..');
const SAMPLES = {
  tavan_mellat: path.join(ROOT, 'ceDashbord', 'samples', 'mellat.json'),
  tavan_resalat: path.join(ROOT, 'ceDashbord', 'samples', 's.json'),
  tavan_postbank: path.join(ROOT, 'ceDashbord', 'samples', 'postbank.json'),
};
const TABLES = {
  tavan_mellat: 'samples_mellat',
  tavan_resalat: 'samples_resalat',
  tavan_postbank: 'samples_postbank',
};
const UPSERT_COLUMNS = [
  'request_id', 'day', 'inserted_at', 'stamp_key', 'unique_key', 'is_success', 'model_name', 'status_code',
  'error_code', 'message_key', 'total_time_s', 'pd', 'suggested_amount', 'amount_kind', 'score_req',
  'credit_basket', 'avg36', 'ln_avg_installments', 'rotbe', 'flags', 'cats', 'counters', 'metrics',
  'paths', 'services', 'credit_alerts', 'display_extras', 'analysis_version',
];
const JSON_COLUMNS = new Set(['flags', 'cats', 'counters', 'metrics', 'paths', 'services', 'credit_alerts', 'display_extras']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function seed(pg, evaluator) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  await pg.exec(schema);
  const rawByRequestId = new Map();
  const day = '1405-08-18';
  for (const [bankKey, table] of Object.entries(TABLES)) {
    const base = JSON.parse(fs.readFileSync(SAMPLES[bankKey], 'utf8'));
    const variants = [
      ['a', '14050818090000001', null],
      ['b', '14050818100000002', null],
      ['c', '14050818110000003', { statusCode: '500', message: { fa: 'شناسه یکتا تکراری است!', en: 'duplicate UniqueKey!' } }],
    ];
    const rows = [];
    for (const [suffix, stamp, override] of variants) {
      const raw = clone(base);
      raw.requestId = `${bankKey}-${suffix}`;
      if (raw.input && typeof raw.input === 'object') raw.input.uniqueKey = `${bankKey}-uk-${suffix}`;
      raw.insertDate_full = stamp;
      if (override?.message) raw.output.message = override.message;
      if (override?.statusCode) raw.output.statusCode = override.statusCode;
      const normalized = evaluator.normalizeSample(raw);
      const ok = evaluator.isReportSuccess(normalized);
      const row = evaluator.evaluate(normalized, ok, day, bankKey);
      rows.push(row);
      rawByRequestId.set(row.request_id, raw);
    }
    const values = [];
    const params = [];
    rows.forEach((row, index) => {
      const offset = index * UPSERT_COLUMNS.length;
      values.push(`(${UPSERT_COLUMNS.map((_, i) => `$${offset + i + 1}`).join(',')})`);
      for (const column of UPSERT_COLUMNS) {
        const value = row[column];
        params.push(JSON_COLUMNS.has(column) && value !== null && value !== undefined ? JSON.stringify(value) : value);
      }
    });
    await pg.query(`INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}
      ON CONFLICT (request_id) DO NOTHING`, params);
    await pg.query(`INSERT INTO day_runs(bank,day,mode,status,source_total,ingested_count,success_count,fail_count,
      skipped_count,checkpoint,analysis_version,started_at,finished_at)
      VALUES($1,$2,'nightly','complete',$3,$3,$4,$5,0,$3,$6,now(),now())
      ON CONFLICT(bank,day) DO UPDATE SET status='complete', source_total=EXCLUDED.source_total,
      ingested_count=EXCLUDED.ingested_count, success_count=EXCLUDED.success_count,
      fail_count=EXCLUDED.fail_count, checkpoint=EXCLUDED.checkpoint,
      analysis_version=EXCLUDED.analysis_version, finished_at=now(), updated_at=now()`,
      [bankKey, day, rows.length, rows.filter((r) => r.is_success).length,
       rows.filter((r) => !r.is_success).length, evaluator.versionOf(bankKey)]);
  }
  return rawByRequestId;
}

function dbWrapper(pg) {
  return {
    async query(text, params = []) {
      const result = await pg.query(text, params);
      return { rows: result.rows || [], rowCount: result.affectedRows ?? (result.rows || []).length };
    },
    async getClient() {
      return { query: this.query.bind(this), release() {} };
    },
    async onModuleDestroy() { await pg.close(); },
  };
}

(async () => {
  const pg = new PGlite();
  const evaluator = new EvaluatorService();
  const rawByRequestId = await seed(pg, evaluator);
  const wrapper = dbWrapper(pg);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService).useValue(wrapper)
    .compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableCors({ origin: true, credentials: false });
  const express = app.getHttpAdapter().getInstance();
  express.get('/api/mock-report', (req, res) => {
    const requestId = String(req.query.requestId || '');
    const raw = rawByRequestId.get(requestId) || rawByRequestId.values().next().value;
    res.set('Cache-Control', 'no-store');
    res.json({ data: { reportResults: [raw] } });
  });
  await app.listen(3000, '0.0.0.0');
  console.log('✅ PGlite live preview: http://0.0.0.0:3000/api/report?bank=tavan_resalat');
})().catch((error) => { console.error(error); process.exit(1); });
