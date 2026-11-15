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

const REPO_ROOT = path.join(__dirname, '..', '..');
const SAMPLES = {
  tavan_mellat: path.join(REPO_ROOT, 'samples', 'mellat.json'),
  tavan_resalat: path.join(REPO_ROOT, 'samples', 's.json'),
  tavan_postbank: path.join(REPO_ROOT, 'samples', 'postbank.json'),
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

const BASE_SAMPLES = {
  tavan_mellat: JSON.parse(fs.readFileSync(SAMPLES.tavan_mellat, 'utf8')),
  tavan_resalat: JSON.parse(fs.readFileSync(SAMPLES.tavan_resalat, 'utf8')),
  tavan_postbank: JSON.parse(fs.readFileSync(SAMPLES.tavan_postbank, 'utf8')),
};

function buildMockDatasetForDay(dayDigits, rawByRequestId) {
  const cleanDigits = String(dayDigits || '14050818').replace(/\D/g, '').slice(0, 8) || '14050818';
  const all = [];
  for (const [bankKey, base] of Object.entries(BASE_SAMPLES)) {
    const variants = [
      ['a', `${cleanDigits}090000001`, '0012345678', null],
      ['b', `${cleanDigits}100000002`, '0012345679', null],
      ['c', `${cleanDigits}110000003`, '0099887766', { statusCode: '500', message: { fa: 'شناسه یکتا تکراری است!', en: 'duplicate UniqueKey!' } }],
    ];
    for (const [suffix, stamp, natCode, override] of variants) {
      const raw = clone(base);
      raw.requestId = `${bankKey}-${cleanDigits}-${suffix}`;
      if (raw.input && typeof raw.input === 'object') {
        raw.input.uniqueKey = `${bankKey}-uk-${cleanDigits}-${suffix}`;
        raw.input.nationalCode = natCode;
      }
      raw.insertDate_full = stamp;
      raw.insertDate_yearMonthDay = cleanDigits;
      if (override?.message) raw.output.message = override.message;
      if (override?.statusCode) raw.output.statusCode = override.statusCode;
      rawByRequestId.set(raw.requestId, raw);
      all.push(raw);
    }
  }
  return all;
}

async function seed(pg, evaluator) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  await pg.exec(schema);
  const rawByRequestId = new Map();
  const day = '1405-08-18';
  for (const [bankKey, table] of Object.entries(TABLES)) {
    const base = BASE_SAMPLES[bankKey];
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
      raw.insertDate_yearMonthDay = '14050818';
      if (override?.message) raw.output.message = override.message;
      if (override?.statusCode) raw.output.statusCode = override.statusCode;
      const normalized = evaluator.normalizeSample(raw);
      const ok = evaluator.isReportSuccess(normalized);
      const row = evaluator.evaluate(normalized, ok, day, bankKey);
      rows.push(row);
      rawByRequestId.set(row.requestId, raw);
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
      ON CONFLICT (day, request_id) DO NOTHING`, params);
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
    const requestId = String(req.query.requestId || '').trim();
    const uniqueKey = String(req.query.uniqueKey || '').trim();
    const nationalCode = String(req.query.nationalCode || '').trim();
    const status = String(req.query.status || '').trim();
    const dateParam = String(req.query.date || '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Number(req.query.limit || 50));

    // حالت نمونهٔ تکی برای دکمهٔ مشاهده جزئیات خام در داشبورد
    if (requestId && rawByRequestId.has(requestId) && !dateParam && !req.query.page) {
      res.set('Cache-Control', 'no-store');
      return res.json({ data: { count: 1, reportResults: [rawByRequestId.get(requestId)] } });
    }

    let pool = dateParam
      ? buildMockDatasetForDay(dateParam, rawByRequestId)
      : [
          ...buildMockDatasetForDay('14050818', rawByRequestId),
          ...buildMockDatasetForDay('14050822', rawByRequestId),
        ];

    if (requestId) pool = pool.filter((r) => String(r.requestId || '') === requestId);
    if (uniqueKey) pool = pool.filter((r) => String(r.input?.uniqueKey || '') === uniqueKey);
    if (nationalCode) pool = pool.filter((r) => String(r.input?.nationalCode || '') === nationalCode);
    if (status) pool = pool.filter((r) => String(r.output?.statusCode || '') === status);

    const start = (page - 1) * limit;
    const slice = pool.slice(start, start + limit);
    res.set('Cache-Control', 'no-store');
    return res.json({ data: { count: pool.length, reportResults: slice } });
  });
  await app.listen(3000, '0.0.0.0');
  console.log('✅ PGlite live preview: http://0.0.0.0:3000/api/report?bank=tavan_resalat');
})().catch((error) => { console.error(error); process.exit(1); });
