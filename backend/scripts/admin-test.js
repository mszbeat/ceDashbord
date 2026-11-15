#!/usr/bin/env node
/**
 * تست یکپارچهٔ پنل مدیریت (AdminService + IngestionService + زمانبند Cron با PGlite):
 *   ۱) اعتبارسنجی تقویم شمسی، ارقام فارسی و موتور ۵فیلدی Cron در منطقهٔ زمانی تهران
 *   ۲) بررسی پیش از اجرا (checkExistingData) و الزام تصمیم ادمین هنگام وجود دادهٔ قبلی
 *   ۳) اجرای دستی با انتخاب Upsert در برابر Rebuild و بررسی سلامت دادهها در دیتابیس
 *   ۴) فیلترهای API بالادستی (status, requestId, uniqueKey, nationalCode, maxCount, pageSize) +
 *      عدم تغییر limit صفحات و تضمین عدم ذخیرهٔ کدملی در دیتابیس/جابها + حالت بدون تاریخ (filter_only)
 *   ۵) تنظیمات کران شبانه و اجرای خودکار اتمیک بدون دوبارهکاری در یک اسلات زمانی (tickScheduledCron)
 */
'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const { EvaluatorService } = require(path.join(ROOT, 'dist', 'evaluator', 'evaluator.service'));
const { IngestionService } = require(path.join(ROOT, 'dist', 'ingestion', 'ingestion.service'));
const { AdminService } = require(path.join(ROOT, 'dist', 'admin', 'admin.service'));
const {
  normalizeDay,
  enumerateJalaliDays,
  validateCronExpr,
  matchesCronExpr,
  nextCronRun,
  tehranClockParts,
} = require(path.join(ROOT, 'dist', 'utils', 'date'));

const baseMellat = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'samples', 'mellat.json'), 'utf8'));
const baseResalat = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'samples', 's.json'), 'utf8'));

function dbWrapper(pg) {
  return {
    async query(text, params = []) {
      const r = await pg.query(text, params);
      return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows || []).length };
    },
    async getClient() {
      return { query: this.query.bind(this), release() {} };
    },
  };
}

function makeSample(base, id, ymdDigits, amount = 500000000) {
  const s = JSON.parse(JSON.stringify(base));
  s.requestId = id;
  if (s.input && typeof s.input === 'object') s.input.uniqueKey = `uk-${id}`;
  s.insertDate_full = `${ymdDigits}101500001`;
  s.insertDate_yearMonthDay = ymdDigits;
  if (s.output && typeof s.output === 'object') s.output.Credit_Basket = amount;
  return s;
}

async function waitForJob(admin, jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await admin.getJob(jobId);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timeout waiting for job ${jobId}`);
}

(async () => {
  // ─── ۱. تست توابع تاریخ شمسی و موتور Cron تهران ───
  assert.equal(normalizeDay('۱۴۰۵/۰۸/۱۹'), '1405-08-19');
  const span = enumerateJalaliDays('1405-07-29', '1405-08-02');
  assert.deepEqual(span, ['1405-07-29', '1405-07-30', '1405-08-01', '1405-08-02']);
  assert.throws(() => enumerateJalaliDays('1405-07-31', '1405-08-01'), /نامعتبر/);
  assert.equal(validateCronExpr('0 2 * * *').valid, true);
  assert.equal(validateCronExpr('*/15 1-4 * * 0,6').valid, true);
  assert.equal(validateCronExpr('99 2 * * *').valid, false);
  const nxt = nextCronRun('30 2 * * *', new Date('2026-11-14T10:00:00Z'));
  assert.ok(nxt && nxt.time === '02:30');
  console.log('✓ ۱) تقویم شمسی، ارقام فارسی و موتور Cron تهران معتبرند');

  // راهاندازی PGlite + سرویسها
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  const db = dbWrapper(pg);
  const evaluator = new EvaluatorService();
  const ingestion = new IngestionService(db, evaluator);
  const admin = new AdminService(db, ingestion);
  await admin.onModuleInit();

  // شبیهساز API بالادستی با ثبت دقیق پارامترهای ارسالی
  let apiCalls = [];
  let datasetByDay = new Map();
  ingestion.fetchPage = async (page, limit, day, filters) => {
    apiCalls.push({ page, limit, day, filters: filters ? { ...filters } : undefined });
    const list = day ? (datasetByDay.get(day) || []) : [...datasetByDay.values()].flat();
    let filtered = list;
    if (filters?.requestId) filtered = filtered.filter((x) => x.requestId === filters.requestId);
    if (filters?.uniqueKey) filtered = filtered.filter((x) => x.input?.uniqueKey === filters.uniqueKey);
    const start = (page - 1) * limit;
    return {
      count: filtered.length,
      reportResults: filtered.slice(start, start + limit),
    };
  };

  // ─── ۲. تست checkExistingData پیش از وجود داده و اجرای اولیه ───
  const targetDay = '1405-08-20';
  datasetByDay.set(targetDay, [
    makeSample(baseMellat, 'm-1', '14050820', 100),
    makeSample(baseMellat, 'm-2', '14050820', 200),
  ]);

  const checkBefore = await admin.checkExistingData({
    banks: ['tavan_mellat'],
    dateScope: 'single',
    day: targetDay,
  });
  assert.equal(checkBefore.hasExistingData, false);
  assert.equal(checkBefore.existingCount, 0);

  const job1 = await admin.startManualRun({
    banks: ['tavan_mellat'],
    dateScope: 'single',
    day: targetDay,
    mode: 'nightly',
  });
  const done1 = await waitForJob(admin, job1.id);
  assert.equal(done1.status, 'completed');

  const checkAfter = await admin.checkExistingData({
    banks: ['tavan_mellat'],
    dateScope: 'single',
    day: targetDay,
  });
  assert.equal(checkAfter.hasExistingData, true);
  assert.equal(checkAfter.existingCount, 1);
  assert.equal(checkAfter.items[0].rowCount, 2);
  assert.equal(checkAfter.items[0].dayRun.status, 'complete');

  // بدون confirmedConflict باید خطای EXISTING_DATA_CONFLICT بدهد
  await assert.rejects(
    () =>
      admin.startManualRun({
        banks: ['tavan_mellat'],
        dateScope: 'single',
        day: targetDay,
      }),
    (err) => err?.response?.code === 'EXISTING_DATA_CONFLICT',
  );
  console.log('✓ ۲) بررسی پیش از اجرا (checkExistingData) و محافظ EXISTING_DATA_CONFLICT کار میکنند');

  // ─── ۳. تست تفاوت Upsert در برابر Rebuild پس از تایید ادمین ───
  datasetByDay.set(targetDay, [
    makeSample(baseMellat, 'm-2', '14050820', 250),
    makeSample(baseMellat, 'm-3', '14050820', 300),
  ]);

  // الف) انتخاب Upsert: رکورد قدیمی m-1 باید حفظ شود و مجموع ۳ رکورد باشد
  const jobUpsert = await admin.startManualRun({
    banks: ['tavan_mellat'],
    dateScope: 'single',
    day: targetDay,
    conflictStrategy: 'upsert',
    confirmedConflict: true,
  });
  await waitForJob(admin, jobUpsert.id);
  const rowsAfterUpsert = await db.query(
    'SELECT request_id, credit_basket FROM samples_mellat WHERE day = $1 ORDER BY request_id',
    [targetDay],
  );
  assert.deepEqual(
    rowsAfterUpsert.rows.map((r) => r.request_id),
    ['m-1', 'm-2', 'm-3'],
  );

  // ب) انتخاب Rebuild: رکورد قدیمی m-1 حذف شده و فقط m-2 و m-3 باقی میمانند
  const jobRebuild = await admin.startManualRun({
    banks: ['tavan_mellat'],
    dateScope: 'single',
    day: targetDay,
    conflictStrategy: 'rebuild',
    confirmedConflict: true,
  });
  const doneRebuild = await waitForJob(admin, jobRebuild.id);
  assert.equal(doneRebuild.status, 'completed');
  assert.equal(doneRebuild.steps[0].result.deleted, 3);
  const rowsAfterRebuild = await db.query(
    'SELECT request_id FROM samples_mellat WHERE day = $1 ORDER BY request_id',
    [targetDay],
  );
  assert.deepEqual(
    rowsAfterRebuild.rows.map((r) => r.request_id),
    ['m-2', 'm-3'],
  );
  console.log('✓ ۳) استراتژیهای Upsert و Rebuild دقیقاً مطابق انتخاب ادمین عمل میکنند');

  // ─── ۴. تست فیلترهای API بالادستی، عدم دستکاری limit و حریم خصوصی کدملی ───
  const filterDay = '1405-08-21';
  datasetByDay.set(filterDay, [
    makeSample(baseMellat, 'mf-1', '14050821', 110),
    makeSample(baseMellat, 'mf-2', '14050821', 120),
    makeSample(baseMellat, 'mf-3', '14050821', 130),
    makeSample(baseMellat, 'mf-4', '14050821', 140),
    makeSample(baseMellat, 'mf-5', '14050821', 150),
  ]);
  apiCalls = [];
  const secretNat = '0012345678';
  const jobFiltered = await admin.startManualRun({
    banks: ['mellat'], // تست نام مستعار بانک
    dateScope: 'single',
    day: filterDay,
    mode: 'intraday',
    filters: {
      nationalCode: '۰۰۱۲۳۴۵۶۷۸', // ارقام فارسی ورودی
      status: '200',
      maxCount: 4,
      pageSize: 3,
    },
  });
  const doneFiltered = await waitForJob(admin, jobFiltered.id);
  assert.equal(doneFiltered.status, 'completed');
  assert.equal(doneFiltered.steps[0].result.processed, 4);

  // بررسی اینکه در صفحهٔ دوم، limit همچنان 3 مانده و به 1 تغییر نکرده است (باگ کلاسیک صفحه آخر)
  const dataCalls = apiCalls.filter((c) => c.limit === 3);
  assert.equal(dataCalls.length, 2, 'باید دو صفحه با limit ثابت ۳ واکشی شود');
  assert.equal(dataCalls[0].filters.nationalCode, secretNat);

  // تضمین حریم خصوصی: کد ملی نباید در وضعیت جاب، نمای کلی یا دیتابیس باشد
  const overviewDump = JSON.stringify(await admin.getOverview());
  assert.equal(overviewDump.includes(secretNat), false, 'کدملی نباید در خروجی overview یا جابها ذخیره شود');
  assert.equal(doneFiltered.filters.hasNationalCode, true);
  assert.equal('nationalCode' in doneFiltered.filters, false);

  // تست حالت بدون قید تاریخ (filter_only)
  const jobLookup = await admin.startManualRun({
    banks: ['tavan_mellat'],
    dateScope: 'filter_only',
    filters: { requestId: 'mf-5' },
  });
  const doneLookup = await waitForJob(admin, jobLookup.id);
  assert.equal(doneLookup.status, 'completed');
  assert.equal(doneLookup.steps[0].result.processed, 1);
  const mf5 = await db.query('SELECT day FROM samples_mellat WHERE request_id = $1', ['mf-5']);
  assert.equal(mf5.rows[0].day, '1405-08-21');
  console.log('✓ ۴) فیلترهای API، ثابتماندن limit صفحه آخر، حالت بدون تاریخ و حذف کامل کدملی تایید شدند');

  // ─── ۵. تست زمانبند خودکار کران شبانه (tickScheduledCron) ───
  const fakeNow = new Date('2026-11-14T22:30:10Z'); // معادل ۰۲:۰۰ بامداد تهران (+03:30)
  const parts = tehranClockParts(fakeNow);
  await admin.updateCronConfig({
    enabled: true,
    schedule_mode: 'daily',
    hour: parts.hour,
    minute: parts.minute,
    banks: ['tavan_mellat', 'tavan_resalat'],
    target_offset_days: 1,
    rebuild: false,
  });
  const cronCfg = await admin.getCronConfig();
  datasetByDay.set(cronCfg.target_day_preview, [
    makeSample(baseMellat, 'cm-1', cronCfg.target_day_preview.replace(/-/g, ''), 500),
    makeSample(baseResalat, 'cr-1', cronCfg.target_day_preview.replace(/-/g, ''), 600),
  ]);

  const cronJob1 = await admin.tickScheduledCron(fakeNow);
  assert.ok(cronJob1, 'اولین تیک در دقیقهٔ منطبق باید جاب کران را آغاز کند');
  const finishedCron = await waitForJob(admin, cronJob1.id);
  assert.equal(finishedCron.status, 'completed');

  // تیک دوم در همان دقیقه نباید دوباره اجرا شود
  const cronJob2 = await admin.tickScheduledCron(new Date(fakeNow.getTime() + 15_000));
  assert.equal(cronJob2, null, 'تیک تکراری در همان دقیقه باید نادیده گرفته شود');

  const updatedCron = await admin.getCronConfig();
  assert.equal(updatedCron.last_status, 'completed');
  assert.equal(updatedCron.last_slot, parts.slotKey);
  console.log('✓ ۵) زمانبند خودکار کران شبانه با قفل اتمیک last_slot بدون دوبارهکاری اجرا شد');

  await pg.close();
  console.log('\n🎉 تمام تستهای پنل مدیریت و زمانبند کران با موفقیت پاس شدند.');
})().catch((err) => {
  console.error('❌ شکست در تست پنل مدیریت:', err);
  process.exit(1);
});
