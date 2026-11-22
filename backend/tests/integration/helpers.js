'use strict';

/**
 * زیرساخت آزمون‌های یکپارچه روی PostgreSQL واقعی.
 *
 * این آزمون‌ها فقط وقتی `CE_TEST_PG=1` باشد اجرا می‌شوند (CI: image با سرویس postgres).
 * روی محیط بدون Postgres، هر تست به‌صورت skip گزارش می‌شود تا `npm test` سبز بماند.
 *
 *   CE_TEST_PG=1 PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres node --test tests/integration/*.test.js
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENABLED = process.env.CE_TEST_PG === '1';

let pg = null;
function pgModule() {
  if (pg) return pg;
  try {
    // `pg` وابستگی خود بک‌اند است
    pg = require('pg');
  } catch (error) {
    // در سندباکس توسعه، pg در node_modules مشترک bench نصب است
    pg = require(process.env.CE_PG_MODULE || '/home/user/bench/node_modules/pg');
  }
  return pg;
}

function configOf(database) {
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
    database,
  };
}

/** یک دیتابیس تازه با نام یکتا می‌سازد و آداپتور سازگار با سرویس‌ها برمی‌گرداند */
async function createTestDatabase(label = 'test') {
  const { Client } = pgModule();
  const name = `ce_${label}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Client(configOf(process.env.PGADMIN_DB || 'postgres'));
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const client = new Client(configOf(name));
  await client.connect();

  const run = async (text, params = []) => {
    const result = await client.query(text, params);
    return { rows: result.rows || [], rowCount: result.rowCount ?? (result.rows || []).length };
  };

  const adapter = {
    client,
    query: run,
    exec: (text) => client.query(text),
    async getClient() {
      return {
        query: run,
        release() {},
        // پشتیبانی از نسخهٔ pool-style برای شمارش BEGIN/COMMIT در تست‌ها
        _client: client,
      };
    },
    async close() {
      await client.end();
      const admin2 = new Client(configOf(process.env.PGADMIN_DB || 'postgres'));
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await admin2.end();
    },
    name,
  };
  return adapter;
}

/** اجرای یک تست با skip تمیز وقتی Postgres در دسترس نیست */
function pgTest(name, fn, options = {}) {
  const test = require('node:test');
  if (!ENABLED) {
    return test(name, { skip: 'CE_TEST_PG=1 لازم است (PostgreSQL واقعی)' }, () => {});
  }
  return test(name, options, fn);
}

module.exports = { ENABLED, ROOT, createTestDatabase, pgTest, pgModule, configOf };
