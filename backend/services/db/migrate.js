#!/usr/bin/env node
/* اجرای migration روی PostgreSQL جانبی: npm run migrate */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { config } = require('../config');

(async () => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    // فقط نسخهٔ v1. مهاجرت داده به v2 جداگانه است: `npm run migrate:v2`
    await pool.query(sql);
    console.log('✅ Migration انجام شد: day_runs, samples_{mellat,resalat,postbank}, message_dict, sample_access_logs, cron_configs');
    if ((process.env.CE_DB_SCHEMA || 'v1') === 'v2') {
      console.log('ℹ️  CE_DB_SCHEMA=v2 است؛ برای ساخت/پرکردن جداول v2 «npm run migrate:v2» را اجرا کن.');
    }
  } catch (error) {
    console.error('❌ Migration خطا داد:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
