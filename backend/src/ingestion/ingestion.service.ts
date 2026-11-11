import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { EvaluatorService, AnalyzedRow } from '../evaluator/evaluator.service';
import { BANKS, BankKey, config } from '../config';
import { normalizeDay, tehranToday, tehranYesterday, toApiDate } from '../utils/date';
export { normalizeDay, tehranToday, tehranYesterday } from '../utils/date';

const UPSERT_COLUMNS = [
  'request_id', 'day', 'inserted_at', 'is_success', 'model_name', 'status_code', 'error_code', 'message_key',
  'total_time_s', 'pd', 'suggested_amount', 'amount_kind', 'score_req', 'credit_basket', 'avg36',
  'ln_avg_installments', 'rotbe', 'flags', 'cats', 'counters', 'metrics', 'paths', 'services',
  'credit_alerts', 'analysis_version',
] as const;

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

  private async upsertBatch(table: string, rows: AnalyzedRow[]) {
    if (!rows.length) return;
    const values: string[] = [];
    const params: any[] = [];
    rows.forEach((row, index) => {
      const base = index * UPSERT_COLUMNS.length;
      values.push(`(${UPSERT_COLUMNS.map((_, i) => `$${base + i + 1}`).join(',')})`);
      for (const column of UPSERT_COLUMNS) params.push((row as any)[column]);
    });
    const updates = UPSERT_COLUMNS.filter((c) => c !== 'request_id')
      .map((c) => `${c}=EXCLUDED.${c}`).join(', ');
    const sql = `INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}
      ON CONFLICT (request_id) DO UPDATE SET ${updates}, updated_at=now()`;
    await this.db.query(sql, params);
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
      [bankKey, day, mode, checkpoint, this.evaluator.analysisVersion],
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

  async runDay(bankInput: string, dayInput?: string, mode: 'nightly' | 'intraday' = 'nightly') {
    const bankKey = bankInput as BankKey;
    const bank = BANKS[bankKey];
    if (!bank) throw new Error(`بانک پشتیبانیشده نیست: ${bankInput} (نسخه ۱ فقط tavan_mellat)`);
    const day = normalizeDay(dayInput ?? (mode === 'nightly' ? tehranYesterday() : tehranToday()));
    const client = await this.db.getClient();
    const lockKey = `ce-ingest:${bankKey}:${day}`;
    let checkpoint = 0, sourceTotal = 0, success = 0, fail = 0, skipped = 0, processed = 0;

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      checkpoint = await this.startRun(client, bankKey, day, mode);
      sourceTotal = await this.sourceTotal(day);
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
            const row = this.evaluator.evaluate(sample, isSuccess, day);
            if (!row.request_id) { skipped++; continue; }
            rows.push(row);
            if (isSuccess) success++; else fail++;
          } catch (error) {
            skipped++;
            console.warn(`[ingest] پرش نمونه: ${(error as any)?.message ?? error}`);
          }
        }
        await this.upsertBatch(bank.table, rows);
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
      return { bank: bankKey, day, mode, status, source_total: sourceTotal, processed, success, fail, skipped, checkpoint };
    } catch (error) {
      const message = String((error as any)?.message ?? error);
      await this.updateRun(client, bankKey, day, {
        status: 'failed', error: message.slice(0, 1000), finished_at: new Date(), checkpoint,
        ingested_count: processed, success_count: success, fail_count: fail, skipped_count: skipped,
      }).catch(() => undefined);
      throw error;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }
}
