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
  if (!trimmed || /[\u0600-\u06FF]/.test(trimmed) || /^\*+$/.test(trimmed)) return '';
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

const DEFAULT_REPORT_API_URL = 'http://creditevaluation-v2.ara.partdp.ir/creditEvaluation@2/report';

function resolveGatewayTokenUrl() {
  const explicit = cleanEnv(process.env.CE_GATEWAY_TOKEN_URL);
  if (explicit) return explicit;
  const host = cleanEnv(process.env.CE_GATEWAY_HOST);
  if (!host) return '';
  if (/^https?:\/\//i.test(host)) {
    return `${host.replace(/\/+$/, '')}/service/gateway@3/token`;
  }
  const protocol = cleanEnv(process.env.CE_GATEWAY_PROTOCOL) || 'https';
  return `${protocol}://${host.replace(/\/+$/, '')}/service/gateway@3/token`;
}

const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://ce_user:ce_pass@localhost:5432/ce_dashboard'),
  apiBaseUrl: required('CE_API_BASE_URL', DEFAULT_REPORT_API_URL),
  apiUrls: {
    tavan_mellat: cleanEnv(process.env.CE_API_URL_MELLAT) || required('CE_API_BASE_URL', DEFAULT_REPORT_API_URL),
    tavan_resalat: cleanEnv(process.env.CE_API_URL_RESALAT) || required('CE_API_BASE_URL', DEFAULT_REPORT_API_URL),
    tavan_postbank: cleanEnv(process.env.CE_API_URL_POSTBANK) || required('CE_API_BASE_URL', DEFAULT_REPORT_API_URL),
  },
  apiToken: cleanEnv(process.env.CE_GATEWAY_TOKEN),
  apiSystem: cleanEnv(process.env.CE_GATEWAY_SYSTEM) || 'creditEvaluation',
  gateway: {
    tokenUrl: resolveGatewayTokenUrl(),
    system: cleanEnv(process.env.CE_GATEWAY_SYSTEM) || 'creditEvaluation',
    username: cleanEnv(process.env.CE_GATEWAY_USERNAME),
    password: cleanEnv(process.env.CE_GATEWAY_PASSWORD),
    passHeader: process.env.CE_GATEWAY_PASS_HEADER ?? '',
  },
  pageSize: Number(process.env.CE_API_PAGE_SIZE || 50),
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
};

const BANKS = {
  tavan_mellat: {
    table: 'samples_mellat',
    label: 'ملت',
    method: 'tavan_mellat',
    urlEnv: 'CE_API_URL_MELLAT',
    usesGateway: true,
  },
  tavan_resalat: {
    table: 'samples_resalat',
    label: 'رسالت',
    method: 'tavan_resalat',
    urlEnv: 'CE_API_URL_RESALAT',
    usesGateway: false,
  },
  tavan_postbank: {
    table: 'samples_postbank',
    label: 'پستبانک',
    method: 'tavan_postbank',
    urlEnv: 'CE_API_URL_POSTBANK',
    usesGateway: true,
  },
};

function resolveBankApiUrl(bankKey) {
  const bank = BANKS[bankKey];
  if (bank?.urlEnv) {
    const dynamicUrl = cleanEnv(process.env[bank.urlEnv]);
    if (dynamicUrl) return dynamicUrl;
  }
  if (bankKey && config.apiUrls?.[bankKey]) {
    const fallbackDynamic = cleanEnv(process.env.CE_API_BASE_URL);
    if (!cleanEnv(process.env[bank?.urlEnv || '']) && fallbackDynamic) {
      return fallbackDynamic;
    }
    return config.apiUrls[bankKey];
  }
  return cleanEnv(process.env.CE_API_BASE_URL) || config.apiBaseUrl;
}

function bankUsesGateway(bankKey) {
  const bank = BANKS[bankKey];
  return bank ? bank.usesGateway !== false : true;
}

module.exports = {
  config,
  BANKS,
  cleanEnv,
  parseDurationMs,
  resolveBankApiUrl,
  resolveGatewayTokenUrl,
  bankUsesGateway,
};
