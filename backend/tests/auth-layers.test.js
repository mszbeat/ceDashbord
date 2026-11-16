'use strict';

/**
 * تست‌های واحد لایهٔ اصالت‌سنجی/سشن/رفرش‌توکن/سمد در pd2 (بدون نیاز به هیچ پکیج پارت).
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

function createMockResponse(initialCookies = []) {
  const headers = {};
  if (initialCookies.length) headers['set-cookie'] = [...initialCookies];
  return {
    headers,
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
  };
}

test('SessionManager: set/get/remove + رفرش‌توکن + حفظ کوکی فریم‌ورک + خطای sessionError', async () => {
  const SessionManager = require(path.join(ROOT, 'controllers', 'auth', 'session-manager'));
  const manager = new SessionManager({ useMemoryOnly: true, ttlMs: 60000, rememberTtlMs: 3600000 });
  const session = createMockSession();

  await manager.setSession(session, { username: 'sadegh' }, ['admin']);
  assert.deepEqual(await manager.getSession(session), { samadUsername: 'sadegh', roles: ['admin'] });

  const info = await manager.getSessionInfo(session);
  assert.deepEqual(info, { authenticated: true, username: 'sadegh', samadUsername: 'sadegh', roles: ['admin'] });

  // صدور رفرش‌توکن با حفظ Set-Cookie موجود
  const loginRes = createMockResponse(['token=abc123; Path=/; HttpOnly']);
  const issued = await manager.issueRefreshToken({ username: 'sadegh', roles: ['admin'], rememberMe: false }, loginRes, {});
  assert.ok(issued.rawToken.length > 32);
  const loginCookies = loginRes.headers['set-cookie'];
  assert.equal(loginCookies.some((c) => c.startsWith('token=abc123')), true);
  const refreshCookieLine = loginCookies.find((c) => c.startsWith('ce_refresh='));
  assert.ok(refreshCookieLine);
  assert.match(refreshCookieLine, /HttpOnly/);
  assert.match(refreshCookieLine, /SameSite=Lax/);

  const rawCookieVal = decodeURIComponent(refreshCookieLine.split(';')[0].split('=')[1]);
  assert.equal(rawCookieVal, issued.rawToken);

  // اگر سشن کوتاه‌مدت منقضی شده و visitor شده باشد، getSessionStatus باید canRefresh=true برگرداند
  const expiredSession = createMockSession();
  const statusWithRefresh = await manager.getSessionStatus(expiredSession, {
    headers: { cookie: `ce_refresh=${encodeURIComponent(rawCookieVal)}` },
  });
  assert.equal(statusWithRefresh.authenticated, false);
  assert.equal(statusWithRefresh.canRefresh, true);
  assert.equal(typeof statusWithRefresh.accessExpireMs, 'number');

  // چرخش رفرش‌توکن
  const refreshRes = createMockResponse(['token=new456; Path=/; HttpOnly']);
  const rotated = await manager.rotateRefreshToken(rawCookieVal, { roles: ['admin'] }, refreshRes, {});
  assert.notEqual(rotated.rawToken, issued.rawToken);
  assert.equal(refreshRes.headers['set-cookie'].some((c) => c.startsWith('token=new456')), true);

  // تلاش برای استفادهٔ مجدد از توکن قدیمی باید کل خانواده را باطل کند (reuse detection)
  await assert.rejects(
    () => manager.rotateRefreshToken(rawCookieVal, { roles: ['admin'] }, createMockResponse(), {}),
    (err) => err.statusCode === 401 && err.meta.code === 'refreshTokenRevoked',
  );
  await assert.rejects(
    () => manager.rotateRefreshToken(rotated.rawToken, { roles: ['admin'] }, createMockResponse(), {}),
    (err) => err.statusCode === 401 && err.meta.code === 'refreshTokenRevoked',
  );

  // خروج و پاک‌سازی کوکی‌ها
  let cookies = null;
  await manager.removeSession(session, { setHeader: (name, value) => { if (name === 'Set-Cookie') cookies = value; } });
  assert.equal(Array.isArray(cookies), true);
  assert.match(cookies[0], /Max-Age=0/);
  assert.equal(cookies.some((c) => c.startsWith('ce_refresh=;') && /Max-Age=0/.test(c)), true);
  assert.equal((await manager.getSessionInfo(session)).authenticated, false);

  await assert.rejects(
    () => manager.setSession({ set: (_v, cb) => cb(new Error('redis down')) }, { username: 'x' }, ['visitor']),
    (err) => err.statusCode === 500 && err.meta.code === 'sessionError',
  );
});

test('RefreshTokenService: rememberMe TTL و انقضای توکن و ابطال سراسری کاربر', async () => {
  const { RefreshTokenService } = require(path.join(ROOT, 'controllers', 'auth', 'refresh-token.service'));
  const store = new RefreshTokenService({ useMemoryOnly: true, ttlMs: 1000, rememberTtlMs: 50000 });

  const normal = await store.issue({ username: 'u1', roles: ['visitor'], rememberMe: false });
  const remembered = await store.issue({ username: 'u1', roles: ['admin'], rememberMe: true });
  assert.ok(remembered.expiresAt.getTime() - normal.expiresAt.getTime() > 40000);

  await store.revokeUser('u1');
  assert.equal((await store.peek(normal.rawToken)).valid, false);
  assert.equal((await store.peek(remembered.rawToken)).valid, false);

  const shortStore = new RefreshTokenService({ useMemoryOnly: true, ttlMs: -10 });
  const expired = await shortStore.issue({ username: 'u2', roles: ['admin'] });
  assert.equal((await shortStore.peek(expired.rawToken)).reason, 'expired');
  await assert.rejects(
    () => shortStore.rotate(expired.rawToken),
    (err) => err.statusCode === 401 && err.meta.code === 'refreshTokenExpired',
  );
});

test('RefreshTokenService: مسیر SQL با شبیه‌ساز دیتابیس (هش، چرخش اتمیک و ابطال خانواده)', async () => {
  const { RefreshTokenService, hashToken } = require(path.join(ROOT, 'controllers', 'auth', 'refresh-token.service'));
  const rows = [];
  const ddlCalls = [];
  const fakeDb = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('CREATE ')) {
        ddlCalls.push(normalized);
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('INSERT INTO auth_refresh_tokens')) {
        rows.push({
          id: rows.length + 1,
          token_hash: params[0],
          family_id: params[1],
          username: params[2],
          roles: JSON.parse(params[3]),
          remember_me: params[4],
          expires_at: params[5],
          rotated_at: null,
          revoked_at: null,
          replaced_by_hash: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT username, roles')) {
        const hit = rows.find((r) => r.token_hash === params[0]);
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (normalized.startsWith('UPDATE auth_refresh_tokens SET rotated_at')) {
        const hit = rows.find(
          (r) =>
            r.token_hash === params[0] &&
            !r.rotated_at &&
            !r.revoked_at &&
            new Date(r.expires_at).getTime() > Date.now(),
        );
        if (!hit) return { rows: [], rowCount: 0 };
        hit.rotated_at = new Date().toISOString();
        hit.replaced_by_hash = params[1];
        return { rows: [hit], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT family_id, rotated_at')) {
        const hit = rows.find((r) => r.token_hash === params[0]);
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (normalized.startsWith('UPDATE auth_refresh_tokens SET revoked_at')) {
        if (normalized.includes('WHERE family_id = $1')) {
          for (const r of rows) {
            if (r.family_id === params[0] && !r.revoked_at) r.revoked_at = new Date().toISOString();
          }
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const store = new RefreshTokenService({ db: fakeDb, ttlMs: 60000 });
  const t1 = await store.issue({ username: 'sql_admin', roles: ['admin'] });
  assert.equal(ddlCalls.length, 4);
  assert.equal(rows[0].token_hash, hashToken(t1.rawToken));
  assert.notEqual(rows[0].token_hash, t1.rawToken);

  const p1 = await store.peek(t1.rawToken);
  assert.equal(p1.valid, true);
  assert.equal(p1.username, 'sql_admin');

  const t2 = await store.rotate(t1.rawToken, { roles: ['admin', 'creditEvaluation'] });
  assert.deepEqual(t2.roles, ['admin', 'creditEvaluation']);

  // استفادهٔ مجدد از t1 باید کل خانواده را باطل کند
  await assert.rejects(
    () => store.rotate(t1.rawToken),
    (err) => err.statusCode === 401 && err.meta.code === 'refreshTokenRevoked',
  );
  assert.equal((await store.peek(t2.rawToken)).valid, false);
});

test('legacy-report: خروجی HTML شامل نوار وضعیت احراز هویت و منطق تمدید خودکار نشست است', async () => {
  const { EvaluatorService } = require(path.join(ROOT, 'services', 'evaluator', 'evaluator.service'));
  const { SummaryService } = require(path.join(ROOT, 'services', 'summary', 'summary.service'));
  const fakeDb = { async query() { return { rows: [], rowCount: 0 }; } };
  const summary = new SummaryService(fakeDb, new EvaluatorService());
  const html = await summary.report('tavan_mellat', '1405-08-01', '1405-08-01', 25);
  assert.match(html, /id="ce-auth-slot"/);
  assert.match(html, /id="ce-admin-nav-link"/);
  assert.match(html, /\/api\/auth\/me/);
  assert.match(html, /\/api\/auth\/refresh/);
  assert.match(html, /BroadcastChannel\('ce-auth'\)/);
  assert.match(html, /navigator\.locks/);
  assert.match(html, /\/login\?next=/);
  assert.match(html, /redirectToLogin/);
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
