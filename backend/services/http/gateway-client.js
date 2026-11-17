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

class GatewayTokenManager {
  constructor() {
    this.tokenByBank = new Map();
    this.inFlightByBank = new Map();
  }

  getActiveTokenSync(bankKey) {
    const cached = this.tokenByBank.get(bankKey);
    if (cached) return cached;
    const settings = resolveBankGatewayConfig(bankKey);
    return settings.staticToken || '';
  }

  async getToken(bankKey) {
    const active = this.getActiveTokenSync(bankKey);
    if (active) return active;
    return this.refreshToken(bankKey, '');
  }

  async refreshToken(bankKey, failedToken = '') {
    const current = this.tokenByBank.get(bankKey);
    if (failedToken && current && current !== failedToken) {
      return current;
    }
    if (!this.inFlightByBank.has(bankKey)) {
      const promise = this.#fetchNewToken(bankKey)
        .then((token) => {
          this.tokenByBank.set(bankKey, token);
          return token;
        })
        .finally(() => {
          this.inFlightByBank.delete(bankKey);
        });
      this.inFlightByBank.set(bankKey, promise);
    }
    return this.inFlightByBank.get(bankKey);
  }

  clearCache(bankKey) {
    if (bankKey) this.tokenByBank.delete(bankKey);
    else this.tokenByBank.clear();
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
    return token.trim();
  }
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
            await gatewayTokenManager.refreshToken(bankKey, usedToken);
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
};
