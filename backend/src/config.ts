import * as dotenv from 'dotenv';

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`متغیر محیطی ${name} تنظیم نشده است (.env را ببین)`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://ce_user:ce_pass@localhost:5432/ce_dashboard'),
  apiBaseUrl: required('CE_API_BASE_URL', 'http://creditevaluation-v2.ara.partdp.ir/creditEvaluation@2/report'),
  apiToken: process.env.CE_GATEWAY_TOKEN || '',
  apiSystem: process.env.CE_GATEWAY_SYSTEM || 'creditEvaluation',
  pageSize: Number(process.env.CE_API_PAGE_SIZE || 50),
  backendPort: Number(process.env.BACKEND_PORT || 3000),
  redactNationalCode: (process.env.CE_REDACT_NATIONAL_CODE || 'true') === 'true',
  requestTimeoutMs: Number(process.env.CE_API_TIMEOUT_MS || 20000),
  retryCount: Number(process.env.CE_API_RETRY || 3),
};

export const BANKS = {
  tavan_mellat: { table: 'samples_mellat', label: 'ملت', method: 'tavan_mellat' },
} as const;

export type BankKey = keyof typeof BANKS;
