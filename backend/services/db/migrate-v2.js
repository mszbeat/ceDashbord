'use strict';

/**
 * مهاجرت دادهٔ v1 → v2.
 *
 * اصول:
 *  * **غیرمخرب**: جدول‌های v1 حذف نمی‌شوند؛ فقط `samples_*` به `samples_*_v1_backup`
 *    تغییر نام می‌دهند (اگر وجود داشته باشند) تا بازگشت با یک دستور ممکن باشد.
 *  * **قابل تکرار**: اگر v2 از قبل بخشی‌اش انجام شده باشد، ادامه می‌دهد (idempotent).
 *  * **بازگشت‌پذیر**: `rollback()` همه‌چیز را به وضعیت v1 برمی‌گرداند.
 *
 * اجرا از CLI:  `npm run migrate:v2`  یا  `node scripts/migrate-v2.js --rollback`
 */

const fs = require('node:fs');
const path = require('node:path');
const { KIND } = require('./indicator-registry');
const {
  applySchemaV2, seedRegistry, seedListSpecs, tableNameOf, SAMPLE_COLUMNS_PREFIX,
} = require('./schema-v2-builder');
const { toV2Row, serviceTextsOf, columnMapsOf } = require('./row-mapper-v2');
const { ValueDict } = require('./value-dict');
const { ensureUuid, needsMapping } = require('./uuid-map');

const SAMPLE_COLUMNS = [
  'ts', 'flags', 'service_kinds', 'path_bits', 'total_time_s', 'pd', 'score_req', 'avg36',
  'ln_avg_installments', 'day', 'suggested_amount', 'overdue_amount', 'cheque_amount',
  'request_id', 'external_id', 'model_code', 'status_code', 'error_code', 'message_code',
  'rotbe_code', 'amount_kind', 'overdue_count', 'cheque_count', 'analysis_version',
  'is_success', 'has_overdue', 'has_cheque', 'bad_reports', 'unique_key', 'cat_codes',
  'service_text_codes',
];

const DETAIL_COLUMNS = [
  'bank', 'day', 'request_id', 'flag_bits', 'rank_value',
  'cat_extra', 'list_extra', 'flag_extra', 'rank_extra', 'credit_extra', 'credit_value',
  'summary_extra',
];

const BACKUP_SUFFIX = '_v1_backup';

function asJson(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

/** ستون خروجی `evaluate` را به شکل v1 برمی‌گرداند (برای انتقال، نه نمایش) */
function rowToV1(row) {
  return {
    request_id: String(row.request_id),
    day: String(row.day),
    inserted_at: row.inserted_at ?? row.stamp_key ?? null,
    stamp_key: row.stamp_key ?? row.inserted_at ?? null,
    unique_key: row.unique_key ?? null,
    is_success: !!row.is_success,
    model_name: row.model_name ?? null,
    status_code: row.status_code ?? null,
    error_code: row.error_code ?? null,
    message_key: row.message_key ?? null,
    total_time_s: row.total_time_s,
    pd: row.pd,
    suggested_amount: row.suggested_amount,
    amount_kind: row.amount_kind ?? null,
    score_req: row.score_req,
    avg36: row.avg36,
    ln_avg_installments: row.ln_avg_installments,
    rotbe: row.rotbe ?? null,
    flags: asJson(row.flags),
    cats: asJson(row.cats),
    counters: asJson(row.counters),
    metrics: asJson(row.metrics),
    paths: asJson(row.paths),
    services: asJson(row.services),
    credit_alerts: row.credit_alerts ? asJson(row.credit_alerts) : null,
    display_extras: asJson(row.display_extras),
    analysis_version: row.analysis_version ?? null,
  };
}

class V1ToV2Migration {
  /**
   * @param {{query: Function}} db
   * @param {{registry: Record<string, object>, banksSpecs: Record<string, object>,
   *          logger?: object, batchSize?: number, dryRun?: boolean}} options
   */
  constructor(db, options) {
    this.db = db;
    this.registry = options.registry;
    this.banksSpecs = options.banksSpecs;
    this.logger = options.logger || console;
    this.batchSize = options.batchSize ?? 500;
    this.dryRun = !!options.dryRun;
    this.valueDict = new ValueDict(db);
    this.stats = { banks: {}, detailRows: 0, startedAt: null, finishedAt: null };
  }

  log(message, meta = {}) {
    if (typeof this.logger.info === 'function') this.logger.info({ category: 'migration', action: 'migrate.v2', message, meta });
    else this.logger.log?.(message, meta);
  }

  async tableExists(name) {
    const result = await this.db.query(
      "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
      [name],
    );
    return Number(result.rows[0]?.n ?? 0) > 0;
  }

  async columnExists(table, column) {
    const result = await this.db.query(
      "SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
      [table, column],
    );
    return Number(result.rows[0]?.n ?? 0) > 0;
  }

  /**
   * ۱) اسکیما و رجیستری، ۲) تغییر نام جدول‌های v1 (پشتیبان)، ۳) ساخت جدول v2،
   * ۴) انتقال داده، ۵) به‌روزرسانی day_runs و بازگشت نام جدول‌های پشتیبان به پایان کار.
   */
  /**
   * مرحلهٔ ۰: جدول‌های v1 را قبل از هر DDL v2 کنار می‌گذاریم.
   * (اگر اول تابع v2 اجرا شود، `CREATE INDEX … ON samples_x (day, ts, …)` روی جدول v1
   *  که ستون `ts` ندارد شکست می‌خورد.)
   */
  async prepareV1() {
    const moved = [];
    for (const bankKey of Object.keys(this.registry)) {
      const table = tableNameOf(bankKey);
      const backup = `${table}${BACKUP_SUFFIX}`;
      const hasV1 = await this.tableExists(table);
      const hasBackup = await this.tableExists(backup);
      if (!hasV1 && !hasBackup) continue;
      if (hasV1 && !(await this.columnExists(table, 'ts'))) {
        if (!this.dryRun) {
          await this.db.query(`ALTER TABLE ${table} RENAME TO ${backup}`);
          this.log(`پشتیبان v1 ساخته شد: ${backup}`);
        }
        moved.push({ bankKey, backup });
      } else if (hasBackup) {
        moved.push({ bankKey, backup, resumed: true });
      }
    }
    return moved;
  }

  async run() {
    this.stats.startedAt = new Date().toISOString();
    const bankKeys = Object.keys(this.registry);
    this.log('شروع مهاجرت v1 → v2', { banks: bankKeys, dryRun: this.dryRun });

    // ── ۰) کنارگذاشتن جدول‌های v1 + day_runs + ساخت اسکیمای ثابت ──
    const prepared = await this.prepareV1();
    const dayRunsMoved = await this.prepareDayRuns();
    await applySchemaV2(this.db, { registry: this.registry, banks: this.dryRun ? [] : bankKeys });
    await seedRegistry(this.db, { registry: this.registry, banksSpecs: this.banksSpecs });
    await seedListSpecs(this.db, { banksSpecs: this.banksSpecs });

    for (const bankKey of bankKeys) {
      const table = tableNameOf(bankKey);
      const backup = `${table}${BACKUP_SUFFIX}`;
      const entry = { bankKey, table, sourceRows: 0, migrated: 0, details: 0, backup: null, skipped: false };

      const found = prepared.find((item) => item.bankKey === bankKey);
      if (!found) {
        entry.skipped = true;
        entry.reason = 'جدول v1 وجود ندارد';
        this.stats.banks[bankKey] = entry;
        continue;
      }
      entry.backup = found.backup;
      entry.resumed = !!found.resumed;

      // ── ۲/۳) ساخت جدول v2 از قبل انجام شده؛ فقط در dry-run چیزی منتقل نمی‌شود ──
      if (this.dryRun) {
        this.stats.banks[bankKey] = entry;
        continue;
      }

      const source = entry.backup || table;
      if (!(await this.tableExists(source))) {
        this.stats.banks[bankKey] = entry;
        continue;
      }

      // ── ۴) انتقال داده‌ها به‌صورت صفحه‌بندی‌شده ──
      const count = await this.db.query(`SELECT COUNT(*)::int AS n FROM ${source}`);
      entry.sourceRows = Number(count.rows[0]?.n ?? 0);
      const migrated = await this.copyRows(bankKey, source, table, entry);
      entry.migrated = migrated.rows;
      entry.details = migrated.details;
      this.stats.detailRows += migrated.details;

      this.stats.banks[bankKey] = entry;
      this.log(`بانک ${bankKey}: ${entry.migrated} ردیف مهاجرت شد`, entry);
    }

    if (dayRunsMoved.moved) {
      this.stats.dayRuns = await this.migrateDayRuns();
      this.log(`day_runs منتقل شد: ${this.stats.dayRuns} ردیف`, { backup: dayRunsMoved.backup });
    }
    // D3: همان قرارداد ستون‌ها که `migrations.js` انتظار دارد (name/checksum اجباری‌اند)
    await this.db.query(
      `INSERT INTO schema_migrations(version, name, checksum, duration_ms)
       VALUES('002b-v2-data', 'migrate-v2 (data)', 'runtime-migration', 0)
       ON CONFLICT (version) DO NOTHING`,
    );
    await this.db.query('ANALYZE');
    this.stats.finishedAt = new Date().toISOString();
    return this.stats;
  }

  /** انتقال صفحه‌ای ردیف‌های v1 → v2 */
  async copyRows(bankKey, source, target, entry) {
    const registry = this.registry[bankKey];
    const maps = columnMapsOf(registry);
    const metricColumns = Object.values(maps.metricColumnMap);
    const counterColumns = Object.values(maps.counterColumnMap);
    const allColumns = [...SAMPLE_COLUMNS, ...metricColumns, ...counterColumns];

    let cursor = '';
    let rows = 0;
    let details = 0;
    const analysisVersionCode = 1;

    for (;;) {
      const batch = await this.db.query(
        `SELECT * FROM ${source}
          WHERE ($1 = '' OR request_id > $1)
          ORDER BY request_id
          LIMIT $2::int`,
        [cursor, this.batchSize],
      );
      if (!batch.rows.length) break;

      const mapped = [];
      for (const raw of batch.rows) {
        const row = rowToV1(raw);
        const externalId = needsMapping(row.request_id) ? row.request_id : null;
        row.request_id = ensureUuid(row.request_id);
        const { sampleRow, detailRow } = toV2Row(row, {
          bankKey,
          registry,
          valueDict: this.valueDict,
          catDict: this._catDict,
          analysisVersionCode,
          externalId,
          ...maps,
        });
        sampleRow.service_text_codes = serviceTextsOf(row, registry, this.valueDict, bankKey);
        mapped.push({ sampleRow, detailRow, externalId });
      }

      const values = [];
      const params = [];
      mapped.forEach(({ sampleRow }, index) => {
        const offset = index * allColumns.length;
        values.push(`(${allColumns.map((_, c) => `$${offset + c + 1}`).join(',')})`);
        for (const column of allColumns) {
          const value = sampleRow[column];
          params.push(Array.isArray(value) ? (value.length ? `{${value.join(',')}}` : '{}') : value === undefined ? null : value);
        }
      });
      await this.db.query(
        `INSERT INTO ${target} (${allColumns.join(',')}) VALUES ${values.join(',')}
         ON CONFLICT (day, request_id) DO NOTHING`,
        params,
      );
      rows += mapped.length;

      const detailRows = mapped.filter((item) => item.detailRow);
      for (let start = 0; start < detailRows.length; start += this.batchSize) {
        const chunk = detailRows.slice(start, start + this.batchSize).map((item) => item.detailRow);
        if (!chunk.length) break;
        const dValues = [];
        const dParams = [];
        chunk.forEach((detail, index) => {
          const offset = index * DETAIL_COLUMNS.length;
          dValues.push(`(${DETAIL_COLUMNS.map((_, c) => `$${offset + c + 1}`).join(',')})`);
          for (const column of DETAIL_COLUMNS) {
            const value = detail[column];
            dParams.push(value === undefined ? null : value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
          }
        });
        await this.db.query(
          `INSERT INTO sample_detail (${DETAIL_COLUMNS.join(',')}) VALUES ${dValues.join(',')}
           ON CONFLICT (bank, day, request_id) DO NOTHING`,
          dParams,
        );
        details += chunk.length;
      }

      // نگاشت شناسهٔ بیرونی
      const externalPairs = mapped.filter((item) => item.externalId).map((item) => [item.externalId, item.sampleRow.request_id]);
      for (let start = 0; start < externalPairs.length; start += this.batchSize) {
        const chunk = externalPairs.slice(start, start + this.batchSize);
        if (!chunk.length) break;
        await this.db.query(
          `INSERT INTO external_id_map(external_id, request_id)
           VALUES ${chunk.map((_, k) => `($${k * 2 + 1},$${k * 2 + 2})`).join(',')}
           ON CONFLICT (external_id) DO NOTHING`,
          chunk.flat(),
        );
      }

      await this.valueDict.flush(bankKey);
      await this._catDict.flush(bankKey);
      cursor = String(batch.rows[batch.rows.length - 1].request_id);
      if (batch.rows.length < this.batchSize) break;
    }
    return { rows, details };
  }

  /**
   * `day_runs` در v1 ستون `day` از نوع text (شمسی) دارد؛ در v2 نوع date است.
   * اگر شکل v1 باشد، ابتدا پشتیبان گرفته و سپس ردیف‌ها با تبدیل تاریخ منتقل می‌شوند.
   */
  async prepareDayRuns() {
    const has = await this.tableExists('day_runs');
    if (!has) return { moved: false };
    const type = await this.db.query(
      "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='day_runs' AND column_name='day'",
    );
    const dataType = String(type.rows[0]?.data_type ?? '');
    if (dataType === 'date') return { moved: false, already: true };
    const backup = `day_runs${BACKUP_SUFFIX}`;
    if (!(await this.tableExists(backup))) {
      await this.db.query(`ALTER TABLE day_runs RENAME TO ${backup}`);
    } else {
      await this.db.query('DROP TABLE IF EXISTS day_runs');
    }
    return { moved: true, backup };
  }

  /** انتقال ردیف‌های `day_runs` از پشتیبان (اگر وجود دارد) */
  async migrateDayRuns() {
    const { toDateIso } = require('./row-mapper-v2');
    const backup = `day_runs${BACKUP_SUFFIX}`;
    if (!(await this.tableExists(backup))) return 0;
    const rows = await this.db.query(`SELECT * FROM ${backup}`);
    let moved = 0;
    for (const row of rows.rows) {
      const iso = toDateIso(String(row.day));
      if (!iso) continue;
      await this.db.query(
        `INSERT INTO day_runs(bank, day, mode, status, source_total, ingested_count, success_count,
           fail_count, skipped_other_method, checkpoint, analysis_version, started_at, finished_at,
           error, updated_at)
         VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (bank, day) DO NOTHING`,
        [
          row.bank, iso, row.mode ?? 'nightly', row.status ?? 'complete', row.source_total ?? null,
          row.ingested_count ?? 0, row.success_count ?? 0, row.fail_count ?? 0,
          row.skipped_count ?? 0, row.checkpoint ?? 0, row.analysis_version ?? null,
          row.started_at ?? null, row.finished_at ?? null, row.error ?? null, row.updated_at ?? new Date(),
        ],
      );
      moved += 1;
    }
    return moved;
  }

  /**
   * انتقال کامل با ساخت دیکشنری‌ها. نقطهٔ ورود توصیه‌شده.
   */
  async execute() {
    const { createCatDict } = require('./schema-v2-builder');
    // جدول‌های ثابت (دیکشنری‌ها) بدون دست‌زدن به جداول بانک‌ها
    await applySchemaV2(this.db, { registry: this.registry, banks: [] });
    this._catDict = createCatDict(this.db);
    await this._catDict.load();
    await this.valueDict.load();
    return this.run();
  }

  /**
   * بازگشت به v1: جدول‌های v2 حذف و پشتیبان‌ها با نام اصلی برمی‌گردند.
   */
  async rollback() {
    const bankKeys = Object.keys(SAMPLE_COLUMNS_PREFIX);
    const done = [];
    for (const bankKey of bankKeys) {
      const table = tableNameOf(bankKey);
      const backup = `${table}${BACKUP_SUFFIX}`;
      if (!(await this.tableExists(backup))) continue;
      await this.db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      await this.db.query(`ALTER TABLE ${backup} RENAME TO ${table}`);
      done.push(bankKey);
    }
    const dayRunsBackup = `day_runs${BACKUP_SUFFIX}`;
    if (await this.tableExists(dayRunsBackup)) {
      await this.db.query('DROP TABLE IF EXISTS day_runs CASCADE');
      await this.db.query(`ALTER TABLE ${dayRunsBackup} RENAME TO day_runs`);
      done.push('day_runs');
    }
    await this.db.query(
      "DELETE FROM schema_migrations WHERE version IN ('v2','v2-data','002a-v2-schema-builder','002b-v2-data')",
    ).catch(() => {});
    return { restored: done };
  }
}

module.exports = { V1ToV2Migration, BACKUP_SUFFIX, rowToV1, SAMPLE_COLUMNS, DETAIL_COLUMNS };
