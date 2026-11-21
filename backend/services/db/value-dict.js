'use strict';

/**
 * دیکشنری عمومی `(bank, kind, value) → code` برای رشته‌های کم‌تنوع.
 *
 * چرا لازم است: در v1 متن‌هایی مثل `model_name='tarkibi_model'`، `status_code='200'`،
 * `message_key`، `amount_kind` و نام سرویس‌ها در **هر ردیف** تکرار می‌شوند. این ماژول
 * هر مقدار را یک‌بار در `value_dict` ثبت می‌کند و در ردیف فقط `smallint` می‌نشیند.
 *
 * نکتهٔ مهم (سازگاری): `fromV2Row` مقدار را از همین دیکشنری برمی‌گرداند، پس رفتار
 * `summary`/`report` همه‌جا یکسان می‌ماند؛ فقط نمایش ذخیره‌سازی عوض شده است.
 *
 * کش و ابطال: کدها در پروسه کش می‌شوند. `NOTIFY ce_value_dict` بعد از هر مقدار جدید
 * فرستاده می‌شود تا نمونه‌های دیگر (یا پروسهٔ cron و API) کش خود را دور بریزند.
 */

const CATALOG_KINDS = ['model', 'status', 'error', 'message', 'amountKind', 'service'];

class ValueDict {
  /**
   * @param {{query: Function}} db
   * @param {{notify?: boolean}} options
   */
  constructor(db, { notify = false } = {}) {
    this.db = db;
    this.notify = notify;
    /** @type {Map<string, Map<string, number>>} `bank:kind` → value → code */
    this.cache = new Map();
    /** @type {Map<string, Map<number, string>>} */
    this.reverse = new Map();
    /** @type {Map<string, number>} بالاترین کد صادرشده در هر (bank,kind) */
    this.maxCode = new Map();
    this.loaded = false;
  }

  key(bank, kind) {
    return `${bank}:${kind}`;
  }

  async load(bank) {
    const sql = bank
      ? 'SELECT bank, kind, value, code FROM value_dict WHERE bank=$1'
      : 'SELECT bank, kind, value, code FROM value_dict';
    const result = await this.db.query(sql, bank ? [bank] : []);
    for (const row of result.rows) {
      this.remember(row.bank, row.kind, row.value, Number(row.code));
    }
    this.loaded = true;
  }

  remember(bank, kind, value, code) {
    const key = this.key(bank, kind);
    if (!this.cache.has(key)) this.cache.set(key, new Map());
    if (!this.reverse.has(key)) this.reverse.set(key, new Map());
    this.cache.get(key).set(value, code);
    this.reverse.get(key).set(code, value);
    this.maxCode.set(key, Math.max(this.maxCode.get(key) || 0, code));
  }

  /** کش را دور می‌ریزد (بعد از NOTIFY از سمت دیگر) */
  invalidate() {
    this.cache.clear();
    this.reverse.clear();
    this.maxCode.clear();
    this.loaded = false;
  }

  /**
   * کد یک مقدار را برمی‌گرداند؛ در صورت نبودن، ثبت محلی می‌کند.
   * توجه: ثبت در DB با `flush` انجام می‌شود (batch، نه یک INSERT برای هر مقدار).
   */
  codeOf(bank, kind, value) {
    if (value === null || value === undefined) return null;
    const text = String(value);
    const key = this.key(bank, kind);
    const map = this.cache.get(key);
    if (map && map.has(text)) return map.get(text);
    const reverse = this.reverse.get(key) || new Map();
    this.reverse.set(key, reverse);
    // بیشترین کد تا این لحظه (کش‌شده، نه پیمایش)
    let code = (this.maxCode.get(key) || 0) + 1;
    this.remember(bank, kind, text, code);
    return code;
  }

  valueOf(bank, kind, code) {
    if (code === null || code === undefined) return null;
    const reverse = this.reverse.get(this.key(bank, kind));
    if (!reverse) return null;
    const value = reverse.get(Number(code));
    return value === undefined ? null : value;
  }

  /** ثبت مقادیر کش‌شدهٔ یک بانک در جدول (idempotent) */
  async flush(bank) {
    let inserted = 0;
    for (const kind of CATALOG_KINDS) {
      const map = this.cache.get(this.key(bank, kind));
      if (!map || !map.size) continue;
      const rows = [...map.entries()];
      for (let start = 0; start < rows.length; start += 200) {
        const chunk = rows.slice(start, start + 200);
        const values = chunk.map((_, index) => `($1,$${index * 3 + 2},$${index * 3 + 3},$${index * 3 + 4})`).join(',');
        const params = [bank];
        // ترتیب ستون‌ها: (bank, kind, value, code)
        for (const [value, code] of chunk) params.push(kind, value, code);
        const result = await this.db.query(
          `INSERT INTO value_dict(bank, kind, value, code) VALUES ${values}
           ON CONFLICT (bank, kind, value) DO NOTHING`,
          params,
        );
        inserted += result.rowCount ?? chunk.length;
      }
    }
    if (inserted && this.notify) {
      await this.db.query("NOTIFY ce_value_dict, 'reload'").catch(() => {});
    }
    return inserted;
  }
}

module.exports = { ValueDict, CATALOG_KINDS };
