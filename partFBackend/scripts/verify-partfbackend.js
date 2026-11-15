#!/usr/bin/env node
/**
 * تست یکپارچهٔ سرتاسری partFBackend روی PostgreSQL واقعی در حافظه (PGlite):
 *  ۱. موتور ارزیابی روی نمونههای هر ۳ بانک (ملت، رسالت، پستبانک) + تقویم شمسی و Cron تهران
 *  ۲. هر ۵ باگ بحرانی سروری (حذف کدملی، dedupe دستهٔ تکراری، روز تهران، تراکنش اتمیک rebuild، دریلداون سرور)
 *  ۳. تمام ۱۸ هندلر کنترلرهای partFramework (summaryController, ingestionController, adminController)
 *  ۴. پنل مدیریت، بررسی پیش از اجرا (EXISTING_DATA_CONFLICT -> Upsert / Rebuild)، فیلترها بدون ذخیرهٔ کدملی و اجرای کران
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, '..', 'samples');

function loadPGlite() {
  for (const candidate of [
    '@electric-sql/pglite',
    path.join(ROOT, '..', 'backend', 'node_modules', '@electric-sql', 'pglite'),
  ]) {
    try {
      return require(candidate).PGlite;
    } catch {}
  }
  return null;
}

function makeDbAdapter(pg) {
  let queue = Promise.resolve();
  const runSerialized = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  return {
    query(text, params = []) {
      return runSerialized(async () => {
        const r = await pg.query(text, params);
        return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows || []).length };
      });
    },
    async getClient() {
      let releaseLock;
      const prev = queue;
      queue = new Promise((resolve) => {
        releaseLock = resolve;
      });
      await prev;
      return {
        async query(text, params = []) {
          const r = await pg.query(text, params);
          return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows || []).length };
        },
        release() {
          releaseLock();
        },
      };
    },
    async close() {
      await pg.close();
    },
  };
}

function makeProtocolRef({ url = '/', queryString, params, body } = {}) {
  const headers = {};
  const response = {
    statusCode: 200,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
  };
  return {
    protocolRef: {
      request: {
        url,
        headers: { 'user-agent': 'partFBackend-test-suite' },
        ip: '127.0.0.1',
        ...(queryString ? { queryString } : {}),
        ...(params ? { params } : {}),
        ...(body !== undefined ? { body } : {}),
      },
      response,
    },
    headers,
    response,
  };
}

function parseJsonResult(res) {
  return typeof res === 'string' ? JSON.parse(res) : res;
}

function cloneSample(base, id, ymdDigits, amount = 500000000, extra = {}) {
  const s = JSON.parse(JSON.stringify(base));
  s.requestId = id;
  if (s.input && typeof s.input === 'object') {
    s.input.uniqueKey = extra.uniqueKey || `uk-${id}`;
    if (extra.nationalCode) s.input.nationalCode = extra.nationalCode;
  }
  s.insertDate_full = `${ymdDigits}101500001`;
  s.insertDate_yearMonthDay = ymdDigits;
  if (s.output && typeof s.output === 'object') s.output.Credit_Basket = amount;
  if (extra.nationalCode) s.nationalCode = extra.nationalCode;
  return s;
}

async function waitForJobViaController(adminHelpers, jobId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = makeProtocolRef({
      url: `/api/admin/jobs/${jobId}`,
      params: { id: jobId },
    });
    const job = parseJsonResult(await adminHelpers.getJob(call.protocolRef));
    assert.equal(call.response.statusCode, 200);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timeout waiting for job ${jobId}`);
}

(async () => {
  const PGlite = loadPGlite();
  if (!PGlite) {
    console.log('ℹ️ @electric-sql/pglite نصب نیست؛ تست یکپارچه درونحافظهای رد شد.');
    return;
  }

  process.env.CE_REDACT_NATIONAL_CODE = 'true';
  process.env.CE_GATEWAY_TOKEN = 'test-gateway-token';
  process.env.CE_API_RETRY = '1';

  const {
    normalizeDay,
    enumerateJalaliDays,
    validateCronExpr,
    nextCronRun,
    tehranToday,
  } = require(path.join(ROOT, 'services', 'utils', 'date'));

  // ۱. بررسی تقویم شمسی، روز تهران و موتور Cron
  assert.equal(normalizeDay('۱۴۰۵/۰۸/۲۰'), '1405-08-20');
  assert.deepEqual(enumerateJalaliDays('1405-07-29', '1405-08-01'), [
    '1405-07-29',
    '1405-07-30',
    '1405-08-01',
  ]);
  assert.equal(validateCronExpr('0 2 * * *').valid, true);
  assert.equal(validateCronExpr('99 2 * * *').valid, false);
  const nxt = nextCronRun('30 2 * * *', new Date('2026-11-14T10:00:00Z'));
  assert.equal(nxt.time, '02:30');
  // ساعت ۲۱:۰۰ UTC برابر ۰۰:۳۰ فردا به وقت تهران است (تست باگ ۴ روز تهران)
  const dayBeforeMidnightTehran = tehranToday(new Date('2026-04-16T19:00:00Z'));
  const dayAfterMidnightTehran = tehranToday(new Date('2026-04-16T21:00:00Z'));
  assert.notEqual(dayBeforeMidnightTehran, dayAfterMidnightTehran, 'Tehran midnight must advance at 20:30Z');
  console.log('  ✓ ۱. تقویم شمسی، مرز نیمهشب تهران و موتور Cron تایید شدند');

  // راهاندازی PGlite + کانتینر سرویسهای partFBackend (schema.sql خودش message_dict را هم seed میکند)
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'services', 'db', 'schema.sql'), 'utf8'));
  const db = makeDbAdapter(pg);

  const container = require(path.join(ROOT, 'services', 'container'));
  const services = container.createServices({ db, enableCron: true });
  container.setServicesForTest(services);
  await services.init();

  // بررسی موتور ارزیابی روی نمونههای واقعی هر ۳ بانک + حذف کدملی (باگ ۱)
  const baseMellat = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, 'mellat.json'), 'utf8'));
  const baseResalat = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, 's.json'), 'utf8'));
  const basePostbank = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, 'postbank.json'), 'utf8'));

  for (const [bankKey, raw] of [
    ['tavan_mellat', baseMellat],
    ['tavan_resalat', baseResalat],
    ['tavan_postbank', basePostbank],
  ]) {
    const withNationalCode = cloneSample(raw, `chk-${bankKey}`, '14050820', 400000000, {
      nationalCode: '0012345678',
    });
    const norm = services.evaluator.normalizeSample(withNationalCode, { fromApi: true });
    const row = services.evaluator.evaluate(
      norm,
      services.evaluator.isReportSuccess(norm),
      '1405-08-20',
      bankKey,
    );
    assert.equal(
      JSON.stringify(row).includes('0012345678'),
      false,
      `nationalCode must never be stored in evaluated DB row for ${bankKey}`,
    );
    assert.equal(row.request_id, `chk-${bankKey}`);
    assert.equal(row.day, '1405-08-20');
  }
  console.log('  ✓ ۲. موتور ارزیابی هر ۳ بانک (ملت، رسالت، پستبانک) و حذف کدملی تایید شدند');

  // شبیهسازی گیتوی بالادستی CE از طریق global.fetch تا مسیر کامل HTTP -> fetchPage -> PostgreSQL تست شود
  const capturedUpstreamQueries = [];
  const datasetByDay = new Map();
  let failNextUpstream = false;

  const targetDay = '1405-08-20';
  // شامل رکورد تکراری m-1 در یک صفحه برای تست باگ ۲ (dedupe پیش از INSERT ... ON CONFLICT)
  datasetByDay.set(targetDay, [
    cloneSample(baseMellat, 'm-1', '14050820', 150000000),
    cloneSample(baseMellat, 'm-1', '14050820', 250000000),
    cloneSample(baseMellat, 'm-2', '14050820', 350000000),
  ]);

  const originalFetch = global.fetch;
  global.fetch = async (urlStr) => {
    const u = new URL(urlStr);
    const q = Object.fromEntries(u.searchParams.entries());
    capturedUpstreamQueries.push(q);
    if (failNextUpstream) {
      return { ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({}) };
    }
    const dayKey = q.date ? q.date.replace(/\//g, '-') : null;
    let list = dayKey ? datasetByDay.get(dayKey) || [] : [...datasetByDay.values()].flat();
    if (q.requestId) list = list.filter((x) => x.requestId === q.requestId);
    if (q.uniqueKey) list = list.filter((x) => x.input?.uniqueKey === q.uniqueKey);
    const page = Number(q.page || 1);
    const limit = Number(q.limit || 50);
    const start = (page - 1) * limit;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: {
          count: list.length,
          reportResults: list.slice(start, start + limit),
        },
      }),
    };
  };

  try {
    const summaryHelpers = require(path.join(ROOT, 'controllers', 'summaryController', 'helpers'));
    const ingestionHelpers = require(path.join(ROOT, 'controllers', 'ingestionController', 'helpers'));
    const adminHelpers = require(path.join(ROOT, 'controllers', 'adminController', 'helpers'));

    // ۳. تست POST /api/runs + تراکنش اتمیک rebuild (باگ ۵)
    const badRebuildCall = makeProtocolRef({
      url: '/api/runs',
      body: { bank: 'tavan_mellat', rebuild: true },
    });
    await ingestionHelpers.run(badRebuildCall.protocolRef);
    assert.equal(badRebuildCall.response.statusCode, 400);

    const runCall = makeProtocolRef({
      url: '/api/runs',
      body: { bank: 'tavan_mellat', day: targetDay, mode: 'nightly', rebuild: false },
    });
    const runOut = parseJsonResult(await ingestionHelpers.run(runCall.protocolRef));
    assert.equal(runCall.response.statusCode, 200);
    assert.equal(runOut.status, 'complete');
    assert.equal(runOut.success, 2, 'Duplicate m-1 in same page must be deduplicated cleanly');

    // تست Rollback اتمیک در rebuild هنگام خطای گیتوی بالادستی
    failNextUpstream = true;
    const failedRebuildCall = makeProtocolRef({
      url: '/api/runs',
      body: { bank: 'tavan_mellat', day: targetDay, mode: 'nightly', rebuild: true },
    });
    await ingestionHelpers.run(failedRebuildCall.protocolRef);
    assert.equal(failedRebuildCall.response.statusCode, 500);
    failNextUpstream = false;

    const preservedRows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM samples_mellat WHERE day = $1`,
      [targetDay],
    );
    assert.equal(preservedRows.rows[0].cnt, 2, 'Failed rebuild must roll back and preserve existing rows');
    console.log('  ✓ ۳. مسیر POST /api/runs، حذف رکوردهای تکراری در دسته و Rollback اتمیک rebuild تایید شدند');

    // ۴. تست تمام ۹ مسیر summaryController
    const healthCall = makeProtocolRef({ url: '/api/health' });
    const healthOut = await summaryHelpers.health(healthCall.protocolRef);
    assert.equal(healthOut.ok, true);
    assert.equal(healthOut.framework, 'partFramework');

    const banksCall = makeProtocolRef({ url: '/api/banks' });
    const banksOut = parseJsonResult(await summaryHelpers.banks(banksCall.protocolRef));
    assert.equal(banksCall.response.statusCode, 200);
    assert.equal(banksOut.length, 3);

    const specsCall = makeProtocolRef({ url: '/api/specs?bank=tavan_mellat' });
    const specsOut = parseJsonResult(await summaryHelpers.specs(specsCall.protocolRef));
    assert.equal(specsCall.response.statusCode, 200);
    assert.equal(specsOut.bank.key, 'tavan_mellat');

    const reportCall = makeProtocolRef({
      url: `/api/report?bank=tavan_mellat&from=${targetDay}&to=${targetDay}`,
    });
    const reportHtml = await summaryHelpers.report(reportCall.protocolRef);
    assert.equal(reportCall.response.statusCode, 200);
    assert.match(reportCall.headers['content-type'], /text\/html/);
    assert.equal(typeof reportHtml, 'string');
    assert.equal(reportHtml.includes('/api/sample/'), true, 'Server HTML report must wire live /api/sample drilldown');

    const diagCall = makeProtocolRef({ url: '/api/diagnostics' });
    const diagOut = parseJsonResult(await summaryHelpers.diagnostics(diagCall.protocolRef));
    assert.equal(diagCall.response.statusCode, 200);
    assert.equal(typeof diagOut, 'object');

    const sumCall = makeProtocolRef({
      url: `/api/summary?bank=tavan_mellat&from=${targetDay}&to=${targetDay}`,
    });
    const sumOut = parseJsonResult(await summaryHelpers.summary(sumCall.protocolRef));
    assert.equal(sumCall.response.statusCode, 200);
    assert.equal(sumOut.stats.total, 2);

    const listCall = makeProtocolRef({
      url: `/api/list?bank=tavan_mellat&from=${targetDay}&to=${targetDay}&limit=10&offset=0`,
    });
    const listOut = parseJsonResult(await summaryHelpers.list(listCall.protocolRef));
    assert.equal(listCall.response.statusCode, 200);
    assert.equal(listOut.total, 2);

    const sampleFoundCall = makeProtocolRef({
      url: '/api/sample/m-1',
      params: { requestId: 'm-1' },
    });
    const sampleFoundOut = parseJsonResult(await summaryHelpers.sample(sampleFoundCall.protocolRef));
    assert.equal(sampleFoundCall.response.statusCode, 200);
    assert.equal(sampleFoundOut.found, true);
    assert.equal(sampleFoundOut.requestId, 'm-1');

    const sampleMissingCall = makeProtocolRef({
      url: '/api/sample/non-existent-id',
      params: { requestId: 'non-existent-id' },
    });
    const sampleMissingOut = parseJsonResult(await summaryHelpers.sample(sampleMissingCall.protocolRef));
    assert.equal(sampleMissingCall.response.statusCode, 200);
    assert.equal(sampleMissingOut.found, false);

    const runsListCall = makeProtocolRef({ url: '/api/runs' });
    const runsListOut = parseJsonResult(await summaryHelpers.runs(runsListCall.protocolRef));
    assert.equal(runsListCall.response.statusCode, 200);
    assert.equal(Array.isArray(runsListOut), true);
    console.log('  ✓ ۴. تمام ۹ مسیر summaryController (از جمله رندر HTML و دریلداون سرور) تایید شدند');

    // ۵. تست تمام ۸ مسیر adminController + محافظ EXISTING_DATA_CONFLICT + کران تهران + حفاظت کدملی
    const overviewCall = makeProtocolRef({ url: '/api/admin/overview' });
    const overviewOut = parseJsonResult(await adminHelpers.getOverview(overviewCall.protocolRef));
    assert.equal(overviewCall.response.statusCode, 200);
    assert.equal(overviewOut.banks.length, 3);
    assert.equal(overviewOut.serverClock.timezone, 'Asia/Tehran');

    const cronGetCall = makeProtocolRef({ url: '/api/admin/cron' });
    const cronGetOut = parseJsonResult(await adminHelpers.getCron(cronGetCall.protocolRef));
    assert.equal(cronGetCall.response.statusCode, 200);
    assert.equal(cronGetOut.timezone, 'Asia/Tehran');

    const cronPutCall = makeProtocolRef({
      url: '/api/admin/cron',
      body: {
        enabled: true,
        schedule_mode: 'daily',
        hour: 3,
        minute: 30,
        banks: ['tavan_mellat'],
        target_offset_days: 1,
        rebuild: false,
      },
    });
    const cronPutOut = parseJsonResult(await adminHelpers.updateCron(cronPutCall.protocolRef));
    assert.equal(cronPutCall.response.statusCode, 200);
    assert.equal(cronPutOut.enabled, true);
    assert.equal(cronPutOut.hour, 3);
    assert.equal(cronPutOut.minute, 30);
    assert.equal(cronPutOut.effective_cron_expr, '30 3 * * *');

    const checkCall = makeProtocolRef({
      url: '/api/admin/runs/check',
      body: { banks: ['tavan_mellat'], dateScope: 'single', day: targetDay },
    });
    const checkOut = parseJsonResult(await adminHelpers.checkExisting(checkCall.protocolRef));
    assert.equal(checkCall.response.statusCode, 200);
    assert.equal(checkOut.hasExistingData, true);
    assert.equal(checkOut.items[0].rowCount, 2);

    // بدون confirmedConflict باید خطای ۴۰۰ EXISTING_DATA_CONFLICT برگرداند
    const unconfirmedCall = makeProtocolRef({
      url: '/api/admin/runs/start',
      body: { banks: ['tavan_mellat'], dateScope: 'single', day: targetDay },
    });
    const unconfirmedErr = parseJsonResult(await adminHelpers.startRun(unconfirmedCall.protocolRef));
    assert.equal(unconfirmedCall.response.statusCode, 400);
    assert.equal(unconfirmedErr.code, 'EXISTING_DATA_CONFLICT');

    // اجرای تاییدشده با Rebuild و فیلتر کدملی — بررسی ارسال به گیتوی و عدم ذخیره در جاب
    datasetByDay.set(targetDay, [
      cloneSample(baseMellat, 'm-3', '14050820', 450000000),
    ]);
    capturedUpstreamQueries.length = 0;

    const startCall = makeProtocolRef({
      url: '/api/admin/runs/start',
      body: {
        banks: ['tavan_mellat'],
        dateScope: 'single',
        day: targetDay,
        mode: 'nightly',
        conflictStrategy: 'rebuild',
        confirmedConflict: true,
        filters: {
          status: 'success',
          nationalCode: '۰۰۹۹۸۸۷۷۶۶', // ارقام فارسی باید به انگلیسی نرمال شوند اما ذخیره نشوند
          maxCount: 10,
          pageSize: 25,
        },
      },
    });
    const startedJob = parseJsonResult(await adminHelpers.startRun(startCall.protocolRef));
    assert.equal(startCall.response.statusCode, 200);
    assert.equal(startedJob.filters.hasNationalCode, true);
    assert.equal(
      JSON.stringify(startedJob).includes('0099887766'),
      false,
      'nationalCode must NEVER appear in admin job payload',
    );

    const completedJob = await waitForJobViaController(adminHelpers, startedJob.id);
    assert.equal(completedJob.status, 'completed');
    assert.equal(
      capturedUpstreamQueries.some((q) => q.nationalCode === '0099887766' && q.limit === '25'),
      true,
      'Normalized nationalCode and custom pageSize must be sent to upstream CE API',
    );

    const rebuiltCount = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM samples_mellat WHERE day = $1`,
      [targetDay],
    );
    assert.equal(rebuiltCount.rows[0].cnt, 1, 'Rebuild strategy must replace previous rows');

    const jobsCall = makeProtocolRef({ url: '/api/admin/jobs' });
    const jobsOut = parseJsonResult(await adminHelpers.listJobs(jobsCall.protocolRef));
    assert.equal(jobsCall.response.statusCode, 200);
    assert.equal(jobsOut.length >= 1, true);

    const cronNowCall = makeProtocolRef({ url: '/api/admin/cron/run-now' });
    const cronNowJob = parseJsonResult(await adminHelpers.runCronNow(cronNowCall.protocolRef));
    assert.equal(cronNowCall.response.statusCode, 200);
    const doneCronJob = await waitForJobViaController(adminHelpers, cronNowJob.id);
    assert.equal(doneCronJob.status, 'completed');
    console.log('  ✓ ۵. تمام ۸ مسیر adminController، محافظ تداخل داده، کران تهران و حفاظت کدملی تایید شدند');
  } finally {
    global.fetch = originalFetch;
    await services.close();
  }

  console.log('✅ تمام تستهای یکپارچهٔ partFBackend با موفقیت ۱۰۰٪ پاس شدند!');
})().catch((err) => {
  console.error('❌ خطا در تست یکپارچهٔ partFBackend:', err);
  process.exit(1);
});
