'use strict';

/**
 * توکن گیت‌وی باید **پیش از** درخواست دریافت داده بررسی/تمدید شود:
 *  - توکن منقضی → درخواست تازه به گیت‌وی، بدون ارسال درخواست داده با توکن کهنه
 *  - توکن در پنجرهٔ پیش‌تمدید → همان رفتار
 *  - توکنی که سرور رد کند → کش دور ریخته و توکن تازه گرفته می‌شود
 */
process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { GatewayTokenManager, fetchBankJson } = require(path.join(ROOT, 'services', 'http', 'gateway-client'));
const { resolveBankApiUrl, resolveBankGatewayConfig } = require(path.join(ROOT, 'services', 'config'));

const ENV_KEYS = [
  'CE_REPORT_HOST_MELLAT',
  'CE_GATEWAY_HOST_MELLAT',
  'CE_GATEWAY_SYSTEM_MELLAT',
  'CE_GATEWAY_USERNAME_MELLAT',
  'CE_GATEWAY_PASSWORD_MELLAT',
  'CE_GATEWAY_TOKEN_MELLAT',
  'CE_GATEWAY_TOKEN_TTL_MELLAT',
  'CE_GATEWAY_TOKEN_REFRESH_SKEW_MELLAT',
];

function withEnv(overrides, fn) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

const BASE_ENV = {
  CE_REPORT_HOST_MELLAT: 'mellat-report.example.test',
  CE_GATEWAY_HOST_MELLAT: 'gw-mellat.example.test',
  CE_GATEWAY_SYSTEM_MELLAT: 'sysMellat',
  CE_GATEWAY_USERNAME_MELLAT: 'userMellat',
  CE_GATEWAY_PASSWORD_MELLAT: 'passMellat',
  CE_GATEWAY_TOKEN_TTL_MELLAT: '120000',
  CE_GATEWAY_TOKEN_REFRESH_SKEW_MELLAT: '1000',
};

test('توکن منقضی قبل از درخواست داده تمدید می‌شود و درخواست با توکن تازه ارسال می‌گردد', async () => {
  await withEnv(BASE_ENV, async () => {
    const manager = new GatewayTokenManager();
    const originalFetch = global.fetch;
    let tokenCalls = 0;
    const dataCalls = [];
    let clock = 1_700_000_000_000;
    manager.now = () => clock;

    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'https://gw-mellat.example.test/service/gateway@3/token') {
        tokenCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: `fresh-${tokenCalls}` } }) };
      }
      if (u.startsWith('http://mellat-report.example.test/creditEvaluation@2/report')) {
        dataCalls.push({ token: init.headers['gateway-token'], at: clock });
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { count: 0 } }) };
      }
      throw new Error(`unexpected url ${u}`);
    };

    try {
      // اولین توکن
      const first = await manager.getToken('tavan_mellat');
      assert.equal(first, 'fresh-1');
      assert.equal(tokenCalls, 1);

      // هنوز معتبر است → همان توکن، بدون درخواست تازه
      assert.equal(await manager.getToken('tavan_mellat'), 'fresh-1');
      assert.equal(tokenCalls, 1);

      // از عمر توکن گذشته → قبل از هر درخواست داده، توکن تازه گرفته می‌شود
      clock += 121_000;
      const status = manager.tokenStatus('tavan_mellat');
      assert.equal(status.hasToken, false);
      const second = await manager.getToken('tavan_mellat');
      assert.equal(second, 'fresh-2');
      assert.equal(tokenCalls, 2);
      assert.equal(manager.tokenStatus('tavan_mellat').hasToken, true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('fetchBankJson با توکن کهنه هرگز درخواست داده نمی‌زند و ابتدا توکن تازه می‌گیرد', async () => {
  await withEnv({ ...BASE_ENV, CE_GATEWAY_TOKEN_MELLAT: '' }, async () => {
    const { gatewayTokenManager } = require(path.join(ROOT, 'services', 'http', 'gateway-client'));
    gatewayTokenManager.clearCache();

    const originalFetch = global.fetch;
    let tokenCalls = 0;
    const dataTokens = [];
    let clock = 1_700_000_000_000;
    gatewayTokenManager.now = () => clock;

    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'https://gw-mellat.example.test/service/gateway@3/token') {
        tokenCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: `gw-${tokenCalls}`, expiresIn: 120 } }) };
      }
      if (u.startsWith('http://mellat-report.example.test/creditEvaluation@2/report')) {
        dataTokens.push(init.headers['gateway-token']);
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { count: 1 } }) };
      }
      throw new Error(`unexpected url ${u}`);
    };

    try {
      const url = `${resolveBankApiUrl('tavan_mellat')}?page=1&limit=5`;
      await fetchBankJson('tavan_mellat', url, { retryCount: 1 });
      assert.deepEqual(dataTokens, ['gw-1']);
      assert.equal(tokenCalls, 1);

      // عمر اعلام‌شده توسط گیت‌وی (expiresIn: 120s) باید استفاده شود
      const ttl = resolveBankGatewayConfig('tavan_mellat').ttlMs;
      assert.equal(ttl, 120000);

      clock += 130_000;
      await fetchBankJson('tavan_mellat', url, { retryCount: 1 });
      assert.deepEqual(dataTokens, ['gw-1', 'gw-2'], 'second data request must use a renewed token');
      assert.equal(tokenCalls, 2);
    } finally {
      global.fetch = originalFetch;
      gatewayTokenManager.clearCache();
    }
  });
});

test('توکن ردشده توسط سرور: کش دور ریخته و درخواست با توکن تازه تکرار می‌شود', async () => {
  await withEnv({ ...BASE_ENV, CE_GATEWAY_TOKEN_MELLAT: '' }, async () => {
    const { gatewayTokenManager } = require(path.join(ROOT, 'services', 'http', 'gateway-client'));
    gatewayTokenManager.clearCache();

    const originalFetch = global.fetch;
    let tokenCalls = 0;
    const attempts = [];

    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'https://gw-mellat.example.test/service/gateway@3/token') {
        tokenCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: `gw-${tokenCalls}` } }) };
      }
      if (u.startsWith('http://mellat-report.example.test/creditEvaluation@2/report')) {
        attempts.push(init.headers['gateway-token']);
        if (tokenCalls === 1) {
          return {
            ok: false,
            status: 401,
            text: async () =>
              JSON.stringify({
                data: { message: { en: 'Gateway token is not valid!', fa: 'توکن ارتباط با gateway معتبر نیست!' } },
                meta: { code: 'invalidToken', sourceName: 'apiGateway' },
              }),
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { count: 2 } }) };
      }
      throw new Error(`unexpected url ${u}`);
    };

    try {
      const result = await fetchBankJson('tavan_mellat', `${resolveBankApiUrl('tavan_mellat')}?page=1`, { retryCount: 1 });
      assert.equal(result.count, 2);
      assert.deepEqual(attempts, ['gw-1', 'gw-2']);
      assert.equal(tokenCalls, 2);
    } finally {
      global.fetch = originalFetch;
      gatewayTokenManager.clearCache();
    }
  });
});
