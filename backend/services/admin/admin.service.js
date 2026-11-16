'use strict';
const { randomUUID } = require('node:crypto');
const { BANKS } = require('../config');
const { hasNarrowingFilters } = require('../ingestion/ingestion.service');
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
  constructor(db, ingestion) {
    this.db = db;
    this.ingestion = ingestion;
    this.jobs = new Map();
    this.cronTableReady = false;
  }

  async onModuleInit() {
    try {
      await this.ensureCronTable();
    } catch (err) {
      console.warn(
        '[admin] دیتابیس هنگام بالا آمدن سرور در دسترس نبود؛ جدول cron_configs در اولین اتصال ساخته خواهد شد:',
        err?.code || err?.message || err,
      );
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
    for (const bankKey of banks) {
      const bank = BANKS[bankKey];
      const countsRes = await this.db.query(
        `SELECT day,
                COUNT(*)::int AS row_count,
                COUNT(*) FILTER (WHERE is_success)::int AS success_count,
                COUNT(*) FILTER (WHERE NOT is_success)::int AS fail_count,
                MAX(updated_at) AS last_updated_at
         FROM ${bank.table}
         WHERE day = ANY($1::text[])
         GROUP BY day`,
        [days],
      );
      const countsByDay = new Map(countsRes.rows.map((r) => [r.day, r]));

      const runsRes = await this.db.query(
        `SELECT day, mode, status, source_total, checkpoint, ingested_count,
                success_count, fail_count, skipped_count, started_at, finished_at, updated_at, error
         FROM day_runs
         WHERE bank = $1 AND day = ANY($2::text[])`,
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

  trimJobHistory() {
    if (this.jobs.size <= 35) return;
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size > 30 && finished.length) {
      const oldest = finished.shift();
      this.jobs.delete(oldest.id);
    }
  }

  async startManualRun(payload = {}) {
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
      dateScope,
      mode,
      conflictStrategy,
      banks,
      days,
      filters,
    });
  }

  enqueueJob(params) {
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
    this.trimJobHistory();

    const runtimeFilters = { ...params.filters };
    void this.executeJob(job, runtimeFilters, params.onFinish);

    return job;
  }

  async executeJob(job, runtimeFilters, onFinish) {
    try {
      for (const step of job.steps) {
        step.status = 'running';
        step.startedAt = new Date().toISOString();
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
        } catch (err) {
          step.error = String(err?.data?.message?.fa ?? err?.message ?? err).slice(0, 1000);
          step.status = 'failed';
          step.finishedAt = new Date().toISOString();
          job.failedSteps++;
        }
      }
    } finally {
      delete runtimeFilters.nationalCode;
      job.finishedAt = new Date().toISOString();
      if (job.failedSteps === 0) job.status = 'completed';
      else if (job.completedSteps > 0) job.status = 'partial_error';
      else job.status = 'failed';

      if (onFinish) {
        try {
          await onFinish(job);
        } catch (e) {
          console.error('[admin] خطا در onFinish جاب:', e);
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
      const r = await this.db.query(
        `SELECT checkpoint, source_total, ingested_count, success_count, fail_count, skipped_count
         FROM day_runs WHERE bank = $1 AND day = $2`,
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
    const job = this.jobs.get(jobId);
    if (!job) throw adminError.jobNotFound(jobId);
    return this.enrichJobWithLiveProgress(job);
  }

  async listJobs(limit = 15) {
    const sorted = [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return Promise.all(sorted.map((j) => this.enrichJobWithLiveProgress(j)));
  }

  async triggerCronExecution(triggerSource, slotKey) {
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
    for (const key of ALL_BANKS) {
      const bank = BANKS[key];
      const statsRes = await this.db.query(
        `SELECT COUNT(*)::int AS total_rows,
                COUNT(DISTINCT day)::int AS days_count,
                MIN(day) AS min_day,
                MAX(day) AS max_day,
                COUNT(*) FILTER (WHERE is_success)::int AS success_rows,
                COUNT(*) FILTER (WHERE NOT is_success)::int AS fail_rows,
                MAX(updated_at) AS last_updated_at
         FROM ${bank.table}`,
      );
      const latestRunRes = await this.db.query(
        `SELECT day, mode, status, source_total, checkpoint, ingested_count,
                success_count, fail_count, skipped_count, started_at, finished_at, updated_at, error
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
        minDay: s.min_day ?? null,
        maxDay: s.max_day ?? null,
        successRows: Number(s.success_rows ?? 0),
        failRows: Number(s.fail_rows ?? 0),
        lastUpdatedAt: s.last_updated_at ?? null,
        latestRun: latestRunRes.rows[0] ?? null,
      });
    }

    const recentRunsRes = await this.db.query(
      `SELECT bank, day, mode, status, source_total, checkpoint, ingested_count,
              success_count, fail_count, skipped_count, started_at, finished_at, updated_at, error
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
        ...r,
        bankLabel: BANKS[r.bank] ? bankDisplayName(r.bank) : r.bank,
      })),
    };
  }
}

module.exports = { AdminService };
