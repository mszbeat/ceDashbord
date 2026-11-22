'use strict';

/**
 * لایهٔ دسترسی `day_runs` — همان کاری که dialect برای جداول نمونه می‌کند.
 *
 * چرا؟ در v1 ستون‌ها `skipped_count`/`ingested_count` هستند و در v2
 * `skipped_other_method`/`distinct_stored`. `IngestionService` نباید بداند کدام اسکیما
 * فعال است؛ نام‌های عمومی (canonical) این‌جا به ستون‌های واقعی نگاشت می‌شوند.
 *
 * نام‌های عمومی:
 *   ingested_count       ← v1: ingested_count            | v2: ingested_count
 *   skipped_count        ← v1: skipped_count             | v2: skipped_other_method
 *   error_count          ← v1: error_count               | v2: error_count
 *   distinct_stored      ← v1: distinct_stored           | v2: distinct_stored
 *
 * سیاست شمارش (فاز ۴):
 *   skipped = فقط «رد مجاز» (روش دیگر / شناسهٔ نامعتبر) — مانع complete نمی‌شود
 *   error   = خطای واقعی (استثنا در پردازش یا خطای API) — مانع complete می‌شود
 */

const CANONICAL_TO_V1 = {
  ingested_count: 'ingested_count',
  skipped_count: 'skipped_count',
  error_count: 'error_count',
  distinct_stored: 'distinct_stored',
  source_total: 'source_total',
  checkpoint: 'checkpoint',
  success_count: 'success_count',
  fail_count: 'fail_count',
  status: 'status',
  mode: 'mode',
  error: 'error',
  started_at: 'started_at',
  finished_at: 'finished_at',
  analysis_version: 'analysis_version',
};

const CANONICAL_TO_V2 = {
  ingested_count: 'ingested_count',
  skipped_count: 'skipped_other_method',
  error_count: 'error_count',
  distinct_stored: 'distinct_stored',
  source_total: 'source_total',
  checkpoint: 'checkpoint',
  success_count: 'success_count',
  fail_count: 'fail_count',
  status: 'status',
  mode: 'mode',
  error: 'error',
  started_at: 'started_at',
  finished_at: 'finished_at',
  analysis_version: 'analysis_version',
};

class RunStore {
  /**
   * @param {object} db آداپتور دیتابیس
   * @param {{schema?: 'v1'|'v2'|string, table?: string, columnMap?: object}} options
   */
  constructor(db, options = {}) {
    this.db = db;
    this.schema = options.schema === 'v2' ? 'v2' : 'v1';
    // v1: روز به‌صورت متن شمسی ذخیره می‌شود؛ v2: ستون `date` میلادی
    this.dayParam = this.schema === 'v2' ? '$2::date' : '$2::text';
    this.map = options.columnMap || (this.schema === 'v2' ? CANONICAL_TO_V2 : CANONICAL_TO_V1);
  }

  /** روز شمسی → مقدار ستون `day` برای همان اسکیما */
  dayValue(day) {
    if (this.schema !== 'v2') return String(day);
    const { toDateIso } = require('./row-mapper-v2');
    return toDateIso(String(day));
  }

  columnOf(canonical) {
    const column = this.map[canonical];
    if (!column) throw new Error(`RunStore: ستون ناشناخته «${canonical}»`);
    return column;
  }

  async find(client, bankKey, day) {
    const db = client || this.db;
    const result = await db.query(
      `SELECT checkpoint, status${this.schema === 'v2' ? ', distinct_stored' : ''}
         FROM day_runs WHERE bank=$1 AND day=${this.dayParam}`,
      [bankKey, this.dayValue(day)],
    );
    return result.rows[0] || null;
  }

  /** ثبت ردیف اجرا (upsert) */
  async upsert(client, bankKey, day, patch) {
    const db = client || this.db;
    const entries = Object.entries(patch);
    const columns = ['bank', 'day', ...entries.map(([key]) => this.columnOf(key))];
    const values = [bankKey, this.dayValue(day), ...entries.map(([, value]) => value)];
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updatable = columns.slice(2);
    const sets = updatable
      .map((column) => `${column}=EXCLUDED.${column}`)
      .concat('updated_at=now()');
    await db.query(
      `INSERT INTO day_runs(${columns.join(',')}) VALUES(${placeholders.join(',')})
       ON CONFLICT(bank, day) DO UPDATE SET ${sets.join(', ')}`,
      values,
    );
  }

  /** به‌روزرسانی جزئی — کلیدها canonical هستند */
  async update(client, bankKey, day, patch) {
    const db = client || this.db;
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([key], index) => `${this.columnOf(key)}=$${index + 3}`);
    await db.query(
      `UPDATE day_runs SET ${sets.join(', ')}, updated_at=now() WHERE bank=$1 AND day=${this.dayParam}`,
      [bankKey, this.dayValue(day), ...entries.map(([, value]) => value)],
    );
  }

  /** شمارش متمایز شناسه‌های ذخیره‌شدهٔ یک روز (برای فرض «همه رسیدند») */
  async countDistinct(client, bankKey, day, table) {
    const db = client || this.db;
    const result = await db.query(
      `SELECT COUNT(DISTINCT request_id)::int AS n FROM ${table} WHERE day=${this.schema === 'v2' ? '$1::date' : '$1::text'}`,
      [this.dayValue(day)],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async remove(client, bankKey, day) {
    const db = client || this.db;
    await db.query(`DELETE FROM day_runs WHERE bank=$1 AND day=${this.dayParam}`, [bankKey, this.dayValue(day)]);
  }
}

module.exports = { RunStore, CANONICAL_TO_V1, CANONICAL_TO_V2 };
