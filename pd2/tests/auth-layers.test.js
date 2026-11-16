'use strict';

/**
 * تست‌های واحد لایهٔ اصالت‌سنجی/سشن/سمد در pd2 (بدون نیاز به هیچ پکیج پارت).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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
      for (const key of keys) out[key] = store[key];
      cb(null, out);
    },
    remove(cb) {
      for (const key of Object.keys(store)) delete store[key];
      cb(null, ['OK']);
    },
  };
}

test('SessionManager: set/get/remove + پاک‌سازی کوکی + خطای sessionError', async () => {
  const SessionManager = require(path.join(ROOT, 'controllers', 'auth', 'session-manager'));
  const manager = new SessionManager();
  const session = createMockSession();

  await manager.setSession(session, { username: 'sadegh' }, ['admin']);
  assert.deepEqual(await manager.getSession(session), { samadUsername: 'sadegh', roles: ['admin'] });

  const info = await manager.getSessionInfo(session);
  assert.deepEqual(info, { authenticated: true, username: 'sadegh', samadUsername: 'sadegh', roles: ['admin'] });

  let cookies = null;
  await manager.removeSession(session, { setHeader: (name, value) => { if (name === 'Set-Cookie') cookies = value; } });
  assert.equal(Array.isArray(cookies), true);
  assert.match(cookies[0], /Max-Age=0/);
  assert.equal((await manager.getSessionInfo(session)).authenticated, false);

  await assert.rejects(
    () => manager.setSession({ set: (_v, cb) => cb(new Error('redis down')) }, { username: 'x' }, ['visitor']),
    (err) => err.statusCode === 500 && err.meta.code === 'sessionError',
  );
});

test('SamadService: تخصیص/خواندن/حذف نقش + rollback هنگام خطای setRole', async () => {
  process.env.SAMAD_ORG = 'ce_org';
  const SamadService = require(path.join(ROOT, 'controllers', 'auth', 'samad.service'));

  const users = new Map();
  let failRole = null;
  const httpClient = {
    async sendHttp(options, data) {
      if (options.method === 'PUT' && Array.isArray(data.users) && typeof data.users[0] === 'object') {
        const username = data.users[0].username;
        if (users.has(username)) return { data: [{ status: 'duplicate' }] };
        users.set(username, ['visitor']);
        return { data: [{ status: 'ok' }] };
      }
      if (options.method === 'PUT' && data.roleName) {
        if (data.roleName === failRole) {
          const err = new Error('role missing');
          err.meta = { code: 'roleNotFound' };
          throw err;
        }
        const username = data.users[0];
        if (!users.has(username)) return { data: [{ status: 'not_found' }] };
        users.set(username, [data.roleName]);
        return { data: [{ status: 'ok' }] };
      }
      if (options.method === 'POST') {
        const username = data.filters[0].username;
        return { data: users.has(username) ? [{ roles: users.get(username) }] : [] };
      }
      if (options.method === 'DELETE') {
        const username = data.filters[0].username;
        if (!users.has(username)) return { data: [{ status: 'not_found' }] };
        users.delete(username);
        return { data: [{ status: 'ok' }] };
      }
      throw new Error('unexpected samad call');
    },
  };

  const samad = new SamadService(httpClient);

  const rollback = await samad.addUser('ali', 'creditEvaluation');
  assert.equal(typeof rollback, 'function');
  assert.deepEqual(await samad.getRole('ali'), ['creditEvaluation']);

  await samad.setRole('ali', 'admin');
  assert.deepEqual(await samad.getRole('ali'), ['admin']);

  failRole = 'ghost_role';
  await assert.rejects(
    () => samad.addUser('temp_user', 'ghost_role'),
    (err) => err.statusCode === 404 && err.meta.code === 'roleNotFound',
  );
  assert.equal(users.has('temp_user'), false, 'کاربر باید هنگام خطای نقش از سمد حذف شود');
  failRole = null;

  await samad.removeUser('ali');
  assert.deepEqual(await samad.getRole('ali'), []);

  await assert.rejects(
    () => new SamadService(null).getRole('ali'),
    (err) => err.statusCode === 503 && err.meta.code === 'samadBaseServiceError',
  );
});

test('AuthenticationService: init + add/authenticate/remove با هدرهای رهگیری', async () => {
  const AuthenticationService = require(path.join(ROOT, 'controllers', 'auth', 'authentication.service'));
  const calls = [];
  const partAuth = {
    async addUser(fields, status, system, headers) { calls.push(['add', fields, status, system, headers]); return { id: 1 }; },
    async authenticate(fields, system, headers) { calls.push(['auth', fields, system, headers]); return { id: 1 }; },
    async removeUser(fields, system, headers) { calls.push(['remove', fields, system, headers]); return { removed: true }; },
  };

  const service = new AuthenticationService().init(partAuth);
  await service.addUser({ username: 'u', password: 'p' }, { 'x-id': 'a' });
  await service.authenticate({ username: 'u', password: 'p' }, { 'x-id': 'b' });
  await service.removeUser({ username: 'u' }, { 'x-id': 'c' });

  assert.deepEqual(calls.map((c) => c[0]), ['add', 'auth', 'remove']);
  assert.equal(calls[0][2], 'Active');
  assert.deepEqual(calls[0][4], { 'x-id': 'a' });

  await assert.rejects(
    () => new AuthenticationService().authenticate({ username: 'u', password: 'p' }),
    (err) => err.statusCode === 503 && err.meta.code === 'authBaseServiceError',
  );
});
