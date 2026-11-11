import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { EvaluatorService } from '../evaluator/evaluator.service';
import { BANKS, BankKey, config } from '../config';
import { defaultRange, normalizeDay, toApiDate } from '../utils/date';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SERVICE_FA, SERVICE_KINDS } = (() => {
  const common = require('../evaluator/legacy/src/common');
  const analyze = require('../evaluator/legacy/src/analyze');
  return { SERVICE_FA: common.SERVICE_FA, SERVICE_KINDS: analyze.SERVICE_KINDS };
})();

type Range = { from: string; to: string };

function rangeOf(from?: string, to?: string): Range {
  const fallback = defaultRange(30);
  return { from: normalizeDay(from || fallback.from), to: normalizeDay(to || fallback.to) };
}

function bankTable(bankInput: string): { key: BankKey; table: string; label: string } {
  const key = bankInput as BankKey;
  const bank = BANKS[key];
  if (!bank) throw new Error(`بانک پشتیبانیشده نیست: ${bankInput}`);
  return { key, table: bank.table, label: bank.label };
}

function num(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function redactSensitive(value: any, key = ''): any {
  if (value === null || typeof value !== 'object') return value;
  const sensitive = /national.?code|sourceip/i.test(key);
  if (sensitive) return undefined;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, key));
  const out: Record<string, any> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/national.?code|sourceip/i.test(childKey)) continue;
    out[childKey] = redactSensitive(childValue, childKey);
  }
  return out;
}

@Injectable()
export class SummaryService {
  constructor(private db: DatabaseService, private evaluator: EvaluatorService) {}

  banks() {
    return Object.entries(BANKS).map(([id, bank]) => ({ id, label: bank.label, method: bank.method }));
  }

  specs(bankInput: string) {
    bankTable(bankInput);
    return this.evaluator.specs();
  }

  async summary(bankInput: string, from?: string, to?: string) {
    const { key, table, label } = bankTable(bankInput);
    const { from: f, to: t } = rangeOf(from, to);
    const p = [f, t];

    const [totals, metricsRows, counterRows, flagRows, catRows, serviceRows, pathRows, rotbeRows,
      messageRows, dailyTotals, dailyFlags, runRows, pdHist, timeHist, amountHist] = await Promise.all([
      this.db.query(`SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_success)::int AS success,
          COUNT(*) FILTER (WHERE NOT is_success)::int AS fail,
          COUNT(DISTINCT day)::int AS days,
          MIN(inserted_at) AS first_inserted, MAX(inserted_at) AS last_inserted
        FROM ${table} WHERE day BETWEEN $1 AND $2`, p),
      this.db.query(`SELECT key,
          COUNT(value::double precision)::int AS count,
          MIN(value::double precision) AS min,
          AVG(value::double precision) AS mean,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY value::double precision) AS p25,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY value::double precision) AS median,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY value::double precision) AS p75,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY value::double precision) AS p95,
          MAX(value::double precision) AS max
        FROM ${table}, jsonb_each_text(metrics)
        WHERE day BETWEEN $1 AND $2 AND value IS NOT NULL
        GROUP BY key`, p),
      this.db.query(`SELECT key, SUM(value::numeric)::float8 AS total
        FROM ${table}, jsonb_each_text(counters)
        WHERE day BETWEEN $1 AND $2 AND value IS NOT NULL
        GROUP BY key`, p),
      this.db.query(`SELECT key, COUNT(*)::int AS count
        FROM ${table}, jsonb_each_text(flags)
        WHERE day BETWEEN $1 AND $2 AND value = 'true'
        GROUP BY key`, p),
      this.db.query(`SELECT key, value, is_success, COUNT(*)::int AS count
        FROM ${table}, jsonb_each_text(cats)
        WHERE day BETWEEN $1 AND $2 AND value IS NOT NULL
        GROUP BY key, value, is_success`, p),
      this.db.query(`SELECT key, value, COUNT(*)::int AS count
        FROM ${table}, jsonb_each_text(services)
        WHERE day BETWEEN $1 AND $2
        GROUP BY key, value`, p),
      this.db.query(`SELECT key, value, COUNT(*)::int AS count
        FROM ${table}, jsonb_each_text(paths)
        WHERE day BETWEEN $1 AND $2 AND value IS NOT NULL
        GROUP BY key, value`, p),
      this.db.query(`SELECT rotbe, COUNT(*)::int AS count
        FROM ${table} WHERE day BETWEEN $1 AND $2 AND rotbe IS NOT NULL GROUP BY rotbe`, p),
      this.db.query('SELECT message_key, label, topic FROM message_dict'),
      this.db.query(`SELECT day, COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_success)::int AS success,
          COUNT(*) FILTER (WHERE NOT is_success)::int AS fail
        FROM ${table} WHERE day BETWEEN $1 AND $2 GROUP BY day ORDER BY day`, p),
      this.db.query(`SELECT day, key, COUNT(*) FILTER (WHERE value = 'true')::int AS count
        FROM ${table}, jsonb_each_text(flags)
        WHERE day BETWEEN $1 AND $2 GROUP BY day, key ORDER BY day`, p),
      this.db.query('SELECT * FROM day_runs WHERE bank=$1 AND day BETWEEN $2 AND $3 ORDER BY day DESC', [key, f, t]),
      this.db.query(`SELECT CASE
            WHEN pd < 0.1 THEN '۰٫۰۰ تا کمتر از ۰٫۱۰'
            WHEN pd < 0.2 THEN '۰٫۱۰ تا کمتر از ۰٫۲۰'
            WHEN pd < 0.3 THEN '۰٫۲۰ تا کمتر از ۰٫۳۰'
            WHEN pd < 0.4 THEN '۰٫۳۰ تا کمتر از ۰٫۴۰'
            WHEN pd < 0.5 THEN '۰٫۴۰ تا کمتر از ۰٫۵۰'
            WHEN pd = 0.5 THEN 'دقیقاً ۰٫۵۰'
            WHEN pd < 0.6 THEN 'بیشتر از ۰٫۵۰ تا کمتر از ۰٫۶۰'
            WHEN pd < 0.8 THEN '۰٫۶۰ تا کمتر از ۰٫۸۰'
            WHEN pd <= 1 THEN '۰٫۸۰ تا ۱٫۰۰'
            ELSE 'خارج از بازه' END AS bucket, COUNT(*)::int AS count
          FROM ${table} WHERE day BETWEEN $1 AND $2 AND pd IS NOT NULL
          GROUP BY 1 ORDER BY MIN(pd)`, p),
      this.db.query(`SELECT CASE
            WHEN total_time_s <= 1 THEN 'تا ۱ ثانیه'
            WHEN total_time_s <= 2 THEN '۱ تا ۲ ثانیه'
            WHEN total_time_s <= 4 THEN '۲ تا ۴ ثانیه'
            WHEN total_time_s <= 8 THEN '۴ تا ۸ ثانیه'
            WHEN total_time_s <= 15 THEN '۸ تا ۱۵ ثانیه'
            ELSE 'بیش از ۱۵ ثانیه' END AS bucket, COUNT(*)::int AS count
          FROM ${table} WHERE day BETWEEN $1 AND $2 AND total_time_s IS NOT NULL
          GROUP BY 1 ORDER BY MIN(total_time_s)`, p),
      this.db.query(`SELECT CASE
            WHEN v < 1e7 THEN 'کمتر از ۱۰ میلیون'
            WHEN v < 5e7 THEN '۱۰ تا ۵۰ میلیون'
            WHEN v < 1e8 THEN '۵۰ تا ۱۰۰ میلیون'
            WHEN v < 5e8 THEN '۱۰۰ تا ۵۰۰ میلیون'
            WHEN v < 1e9 THEN '۵۰۰ میلیون تا ۱ میلیارد'
            ELSE '۱ میلیارد و بیشتر' END AS bucket, COUNT(*)::int AS count
          FROM (SELECT (metrics->>'creditBasket')::numeric AS v FROM ${table}
                WHERE day BETWEEN $1 AND $2 AND metrics->>'creditBasket' IS NOT NULL) x
          GROUP BY 1 ORDER BY MIN(v)`, p),
    ]);

    const stats = totals.rows[0] || { total: 0, success: 0, fail: 0, days: 0 };
    const specs = this.evaluator.specs();
    const messageLabels = new Map<string, string>(
      messageRows.rows.map((r: any) => [r.message_key, r.label]),
    );
    const labelOfMessage = (value: string) => messageLabels.get(value)
      ?? (value.startsWith('MSG_UNKNOWN:') ? `پیام طبقهبندی نشده (${value.slice(12)})` : value);

    const metricById = new Map(specs.metrics.map((m) => [m.id, m]));
    const metrics = Object.fromEntries(metricsRows.rows.map((r: any) => [r.key, {
      id: r.key,
      label: metricById.get(r.key)?.label ?? r.key,
      count: Number(r.count),
      min: num(r.min), mean: num(r.mean), p25: num(r.p25), median: num(r.median),
      p75: num(r.p75), p95: num(r.p95), max: num(r.max),
    }]));
    const counterById = new Map(specs.counters.map((c) => [c.id, c]));
    const counters = Object.fromEntries(counterRows.rows.map((r: any) => [r.key, {
      id: r.key, label: counterById.get(r.key)?.label ?? r.key, total: num(r.total) ?? 0,
    }]));

    const flagById = new Map(specs.flags.map((s) => [s.id, s]));
    const flagCounts = new Map(flagRows.rows.map((r: any) => [r.key, Number(r.count)]));
    const flags = specs.flags.map((s) => ({
      ...s, count: flagCounts.get(s.id) ?? 0,
      percent: stats.total ? Number(((flagCounts.get(s.id) ?? 0) * 100 / stats.total).toFixed(2)) : 0,
    }));

    const catById = new Map(specs.categories.map((s) => [s.id, s]));
    const catMap = new Map<string, Map<string, number>>();
    for (const row of catRows.rows as any[]) {
      const spec = catById.get(row.key);
      if (!spec) continue;
      if (spec.onlyStatus && spec.onlyStatus !== (row.is_success ? 'success' : 'fail')) continue;
      if (spec.excludeValues?.includes(row.value)) continue;
      const values = catMap.get(row.key) ?? new Map<string, number>();
      const display = row.key === 'messageSuccess' || row.key === 'messageFail'
        ? labelOfMessage(row.value) : row.value;
      values.set(display, (values.get(display) ?? 0) + Number(row.count));
      catMap.set(row.key, values);
    }
    const categories = specs.categories.map((s) => ({
      ...s,
      values: [...(catMap.get(s.id) ?? new Map()).entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
    }));

    const serviceMap = new Map<string, Record<string, number>>();
    for (const row of serviceRows.rows as any[]) {
      const entry = serviceMap.get(row.key) ?? Object.fromEntries(SERVICE_KINDS.map((k: string) => [k, 0]));
      entry[row.value] = Number(row.count);
      serviceMap.set(row.key, entry);
    }
    const services = [...serviceMap.entries()].map(([key, counts]) => ({
      key, label: SERVICE_FA[key] ?? key, counts,
    }));

    const pathCounts = new Map<string, Record<string, number>>();
    for (const row of pathRows.rows as any[]) {
      const entry = pathCounts.get(row.key) ?? {};
      entry[row.value] = Number(row.count);
      pathCounts.set(row.key, entry);
    }
    const paths = specs.paths.map((p) => ({ ...p, kinds: pathCounts.get(p.key) ?? {} }));

    const dailyMap = new Map<string, any>();
    for (const row of dailyTotals.rows as any[]) {
      dailyMap.set(row.day, { day: row.day, total: Number(row.total), success: Number(row.success), fail: Number(row.fail), flags: {} });
    }
    for (const row of dailyFlags.rows as any[]) {
      const entry = dailyMap.get(row.day);
      if (entry) entry.flags[row.key] = Number(row.count);
    }

    return {
      bank: { id: key, label }, from: f, to: t,
      stats: {
        ...stats,
        success_rate: stats.total ? Number((stats.success * 100 / stats.total).toFixed(2)) : 0,
      },
      runs: runRows.rows,
      metrics, counters, flags, categories, services,
      dataQuality: { paths, rotbe: rotbeRows.rows },
      histograms: {
        pd: pdHist.rows.map((r: any) => ({ label: r.bucket, count: Number(r.count) })),
        totalTime: timeHist.rows.map((r: any) => ({ label: r.bucket, count: Number(r.count) })),
        creditBasket: amountHist.rows.map((r: any) => ({ label: r.bucket, count: Number(r.count) })),
      },
      daily: [...dailyMap.values()],
      specs,
      generatedAt: new Date().toISOString(),
    };
  }

  async list(params: {
    bank: string; from?: string; to?: string; indicator?: string; type?: string; id?: string;
    value?: string; status?: string; limit?: number; offset?: number;
  }) {
    const { table } = bankTable(params.bank);
    const { from, to } = rangeOf(params.from, params.to);
    const limit = Math.min(Math.max(Number(params.limit ?? 100) || 100, 1), 100);
    const offset = Math.max(Number(params.offset ?? 0) || 0, 0);
    const sqlParams: any[] = [from, to];
    let type = params.type || 'flag';
    let id = params.id || '';
    let raw = params.indicator || '';

    if (!params.type && raw.includes(':')) {
      const [prefix, ...rest] = raw.split(':');
      if (['flag', 'metric', 'cat', 'service'].includes(prefix)) { type = prefix; id = rest.join(':'); }
    } else if (!params.type && raw) {
      id = raw;
    }
    if (!id && raw === 'slow') { type = 'slow'; id = 'slow'; }
    if (!id && raw === 'creditAlert') { type = 'creditAlert'; id = 'creditAlert'; }

    const add = (value: any) => { sqlParams.push(value); return `$${sqlParams.length}`; };
    let where = '';
    let order = 'inserted_at DESC NULLS LAST, request_id DESC';

    if (type === 'flag' && id) where += ` AND flags->>${add(id)} = 'true'`;
    else if (type === 'cat' && id) {
      where += params.value
        ? ` AND cats->>${add(id)} = ${add(params.value)}`
        : ` AND cats->>${add(id)} IS NOT NULL`;
    } else if (type === 'metric' && id) {
      const col = add(id);
      where += ` AND (metrics->>${col})::double precision IS NOT NULL`;
      order = `(metrics->>${col})::double precision DESC NULLS LAST, request_id DESC`;
    } else if (type === 'service' && id) {
      where += ` AND services->>${add(id)} IS NOT NULL AND services->>${add(id)} <> 'ok'`;
    } else if (type === 'slow') {
      where += ' AND total_time_s > 4';
      order = 'total_time_s DESC NULLS LAST, request_id DESC';
    } else if (type === 'creditAlert') {
      where += ` AND (COALESCE(credit_alerts->>'overdue','false') = 'true'
                  OR COALESCE(credit_alerts->>'cheque','false') = 'true')`;
    } else if (type === 'all') {
      // بدون فیلتر اضافی
    } else if (id) {
      // شناسه ناشناخته: ابتدا بهعنوان flag تلاش میشود
      where += ` AND flags->>${add(id)} = 'true'`;
      type = 'flag';
    }

    if (params.status === 'success' || params.status === 'fail') {
      where += ` AND is_success = ${add(params.status === 'success')}`;
    }
    const limitParam = add(limit);
    const offsetParam = add(offset);

    const result = await this.db.query(
      `SELECT COUNT(*) OVER() AS total_count,
        request_id, day, inserted_at, is_success, model_name, status_code, error_code, message_key,
        total_time_s, pd, suggested_amount, amount_kind, score_req, flags, cats, credit_alerts
       FROM ${table}
       WHERE day BETWEEN $1 AND $2 ${where}
       ORDER BY ${order}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      sqlParams,
    );
    const rows = result.rows.map((r: any) => ({
      ...r,
      total_count: Number(r.total_count),
      true_flags: Object.entries(r.flags || {}).filter(([, v]) => v === true).map(([k]) => k),
    }));
    return {
      bank: params.bank, from, to, type, id, value: params.value ?? null,
      limit, offset, total: rows[0]?.total_count ?? 0, rows,
    };
  }

  async sample(requestId: string, req: any) {
    const url = new URL(config.apiBaseUrl);
    url.searchParams.set('page', '1');
    url.searchParams.set('limit', '1');
    url.searchParams.set('requestId', requestId);
    const response = await fetch(url.toString(), {
      headers: {
        'gateway-system': config.apiSystem,
        'gateway-token': config.apiToken,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`API اصلی پاسخ نداد: HTTP ${response.status}`);
    const body: any = await response.json();
    const data = body?.data ?? body;
    const raw = data?.reportResults?.[0] ?? data?.reports?.[0] ?? null;
    await this.db.query(
      'INSERT INTO sample_access_logs(request_id, ip, user_agent) VALUES($1,$2,$3)',
      [requestId, req?.ip ?? null, String(req?.headers?.['user-agent'] ?? '').slice(0, 500)],
    ).catch(() => undefined);
    return {
      requestId,
      found: !!raw,
      fetchedAt: new Date().toISOString(),
      sample: raw ? redactSensitive(raw) : null,
      note: 'جزئیات فقط در لحظه از API اصلی گرفته میشود و در دیتابیس جانبی ذخیره نمیشود.',
    };
  }

  async runs() {
    const result = await this.db.query('SELECT * FROM day_runs ORDER BY day DESC, bank LIMIT 200');
    return result.rows;
  }
}
