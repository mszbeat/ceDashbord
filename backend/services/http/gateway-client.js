'use strict';

const {
  config,
  cleanEnv,
  bankUsesGateway,
  resolveGatewayTokenUrl,
} = require('../config');

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

function resolveGatewaySettings() {
  return {
    tokenUrl: resolveGatewayTokenUrl() || config.gateway.tokenUrl,
    system: cleanEnv(process.env.CE_GATEWAY_SYSTEM) || config.gateway.system || config.apiSystem || 'creditEvaluation',
    username: cleanEnv(process.env.CE_GATEWAY_USERNAME) || config.gateway.username,
    password: cleanEnv(process.env.CE_GATEWAY_PASSWORD) || config.gateway.password,
    passHeader: process.env.CE_GATEWAY_PASS_HEADER ?? config.gateway.passHeader ?? '',
    staticToken: cleanEnv(process.env.CE_GATEWAY_TOKEN) || config.apiToken || '',
  };
}

class GatewayTokenManager {
  constructor() {
    this.cachedToken = '';
    this.inFlight = null;
  }

  getActiveTokenSync() {
    if (this.cachedToken) return this.cachedToken;
    const settings = resolveGatewaySettings();
    return settings.staticToken || '';
  }

  async getToken() {
    const active = this.getActiveTokenSync();
    if (active) return active;
    return this.refreshToken('');
  }

  async refreshToken(failedToken = '') {
    if (failedToken && this.cachedToken && this.cachedToken !== failedToken) {
      return this.cachedToken;
    }
    if (!this.inFlight) {
      this.inFlight = this.#fetchNewToken()
        .then((token) => {
          this.cachedToken = token;
          return token;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  async #fetchNewToken() {
    const settings = resolveGatewaySettings();
    if (!settings.tokenUrl) {
      if (settings.staticToken) return settings.staticToken;
      throw new Error('آدرس دریافت توکن گیت‌وی (CE_GATEWAY_TOKEN_URL یا CE_GATEWAY_HOST) تنظیم نشده است');
    }
    if (!settings.username || !settings.password) {
      throw new Error('نام کاربری یا رمز عبور گیت‌وی (CE_GATEWAY_USERNAME / CE_GATEWAY_PASSWORD) تنظیم نشده است');
    }

    const response = await fetch(settings.tokenUrl, {
      method: 'POST',
      headers: {
        pass: String(settings.passHeader ?? ''),
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        system: settings.system,
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
      throw new Error(`دریافت توکن گیت‌وی ناموفق بود: ${detail}`);
    }
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
          const settings = resolveGatewaySettings();
          usedToken = await gatewayTokenManager.getToken();
          headers['gateway-system'] = settings.system;
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
            await gatewayTokenManager.refreshToken(usedToken);
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
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  throw lastError;
}

module.exports = {
  GatewayTokenManager,
  gatewayTokenManager,
  isGatewayInvalidTokenResponse,
  fetchBankJson,
};
