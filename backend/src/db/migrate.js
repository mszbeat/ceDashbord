#!/usr/bin/env node
/* اجرای migration روی PostgreSQL جانبی: npm run migrate */
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ Migration انجام شد: day_runs, samples_{mellat,resalat,postbank}, message_dict, sample_access_logs');
  } catch (error) {
    console.error('❌ Migration خطا داد:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
