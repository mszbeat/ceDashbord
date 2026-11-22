'use strict';

/**
 * ۵۰۰ پنل ادمین روی اسکیمای v2.
 *
 * باگ واقعی گزارش‌شده: `migrate:v2` جدول‌های typed می‌سازد که ستون `updated_at` ندارند
 * (`created_at` دارند) و `day_runs` ستون `skipped_other_method` دارد (نه `skipped_count`).
 * سرویس ادمین این نام‌ها را مستقیم در SQL نوشته بود ⇒ اولین درخواست `/api/admin/overview`
 * با «column "updated_at" does not exist» → HTTP 500.
 *
 * این تست همان مسیر را روی PostgreSQL واقعی می‌بندد.
 */

process.env.DISABLE_FILE_LOGS = '1';
process.env.DISABLE_DB_ACTION_LOGS = '1';
process.env.LOG_CONSOLE = 'false';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, createTestDatabase, pgTest } = require('./helpers');

pgTest('v2: overview/checkExistingData بدون ۵۰۰ و با روز شمسی درست', async () => {
  const db = await createTestDatabase('adminv2');
  try {
    const builder = require(path.join(ROOT, 'services', 'db', 'schema-v2-builder'));
    const { EvaluatorService } = require(path.join(ROOT, 'services', 'evaluator', 'evaluator.service'));
    const { AdminService } = require(path.join(ROOT, 'services', 'admin', 'admin.service'));

    const evaluator = new EvaluatorService();
    const { buildRuntimeRegistry } = require(path.join(ROOT, 'services', 'db', 'schema-registry'));
    const { registry, banksSpecs } = buildRuntimeRegistry(evaluator);
    // فقط جداول مدیریتی (day_runs و …) لازم است؛ جدول‌های نمونهٔ v1 را کنار می‌گذاریم
    // تا builder همان کاری را بکند که `migrate:v2` می‌کند.
    await require(path.join(ROOT, 'services', 'db', 'migrations')).runMigrations(db);
    for (const table of ['samples_mellat', 'samples_resalat', 'samples_postbank']) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(`ALTER TABLE ${table} RENAME TO ${table}_v1_backup`);
    }
    await builder.applySchemaV2(db, { registry, banks: Object.keys(registry) });
    await builder.seedRegistry(db, { registry, banksSpecs });
    await builder.seedListSpecs(db, { banksSpecs });

    // یک روز واقعی: 2026-10-23 = 1405-08-01
    await db.query(
      `INSERT INTO day_runs(bank, day, mode, status, source_total, skipped_other_method, success_count, fail_count)
       VALUES('tavan_mellat','2026-10-23','nightly','complete',10,2,8,2)`,
    );

    const admin = new AdminService(db, null, { dbSchema: 'v2' });

    // ۱) overview نباید بشکند (باگ اصلی)
    const overview = await admin.getOverview();
    assert.equal(overview.banks.length, 3);
    assert.equal(overview.recentDayRuns.length, 1, 'اجرای روز خوانده شد');

    // ۲) ستون skipped در قالب نام قدیمی برگردد تا UI نشکند
    assert.equal(Number(overview.recentDayRuns[0].skipped_count), 2, 'skipped_count از skipped_other_method');

    // ۳) روز باید شمسی باشد، نه ISO میلادی
    assert.equal(overview.recentDayRuns[0].day, '1405-08-01', 'روز به شمسی تبدیل شد');
    assert.equal(overview.banks[0].latestRun.day, '1405-08-01');

    // ۴) مسیر بررسی داده‌های موجود هم روی day از نوع date کار کند
    const existing = await admin.checkExistingData({ banks: ['tavan_mellat'], days: ['2026-10-23'] });
    assert.equal(existing.items.length, 1);
    assert.ok('exists' in existing.items[0]);
  } finally {
    await db.close();
  }
}, { timeout: 120000 });
