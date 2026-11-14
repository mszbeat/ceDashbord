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
    const values: string[] = [];
    const params: any[] = [];
    const jsonColumns = new Set(['flags', 'cats', 'counters', 'metrics', 'paths', 'services', 'credit_alerts', 'display_extras']);
    rows.forEach((row, index) => {
      const base = index * UPSERT_COLUMNS.length;
      values.push(`(${UPSERT_COLUMNS.map((_, i) => `$${base + i + 1}`).join(',')})`);
      for (const column of UPSERT_COLUMNS) {
        const value = (row as any)[column];
        params.push(jsonColumns.has(column) && value !== null && value !== undefined ? JSON.stringify(value) : value);
      }
    });
    const updates = UPSERT_COLUMNS.filter((c) => c !== 'request_id')
      .map((c) => `${c}=EXCLUDED.${c}`).join(', ');
    const sql = `INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}
      ON CONFLICT (request_id) DO UPDATE SET ${updates}, updated_at=now()`;
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
      checkpoint = await this.startRun(client, bankKey, day, mode);
      sourceTotal = preflight;
      await this.updateRun(client, bankKey, day, { source_total: sourceTotal });

      while (checkpoint < sourceTotal) {
        const page = Math.floor(checkpoint / config.pageSize) + 1;
        const skip = checkpoint % config.pageSize;
        const data = await this.fetchPage(page, config.pageSize, day);
        const reports: any[] = Array.isArray(data?.reportResults) ? data.reportResults
          : Array.isArray(data?.reports) ? data.reports : Array.isArray(data) ? data : [];
        if (!reports.length) break;
        const slice = reports.slice(skip);
        const rows: AnalyzedRow[] = [];
        for (const raw of slice) {
          processed++;
          try {
            const sample = this.evaluator.normalizeSample(raw);
            const method = String(sample?.input?.method ?? '').toLowerCase();
            if (method !== bank.method) { skipped++; continue; }
            const isSuccess = this.evaluator.isReportSuccess(sample);
            const template = this.evaluator.messageTemplateOf(sample, isSuccess);
            if (template) messageTemplates.set(template.key, template.text);
            const row = this.evaluator.evaluate(sample, isSuccess, day, bankKey);
            if (!row.request_id) { skipped++; continue; }
            rows.push(row);
            if (isSuccess) success++; else fail++;
          } catch (error) {
            skipped++;
            console.warn(`[ingest] پرش نمونه: ${(error as any)?.message ?? error}`);
          }
        }
        await this.upsertBatch(client, bank.table, rows);
        // متن دقیق پیامهای قالبی قدیمی (fa + en) فقط یکبار در message_dict نوشته میشود؛
        // متن آزاد هر نمونه هرگز در ردیفها ذخیره نمیشود (PRD §12).
        const pending = [...messageTemplates.entries()].filter(([key]) => !writtenTemplates.has(key));
        if (pending.length) await client.query(
          `INSERT INTO message_dict(message_key, label, topic, message_text)
           SELECT k, k, 'other', t FROM unnest($1::text[], $2::text[]) AS x(k, t)
           ON CONFLICT (message_key) DO UPDATE SET message_text=EXCLUDED.message_text`,
          [pending.map(([key]) => key), pending.map(([, text]) => text)],
        );
        for (const [key] of pending) writtenTemplates.add(key);
        const unknownKeys = [...new Set(rows.map((row) => row.message_key).filter((key) => key && key.startsWith('MSG_UNKNOWN:')))];
        if (unknownKeys.length) await client.query(
          `INSERT INTO message_dict(message_key, label, topic, message_text)
           SELECT key, 'سایر پیامها', 'other', 'سایر پیامها' FROM unnest($1::text[]) AS key
           ON CONFLICT (message_key) DO NOTHING`, [unknownKeys],
        );
        checkpoint += slice.length;
        await this.updateRun(client, bankKey, day, {
          checkpoint, ingested_count: processed, success_count: success, fail_count: fail, skipped_count: skipped,
        });
      }

      const complete = mode === 'nightly' && checkpoint >= sourceTotal && skipped === 0;
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
