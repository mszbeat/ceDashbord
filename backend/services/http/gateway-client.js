'use strict';

const {
  config,
  bankUsesGateway,
  resolveBankGatewayConfig,
} = require('../config');
const { getActionLogger } = require('../logger/action-logger.service');

function isGatewayInvalidTokenResponse(status, body) {
  const meta = body && typeof body === 'object' ? body.meta : null;
  if (meta?.code === 'invalidToken') return true;
  const msgObj = body?.data?.message || body?.message || '';
  const msgText = typeof msgObj === 'string'
    ? msgObj
    : [msgObj?.en, msgObj?.fa].filter(Boolean).join(' ');
  if (/gateway token is not valid/i.test(msgText) || /توکن ارتباط با gateway معتبر نیست/.test(msgText)) {
    return true;
  }
  if (meta?.sourceName === 'apiGateway' && (status === 401 || status === 403 || /token|توکن/i.test(msgText))) {
    return true;
  }
  return false;
}

async function readResponseBody(response) {
  if (typeof response.text === 'function') {
    const raw = await response.text().catch(() => '');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  if (typeof response.json === 'function') {
    return response.json().catch(() => null);
  }
  return null;
}

/**
 * وضعیت هر توکن گیت‌وی: مقدار + زمان انقضا + زمان آخرین تمدید.
 * توکن‌ها پیش از هر درخواست داده بررسی می‌شوند: اگر منقضی یا در آستانهٔ انقضا باشند،
 * ابتدا از گیت‌وی توکن تازه گرفته می‌شود و بعد درخواست دریافت داده زده می‌شود.
 */
class GatewayTokenManager {
  constructor() {
    this.tokenByBank = new Map();
    this.inFlightByBank = new Map();
    // اکسپایر اعلام‌شده در پاسخ گیت‌وی برای هر بانک (میلی‌ثانیه)
    this.declaredTtlByBank = new Map();
  }

  now() {
    return Date.now();
  }

  #resolveLifetimeMs(bankKey) {
    const settings = resolveBankGatewayConfig(bankKey);
    const declared = Number(this.declaredTtlByBank.get(bankKey));
    const configured = Number(settings.ttlMs);
    const lifetime = Number.isFinite(declared) && declared > 0 ? declared : configured;
    const skew = Number(settings.refreshSkewMs);
    const safeSkew = Number.isFinite(skew) && skew >= 0 ? skew : 15000;
    return { lifetimeMs: lifetime > 0 ? lifetime : 60000, skewMs: safeSkew };
  }

  /**
   * توکن آمادهٔ استفاده را برمی‌گرداند. اگر توکن کش‌شده منقضی شده یا در پنجرهٔ
   * پیش‌تمدید (refreshSkew) باشد، **قبل از** درخواست داده، توکن تازه از گیت‌وی گرفته می‌شود.
   */
  async getToken(bankKey) {
    const entry = this.tokenByBank.get(bankKey);
    const now = this.now();
    if (entry && entry.token) {
      const { skewMs } = this.#resolveLifetimeMs(bankKey);
      const renewAt = entry.expiresAt - skewMs;
      if (now < renewAt) return entry.token;
      getActionLogger().info({
        category: 'gateway',
        action: now >= entry.expiresAt ? 'gateway.token.expired' : 'gateway.token.preemptive_renew',
        statusCode: 200,
        message: `Renewing gateway token for ${bankKey} before the upstream data request`,
        meta: {
          bankKey,
          expiresAt: new Date(entry.expiresAt).toISOString(),
          skewMs,
        },
      });
      return this.refreshToken(bankKey, '');
    }
    const settings = resolveBankGatewayConfig(bankKey);
    if (settings.staticToken) return settings.staticToken;
    return this.refreshToken(bankKey, '');
  }

  /** برای سازگاری با فراخوان‌های قبلی؛ فقط توکن معتبر فعلی یا توکن استاتیک. */
  getActiveTokenSync(bankKey) {
    const entry = this.tokenByBank.get(bankKey);
    if (entry && entry.token && entry.expiresAt > this.now()) return entry.token;
    const settings = resolveBankGatewayConfig(bankKey);
    return settings.staticToken || '';
  }

  /** وضعیت توکن برای گزارش/دیاگنوستیک. */
  tokenStatus(bankKey) {
    const entry = this.tokenByBank.get(bankKey);
    if (!entry) {
      return {
        bank: bankKey,
        hasToken: Boolean(resolveBankGatewayConfig(bankKey).staticToken),
        expiresAt: null,
        issuedAt: null,
        ttlMs: null,
        source: resolveBankGatewayConfig(bankKey).staticToken ? 'static' : 'none',
      };
    }
    return {
      bank: bankKey,
      hasToken: entry.expiresAt > this.now(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      issuedAt: new Date(entry.issuedAt).toISOString(),
      ttlMs: entry.expiresAt - entry.issuedAt,
      source: 'gateway',
    };
  }

  async refreshToken(bankKey, failedToken = '') {
    const current = this.tokenByBank.get(bankKey);
    if (failedToken && current && current.token && current.token !== failedToken) {
      return current.token;
    }
    if (!this.inFlightByBank.has(bankKey)) {
      const promise = this.#fetchNewToken(bankKey)
        .then((issued) => {
          const { lifetimeMs } = this.#resolveLifetimeMs(bankKey);
          const now = this.now();
          const entry = {
            token: issued.token,
            issuedAt: now,
            expiresAt: now + lifetimeMs,
          };
          if (issued.ttlMs) this.declaredTtlByBank.set(bankKey, issued.ttlMs);
          this.tokenByBank.set(bankKey, entry);
          getActionLogger().info({
            category: 'gateway',
            action: 'gateway.token.ready',
            statusCode: 200,
            meta: { bankKey, ttlMs: lifetimeMs, expiresAt: new Date(entry.expiresAt).toISOString() },
          });
          return entry.token;
        })
        .finally(() => {
          this.inFlightByBank.delete(bankKey);
        });
      this.inFlightByBank.set(bankKey, promise);
    }
    return this.inFlightByBank.get(bankKey);
  }

  /** سرور پاسخ داد «توکن معتبر نیست»: کش را کنار بگذار و توکن تازه بگیر. */
  async invalidateAndRenew(bankKey, rejectedToken = '') {
    const entry = this.tokenByBank.get(bankKey);
    if (entry && (!rejectedToken || entry.token === rejectedToken)) {
      this.tokenByBank.delete(bankKey);
    }
    return this.refreshToken(bankKey, rejectedToken);
  }

  clearCache(bankKey) {
    if (bankKey) {
      this.tokenByBank.delete(bankKey);
      this.declaredTtlByBank.delete(bankKey);
    } else {
      this.tokenByBank.clear();
      this.declaredTtlByBank.clear();
    }
  }

  async #fetchNewToken(bankKey) {
    const settings = resolveBankGatewayConfig(bankKey);
    if (!settings.tokenUrl) {
      if (settings.staticToken) return settings.staticToken;
      throw new Error(`هاست یا آدرس گیت‌وی برای بانک ${bankKey} تنظیم نشده است`);
    }
    if (!settings.username || !settings.password) {
      throw new Error(`نام کاربری یا رمز عبور گیت‌وی برای بانک ${bankKey} تنظیم نشده است`);
    }

    const response = await fetch(settings.tokenUrl, {
      method: 'POST',
      headers: {
        pass: String(settings.passHeader ?? ''),
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        system: settings.authSystem,
        authenticationPack: {
          username: settings.username,
          password: settings.password,
        },
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs || 20000),
    });

    const body = await readResponseBody(response);
    const token = body?.data?.token;
    if (!response.ok || typeof token !== 'string' || !token.trim()) {
      const detail =
        body?.data?.message?.fa ||
        body?.data?.message?.en ||
        body?.message ||
        `HTTP ${response.status} ${response.statusText || ''}`.trim();
      getActionLogger().error({
        category: 'gateway',
        action: 'gateway.token.failed',
        statusCode: response.status || 502,
        errorCode: 'GATEWAY_TOKEN_FAILED',
        message: `Gateway token fetch failed for ${bankKey}: ${detail}`,
        meta: { bankKey },
      });
      throw new Error(`دریافت توکن گیت‌وی برای ${bankKey} ناموفق بود: ${detail}`);
    }
    getActionLogger().info({
      category: 'gateway',
      action: 'gateway.token.refreshed',
      statusCode: 200,
      meta: { bankKey },
    });
    return { token: token.trim(), ttlMs: readDeclaredTtlMs(body) };
  }
}

/** عمر توکن را از فیلدهای رایج پاسخ گیت‌وی (expiresIn/ttl/exp) استخراج می‌کند. */
function readDeclaredTtlMs(body) {
  const candidates = [
    body?.data?.expiresInMs,
    body?.data?.expires_in_ms,
    body?.data?.expiresIn,
    body?.data?.expires_in,
    body?.data?.ttlMs,
    body?.data?.ttl,
  ];
  for (const raw of candidates) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      // مقادیر کوچک (<= 86400) ثانیه‌اند؛ مقادیر بزرگ ms.
      return value > 86400 ? Math.floor(value) : Math.floor(value * 1000);
    }
  }
  const exp = Number(body?.data?.exp);
  if (Number.isFinite(exp) && exp > 0) {
    // exp یا epoch ثانیه است یا epoch ms.
    const expiresAtMs = exp > 1e12 ? exp : exp * 1000;
    const delta = expiresAtMs - Date.now();
    if (delta > 0) return Math.floor(delta);
  }
  return 0;
}

const gatewayTokenManager = new GatewayTokenManager();

async function fetchBankJson(bankKey, url, options = {}) {
  const usesGateway = bankUsesGateway(bankKey);
  const timeoutMs = Number(options.timeoutMs || config.requestTimeoutMs || 20000);
  const retryCount = Math.max(1, Number(options.retryCount || config.retryCount || 3));

  let lastError;
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      let gatewayRefreshCount = 0;
      for (;;) {
        const headers = { accept: 'application/json' };
        let usedToken = '';
        if (usesGateway) {
          const settings = resolveBankGatewayConfig(bankKey);
          usedToken = await gatewayTokenManager.getToken(bankKey);
          headers['gateway-system'] = settings.gatewaySystem;
          headers['gateway-token'] = usedToken;
        }

        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await readResponseBody(response);

        if (usesGateway && isGatewayInvalidTokenResponse(response.status, body)) {
          if (gatewayRefreshCount < 2) {
            gatewayRefreshCount += 1;
            getActionLogger().warn({
              category: 'gateway',
              action: 'gateway.token.renew_after_reject',
              statusCode: response.status || 401,
              message: `Upstream rejected the gateway token for ${bankKey}; renewing and retrying`,
              meta: { bankKey, attempt: gatewayRefreshCount },
            });
            await gatewayTokenManager.invalidateAndRenew(bankKey, usedToken);
            continue;
          }
          throw new Error(
            body?.data?.message?.fa ||
            body?.data?.message?.en ||
            'توکن ارتباط با gateway معتبر نیست!',
          );
        }

        if (!response.ok) {
          const statusErr = new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
          statusErr.statusCode = response.status;
          throw statusErr;
        }

        return body?.data ?? body;
      }
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) {
        getActionLogger().warn({
          category: 'gateway',
          action: 'gateway.upstream.retry',
          statusCode: Number(error?.statusCode) || 502,
          message: error?.message || 'Upstream request retry',
          meta: { bankKey, attempt, retryCount },
        });
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  getActionLogger().error({
    category: 'gateway',
    action: 'gateway.upstream.failed',
    statusCode: Number(lastError?.statusCode) || 502,
    errorCode: 'UPSTREAM_FETCH_FAILED',
    message: lastError?.message || 'Upstream request failed after retries',
    meta: { bankKey, retryCount },
  });
  throw lastError;
}

module.exports = {
  GatewayTokenManager,
  gatewayTokenManager,
  isGatewayInvalidTokenResponse,
  fetchBankJson,
  readDeclaredTtlMs,
};
