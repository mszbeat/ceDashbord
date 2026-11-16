#!/usr/bin/env node
/**
 * تست یکپارچهٔ سرتاسری pd2 روی PostgreSQL درون‌حافظه‌ای (PGlite) — بدون نیاز به سرور واقعی:
 *
 *  ۱. تقویم شمسی، مرز نیمه‌شب تهران و موتور کران
 *  ۲. موتور ارزیابی روی نمونه‌های هر ۳ بانک + حذف کدملی از خروجی
 *  ۳. کنترلرها با تزریق پارامترهای `partFramework` (`needProtocolRef: false`):
 *     adminController (دریافت داده + rollback اتمیک rebuild) و summaryController
 *  ۴. پنل مدیریت، محافظ تداخل داده (EXISTING_DATA_CONFLICT → Upsert/Rebuild)، حفاظت کدملی و کران
 *  ۵. مسیرها/کنترلرها: بررسی مرکزی‌بودن routes.js و الزام checkAccess(true) روی روت‌های سشن‌دار
 *
 * اگر `@electric-sql/pglite` نصب نباشد، بخش دیتابیس رد (skip) می‌شود و فقط
 * بررسی‌های ساختاری اجرا می‌گردند.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, '..', 'samples');

// شبیه‌سازی حداقلی پکیج‌های پارت برای محیط بدون رجیستری سازمانی
require(path.join(ROOT, 'tests', 'support', 'framework-mock')).install();

function loadPGlite() {
  for (const candidate of [
    '@electric-sql/pglite',
    path.join(ROOT, '..', 'backend', 'node_modules', '@electric-sql', 'pglite'),
  ]) {
    try {
      return require(candidate).PGlite;
    } catch {
      // ادامه با گزینهٔ بعدی
    }
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
        const result = await pg.query(text, params);
        return { rows: result.rows || [], rowCount: result.affectedRows ?? (result.rows || []).length };
      });
    },
    async getClient() {
      let releaseLock;
      const previous = queue;
      queue = new Promise((resolve) => {
        releaseLock = resolve;
      });
      await previous;
      return {
        async query(text, params = []) {
          const result = await pg.query(text, params);
          return { rows: result.rows || [], rowCount: result.affectedRows ?? (result.rows || []).length };
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
 * شبیه‌ساز تزریق‌گر پارامترهای partFramework بر اساس `config.handlers[name].params`.
 */
function invokeWithConfigParams(ctrlConfig, ctrlHelpers, handlerName, input = {}) {
  const { url = '/', queryString = {}, params = {}, data = {} } = input;
  const handlerCfg = ctrlConfig.handlers[handlerName];
  assert.ok(handlerCfg, `Missing handler config for ${handlerName}`);
  assert.equal(handlerCfg.needProtocolRef, false, `${handlerName} must use needProtocolRef: false`);

  const response = {
    headers: {},
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
  };
  const request = {
    url,
    queryString,
    params,
    data,
    postData: data,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'pd2-verify-suite' },
  };
  const inputData = { header: request.headers, params, queryString, data };

  const tokenMap = {
    '_protocolRef.request': request,
    '_protocolRef.request.data': data,
    '_protocolRef.request.queryString': queryString,
    '_protocolRef.response': response,
    '_inputData': inputData,
    '_session': { samadUsername: 'verify-admin', roles: ['admin'] },
    '_trackingHeaders': {},
  };

  const args = handlerCfg.params.map((token) => {
    assert.equal(token in tokenMap, true, `Unsupported param token: ${token}`);
    return tokenMap[token];
  });

  return { promise: (async () => ctrlHelpers[handlerName](...args))(), response };
}

function parseResult(result) {
  if (result && typeof result === 'object' && typeof result.data === 'string' && 'statusCode' in result) {
    try {
      return JSON.parse(result.data);
    } catch {
      return result.data;
    }
  }
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function cloneSample(base, id, ymdDigits, amount = 500000000, extra = {}) {
  const sample = JSON.parse(JSON.stringify(base));
  sample.requestId = id;
  if (sample.input && typeof sample.input === 'object') {
    sample.input.uniqueKey = extra.uniqueKey || `uk-${id}`;
    if (extra.nationalCode) sample.input.nationalCode = extra.nationalCode;
  }
  sample.insertDate_full = `${ymdDigits}101500001`;
  sample.insertDate_yearMonthDay = ymdDigits;
  if (sample.output && typeof sample.output === 'object') sample.output.Credit_Basket = amount;
  if (extra.nationalCode) sample.nationalCode = extra.nationalCode;
  return sample;
}

async function waitForJob(adminConfig, adminHelpers, jobId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = invokeWithConfigParams(adminConfig, adminHelpers, 'getJob', {
      url: `/api/admin/jobs/${jobId}`,
      params: { id: jobId },
    });
    const job = parseResult(await call.promise);
    assert.equal(call.response.headers['content-type'], undefined);
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timeout waiting for job ${jobId}`);
}

(async () => {
  // ── ۰. بررسی ساختاری مسیرها (بدون دیتابیس) ──
  const recorded = [];
  let chain = null;
  const router = {
    setRoute(url, target) {
      chain = { url, target, verb: null, validate: false, checkAccess: false };
      recorded.push(chain);
      return {
        method(verb) { chain.verb = String(verb).toUpperCase(); return this; },
        validate() { chain.validate = true; return this; },
        checkAccess(flag) { chain.checkAccess = flag !== false; return this; },
      };
    },
  };
  require(path.join(ROOT, 'routes.js'))(router);
  assert.equal(recorded.length, 27, 'routes.js must register 27 routes');

  const controllers = {
    'auth-controller': 'auth',
    'summary-controller': 'summaryController',
    'credit-evaluation-controller': 'creditEvaluationController',
    'admin-controller': 'adminController',
  };
  for (const route of recorded) {
    const [controllerName, handlerName] = route.target.split('.');
    const dir = controllers[controllerName];
    const config = require(path.join(ROOT, 'controllers', dir, 'config.js'));
    assert.ok(config.handlers[handlerName], `routes.js references unknown handler ${route.target}`);
    if (config.handlers[handlerName].params.includes('_session')) {
      assert.equal(route.checkAccess, true, `${route.target} needs checkAccess(true) to receive _session`);
    }
    assert.equal(route.verb, route.verb.toUpperCase());
  }

  const routerConf = require(path.join(ROOT, 'project-config', 'dev', 'routerConf.js'));
  assert.equal(path.resolve(routerConf.routerPath), path.join(ROOT, 'routes.js'));
  assert.ok(routerConf.accessControl?.partSessionManagerConfig);
  assert.ok(routerConf.accessControl?.partSecurityConfig);

  for (const dir of Object.values(controllers)) {
    const mainSource = fs.readFileSync(path.join(ROOT, 'controllers', dir, 'main.js'), 'utf8');
    assert.equal(/@Route|@HTTP/.test(mainSource), false, `${dir}/main.js must be decorator-free`);
    assert.match(mainSource, /BaseController\.exportedProperties\(/);
    const config = require(path.join(ROOT, 'controllers', dir, 'config.js'));
    assert.equal(typeof config.exception?.handler, 'function');
  }
  console.log('  ✓ ۰. routes.js مرکزی، accessControl و کنترلرهای بدون دکوراتور تایید شدند');

  const PGlite = loadPGlite();
  if (!PGlite) {
    console.log('ℹ️ @electric-sql/pglite نصب نیست؛ بخش دیتابیس تست یکپارچه رد شد.');
    console.log('✅ بررسی‌های ساختاری pd2 با موفقیت انجام شد!');
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
  assert.deepEqual(enumerateJalaliDays('1405-07-29', '1405-08-01'), ['1405-07-29', '1405-07-30', '1405-08-01']);
  assert.equal(validateCronExpr('0 2 * * *').valid, true);
  assert.equal(validateCronExpr('99 2 * * *').valid, false);
  assert.equal(nextCronRun('30 2 * * *', new Date('2026-11-14T10:00:00Z')).time, '02:30');
  assert.notEqual(
    tehranToday(new Date('2026-04-16T19:00:00Z')),
    tehranToday(new Date('2026-04-16T21:00:00Z')),
    'Tehran midnight must advance at 20:30Z',
  );
  console.log('  ✓ ۱. تقویم شمسی، مرز نیمه‌شب تهران و موتور Cron تایید شدند');

  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'services', 'db', 'schema.sql'), 'utf8'));
  const db = makeDbAdapter(pg);

  const container = require(path.join(ROOT, 'services', 'container'));
  const services = container.createServices({ db, enableCron: false });
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
    const withNationalCode = cloneSample(raw, `chk-${bankKey}`, '14050820', 400000000, { nationalCode: '0012345678' });
    const normalized = services.evaluator.normalizeSample(withNationalCode, { fromApi: true });
    const row = services.evaluator.evaluate(normalized, services.evaluator.isReportSuccess(normalized), '1405-08-20', bankKey);
    assert.equal(JSON.stringify(row).includes('0012345678'), false, 'nationalCode must never be persisted');
    assert.equal(row.request_id, `chk-${bankKey}`);
    assert.equal(row.day, '1405-08-20');
  }
  console.log('  ✓ ۲. موتور ارزیابی هر ۳ بانک و حذف کدملی تایید شدند');

  const capturedQueries = [];
  const datasetByDay = new Map();
  const targetDay = '1405-08-20';
  datasetByDay.set(targetDay, [
    cloneSample(baseMellat, 'm-1', '14050820', 150000000),
    cloneSample(baseMellat, 'm-1', '14050820', 250000000),
    cloneSample(baseMellat, 'm-2', '14050820', 350000000),
  ]);

  let failNextUpstream = false;
  const originalFetch = global.fetch;
  global.fetch = async (urlStr) => {
    const parsed = new URL(urlStr);
    const query = Object.fromEntries(parsed.searchParams.entries());
    capturedQueries.push(query);
    if (failNextUpstream) {
      return { ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({}) };
    }
    const dayKey = query.date ? query.date.replace(/\//g, '-') : null;
    let list = dayKey ? datasetByDay.get(dayKey) || [] : [...datasetByDay.values()].flat();
    if (query.requestId) list = list.filter((item) => item.requestId === query.requestId);
    if (query.uniqueKey) list = list.filter((item) => item.input?.uniqueKey === query.uniqueKey);
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 50);
    const start = (page - 1) * limit;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: { count: list.length, reportResults: list.slice(start, start + limit) } }),
    };
  };

  try {
    const summaryConfig = require(path.join(ROOT, 'controllers', 'summaryController', 'config'));
    const summaryHelpers = require(path.join(ROOT, 'controllers', 'summaryController', 'helpers'));
    const ceConfig = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'config'));
    const ceHelpers = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'helpers'));
    const adminConfig = require(path.join(ROOT, 'controllers', 'adminController', 'config'));
    const adminHelpers = require(path.join(ROOT, 'controllers', 'adminController', 'helpers'));

    // ── ۳. دریافت داده + Rollback اتمیک ──
    const badRebuild = invokeWithConfigParams(adminConfig, adminHelpers, 'runAdminDay', {
      data: { bank: 'tavan_mellat', rebuild: true },
    });
    await assert.rejects(() => badRebuild.promise, (err) => err.statusCode === 400);

    const runCall = invokeWithConfigParams(adminConfig, adminHelpers, 'runAdminDay', {
      data: { bank: 'tavan_mellat', day: targetDay, mode: 'nightly', rebuild: false },
    });
    const runOut = parseResult(await runCall.promise);
    assert.equal(runOut.status, 'complete');
    assert.equal(runOut.success, 2);

    failNextUpstream = true;
    const failedRebuild = invokeWithConfigParams(adminConfig, adminHelpers, 'run', {
      data: { bank: 'tavan_mellat', day: targetDay, mode: 'nightly', rebuild: true },
    });
    await assert.rejects(() => failedRebuild.promise, (err) => err.statusCode === 503);
    failNextUpstream = false;

    const preserved = await db.query('SELECT COUNT(*)::int AS cnt FROM samples_mellat WHERE day = $1', [targetDay]);
    assert.equal(preserved.rows[0].cnt, 2, 'atomic rebuild must keep previous rows on upstream failure');
    console.log('  ✓ ۳. مسیرهای دریافت داده و Rollback اتمیک rebuild تایید شدند');

    // ── ۴. summaryController و creditEvaluationController ──
    assert.equal(parseResult(await invokeWithConfigParams(summaryConfig, summaryHelpers, 'health').promise).ok, true);
    assert.equal(parseResult(await invokeWithConfigParams(summaryConfig, summaryHelpers, 'banks').promise).length, 3);
    assert.equal(
      parseResult(await invokeWithConfigParams(summaryConfig, summaryHelpers, 'specs', { queryString: { bank: 'tavan_mellat' } }).promise).bank.key,
      'tavan_mellat',
    );

    const reportCall = invokeWithConfigParams(summaryConfig, summaryHelpers, 'report', {
      queryString: { bank: 'tavan_mellat', from: targetDay, to: targetDay },
    });
    const reportResult = await reportCall.promise;
    assert.equal(reportResult.statusCode, 200);
    assert.match(reportResult.headers['Content-Type'], /text\/html/);
    assert.equal(reportResult.data.includes('/api/sample/'), true);

    assert.equal((await invokeWithConfigParams(summaryConfig, summaryHelpers, 'diagnostics').promise).ok, true);
    assert.equal(
      parseResult(await invokeWithConfigParams(summaryConfig, summaryHelpers, 'summary', { queryString: { bank: 'tavan_mellat', from: targetDay, to: targetDay } }).promise).stats.total,
      2,
    );
    assert.equal(
      parseResult(await invokeWithConfigParams(summaryConfig, summaryHelpers, 'list', { queryString: { bank: 'tavan_mellat', from: targetDay, to: targetDay, limit: '10', offset: '0' } }).promise).total,
      2,
    );
    assert.equal(Array.isArray(parseResult(await invokeWithConfigParams(summaryConfig, summaryHelpers, 'runs').promise)), true);

    const sampleFound = parseResult(
      await invokeWithConfigParams(ceConfig, ceHelpers, 'sample', { url: '/api/sample/m-1', params: { requestId: 'm-1' } }).promise,
    );
    assert.equal(sampleFound.found, true);
    assert.equal(sampleFound.requestId, 'm-1');
    console.log('  ✓ ۴. summaryController و creditEvaluationController با پارامترهای تزریقی تایید شدند');

    // ── ۵. adminController: پنل، تداخل داده، کدملی، کران ──
    const overview = parseResult(await invokeWithConfigParams(adminConfig, adminHelpers, 'getOverview').promise);
    assert.equal(overview.banks.length, 3);
    assert.equal(parseResult(await invokeWithConfigParams(adminConfig, adminHelpers, 'getCron').promise).timezone, 'Asia/Tehran');

    const cronPut = parseResult(
      await invokeWithConfigParams(adminConfig, adminHelpers, 'updateCron', {
        data: { enabled: true, schedule_mode: 'daily', hour: 3, minute: 30, banks: ['tavan_mellat'], target_offset_days: 1, rebuild: false },
      }).promise,
    );
    assert.equal(cronPut.effective_cron_expr, '30 3 * * *');

    const check = parseResult(
      await invokeWithConfigParams(adminConfig, adminHelpers, 'checkExisting', {
        data: { banks: ['tavan_mellat'], dateScope: 'single', day: targetDay },
      }).promise,
    );
    assert.equal(check.hasExistingData, true);

    const unconfirmed = invokeWithConfigParams(adminConfig, adminHelpers, 'startRun', {
      data: { banks: ['tavan_mellat'], dateScope: 'single', day: targetDay },
    });
    await assert.rejects(() => unconfirmed.promise, (err) => err.statusCode === 400 && err.data.code === 'EXISTING_DATA_CONFLICT');

    datasetByDay.set(targetDay, [cloneSample(baseMellat, 'm-3', '14050820', 450000000)]);
    capturedQueries.length = 0;

    const startedJob = parseResult(
      await invokeWithConfigParams(adminConfig, adminHelpers, 'startRun', {
        data: {
          banks: ['tavan_mellat'],
          dateScope: 'single',
          day: targetDay,
          mode: 'nightly',
          conflictStrategy: 'rebuild',
          confirmedConflict: true,
          filters: { status: 'success', nationalCode: '۰۰۹۹۸۸۷۷۶۶', maxCount: 10, pageSize: 25 },
        },
      }).promise,
    );
    assert.equal(JSON.stringify(startedJob).includes('0099887766'), false, 'nationalCode must not be echoed back');

    const completedJob = await waitForJob(adminConfig, adminHelpers, startedJob.id);
    assert.equal(completedJob.status, 'completed');
    assert.equal(capturedQueries.some((q) => q.nationalCode === '0099887766' && q.limit === '25'), true);

    assert.equal(parseResult(await invokeWithConfigParams(adminConfig, adminHelpers, 'listJobs').promise).length >= 1, true);

    const cronNowJob = parseResult(await invokeWithConfigParams(adminConfig, adminHelpers, 'runCronNow').promise);
    const doneCronJob = await waitForJob(adminConfig, adminHelpers, cronNowJob.id);
    assert.equal(doneCronJob.status, 'completed');
    console.log('  ✓ ۵. پنل admin، محافظ تداخل داده، کران تهران و حفاظت کدملی تایید شدند');

    // ── ۶. رفرش‌توکن در دیتابیس (PGlite) ──
    const { RefreshTokenService } = require(path.join(ROOT, 'controllers', 'auth', 'refresh-token.service'));
    const rtService = new RefreshTokenService({ db });
    const issuedRt = await rtService.issue({ username: 'verify-admin', roles: ['admin'], rememberMe: true });
    assert.equal((await rtService.peek(issuedRt.rawToken)).valid, true);
    const rotatedRt = await rtService.rotate(issuedRt.rawToken, { roles: ['admin'] });
    assert.notEqual(rotatedRt.rawToken, issuedRt.rawToken);
    await assert.rejects(() => rtService.rotate(issuedRt.rawToken), (err) => err.statusCode === 401);
    console.log('  ✓ ۶. رفرش‌توکن، چرخش یکبارمصرف و تشخیص سوءاستفاده در دیتابیس تایید شدند');
  } finally {
    global.fetch = originalFetch;
    await services.close();
  }

  console.log('✅ تمام تست‌های یکپارچهٔ pd2 با موفقیت پاس شدند!');
})().catch((err) => {
  console.error('❌ خطا در تست یکپارچهٔ pd2:', err);
  process.exit(1);
});
