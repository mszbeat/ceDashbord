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
  /**
   * `remoteAddress` برای تست پل BFF لازم است: بک‌اند بدون کلید مشترک فقط درخواست
   * loopback را در حالت BFF می‌پذیرد. پیش‌فرض تست، loopback است تا رفتار «نصب
   * تک‌سروری» شبیه‌سازی شود؛ برای تست «درخواست از راه دور» مقدار دیگری بدهید.
   */
  const remoteAddress = input.remoteAddress || '127.0.0.1';
  const request = {
    url,
    queryString,
    params,
    data,
    postData: data,
    headers: { 'user-agent': 'pd2-test', ...headers },
    ip: remoteAddress,
    socket: { remoteAddress },
    connection: { remoteAddress },
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
    report: async () => '<!doctype html><html><body><a href="/api/sample?requestId=m-1">x</a></body></html>',
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

  // ثبت‌نام عمومی باید پیش از هرگونه ایجاد کاربر یا تغییر سشن رد شود.
  await assert.rejects(
    () => invoke(controller, authConfig, 'register', {
      data: { username: 'sara', password: 'p2', role: 'visitor', autoLogin: false },
      session,
    }).promise,
    (err) => err.statusCode === 403,
  );
  assert.equal(authCalls.some(([kind, payload]) => kind === 'add' && payload.username === 'sara'), false);
  assert.equal(samadUsers.has('sara'), false);

  // حساب‌های این تست مانند حساب‌های provision شدهٔ داخلی موجود هستند.
  samadUsers.set('ali', 'visitor');
  await sessionManager.setSession(session, { username: 'ali' }, ['visitor']);

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

  // پس از logout سشن خالی است؛ عملیات removeUser بدون سشن باید ۴۰۱ بدهد
  await assert.rejects(
    () => invoke(controller, authConfig, 'removeUser', { data: { username: 'ali' }, session }).promise,
    (err) => err.statusCode === 401,
  );

  // با سشن ادمین معتبر، removeUser کاربر را از اصالت‌سنجی و سمد حذف و رفرش‌توکن‌ها را باطل می‌کند
  sessionStore.samadUsername = 'ali';
  sessionStore.roles = ['admin'];
  const removeOut = await invoke(controller, authConfig, 'removeUser', {
    data: { username: 'ali' },
    session,
  }).promise;
  assert.deepEqual(removeOut, { status: 'ok', username: 'ali' });
  assert.equal(samadUsers.has('ali'), false);
  assert.equal(authCalls.some(([kind, payload]) => kind === 'remove' && payload.username === 'ali'), true);
});

test('auth-controller BFF bridge: فقط درخواست امضاشده (یا loopback بدون کلید) کوکی‌ها را در _ceSetCookies می‌گیرد', async () => {
  const { controller: AuthController } = require(path.join(ROOT, 'controllers', 'auth', 'main.js'));
  const authConfig = require(path.join(ROOT, 'controllers', 'auth', 'config.js'));
  const SessionManager = require(path.join(ROOT, 'controllers', 'auth', 'session-manager'));

  const sessionStore = { samadUsername: 'visitor', roles: ['visitor'] };
  const session = {
    set(values, cb) { Object.assign(sessionStore, values); cb(null, sessionStore); },
    get(keys, cb) { const out = {}; for (const k of keys) out[k] = sessionStore[k]; cb(null, out); },
    remove(cb) { sessionStore.samadUsername = 'visitor'; sessionStore.roles = ['visitor']; cb(null, ['OK']); },
  };
  const authService = {
    async addUser() { return { ok: true }; },
    async authenticate() { return { ok: true }; },
  };
  const samadService = {
    async addUser() { return () => {}; },
    async getRole() { return ['admin']; },
  };
  const sessionManager = new SessionManager({ useMemoryOnly: true });
  const controller = new AuthController({}, {}, authConfig, authService, sessionManager, samadService);

  // بدون x-ce-bff: 1 نباید _ceSetCookies برگردد
  const normalOut = await invoke(controller, authConfig, 'login', {
    data: { username: 'u1', password: 'p1', rememberMe: true },
    session,
  }).promise;
  assert.equal('_ceSetCookies' in normalOut, false);

  // حتی درخواست BFF معتبر نیز نباید از مسیر عمومی حساب بسازد.
  await assert.rejects(
    () => invoke(controller, authConfig, 'register', {
      data: { username: 'u2', password: 'p2', rememberMe: true },
      session,
      headers: { 'x-ce-bff': '1' },
      remoteAddress: '127.0.0.1',
    }).promise,
    (err) => err.statusCode === 403,
  );

  const loginBff = await invoke(controller, authConfig, 'login', {
    data: { username: 'u1', password: 'p1', rememberMe: true },
    session,
    headers: { 'x-ce-bff': '1' },
    remoteAddress: '127.0.0.1',
  }).promise;
  assert.equal(Array.isArray(loginBff._ceSetCookies), true);
  const bffRefreshLine = loginBff._ceSetCookies.find((c) => c.startsWith('ce_refresh='));
  assert.ok(bffRefreshLine && bffRefreshLine.includes('Path=/'));
  const rt1 = decodeURIComponent(bffRefreshLine.split(';')[0].slice('ce_refresh='.length));

  const refreshBff = await invoke(controller, authConfig, 'refresh', {
    session,
    headers: { 'x-ce-bff': '1', cookie: `ce_refresh=${encodeURIComponent(rt1)}` },
    remoteAddress: '127.0.0.1',
  }).promise;
  assert.equal(Array.isArray(refreshBff._ceSetCookies), true);
  assert.equal(refreshBff._ceSetCookies.some((c) => c.startsWith('ce_refresh=') && c.includes('Path=/')), true);

  const logoutBff = await invoke(controller, authConfig, 'logout', {
    session,
    headers: { 'x-ce-bff': '1', cookie: `ce_refresh=${encodeURIComponent(rt1)}` },
    remoteAddress: '127.0.0.1',
  }).promise;
  assert.equal(Array.isArray(logoutBff._ceSetCookies), true);
  assert.equal(logoutBff._ceSetCookies.some((c) => c.startsWith('token=;') && c.includes('Path=/') && c.includes('Max-Age=0')), true);
  assert.equal(logoutBff._ceSetCookies.some((c) => c.startsWith('ce_refresh=;') && c.includes('Path=/') && c.includes('Max-Age=0')), true);
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

  // کش بین تست‌ها به اشتراک گذاشته می‌شود؛ برای مسیر «خطا» باید خالی باشد
  require(path.join(ROOT, 'services', 'report', 'report-cache')).reportCache.clear();
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

test('credit-evaluation-controller: requestId از query param خوانده می‌شود و نبود آن خطای ۴۰۰ می‌دهد', async () => {
  const { controller: CEController } = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'main.js'));
  const config = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'config.js'));
  const controller = new CEController({}, {}, config);

  container.setServicesForTest({ summary: fakeSummaryService() });
  try {
    const ok = await invoke(controller, config, 'sample', {
      url: '/api/sample?requestId=m-1&bank=tavan_mellat',
      queryString: { requestId: 'm-1', bank: 'tavan_mellat' },
      session: { samadUsername: 'quality-user', roles: ['quality-reviewer'] },
    }).promise;
    assert.deepEqual(ok, { found: true, requestId: 'm-1' });

    // نام جایگزین id هم پذیرفته می‌شود
    const byId = await invoke(controller, config, 'sample', {
      url: '/api/sample?id=m-2',
      queryString: { id: 'm-2' },
    }).promise;
    assert.deepEqual(byId, { found: true, requestId: 'm-2' });
  } finally {
    container.setServicesForTest(undefined);
  }

  try {
    await assert.rejects(
      () => invoke(controller, config, 'sample', { url: '/api/sample' }).promise,
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
    const overview = await invoke(controller, config, 'getOverview', { session: { samadUsername: 'adm', roles: ['admin'] } }).promise;
    assert.equal(overview.banks.length, 3);
    assert.equal(overview.actor, 'adm');

    assert.equal((await invoke(controller, config, 'getCron').promise).timezone, 'Asia/Tehran');

    const cronPut = await invoke(controller, config, 'updateCron', {
      data: { enabled: true, schedule_mode: 'daily', hour: 3, minute: 30 },
      session: { samadUsername: 'adm', roles: ['admin'] },
    }).promise;
    assert.equal(cronPut.effective_cron_expr, '30 3 * * *');

    assert.equal((await invoke(controller, config, 'runCronNow', { session: { samadUsername: 'adm', roles: ['admin'] } }).promise).id, 'job-1');
    assert.equal((await invoke(controller, config, 'checkExisting', { data: { banks: ['tavan_mellat'] } }).promise).hasExistingData, true);
    await assert.rejects(
      () => invoke(controller, config, 'startRun', { data: { banks: ['tavan_mellat'] }, session: {} }).promise,
      (err) => err.statusCode === 401,
    );
    assert.equal((await invoke(controller, config, 'startRun', { data: { banks: ['tavan_mellat'] }, session: { samadUsername: 'adm', roles: ['admin'] } }).promise).id, 'job-1');
    assert.equal((await invoke(controller, config, 'listJobs', { session: { samadUsername: 'adm', roles: ['admin'] } }).promise).length, 1);

    const job = await invoke(controller, config, 'getJob', { url: '/api/admin/jobs?id=job-1', queryString: { id: 'job-1' }, session: { samadUsername: 'adm', roles: ['admin'] } }).promise;
    assert.equal(job.status, 'completed');
    await assert.rejects(
      () => invoke(controller, config, 'getJob', { url: '/api/admin/jobs?id=none', queryString: { id: 'none' }, session: { samadUsername: 'adm', roles: ['admin'] } }).promise,
      (err) => err.statusCode === 404 && err.meta.code === 'jobNotFound',
    );

    const runOut = await invoke(controller, config, 'run', {
      data: { bank: 'tavan_mellat', day: '1405-08-20', mode: 'nightly' },
      session: { samadUsername: 'adm', roles: ['admin'] },
    }).promise;
    assert.equal(runOut.status, 'complete');
    assert.deepEqual(runDayCalls.at(-1), {
      bank: 'tavan_mellat',
      day: '1405-08-20',
      mode: 'nightly',
      options: { rebuild: false, filters: undefined },
    });

    await assert.rejects(
      () => invoke(controller, config, 'runAdminDay', { data: { bank: 'tavan_mellat', rebuild: true }, session: { samadUsername: 'adm', roles: ['admin'] } }).promise,
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

  // ج) HTML نباید در پوشش JSON برود و هدر Content-Type باید واقعاً ست شود
  //    (باگ واقعی: بدنهٔ {"data":"<html>…"} با هدر text/html به مرورگر می‌رفت و
  //     چون `class=\"page\"` در HTML می‌شکست، هیچ CSS اعمال نمی‌شد)
  class CapturingHttpResult {
    constructor(data, statusCode, headers) {
      this.data = data;
      this.statusCode = statusCode;
      this.headers = headers;
    }
  }
  global.HttpResult = CapturingHttpResult;
  resetHttpResultCacheForTest();
  try {
    const html = '<!doctype html><html><body><div class="page">x</div></body></html>';
    const target = { headers: {}, statusCode: 0, setHeader(k, v) { this.headers[k] = v; } };
    const asHtml = sendHtml(html, 200, target);

    assert.equal(typeof asHtml.data, 'string', 'رشته همان‌طور پاس می‌شود');
    assert.equal(asHtml.data, html, 'HTML بدون escape و بدون JSON.stringify');
    assert.match(asHtml.headers['Content-Type'], /text\/html/, 'هدر HttpResult');
    assert.match(target.headers['Content-Type'], /text\/html/, 'هدر روی پاسخ خام');

    const asJson = httpResultMod.sendJson({ ok: true }, 200, null);
    assert.equal(typeof asJson.data, 'string');
    assert.deepEqual(JSON.parse(asJson.data), { ok: true });
    assert.match(asJson.headers['Content-Type'], /application\/json/);
  } finally {
    delete global.HttpResult;
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

test('session-guard: تمام روت‌های داشبورد/جزئیات/مدیریت بدون سشن احرازشده (visitor یا خالی) خطای ۴۰۱ می‌دهند و از session.get پشتیبانی می‌کنند', async () => {
  const { controller: SummaryController } = require(path.join(ROOT, 'controllers', 'summaryController', 'main.js'));
  const summaryConfig = require(path.join(ROOT, 'controllers', 'summaryController', 'config.js'));
  const summaryCtrl = new SummaryController({}, {}, summaryConfig);

  const { controller: CEController } = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'main.js'));
  const ceConfig = require(path.join(ROOT, 'controllers', 'creditEvaluationController', 'config.js'));
  const ceCtrl = new CEController({}, {}, ceConfig);

  const { controller: AdminController } = require(path.join(ROOT, 'controllers', 'adminController', 'main.js'));
  const adminConfig = require(path.join(ROOT, 'controllers', 'adminController', 'config.js'));
  const adminCtrl = new AdminController({}, {}, adminConfig);

  const { controller: AuthController } = require(path.join(ROOT, 'controllers', 'auth', 'main.js'));
  const authConfig = require(path.join(ROOT, 'controllers', 'auth', 'config.js'));
  const SessionManager = require(path.join(ROOT, 'controllers', 'auth', 'session-manager'));
  const authCtrl = new AuthController({}, {}, authConfig, {}, new SessionManager({ useMemoryOnly: true }), {});

  const callbackVisitorSession = {
    get(keys, cb) {
      cb(null, { samadUsername: 'visitor', roles: ['visitor'] });
    },
  };
  const callbackAdminSession = {
    get(keys, cb) {
      cb(null, { samadUsername: 'real-admin', roles: ['admin'] });
    },
  };

  // health همچنان بدون سشن مجاز است
  assert.equal((await invoke(summaryCtrl, summaryConfig, 'health', { session: callbackVisitorSession }).promise).ok, true);

  for (const [ctrl, cfg, handler, extra] of [
    [summaryCtrl, summaryConfig, 'banks', {}],
    [summaryCtrl, summaryConfig, 'specs', { queryString: { bank: 'tavan_mellat' } }],
    [summaryCtrl, summaryConfig, 'report', { queryString: { bank: 'tavan_mellat' } }],
    [summaryCtrl, summaryConfig, 'diagnostics', {}],
    [summaryCtrl, summaryConfig, 'summary', { queryString: { bank: 'tavan_mellat' } }],
    [summaryCtrl, summaryConfig, 'list', { queryString: { bank: 'tavan_mellat' } }],
    [summaryCtrl, summaryConfig, 'runs', {}],
    [ceCtrl, ceConfig, 'sample', { url: '/api/sample?requestId=m-1', queryString: { requestId: 'm-1' } }],
    [adminCtrl, adminConfig, 'getOverview', {}],
    [adminCtrl, adminConfig, 'getCron', {}],
    [adminCtrl, adminConfig, 'updateCron', { data: { enabled: true } }],
    [adminCtrl, adminConfig, 'runCronNow', {}],
    [adminCtrl, adminConfig, 'checkExisting', { data: { banks: ['tavan_mellat'] } }],
    [adminCtrl, adminConfig, 'startRun', { data: { banks: ['tavan_mellat'] } }],
    [adminCtrl, adminConfig, 'listJobs', {}],
    [adminCtrl, adminConfig, 'getJob', { url: '/api/admin/jobs?id=job-1', queryString: { id: 'job-1' } }],
    [adminCtrl, adminConfig, 'runAdminDay', { data: { bank: 'tavan_mellat' } }],
    [adminCtrl, adminConfig, 'run', { data: { bank: 'tavan_mellat' } }],
    [authCtrl, authConfig, 'assignRole', { data: { username: 'ali', role: 'admin' } }],
    [authCtrl, authConfig, 'getRole', { queryString: { username: 'ali' } }],
    [authCtrl, authConfig, 'removeUser', { data: { username: 'ali' } }],
  ]) {
    await assert.rejects(
      () => invoke(ctrl, cfg, handler, { ...extra, session: callbackVisitorSession }).promise,
      (err) => err.statusCode === 401,
      `${cfg.name}.${handler} must reject visitor session with 401`,
    );
  }

  // سشن callback-based معتبر (مثل خروجی واقعی partSessionManager) باید پذیرفته شود
  container.setServicesForTest({
    summary: fakeSummaryService(),
    admin: fakeAdminService(),
  });
  try {
    const overview = await invoke(adminCtrl, adminConfig, 'getOverview', { session: callbackAdminSession }).promise;
    assert.equal(overview.actor, 'real-admin');
    const banks = await invoke(summaryCtrl, summaryConfig, 'banks', { session: callbackAdminSession }).promise;
    assert.equal(banks.length, 3);
  } finally {
    container.setServicesForTest(undefined);
  }
});

test('gateway-client & per-bank HOST_NAME: هاست گزارش هر بانک + توکن گیت‌وی مستقل برای ملت و پست‌بانک و بدون گیت‌وی برای رسالت', async () => {
  const { gatewayTokenManager, isGatewayInvalidTokenResponse, fetchBankJson } = require(path.join(ROOT, 'services', 'http', 'gateway-client'));
  const { resolveBankApiUrl, resolveBankGatewayConfig, bankUsesGateway, parseDurationMs } = require(path.join(ROOT, 'services', 'config'));

  assert.equal(parseDurationMs('30m', 1000), 1800000);
  assert.equal(parseDurationMs('14d', 1000), 14 * 86400000);
  assert.equal(
    isGatewayInvalidTokenResponse(401, {
      data: { message: { en: 'Gateway token is not valid!', fa: 'توکن ارتباط با gateway معتبر نیست!' } },
      meta: { code: 'invalidToken', sourceName: 'apiGateway' },
    }),
    true,
  );
  assert.equal(bankUsesGateway('tavan_mellat'), true);
  assert.equal(bankUsesGateway('tavan_postbank'), true);
  assert.equal(bankUsesGateway('tavan_resalat'), false);

  const envKeys = [
    'CE_REPORT_HOST_MELLAT', 'CE_REPORT_HOST_RESALAT', 'CE_REPORT_HOST_POSTBANK',
    'CE_GATEWAY_HOST_MELLAT', 'CE_GATEWAY_SYSTEM_MELLAT', 'CE_GATEWAY_USERNAME_MELLAT', 'CE_GATEWAY_PASSWORD_MELLAT', 'CE_GATEWAY_TOKEN_MELLAT',
    'CE_GATEWAY_HOST_POSTBANK', 'CE_GATEWAY_SYSTEM_POSTBANK', 'CE_GATEWAY_USERNAME_POSTBANK', 'CE_GATEWAY_PASSWORD_POSTBANK', 'CE_GATEWAY_TOKEN_POSTBANK',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.CE_REPORT_HOST_MELLAT = 'mellat-report.example.test';
  process.env.CE_REPORT_HOST_RESALAT = 'resalat-report.example.test';
  process.env.CE_REPORT_HOST_POSTBANK = 'postbank-report.example.test';

  process.env.CE_GATEWAY_HOST_MELLAT = 'gw-mellat.example.test';
  process.env.CE_GATEWAY_SYSTEM_MELLAT = 'sysMellat';
  process.env.CE_GATEWAY_USERNAME_MELLAT = 'userMellat';
  process.env.CE_GATEWAY_PASSWORD_MELLAT = 'passMellat';
  process.env.CE_GATEWAY_TOKEN_MELLAT = 'stale-mellat-0';

  process.env.CE_GATEWAY_HOST_POSTBANK = 'gw-postbank.example.test';
  process.env.CE_GATEWAY_SYSTEM_POSTBANK = 'sysPostbank';
  process.env.CE_GATEWAY_USERNAME_POSTBANK = 'userPostbank';
  process.env.CE_GATEWAY_PASSWORD_POSTBANK = 'passPostbank';
  process.env.CE_GATEWAY_TOKEN_POSTBANK = 'stale-postbank-0';

  assert.equal(resolveBankApiUrl('tavan_mellat'), 'http://mellat-report.example.test/creditEvaluation@2/report');
  assert.equal(resolveBankApiUrl('tavan_resalat'), 'http://resalat-report.example.test/creditEvaluation@2/report');
  assert.equal(resolveBankApiUrl('tavan_postbank'), 'http://postbank-report.example.test/creditEvaluation@2/report');
  assert.equal(resolveBankGatewayConfig('tavan_mellat').tokenUrl, 'https://gw-mellat.example.test/service/gateway@3/token');
  assert.equal(resolveBankGatewayConfig('tavan_postbank').tokenUrl, 'https://gw-postbank.example.test/service/gateway@3/token');

  gatewayTokenManager.clearCache();
  const origFetch = global.fetch;
  let mellatTokenCalls = 0;
  let postbankTokenCalls = 0;

  global.fetch = async (url, init = {}) => {
    const u = String(url);

    if (u === 'https://gw-mellat.example.test/service/gateway@3/token') {
      mellatTokenCalls += 1;
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.pass, '');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), {
        system: 'sysMellat',
        authenticationPack: { username: 'userMellat', password: 'passMellat' },
      });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: `mellat-fresh-${mellatTokenCalls}` } }) };
    }

    if (u === 'https://gw-postbank.example.test/service/gateway@3/token') {
      postbankTokenCalls += 1;
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.pass, '');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), {
        system: 'sysPostbank',
        authenticationPack: { username: 'userPostbank', password: 'passPostbank' },
      });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: `postbank-fresh-${postbankTokenCalls}` } }) };
    }

    if (u.startsWith('http://mellat-report.example.test/creditEvaluation@2/report')) {
      assert.equal(init.headers['gateway-system'], 'sysMellat');
      if (init.headers['gateway-token'] === 'stale-mellat-0') {
        return {
          ok: false,
          status: 401,
          text: async () =>
            JSON.stringify({
              data: { message: { en: 'Gateway token is not valid!', fa: 'توکن ارتباط با gateway معتبر نیست!' } },
              meta: { code: 'invalidToken', sourceType: 'launcher', sourceName: 'apiGateway' },
            }),
        };
      }
      assert.equal(init.headers['gateway-token'], 'mellat-fresh-1');
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { count: 1, bank: 'mellat' } }) };
    }

    if (u.startsWith('http://postbank-report.example.test/creditEvaluation@2/report')) {
      assert.equal(init.headers['gateway-system'], 'sysPostbank');
      if (init.headers['gateway-token'] === 'stale-postbank-0') {
        return {
          ok: false,
          status: 401,
          text: async () =>
            JSON.stringify({
              data: { message: { en: 'Gateway token is not valid!', fa: 'توکن ارتباط با gateway معتبر نیست!' } },
              meta: { code: 'invalidToken', sourceType: 'launcher', sourceName: 'apiGateway' },
            }),
        };
      }
      assert.equal(init.headers['gateway-token'], 'postbank-fresh-1');
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { count: 1, bank: 'postbank' } }) };
    }

    if (u.startsWith('http://resalat-report.example.test/creditEvaluation@2/report')) {
      assert.equal('gateway-token' in init.headers, false, 'resalat must NOT send gateway-token');
      assert.equal('gateway-system' in init.headers, false, 'resalat must NOT send gateway-system');
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { count: 1, bank: 'resalat' } }) };
    }

    throw new Error(`unexpected fetch url: ${u}`);
  };

  try {
    const mellatData = await fetchBankJson('tavan_mellat', `${resolveBankApiUrl('tavan_mellat')}?page=1&limit=1`, { retryCount: 1 });
    assert.equal(mellatData.bank, 'mellat');
    assert.equal(mellatTokenCalls, 1);

    // پست‌بانک باید توکن و گیت‌وی مستقل خودش را بگیرد و با ملت تداخل نداشته باشد
    const postbankData = await fetchBankJson('tavan_postbank', `${resolveBankApiUrl('tavan_postbank')}?page=1&limit=1`, { retryCount: 1 });
    assert.equal(postbankData.bank, 'postbank');
    assert.equal(postbankTokenCalls, 1);

    // درخواست بعدی ملت همچنان از توکن کش‌شدهٔ ملت استفاده کند (بدون درخواست مجدد گیت‌وی)
    const mellatAgain = await fetchBankJson('tavan_mellat', `${resolveBankApiUrl('tavan_mellat')}?page=2&limit=1`, { retryCount: 1 });
    assert.equal(mellatAgain.bank, 'mellat');
    assert.equal(mellatTokenCalls, 1);

    // رسالت بدون هیچ هدر و درخواست گیت‌وی
    const resalatData = await fetchBankJson('tavan_resalat', `${resolveBankApiUrl('tavan_resalat')}?page=1&limit=1`, { retryCount: 1 });
    assert.equal(resalatData.bank, 'resalat');
  } finally {
    gatewayTokenManager.clearCache();
    global.fetch = origFetch;
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }
});

test.after(() => restore());

test('admin-controller: payload «بررسی پیش از اجرا» با mode و فیلترهای عددی پذیرفته می‌شود (رگرسیون خطای اعتبارسنجی)', () => {
  const schema = require(path.join(ROOT, 'controllers', 'adminController', 'schema.js'));
  const checkProps = schema.checkExisting.body.properties;
  // کلاینت همان payload اجرای تحلیل را برای بررسی می‌فرستد و mode هم در آن هست؛
  // با additionalProperties:false، نبودِ mode در اسکیما خطای «داده های ورودی نامعتبرند» می‌داد.
  assert.ok(checkProps.mode, 'checkExisting schema must accept mode');
  assert.deepEqual(checkProps.mode.enum, ['nightly', 'intraday']);
  // فیلترهای عددی باید number باشند و کلاینت آن‌ها را به عدد تبدیل می‌کند.
  assert.equal(schema.checkExisting.body.properties.filters.properties.maxCount.type, 'number');
  assert.equal(schema.checkExisting.body.properties.filters.properties.pageSize.type, 'number');
  assert.equal(schema.checkExisting.body.additionalProperties, false);
});

test('SECURITY: نقش مسیرهای مدیریتی را Samad تعیین می‌کند، نه hard-code محلی controller', async () => {
  const { controller: AdminController } = require(path.join(ROOT, 'controllers', 'adminController', 'main.js'));
  const config = require(path.join(ROOT, 'controllers', 'adminController', 'config.js'));
  const controller = new AdminController({}, {}, config);

  container.setServicesForTest({ admin: fakeAdminService(), ingestion: { async runDay() { return {}; } } });

  // این تست controllerها را مستقیم صدا می‌زند و دورِ middleware روتر است؛
  // بنابراین نقش غیرادمینِ احرازشده نباید با یک فهرست نقش محلی رد شود.
  // در ترافیک واقعی، checkAccess(true) در routes.js مجوز همین مسیر را از Samad می‌گیرد.
  const assignedSamadRole = { samadUsername: 'report-operator', roles: ['ops-reports'] };
  const protectedHandlers = [
    ['getOverview', {}],
    ['getCron', {}],
    ['updateCron', { data: { enabled: true, schedule_mode: 'daily', hour: 3, minute: 30 } }],
    ['runCronNow', {}],
    ['checkExisting', { data: { banks: ['tavan_mellat'] } }],
    ['startRun', { data: { banks: ['tavan_mellat'] } }],
    ['listJobs', {}],
    ['getJob', { url: '/api/admin/jobs?id=job-1', queryString: { id: 'job-1' } }],
    ['runAdminDay', { data: { bank: 'tavan_mellat', day: '1405-08-20' } }],
    ['run', { data: { bank: 'tavan_mellat', day: '1405-08-20' } }],
  ];

  try {
    for (const [handler, extra] of protectedHandlers) {
      await assert.doesNotReject(
        () => invoke(controller, config, handler, { ...extra, session: assignedSamadRole }).promise,
        `${handler} نباید بر اساس نام نقش در controller hard-code شود`,
      );
    }
  } finally {
    container.setServicesForTest(undefined);
  }
});

test('SECURITY: مهاجم راه‌دور نمی‌تواند کوکی نشست را از بدنهٔ پاسخ بکشد', async () => {
  const { controller: AuthController } = require(path.join(ROOT, 'controllers', 'auth', 'main.js'));
  const authConfig = require(path.join(ROOT, 'controllers', 'auth', 'config.js'));
  const SessionManager = require(path.join(ROOT, 'controllers', 'auth', 'session-manager'));

  const sessionStore = { samadUsername: 'visitor', roles: ['visitor'] };
  const session = {
    set(values, cb) { Object.assign(sessionStore, values); cb(null, sessionStore); },
    get(keys, cb) { const out = {}; for (const k of keys) out[k] = sessionStore[k]; cb(null, out); },
    remove(cb) { sessionStore.samadUsername = 'visitor'; sessionStore.roles = ['visitor']; cb(null, ['OK']); },
  };
  const authService = { async addUser() { return { ok: true }; }, async authenticate() { return { ok: true }; } };
  const samadService = { async addUser() { return () => {}; }, async getRole() { return ['visitor']; } };
  const controller = new AuthController({}, {}, authConfig, authService, new SessionManager({ useMemoryOnly: true }), samadService);

  const prevSecret = process.env.CE_BFF_SHARED_SECRET;
  delete process.env.CE_BFF_SHARED_SECRET; // سخت‌ترین حالت: بدون کلید مشترک
  try {
    // ۱) مهاجم از یک IP عمومی همان هدر خام را می‌فرستد → نباید کوکی در بدنه بگیرد
    const attackerLogin = await invoke(controller, authConfig, 'login', {
      data: { username: 'victim', password: 'p1', rememberMe: true },
      session,
      headers: { 'x-ce-bff': '1' },
      remoteAddress: '203.0.113.9',
    }).promise;
    assert.equal('_ceSetCookies' in attackerLogin, false, 'بدنه نباید هیچ کوکی‌ای داشته باشد');
    assert.doesNotMatch(JSON.stringify(attackerLogin), /ce_refresh/, 'هیچ ردی از رفرش‌توکن در پاسخ نباشد');

    // ۲) همان درخواست از loopback (Next.js روی همان هاست) مجاز است — بدون شکستن سرویس
    const legitLogin = await invoke(controller, authConfig, 'login', {
      data: { username: 'victim2', password: 'p2', rememberMe: true },
      session,
      headers: { 'x-ce-bff': '1' },
      remoteAddress: '127.0.0.1',
    }).promise;
    assert.equal(Array.isArray(legitLogin._ceSetCookies), true, 'نصب تک‌سروری باید کار کند');
    assert.equal(legitLogin._ceSetCookies.some((c) => c.startsWith('ce_refresh=')), true);
  } finally {
    if (prevSecret === undefined) delete process.env.CE_BFF_SHARED_SECRET;
    else process.env.CE_BFF_SHARED_SECRET = prevSecret;
  }
});
