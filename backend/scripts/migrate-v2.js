#!/usr/bin/env node
/**
 * مهاجرت دادهٔ v1 → v2 روی PostgreSQL واقعی.
 *
 *   npm run migrate:v2              # مهاجرت کامل (با پشتیبان)
 *   npm run migrate:v2 -- --dry-run # فقط گزارش؛ هیچ تغییری اعمال نمی‌شود
 *   npm run migrate:v2 -- --rollback
 *
 * پیش‌نیاز: `npm run migrate` (اسکیمای v1) قبلاً اجرا شده و `DATABASE_URL` معتبر است.
 * بعد از مهاجرت، برای استفادهٔ سرویس‌ها: `CE_DB_SCHEMA=v2`.
 */
'use strict';

// `services/config` خودش dotenv را (در صورت وجود) بارگذاری می‌کند
const { Pool } = require('pg');
const { config } = require('../services/config');
const { EvaluatorService } = require('../services/evaluator/evaluator.service');
const { buildRuntimeRegistry } = require('../services/db/schema-registry');
const { V1ToV2Migration } = require('../services/db/migrate-v2');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    rollback: argv.includes('--rollback'),
    batchSize: (() => {
      const found = argv.find((arg) => arg.startsWith('--batch-size='));
      return found ? Number(found.split('=')[1]) : 1000;
    })(),
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = {
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
  };
  const evaluator = new EvaluatorService();
  const { registry, banksSpecs } = buildRuntimeRegistry(evaluator);
  const migration = new V1ToV2Migration(db, {
    registry,
    banksSpecs,
    batchSize: args.batchSize,
    dryRun: args.dryRun,
    logger: { info: ({ message, meta }) => console.log(`• ${message}`, meta ? JSON.stringify(meta) : '') },
  });

  try {
    if (args.rollback) {
      const result = await migration.rollback();
      console.log('↩️  بازگشت به v1 انجام شد:', result.restored.join(', ') || '(چیزی برای بازگشت نبود)');
      return;
    }
    const stats = await migration.execute();
    const installed = (dbSchema) => console.log(`اسکیمای فعال را با CE_DB_SCHEMA=${dbSchema} تنظیم کن.`);
    let total = 0;
    for (const [bank, entry] of Object.entries(stats.banks)) {
      if (entry.skipped) {
        console.log(`⚠️  ${bank}: ${entry.reason} — رد شد`);
        continue;
      }
      total += entry.migrated || 0;
      console.log(`✅ ${bank}: ${entry.migrated ?? 0} ردیف، ${entry.details ?? 0} ردیف جزئیات (پشتیبان: ${entry.backup ?? '—'})`);
    }
    console.log(`📦 مجموع ${total} ردیف نمونه مهاجرت شد؛ ${stats.detailRows} ردیف در sample_detail.`);
    if (args.dryRun) console.log('ℹ️  dry-run: هیچ تغییری اعمال نشد.');
    else installed('v2');
  } catch (error) {
    console.error('❌ مهاجرت خطا داد:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
