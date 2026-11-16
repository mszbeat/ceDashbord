'use strict';

/**
 * تست اجرایی کنترلرها با شبیه‌سازی تزریق پارامترهای partFramework (`needProtocolRef: false`).
 * سرویس‌های دامنه با کانتینر جعلی جایگزین می‌شوند تا منطق هندلرها مستقل بررسی شود.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const path0 = require('node:path');
const frameworkMock = require(path0.join(__dirname, 'support', 'framework-mock'));
const ROOT = path.join(__dirname, '..');

const restore = frameworkMock.install();
const container = require(path.join(ROOT, 'services', 'container'));

/**
 * مقدار هر توکن config.params را می‌سازد و هندلر را مثل فریم‌ورک صدا می‌زند.
 */
function invoke(controller, config, handlerName, input = {}) {
  const { url = '/', queryString = {}, params = {}, data = {}, headers = {} } = input;
  const session = input.session || { samadUsername: 'admin-user', roles: ['admin'] };

  const response = {
    headers: {},
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
  };
  const request = {
    url,
    queryString,
    params,
    data,
    postData: data,
    headers: { 'user-agent': 'pd2-test', ...headers },
    ip: '127.0.0.1',
  };
  const inputData = { header: request.headers, params, queryString, data };

  const tokenMap = {
    '_protocolRef.request': request,
    '_protocolRef.request.data': data,
    '_protocolRef.request.queryString': queryString,
    '_protocolRef.response': response,
    '_inputData': inputData,
    '_session': session,
    '_trackingHeaders': {},
  };

  const args = config.handlers[handlerName].params.map((token) => {
    assert.ok(token in tokenMap, `unsupported param token ${token}`);
    return tokenMap[token];
  });

  // فراخوانی ناهمگام تا خطاهای همگام هندلر هم به‌صورت reject ظاهر شوند
  const promise = (async () => controller[handlerName](...args))();
  return { promise, response };
}

function extractRefreshCookieValue(response) {
  const setCookie = response.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = list.find((item) => String(item).startsWith('ce_refresh='));
  if (!hit) return null;
  const raw = String(hit).split(';')[0].slice('ce_refresh='.length);
  return decodeURIComponent(raw);
}

function fakeSummaryService(overrides = {}) {
  return {
    banks: () => [{ key: 'tavan_mellat' }, { key: 'tavan_resalat' }, { key: 'tavan_postbank' }],
    specs: (bank) => ({ bank: { key: bank } }),
    report: async () => '<!doctype html><html><body><a href="/api/sample/m-1">x</a></body></html>',
    errorHtml: () => '<!doctype html><html><body>error</body></html>',
    diagnostics: async () => ({ ok: true }),
    summary: async () => ({ stats: { total: 2 } }),
    list: async () => ({ total: 2, rows: [] }),
    runs: async () => [],
    sample: async (requestId) => ({ found: true, requestId }),
    ...overrides,
  };
}

function fakeAdminService(overrides = {}) {
  const jobs = new Map([['job-1', { id: 'job-1', status: 'completed', totalSteps: 1 }]]);
  return {
    getOverview: async (meta) => ({ banks: [1, 2, 3], actor: meta?.actor }),
    getCronConfig: async () => ({ timezone: 'Asia/Tehran', effective_cron_expr: '0 2 * * *' }),
    updateCronConfig: async (body) => ({ ...body, effective_cron_expr: '30 3 * * *' }),
    triggerCronExecution: async () => ({ id: 'job-1', status: 'running', totalSteps: 1 }),
    checkExistingData: async () => ({ hasExistingData: true }),
    startManualRun: async (body) => ({ id: 'job-1', status: 'running', totalSteps: 1, banks: body.banks }),
    listJobs: async () => [...jobs.values()],
    getJob: async (id) => {
      const job = jobs.get(id);
      if (!job) {
        const { error: adminError } = require(path.join(ROOT, 'controllers', 'adminController', 'config'));
        throw adminError.jobNotFound(id);
      }
      return job;
    },
    ...overrides,
  };
}

test('auth-controller: register/login/refresh/logout/me/role/removeUser با تزریق _session و رفرش‌توکن', async () => {
  const { controller: AuthController } = require(path.join(ROOT, 'controllers', 'auth', 'main.js'));
  const authConfig = require(path.join(ROOT, 'controllers', 'auth', 'config.js'));

  const sessionStore = { samadUsername: 'visitor', roles: ['visitor'] };
  const session = {
    set(values, cb) { Object.assign(sessionStore, values); cb(null, sessionStore); },
    get(keys, cb) { const out = {}; for (const k of keys) out[k] = sessionStore[k]; cb(null, out); },
    remove(cb) { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; cb(null, ['OK']); },
  };

  const authCalls = [];
  const authService = {
    async addUser(payload, headers) { authCalls.push(['add', payload, headers]); return { id: '1' }; },
    async authenticate(payload) { authCalls.push(['auth', payload]); return { id: '1' }; },
    async removeUser(payload) { authCalls.push(['remove', payload]); return { removed: true }; },
  };
  const samadUsers = new Map();
  const samadService = {
    async addUser(username, role) { samadUsers.set(username, role); return () => samadUsers.delete(username); },
    async setRole(username, role) { samadUsers.set(username, role); return () => samadUsers.delete(username); },
    async getRole(username) { return samadUsers.has(username) ? [samadUsers.get(username)] : []; },
    async removeUser(username) { samadUsers.delete(username); return 'ok'; },
  };

  const SessionManager = require(path.join(ROOT, 'controllers', 'auth', 'session-manager'));
  const sessionManager = new SessionManager({ useMemoryOnly: true });
  const controller = new AuthController({}, {}, authConfig, authService, sessionManager, samadService);

  // register
  const registerOut = await invoke(controller, authConfig, 'register', {
    data: { username: 'ali', password: 'p1', role: 'creditEvaluation' },
    session,
  }).promise;
  assert.deepEqual(registerOut, { status: 'ok', username: 'ali', roles: ['creditEvaluation'] });
  assert.equal(sessionStore.samadUsername, 'ali');
  assert.deepEqual(samadUsers.get('ali'), 'creditEvaluation');
  assert.equal(authCalls[0][0], 'add');

  // me
  const meOut = await invoke(controller, authConfig, 'me', { session }).promise;
  assert.equal(meOut.authenticated, true);
  assert.equal(meOut.username, 'ali');

  // role (POST) → تغییر نقش + به‌روزرسانی سشن خود کاربر
  const roleOut = await invoke(controller, authConfig, 'assignRole', {
    data: { username: 'ali', role: 'admin' },
    session,
  }).promise;
  assert.deepEqual(roleOut.roles, ['admin']);
  assert.deepEqual(sessionStore.roles, ['admin']);

  // role (GET)
  const getRoleOut = await invoke(controller, authConfig, 'getRole', { queryString: { username: 'ali' } }).promise;
  assert.deepEqual(getRoleOut, { username: 'ali', roles: ['admin'] });

  // login → صدور کوکی رفرش‌توکن
  const loginCall = invoke(controller, authConfig, 'login', {
    data: { username: 'ali', password: 'p1', rememberMe: true },
    session,
  });
  const loginOut = await loginCall.promise;
  assert.deepEqual(loginOut.roles, ['admin']);
  assert.equal(loginOut.authenticated, true);
  const refreshToken1 = extractRefreshCookieValue(loginCall.response);
  assert.ok(refreshToken1 && refreshToken1.length > 20);

  // شبیه‌سازی انقضای سشن کوتاه‌مدت (تبدیل شدن سشن به visitor)
  sessionStore.samadUsername = 'visitor';
  sessionStore.roles = ['visitor'];
  const expiredMe = await invoke(controller, authConfig, 'me', {
    session,
    headers: { cookie: `ce_refresh=${encodeURIComponent(refreshToken1)}` },
  }).promise;
  assert.equal(expiredMe.authenticated, false);
  assert.equal(expiredMe.canRefresh, true);

  // refresh → بازیابی سشن کاربر و چرخش رفرش‌توکن
  const refreshCall = invoke(controller, authConfig, 'refresh', {
    session,
    headers: { cookie: `ce_refresh=${encodeURIComponent(refreshToken1)}` },
  });
  const refreshOut = await refreshCall.promise;
  assert.equal(refreshOut.authenticated, true);
  assert.equal(refreshOut.username, 'ali');
  assert.deepEqual(refreshOut.roles, ['admin']);
  assert.equal(sessionStore.samadUsername, 'ali');
  const refreshToken2 = extractRefreshCookieValue(refreshCall.response);
  assert.ok(refreshToken2 && refreshToken2 !== refreshToken1);

  // استفادهٔ مجدد از رفرش‌توکن قبلی باید خطای 401 بدهد و خانواده را باطل کند
  await assert.rejects(
    () => invoke(controller, authConfig, 'refresh', {
      session,
      headers: { cookie: `ce_refresh=${encodeURIComponent(refreshToken1)}` },
    }).promise,
    (err) => err.statusCode === 401,
  );

  // logout → پاک‌سازی سشن و هر دو کوکی
  const logoutCall = invoke(controller, authConfig, 'logout', {
    session,
    headers: { cookie: `ce_refresh=${encodeURIComponent(refreshToken2)}` },
  });
  const logoutOut = await logoutCall.promise;
  assert.deepEqual(logoutOut, { status: 'ok' });
  assert.match(String(logoutCall.response.headers['set-cookie'][0]), /Max-Age=0/);
  assert.equal((await invoke(controller, authConfig, 'me', { session }).promise).authenticated, false);

  // remove → حذف از اصالت‌سنجی، سمد و ابطال رفرش‌توکن‌ها
  const removeOut = await invoke(controller, authConfig, 'removeUser', {
    data: { username: 'ali' },
    session,
  }).promise;
  assert.deepEqual(removeOut, { status: 'ok', username: 'ali' });
  assert.equal(samadUsers.has('ali'), false);
  assert.equal(authCalls.some(([kind, payload]) => kind === 'remove' && payload.username === 'ali'), true);
});

test('summary-controller: هر ۸ هندلر با پارامترهای تزریقی پاسخ درست می‌دهد', async () => {
  const { controller: SummaryController } = require(path.join(ROOT, 'controllers', 'summaryController', 'main.js'));
  const config = require(path.join(ROOT, 'controllers', 'summaryController', 'config.js'));
  const controller = new SummaryController({}, {}, config);

  container.setServicesForTest({ summary: fakeSummaryService() });
  try {
    assert.equal((await invoke(controller, config, 'health').promise).ok, true);
    assert.equal((await invoke(controller, config, 'health').promise).service, 'ce-dashboard-backend');
    assert.equal((await invoke(controller, config, 'banks').promise).length, 3);
    assert.equal((await invoke(controller, config, 'specs', { queryString: { bank: 'tavan_mellat' } }).promise).bank.key, 'tavan_mellat');
    assert.equal((await invoke(controller, config, 'summary', { queryString: { bank: 'tavan_mellat' } }).promise).stats.total, 2);
    assert.equal((await invoke(controller, config, 'list', { queryString: { bank: 'tavan_mellat' } }).promise).total, 2);
    assert.equal((await invoke(controller, config, 'diagnostics').promise).ok, true);
    assert.deepEqual(await invoke(controller, config, 'runs').promise, []);

    const report = await invoke(controller, config, 'report', { queryString: { bank: 'tavan_mellat' } }).promise;
    assert.equal(report.statusCode, 200);
    assert.match(report.headers['Content-Type'], /text\/html/);
    assert.match(report.data, /<!doctype html>/);
  } finally {
    container.setServicesForTest(undefined);
  }
});

test('summary-controller: خطای ساخت گزارش به صفحهٔ HTML با status 503 تبدیل می‌شود', async () => {
  const { controller: SummaryController } = require(path.join(ROOT, 'controllers', 'summaryController', 'main.js'));
  const config = require(path.join(ROOT, 'controllers', 'summaryController', 'config.js'));
  const controller = new SummaryController({}, {}, config);

  container.setServicesForTest({
    summary: fakeSummaryService({
      report: async () => {
        throw new Error('db down');
      },
    }),
  });
  try {
    const result = await invoke(controller, config, 'report', {}).promise;
    assert.equal(result.statusCode, 503);
    assert.match(result.data, /error/);
  } finally {
    container.setServicesForTest(undefined);
  }
});

test('credit-evaluation-controller: requestId از مسیر خوانده می‌شود و نبود آن خطای ۴۰۰ می‌دهد', async () => {
  const { controller: CEController } = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'main.js'));
  const config = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'config.js'));
  const controller = new CEController({}, {}, config);

  container.setServicesForTest({ summary: fakeSummaryService() });
  try {
    const ok = await invoke(controller, config, 'sample', {
      url: '/api/sample/m-1',
      params: { requestId: 'm-1' },
    }).promise;
    assert.deepEqual(ok, { found: true, requestId: 'm-1' });
  } finally {
    container.setServicesForTest(undefined);
  }

  try {
    await assert.rejects(
      () => invoke(controller, config, 'sample', { url: '/api/sample/' }).promise,
      (err) => err.statusCode === 400 && err.meta.code === 'requestIdRequired',
    );
  } finally {
    container.setServicesForTest(undefined);
  }
});

test('admin-controller: همهٔ ۱۰ هندلر با تزریق _session و data کار می‌کنند (پنل، کران، جاب‌ها)', async () => {
  const { controller: AdminController } = require(path.join(ROOT, 'controllers', 'adminController', 'main.js'));
  const config = require(path.join(ROOT, 'controllers', 'adminController', 'config.js'));
  const controller = new AdminController({}, {}, config);

  const runDayCalls = [];
  container.setServicesForTest({
    admin: fakeAdminService(),
    ingestion: {
      async runDay(bank, day, mode, options) {
        runDayCalls.push({ bank, day, mode, options });
        return { status: 'complete', success: 2 };
      },
    },
  });
  try {
    const overview = await invoke(controller, config, 'getOverview', { session: { samadUsername: 'adm' } }).promise;
    assert.equal(overview.banks.length, 3);
    assert.equal(overview.actor, 'adm');

    assert.equal((await invoke(controller, config, 'getCron').promise).timezone, 'Asia/Tehran');

    const cronPut = await invoke(controller, config, 'updateCron', {
      data: { enabled: true, schedule_mode: 'daily', hour: 3, minute: 30 },
      session: { samadUsername: 'adm' },
    }).promise;
    assert.equal(cronPut.effective_cron_expr, '30 3 * * *');

    assert.equal((await invoke(controller, config, 'runCronNow', { session: { samadUsername: 'adm' } }).promise).id, 'job-1');
    assert.equal((await invoke(controller, config, 'checkExisting', { data: { banks: ['tavan_mellat'] } }).promise).hasExistingData, true);
    assert.equal((await invoke(controller, config, 'startRun', { data: { banks: ['tavan_mellat'] }, session: {} }).promise).id, 'job-1');
    assert.equal((await invoke(controller, config, 'listJobs').promise).length, 1);

    const job = await invoke(controller, config, 'getJob', { url: '/api/admin/jobs/job-1', params: { id: 'job-1' } }).promise;
    assert.equal(job.status, 'completed');
    await assert.rejects(
      () => invoke(controller, config, 'getJob', { url: '/api/admin/jobs/none', params: { id: 'none' } }).promise,
      (err) => err.statusCode === 404 && err.meta.code === 'jobNotFound',
    );

    const runOut = await invoke(controller, config, 'run', {
      data: { bank: 'tavan_mellat', day: '1405-08-20', mode: 'nightly' },
    }).promise;
    assert.equal(runOut.status, 'complete');
    assert.deepEqual(runDayCalls.at(-1), {
      bank: 'tavan_mellat',
      day: '1405-08-20',
      mode: 'nightly',
      options: { rebuild: false, filters: undefined },
    });

    await assert.rejects(
      () => invoke(controller, config, 'runAdminDay', { data: { bank: 'tavan_mellat', rebuild: true } }).promise,
      (err) => err.statusCode === 400 && err.meta.code === 'rebuildRequiresExplicitDay',
    );
  } finally {
    container.setServicesForTest(undefined);
  }
});

test('http/result.js: نبود HttpResult در فریم‌ورک باعث بازگرداندن HTML خام می‌شود (نه LocalHttpResult) و امضاهای HttpResult درست تطبیق داده می‌شوند', () => {
  const Module = require('node:module');
  const httpResultMod = require(path.join(ROOT, 'services', 'http', 'result.js'));
  const { resetHttpResultCacheForTest, sendHtml, instantiateHttpResult } = httpResultMod;

  // الف) شبیه‌سازی نبودن HttpResult در هیچ پکیج پارت (رفتار واقعی @partFramework/http@1.25.0)
  const prevLoad = Module._load;
  Module._load = function emptyLoad(request, parent, isMain) {
    if (request.includes('partFramework') || request.includes('partUtilities')) {
      return {};
    }
    return prevLoad.call(this, request, parent, isMain);
  };
  resetHttpResultCacheForTest();
  try {
    const response = { headers: {}, statusCode: 0, setHeader(k, v) { this.headers[k] = v; } };
    const out = sendHtml('<!doctype html><html>ok</html>', 200, response);
    assert.equal(typeof out, 'string');
    assert.equal(out, '<!doctype html><html>ok</html>');
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['Content-Type'], /text\/html/);
  } finally {
    Module._load = prevLoad;
    resetHttpResultCacheForTest();
  }

  // ب) تطبیق امضاهای مختلف سازندهٔ HttpResult
  class PositionalHeaderFirst {
    constructor(body, headers, status) {
      this.body = body;
      this.headers = headers;
      this.status = status;
    }
  }
  const r1 = instantiateHttpResult(PositionalHeaderFirst, '<html>a</html>', 200, { 'Content-Type': 'text/html' }, 'text/html');
  assert.equal(r1.body, '<html>a</html>');
  assert.equal(r1.status, 200);
  assert.equal(r1.headers['Content-Type'], 'text/html');

  class DestructuredCtor {
    constructor({ data, statusCode, headers }) {
      this.data = data;
      this.statusCode = statusCode;
      this.headers = headers;
    }
  }
  const r2 = instantiateHttpResult(DestructuredCtor, '<html>b</html>', 503, { 'Content-Type': 'text/html' }, 'text/html');
  assert.equal(r2.data, '<html>b</html>');
  assert.equal(r2.statusCode, 503);
  assert.equal(r2.headers['Content-Type'], 'text/html');
});

test.after(() => restore());
