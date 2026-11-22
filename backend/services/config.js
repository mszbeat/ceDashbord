'use strict';
const fs = require('node:fs');
const path = require('node:path');

try {
  const dotenv = require('dotenv');
  const localEnv = path.join(__dirname, '..', '.env');
  if (fs.existsSync(localEnv)) {
    dotenv.config({ path: localEnv });
  } else {
    dotenv.config();
  }
} catch {
  // در صورتی که dotenv نصب نباشد از process.env مستقیم استفاده میشود
}

function cleanEnv(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || /[\u0600-\u06FF]/.test(trimmed) || /^\*+$/.test(trimmed) || /^HOST_NAME$/i.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function parseDurationMs(raw, fallbackMs) {
  if (raw === undefined || raw === null || raw === '') return fallbackMs;
  const text = String(raw).trim();
  if (!text) return fallbackMs;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) return fallbackMs;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const ms = Math.floor(value * multipliers[unit]);
  return Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
}

function required(name, fallback) {
  const value = cleanEnv(process.env[name]) || fallback;
  if (!value) throw new Error(`متغیر محیطی ${name} تنظیم نشده است (.env را بررسی کنید)`);
  return value;
}

function requiredEnv(name) {
  return required(name);
}

const DEFAULT_REPORT_API_URL = 'http://creditevaluation-v2.ara.partdp.ir/creditEvaluation@2/report';

function buildServiceUrlFromHost(hostValue, defaultPath, defaultProtocol) {
  const clean = cleanEnv(hostValue);
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) {
    const parsed = new URL(clean);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = defaultPath;
    }
    return parsed.toString();
  }
  const stripped = clean.replace(/\/+$/, '');
  if (stripped.includes('/')) {
    return `${defaultProtocol}://${stripped}`;
  }
  return `${defaultProtocol}://${stripped}${defaultPath}`;
}

const BANKS = {
  tavan_mellat: {
    table: 'samples_mellat',
    label: 'ملت',
    method: 'tavan_mellat',
    envSuffix: 'MELLAT',
    reportHostEnv: 'CE_REPORT_HOST_MELLAT',
    urlEnv: 'CE_API_URL_MELLAT',
    usesGateway: true,
  },
  tavan_resalat: {
    table: 'samples_resalat',
    label: 'رسالت',
    method: 'tavan_resalat',
    envSuffix: 'RESALAT',
    reportHostEnv: 'CE_REPORT_HOST_RESALAT',
    urlEnv: 'CE_API_URL_RESALAT',
    usesGateway: false,
  },
  tavan_postbank: {
    table: 'samples_postbank',
    label: 'پستبانک',
    method: 'tavan_postbank',
    envSuffix: 'POSTBANK',
    reportHostEnv: 'CE_REPORT_HOST_POSTBANK',
    urlEnv: 'CE_API_URL_POSTBANK',
    usesGateway: true,
  },
};

function resolveBankApiUrl(bankKey) {
  const bank = BANKS[bankKey];
  if (bank) {
    const protocol =
      cleanEnv(process.env[`CE_REPORT_PROTOCOL_${bank.envSuffix}`]) ||
      cleanEnv(process.env.CE_REPORT_PROTOCOL) ||
      'http';
    const byHost = buildServiceUrlFromHost(
      process.env[bank.reportHostEnv],
      '/creditEvaluation@2/report',
      protocol,
    );
    if (byHost) return byHost;

    const explicitUrl = cleanEnv(process.env[bank.urlEnv]);
    if (explicitUrl) return explicitUrl;
  }

  const baseHostProtocol = cleanEnv(process.env.CE_REPORT_PROTOCOL) || 'http';
  const baseByHost = buildServiceUrlFromHost(
    process.env.CE_REPORT_HOST,
    '/creditEvaluation@2/report',
    baseHostProtocol,
  );
  if (baseByHost) return baseByHost;

  return cleanEnv(process.env.CE_API_BASE_URL) || DEFAULT_REPORT_API_URL;
}

function bankUsesGateway(bankKey) {
  const bank = BANKS[bankKey];
  return bank ? bank.usesGateway !== false : true;
}

function resolveBankGatewayConfig(bankKey) {
  const bank = BANKS[bankKey];
  const suffix = bank?.envSuffix || '';

  const protocol =
    (suffix && cleanEnv(process.env[`CE_GATEWAY_PROTOCOL_${suffix}`])) ||
    cleanEnv(process.env.CE_GATEWAY_PROTOCOL) ||
    'https';

  const explicitTokenUrl =
    (suffix && cleanEnv(process.env[`CE_GATEWAY_TOKEN_URL_${suffix}`])) ||
    cleanEnv(process.env.CE_GATEWAY_TOKEN_URL);

  const hostTokenUrl = buildServiceUrlFromHost(
    (suffix && process.env[`CE_GATEWAY_HOST_${suffix}`]) || process.env.CE_GATEWAY_HOST,
    '/service/gateway@3/token',
    protocol,
  );

  const tokenUrl = explicitTokenUrl || hostTokenUrl;

  const gatewaySystem =
    (suffix && cleanEnv(process.env[`CE_GATEWAY_SYSTEM_${suffix}`])) ||
    cleanEnv(process.env.CE_GATEWAY_SYSTEM) ||
    'creditEvaluation';

  const authSystem =
    (suffix && cleanEnv(process.env[`CE_GATEWAY_TOKEN_SYSTEM_${suffix}`])) ||
    gatewaySystem;

  const username =
    (suffix && cleanEnv(process.env[`CE_GATEWAY_USERNAME_${suffix}`])) ||
    cleanEnv(process.env.CE_GATEWAY_USERNAME) ||
    '';

  const password =
    (suffix && cleanEnv(process.env[`CE_GATEWAY_PASSWORD_${suffix}`])) ||
    cleanEnv(process.env.CE_GATEWAY_PASSWORD) ||
    '';

  const passHeader =
    (suffix && process.env[`CE_GATEWAY_PASS_HEADER_${suffix}`] !== undefined
      ? process.env[`CE_GATEWAY_PASS_HEADER_${suffix}`]
      : undefined) ??
    process.env.CE_GATEWAY_PASS_HEADER ??
    '';

  const staticToken =
    (suffix && cleanEnv(process.env[`CE_GATEWAY_TOKEN_${suffix}`])) ||
    cleanEnv(process.env.CE_GATEWAY_TOKEN) ||
    '';

  // عمر اعلامی توکن گیت‌وی (ثانیه یا ms یا 30m). پیش‌فرض ۶۰ ثانیه؛ اگر گیت‌وی عمر دیگری اعلام کند، همان اولویت دارد.
  const ttlMs = parseDurationMs(
    (suffix && cleanEnv(process.env[`CE_GATEWAY_TOKEN_TTL_${suffix}`])) ||
      cleanEnv(process.env.CE_GATEWAY_TOKEN_TTL),
    60000,
  );
  const refreshSkewMs = parseDurationMs(
    (suffix && cleanEnv(process.env[`CE_GATEWAY_TOKEN_REFRESH_SKEW_${suffix}`])) ||
      cleanEnv(process.env.CE_GATEWAY_TOKEN_REFRESH_SKEW),
    15000,
  );

  return {
    usesGateway: bankUsesGateway(bankKey),
    tokenUrl,
    gatewaySystem,
    authSystem,
    username,
    password,
    passHeader,
    staticToken,
    ttlMs,
    refreshSkewMs,
  };
}

function resolveGatewayTokenUrl(bankKey) {
  return resolveBankGatewayConfig(bankKey).tokenUrl;
}

const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://ce_user:ce_pass@localhost:5432/ce_dashboard'),
  apiBaseUrl: required('CE_API_BASE_URL', DEFAULT_REPORT_API_URL),
  apiUrls: {
    tavan_mellat: resolveBankApiUrl('tavan_mellat'),
    tavan_resalat: resolveBankApiUrl('tavan_resalat'),
    tavan_postbank: resolveBankApiUrl('tavan_postbank'),
  },
  apiToken: cleanEnv(process.env.CE_GATEWAY_TOKEN),
  apiSystem: cleanEnv(process.env.CE_GATEWAY_SYSTEM) || 'creditEvaluation',
  gateway: {
    tavan_mellat: resolveBankGatewayConfig('tavan_mellat'),
    tavan_postbank: resolveBankGatewayConfig('tavan_postbank'),
  },
  /**
   * اندازهٔ صفحهٔ خواندن از API بانک — با کران بالا و پایین (فاز ۴).
   * مقدار بزرگ‌تر از سقف، حافظهٔ پروسه را می‌ترکاند و پاسخ API را هم کند می‌کند؛ مقدار صفر
   * یا منفی حلقهٔ بی‌پایان می‌سازد. هر دو حالت این‌جا بسته می‌شوند.
   */
  pageSize: Math.min(Math.max(Number(process.env.CE_API_PAGE_SIZE || 50) || 50, 1), 200),
  backendPort: Number(process.env.BACKEND_PORT || process.env.PORT || 3000),
  backendHost: process.env.BACKEND_HOST || '0.0.0.0',
  redactNationalCode: (process.env.CE_REDACT_NATIONAL_CODE || 'true') === 'true',
  requestTimeoutMs: Number(process.env.CE_API_TIMEOUT_MS || 20000),
  retryCount: Number(process.env.CE_API_RETRY || 3),
  refreshTokenTtlMs: parseDurationMs(
    process.env.REFRESH_TOKEN_TTL_MS || process.env.REFRESH_TOKEN_TTL,
    24 * 60 * 60 * 1000,
  ),
  refreshTokenRememberTtlMs: parseDurationMs(
    process.env.REFRESH_TOKEN_REMEMBER_TTL_MS || process.env.REFRESH_TOKEN_REMEMBER_TTL,
    14 * 24 * 60 * 60 * 1000,
  ),
  sessionExpireMs: parseDurationMs(process.env.SESSION_EXPIRE_MS, 300000),
  sessionIdleMs: parseDurationMs(process.env.SESSION_IDLE_MS, 120000),
  /**
   * اسکیمای فعال دیتابیس: `v1` (jsonb فعلی) یا `v2` (جداول typed + پارتیشن).
   * پیش‌فرض `v1` است تا ارتقا با یک متغیر محیطی و بدون تغییر کد انجام شود.
   */
  dbSchema: (process.env.CE_DB_SCHEMA || 'v1').toLowerCase() === 'v2' ? 'v2' : 'v1',
};

module.exports = {
  config,
  BANKS,
  cleanEnv,
  requiredEnv,
  parseDurationMs,
  buildServiceUrlFromHost,
  resolveBankApiUrl,
  resolveBankGatewayConfig,
  resolveGatewayTokenUrl,
  bankUsesGateway,
};
