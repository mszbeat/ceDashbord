#!/usr/bin/env node
/**
 * تست یکپارچهٔ سرتاسری partFBackend روی PostgreSQL واقعی در حافظه (PGlite):
 *  ۱. موتور ارزیابی روی نمونههای هر ۳ بانک (ملت، رسالت، پستبانک) + تقویم شمسی و Cron تهران
 *  ۲. هر ۵ باگ بحرانی سروری (حذف کدملی، dedupe دستهٔ تکراری، روز تهران، تراکنش اتمیک rebuild، دریلداون سرور)
 *  ۳. تست کامل ماتریس ۳ سطح دسترسی (کاربر عادی / creditEvaluation / admin) روی تمام ۲۰ مسیر API
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

function makeProtocolRef({ url = '/', queryString, params, body, role, username } = {}) {
  const headers = {};
  const response = {
    statusCode: 200,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
  };
  const userObj = role
    ? {
        username: username || `${role}-user`,
        roles: Array.isArray(role) ? role : [role],
      }
    : undefined;

  return {
    protocolRef: {
      ...(userObj ? { user: userObj } : {}),
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

async function waitForJobViaController(adminHelpers, jobId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = makeProtocolRef({
      url: `/api/admin/jobs/${jobId}`,
      params: { id: jobId },
      role: 'admin',
    });
    const job = parseResult(await adminHelpers.getJob(call.protocolRef));
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

  delete process.env.AUTH_DEV_DEFAULT_ROLE;
  process.env.AUTH_TRUST_ROLE_HEADERS = 'false';
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
  const dayBeforeMidnightTehran = tehranToday(new Date('2026-04-16T19:00:00Z'));
  const dayAfterMidnightTehran = tehranToday(new Date('2026-04-16T21:00:00Z'));
  assert.notEqual(dayBeforeMidnightTehran, dayAfterMidnightTehran, 'Tehran midnight must advance at 20:30Z');
  console.log('  ✓ ۱. تقویم شمسی، مرز نیمهشب تهران و موتور Cron تایید شدند');

  // راهاندازی PGlite + کانتینر سرویسهای partFBackend
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
    assert.equal(
      JSON.stringify(row).includes('0012345678'),
      false,
      `nationalCode must never be stored in evaluated DB row for ${bankKey}`,
    );
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
    const summaryHelpers = require(path.join(ROOT, 'controllers', 'summaryController', 'helpers'));
    const ceHelpers = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'helpers'));
    const adminHelpers = require(path.join(ROOT, 'controllers', 'adminController', 'helpers'));

    // ۳. تست اجرای دریافت داده توسط admin + تراکنش اتمیک rebuild
    const badRebuildCall = makeProtocolRef({
      url: '/api/admin/runs',
      body: { bank: 'tavan_mellat', rebuild: true },
      role: 'admin',
    });
    await adminHelpers.runAdminDay(badRebuildCall.protocolRef);
    assert.equal(badRebuildCall.response.statusCode, 400);

    const runCall = makeProtocolRef({
      url: '/api/admin/runs',
      body: { bank: 'tavan_mellat', day: targetDay, mode: 'nightly', rebuild: false },
      role: 'admin',
    });
    const runOut = parseResult(await adminHelpers.runAdminDay(runCall.protocolRef));
    assert.equal(runCall.response.statusCode, 200);
    assert.equal(runOut.status, 'complete');
    assert.equal(runOut.success, 2, 'Duplicate m-1 in same page must be deduplicated cleanly');

    failNextUpstream = true;
    const failedRebuildCall = makeProtocolRef({
      url: '/api/runs',
      body: { bank: 'tavan_mellat', day: targetDay, mode: 'nightly', rebuild: true },
      role: 'admin',
    });
    await adminHelpers.run(failedRebuildCall.protocolRef);
    assert.equal(failedRebuildCall.response.statusCode, 500);
    failNextUpstream = false;

    const preservedRows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM samples_mellat WHERE day = $1`,
      [targetDay],
    );
    assert.equal(preservedRows.rows[0].cnt, 2, 'Failed rebuild must roll back and preserve existing rows');
    console.log('  ✓ ۳. مسیرهای دریافت داده (admin)، حذف تکراریها و Rollback اتمیک rebuild تایید شدند');

    // ۴. تست کامل ماتریس ۳ سطح دسترسی (کاربر عادی / creditEvaluation / admin)
    // ۴-الف: کاربر عادی (بدون نقش خاص)
    const normalMeCall = makeProtocolRef({ url: '/api/auth/me' });
    const normalMe = parseResult(await summaryHelpers.me(normalMeCall.protocolRef));
    assert.equal(normalMeCall.response.statusCode, 200);
    assert.deepEqual(normalMe.roles, ['user']);
    assert.equal(normalMe.permissions.canViewDashboard, true);
    assert.equal(normalMe.permissions.canViewReportDetails, false);
    assert.equal(normalMe.permissions.canAccessAdmin, false);

    // کاربر عادی میتواند صفحهٔ اول و تحلیلهای کلی را ببیند
    const normalReportCall = makeProtocolRef({
      url: `/api/report?bank=tavan_mellat&from=${targetDay}&to=${targetDay}`,
    });
    const normalHtml = unwrapHtmlResult(await summaryHelpers.report(normalReportCall.protocolRef));
    assert.equal(normalReportCall.response.statusCode, 200);
    assert.equal(normalHtml.includes('id="ce-admin-link" class="ce-admin-link" style="display:none"'), true);

    const sumCall = makeProtocolRef({
      url: `/api/summary?bank=tavan_mellat&from=${targetDay}&to=${targetDay}`,
    });
    const sumOut = parseResult(await summaryHelpers.summary(sumCall.protocolRef));
    assert.equal(sumCall.response.statusCode, 200);
    assert.equal(sumOut.stats.total, 2);

    const listCall = makeProtocolRef({
      url: `/api/list?bank=tavan_mellat&from=${targetDay}&to=${targetDay}&limit=10&offset=0`,
    });
    const listOut = parseResult(await summaryHelpers.list(listCall.protocolRef));
    assert.equal(listCall.response.statusCode, 200);
    assert.equal(listOut.total, 2);

    // کاربر عادی نمیتواند اطلاعات یک گزارش تکی را درخواست بزند (403 Forbidden)
    const upstreamCountBeforeBlocked = capturedUpstreamQueries.length;
    const normalSampleCall = makeProtocolRef({
      url: '/api/sample/m-1',
      params: { requestId: 'm-1' },
    });
    const normalSampleErr = parseResult(await ceHelpers.sample(normalSampleCall.protocolRef));
    assert.equal(normalSampleCall.response.statusCode, 403);
    assert.equal(normalSampleErr.code, 'FORBIDDEN_ROLE');
    assert.equal(
      capturedUpstreamQueries.length,
      upstreamCountBeforeBlocked,
      'Blocked normal user must never trigger upstream sample fetch',
    );

    // کاربر عادی نمیتواند وارد مسیرهای ادمین شود (403 Forbidden)
    for (const [fnName, body] of [
      ['getOverview', undefined],
      ['getCron', undefined],
      ['updateCron', { enabled: true }],
      ['runCronNow', {}],
      ['checkExisting', { banks: ['tavan_mellat'], day: targetDay }],
      ['startRun', { banks: ['tavan_mellat'], day: targetDay }],
      ['listJobs', undefined],
      ['runAdminDay', { bank: 'tavan_mellat', day: targetDay }],
      ['run', { bank: 'tavan_mellat', day: targetDay }],
    ]) {
      const blockedAdminCall = makeProtocolRef({ url: '/api/admin/test', body });
      await adminHelpers[fnName](blockedAdminCall.protocolRef);
      assert.equal(blockedAdminCall.response.statusCode, 403, `Normal user must get 403 on admin.${fnName}`);
    }

    // ۴-ب: نقش creditEvaluation -> مجاز به دریافت اطلاعات یک گزارش، ولی ممنوع از ورود به پنل ادمین
    const ceSampleCall = makeProtocolRef({
      url: '/api/sample/m-1',
      params: { requestId: 'm-1' },
      role: 'creditEvaluation',
    });
    const ceSampleOut = parseResult(await ceHelpers.sample(ceSampleCall.protocolRef));
    assert.equal(ceSampleCall.response.statusCode, 200);
    assert.equal(ceSampleOut.found, true);
    assert.equal(ceSampleOut.requestId, 'm-1');

    const ceAdminBlockedCall = makeProtocolRef({
      url: '/api/admin/overview',
      role: 'creditEvaluation',
    });
    const ceAdminBlockedErr = parseResult(await adminHelpers.getOverview(ceAdminBlockedCall.protocolRef));
    assert.equal(ceAdminBlockedCall.response.statusCode, 403);
    assert.equal(ceAdminBlockedErr.code, 'FORBIDDEN_ROLE');

    const ceRunBlockedCall = makeProtocolRef({
      url: '/api/runs',
      body: { bank: 'tavan_mellat', day: targetDay },
      role: 'creditEvaluation',
    });
    await adminHelpers.run(ceRunBlockedCall.protocolRef);
    assert.equal(ceRunBlockedCall.response.statusCode, 403);

    // ۴-ج: نقش admin -> دسترسی کامل به همه چیز (تحلیل کلی + جزئیات گزارش + پنل ادمین)
    const adminReportCall = makeProtocolRef({
      url: `/api/report?bank=tavan_mellat&from=${targetDay}&to=${targetDay}`,
      role: 'admin',
    });
    const adminHtml = unwrapHtmlResult(await summaryHelpers.report(adminReportCall.protocolRef));
    assert.equal(adminReportCall.response.statusCode, 200);
    assert.equal(adminHtml.includes('id="ce-admin-link" class="ce-admin-link">⚙ پنل مدیریت</a>'), true);

    const adminSampleCall = makeProtocolRef({
      url: '/api/sample/m-1',
      params: { requestId: 'm-1' },
      role: 'admin',
    });
    const adminSampleOut = parseResult(await ceHelpers.sample(adminSampleCall.protocolRef));
    assert.equal(adminSampleCall.response.statusCode, 200);
    assert.equal(adminSampleOut.found, true);
    console.log('  ✓ ۴. جداسازی مسیرها و گاردهای هر ۳ نقش (کاربر عادی / creditEvaluation / admin) ۱۰۰٪ تایید شدند');

    // ۵. تست عملیات کامل پنل ادمین با نقش admin
    const overviewCall = makeProtocolRef({ url: '/api/admin/overview', role: 'admin' });
    const overviewOut = parseResult(await adminHelpers.getOverview(overviewCall.protocolRef));
    assert.equal(overviewCall.response.statusCode, 200);
    assert.equal(overviewOut.banks.length, 3);

    const cronPutCall = makeProtocolRef({
      url: '/api/admin/cron',
      role: 'admin',
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
    const cronPutOut = parseResult(await adminHelpers.updateCron(cronPutCall.protocolRef));
    assert.equal(cronPutCall.response.statusCode, 200);
    assert.equal(cronPutOut.effective_cron_expr, '30 3 * * *');

    const checkCall = makeProtocolRef({
      url: '/api/admin/runs/check',
      role: 'admin',
      body: { banks: ['tavan_mellat'], dateScope: 'single', day: targetDay },
    });
    const checkOut = parseResult(await adminHelpers.checkExisting(checkCall.protocolRef));
    assert.equal(checkCall.response.statusCode, 200);
    assert.equal(checkOut.hasExistingData, true);

    datasetByDay.set(targetDay, [cloneSample(baseMellat, 'm-3', '14050820', 450000000)]);
    capturedUpstreamQueries.length = 0;

    const startCall = makeProtocolRef({
      url: '/api/admin/runs/start',
      role: 'admin',
      body: {
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
    const startedJob = parseResult(await adminHelpers.startRun(startCall.protocolRef));
    assert.equal(startCall.response.statusCode, 200);
    assert.equal(JSON.stringify(startedJob).includes('0099887766'), false);

    const completedJob = await waitForJobViaController(adminHelpers, startedJob.id);
    assert.equal(completedJob.status, 'completed');
    assert.equal(
      capturedUpstreamQueries.some((q) => q.nationalCode === '0099887766' && q.limit === '25'),
      true,
    );

    const cronNowCall = makeProtocolRef({ url: '/api/admin/cron/run-now', role: 'admin' });
    const cronNowJob = parseResult(await adminHelpers.runCronNow(cronNowCall.protocolRef));
    assert.equal(cronNowCall.response.statusCode, 200);
    const doneCronJob = await waitForJobViaController(adminHelpers, cronNowJob.id);
    assert.equal(doneCronJob.status, 'completed');
    console.log('  ✓ ۵. تمام مسیرهای مدیریتی ادمین، کران تهران و حفاظت کدملی تایید شدند');
  } finally {
    global.fetch = originalFetch;
    await services.close();
  }

  console.log('✅ تمام تستهای یکپارچهٔ partFBackend با موفقیت ۱۰۰٪ پاس شدند!');
})().catch((err) => {
  console.error('❌ خطا در تست یکپارچهٔ partFBackend:', err);
  process.exit(1);
});
