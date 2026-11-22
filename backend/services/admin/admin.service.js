'use strict';
const { randomUUID } = require('node:crypto');
const { BANKS } = require('../config');
const { resolveDayRunsSkippedColumn, resolveSamplesUpdatedColumn } = require('../db/schema-columns');
const { hasNarrowingFilters } = require('../ingestion/ingestion.service');
const { getActionLogger } = require('../logger/action-logger.service');
const { error: adminError } = require('../../controllers/adminController/config');
const {
  enumerateJalaliDays,
  matchesCronExpr,
  nextCronRun,
  normalizeDay,
  tehranClockParts,
  tehranDaysAgo,
  tehranToday,
  tehranYesterday,
  validateCronExpr,
} = require('../utils/date');

const CRON_ID = 'nightly_default';
const ALL_BANKS = Object.keys(BANKS);

/**
 * روزِ خوانده‌شده از دیتابیس را به شکل **شمسی YYYY-MM-DD** برمی‌گرداند.
 * در v1 مقدار از قبل متنِ شمسی است؛ در v2 ستون `date` میلادی است و باید تبدیل شود.
 * بدون این، پنل ادمین «2026-10-23T00:00:00.000Z» نشان می‌داد (اصلاح ۵۰۰/نمایش پنل).
 */
function toJalaliDayValue(value, dbSchema) {
  if (value === null || value === undefined) return value;
  if (String(dbSchema).toLowerCase() !== 'v2') return value;
  try {
    const { toJalaliDay } = require('../db/row-mapper-v2');
    return toJalaliDay(value);
  } catch {
    return value;
  }
}

/** همان تبدیل، روی فیلدهای `day`/`minDay`/`maxDay` یک شیء */
function mapDayFields(row, dbSchema) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of ['day', 'minDay', 'maxDay', 'min_day', 'max_day']) {
    if (key in out && (typeof out[key] === 'string' || out[key] instanceof Date)) {
      out[key] = toJalaliDayValue(out[key], dbSchema);
    }
  }
  return out;
}

const BANK_ALIAS_MAP = {
  tavan_mellat: 'tavan_mellat',
  mellat: 'tavan_mellat',
  tavan_resalat: 'tavan_resalat',
  resalat: 'tavan_resalat',
  tavan_postbank: 'tavan_postbank',
  postbank: 'tavan_postbank',
  post_bank: 'tavan_postbank',
};

function bankDisplayName(key) {
  const lbl = BANKS[key]?.label ?? key;
  return lbl.includes('بانک') ? lbl : `بانک ${lbl}`;
}

function normalizeDigitsOnly(s) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .trim();
}

class AdminService {
  constructor(db, ingestion, options = {}) {
    this.db = db;
    this.ingestion = ingestion;
    // اسکیمای فعال برای انتخاب نام ستون‌ها (v1: updated_at/skipped_count، v2: created_at/skipped_other_method)
    this.dbSchema = options.dbSchema || process.env.CE_DB_SCHEMA || 'v1';
    this.jobs = new Map();
    this.cronTableReady = false;
    this.jobsTableReady = false;
  }

  async onModuleInit() {
    try {
      await this.ensureCronTable();
    } catch (err) {
      getActionLogger().warn({
        category: 'admin',
        action: 'admin.cron_table_deferred',
        errorCode: err?.code || 'DB_INIT_DEFERRED',
        message: 'DB unavailable on startup; cron_configs will be ensured on first use',
        meta: { cause: err?.code || err?.message || String(err) },
      });
    }
    try {
      await this.ensureJobsTable();
      await this.recoverInterruptedJobs();
    } catch (err) {
      getActionLogger().warn({
        category: 'admin',
        action: 'admin.jobs_table_deferred',
        errorCode: err?.code || 'DB_INIT_DEFERRED',
        message: 'DB unavailable on startup; admin_jobs will be ensured on first use',
        meta: { cause: err?.code || err?.message || String(err) },
      });
    }
  }

  async ensureCronTable() {
    if (this.cronTableReady) return;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS cron_configs (
        id                  TEXT PRIMARY KEY DEFAULT 'nightly_default',
        enabled             BOOLEAN NOT NULL DEFAULT FALSE,
        schedule_mode       TEXT NOT NULL DEFAULT 'daily',
        hour                INTEGER NOT NULL DEFAULT 2,
        minute              INTEGER NOT NULL DEFAULT 0,
        cron_expr           TEXT NOT NULL DEFAULT '0 2 * * *',
        timezone            TEXT NOT NULL DEFAULT 'Asia/Tehran',
        banks               TEXT[] NOT NULL DEFAULT ARRAY['tavan_mellat','tavan_resalat','tavan_postbank']::TEXT[],
        target_offset_days  INTEGER NOT NULL DEFAULT 1,
        rebuild             BOOLEAN NOT NULL DEFAULT FALSE,
        last_slot           TEXT,
        last_run_at         TIMESTAMPTZ,
        last_status         TEXT,
        last_error          TEXT,
        last_summary        JSONB,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `INSERT INTO cron_configs (id, enabled, schedule_mode, hour, minute, cron_expr, timezone, banks, target_offset_days, rebuild)
       VALUES ($1, FALSE, 'daily', 2, 0, '0 2 * * *', 'Asia/Tehran', ARRAY['tavan_mellat','tavan_resalat','tavan_postbank']::TEXT[], 1, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [CRON_ID],
    );
    this.cronTableReady = true;
  }

  async ensureJobsTable() {
    if (this.jobsTableReady) return;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS admin_jobs (
        id           TEXT PRIMARY KEY,
        source       TEXT NOT NULL,
        status       TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL,
        finished_at  TIMESTAMPTZ,
        payload      JSONB NOT NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query('CREATE INDEX IF NOT EXISTS idx_admin_jobs_created_at ON admin_jobs(created_at DESC)');
    this.jobsTableReady = true;
  }

  /** فقط فیلدهای ایمن و نمایشی job ذخیره میشوند؛ کدملی/داده خام هرگز وارد JSONB نمیشود. */
  sanitizeJobForStorage(job) {
    return {
      ...job,
      filters: this.sanitizeFilters(job.filters || {}),
      steps: (job.steps || []).map((step) => ({
        bank: step.bank,
        bankLabel: step.bankLabel,
        day: step.day,
        status: step.status,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        error: step.error ? String(step.error).slice(0, 1000) : undefined,
        result: step.result
          ? {
              source_total: step.result.source_total,
              processed: step.result.processed,
              success: step.result.success,
              fail: step.result.fail,
              skipped: step.result.skipped,
              deleted: step.result.deleted,
              rebuild: step.result.rebuild,
            }
          : undefined,
      })),
    };
  }

  hydrateStoredJob(row) {
    if (!row) return null;
    let job = row.payload;
    if (typeof job === 'string') {
      try { job = JSON.parse(job); } catch { return null; }
    }
    if (!job || typeof job !== 'object') return null;
    const hydrated = { ...job, id: row.id || job.id, status: row.status || job.status };
    if (hydrated.status === 'running' && !this.jobs.has(hydrated.id)) {
      hydrated.status = 'interrupted';
      hydrated.finishedAt = row.updated_at || new Date().toISOString();
      for (const step of hydrated.steps || []) {
        if (step.status === 'running') step.status = 'interrupted';
      }
    }
    return hydrated;
  }

  async persistJob(job) {
    try {
      await this.ensureJobsTable();
      await this.db.query(
        `INSERT INTO admin_jobs (id, source, status, created_at, finished_at, payload, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           source = EXCLUDED.source,
           status = EXCLUDED.status,
           finished_at = EXCLUDED.finished_at,
           payload = EXCLUDED.payload,
           updated_at = now()`,
        [
          job.id,
          job.source || 'manual',
          job.status,
          job.createdAt,
          job.finishedAt || null,
          JSON.stringify(this.sanitizeJobForStorage(job)),
        ],
      );
    } catch (err) {
      this.jobsTableReady = false;
      getActionLogger().warn({
        category: 'admin',
        action: 'admin.job.persist_deferred',
        errorCode: err?.code || 'JOB_PERSIST_FAILED',
        message: 'Could not persist admin job history; in-memory state is still available',
        meta: { jobId: job.id, cause: err?.code || err?.message || String(err) },
      });
    }
  }

  async recoverInterruptedJobs() {
    await this.ensureJobsTable();
    const res = await this.db.query("SELECT id, payload, updated_at FROM admin_jobs WHERE status = 'running'");
    for (const row of res.rows || []) {
      const job = this.hydrateStoredJob(row);
      if (!job || job.status !== 'interrupted') continue;
      await this.persistJob(job);
    }
  }

  resolveBanks(banksInput, singleBank) {
    if (banksInput === 'all' || singleBank === 'all') return [...ALL_BANKS];
    const rawList =
      Array.isArray(banksInput) && banksInput.length
        ? banksInput
        : singleBank
          ? [singleBank]
          : [];
    if (!rawList.length) {
      throw adminError.bankSelectionRequired;
    }
    if (rawList.includes('all')) return [...ALL_BANKS];
    const resolved = [];
    for (const item of rawList) {
      const normalized = String(item ?? '').trim().toLowerCase();
      const key = BANK_ALIAS_MAP[normalized];
      if (!key || !BANKS[key]) {
        throw adminError.invalidBank(item);
      }
      if (!resolved.includes(key)) resolved.push(key);
    }
    return resolved;
  }

  normalizeFilters(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    if (typeof raw.status === 'string' && raw.status.trim()) out.status = raw.status.trim();
    if (typeof raw.requestId === 'string' && raw.requestId.trim()) out.requestId = raw.requestId.trim();
    if (typeof raw.uniqueKey === 'string' && raw.uniqueKey.trim()) out.uniqueKey = raw.uniqueKey.trim();
    if (typeof raw.nationalCode === 'string' && raw.nationalCode.trim()) {
      const digits = normalizeDigitsOnly(raw.nationalCode);
      if (!/^\d{8,12}$/.test(digits)) {
        throw adminError.invalidNationalCode;
      }
      out.nationalCode = digits;
    }
    if (raw.maxCount !== undefined && raw.maxCount !== null && String(raw.maxCount).trim() !== '') {
      const mc = Number(normalizeDigitsOnly(String(raw.maxCount)));
      if (!Number.isInteger(mc) || mc < 1 || mc > 500000) {
        throw adminError.invalidMaxCount;
      }
      out.maxCount = mc;
    }
    if (raw.pageSize !== undefined && raw.pageSize !== null && String(raw.pageSize).trim() !== '') {
      const ps = Number(normalizeDigitsOnly(String(raw.pageSize)));
      if (!Number.isInteger(ps) || ps < 1 || ps > 200) {
        throw adminError.invalidPageSize;
      }
      out.pageSize = ps;
    }
    return out;
  }

  sanitizeFilters(filters) {
    return {
      status: filters?.status || undefined,
      requestId: filters?.requestId || undefined,
      uniqueKey: filters?.uniqueKey || undefined,
      hasNationalCode: Boolean(filters?.nationalCode),
      maxCount: filters?.maxCount,
      pageSize: filters?.pageSize,
    };
  }

  resolveDays(payload, filters) {
    const scope = payload.dateScope ?? (payload.fromDay || payload.toDay ? 'range' : 'single');
    try {
      if (scope === 'filter_only') {
        if (!filters.requestId && !filters.uniqueKey && !filters.nationalCode) {
          throw adminError.filterRequiredWithoutDate;
        }
        return { dateScope: 'filter_only', days: [] };
      }
      if (scope === 'range') {
        if (!payload.fromDay || !payload.toDay) {
          throw adminError.incompleteDateRange;
        }
        const days = enumerateJalaliDays(payload.fromDay, payload.toDay, 62);
        return { dateScope: 'range', days };
      }
      const mode = payload.mode === 'intraday' ? 'intraday' : 'nightly';
      const fallbackDay = mode === 'nightly' ? tehranYesterday() : tehranToday();
      const day = normalizeDay(payload.day?.trim() ? payload.day : fallbackDay);
      enumerateJalaliDays(day, day, 1);
      return { dateScope: 'single', days: [day] };
    } catch (err) {
      if (err && typeof err === 'object' && err.statusCode && err.meta) throw err;
      throw adminError.invalidDateInput(err?.message ?? String(err));
    }
  }

  effectiveCronExpr(row) {
    if (row.schedule_mode === 'cron') return String(row.cron_expr || '0 2 * * *').trim();
    const hour = Number(row.hour ?? 2);
    const minute = Number(row.minute ?? 0);
    return `${minute} ${hour} * * *`;
  }

  formatCronRow(row, now = new Date()) {
    const expr = this.effectiveCronExpr(row);
    const nextRun = nextCronRun(expr, now);
    const offsetDays = Number(row.target_offset_days ?? 1);
    return {
      id: row.id,
      enabled: Boolean(row.enabled),
      schedule_mode: row.schedule_mode === 'cron' ? 'cron' : 'daily',
      hour: Number(row.hour ?? 2),
      minute: Number(row.minute ?? 0),
      cron_expr: String(row.cron_expr ?? '0 2 * * *'),
      effective_cron_expr: expr,
      timezone: String(row.timezone ?? 'Asia/Tehran'),
      banks: Array.isArray(row.banks) && row.banks.length ? this.resolveBanks(row.banks) : ALL_BANKS,
      target_offset_days: offsetDays,
      target_day_preview: tehranDaysAgo(offsetDays, now),
      rebuild: Boolean(row.rebuild),
      last_slot: row.last_slot ?? null,
      last_run_at: row.last_run_at ?? null,
      last_status: row.last_status ?? null,
      last_error: row.last_error ?? null,
      last_summary: row.last_summary ?? null,
      updated_at: row.updated_at ?? null,
      next_run: nextRun,
    };
  }

  async getCronConfig() {
    await this.ensureCronTable();
    const res = await this.db.query('SELECT * FROM cron_configs WHERE id = $1', [CRON_ID]);
    return this.formatCronRow(res.rows[0]);
  }

  async updateCronConfig(input = {}) {
    await this.ensureCronTable();
    const currentRes = await this.db.query('SELECT * FROM cron_configs WHERE id = $1', [CRON_ID]);
    const current = currentRes.rows[0];

    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : Boolean(current.enabled);
    const scheduleMode =
      input.schedule_mode === 'cron'
        ? 'cron'
        : input.schedule_mode === 'daily'
          ? 'daily'
          : current.schedule_mode === 'cron'
            ? 'cron'
            : 'daily';

    const hour = input.hour !== undefined ? Number(input.hour) : Number(current.hour ?? 2);
    const minute = input.minute !== undefined ? Number(input.minute) : Number(current.minute ?? 0);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw adminError.invalidCronHour;
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw adminError.invalidCronMinute;
    }

    let cronExpr = input.cron_expr !== undefined ? String(input.cron_expr).trim() : String(current.cron_expr ?? '0 2 * * *');
    if (scheduleMode === 'daily') {
      cronExpr = `${minute} ${hour} * * *`;
    } else {
      const validation = validateCronExpr(cronExpr);
      if (!validation.valid) throw adminError.invalidCronExpression(validation.error);
    }

    const banks =
      input.banks !== undefined
        ? this.resolveBanks(input.banks)
        : Array.isArray(current.banks) && current.banks.length
          ? current.banks
          : ALL_BANKS;

    const targetOffsetDays =
      input.target_offset_days !== undefined
        ? Number(input.target_offset_days)
        : Number(current.target_offset_days ?? 1);
    if (!Number.isInteger(targetOffsetDays) || targetOffsetDays < 0 || targetOffsetDays > 30) {
      throw adminError.invalidCronOffsetDays;
    }

    const rebuild = input.rebuild !== undefined ? Boolean(input.rebuild) : Boolean(current.rebuild);

    const updated = await this.db.query(
      `UPDATE cron_configs
       SET enabled = $2,
           schedule_mode = $3,
           hour = $4,
           minute = $5,
           cron_expr = $6,
           banks = $7::text[],
           target_offset_days = $8,
           rebuild = $9,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [CRON_ID, enabled, scheduleMode, hour, minute, cronExpr, banks, targetOffsetDays, rebuild],
    );
    return this.formatCronRow(updated.rows[0]);
  }

  async checkExistingData(payload = {}) {
    const banks = this.resolveBanks(payload.banks, payload.bank);
    const filters = this.normalizeFilters(payload.filters);
    const { dateScope, days } = this.resolveDays(payload, filters);
    const narrowing = hasNarrowingFilters(filters);

    if (dateScope === 'filter_only') {
      const items = [];
      for (const bankKey of banks) {
        const bank = BANKS[bankKey];
        let matchedRows = 0;
        const matchedDays = [];
        if (filters.requestId || filters.uniqueKey) {
          const conds = [];
          const params = [];
          if (filters.requestId) {
            params.push(filters.requestId);
            conds.push(`request_id = $${params.length}`);
          }
          if (filters.uniqueKey) {
            params.push(filters.uniqueKey);
            conds.push(`unique_key = $${params.length}`);
          }
          const q = await this.db.query(
            `SELECT COUNT(*)::int AS cnt, ARRAY_AGG(DISTINCT day) AS days
             FROM ${bank.table}
             WHERE ${conds.join(' AND ')}`,
            params,
          );
          matchedRows = Number(q.rows[0]?.cnt ?? 0);
          if (Array.isArray(q.rows[0]?.days)) {
            for (const d of q.rows[0].days) if (d) matchedDays.push(d);
          }
        }
        items.push({
          bank: bankKey,
          bankLabel: bankDisplayName(bankKey),
          day: matchedDays.length ? matchedDays.sort().join('، ') : 'بدون قید تاریخ',
          exists: matchedRows > 0,
          rowCount: matchedRows,
          successCount: null,
          failCount: null,
          dayRun: null,
        });
      }
      const existingCount = items.filter((i) => i.exists).length;
      return {
        dateScope,
        banks,
        days: [],
        narrowingFilters: narrowing,
        filters: this.sanitizeFilters(filters),
        totalTargets: items.length,
        existingCount,
        hasExistingData: existingCount > 0,
        canRebuild: false,
        items,
      };
    }

    const items = [];
    const skippedColumnCheck = await resolveDayRunsSkippedColumn(this.db, this.dbSchema);
    for (const bankKey of banks) {
      const bank = BANKS[bankKey];
      const updatedColumn = await resolveSamplesUpdatedColumn(this.db, bank.table);
      const countsRes = await this.db.query(
        `SELECT day,
                COUNT(*)::int AS row_count,
                COUNT(*) FILTER (WHERE is_success)::int AS success_count,
                COUNT(*) FILTER (WHERE NOT is_success)::int AS fail_count,
                ${updatedColumn ? `MAX(${updatedColumn})` : 'NULL::timestamptz'} AS last_updated_at
         FROM ${bank.table}
         WHERE day::text = ANY($1::text[])
         GROUP BY day`,
        [days],
      );
      const countsByDay = new Map(countsRes.rows.map((r) => [r.day, r]));

      const runsRes = await this.db.query(
        `SELECT day, mode, status, source_total, checkpoint, ingested_count,
                success_count, fail_count, ${skippedColumnCheck} AS skipped_count,
                started_at, finished_at, updated_at, error
         FROM day_runs
         WHERE bank = $1 AND day::text = ANY($2::text[])`,
        [bankKey, days],
      );
      const runsByDay = new Map(runsRes.rows.map((r) => [r.day, r]));

      for (const day of days) {
        const c = countsByDay.get(day);
        const r = runsByDay.get(day) ?? null;
        const rowCount = Number(c?.row_count ?? 0);
        const exists = rowCount > 0 || Boolean(r);
        items.push({
          bank: bankKey,
          bankLabel: bankDisplayName(bankKey),
          day,
          exists,
          rowCount,
          successCount: Number(c?.success_count ?? 0),
          failCount: Number(c?.fail_count ?? 0),
          lastUpdatedAt: c?.last_updated_at ?? r?.updated_at ?? null,
          dayRun: r,
        });
      }
    }

    const existingCount = items.filter((i) => i.exists).length;
    return {
      dateScope,
      banks,
      days,
      narrowingFilters: narrowing,
      filters: this.sanitizeFilters(filters),
      totalTargets: items.length,
      existingCount,
      hasExistingData: existingCount > 0,
      canRebuild: true,
      items,
    };
  }

  async trimJobHistory() {
    if (this.jobs.size <= 35) return;
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size > 30 && finished.length) {
      const oldest = finished.shift();
      this.jobs.delete(oldest.id);
    }
    try {
      await this.ensureJobsTable();
      await this.db.query(`
        DELETE FROM admin_jobs
        WHERE status <> 'running'
          AND id NOT IN (SELECT id FROM admin_jobs ORDER BY created_at DESC LIMIT 30)
      `);
    } catch {
      // پاکسازی تاریخچه بهترینتلاش است؛ اجرای جاری نباید متوقف شود.
    }
  }

  async startManualRun(payload = {}, meta = {}) {
    const banks = this.resolveBanks(payload.banks, payload.bank);
    const filters = this.normalizeFilters(payload.filters);
    const { dateScope, days } = this.resolveDays(payload, filters);
    const mode = payload.mode === 'intraday' ? 'intraday' : 'nightly';
    const conflictStrategy = payload.conflictStrategy === 'rebuild' ? 'rebuild' : 'upsert';

    if (conflictStrategy === 'rebuild' && dateScope === 'filter_only') {
      throw adminError.rebuildRequiresDate;
    }

    if (!payload.confirmedConflict) {
      const check = await this.checkExistingData(payload);
      if (check.hasExistingData) {
        throw adminError.existingDataConflict(check);
      }
    }

    return this.enqueueJob({
      source: 'manual',
      actor: meta?.actor || null,
      dateScope,
      mode,
      conflictStrategy,
      banks,
      days,
      filters,
    });
  }

  async enqueueJob(params) {
    const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const steps = [];
    if (params.dateScope === 'filter_only') {
      for (const bank of params.banks) {
        steps.push({
          bank,
          bankLabel: bankDisplayName(bank),
          day: 'بدون قید تاریخ',
          status: 'pending',
        });
      }
    } else {
      for (const day of params.days) {
        for (const bank of params.banks) {
          steps.push({
            bank,
            bankLabel: bankDisplayName(bank),
            day,
            status: 'pending',
          });
        }
      }
    }

    const job = {
      id,
      source: params.source,
      dateScope: params.dateScope,
      mode: params.mode,
      conflictStrategy: params.conflictStrategy,
      banks: params.banks,
      days: params.days,
      filters: this.sanitizeFilters(params.filters),
      status: 'running',
      createdAt: new Date().toISOString(),
      totalSteps: steps.length,
      completedSteps: 0,
      failedSteps: 0,
      steps,
    };

    this.jobs.set(id, job);
    await this.trimJobHistory();
    await this.persistJob(job);

    getActionLogger().info({
      category: 'admin',
      action: 'admin.job.started',
      actor: params.actor || (params.source === 'cron' ? 'cron' : null),
      meta: {
        jobId: id,
        source: params.source,
        dateScope: params.dateScope,
        mode: params.mode,
        conflictStrategy: params.conflictStrategy,
        banks: params.banks,
        days: params.days,
        totalSteps: steps.length,
      },
    });

    const runtimeFilters = { ...params.filters };
    void this.executeJob(job, runtimeFilters, params.onFinish);

    return job;
  }

  async executeJob(job, runtimeFilters, onFinish) {
    try {
      for (const step of job.steps) {
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        await this.persistJob(job);
        try {
          let result;
          if (job.dateScope === 'filter_only') {
            result = await this.ingestion.runFilteredLookup(step.bank, runtimeFilters);
            if (result?.day) step.day = result.day;
          } else {
            result = await this.ingestion.runDay(step.bank, step.day, job.mode, {
              rebuild: job.conflictStrategy === 'rebuild',
              filters: runtimeFilters,
            });
          }
          step.result = result;
          step.status = 'done';
          step.finishedAt = new Date().toISOString();
          job.completedSteps++;
          await this.persistJob(job);
          getActionLogger().info({
            category: 'admin',
            action: 'admin.job.step_done',
            meta: {
              jobId: job.id,
              bank: step.bank,
              day: step.day,
              processed: result?.processed ?? 0,
              success: result?.success ?? 0,
              fail: result?.fail ?? 0,
              skipped: result?.skipped ?? 0,
            },
          });
        } catch (err) {
          step.error = String(err?.data?.message?.fa ?? err?.message ?? err).slice(0, 1000);
          step.status = 'failed';
          step.finishedAt = new Date().toISOString();
          job.failedSteps++;
          await this.persistJob(job);
          getActionLogger().error({
            category: 'admin',
            action: 'admin.job.step_failed',
            errorCode: err?.meta?.code || err?.code || 'JOB_STEP_FAILED',
            message: step.error,
            meta: { jobId: job.id, bank: step.bank, day: step.day },
            stack: err?.stack,
          });
        }
      }
    } finally {
      delete runtimeFilters.nationalCode;
      job.finishedAt = new Date().toISOString();
      if (job.failedSteps === 0) job.status = 'completed';
      else if (job.completedSteps > 0) job.status = 'partial_error';
      else job.status = 'failed';
      await this.persistJob(job);

      getActionLogger().logEvent({
        level: job.failedSteps > 0 ? (job.completedSteps === 0 ? 'error' : 'warn') : 'info',
        category: 'admin',
        action: 'admin.job.completed',
        meta: {
          jobId: job.id,
          source: job.source,
          status: job.status,
          completedSteps: job.completedSteps,
          failedSteps: job.failedSteps,
          totalSteps: job.totalSteps,
        },
      });

      if (onFinish) {
        try {
          await onFinish(job);
        } catch (e) {
          getActionLogger().error({
            category: 'admin',
            action: 'admin.job.on_finish_error',
            errorCode: e?.code || 'JOB_ON_FINISH_ERROR',
            message: e?.message || String(e),
            meta: { jobId: job.id },
            stack: e?.stack,
          });
        }
      }
    }
  }

  async enrichJobWithLiveProgress(job) {
    if (job.status !== 'running' || job.dateScope === 'filter_only') return job;
    const runningSteps = job.steps.filter((s) => s.status === 'running');
    if (!runningSteps.length) return job;
    const cloned = {
      ...job,
      steps: job.steps.map((s) => ({ ...s })),
    };
    for (const step of cloned.steps) {
      if (step.status !== 'running') continue;
      // نام ستون «ردشده» در v1/v2 فرق دارد (skipped_count / skipped_other_method)
      // eslint-disable-next-line no-await-in-loop
      const skippedColumn = await resolveDayRunsSkippedColumn(this.db, this.dbSchema);
      // روز در v2 از نوع date است؛ پارامتر متنی به date کست می‌شود
      const r = await this.db.query(
        `SELECT checkpoint, source_total, ingested_count, success_count, fail_count,
                ${skippedColumn} AS skipped_count
         FROM day_runs WHERE bank = $1 AND day = $2::text::date`,
        [step.bank, step.day],
      );
      if (r.rows[0]) {
        step.liveProgress = {
          checkpoint: Number(r.rows[0].checkpoint ?? 0),
          source_total: r.rows[0].source_total !== null ? Number(r.rows[0].source_total) : null,
          ingested_count: Number(r.rows[0].ingested_count ?? 0),
          success_count: Number(r.rows[0].success_count ?? 0),
          fail_count: Number(r.rows[0].fail_count ?? 0),
          skipped_count: Number(r.rows[0].skipped_count ?? 0),
        };
      }
    }
    return cloned;
  }

  async getJob(jobId) {
    const liveJob = this.jobs.get(jobId);
    if (liveJob) return this.enrichJobWithLiveProgress(liveJob);
    try {
      await this.ensureJobsTable();
      const res = await this.db.query('SELECT * FROM admin_jobs WHERE id = $1', [jobId]);
      const stored = this.hydrateStoredJob(res.rows?.[0]);
      if (stored) {
        this.jobs.set(stored.id, stored);
        return this.enrichJobWithLiveProgress(stored);
      }
    } catch {
      // DB موقتاً در دسترس نیست؛ فقط jobNotFound گزارش میشود.
    }
    throw adminError.jobNotFound(jobId);
  }

  async listJobs(limit = 15) {
    const safeLimit = Math.min(Math.max(Number(limit) || 15, 1), 100);
    const merged = new Map(this.jobs);
    try {
      await this.ensureJobsTable();
      const res = await this.db.query(
        'SELECT * FROM admin_jobs ORDER BY created_at DESC LIMIT $1',
        [safeLimit],
      );
      for (const row of res.rows || []) {
        const stored = this.hydrateStoredJob(row);
        if (stored && !merged.has(stored.id)) merged.set(stored.id, stored);
      }
    } catch {
      // در صورت نبود DB، همان تاریخچهٔ در حال اجرا/همین پروسه برگردانده میشود.
    }
    const sorted = [...merged.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, safeLimit);
    return Promise.all(sorted.map((j) => this.enrichJobWithLiveProgress(j)));
  }

  async triggerCronExecution(triggerSource, slotKey, meta = {}) {
    await this.ensureCronTable();
    const cfgRes = await this.db.query('SELECT * FROM cron_configs WHERE id = $1', [CRON_ID]);
    const cfg = cfgRes.rows[0];
    const banks = this.resolveBanks(Array.isArray(cfg.banks) && cfg.banks.length ? cfg.banks : ALL_BANKS);
    const offsetDays = Number(cfg.target_offset_days ?? 1);
    const targetDay = tehranDaysAgo(offsetDays);
    const rebuild = Boolean(cfg.rebuild);

    await this.db.query(
      `UPDATE cron_configs
       SET last_run_at = now(),
           last_status = 'running',
           last_error = NULL,
           last_slot = COALESCE($2, last_slot),
           updated_at = now()
       WHERE id = $1`,
      [CRON_ID, slotKey ?? null],
    );

    return this.enqueueJob({
      source: triggerSource,
      actor: meta?.actor || 'cron',
      dateScope: 'single',
      mode: 'nightly',
      conflictStrategy: rebuild ? 'rebuild' : 'upsert',
      banks,
      days: [targetDay],
      filters: {},
      onFinish: async (finishedJob) => {
        const summary = {
          jobId: finishedJob.id,
          source: triggerSource,
          targetDay,
          banks: finishedJob.banks,
          status: finishedJob.status,
          completedSteps: finishedJob.completedSteps,
          failedSteps: finishedJob.failedSteps,
          steps: finishedJob.steps.map((s) => ({
            bank: s.bank,
            day: s.day,
            status: s.status,
            processed: s.result?.processed ?? 0,
            success: s.result?.success ?? 0,
            fail: s.result?.fail ?? 0,
            error: s.error ?? null,
          })),
        };
        const firstError = finishedJob.steps.find((s) => s.error)?.error ?? null;
        await this.db.query(
          `UPDATE cron_configs
           SET last_status = $2,
               last_error = $3,
               last_summary = $4::jsonb,
               updated_at = now()
           WHERE id = $1`,
          [CRON_ID, finishedJob.status, firstError, JSON.stringify(summary)],
        );
      },
    });
  }

  async tickScheduledCron(now = new Date()) {
    await this.ensureCronTable();
    const res = await this.db.query('SELECT * FROM cron_configs WHERE id = $1', [CRON_ID]);
    const cfg = res.rows[0];
    if (!cfg || !cfg.enabled) return null;

    const expr = this.effectiveCronExpr(cfg);
    if (!matchesCronExpr(expr, now)) return null;

    const clock = tehranClockParts(now);
    const slotKey = clock.slotKey;
    if (cfg.last_slot === slotKey) return null;

    const runningCron = [...this.jobs.values()].find(
      (j) => (j.source === 'cron' || j.source === 'cron_manual') && j.status === 'running',
    );
    if (runningCron) return null;
    try {
      await this.ensureJobsTable();
      const persistedRunning = await this.db.query(
        "SELECT 1 FROM admin_jobs WHERE status = 'running' AND source IN ('cron','cron_manual') LIMIT 1",
      );
      if (persistedRunning.rows?.length) return null;
    } catch {
      // اگر جدول jobs آماده نبود، claim کردن cron_configs همچنان از اجرای همزمان جلوگیری میکند.
    }

    const claim = await this.db.query(
      `UPDATE cron_configs
       SET last_slot = $2,
           last_run_at = now(),
           last_status = 'running',
           last_error = NULL,
           updated_at = now()
       WHERE id = $1 AND enabled = TRUE AND (last_slot IS NULL OR last_slot <> $2)
       RETURNING *`,
      [CRON_ID, slotKey],
    );
    if (!claim.rows.length) return null;

    return this.triggerCronExecution('cron', slotKey);
  }

  async getOverview() {
    await this.ensureCronTable();
    const now = new Date();
    const clock = tehranClockParts(now);
    const today = tehranToday(now);
    const yesterday = tehranYesterday(now);

    const bankStats = [];
    /**
     * نام ستون‌های وابسته به اسکیما (اصلاح ۵۰۰ پنل ادمین).
     * در v2: نمونه‌ها `created_at` دارند (نه updated_at) و day_runs ستون
     * `skipped_other_method` (نه skipped_count). این‌ها از دیتابیس خوانده می‌شوند تا
     * همان کوئری روی هر دو اسکیما کار کند.
     */
    const skippedColumn = await resolveDayRunsSkippedColumn(this.db, this.dbSchema);
    for (const key of ALL_BANKS) {
      const bank = BANKS[key];
      const updatedColumn = await resolveSamplesUpdatedColumn(this.db, bank.table);
      const statsRes = await this.db.query(
        `SELECT COUNT(*)::int AS total_rows,
                COUNT(DISTINCT day)::int AS days_count,
                MIN(day) AS min_day,
                MAX(day) AS max_day,
                COUNT(*) FILTER (WHERE is_success)::int AS success_rows,
                COUNT(*) FILTER (WHERE NOT is_success)::int AS fail_rows,
                ${updatedColumn ? `MAX(${updatedColumn})` : 'NULL::timestamptz'} AS last_updated_at
         FROM ${bank.table}`,
      );
      const latestRunRes = await this.db.query(
        `SELECT day, mode, status, source_total, checkpoint, ingested_count,
                success_count, fail_count, ${skippedColumn} AS skipped_count,
                started_at, finished_at, updated_at, error
         FROM day_runs
         WHERE bank = $1
         ORDER BY updated_at DESC NULLS LAST, day DESC
         LIMIT 1`,
        [key],
      );
      const s = statsRes.rows[0] ?? {};
      bankStats.push({
        bank: key,
        faName: bankDisplayName(key),
        enName: bank.method,
        totalRows: Number(s.total_rows ?? 0),
        daysCount: Number(s.days_count ?? 0),
        minDay: toJalaliDayValue(s.min_day ?? null, this.dbSchema),
        maxDay: toJalaliDayValue(s.max_day ?? null, this.dbSchema),
        successRows: Number(s.success_rows ?? 0),
        failRows: Number(s.fail_rows ?? 0),
        lastUpdatedAt: s.last_updated_at ?? null,
        latestRun: latestRunRes.rows[0] ? mapDayFields(latestRunRes.rows[0], this.dbSchema) : null,
      });
    }

    const recentRunsRes = await this.db.query(
      `SELECT bank, day, mode, status, source_total, checkpoint, ingested_count,
              success_count, fail_count, ${skippedColumn} AS skipped_count,
              started_at, finished_at, updated_at, error
       FROM day_runs
       ORDER BY updated_at DESC NULLS LAST, day DESC
       LIMIT 30`,
    );

    const cron = await this.getCronConfig();
    const jobs = await this.listJobs(15);

    return {
      serverClock: {
        iso: now.toISOString(),
        timezone: 'Asia/Tehran',
        jalaliToday: today,
        jalaliYesterday: yesterday,
        tehranTime: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
      },
      banks: bankStats,
      cron,
      jobs,
      recentDayRuns: recentRunsRes.rows.map((r) => ({
        ...mapDayFields(r, this.dbSchema),
        bankLabel: BANKS[r.bank] ? bankDisplayName(r.bank) : r.bank,
      })),
    };
  }
}

module.exports = { AdminService };
