'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

function createMockSession(initial = { samadUsername: 'visitor', roles: ['visitor'] }) {
  const store = { ...initial };
  return {
    store,
    set(values, cb) {
      Object.assign(store, values);
      cb(null, store);
    },
    get(keys, cb) {
      const out = {};
      for (const k of keys) out[k] = store[k];
      cb(null, out);
    },
    remove(cb) {
      for (const k of Object.keys(store)) delete store[k];
      cb(null, ['OK']);
    },
  };
}

test('SessionManager manages setSession, getSession, removeSession, and cookie clearing with config.error objects', async () => {
  const SessionManager = require('../controllers/auth/session-manager');
  const sm = new SessionManager();

  const session = createMockSession();
  await sm.setSession(session, { username: 'sadegh' }, ['admin']);
  const current = await sm.getSession(session);
  assert.deepEqual(current, { samadUsername: 'sadegh', roles: ['admin'] });

  let setCookieVal = null;
  const response = {
    setHeader(name, value) {
      if (name === 'Set-Cookie') setCookieVal = value;
    },
  };
  await sm.removeSession(session, response);
  assert.equal(Array.isArray(setCookieVal), true);
  assert.match(setCookieVal[0], /Max-Age=0/);

  const brokenSession = {
    set(_v, cb) {
      cb(new Error('redis_down'));
    },
  };
  await assert.rejects(
    () => sm.setSession(brokenSession, { username: 'sadegh' }, ['visitor']),
    (err) => err.statusCode === 500 && err.meta?.code === 'sessionError',
  );
});

test('SamadService assigns roles, fetches roles, removes users, and rolls back addUser on setRole failure using config.error', async () => {
  process.env.org = 'ce_org';
  const SamadService = require('../controllers/auth/samad.service');

  const samadUsers = new Map();
  let failRoleName = null;

  const mockHttpClient = {
    async sendHttp(options, data) {
      if (options.url === 'users' && options.method === 'PUT' && Array.isArray(data.users) && typeof data.users[0] === 'object') {
        const u = data.users[0].username;
        if (samadUsers.has(u)) return { data: [{ status: 'duplicate' }] };
        samadUsers.set(u, ['visitor']);
        return { data: [{ status: 'ok' }] };
      }
      if (options.url === 'users' && options.method === 'PUT' && data.roleName) {
        if (data.roleName === failRoleName) {
          const e = new Error('role missing');
          e.meta = { code: 'roleNotFound' };
          throw e;
        }
        const u = data.users[0];
        if (!samadUsers.has(u)) return { data: [{ status: 'not_found' }] };
        samadUsers.set(u, [data.roleName]);
        return { data: [{ status: 'ok' }] };
      }
      if (options.url === 'users' && options.method === 'POST') {
        const u = data.filters[0].username;
        return { data: samadUsers.has(u) ? [{ roles: samadUsers.get(u) }] : [] };
      }
      if (options.url === 'users' && options.method === 'DELETE') {
        const u = data.filters[0].username;
        if (!samadUsers.has(u)) return { data: [{ status: 'not_found' }] };
        samadUsers.delete(u);
        return { data: [{ status: 'ok' }] };
      }
      throw new Error('unexpected call');
    },
  };

  const samad = new SamadService(mockHttpClient);

  const rollback = await samad.addUser('ali', 'creditEvaluation');
  assert.equal(typeof rollback, 'function');
  assert.deepEqual(await samad.getRole('ali'), ['creditEvaluation']);

  await samad.setRole('ali', 'admin');
  assert.deepEqual(await samad.getRole('ali'), ['admin']);

  // تست Rollback خودکار در صورتی که setRole در حین addUser خطا بدهد
  failRoleName = 'non_existent_role';
  await assert.rejects(
    () => samad.addUser('temp_user', 'non_existent_role'),
    (err) => err.statusCode === 404 && err.meta?.code === 'roleNotFound',
  );
  assert.equal(samadUsers.has('temp_user'), false, 'temp_user must be rolled back from Samad when setRole fails');
  failRoleName = null;

  await samad.removeUser('ali');
  assert.deepEqual(await samad.getRole('ali'), []);
});

test('AuthService integrates partAuthenticationInterface + SamadService + SessionManager and throws config.error objects', async () => {
  process.env.PART_AUTH_SYSTEM = 'ce_dashboard';
  process.env.org = 'ce_org';
  const AuthService = require('../controllers/auth/auth.service');
  const SessionManager = require('../controllers/auth/session-manager');
  const SamadService = require('../controllers/auth/samad.service');

  const authStore = new Map();
  const samadStore = new Map();
  const loggedErrors = [];

  const mockPartAuth = {
    async addUser(payload, status, system) {
      if (payload.username === 'boom_user') throw new Error('upstream_timeout');
      if (authStore.has(payload.username)) {
        const err = new Error('exists');
        err.meta = { code: 'authEntryAlreadyExists' };
        throw err;
      }
      authStore.set(payload.username, { password: payload.password, status, system });
      return { id: `id-${payload.username}` };
    },
    async authenticate(fields) {
      const entry = authStore.get(fields.username);
      if (!entry || entry.password !== fields.password) {
        const err = new Error('bad creds');
        err.statusCode = 401;
        err.meta = { code: 'invalidUsernameOrPassword' };
        throw err;
      }
      if (entry.status !== 'Active') {
        const err = new Error('inactive');
        err.statusCode = 403;
        err.meta = { code: 'authEntryIsInactive' };
        throw err;
      }
      return { id: `id-${fields.username}`, username: fields.username };
    },
    async removeUser(fields) {
      if (!authStore.has(fields.username)) {
        const err = new Error('missing');
        err.statusCode = 404;
        err.meta = { code: 'authEntryNotFound' };
        throw err;
      }
      authStore.delete(fields.username);
      return { removed: true };
    },
  };

  const mockSamadHttp = {
    async sendHttp(options, data) {
      if (options.method === 'PUT' && Array.isArray(data.users) && typeof data.users[0] === 'object') {
        const u = data.users[0].username;
        if (samadStore.has(u)) return { data: [{ status: 'exists' }] };
        samadStore.set(u, ['visitor']);
        return { data: [{ status: 'ok' }] };
      }
      if (options.method === 'PUT' && data.roleName) {
        const u = data.users[0];
        if (!samadStore.has(u)) return { data: [{ status: 'not_found' }] };
        samadStore.set(u, [data.roleName]);
        return { data: [{ status: 'ok' }] };
      }
      if (options.method === 'POST') {
        const u = data.filters[0].username;
        return { data: samadStore.has(u) ? [{ roles: samadStore.get(u) }] : [] };
      }
      if (options.method === 'DELETE') {
        const u = data.filters[0].username;
        if (!samadStore.has(u)) return { data: [{ status: 'not_found' }] };
        samadStore.delete(u);
        return { data: [{ status: 'ok' }] };
      }
    },
  };

  const service = new AuthService(
    mockPartAuth,
    {},
    { error: (e) => loggedErrors.push(e) },
    new SessionManager(),
    new SamadService(mockSamadHttp),
  );

  const visitorSession = createMockSession();
  const headers = { 'x-request-id': 'req-200' };

  // ۱. ثبتنام کاربر بههمراه تخصیص نقش در سمد و ذخیره در سشن
  const reg = await service.addAuthEntry(
    { username: 'reza', password: 'p1', role: 'creditEvaluation' },
    headers,
    visitorSession,
  );
  assert.deepEqual(reg, { status: 'ok', username: 'reza', roles: ['creditEvaluation'] });
  assert.deepEqual(visitorSession.store, { samadUsername: 'reza', roles: ['creditEvaluation'] });

  // ۲. اگر ثبت در partAuthenticationInterface خطا بدهد، کاربر از سمد Rollback میشود
  await assert.rejects(
    () => service.addAuthEntry({ username: 'boom_user', password: 'p1', role: 'visitor' }, headers, createMockSession()),
    (err) => err.statusCode === 500 && err.meta?.code === 'internalServerError',
  );
  assert.equal(samadStore.has('boom_user'), false, 'Samad user must be rolled back when auth addUser fails');
  assert.equal(loggedErrors.length, 1);

  // ۳. تغییر نقش کاربر در سمد و بهروزرسانی خودکار سشن فعال همان کاربر
  const roleRes = await service.assignRole({ username: 'reza', role: 'admin' }, visitorSession);
  assert.deepEqual(roleRes, { status: 'ok', username: 'reza', roles: ['admin'] });
  const meAfterRole = await service.getCurrentSession(visitorSession);
  assert.equal(meAfterRole.authenticated, true);
  assert.deepEqual(meAfterRole.roles, ['admin']);

  // ۴. خروج از حساب (logout) و پاکسازی سشن + کوکی
  let clearedCookies = null;
  const logoutRes = await service.logout(visitorSession, {
    setHeader(k, v) {
      if (k === 'Set-Cookie') clearedCookies = v;
    },
  });
  assert.deepEqual(logoutRes, { status: 'ok' });
  assert.equal(Array.isArray(clearedCookies), true);
  assert.equal((await service.getCurrentSession(visitorSession)).authenticated, false);

  // ۵. ورود مجدد (login) -> اصالتسنجی + خواندن نقشها از سمد + ذخیره در سشن
  const freshSession = createMockSession();
  const loginRes = await service.authenticate({ username: 'reza', password: 'p1' }, headers, freshSession);
  assert.deepEqual(loginRes, { status: 'ok', username: 'reza', roles: ['admin'] });
  assert.deepEqual(freshSession.store, { samadUsername: 'reza', roles: ['admin'] });

  // ۶. رمز اشتباه -> خطای استاندارد config.error.invalidCredentials (401)
  await assert.rejects(
    () => service.authenticate({ username: 'reza', password: 'wrong' }, headers, createMockSession()),
    (err) => err.statusCode === 401 && err.meta?.code === 'invalidCredentials',
  );

  // ۷. حذف کاربر -> حذف از Auth + حذف از سمد + پاک شدن سشن فعال
  const remRes = await service.removeUser({ username: 'reza' }, headers, freshSession, { setHeader() {} });
  assert.deepEqual(remRes, { status: 'ok', username: 'reza' });
  assert.equal(authStore.has('reza'), false);
  assert.equal(samadStore.has('reza'), false);
  assert.equal((await service.getCurrentSession(freshSession)).authenticated, false);
});

test('AuthController delegates all 7 routes cleanly to injected authService', async () => {
  let ts = null;
  for (const candidate of [
    'typescript',
    path.join(ROOT, '..', 'backend', 'node_modules', 'typescript'),
  ]) {
    try {
      ts = require(candidate);
      break;
    } catch {}
  }
  if (!ts) return;

  const mainPath = path.join(ROOT, 'controllers', 'auth', 'main.js');
  const source = fs.readFileSync(mainPath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      experimentalDecorators: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;

  class MockBaseController {
    static exportedProperties(schema, config) {
      return { schema, config };
    }
  }

  const customRequire = Module.createRequire(mainPath);
  const modObj = { exports: {} };
  vm.runInNewContext(
    transpiled,
    {
      module: modObj,
      exports: modObj.exports,
      __filename: mainPath,
      __dirname: path.dirname(mainPath),
      require: (id) => (id === '@partFramework/baseController' ? MockBaseController : customRequire(id)),
      Route: () => () => {},
      HTTP: () => () => {},
      console,
    },
    { filename: mainPath },
  );

  const calls = [];
  const mockAuthService = {
    async addAuthEntry(...args) { calls.push(['addAuthEntry', ...args]); return { status: 'ok' }; },
    async authenticate(...args) { calls.push(['authenticate', ...args]); return { status: 'ok' }; },
    async logout(...args) { calls.push(['logout', ...args]); return { status: 'ok' }; },
    async getCurrentSession(...args) { calls.push(['getCurrentSession', ...args]); return { authenticated: false }; },
    async assignRole(...args) { calls.push(['assignRole', ...args]); return { status: 'ok' }; },
    async getUserRoles(...args) { calls.push(['getUserRoles', ...args]); return { roles: [] }; },
    async removeUser(...args) { calls.push(['removeUser', ...args]); return { status: 'ok' }; },
  };

  const ctrl = new modObj.exports.controller({}, {}, {}, mockAuthService);
  await ctrl.register({ username: 'u', password: 'p' }, { h: 1 }, { s: 1 });
  await ctrl.login({ username: 'u', password: 'p' }, { h: 1 }, { s: 1 });
  await ctrl.logout({ s: 1 }, { res: 1 });
  await ctrl.me({ s: 1 });
  await ctrl.assignRole({ username: 'u', role: 'admin' }, { s: 1 });
  await ctrl.getRole({ username: 'u' });
  await ctrl.removeUser({ username: 'u' }, { h: 1 }, { s: 1 }, { res: 1 });
  assert.equal(calls.length, 7);
});
