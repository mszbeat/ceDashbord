#!/usr/bin/env node
/**
 * اجرای مهاجرت‌های نسخه‌دار روی PostgreSQL: `npm run migrate`
 *
 * پیش از این، این اسکریپت هر بار `schema.sql` را کامل اجرا می‌کرد (D3). دو مشکل:
 *  ۱) هر استارت/دیپلوی، DDL تکرار می‌شد و قفل می‌گرفت و «کند شدن/تایم‌اوت» می‌ساخت،
 *  ۲) هیچ ردی از «چه نسخه‌ای اعمال شده» نبود، پس drift اسکیما بی‌صدا می‌ماند.
 *
 * حالا از `runMigrations` استفاده می‌شود: advisory lock، جدول `schema_migrations`،
 * هر فایل در یک ترنزکشن، و تشخیص تغییر checksum.
 *
 * استفاده:
 *   npm run migrate           # اعمال مهاجرت‌های اعمال‌نشده
 *   npm run migrate:status    # وضعیت بدون تغییر
 */
'use strict';

const { Pool } = require('pg');
const { config } = require('../config');
const { runMigrations, migrationStatus } = require('./migrations');

(async () => {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    // همان قاعدهٔ database.service: CE_DB_SSL=true ⇒ اتصال رمزنگاری‌شده
    ssl: String(process.env.CE_DB_SSL || '').toLowerCase() === 'true'
      ? { rejectUnauthorized: String(process.env.CE_DB_SSL_STRICT || 'true').toLowerCase() !== 'false' }
      : undefined,
  });
  const wantsStatus = process.argv.includes('--status') || process.env.npm_lifecycle_event === 'migrate:status';
  try {
    if (wantsStatus) {
      // `migrationStatus` برای هر فایل یک ردیف می‌دهد: {version,name,applied,appliedAt,drift}
      const rows = await migrationStatus(pool);
      const applied = rows.filter((r) => r.applied);
      const pending = rows.filter((r) => !r.applied);
      const drift = rows.filter((r) => r.drift === true);
      console.log(`فایل‌های مهاجرت: ${rows.length}`);
      console.log(`اعمال‌شده: ${applied.length}${applied.length ? ` (آخرین: ${applied[applied.length - 1].name})` : ''}`);
      console.log(`در انتظار: ${pending.length}${pending.length ? ` → ${pending.map((p) => p.name).join(', ')}` : ''}`);
      if (drift.length) {
        console.error(`⚠️  drift در checksum: ${drift.map((d) => d.name).join(', ')}`);
        process.exitCode = 1;
      }
      return;
    }

    const result = await runMigrations(pool);
    if (result.applied.length) {
      console.log(`✅ ${result.applied.length} مهاجرت اعمال شد: ${result.applied.join(', ')}`);
    } else {
      console.log('✅ اسکیما به‌روز است؛ مهاجرت جدیدی نبود.');
    }
    if ((process.env.CE_DB_SCHEMA || 'v1') === 'v2') {
      console.log('ℹ️  CE_DB_SCHEMA=v2 است؛ برای پرکردن جداول v2 «npm run migrate:v2» را اجرا کن.');
    }
  } catch (error) {
    console.error('❌ مهاجرت خطا داد:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
