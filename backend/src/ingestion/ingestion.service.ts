import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { EvaluatorService, AnalyzedRow } from '../evaluator/evaluator.service';
import { BANKS, BankKey, config } from '../config';
import { normalizeDay, tehranToday, tehranYesterday, toApiDate } from '../utils/date';
export { normalizeDay, tehranToday, tehranYesterday } from '../utils/date';

const UPSERT_COLUMNS = [
  'request_id', 'day', 'inserted_at', 'stamp_key', 'unique_key', 'is_success', 'model_name', 'status_code', 'error_code', 'message_key',
  'total_time_s', 'pd', 'suggested_amount', 'amount_kind', 'score_req', 'credit_basket', 'avg36',
  'ln_avg_installments', 'rotbe', 'flags', 'cats', 'counters', 'metrics', 'paths', 'services',
  'credit_alerts', 'display_extras', 'analysis_version',
] as const;

/** گزینههای اجرای یک روز. rebuild: پاک کردن کامل ردیفهای آن روز پیش از ورود مجدد. */
export interface RunDayOptions {
  rebuild?: boolean;
}

@Injectable()
export class IngestionService {
  constructor(private db: DatabaseService, private evaluator: EvaluatorService) {}

  private async fetchPage(page: number, limit: number, day: string): Promise<any> {
    const url = new URL(config.apiBaseUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('date', toApiDate(day));
    const headers: Record<string, string> = {
      'gateway-system': config.apiSystem,
      'gateway-token': config.apiToken,
      accept: 'application/json',
    };
    let lastError: any;
    for (let attempt = 1; attempt <= config.retryCount; attempt++) {
      try {
        const response = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(config.requestTimeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        const body: any = await response.json();
        return body?.data ?? body;
      } catch (error) {
        lastError = error;
        if (attempt < config.retryCount) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw new Error(`دریافت صفحه ${page} از API اصلی ناموفق بود: ${lastError?.message ?? lastError}`);
  }

  private async sourceTotal(day: string): Promise<number> {
    const data = await this.fetchPage(1, 1, day);
    const raw = data?.count ?? data?.totalCount ?? data?.total ?? data?.reportResults?.length ?? 0;
    const total = Number(raw);
    return Number.isFinite(total) ? total : 0;
  }

  private async upsertBatch(client: any, table: string, rows: AnalyzedRow[]) {
    if (!rows.length) return;
    // حذف تکراریهای همزمان داخل یک بچ بر اساس (day, request_id) تا PostgreSQL خطای
    // "ON CONFLICT DO UPDATE command cannot affect row a second time" ندهد.
    const dedupedMap = new Map<string, AnalyzedRow>();
    for (const row of rows) {
      dedupedMap.set(`${row.day}\0${row.request_id}`, row);
    }
    const uniqueRows = [...dedupedMap.values()];

    const values: string[] = [];
    const params: any[] = [];
    const jsonColumns = new Set(['flags', 'cats', 'counters', 'metrics', 'paths', 'services', 'credit_alerts', 'display_extras']);
    uniqueRows.forEach((row, index) => {
      const base = index * UPSERT_COLUMNS.length;
      values.push(`(${UPSERT_COLUMNS.map((_, i) => `$${base + i + 1}`).join(',')})`);
      for (const column of UPSERT_COLUMNS) {
        const value = (row as any)[column];
        params.push(jsonColumns.has(column) && value !== null && value !== undefined ? JSON.stringify(value) : value);
      }
    });
    const updates = UPSERT_COLUMNS.filter((c) => c !== 'request_id' && c !== 'day')
      .map((c) => `${c}=EXCLUDED.${c}`).join(', ');
    const sql = `INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}
      ON CONFLICT (day, request_id) DO UPDATE SET ${updates}, updated_at=now()`;
    await client.query(sql, params);
  }

  private async startRun(client: any, bankKey: string, day: string, mode: string) {
    const existing: any = await client.query(
      'SELECT status, checkpoint FROM day_runs WHERE bank=$1 AND day=$2', [bankKey, day],
    );
    const resume = mode === 'nightly' && existing.rows[0]?.status === 'running';
    const checkpoint = resume ? Number(existing.rows[0].checkpoint) : 0;
    await client.query(
      `INSERT INTO day_runs(bank,day,mode,status,checkpoint,analysis_version,started_at)
       VALUES($1,$2,$3,'running',$4,$5,now())
       ON CONFLICT(bank,day) DO UPDATE SET mode=EXCLUDED.mode, status='running', checkpoint=EXCLUDED.checkpoint,
         analysis_version=EXCLUDED.analysis_version, started_at=now(), finished_at=NULL, error=NULL, updated_at=now()`,
      [bankKey, day, mode, checkpoint, this.evaluator.versionOf(bankKey)],
    );
    return checkpoint;
  }

  private async updateRun(client: any, bankKey: string, day: string, patch: Record<string, any>) {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
    await client.query(
      `UPDATE day_runs SET ${sets}, updated_at=now() WHERE bank=$1 AND day=$2`,
      [bankKey, day, ...keys.map((k) => patch[k])],
    );
  }

  async runDay(bankInput: string, dayInput?: string, mode: 'nightly' | 'intraday' = 'nightly', options: RunDayOptions = {}) {
    const bankKey = bankInput as BankKey;
    const bank = BANKS[bankKey];
    if (!bank) throw new Error(`بانک پشتیبانیشده نیست: ${bankInput} (بانکهای پشتیبانیشده: ملت، رسالت، پستبانک)`);
    const rebuild = options.rebuild === true;
    if (rebuild && !dayInput) throw new Error('--rebuild نیاز به --day مشخص دارد (برای جلوگیری از پاک شدن ناخواستهٔ دیروز).');
    const day = normalizeDay(dayInput ?? (mode === 'nightly' ? tehranYesterday() : tehranToday()));
    const client = await this.db.getClient();
    const lockKey = `ce-ingest:${bankKey}:${day}`;
    let checkpoint = 0, sourceTotal = 0, success = 0, fail = 0, skipped = 0, processed = 0;
    let inTransaction = false, deleted = 0;
    const messageTemplates = new Map<string, string>();
    const writtenTemplates = new Set<string>();

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      // پیشبینی خرابی API پیش از پاک کردن: اگر منبع پاسخ نداد، چیزی حذف نشود.
      const preflight = await this.sourceTotal(day);
      if (rebuild && !preflight) {
        throw new Error(`--rebuild لغو شد: API برای ${day} هیچ رکوردی برنگرداند؛ دادههای موجود دستنخورده ماندند.`);
      }
      if (rebuild) {
        // حذف و ورود مجدد در یک تراکنش: یا همه چیز جایگزین میشود، یا هیچچیز.
        await client.query('BEGIN');
        inTransaction = true;
        const removed: any = await client.query(`DELETE FROM ${bank.table} WHERE day=$1`, [day]);
        deleted = removed.rowCount ?? 0;
        await client.query('DELETE FROM day_runs WHERE bank=$1 AND day=$2', [bankKey, day]);
        console.warn(`[ingest] --rebuild: ${deleted} ردیف قدیمی ${bankKey}/${day} حذف شد؛ تراکنش تا پایان ورود باز است.`);
      }
      const initialTotal = preflight;
      checkpoint = await this.startRun(client, bankKey, day, mode);
      sourceTotal = preflight;
      await this.updateRun(client, bankKey, day, { source_total: sourceTotal });

      const seenStatus = new Map<string, boolean>();
      let reachedEndOfPages = sourceTotal === 0;

      const ingestSlice = async (slice: any[], countProcessed = true) => {
        const rows: AnalyzedRow[] = [];
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
            console.warn(`[ingest] پرش نمونه: ${(error as any)?.message ?? error}`);
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
        const page = Math.floor(checkpoint / config.pageSize) + 1;
        const skip = checkpoint % config.pageSize;
        const data = await this.fetchPage(page, config.pageSize, day);
        const liveRaw = data?.count ?? data?.totalCount ?? data?.total;
        const liveTotal = Number(liveRaw);
        if (Number.isFinite(liveTotal) && liveTotal > sourceTotal) {
          sourceTotal = liveTotal;
        }
        const reports: any[] = Array.isArray(data?.reportResults) ? data.reportResults
          : Array.isArray(data?.reports) ? data.reports : Array.isArray(data) ? data : [];
        if (!reports.length) {
          reachedEndOfPages = true;
          break;
        }
        const slice = reports.slice(skip);
        if (!slice.length) {
          reachedEndOfPages = true;
          break;
        }

        await ingestSlice(slice, true);
        checkpoint += slice.length;
        await this.updateRun(client, bankKey, day, {
          source_total: sourceTotal, checkpoint, ingested_count: processed,
          success_count: success, fail_count: fail, skipped_count: skipped,
        });

        // اگر صفحه کمتر از pageSize رکورد برگرداند، به انتهای واقعی دادههای API رسیدهایم
        // (جلوگیری از حلقهٔ بینهایت وقتی sourceTotal اولیه بزرگتر از تعداد واقعی رکوردها بوده).
        if (reports.length < config.pageSize) {
          reachedEndOfPages = true;
          break;
        }
      }

      // در حالت زنده، اگر حین پیمایش صفحات رکوردهای جدیدی اضافه شده و ترتیب API نزولی باشد،
      // صفحات ابتدایی را به اندازهٔ رشد sourceTotal بازخوانی میکنیم تا رکوردهای تازه جا نمانند.
      if (sourceTotal > initialTotal && initialTotal > 0) {
        const headPages = Math.min(
          Math.ceil((sourceTotal - initialTotal) / config.pageSize) + 1,
          Math.ceil(sourceTotal / config.pageSize),
        );
        for (let headPage = 1; headPage <= headPages; headPage++) {
          const headData = await this.fetchPage(headPage, config.pageSize, day);
          const headReports: any[] = Array.isArray(headData?.reportResults) ? headData.reportResults
            : Array.isArray(headData?.reports) ? headData.reports : Array.isArray(headData) ? headData : [];
          if (!headReports.length) break;
          await ingestSlice(headReports, false);
          if (headReports.length < config.pageSize) break;
        }
        processed = Math.max(processed, success + fail + skipped);
      }

      const complete = mode === 'nightly'
        && (checkpoint >= sourceTotal || (reachedEndOfPages && checkpoint > 0))
        && skipped === 0;
      const status = mode === 'intraday' ? 'partial' : complete ? 'complete' : 'needs_review';
      await this.updateRun(client, bankKey, day, {
        status, finished_at: new Date(), source_total: sourceTotal, checkpoint,
        ingested_count: processed, success_count: success, fail_count: fail, skipped_count: skipped,
      });
      if (inTransaction) { await client.query('COMMIT'); inTransaction = false; }
      return { bank: bankKey, day, mode, status, source_total: sourceTotal, processed, success, fail, skipped, checkpoint,
        rebuild, deleted };
    } catch (error) {
      const message = String((error as any)?.message ?? error);
      // در حالت rebuild تراکنش برگردانده میشود تا هم ردیفها و هم day_runs قدیمی سالم بمانند؛
      // خطا از طریق CLI گزارش میشود، پس وضعیت لاگ قبلی دستکاری نمیشود.
      if (inTransaction) { await client.query('ROLLBACK').catch(() => undefined); inTransaction = false; }
      if (!rebuild) await this.updateRun(client, bankKey, day, {
        status: 'failed', error: message.slice(0, 1000), finished_at: new Date(), checkpoint,
        ingested_count: processed, success_count: success, fail_count: fail, skipped_count: skipped,
      }).catch(() => undefined);
      throw new Error(rebuild ? `${message} (--rebuild: تراکنش برگردانده شد، دادههای ${day} دستنخورده ماندند)` : message);
    } finally {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }
}
