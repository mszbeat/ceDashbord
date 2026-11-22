'use strict';

/**
 * D3 — مهاجرت‌های نسخه‌دار (به‌جای اجرای `schema.sql` در هر شروع).
 *
 * چرا: `schema.sql` کل ساختار را با `CREATE TABLE IF NOT EXISTS` می‌سازد؛ این کار
 *  * در هر شروع کوئری‌های DDL اجرا می‌کند (قفل و ریسک روی دیتابیس زنده)،
 *  * تغییرات آیندهٔ ساختار را نمی‌تواند بیان کند،
 *  * نمی‌داند کدام نسخه روی دیتابیس نصب است.
 *
 * این ماژول یک جدول `schema_migrations` نگه می‌دارد و هر فایل `migrations/NNN-*.sql` را
 * **یک‌بار** و در یک تراکنش (با قفل مشورتی) اجرا می‌کند. اجرای دوباره بی‌اثر است.
 *
 *   node services/db/migrations.js            # اجرا
 *   node services/db/migrations.js --status   # فقط وضعیت
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 'ce-schema-migrations';

function listFiles() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const file = path.join(DIR, name);
      const sql = fs.readFileSync(file, 'utf8');
      return {
        version: name.slice(0, 3),
        name,
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex').slice(0, 32),
      };
    });
}

async function ensureTable(db) {
  /**
   * `CREATE TABLE IF NOT EXISTS` جدولِ موجود را تغییر نمی‌دهد. پیش از این نسخه‌دار شدن
   * مهاجرت‌ها، `schema-v2.sql` همان جدول را با شکل ساده (`version`, `applied_at`) می‌ساخت؛
   * روی چنان دیتابیسی، اجرای مهاجرت با
   *   «column "name" of relation "schema_migrations" does not exist»
   * شکست می‌خورد. پس ستون‌های لازم افزایشی اضافه می‌شوند (بدون حذف چیزی).
   */
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )`);
  await db.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS name text");
  await db.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
  await db.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS duration_ms integer NOT NULL DEFAULT 0");
  // ردیف‌های قدیمیِ بدون نام/checksum نباید مانع درج‌های تازه شوند
  await db.query("UPDATE schema_migrations SET name = COALESCE(name, version), checksum = COALESCE(checksum, 'legacy') WHERE name IS NULL OR checksum IS NULL");
  await db.query("ALTER TABLE schema_migrations ALTER COLUMN name SET NOT NULL");
  await db.query("ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL");
}

/**
 * اجرای مهاجرت‌های اعمال‌نشده.
 * @param {{query: Function, getClient?: Function}} db
 * @returns {Promise<{applied: string[], skipped: string[], statuses: object[]}>}
 */
async function runMigrations(db) {
  const files = listFiles();
  const client = db.getClient ? await db.getClient() : null;
  const runner = client || db;
  const applied = [];
  const skipped = [];
  try {
    // قفل مشورتی: دو نمونهٔ هم‌زمان نمی‌توانند هم‌زمان مهاجرت بزنند
    await runner.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await ensureTable(runner);
    const existing = await runner.query('SELECT version, name, checksum, applied_at FROM schema_migrations');
    const map = new Map(existing.rows.map((row) => [String(row.version), row]));
    const statuses = [];
    for (const file of files) {
      const seen = map.get(file.version);
      if (seen) {
        skipped.push(file.name);
        statuses.push({
          version: file.version,
          name: file.name,
          applied: true,
          appliedAt: seen.applied_at,
          checksumMatches: String(seen.checksum) === file.checksum,
        });
        if (String(seen.checksum) !== file.checksum) {
          // فایل تغییر کرده ولی نسخه همان است — نسخهٔ جدید لازم است، نه ویرایش قدیمی
          throw new Error(
            `مهاجرت ${file.name} بعد از اعمال تغییر کرده است (checksum متفاوت). فایل جدید با نسخهٔ بعدی بساز.`,
          );
        }
        continue;
      }
      const started = Date.now();
      await runner.query('BEGIN');
      try {
        await runner.query(file.sql);
        await runner.query(
          'INSERT INTO schema_migrations(version, name, checksum, duration_ms) VALUES($1,$2,$3,$4)',
          [file.version, file.name, file.checksum, Date.now() - started],
        );
        await runner.query('COMMIT');
        applied.push(file.name);
        statuses.push({ version: file.version, name: file.name, applied: true, appliedAt: new Date().toISOString(), checksumMatches: true });
      } catch (error) {
        await runner.query('ROLLBACK').catch(() => undefined);
        throw new Error(`اجرای ${file.name} شکست خورد: ${error.message}`);
      }
    }
    return { applied, skipped, statuses };
  } finally {
    await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => undefined);
    if (client?.release) client.release();
  }
}

/** وضعیت مهاجرت‌ها بدون اجرا */
async function migrationStatus(db) {
  const files = listFiles();
  await ensureTable(db);
  const existing = await db.query('SELECT version, applied_at, checksum FROM schema_migrations');
  const map = new Map(existing.rows.map((row) => [String(row.version), row]));
  return files.map((file) => ({
    version: file.version,
    name: file.name,
    applied: map.has(file.version),
    appliedAt: map.get(file.version)?.applied_at ?? null,
    drift: map.has(file.version) ? String(map.get(file.version).checksum) !== file.checksum : null,
  }));
}

module.exports = { runMigrations, migrationStatus, listFiles, DIR };

if (require.main === module) {
  (async () => {
    const { DatabaseService } = require('./database.service');
    const db = new DatabaseService(undefined, { role: 'write' });
    try {
      if (process.argv.includes('--status')) {
        const status = await migrationStatus(db);
        for (const row of status) {
          console.log(`${row.applied ? '✔' : '·'} ${row.version} ${row.name}${row.drift ? '  ⚠ checksum متفاوت' : ''}`);
        }
      } else {
        const out = await runMigrations(db);
        console.log(`مهاجرت‌های اعمال‌شده: ${out.applied.length ? out.applied.join(', ') : '— (همه از قبل اعمال شده بودند)'}`);
      }
    } catch (error) {
      console.error('❌', error.message);
      process.exitCode = 1;
    } finally {
      await db.close();
    }
  })();
}
