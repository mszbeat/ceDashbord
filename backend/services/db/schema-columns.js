'use strict';

/**
 * نام ستون‌های وابسته به اسکیما، در یک جا (B1 / اصلاح خطای ۵۰۰ پنل ادمین).
 *
 * چرا این ماژول لازم شد:
 *   پس از `npm run migrate:v2`، جدول‌های نمونه‌ها ستون `updated_at` ندارند
 *   (`created_at` دارند) و `day_runs` هم `skipped_count` ندارد
 *   (`skipped_other_method` دارد). سرویس ادمین این نام‌ها را مستقیم در SQL نوشته بود،
 *   پس روی v2 اولین درخواست `/api/admin/overview` با
 *   «column "updated_at" does not exist» → HTTP 500 می‌شکست.
 *
 * این ماژول همان اطلاعاتی را می‌دهد که `dialect-v2` از رجیستری استخراج می‌کند،
 * بدون وابستگی به نمونهٔ dialect — تا سرویس‌های دیگر (admin/health) هم بتوانند بخوانند.
 */

const SCHEMAS = {
  v1: {
    // v1: هر ردیف زمان بروزرسانی دارد و day_runs ستون skipped_count
    samplesUpdatedAt: 'updated_at',
    samplesDayExpression: 'day', // متنِ شمسی
    dayRunsSkipped: 'skipped_count',
    dayRunsHasDistinctStored: false,
  },
  v2: {
    samplesUpdatedAt: 'created_at', // در v2 ردیف بازنویسی می‌شود ولی created_at ثابت است
    samplesDayExpression: 'day', // date میلادی؛ تبدیل به شمسی در لایهٔ dialect انجام می‌شود
    dayRunsSkipped: 'skipped_other_method',
    dayRunsHasDistinctStored: true,
  },
};

/** @param {'v1'|'v2'|string} schema */
function columnsFor(schema) {
  return SCHEMAS[String(schema).toLowerCase()] || SCHEMAS.v1;
}

/** آیا ستون با این نام در جدول `day_runs` وجود دارد؟ (برای انتخاب پویا در کوئری) */
async function dayRunsHasColumn(db, column) {
  const result = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'day_runs' AND column_name = $1 LIMIT 1`,
    [column],
  );
  return result.rows.length > 0;
}

/**
 * نام ستون «ردشده» در day_runs را بر اساس **واقعیت دیتابیس** برمی‌گرداند، نه فقط تنظیمات.
 * اگر هر دو باشد، `skipped_other_method` (نام v2) ترجیح دارد.
 */
async function resolveDayRunsSkippedColumn(db, schema) {
  if (await dayRunsHasColumn(db, 'skipped_other_method')) return 'skipped_other_method';
  if (await dayRunsHasColumn(db, 'skipped_count')) return 'skipped_count';
  return columnsFor(schema).dayRunsSkipped;
}

/**
 * نام ستون «آخرین بروزرسانی» در جدول نمونه‌های یک بانک.
 * در v2 `created_at` وجود دارد؛ در v1 `updated_at`.
 */
async function resolveSamplesUpdatedColumn(db, table) {
  const result = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name IN ('updated_at','created_at')`,
    [table],
  );
  const names = result.rows.map((r) => r.column_name);
  if (names.includes('updated_at')) return 'updated_at';
  if (names.includes('created_at')) return 'created_at';
  return null; // هیچ‌کدام ⇒ مقدار تهی برگردانده می‌شود، بدون شکستن کوئری
}

module.exports = { columnsFor, SCHEMAS, resolveDayRunsSkippedColumn, resolveSamplesUpdatedColumn, dayRunsHasColumn };
