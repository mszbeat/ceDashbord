'use strict';
const fs = require('node:fs');
const path = require('node:path');

try {
  const dotenv = require('dotenv');
  const localEnv = path.join(__dirname, '..', '.env');
  const legacyBackendEnv = path.join(__dirname, '..', '..', 'backend', '.env');
  if (fs.existsSync(localEnv)) {
    dotenv.config({ path: localEnv });
  } else if (fs.existsSync(legacyBackendEnv)) {
    dotenv.config({ path: legacyBackendEnv });
  } else {
    dotenv.config();
  }
} catch {
  // در صورتی که dotenv نصب نباشد از process.env مستقیم استفاده میشود
}

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`متغیر محیطی ${name} تنظیم نشده است (.env را بررسی کنید)`);
  return value;
}

const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://ce_user:ce_pass@localhost:5432/ce_dashboard'),
  apiBaseUrl: required('CE_API_BASE_URL', 'http://creditevaluation-v2.ara.partdp.ir/creditEvaluation@2/report'),
  apiToken: process.env.CE_GATEWAY_TOKEN || '',
  apiSystem: process.env.CE_GATEWAY_SYSTEM || 'creditEvaluation',
  pageSize: Number(process.env.CE_API_PAGE_SIZE || 50),
  backendPort: Number(process.env.BACKEND_PORT || process.env.PORT || 3000),
  backendHost: process.env.BACKEND_HOST || '0.0.0.0',
  redactNationalCode: (process.env.CE_REDACT_NATIONAL_CODE || 'true') === 'true',
  requestTimeoutMs: Number(process.env.CE_API_TIMEOUT_MS || 20000),
  retryCount: Number(process.env.CE_API_RETRY || 3),
};

const BANKS = {
  tavan_mellat: { table: 'samples_mellat', label: 'ملت', method: 'tavan_mellat' },
  tavan_resalat: { table: 'samples_resalat', label: 'رسالت', method: 'tavan_resalat' },
  tavan_postbank: { table: 'samples_postbank', label: 'پستبانک', method: 'tavan_postbank' },
};

module.exports = {
  config,
  BANKS,
};
