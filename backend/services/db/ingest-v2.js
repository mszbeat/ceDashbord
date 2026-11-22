'use strict';

/**
 * مسیر نوشتن v2: ردیف‌های `evaluator.evaluate` را به اسکیمای v2 می‌ریزد.
 *
 * تفاوت‌های اصلی با `IngestionService.upsertBatch` (v1):
 *  * ستون‌ها از رجیستری ساخته می‌شوند (نه فهرست ثابت ۲۸تایی) و تعدادشان per-bank است.
 *  * `display_extras` دیگر ستون ردیف نیست؛ جزئیات نمایشی به `sample_detail` می‌رود.
 *  * رشته‌های کم‌تنوع با کد در `value_dict` ذخیره می‌شوند (batch، نه یک INSERT/مقدار).
 *  * پارتیشن ماهانه قبل از درج تضمین می‌شود.
 *
 * این ماژول مستقل از `IngestionService` است تا مهاجرت تدریجی ممکن باشد: مسیر فعلی
 * دست نمی‌خورد، و `IngestionService` می‌تواند با یک فلگ (`dbSchema==='v2'`) به این‌جا
 * تفویض کند.
 */

const { KIND, columnName } = require('./indicator-registry');
const { createCatDict, tableNameOf, ensureMonthlyPartitions } = require('./schema-v2-builder');
const { ValueDict } = require('./value-dict');
const { toV2Row, columnMapsOf, toDateIso } = require('./row-mapper-v2');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getLogger() {
  try {
    return require('../logger/action-logger.service').getActionLogger();
  } catch {
    return null;
  }
}

const SAMPLE_COLUMNS = [
  'ts', 'flags', 'service_kinds', 'path_bits', 'total_time_s', 'pd', 'score_req', 'avg36',
  'ln_avg_installments', 'day', 'suggested_amount', 'overdue_amount', 'cheque_amount',
  'request_id', 'model_code', 'status_code', 'error_code', 'message_code', 'rotbe_code',
  'amount_kind', 'overdue_count', 'cheque_count', 'analysis_version', 'is_success',
  'has_overdue', 'has_cheque', 'bad_reports', 'unique_key', 'cat_codes', 'service_text_codes',
];

const DETAIL_COLUMNS = [
  'bank', 'day', 'request_id', 'flag_bits', 'rank_value',
  'cat_extra', 'list_extra', 'flag_extra', 'rank_extra', 'credit_extra', 'credit_value',
  'summary_extra',
];

class V2Writer {
  /**
   * @param {{query: Function}} db
   * @param {import('../evaluator/evaluator.service').EvaluatorService} evaluator
   * @param {{registry: Record<string, object>, banksSpecs: Record<string, object>,
   *          analysisVersions?: Record<string, number>, chunkSize?: number}} options
   */
  constructor(db, evaluator, options) {
    this.db = db;
    this.evaluator = evaluator;
    this.registry = options.registry;
    this.banksSpecs = options.banksSpecs || {};
    this.analysisVersions = options.analysisVersions || {};
    // اندازهٔ دسته‌ها: تجربهٔ Postgres واقعی نشان می‌دهد ۱۰۰۰ ردیف × ~۴۰ ستون
    // بهترین نقطه بین تعداد رفت‌وبرگشت و اندازهٔ پیام است (≥۵۰۰ تنهال پیشنهاد PG است).
    this.chunkSize = options.chunkSize ?? 1000;
    this.detailChunkSize = options.detailChunkSize ?? 500;
    /**
     * پارتیشن‌های ساخته‌شده در همین پروسه — تا هر دسته یک `CREATE TABLE … PARTITION OF`
     * تکراری اجرا نکند (اندازه‌گیری: DDL تکراری، نرخ درج را چند برابر کم می‌کرد).
     */
    this.ensuredPartitions = new Set();
    this.valueDict = new ValueDict(db, { notify: true });
    this.catDict = createCatDict(db);
    this.loaded = false;
  }

  async ready() {
    if (this.loaded) return;
    await this.valueDict.load();
    await this.catDict.load();
    this.loaded = true;
  }

  /** ستون‌های کامل یک بانک: پایه + typed متریک/کانتر */
  columnsOf(bankKey) {
    const registry = this.registry[bankKey];
    if (!registry) throw new Error(`بانک ناشناخته در رجیستری: ${bankKey}`);
    const { metricColumnMap, counterColumnMap } = columnMapsOf(registry);
    return {
      all: [...SAMPLE_COLUMNS, ...Object.values(metricColumnMap), ...Object.values(counterColumnMap)],
      ...registry,
      metricColumnMap,
      counterColumnMap,
    };
  }

  /**
   * درج/به‌روزرسانی یک دسته ردیف.
   * @param {{query: Function}} client تراکنش‌دار (pool client) یا db عادی
   * @param {string} bankKey
   * @param {object[]} rows خروجی `evaluator.evaluate`
   * @returns {Promise<{inserted:number, details:number, firstDay:string|null, lastDay:string|null}>}
   */
  /**
   * سقف سخت Postgres: ۶۵۵۳۵ پارامتر bind در هر دستور. تعداد ستون‌های typed هر بانک
   * متفاوت است، پس اندازهٔ دسته از تعداد ستون‌ها هم محدود می‌شود (نه فقط از chunkSize).
   */
  chunkFor(bankKey, requested) {
    const columns = this.columnsOf(bankKey).all.length;
    const maxByParams = Math.max(1, Math.floor(60000 / columns));
    return Math.max(1, Math.min(requested, maxByParams));
  }

  async upsertBatch(client, bankKey, rows) {
    if (!rows.length) return { inserted: 0, details: 0, firstDay: null, lastDay: null, invalidIds: [] };
    await this.ready();
    const table = tableNameOf(bankKey);
    const cols = this.columnsOf(bankKey);

    // B4 — طبق تصمیم صاحب پروژه، `request_id` همیشه UUID است.
    // شناسهٔ غیر-UUID ساخته نمی‌شود؛ ردیف با خطای شفاف و شمارندهٔ `skipped_invalid_id` رد می‌شود.
    const invalid = [];
    const valid = [];
    for (const row of rows) {
      const original = String(row.request_id ?? '').trim();
      if (!UUID_RE.test(original)) {
        invalid.push(original);
        continue;
      }
      row.request_id = original.toLowerCase();
      valid.push(row);
    }
    rows = valid;
    const deduped = new Map();
    for (const row of rows) deduped.set(`${row.day}\u0000${row.request_id}`, row);
    const uniqueRows = [...deduped.values()];

    const mapped = [];
    let firstDay = null;
    let lastDay = null;
    for (const row of uniqueRows) {
      const { sampleRow, detailRow } = toV2Row(row, {
        bankKey,
        registry: cols,
        valueDict: this.valueDict,
        catDict: this.catDict,
        analysisVersionCode: this.analysisVersions[bankKey] ?? 1,
        metricColumnMap: cols.metricColumnMap,
        counterColumnMap: cols.counterColumnMap,
      });
      sampleRow.service_text_codes = require('./row-mapper-v2').serviceTextsOf(
        row, cols, this.valueDict, bankKey,
      );
      mapped.push({ sampleRow, detailRow });
      if (sampleRow.day) {
        if (!firstDay || sampleRow.day < firstDay) firstDay = sampleRow.day;
        if (!lastDay || sampleRow.day > lastDay) lastDay = sampleRow.day;
      }
    }

    // پارتیشن ماهانه برای هر بازهٔ موجود در این دسته (فقط یک‌بار در هر پروسه)
    if (firstDay) {
      const monthKey = `${bankKey}:${String(firstDay).slice(0, 7)}..${String(lastDay).slice(0, 7)}`;
      if (!this.ensuredPartitions.has(monthKey)) {
        await ensureMonthlyPartitions(this.db, bankKey, firstDay, lastDay);
        this.ensuredPartitions.add(monthKey);
      }
    }

    // B5: اگر هیچ ستونی واقعاً عوض نشده باشد، UPDATE انجام نشود (جلوگیری از bloat در rebuild).
    // مقایسه با `IS DISTINCT FROM` روی همان ستون‌هایی که در SET آمده‌اند.
    const updates = cols.all
      .filter((column) => column !== 'request_id' && column !== 'day')
      .map((column) => `${column}=EXCLUDED.${column}`)
      .join(', ');
    const guard = cols.all
      .filter((column) => column !== 'request_id' && column !== 'day')
      .map((column) => `${table}.${column} IS DISTINCT FROM EXCLUDED.${column}`)
      .join(' OR ');

    const sampleChunk = this.chunkFor(bankKey, this.chunkSize);
    let inserted = 0;
    for (let start = 0; start < mapped.length; start += sampleChunk) {
      const chunk = mapped.slice(start, start + sampleChunk);
      const values = [];
      const params = [];
      chunk.forEach(({ sampleRow }, index) => {
        const offset = index * cols.all.length;
        values.push(`(${cols.all.map((_, c) => `$${offset + c + 1}`).join(',')})`);
        for (const column of cols.all) {
          const value = sampleRow[column];
          // آرایه‌ها (cat_codes/service_text_codes) به‌صورت literal پاس می‌شوند تا
          // درایور آن‌ها را رشتهٔ ساده تفسیر نکند.
          if (Array.isArray(value)) {
            params.push(value.length ? `{${value.join(',')}}` : '{}');
          } else {
            params.push(value === undefined ? null : value);
          }
        }
      });
      const result = await client.query(
        `INSERT INTO ${table} (${cols.all.join(',')}) VALUES ${values.join(',')}
         ON CONFLICT (day, request_id) DO UPDATE SET ${updates} WHERE ${guard}`,
        params,
      );
      inserted += result.rowCount ?? chunk.length;
    }

    // جزئیات نمایشی (اسپارس)
    const details = mapped.filter((item) => item.detailRow).map((item) => item.detailRow);
    const detailChunk = Math.max(1, Math.min(this.detailChunkSize, Math.floor(60000 / DETAIL_COLUMNS.length)));
    for (let start = 0; start < details.length; start += detailChunk) {
      const chunk = details.slice(start, start + detailChunk);
      const values = [];
      const params = [];
      chunk.forEach((detail, index) => {
        const offset = index * DETAIL_COLUMNS.length;
        values.push(`(${DETAIL_COLUMNS.map((_, c) => `$${offset + c + 1}`).join(',')})`);
        for (const column of DETAIL_COLUMNS) {
          const value = detail[column];
          params.push(value === undefined || value === null || typeof value !== 'object' ? value ?? null : JSON.stringify(value));
        }
      });
      await client.query(
        `INSERT INTO sample_detail (${DETAIL_COLUMNS.join(',')}) VALUES ${values.join(',')}
         ON CONFLICT (bank, day, request_id) DO UPDATE SET
           flag_bits=EXCLUDED.flag_bits, rank_value=EXCLUDED.rank_value,
           cat_extra=EXCLUDED.cat_extra, list_extra=EXCLUDED.list_extra,
           flag_extra=EXCLUDED.flag_extra, rank_extra=EXCLUDED.rank_extra,
           credit_extra=EXCLUDED.credit_extra, credit_value=EXCLUDED.credit_value,
           summary_extra=EXCLUDED.summary_extra`,
        params,
      );
    }

    await this.valueDict.flush(bankKey);
    await this.catDict.flush(bankKey);
    if (invalid.length) {
      getLogger()?.warn?.({
        category: 'ingestion',
        action: 'ingestion.v2.invalid_request_id',
        message: `${invalid.length} ردیف با شناسهٔ غیر-UUID رد شد`,
        meta: { bank: bankKey, sample: invalid.slice(0, 5) },
      });
    }
    return { inserted, details: details.length, firstDay, lastDay, invalidIds: invalid };
  }

  /**
   * ردیف‌های یک بازه را به شکل v1 برمی‌گرداند (برای `SummaryService`).
   * صفحه‌بندی keyset روی `(ts, request_id)`، دقیقاً مثل v1 روی `(stamp_key, request_id)`.
   */
  async readBatch(bankKey, fromIso, toIso, cursor, limit) {
    const table = tableNameOf(bankKey);
    const cols = this.columnsOf(bankKey);
    const { fromV2Row } = require('./row-mapper-v2');
    const result = await this.db.query(
      `SELECT s.*, d.flag_extra, d.cat_extra, d.list_extra, d.rank_extra, d.credit_extra,
              d.rank_value AS detail_rank
         FROM ${table} s
         LEFT JOIN sample_detail d
           ON d.bank = $3 AND d.day = s.day AND d.request_id = s.request_id
        WHERE s.day BETWEEN $1::date AND $2::date
          AND (s.ts, s.request_id) > ($4::bigint, $5::uuid)
        ORDER BY s.ts, s.request_id
        LIMIT $6`,
      [fromIso, toIso, bankKey, cursor[0], cursor[1], limit],
    );
    return result.rows.map((row) => fromV2Row({
      sample: row,
      detail: {
        flag_extra: row.flag_extra,
        cat_extra: row.cat_extra,
        list_extra: row.list_extra,
        rank_extra: row.rank_extra,
        credit_extra: row.credit_extra,
      },
      valueDict: this.valueDict,
      catDict: this.catDict,
      bankKey,
      registry: cols,
    }));
  }

  async countRange(bankKey, fromIso, toIso) {
    const table = tableNameOf(bankKey);
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS total FROM ${table} WHERE day BETWEEN $1::date AND $2::date`,
      [fromIso, toIso],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async distinctDays(bankKey, fromIso, toIso) {
    const table = tableNameOf(bankKey);
    const result = await this.db.query(
      `SELECT DISTINCT day FROM ${table} WHERE day BETWEEN $1::date AND $2::date ORDER BY day`,
      [fromIso, toIso],
    );
    return result.rows.map((row) => toJalali(row.day));
  }
}

function toJalali(value) {
  return require('./row-mapper-v2').toJalaliDay(value);
}

module.exports = { V2Writer, SAMPLE_COLUMNS, DETAIL_COLUMNS };
