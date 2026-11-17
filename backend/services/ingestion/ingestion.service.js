'use strict';
const { BANKS, config, resolveBankApiUrl } = require('../config');
const { fetchBankJson } = require('../http/gateway-client');
const { error: adminError } = require('../../controllers/adminController/config');
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
  constructor(db, evaluator) {
    this.db = db;
    this.evaluator = evaluator;
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

  async upsertBatch(client, table, rows) {
    if (!rows.length) return;
    const dedupedMap = new Map();
    for (const row of rows) {
      dedupedMap.set(`${row.day}\0${row.request_id}`, row);
    }
    const uniqueRows = [...dedupedMap.values()];

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
    const updates = UPSERT_COLUMNS
      .filter((c) => c !== 'request_id' && c !== 'day')
      .map((c) => `${c}=EXCLUDED.${c}`)
      .concat('updated_at=now()')
      .join(', ');
    await client.query(
      `INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (day, request_id) DO UPDATE SET ${updates}`,
      params,
    );
  }

  async startRun(client, bankKey, day, mode) {
    const existing = await client.query(
      'SELECT checkpoint, status FROM day_runs WHERE bank=$1 AND day=$2',
      [bankKey, day],
    );
    const row = existing.rows[0];
    const checkpoint = row?.status === 'complete' ? 0 : Number(row?.checkpoint ?? 0);
    await client.query(
      `INSERT INTO day_runs(bank,day,mode,status,checkpoint,analysis_version,started_at)
       VALUES($1,$2,$3,'running',$4,$5,now())
       ON CONFLICT(bank,day) DO UPDATE SET mode=EXCLUDED.mode, status='running', checkpoint=$4,
         analysis_version=EXCLUDED.analysis_version, started_at=now(), finished_at=NULL, error=NULL, updated_at=now()`,
      [bankKey, day, mode, checkpoint, this.evaluator.versionOf(bankKey)],
    );
    return checkpoint;
  }

  async updateRun(client, bankKey, day, patch) {
    const keys = Object.keys(patch);
    const sets = keys.map((k, idx) => `${k}=$${idx + 3}`).concat('updated_at=now()');
    await client.query(
      `UPDATE day_runs SET ${sets.join(', ')} WHERE bank=$1 AND day=$2`,
      [bankKey, day, ...keys.map((k) => patch[k])],
    );
  }

  async runDay(bankInput, dayInput, mode = 'nightly', options = {}) {
    const bankKey = bankInput;
    const bank = BANKS[bankKey];
    if (!bank) throw adminError.invalidBank(bankInput);
    const rebuild = options.rebuild === true;
    const filters = options.filters;
    const pageSize =
      filters?.pageSize && Number(filters.pageSize) >= 1 && Number(filters.pageSize) <= 200
        ? Math.floor(Number(filters.pageSize))
        : config.pageSize;
    const maxCount =
      filters?.maxCount && Number(filters.maxCount) >= 1
        ? Math.floor(Number(filters.maxCount))
        : null;
    const filteredRun = hasNarrowingFilters(filters);
    if (rebuild && !dayInput) {
      throw adminError.rebuildRequiresExplicitDay;
    }
    const day = normalizeDay(dayInput ?? (mode === 'nightly' ? tehranYesterday() : tehranToday()));
    const client = await this.db.getClient();
    const lockKey = `ce-ingest:${bankKey}:${day}`;
    let checkpoint = 0, sourceTotal = 0, success = 0, fail = 0, skipped = 0, processed = 0;
    let inTransaction = false, deleted = 0;
    const messageTemplates = new Map();
    const writtenTemplates = new Set();

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      const preflight = await this.sourceTotal(day, filters, bankKey);
      if (rebuild && !preflight) {
        throw adminError.emptyRebuildAborted(day);
      }
      if (rebuild) {
        await client.query('BEGIN');
        inTransaction = true;
        const removed = await client.query(`DELETE FROM ${bank.table} WHERE day=$1`, [day]);
        deleted = removed.rowCount ?? 0;
        await client.query('DELETE FROM day_runs WHERE bank=$1 AND day=$2', [bankKey, day]);
        console.warn(`[ingest] --rebuild: ${deleted} ردیف قدیمی ${bankKey}/${day} حذف شد؛ تراکنش تا پایان ورود باز است.`);
      }
      const effectiveInitial = maxCount !== null ? Math.min(preflight, maxCount) : preflight;
      const initialTotal = effectiveInitial;
      checkpoint = filteredRun ? 0 : await this.startRun(client, bankKey, day, mode);
      if (filteredRun) {
        await client.query(
          `INSERT INTO day_runs(bank,day,mode,status,checkpoint,analysis_version,started_at)
           VALUES($1,$2,$3,'running',0,$4,now())
           ON CONFLICT(bank,day) DO UPDATE SET mode=EXCLUDED.mode, status='running', checkpoint=0,
             analysis_version=EXCLUDED.analysis_version, started_at=now(), finished_at=NULL, error=NULL, updated_at=now()`,
          [bankKey, day, mode, this.evaluator.versionOf(bankKey)],
        );
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
              if (countProcessed) skipped++;
              continue;
            }
            const isSuccess = this.evaluator.isReportSuccess(sample);
            const template = this.evaluator.messageTemplateOf(sample, isSuccess);
            if (template) messageTemplates.set(template.key, template.text);
            const row = this.evaluator.evaluate(sample, isSuccess, day, bankKey);
            if (!row.request_id) {
              if (countProcessed) skipped++;
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
            if (countProcessed) skipped++;
            console.warn(`[ingest] پرش نمونه: ${error?.message ?? error}`);
          }
        }
        await this.upsertBatch(client, bank.table, rows);
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
          skipped_count: skipped,
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

      const complete =
        mode === 'nightly' &&
        !filteredRun &&
        (checkpoint >= sourceTotal || (reachedEndOfPages && checkpoint > 0)) &&
        skipped === 0;
      const status = mode === 'intraday' || filteredRun ? 'partial' : complete ? 'complete' : 'needs_review';
      await this.updateRun(client, bankKey, day, {
        status,
        finished_at: new Date(),
        source_total: sourceTotal,
        checkpoint,
        ingested_count: processed,
        success_count: success,
        fail_count: fail,
        skipped_count: skipped,
      });
      if (inTransaction) {
        await client.query('COMMIT');
        inTransaction = false;
      }
      return {
        bank: bankKey,
        day,
        mode,
        status,
        source_total: sourceTotal,
        processed,
        success,
        fail,
        skipped,
        checkpoint,
        rebuild,
        deleted,
      };
    } catch (error) {
      const message = String(error?.data?.message?.fa ?? error?.message ?? error);
      if (inTransaction) {
        await client.query('ROLLBACK').catch(() => undefined);
        inTransaction = false;
      }
      if (!rebuild) {
        await this.updateRun(client, bankKey, day, {
          status: 'failed',
          error: message.slice(0, 1000),
          finished_at: new Date(),
          checkpoint,
          ingested_count: processed,
          success_count: success,
          fail_count: fail,
          skipped_count: skipped,
        }).catch(() => undefined);
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
    const pageSize =
      filters?.pageSize && Number(filters.pageSize) >= 1 && Number(filters.pageSize) <= 200
        ? Math.floor(Number(filters.pageSize))
        : config.pageSize;
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
            console.warn(`[ingest] پرش نمونه در جستجوی شناسهای: ${error?.message ?? error}`);
          }
        }
        await this.upsertBatch(client, bank.table, rows);
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
      return {
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
