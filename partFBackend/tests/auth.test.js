'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

test('AuthService supports addAuthEntry, authenticate (login), and removeUser (removeAuthEntry) with partAuthenticationInterface', async () => {
  process.env.PART_AUTH_SYSTEM = 'ce_dashboard';
  delete require.cache[require.resolve('../controllers/auth/auth.service')];
  const AuthService = require('../controllers/auth/auth.service');

  const calls = [];
  const loggedErrors = [];
  const mockPartAuth = {
    async addUser(payload, status, system, trackingHeaders) {
      calls.push({ fn: 'addUser', payload, status, system, trackingHeaders });
      if (payload.username === 'duplicate_user') {
        const err = new Error('exists');
        err.meta = { code: 'authEntryAlreadyExists' };
        throw err;
      }
      if (payload.username === 'boom_user') {
        throw new Error('upstream_timeout');
      }
      return { id: 'u-1' };
    },
    async authenticate(fields, system, trackingHeaders) {
      calls.push({ fn: 'authenticate', fields, system, trackingHeaders });
      if (fields.password === 'wrong_pass') {
        const err = new Error('unauthorized');
        err.statusCode = 401;
        err.meta = { code: 'invalidUsernameOrPassword' };
        throw err;
      }
      if (fields.username === 'inactive_user') {
        const err = new Error('inactive');
        err.statusCode = 403;
        err.meta = { code: 'authEntryIsInactive' };
        throw err;
      }
      return { id: 'u-1', username: fields.username, status: 'Active' };
    },
    async removeUser(fields, system, trackingHeaders) {
      calls.push({ fn: 'removeUser', fields, system, trackingHeaders });
      if (fields.username === 'missing_user') {
        const err = new Error('not found');
        err.statusCode = 404;
        err.meta = { code: 'authEntryNotFound' };
        throw err;
      }
      return { removed: true };
    },
  };

  const mockLogger = {
    error(err) {
      loggedErrors.push(err);
    },
  };

  const service = new AuthService(mockPartAuth, {}, mockLogger);
  const headers = { 'x-request-id': 'req-100' };

  // ۱. ثبت کاربر جدید (addAuthEntry)
  const regRes = await service.addAuthEntry({ username: 'ali', password: 'secret' }, headers);
  assert.equal(regRes, 'ok');
  assert.deepEqual(calls[0], {
    fn: 'addUser',
    payload: { username: 'ali', password: 'secret' },
    status: 'Active',
    system: 'ce_dashboard',
    trackingHeaders: headers,
  });

  // ۲. خطای تکراری بودن کاربر (409)
  await assert.rejects(
    () => service.addAuthEntry({ username: 'duplicate_user', password: 'secret' }, headers),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.data.message.en, 'auth entry alreadyExists');
      return true;
    },
  );

  // ۳. خطای غیرمنتظره باید لاگ شود و پرتاب شود (بلعیده نشود)
  await assert.rejects(
    () => service.addAuthEntry({ username: 'boom_user', password: 'secret' }, headers),
    (err) => {
      assert.equal(err.statusCode, 500);
      return true;
    },
  );
  assert.equal(loggedErrors.length, 1);

  // ۴. اصالت‌سنجی موفق (authenticate & login)
  const authRes = await service.authenticate(
    JSON.stringify({ username: 'ali', password: 'secret' }),
    headers,
  );
  assert.equal(authRes.username, 'ali');
  assert.deepEqual(calls[calls.length - 1], {
    fn: 'authenticate',
    fields: { username: 'ali', password: 'secret' },
    system: 'ce_dashboard',
    trackingHeaders: headers,
  });

  const loginAliasRes = await service.login({ username: 'ali', password: 'secret' }, headers);
  assert.equal(loginAliasRes.username, 'ali');

  // ۵. رمز عبور اشتباه (401) و حساب غیرفعال (403)
  await assert.rejects(
    () => service.authenticate({ username: 'ali', password: 'wrong_pass' }, headers),
    (err) => {
      assert.equal(err.statusCode, 401);
      return true;
    },
  );
  await assert.rejects(
    () => service.authenticate({ username: 'inactive_user', password: 'secret' }, headers),
    (err) => {
      assert.equal(err.statusCode, 403);
      return true;
    },
  );

  // ۶. حذف کاربر موفق (removeUser & removeAuthEntry) و خطای عدم وجود (404)
  const remRes = await service.removeUser({ username: 'ali' }, headers);
  assert.equal(remRes, 'ok');
  assert.deepEqual(calls[calls.length - 1], {
    fn: 'removeUser',
    fields: { username: 'ali' },
    system: 'ce_dashboard',
    trackingHeaders: headers,
  });

  const remAliasRes = await service.removeAuthEntry({ username: 'ali' }, headers);
  assert.equal(remAliasRes, 'ok');

  await assert.rejects(
    () => service.removeUser({ username: 'missing_user' }, headers),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    },
  );

  // ۷. اعتبارسنجی ورودیهای خالی (400)
  await assert.rejects(
    () => service.addAuthEntry({}, headers),
    (err) => err.statusCode === 400,
  );
  await assert.rejects(
    () => service.authenticate({ username: 'ali' }, headers),
    (err) => err.statusCode === 400,
  );
  await assert.rejects(
    () => service.removeUser({}, headers),
    (err) => err.statusCode === 400,
  );
});

test('AuthController delegates register, login, and removeUser to injected authService', async () => {
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

  const invoked = [];
  const mockAuthService = {
    async addAuthEntry(postData, trackingHeaders) {
      invoked.push(['addAuthEntry', postData, trackingHeaders]);
      return 'ok';
    },
    async authenticate(postData, trackingHeaders) {
      invoked.push(['authenticate', postData, trackingHeaders]);
      return { id: 'u-1' };
    },
    async removeUser(postData, trackingHeaders) {
      invoked.push(['removeUser', postData, trackingHeaders]);
      return 'ok';
    },
  };

  const ctrl = new modObj.exports.controller({}, {}, {}, mockAuthService);
  assert.equal(await ctrl.register({ username: 'u', password: 'p' }, { t: 1 }), 'ok');
  assert.deepEqual(await ctrl.login({ username: 'u', password: 'p' }, { t: 2 }), { id: 'u-1' });
  assert.equal(await ctrl.removeUser({ username: 'u' }, { t: 3 }), 'ok');
  assert.equal(invoked.length, 3);
});
