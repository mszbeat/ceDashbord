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
    await pool.query(sql);
    console.log('✅ Migration انجام شد: day_runs, samples_{mellat,resalat,postbank}, message_dict, sample_access_logs, cron_configs');
  } catch (error) {
    console.error('❌ Migration خطا داد:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
