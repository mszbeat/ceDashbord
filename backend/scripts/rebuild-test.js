#!/usr/bin/env node
/**
 * تست گزینهٔ --rebuild (بدون نیاز به PostgreSQL سرور، با PGlite):
 *   ۱) rebuild ردیفهای قدیمی/اضافی آن روز را پاک میکند و فقط اسنپشاپ جدید میماند
 *   ۲) بدون rebuild ردیفهای غایب باقی میمانند (همان رفتار قبلی UPSERT)
 *   ۳) خرابی API در حین rebuild تراکنش را برمیگرداند و دادههای قدیمی سالم میمانند
 *   ۴) پاسخ خالی API پیش از هر حذفی اجرا را لغو میکند
 */
'use strict';
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const { EvaluatorService } = require(path.join(ROOT, 'dist', 'evaluator', 'evaluator.service'));
const { IngestionService } = require(path.join(ROOT, 'dist', 'ingestion', 'ingestion.service'));
const DAY = '1405-08-19';
const base = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'ceDashbord', 'samples', 'mellat.json'), 'utf8'));

const COLS = [
  'request_id', 'day', 'inserted_at', 'stamp_key', 'unique_key', 'is_success', 'model_name', 'status_code',
  'error_code', 'message_key', 'total_time_s', 'pd', 'suggested_amount', 'amount_kind', 'score_req',
  'credit_basket', 'avg36', 'ln_avg_installments', 'rotbe', 'flags', 'cats', 'counters', 'metrics',
  'paths', 'services', 'credit_alerts', 'display_extras', 'analysis_version',
];
const JC = new Set(['flags', 'cats', 'counters', 'metrics', 'paths', 'services', 'credit_alerts', 'display_extras']);

function dbWrapper(pg) {
  return {
    async query(text, params = []) {
      const r = await pg.query(text, params);
      return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows || []).length };
    },
    async getClient() { return { query: this.query.bind(this), release() {} }; },
  };
}

function rawSample(id, amount) {
  const s = JSON.parse(JSON.stringify(base));
  s.requestId = id;
  s.input.uniqueKey = `uk-${id}`;
  s.insertDate_full = `14050819${String(9 + (id.length % 9)).padStart(2, '0')}0000001`;
  s.output.Credit_Basket = amount;
  s.output.PD = 0.3;
  s.output.total_time = 1.2;
  s.output.message = { fa: 'درخواست اعتبارسنجی با موفقیت انجام شد.', en: 'Validation was successful.' };
  return s;
}

async function seed(pg, ev) {
  // سه ردیف قدیمی: دو تاشان در اسنپشاپ جدید هستند، یکی منسوخ است.
  for (const [id, amount, version] of [
    ['old-A', 10_000_000, 'mellat-0.9.0'],
    ['old-B', 20_000_000, 'mellat-0.9.0'],
    ['stale-Z', 99_000_000, 'mellat-0.9.0'],
  ]) {
    const s = ev.normalizeSample(rawSample(id, amount));
    const row = ev.evaluate(s, true, DAY, 'tavan_mellat');
    row.analysis_version = version;
    const params = COLS.map((c) => JC.has(c) && row[c] != null ? JSON.stringify(row[c]) : row[c]);
    await pg.query(`INSERT INTO samples_mellat (${COLS.join(',')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(',')})`, params);
  }
  await pg.query(`INSERT INTO day_runs(bank,day,mode,status,analysis_version,started_at,finished_at)
    VALUES('tavan_mellat',$1,'nightly','complete','mellat-0.9.0',now(),now())`, [DAY]);
}

function service(pg, apiPages, total, failAtPage = 0) {
  const db = dbWrapper(pg);
  const svc = new IngestionService(db, new EvaluatorService());
  svc.sourceTotal = async () => total;
  svc.fetchPage = async (page) => {
    if (failAtPage && page >= failAtPage) throw new Error('API قطع شد (شبیهسازی)');
    return { count: total, reportResults: apiPages[page] || [] };
  };
  return svc;
}

const state = (pg) => pg.query(`SELECT request_id, analysis_version, suggested_amount::text AS suggested_amount FROM samples_mellat ORDER BY request_id`)
  .then((r) => r.rows);

(async () => {
  const problems = [];
  const check = (name, condition, detail) => {
    console.log(`${condition ? '✅' : '❌'} ${name}`, detail ?? '');
    if (!condition) problems.push(name);
  };

  // ۱) rebuild
  {
    const pg = new PGlite(); await pg.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
    const ev = new EvaluatorService(); await seed(pg, ev);
    const before = await state(pg);
    const svc = service(pg, { 1: [rawSample('old-A', 11_000_000), rawSample('old-B', 22_000_000)] }, 2);
    const result = await svc.runDay('tavan_mellat', DAY, 'nightly', { rebuild: true });
    const after = await state(pg);
    const run = (await pg.query(`SELECT status, analysis_version FROM day_runs WHERE bank='tavan_mellat' AND day=$1`, [DAY])).rows[0];
    check('rebuild: تعداد ردیفها ۳ → ۲', before.length === 3 && after.length === 2, JSON.stringify(after));
    check('rebuild: ردیف منسوخ stale-Z حذف شد', !after.some((r) => r.request_id === 'stale-Z'));
    check('rebuild: نسخهها همه جدید شدند', after.every((r) => r.analysis_version === ev.versionOf('tavan_mellat')));
    check('rebuild: deleted=3 و status=complete', result.deleted === 3 && result.status === 'complete' && run.status === 'complete');
    check('rebuild: مقادیر تازه جایگزین شدند', after.find((r) => r.request_id === 'old-A')?.suggested_amount === '11000000');
    await pg.close();
  }

  // ۲) بدون rebuild (رفتار قدیمی UPSERT)
  {
    const pg = new PGlite(); await pg.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
    await seed(pg, new EvaluatorService());
    const svc = service(pg, { 1: [rawSample('old-A', 11_000_000), rawSample('old-B', 22_000_000)] }, 2);
    const result = await svc.runDay('tavan_mellat', DAY, 'nightly');
    const after = await state(pg);
    check('بدون rebuild: ردیف منسوخ باقی میماند', after.length === 3 && after.some((r) => r.request_id === 'stale-Z'));
    check('بدون rebuild: rebuild=false و deleted=0', result.rebuild === false && result.deleted === 0);
    await pg.close();
  }

  // ۳) خرابی API در حین rebuild → ROLLBACK
  {
    const pg = new PGlite(); await pg.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
    await seed(pg, new EvaluatorService());
    const before = await state(pg);
    // ۶۰ رکورد یعنی ۲ صفحه؛ صفحهٔ دوم خراب میشود
    const pages = { 1: Array.from({ length: 50 }, (_, i) => rawSample(`p1-${i}`, 1_000_000 + i)) };
    const svc = service(pg, pages, 60, 2);
    let error = '';
    try { await svc.runDay('tavan_mellat', DAY, 'nightly', { rebuild: true }); } catch (e) { error = e.message; }
    const after = await state(pg);
    const run = (await pg.query(`SELECT status FROM day_runs WHERE bank='tavan_mellat' AND day=$1`, [DAY])).rows[0];
    check('ROLLBACK: خطا گزارش شد', error.includes('API قطع شد') && error.includes('دستنخورده'));
    check('ROLLBACK: سه ردیف قدیمی دقیقاً سالم ماندند', JSON.stringify(before) === JSON.stringify(after), `${after.length} ردیف`);
    check('ROLLBACK: day_runs همچنان complete قدیمی', run?.status === 'complete');
    await pg.close();
  }

  // ۴) API خالی → لغو پیش از حذف
  {
    const pg = new PGlite(); await pg.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
    await seed(pg, new EvaluatorService());
    const before = await state(pg);
    const svc = service(pg, {}, 0);
    let error = '';
    try { await svc.runDay('tavan_mellat', DAY, 'nightly', { rebuild: true }); } catch (e) { error = e.message; }
    const after = await state(pg);
    check('preflight: اجرا لغو شد', error.includes('لغو شد'));
    check('preflight: هیچ ردیفی حذف نشد', JSON.stringify(before) === JSON.stringify(after));
    await pg.close();
  }

  // ۵) محافظ CLI: rebuild بدون day
  {
    const pg = new PGlite(); await pg.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
    const svc = service(pg, { 1: [] }, 1);
    let error = '';
    try { await svc.runDay('tavan_mellat', undefined, 'nightly', { rebuild: true }); } catch (e) { error = e.message; }
    check('محافظ: rebuild بدون day رد میشود', error.includes('--day'));
    await pg.close();
  }

  console.log(JSON.stringify({ problems }));
  if (problems.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
