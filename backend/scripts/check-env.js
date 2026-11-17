'use strict';
/**
 * پیش از اجرای بکاند، وجود تنظیمات محیطی لازم را بررسی میکند.
 * این اسکریپت به رجیستری خصوصی پارت، PostgreSQL یا هاست‌های داخلی وابسته نیست.
 */
const fs = require('node:fs');
const path = require('node:path');

try {
  const dotenv = require('dotenv');
  const localEnv = path.join(__dirname, '..', '.env');
  dotenv.config({ path: fs.existsSync(localEnv) ? localEnv : undefined });
} catch {
  // dotenv اختیاری است؛ process.env مستقیم کافی است.
}

const clean = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || /[\u0600-\u06FF]/.test(trimmed) || /^(HOST_NAME|YOUR_|CHANGE_ME|TODO|FIXME)/i.test(trimmed)) return '';
  return trimmed;
};

const REQUIRED = [
  'DATABASE_URL',
  'PART_AUTH_USERNAME',
  'PART_AUTH_PASS',
  'SAMAD_ORG',
  'SAMAD_USER',
  'SAMAD_PASS',
  'CE_REPORT_HOST_MELLAT',
  'CE_REPORT_HOST_RESALAT',
  'CE_REPORT_HOST_POSTBANK',
];

const missing = REQUIRED.filter((name) => !clean(process.env[name]));
if (missing.length) {
  console.error('❌ تنظیمات محیطی ناقص است. فایل backend/.env را از روی .env.example بساز و مقادیر واقعی را وارد کن.');
  for (const name of missing) console.error(`   • ${name}`);
  console.error('ℹ️  پیشنیازهای خارج از این ریپو: PostgreSQL، رجیستری خصوصی پارت، سرویس سمد و هاست‌های *.partdp.ir.');
  process.exit(1);
}
console.log('✅ تنظیمات محیطی بکاند کامل است.');
console.log('ℹ️  اتصال واقعی به PostgreSQL / سمد / رجیستری پارت هنگام npm start مشخص میشود.');
