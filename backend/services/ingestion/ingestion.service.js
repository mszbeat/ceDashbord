'use strict';
const { BANKS, config, resolveBankApiUrl } = require('../config');
const { fetchBankJson } = require('../http/gateway-client');
const { getActionLogger } = require('../logger/action-logger.service');
const { error: adminError } = require('../../controllers/adminController/config');
const { RunStore } = require('../db/run-store');
const { toDateIso } = require('../db/row-mapper-v2');
const {
  jalaliStampDigitsOf,
  normalizeDay,
  tehranToday,
  tehranYesterday,
  toApiDate,
} = require('../utils/date');

const UPSERT_COLUMNS = [
  'request_id', 'day', 'inserted_at', 'stamp_key', 'unique_key', 'is_success', 'model_name', 'status_code', 'error_code', 'message_key',
  'total_time_s', 'pd', 'suggested_amount', 'amount_kind', 'score_req', 'credit_basket', 'avg36',
  'ln_avg_installments', 'rotbe', 'flags', 'cats', 'counters', 'metrics', 'paths', 'services',
  'credit_alerts', 'display_extras', 'analysis_version',
];

const JSON_COLUMNS = new Set([
  'flags', 'cats', 'counters', 'metrics', 'paths', 'services', 'credit_alerts', 'display_extras',
]);


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bankKeyOfTable(table) {
  const found = Object.entries(BANKS).find(([, bank]) => bank.table === table);
  if (!found) throw new Error(`جدول ناشناخته: ${table}`);
  return found[0];
}

function hasNarrowingFilters(filters) {
  if (!filters) return false;
  return Boolean(
    filters.status?.trim() ||
    filters.requestId?.trim() ||
    filters.uniqueKey?.trim() ||
    filters.nationalCode?.trim() ||
    (filters.maxCount !== undefined && filters.maxCount !== null && Number(filters.maxCount) > 0),
  );
}

function inferDayFromSample(sample) {
  const candidates = [
    sample?.insertDate_yearMonthDay,
    jalaliStampDigitsOf(sample?.insertDate_full)?.slice(0, 8),
    jalaliStampDigitsOf(sample?.insertDate)?.slice(0, 8),
  ];
  for (const raw of candidates) {
    const digits = String(raw ?? '').replace(/\D/g, '');
    if (/^1[34]\d{6}$/.test(digits)) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
  }
  return tehranToday();
}

class IngestionService {
  constructor(db, evaluator, options = {}) {
    this.db = db;
    this.evaluator = evaluator;
    /**
     * مسیر نوشتن جایگزین (اسکیمای v2). وقتی ست شود، `upsertBatch` ردیف‌ها را به‌جای
     * ستون jsonb در جدول typed/پارتیشن‌شده می‌ریزد؛ بقیهٔ منطق (checkpoint، day_runs،
     * پیام‌ها) بدون تغییر می‌ماند.
     */
    this.writer = options.writer || null;
    /**
     * لایهٔ دسترسی `day_runs` (نام ستون‌ها بین v1 و v2 فرق دارد).
     * `schema` از config یا گزینه می‌آید و `runStore` را می‌سازد.
     */
    // اگر writer (اسکیمای v2) تزریق شده باشد، `day_runs` هم باید v2 خوانده شود؛
    // در غیر این صورت ستون `day` درست نگاشت نمی‌شود و varchar/date قاطی می‌شود.
    this.schema = options.dbSchema
      || (this.writer && this.writer.constructor && this.writer.constructor.name === 'V2Writer' ? 'v2' : null)
      || config.dbSchema;
    this.runStore = options.runStore || new RunStore(db, { schema: this.schema });
  }

  /**
   * `day_runs.day` در v2 ستون `date` میلادی است و در v1 متن شمسی.
   * همهٔ کوئری‌های مربوط به نمونه هم از همین تابع عبور می‌کنند.
   */
  dayValue(day) {
    return this.runStore.dayValue(day);
  }

  /** جدول نمونهٔ فعال برای این اسکیما */
  samplesTable(bank) {
    return bank.table;
  }

  /**
   * B4 — `request_id` طبق تصمیم صاحب پروژه همیشه UUID است.
   * شناسهٔ غیر-UUID با پیام شفاف رد می‌شود (به‌جای ساختن UUID جعلی با UUIDv5).
   */
  requireValidRequestId(requestId) {
    const text = String(requestId ?? '').trim();
    if (!text) return { ok: false, reason: 'شناسهٔ درخواست خالی است' };
    if (!UUID_RE.test(text)) {
      return { ok: false, reason: `شناسهٔ درخواست UUID معتبر نیست: ${text.slice(0, 64)}` };
    }
    return { ok: true, value: text.toLowerCase() };
  }

  /**
   * ساخت `day_rollup` برای یک روز کامل (فاز ۳). اگر rollup از نسخهٔ تحلیل قدیمی باشد
   * بازسازی می‌شود؛ در غیر این صورت کاری نمی‌کند (idempotent).
   */
  async buildRollup(bankKey, day) {
    if (this.schema !== 'v2') return null;
    const { buildDayRollup } = require('../rollup/rollup.service');
    return buildDayRollup(this.db, {
      bankKey,
      day,
      evaluator: this.evaluator,
      registryBundle: require('../db/schema-registry').buildRuntimeRegistry(this.evaluator),
    });
  }

  async fetchPage(page, limit, day, filters, bankKey = 'tavan_mellat') {
    const baseUrl = resolveBankApiUrl(bankKey);
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    if (day) url.searchParams.set('date', toApiDate(day));
    if (filters?.status?.trim()) url.searchParams.set('status', filters.status.trim());
    if (filters?.requestId?.trim()) url.searchParams.set('requestId', filters.requestId.trim());
    if (filters?.uniqueKey?.trim()) url.searchParams.set('uniqueKey', filters.uniqueKey.trim());
    if (filters?.nationalCode?.trim()) url.searchParams.set('nationalCode', filters.nationalCode.trim());

    try {
      return await fetchBankJson(bankKey, url.toString(), {
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.retryCount,
      });
    } catch (lastError) {
      throw adminError.creditEvaluationBaseServiceError({
        bank: bankKey,
        page,
        day: day || null,
        cause: lastError?.message ?? String(lastError),
      });
    }
  }

  async sourceTotal(day, filters, bankKey = 'tavan_mellat') {
    const data = await this.fetchPage(1, 1, day, filters, bankKey);
    const raw = data?.count ?? data?.totalCount ?? data?.total ?? data?.reportResults?.length ?? 0;
    const total = Number(raw);
    return Number.isFinite(total) ? total : 0;
  }

  async upsertBatch(client, table, rows, bankKey) {
    if (!rows.length) return;
    if (this.writer) {
      // v2: نگاشت و درج با ستون‌های typed + sample_detail + دیکشنری‌ها
      await this.writer.upsertBatch(client, bankKey || bankKeyOfTable(table), rows);
      return;
    }
    const dedupedMap = new Map();
    for (const row of rows) {
      dedupedMap.set(`${row.day}\0${row.request_id}`, row);
    }
    const uniqueRows = [...dedupedMap.values()];
    if (this.schema === 'v2') {
      // v2: ستون `day` تاریخ میلادی است؛ نگاشت همین‌جا انجام می‌شود
      for (const row of uniqueRows) row.day = toDateIso(String(row.day));
    }

    const values = [];
    const params = [];
    uniqueRows.forEach((row, rIdx) => {
      const offset = rIdx * UPSERT_COLUMNS.length;
      values.push(`(${UPSERT_COLUMNS.map((_, cIdx) => `$${offset + cIdx + 1}`).join(',')})`);
      for (const col of UPSERT_COLUMNS) {
        const v = row[col];
        params.push(JSON_COLUMNS.has(col) && v !== null && v !== undefined ? JSON.stringify(v) : v);
      }
    });
    // B5: اگر مقدارها عوض نشده‌اند، هیچ نوشتنی انجام نشود (جلوگیری از bloat در rebuild)
    const changed = UPSERT_COLUMNS
      .filter((c) => c !== 'request_id' && c !== 'day')
      .map((c) => `(${table}.${c} IS DISTINCT FROM EXCLUDED.${c})`)
      .join(' OR ');
    const updates = UPSERT_COLUMNS
      .filter((c) => c !== 'request_id' && c !== 'day')
      .map((c) => `${c}=EXCLUDED.${c}`)
      .concat('updated_at=now()')
      .join(', ');
    await client.query(
      `INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (day, request_id) DO UPDATE SET ${updates} WHERE ${changed}`,
      params,
    );
  }

  async startRun(client, bankKey, day, mode) {
    const existing = await this.runStore.find(client, bankKey, day);
    const checkpoint = existing?.status === 'complete' ? 0 : Number(existing?.checkpoint ?? 0);
    await this.runStore.upsert(client, bankKey, day, {
      mode,
      status: 'running',
      checkpoint,
      analysis_version: this.evaluator.versionOf(bankKey),
      started_at: new Date(),
      finished_at: null,
      error: null,
    });
    return checkpoint;
  }

  /**
   * به‌روزرسانی وضعیت اجرا. کلیدهای ورودی «نام عمومی» هستند
   * (`skipped_count`/`ingested_count`/`error_count`/`distinct_stored`) و
   * `RunStore` آن‌ها را به ستون واقعی اسکیمای فعال نگاشت می‌کند.
   */
  async updateRun(client, bankKey, day, patch) {
    await this.runStore.update(client, bankKey, day, patch);
  }

  /** شمارش متمایز شناسه‌های ذخیره‌شدهٔ روز + به‌روزرسانی `distinct_stored` (C1) */
  async refreshDistinctStored(client, bankKey, day, table) {
    const distinct = await this.runStore.countDistinct(client, bankKey, day, table);
    await this.updateRun(client, bankKey, day, { distinct_stored: distinct });
    return distinct;
  }

  /**
   * آماده‌سازی ذخیره‌گاه روز **پیش از** تراکنش: پارتیشن ماهانه + میزبان rollup.
   * @param {string} day روز شمسی
   */
  async prepareDayStorage(day) {
    if (this.schema !== 'v2') return;
    const isoDay = toDateIso(String(day));
    if (!isoDay) throw new Error(`روز نامعتبر برای آماده‌سازی: ${day}`);
    const builder = require('../db/schema-v2-builder');
    for (const bankKey of Object.keys(BANKS)) {
      await builder.ensureMonthlyPartitions(this.db, bankKey, isoDay, isoDay);
    }
  }

  /**
   * حذف کامل دادهٔ یک روز (B2). در v2 `day` تاریخ میلادی است و `sample_detail` و
   * `day_rollup` هم در همان تراکنش پاک می‌شوند. پارتیشن ماهانه DROP نمی‌شود
   * (روزهای دیگر همان ماه باید دست‌نخورده بمانند).
   */
  async deleteDay(client, bank, dayValue) {
    const removed = { samples: 0, details: 0, rollups: 0 };
    const cast = this.schema === 'v2' ? '$1::date' : '$1::text';
    const samples = await client.query(
      `DELETE FROM ${this.samplesTable(bank)} WHERE day=${cast}`, [dayValue],
    );
    removed.samples = samples.rowCount ?? 0;
    if (this.schema === 'v2') {
      const details = await client.query('DELETE FROM sample_detail WHERE day=$1::date', [dayValue]);
      removed.details = details.rowCount ?? 0;
      const rollups = await client.query('DELETE FROM day_rollup WHERE day=$1::date', [dayValue]);
      removed.rollups = rollups.rowCount ?? 0;
    }
    return removed;
  }

  /**
   * ثبت وضعیت `interrupted` برای اجراهای نیمه‌کاره موقع خاموشی (فاز ۴).
   * SIGTERM در سطح پروسه ثبت می‌شود و این متد از آن مسیر صدا زده می‌شود.
   */
  async markInterrupted(reason = 'SIGTERM') {
    const stale = await this.runStore.db.query(
      `SELECT bank, day FROM day_runs WHERE status IN ('running','partial') AND updated_at > now() - interval '2 days'`,
    ).catch(() => ({ rows: [] }));
    let marked = 0;
    for (const row of stale.rows) {
      const day = this.schema === 'v2'
        ? require('../db/row-mapper-v2').toJalaliDay(row.day)
        : row.day;
      await this.updateRun(null, row.bank, day, {
        status: 'interrupted',
        error: `خاموشی سرور (${reason}) — اجرا نیمه‌کاره ماند`,
        finished_at: new Date(),
      }).then(() => { marked += 1; }).catch(() => undefined);
    }
    return { marked };
  }

  async runDay(bankInput, dayInput, mode = 'nightly', options = {}) {
    const bankKey = bankInput;
    const bank = BANKS[bankKey];
    if (!bank) throw adminError.invalidBank(bankInput);
    const rebuild = options.rebuild === true;
    const filters = options.filters;
    // سقف ۲۰۰ برای هر صفحه (هم از env و هم از پارامتر درخواست) — در `config.js` هم بسته شده
    const maxPageSize = Number(process.env.CE_API_PAGE_SIZE_MAX || 200);
    const pageSize =
      filters?.pageSize && Number(filters.pageSize) >= 1
        ? Math.min(Math.floor(Number(filters.pageSize)), maxPageSize)
        : Math.min(config.pageSize, maxPageSize);
    const maxCount =
      filters?.maxCount && Number(filters.maxCount) >= 1
        ? Math.floor(Number(filters.maxCount))
        : null;
    const filteredRun = hasNarrowingFilters(filters);
    if (rebuild && !dayInput) {
      throw adminError.rebuildRequiresExplicitDay;
    }
    const day = normalizeDay(dayInput ?? (mode === 'nightly' ? tehranYesterday() : tehranToday()));
    const dayValue = this.dayValue(day);
    const client = await this.db.getClient();
    const lockKey = `ce-ingest:${bankKey}:${day}`;
    let checkpoint = 0, sourceTotal = 0, success = 0, fail = 0, skipped = 0, processed = 0;
    let skippedOtherMethod = 0, errors = 0, invalidIds = 0;
    let inTransaction = false, deleted = 0;
    const messageTemplates = new Map();
    const writtenTemplates = new Set();

    try {
      // فاز ۴: قفل مشورتی per (bank, day) با مهلت محدود.
      //  * `pg_try_advisory_lock` اول تلاش می‌کند؛ اگر آزاد نبود تا `CE_INGEST_LOCK_WAIT_SECONDS`
      //    (پیش‌فرض ۵ ثانیه) منتظر می‌ماند.
      //  * بعد از مهلت، خطای 409 برمی‌گردانیم — نه اجرای موازی و نه انتظار بی‌نهایت.
      const lockWaitSeconds = Math.max(0, Number(process.env.CE_INGEST_LOCK_WAIT_SECONDS ?? 5));
      let lockHeld = Boolean((await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [lockKey],
      )).rows[0]?.locked);
      if (!lockHeld && lockWaitSeconds > 0) {
        // انتظار محدود: `pg_advisory_lock` روی همین اتصال، با `statement_timeout` موقت
        // `SET` (نه `SET LOCAL`) چون خارج از تراکنش هم باید اثر کند؛ بعد از انتظار برگردانده می‌شود
        const previous = (await client.query('SHOW statement_timeout')).rows[0]?.statement_timeout || '0';
        await client.query(`SET statement_timeout = ${Math.round(lockWaitSeconds * 1000)}`);
        try {
          await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
          lockHeld = true;
        } catch {
          lockHeld = false;
        } finally {
          await client.query(`SET statement_timeout = '${String(previous).replace(/'/g, '')}'`)
            .catch(() => undefined);
        }
      }
      if (!lockHeld) {
        const conflict = new Error(
          `اجرای دیگری برای ${bankKey}/${day} در جریان است؛ بعد از پایان آن دوباره تلاش کنید`,
        );
        conflict.statusCode = 409;
        conflict.code = 'ingestionLocked';
        conflict.data = {
          code: 'ingestionLocked',
          message: { fa: conflict.message, en: 'another ingestion run holds this (bank, day) lock' },
        };
        getActionLogger().warn({
          category: 'ingestion',
          action: 'ingestion.day.locked',
          statusCode: 409,
          errorCode: 'ingestionLocked',
          message: conflict.message,
          meta: { bank: bankKey, day, lockWaitSeconds },
        });
        throw conflict;
      }
      getActionLogger().info({
        category: 'ingestion',
        action: 'ingestion.day.started',
        meta: { bank: bankKey, day, mode, rebuild, filteredRun },
      });
      const preflight = await this.sourceTotal(day, filters, bankKey);
      if (rebuild && !preflight) {
        getActionLogger().warn({
          category: 'ingestion',
          action: 'ingestion.day.aborted_empty_rebuild',
          statusCode: 409,
          errorCode: 'emptyRebuildAborted',
          message: `Rebuild aborted for ${bankKey}/${day}: sourceTotal=0`,
          meta: { bank: bankKey, day },
        });
        throw adminError.emptyRebuildAborted(day);
      }
      if (rebuild) {
        // B3: پارتیشن‌ها بیرون از تراکنش ساخته می‌شوند. `CREATE TABLE ... PARTITION OF`
        // به قفل قوی جدول مادر نیاز دارد و اگر داخل همان تراکنش rebuild باشد، بن‌بست می‌شود.
        await this.prepareDayStorage(day);
        await client.query('BEGIN');
        inTransaction = true;
        const removed = await this.deleteDay(client, bank, dayValue);
        deleted = removed.samples;
        await this.runStore.remove(client, bankKey, day);
        getActionLogger().warn({
          category: 'ingestion',
          action: 'ingestion.day.rebuild_reset',
          message: `Deleted ${deleted} existing rows for ${bankKey}/${day} inside transaction`,
          meta: { bank: bankKey, day, deleted, ...removed },
        });
      }
      const effectiveInitial = maxCount !== null ? Math.min(preflight, maxCount) : preflight;
      const initialTotal = effectiveInitial;
      checkpoint = filteredRun ? 0 : await this.startRun(client, bankKey, day, mode);
      if (filteredRun) {
        await this.runStore.upsert(client, bankKey, day, {
          mode,
          status: 'running',
          checkpoint: 0,
          analysis_version: this.evaluator.versionOf(bankKey),
          started_at: new Date(),
          finished_at: null,
          error: null,
        });
      }
      sourceTotal = effectiveInitial;
      await this.updateRun(client, bankKey, day, { source_total: sourceTotal });

      const seenStatus = new Map();
      let reachedEndOfPages = sourceTotal === 0;

      const ingestSlice = async (slice, countProcessed = true) => {
        const rows = [];
        for (const raw of slice) {
          if (countProcessed) processed++;
          try {
            const sample = this.evaluator.normalizeSample(raw, { fromApi: true });
            const method = String(sample?.input?.method ?? '').trim().toLowerCase();
            if (method !== bank.method) {
              // «رد مجاز» — روش دیگر است، خطا نیست و مانع complete نمی‌شود
              if (countProcessed) { skipped++; skippedOtherMethod++; }
              continue;
            }
            const isSuccess = this.evaluator.isReportSuccess(sample);
            const template = this.evaluator.messageTemplateOf(sample, isSuccess);
            if (template) messageTemplates.set(template.key, template.text);
            const row = this.evaluator.evaluate(sample, isSuccess, day, bankKey);
            if (!row.request_id) {
              if (countProcessed) { skipped++; invalidIds++; }
              continue;
            }
            // B4: شناسه باید UUID معتبر باشد؛ در غیر این صورت ردیف با خطای شفاف رد می‌شود
            const idCheck = this.requireValidRequestId(row.request_id);
            if (!idCheck.ok) {
              if (countProcessed) { skipped++; invalidIds++; }
              getActionLogger().warn({
                category: 'ingestion',
                action: 'ingestion.sample.invalid_request_id',
                message: idCheck.reason,
                meta: { bank: bankKey, day, requestId: String(row.request_id).slice(0, 64) },
              });
              continue;
            }
            rows.push(row);
            const prev = seenStatus.get(row.request_id);
            if (prev === undefined) {
              seenStatus.set(row.request_id, isSuccess);
              if (isSuccess) success++; else fail++;
            } else if (prev !== isSuccess) {
              seenStatus.set(row.request_id, isSuccess);
              if (isSuccess) { success++; fail--; } else { fail++; success--; }
            }
          } catch (error) {
            // خطای واقعی در پردازش یک نمونه — مانع `complete` است
            if (countProcessed) { skipped++; errors++; }
            getActionLogger().warn({
              category: 'ingestion',
              action: 'ingestion.sample.skipped',
              message: error?.message ?? String(error),
              meta: { bank: bankKey, day },
            });
          }
        }
        await this.upsertBatch(client, bank.table, rows, bankKey);
        const pending = [...messageTemplates.entries()].filter(([key]) => !writtenTemplates.has(key));
        if (pending.length) {
          await client.query(
            `INSERT INTO message_dict(message_key, label, topic, message_text)
             SELECT k, k, 'other', t FROM unnest($1::text[], $2::text[]) AS x(k, t)
             ON CONFLICT (message_key) DO UPDATE SET message_text=EXCLUDED.message_text`,
            [pending.map(([key]) => key), pending.map(([, text]) => text)],
          );
          for (const [key] of pending) writtenTemplates.add(key);
        }
      };

      while (checkpoint < sourceTotal) {
        const page = Math.floor(checkpoint / pageSize) + 1;
        const skip = checkpoint % pageSize;
        const data = await this.fetchPage(page, pageSize, day, filters, bankKey);
        const liveRaw = data?.count ?? data?.totalCount ?? data?.total;
        const liveTotal = Number(liveRaw);
        if (Number.isFinite(liveTotal)) {
          const cappedLive = maxCount !== null ? Math.min(liveTotal, maxCount) : liveTotal;
          if (cappedLive > sourceTotal) sourceTotal = cappedLive;
        }
        const reports = Array.isArray(data?.reportResults)
          ? data.reportResults
          : Array.isArray(data?.reports)
            ? data.reports
            : Array.isArray(data)
              ? data
              : [];
        if (!reports.length) {
          reachedEndOfPages = true;
          break;
        }
        let slice = reports.slice(skip);
        if (maxCount !== null && checkpoint + slice.length > maxCount) {
          slice = slice.slice(0, maxCount - checkpoint);
        }
        if (!slice.length) {
          reachedEndOfPages = true;
          break;
        }

        await ingestSlice(slice, true);
        checkpoint += slice.length;
        await this.updateRun(client, bankKey, day, {
          source_total: sourceTotal,
          checkpoint,
          ingested_count: processed,
          success_count: success,
          fail_count: fail,
          skipped_count: skippedOtherMethod,
          error_count: errors,
        });

        if (reports.length < pageSize || (maxCount !== null && checkpoint >= maxCount)) {
          reachedEndOfPages = true;
          break;
        }
      }

      if (maxCount === null && sourceTotal > initialTotal && initialTotal > 0) {
        const headPages = Math.min(
          Math.ceil((sourceTotal - initialTotal) / pageSize) + 1,
          Math.ceil(sourceTotal / pageSize),
        );
        for (let headPage = 1; headPage <= headPages; headPage++) {
          const headData = await this.fetchPage(headPage, pageSize, day, filters, bankKey);
          const headReports = Array.isArray(headData?.reportResults)
            ? headData.reportResults
            : Array.isArray(headData?.reports)
              ? headData.reports
              : Array.isArray(headData)
                ? headData
                : [];
          if (!headReports.length) break;
          await ingestSlice(headReports, false);
          if (headReports.length < pageSize) break;
        }
        processed = Math.max(processed, success + fail + skipped);
      }

      // C1: `complete` فقط وقتی که همهٔ ردیف‌های منبع (متمایز) ذخیره شده باشند
      const distinctStored = await this.runStore.countDistinct(
        client, bankKey, day, this.samplesTable(bank),
      );
      // فاز ۴: «رد مجاز» فقط ردِ روش دیگر است؛ شناسهٔ نامعتبر و پیام ناخوانا **خطا** هستند و
      // نباید در انتظارِ تعداد ردیف‌های ذخیره‌شده کم شوند (وگرنه روز ناقص «کامل» اعلام می‌شد).
      const expectedDistinct = Math.max(0, sourceTotal - skippedOtherMethod);
      const countMatches =
        distinctStored === expectedDistinct ||
        (maxCount !== null && distinctStored >= Math.min(maxCount, expectedDistinct));
      const reachedAll =
        checkpoint >= sourceTotal || (reachedEndOfPages && checkpoint > 0);
      // شرط پذیرش فاز ۴: کامل فقط وقتی `COUNT(DISTINCT request_id)` برابر با تعداد ردیف‌های
      // متمایز منبع باشد و هیچ خطایی (نه فقط خطای پردازش) رخ نداده باشد.
      const distinctMatches = distinctStored === expectedDistinct;
      const complete =
        mode === 'nightly' &&
        !filteredRun &&
        reachedAll &&
        distinctMatches &&
        countMatches &&
        errors === 0;
      const status = mode === 'intraday' || filteredRun ? 'partial' : complete ? 'complete' : 'needs_review';
      const countGap = {
        source_total: sourceTotal,
        distinct_stored: distinctStored,
        expected_distinct: expectedDistinct,
        skipped_other_method: skippedOtherMethod,
        invalid_ids: invalidIds,
        error_count: errors + invalidIds,
        distinct_matches: distinctMatches,
      };
      await this.updateRun(client, bankKey, day, {
        status,
        finished_at: new Date(),
        source_total: sourceTotal,
        checkpoint,
        ingested_count: processed,
        success_count: success,
        fail_count: fail,
        skipped_count: skippedOtherMethod,
        // خطاها جدا ثبت می‌شوند: `error_count` شامل شناسهٔ نامعتبر و خطای پردازش است
        error_count: errors + invalidIds,
        distinct_stored: distinctStored,
      });
      if (!complete && status === 'needs_review') {
        getActionLogger().warn({
          category: 'ingestion',
          action: 'ingestion.day.needs_review',
          message: `روز ${bankKey}/${day} کامل نشد؛ اختلاف شمارش یا خطا`,
          meta: { bank: bankKey, day, ...countGap },
        });
      }
      if (inTransaction) {
        await client.query('COMMIT');
        inTransaction = false;
      }
      // rollup روز فقط بعد از commit و فقط برای روز `complete` (فاز ۳)
      if (status === 'complete') {
        await this.buildRollup(bankKey, day).catch((error) => {
          getActionLogger().warn({
            category: 'ingestion',
            action: 'ingestion.rollup.failed',
            message: error?.message ?? String(error),
            meta: { bank: bankKey, day },
          });
        });
      }
      const summaryOut = {
        bank: bankKey,
        day,
        mode,
        status,
        source_total: sourceTotal,
        processed,
        success,
        fail,
        skipped,
        skipped_other_method: skippedOtherMethod,
        // فاز ۴: `error_count` مجموع خطاهای واقعی و شناسه‌های نامعتبر است؛ `invalid_ids` تفکیک
        error_count: errors + invalidIds,
        invalid_ids: invalidIds,
        distinct_stored: distinctStored,
        checkpoint,
        rebuild,
        deleted,
      };
      getActionLogger().info({
        category: 'ingestion',
        action: 'ingestion.day.completed',
        meta: summaryOut,
      });
      return summaryOut;
    } catch (error) {
      const message = String(error?.data?.message?.fa ?? error?.message ?? error);
      if (inTransaction) {
        await client.query('ROLLBACK').catch(() => undefined);
        inTransaction = false;
      }
      if (rebuild) {
        // تراکنش rollback شد ⇒ دادهٔ قبلی روز دست‌نخورده است؛ ولی اجرا نیمه‌کاره مانده.
        // ثبت `interrupted` مانع می‌شود اپراتور آن را «اجرای موفق» ببیند (فاز ۴).
        await this.updateRun(client, bankKey, day, {
          status: 'interrupted',
          error: message.slice(0, 1000),
          finished_at: new Date(),
        }).catch(() => undefined);
      } else {
        await this.updateRun(client, bankKey, day, {
          status: 'failed',
          error: message.slice(0, 1000),
          finished_at: new Date(),
          checkpoint,
          ingested_count: processed,
          success_count: success,
          fail_count: fail,
          skipped_count: skippedOtherMethod,
          error_count: errors + 1,
        }).catch(() => undefined);
      }
      getActionLogger().error({
        category: 'ingestion',
        action: 'ingestion.day.failed',
        errorCode: error?.meta?.code || error?.code || 'INGESTION_FAILED',
        statusCode: Number(error?.statusCode) || 500,
        message,
        meta: { bank: bankKey, day, mode, rebuild, checkpoint, processed },
        stack: error?.stack,
      });
      // خطاهای معنادار (۴۰۹ قفل، ۴۱۱ بازهٔ نامعتبر، …) همان‌طور بالا می‌روند تا کنترلر
      // کد وضعیت درست را برگرداند؛ تبدیل به ۵۰۰ باعث می‌شد اپراتور علت را نبیند.
      if (error && typeof error === 'object' && Number(error.statusCode) >= 400 && Number(error.statusCode) < 500) {
        throw error;
      }
      if (error && typeof error === 'object' && error.statusCode && error.meta) {
        throw error;
      }
      throw adminError.internalServerError({
        day,
        rebuild,
        cause: message,
      });
    } finally {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async runFilteredLookup(bankInput, filters) {
    const bankKey = bankInput;
    const bank = BANKS[bankKey];
    if (!bank) throw adminError.invalidBank(bankInput);
    if (!filters?.requestId?.trim() && !filters?.uniqueKey?.trim() && !filters?.nationalCode?.trim()) {
      throw adminError.filterRequiredWithoutDate;
    }
    // سقف ۲۰۰ برای هر صفحه (هم از env و هم از پارامتر درخواست) — در `config.js` هم بسته شده
    const maxPageSize = Number(process.env.CE_API_PAGE_SIZE_MAX || 200);
    const pageSize =
      filters?.pageSize && Number(filters.pageSize) >= 1
        ? Math.min(Math.floor(Number(filters.pageSize)), maxPageSize)
        : Math.min(config.pageSize, maxPageSize);
    const maxCount =
      filters?.maxCount && Number(filters.maxCount) >= 1
        ? Math.min(Math.floor(Number(filters.maxCount)), 5000)
        : 500;

    const client = await this.db.getClient();
    let checkpoint = 0, sourceTotal = 0, success = 0, fail = 0, skipped = 0, processed = 0;
    const daysTouched = new Set();
    const messageTemplates = new Map();
    const writtenTemplates = new Set();
    const seenStatus = new Map();

    try {
      const preflight = await this.sourceTotal(null, filters, bankKey);
      sourceTotal = Math.min(preflight, maxCount);
      while (checkpoint < sourceTotal) {
        const page = Math.floor(checkpoint / pageSize) + 1;
        const skip = checkpoint % pageSize;
        const data = await this.fetchPage(page, pageSize, null, filters, bankKey);
        const reports = Array.isArray(data?.reportResults)
          ? data.reportResults
          : Array.isArray(data?.reports)
            ? data.reports
            : Array.isArray(data)
              ? data
              : [];
        if (!reports.length) break;
        let slice = reports.slice(skip);
        if (checkpoint + slice.length > maxCount) {
          slice = slice.slice(0, maxCount - checkpoint);
        }
        if (!slice.length) break;

        const rows = [];
        for (const raw of slice) {
          processed++;
          try {
            const sample = this.evaluator.normalizeSample(raw, { fromApi: true });
            const method = String(sample?.input?.method ?? '').trim().toLowerCase();
            if (method !== bank.method) {
              skipped++;
              continue;
            }
            const inferredDay = inferDayFromSample(sample);
            const isSuccess = this.evaluator.isReportSuccess(sample);
            const template = this.evaluator.messageTemplateOf(sample, isSuccess);
            if (template) messageTemplates.set(template.key, template.text);
            const row = this.evaluator.evaluate(sample, isSuccess, inferredDay, bankKey);
            if (!row.request_id) {
              skipped++;
              continue;
            }
            daysTouched.add(inferredDay);
            rows.push(row);
            const seenKey = `${inferredDay}\0${row.request_id}`;
            const prev = seenStatus.get(seenKey);
            if (prev === undefined) {
              seenStatus.set(seenKey, isSuccess);
              if (isSuccess) success++; else fail++;
            } else if (prev !== isSuccess) {
              seenStatus.set(seenKey, isSuccess);
              if (isSuccess) { success++; fail--; } else { fail++; success--; }
            }
          } catch (error) {
            skipped++;
            getActionLogger().warn({
              category: 'ingestion',
              action: 'ingestion.filtered_sample.skipped',
              message: error?.message ?? String(error),
              meta: { bank: bankKey },
            });
          }
        }
        await this.upsertBatch(client, bank.table, rows, bankKey);
        const pending = [...messageTemplates.entries()].filter(([key]) => !writtenTemplates.has(key));
        if (pending.length) {
          await client.query(
            `INSERT INTO message_dict(message_key, label, topic, message_text)
             SELECT k, k, 'other', t FROM unnest($1::text[], $2::text[]) AS x(k, t)
             ON CONFLICT (message_key) DO UPDATE SET message_text=EXCLUDED.message_text`,
            [pending.map(([key]) => key), pending.map(([, text]) => text)],
          );
          for (const [key] of pending) writtenTemplates.add(key);
        }
        checkpoint += slice.length;
        if (reports.length < pageSize || checkpoint >= maxCount) break;
      }
      const filteredSummary = {
        bank: bankKey,
        day: daysTouched.size ? [...daysTouched].sort().join('، ') : 'بدون داده',
        days_touched: [...daysTouched].sort(),
        mode: 'intraday',
        status: 'partial',
        source_total: sourceTotal,
        processed,
        success,
        fail,
        skipped,
        checkpoint,
        rebuild: false,
        deleted: 0,
      };
      getActionLogger().info({
        category: 'ingestion',
        action: 'ingestion.filtered.completed',
        meta: filteredSummary,
      });
      return filteredSummary;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  IngestionService,
  hasNarrowingFilters,
  normalizeDay,
  tehranToday,
  tehranYesterday,
};
