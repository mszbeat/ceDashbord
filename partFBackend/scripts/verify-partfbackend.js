#!/usr/bin/env node
/**
 * تست یکپارچهٔ سرتاسری partFBackend روی PostgreSQL واقعی در حافظه (PGlite):
 *  ۱. موتور ارزیابی روی نمونههای هر ۳ بانک (ملت، رسالت، پستبانک) + تقویم شمسی و Cron تهران
 *  ۲. هر ۵ باگ بحرانی سروری (حذف کدملی، dedupe دستهٔ تکراری، روز تهران، تراکنش اتمیک rebuild، دریلداون سرور)
 *  ۳. فراخوانی تمام ۱۹ هندلر در ۳ کنترلر مجزا (summaryController, creditEvaluationController, adminController)
 *     با شبیهسازی دقیق پارامترهای تزریقی partFramework در حالت needProtocolRef: false
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

/**
 * شبیهساز تزریقگر پارامترهای partFramework بر اساس آرایهٔ params در config.js هر کنترلر
 */
function invokeWithConfigParams(ctrlConfig, ctrlHelpers, handlerName, { url = '/', queryString = {}, params = {}, data = {} } = {}) {
  const handlerCfg = ctrlConfig.handlers[handlerName];
  assert.ok(handlerCfg, `Missing handler config for ${handlerName}`);
  assert.equal(handlerCfg.needProtocolRef, false, `${handlerName} must have needProtocolRef: false`);

  const headers = {};
  const response = {
    statusCode: 200,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
  };
  const request = {
    url,
    queryString,
    params,
    postData: data,
    data,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'partFBackend-test-suite' },
  };
  const inputData = {
    header: request.headers,
    params,
    queryString,
    data,
  };

  const tokenMap = {
    '_protocolRef.request.queryString': queryString,
    '_protocolRef.request.postData': data,
    '_protocolRef.request.data': data,
    '_protocolRef.request': request,
    '_protocolRef.response': response,
    _inputData: inputData,
    _session: {},
    _trackingHeaders: {},
  };

  const args = handlerCfg.params.map((token) => {
    assert.equal(token in tokenMap, true, `Unsupported param token: ${token}`);
    return tokenMap[token];
  });

  return {
    promise: Promise.resolve(ctrlHelpers[handlerName](...args)),
    response,
    headers,
  };
}

function parseResult(res) {
  if (res && typeof res === 'object' && typeof res.data === 'string' && 'statusCode' in res) {
    try {
      return JSON.parse(res.data);
    } catch {
      return res.data;
    }
  }
  return typeof res === 'string' ? JSON.parse(res) : res;
}

function unwrapHtmlResult(res) {
  if (res && typeof res === 'object' && typeof res.data === 'string') return res.data;
  return res;
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

async function waitForJobViaController(adminConfig, adminHelpers, jobId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = invokeWithConfigParams(adminConfig, adminHelpers, 'getJob', {
      url: `/api/admin/jobs/${jobId}`,
      params: { id: jobId },
    });
    const job = parseResult(await call.promise);
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
  const dayBeforeMidnightTehran = tehranToday(new Date('2026-04-16T19:00:00Z'));
  const dayAfterMidnightTehran = tehranToday(new Date('2026-04-16T21:00:00Z'));
  assert.notEqual(dayBeforeMidnightTehran, dayAfterMidnightTehran, 'Tehran midnight must advance at 20:30Z');
  console.log('  ✓ ۱. تقویم شمسی، مرز نیمهشب تهران و موتور Cron تایید شدند');

  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'services', 'db', 'schema.sql'), 'utf8'));
  const db = makeDbAdapter(pg);

  const container = require(path.join(ROOT, 'services', 'container'));
  const services = container.createServices({ db, enableCron: true });
  container.setServicesForTest(services);
  await services.init();

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
    assert.equal(JSON.stringify(row).includes('0012345678'), false);
    assert.equal(row.request_id, `chk-${bankKey}`);
    assert.equal(row.day, '1405-08-20');
  }
  console.log('  ✓ ۲. موتور ارزیابی هر ۳ بانک (ملت، رسالت، پستبانک) و حذف کدملی تایید شدند');

  const capturedUpstreamQueries = [];
  const datasetByDay = new Map();
  let failNextUpstream = false;

  const targetDay = '1405-08-20';
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
    const summaryConfig = require(path.join(ROOT, 'controllers', 'summaryController', 'config'));
    const summaryHelpers = require(path.join(ROOT, 'controllers', 'summaryController', 'helpers'));
    const ceConfig = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'config'));
    const ceHelpers = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'helpers'));
    const adminConfig = require(path.join(ROOT, 'controllers', 'adminController', 'config'));
    const adminHelpers = require(path.join(ROOT, 'controllers', 'adminController', 'helpers'));

    // ۳. تست اجرای دریافت داده در adminController با تزریق _protocolRef.request.data + Rollback اتمیک
    const badRebuildCall = invokeWithConfigParams(adminConfig, adminHelpers, 'runAdminDay', {
      url: '/api/admin/runs',
      data: { bank: 'tavan_mellat', rebuild: true },
    });
    await badRebuildCall.promise;
    assert.equal(badRebuildCall.response.statusCode, 400);

    const runCall = invokeWithConfigParams(adminConfig, adminHelpers, 'runAdminDay', {
      url: '/api/admin/runs',
      data: { bank: 'tavan_mellat', day: targetDay, mode: 'nightly', rebuild: false },
    });
    const runOut = parseResult(await runCall.promise);
    assert.equal(runCall.response.statusCode, 200);
    assert.equal(runOut.status, 'complete');
    assert.equal(runOut.success, 2);

    failNextUpstream = true;
    const failedRebuildCall = invokeWithConfigParams(adminConfig, adminHelpers, 'run', {
      url: '/api/runs',
      data: { bank: 'tavan_mellat', day: targetDay, mode: 'nightly', rebuild: true },
    });
    const failedRebuildErr = parseResult(await failedRebuildCall.promise);
    assert.equal(failedRebuildCall.response.statusCode, 503);
    assert.equal(failedRebuildErr.meta.code, 'creditEvaluationBaseServiceError');
    failNextUpstream = false;

    const preservedRows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM samples_mellat WHERE day = $1`,
      [targetDay],
    );
    assert.equal(preservedRows.rows[0].cnt, 2);
    console.log('  ✓ ۳. تزریق _protocolRef.request.data در مسیرهای دریافت داده و Rollback اتمیک rebuild تایید شدند');

    // ۴. تست تمام ۸ مسیر summaryController و مسیر creditEvaluationController با تزریق params
    const healthCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'health');
    assert.equal((await healthCall.promise).ok, true);

    const banksCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'banks');
    assert.equal(parseResult(await banksCall.promise).length, 3);

    const specsCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'specs', {
      queryString: { bank: 'tavan_mellat' },
    });
    assert.equal(parseResult(await specsCall.promise).bank.key, 'tavan_mellat');

    const reportCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'report', {
      queryString: { bank: 'tavan_mellat', from: targetDay, to: targetDay },
    });
    const reportHtml = unwrapHtmlResult(await reportCall.promise);
    assert.equal(reportCall.response.statusCode, 200);
    assert.match(reportCall.headers['content-type'], /text\/html/);
    assert.equal(reportHtml.includes('/api/sample/'), true);

    const diagCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'diagnostics');
    assert.equal((await diagCall.promise).ok, true);

    const sumCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'summary', {
      queryString: { bank: 'tavan_mellat', from: targetDay, to: targetDay },
    });
    assert.equal(parseResult(await sumCall.promise).stats.total, 2);

    const listCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'list', {
      queryString: { bank: 'tavan_mellat', from: targetDay, to: targetDay, limit: '10', offset: '0' },
    });
    assert.equal(parseResult(await listCall.promise).total, 2);

    const runsCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'runs');
    assert.equal(Array.isArray(parseResult(await runsCall.promise)), true);

    const sampleFoundCall = invokeWithConfigParams(ceConfig, ceHelpers, 'sample', {
      url: '/api/sample/m-1',
      params: { requestId: 'm-1' },
    });
    const sampleFoundOut = parseResult(await sampleFoundCall.promise);
    assert.equal(sampleFoundCall.response.statusCode, 200);
    assert.equal(sampleFoundOut.found, true);
    assert.equal(sampleFoundOut.requestId, 'm-1');
    console.log('  ✓ ۴. کنترلرهای summaryController و creditEvaluationController با needProtocolRef: false تایید شدند');

    // ۵. تست تمام مسیرهای adminController با تزریق params
    const overviewCall = invokeWithConfigParams(adminConfig, adminHelpers, 'getOverview');
    const overviewOut = parseResult(await overviewCall.promise);
    assert.equal(overviewCall.response.statusCode, 200);
    assert.equal(overviewOut.banks.length, 3);

    const cronGetCall = invokeWithConfigParams(adminConfig, adminHelpers, 'getCron');
    assert.equal(parseResult(await cronGetCall.promise).timezone, 'Asia/Tehran');

    const cronPutCall = invokeWithConfigParams(adminConfig, adminHelpers, 'updateCron', {
      data: {
        enabled: true,
        schedule_mode: 'daily',
        hour: 3,
        minute: 30,
        banks: ['tavan_mellat'],
        target_offset_days: 1,
        rebuild: false,
      },
    });
    assert.equal(parseResult(await cronPutCall.promise).effective_cron_expr, '30 3 * * *');

    const checkCall = invokeWithConfigParams(adminConfig, adminHelpers, 'checkExisting', {
      data: { banks: ['tavan_mellat'], dateScope: 'single', day: targetDay },
    });
    assert.equal(parseResult(await checkCall.promise).hasExistingData, true);

    const unconfirmedCall = invokeWithConfigParams(adminConfig, adminHelpers, 'startRun', {
      data: { banks: ['tavan_mellat'], dateScope: 'single', day: targetDay },
    });
    const unconfirmedErr = parseResult(await unconfirmedCall.promise);
    assert.equal(unconfirmedCall.response.statusCode, 400);
    assert.equal(unconfirmedErr.code, 'EXISTING_DATA_CONFLICT');

    datasetByDay.set(targetDay, [cloneSample(baseMellat, 'm-3', '14050820', 450000000)]);
    capturedUpstreamQueries.length = 0;

    const startCall = invokeWithConfigParams(adminConfig, adminHelpers, 'startRun', {
      data: {
        banks: ['tavan_mellat'],
        dateScope: 'single',
        day: targetDay,
        mode: 'nightly',
        conflictStrategy: 'rebuild',
        confirmedConflict: true,
        filters: {
          status: 'success',
          nationalCode: '۰۰۹۹۸۸۷۷۶۶',
          maxCount: 10,
          pageSize: 25,
        },
      },
    });
    const startedJob = parseResult(await startCall.promise);
    assert.equal(startCall.response.statusCode, 200);
    assert.equal(JSON.stringify(startedJob).includes('0099887766'), false);

    const completedJob = await waitForJobViaController(adminConfig, adminHelpers, startedJob.id);
    assert.equal(completedJob.status, 'completed');
    assert.equal(
      capturedUpstreamQueries.some((q) => q.nationalCode === '0099887766' && q.limit === '25'),
      true,
    );

    const jobsCall = invokeWithConfigParams(adminConfig, adminHelpers, 'listJobs');
    assert.equal(parseResult(await jobsCall.promise).length >= 1, true);

    const cronNowCall = invokeWithConfigParams(adminConfig, adminHelpers, 'runCronNow');
    const cronNowJob = parseResult(await cronNowCall.promise);
    const doneCronJob = await waitForJobViaController(adminConfig, adminHelpers, cronNowJob.id);
    assert.equal(doneCronJob.status, 'completed');
    console.log('  ✓ ۵. کنترلر adminController، محافظ تداخل داده، کران تهران و حفاظت کدملی تایید شدند');
  } finally {
    global.fetch = originalFetch;
    await services.close();
  }

  console.log('✅ تمام تستهای یکپارچهٔ partFBackend با موفقیت ۱۰۰٪ پاس شدند!');
})().catch((err) => {
  console.error('❌ خطا در تست یکپارچهٔ partFBackend:', err);
  process.exit(1);
});
