import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { EvaluatorService } from '../evaluator/evaluator.service';
import { BANKS, BankKey, config } from '../config';
import { defaultRange, normalizeDay } from '../utils/date';

/* همهٔ شمارشها/چارکها/درصدها دقیقاً با newStats()/bump() قدیمی ساخته میشوند؛
   SQL فقط برای فهرست، صفحهبندی و روزها استفاده میشود (تصمیم legacy_bump). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { newStats, bump } = require('../evaluator/legacy/src/analyze');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { record, compareReviewRows, nf, SERVICE_FA } = require('../evaluator/legacy/src/common');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { quantile } = require('../legacy-report/render');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildReport } = require('../legacy-report/report-builder');

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

function asObject(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function redactSensitive(value: any, key = ''): any {
  if (value === null || typeof value !== 'object') return value;
  if (/sourceip/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, key));
  const out: Record<string, any> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/sourceip/i.test(childKey)) continue;
    out[childKey] = redactSensitive(childValue, childKey);
  }
  return out;
}

function stampOfRow(row: any) {
  const stored = asObject(asObject(row.display_extras).stamp);
  const day = String(row.day || '');
  if (stored && typeof stored.key === 'string' && stored.key) {
    return {
      key: stored.key,
      display: String(stored.display ?? day.replace(/-/g, '/')),
      rowDisplay: String(stored.rowDisplay ?? day.replace(/-/g, '/')),
    };
  }
  const display = day.replace(/-/g, '/');
  return { key: `${day.replace(/\D/g, '').padEnd(17, '0')}`, display, rowDisplay: `${display} —:—` };
}

function baseOfRow(row: any, stamp: any): Record<string, any> {
  const stored = asObject(asObject(row.display_extras).base);
  if (stored && Object.keys(stored).length) {
    return {
      ...stored,
      uniqueKey: stored.uniqueKey ?? row.unique_key ?? '—',
      requestId: stored.requestId ?? row.request_id,
    };
  }
  const ability = num(row.suggested_amount);
  return {
    uniqueKey: row.unique_key ?? '—',
    requestId: row.request_id,
    'تاریخ و ساعت': stamp.rowDisplay,
    'وضعیت': row.is_success ? 'موفق' : 'ناموفق',
    model_name: row.model_name ?? '—',
    PD: row.pd == null ? '—' : String(row.pd),
    'توان بازپرداخت (ریال)': ability == null ? '—' : nf(ability),
  };
}

@Injectable()
export class SummaryService {
  constructor(private db: DatabaseService, private evaluator: EvaluatorService) {}

  banks() {
    return Object.entries(BANKS).map(([id, bank]) => ({ id, label: bank.label, method: bank.method }));
  }

  specs(bankInput: string) {
    bankTable(bankInput);
    return this.evaluator.specs(bankInput);
  }

  private emptyData(cap: number) {
    return {
      groups: (() => {
        const groups = record();
        groups.ALL = newStats();
        groups.success = newStats();
        groups.fail = newStats();
        return groups;
      })(),
      details: record(),
      flags: record(),
      lists: record(),
      serviceRows: record(),
      categoryRows: record(),
      timeReview: { total: 0, byStatus: { success: 0, fail: 0 }, rows: [] as any[] },
      creditAlerts: { total: 0, overdue: 0, cheque: 0, both: 0, overdueRows: [] as any[], chequeRows: [] as any[] },
      ranges: { first: null as any, last: null as any },
      evaluatorErrors: record(),
      runtimeErrors: [] as any[],
      processedFiles: 0,
      processedSamples: 0,
      __cap: cap,
    };
  }

  private consumeRow(row: any, state: any) {
    const { bank, selectedServices, cap, messageText } = state;
    const data = state.data;
    const status: 'success' | 'fail' = row.is_success ? 'success' : 'fail';
    const order = state.sequence++;
    const stamp = stampOfRow(row);
    const extras = asObject(row.display_extras);
    const base = baseOfRow(row, stamp);
    state.badReports += Number(extras.badReports ?? 0);

    if (!data.ranges.first || String(stamp.key) < String(data.ranges.first.key)) data.ranges.first = stamp;
    if (!data.ranges.last || String(stamp.key) > String(data.ranges.last.key)) data.ranges.last = stamp;

    const restoreCategory = (id: string, value: any) => {
      if (id === 'messageSuccess' || id === 'messageFail') {
        const key = String(value);
        return messageText.get(key) || 'سایر پیامها';
      }
      return String(value);
    };
    const catsInput = asObject(row.cats);
    const categories: Record<string, string> = {};
    for (const [id, value] of Object.entries(catsInput)) {
      if (!bank.catById[id]) continue;
      categories[id] = restoreCategory(id, value);
    }
    const metricsInput = asObject(row.metrics);
    const metrics: Record<string, number | null> = {};
    for (const [id, value] of Object.entries(metricsInput)) {
      const n = num(value);
      metrics[id] = n === null ? null : n;
    }
    const countersInput = asObject(row.counters);
    const counters: Record<string, number> = {};
    for (const [id, value] of Object.entries(countersInput)) counters[id] = num(value) ?? 0;
    const flags = asObject(row.flags);
    const paths = asObject(row.paths);
    const servicesInput = asObject(row.services);
    const services: Record<string, any> = {};
    for (const key of selectedServices) {
      services[key] = servicesInput[key] && typeof servicesInput[key] === 'object'
        ? servicesInput[key] : { kind: 'missingService' };
    }
    const risk = asObject(row.credit_alerts);
    const hasOverdue = !!risk.overdue?.bool;
    const hasCheque = !!risk.cheque?.bool;
    const result: any = {
      flags,
      categories,
      counters,
      metrics,
      pathKinds: paths,
      services,
      rotbe: row.rotbe ?? null,
      creditAlerts: { overdue: hasOverdue ? {} : null, cheque: hasCheque ? {} : null },
    };

    bump(data.groups.ALL, bank, result, status, selectedServices, false);
    bump(data.groups[status], bank, result, status, selectedServices, false);
    const dayKey = `day:${row.day}`;
    data.groups[dayKey] ||= newStats();
    bump(data.groups[dayKey], bank, result, status, selectedServices, true);

    const retainRanked = (rows: any[], rank: any, sequence: number, makeRow: () => any) => {
      if (rows.length >= cap
        && compareReviewRows({ __rank: rank, __order: sequence }, rows[rows.length - 1]) >= 0) return;
      rows.push(makeRow());
      rows.sort(compareReviewRows);
      if (rows.length > cap) rows.pop();
    };
    const withSid = (source: Record<string, any>) => ({
      ...source,
      __sid: row.request_id,
      __st: status,
      __order: order,
    });

    if (hasOverdue || hasCheque) {
      data.creditAlerts.total++;
      if (hasOverdue && hasCheque) data.creditAlerts.both++;
      const riskBase = withSid({ ...base });
      const alertRows = asObject(extras.creditAlertRows);
      if (hasOverdue) {
        data.creditAlerts.overdue++;
        if (data.creditAlerts.overdueRows.length < cap) data.creditAlerts.overdueRows.push({
          ...riskBase, ...asObject(alertRows.overdue),
        });
      }
      if (hasCheque) {
        data.creditAlerts.cheque++;
        if (data.creditAlerts.chequeRows.length < cap) data.creditAlerts.chequeRows.push({
          ...riskBase, ...asObject(alertRows.cheque),
        });
      }
    }

    const totalTime = num(row.total_time_s);
    if (totalTime !== null && totalTime > 4) {
      data.timeReview.total++;
      data.timeReview.byStatus[status]++;
      retainRanked(data.timeReview.rows, totalTime, order, () => ({
        ...withSid(base), __rank: totalTime, 'زمان اجرای مدل (ثانیه)': nf(totalTime),
      }));
    }

    for (const spec of bank.categories) {
      const value = categories[spec.id];
      if (!(spec.inspectAll || spec.inspectValues?.includes(value))
        || spec.excludeValues?.includes(value) || spec.inspectExcept?.includes(value)
        || (spec.onlyStatus && spec.onlyStatus !== status)) continue;
      const entryMap = data.categoryRows[spec.id] ||= record();
      const entry = entryMap[value] ||= {
        total: 0, byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } },
      };
      entry.total++;
      const bucket = entry.byStatus[status];
      bucket.total++;
      if (bucket.rows.length < cap) {
        const extra = asObject(asObject(extras.catRows)[spec.id]);
        bucket.rows.push(withSid({ ...base, ...extra }));
      }
    }

    for (const spec of bank.flags) {
      if (!result.flags[spec.id] || spec.inspect === false) continue;
      const entry = data.flags[spec.id] ||= {
        total: 0, byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } },
      };
      entry.total++;
      const bucket = entry.byStatus[status];
      bucket.total++;
      const extra = asObject(asObject(extras.flagRows)[spec.id]);
      const makeRow = () => spec.sortValue
        ? { ...withSid({ ...base, ...extra }), __rank: asObject(extras.ranks)[spec.id] ?? null }
        : withSid({ ...base, ...extra });
      if (spec.sortValue) {
        retainRanked(bucket.rows, asObject(extras.ranks)[spec.id] ?? null, order, makeRow);
      } else if (bucket.rows.length < cap) bucket.rows.push(makeRow());
    }

    bank.lists.forEach((spec: any, index: number) => {
      const matches = Array.isArray(extras.listMatches) ? !!extras.listMatches[index] : false;
      if (!matches) return;
      const entry = data.lists[index] ||= { total: 0, rows: [] };
      const listRows = asObject(extras.listRows);
      const extra = asObject(listRows[String(index)] ?? listRows[index]);
      entry.rows.push(withSid({ ...base, ...extra }));
      entry.total++;
    });

    const serviceStates = asObject(extras.serviceStates);
    for (const key of selectedServices) {
      const kind = services[key]?.kind ?? 'missingService';
      if (['ok', 'failed', 'other'].includes(kind)) continue;
      const entry = data.serviceRows[key] ||= {
        total: 0, byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } },
      };
      entry.total++;
      const bucket = entry.byStatus[status];
      bucket.total++;
      if (bucket.rows.length < cap) {
        const stateInfo = asObject(serviceStates[key]);
        bucket.rows.push({
          __sid: row.request_id,
          __st: status,
          __order: order,
          'نوع نقص': stateInfo.reason || 'وضعیت سرویس نامشخص',
          'مسیر': `ai_input.${key}.status`,
          uniqueKey: base.uniqueKey ?? '—',
          requestId: base.requestId ?? row.request_id,
          'تاریخ و ساعت': stamp.rowDisplay,
          'وضعیت': status === 'success' ? 'موفق' : 'ناموفق',
        });
      }
    }
  }

  private async buildDashboard(bankInput: string, from?: string, to?: string, rowsCap = 100) {
    const { key, table } = bankTable(bankInput);
    const { from: f, to: t } = rangeOf(from, to);
    const cap = Math.min(Math.max(Number(rowsCap) || 100, 1), 100);
    const bank = this.evaluator.getBank(key);
    const selectedServices = this.evaluator.getSelectedServices(key);

    const [countRes, daysRes, runsRes, dictRes] = await Promise.all([
      this.db.query(`SELECT COUNT(*)::int AS total FROM ${table} WHERE day BETWEEN $1 AND $2`, [f, t]),
      this.db.query(`SELECT DISTINCT day FROM ${table} WHERE day BETWEEN $1 AND $2 ORDER BY day`, [f, t]),
      this.db.query('SELECT * FROM day_runs WHERE bank=$1 AND day BETWEEN $2 AND $3 ORDER BY day DESC', [key, f, t]),
      this.db.query("SELECT message_key, COALESCE(message_text, label, 'سایر پیامها') AS text FROM message_dict"),
    ]);
    const totalSamples = Number(countRes.rows[0]?.total ?? 0);
    const selectedDays: string[] = daysRes.rows.map((r: any) => String(r.day));
    const messageText = new Map<string, string>(
      dictRes.rows.map((r: any) => [String(r.message_key), String(r.text)]),
    );
    const data = this.emptyData(cap);
    data.processedFiles = runsRes.rowCount || 0;
    data.runtimeErrors = runsRes.rows
      .filter((r: any) => r.status === 'failed')
      .map((r: any) => ({ file: String(r.day), error: String(r.error ?? 'خطای اجرا') }));

    const state = { bank, selectedServices, cap, messageText, data, sequence: 0, badReports: 0 };
    let cursor = ['', '', ''];
    const pageSize = 1000;
    for (;;) {
      const batch = await this.db.query(
        `SELECT * FROM ${table}
         WHERE day BETWEEN $1 AND $2
           AND (day, COALESCE(stamp_key, ''), request_id) > ($3::text, $4::text, $5::text)
         ORDER BY day, COALESCE(stamp_key, ''), request_id
         LIMIT $6`,
        [f, t, cursor[0], cursor[1], cursor[2], pageSize],
      );
      const rows = batch.rows as any[];
      if (!rows.length) break;
      for (const row of rows) this.consumeRow(row, state);
      const last = rows[rows.length - 1];
      cursor = [String(last.day || ''), String(last.stamp_key || ''), String(last.request_id || '')];
      if (rows.length < pageSize) break;
    }
    data.processedSamples = state.sequence;

    const badReports = state.badReports;
    const renderBank = {
      ...bank,
      topics: bank.topics.map((topic: any) => key === 'tavan_mellat' && topic.id === 'deposit' ? {
        ...topic,
        extraHtml: () => !badReports ? '' : `<div class="alert"><strong>نیاز به بررسی تاریخ سپرده:</strong> در ${badReports} گزارش، دستکم یک تاریخ ماه سپرده قابل خواندن نبود. سالوماه (مانند <code>140309</code>) یا سالوماهروز (مانند <code>14030930</code>) پذیرفته میشود؛ مقدارهای خام فقط در پنجرهٔ جزئیات همان گزارش، پس از دریافت از API اصلی، در دسترساند.</div>`,
      } : topic),
    };
    const scan = {
      root: 'database', days: selectedDays, files: [], errors: [], totalSamples, invalidSamples: 0,
      methodCounts: new Map<string, number>(), selectedMethod: bank.key, bank: renderBank,
      selectedFiles: [], selectedDays, selectedServices, ignoredRows: [],
    };
    const latestRun = runsRes.rows[0];
    const controls = {
      action: '/', bank: key, from: f, to: t, rowsCap: cap,
      banks: this.banks(),
      status: latestRun?.status ?? '',
      updatedAt: latestRun?.updated_at ? new Date(latestRun.updated_at).toISOString() : '',
    };
    return { scan, data, options: { rowsCap: cap, controls } };
  }

  async report(bankInput: string, from?: string, to?: string, rowsCap = 100): Promise<string> {
    const built = await this.buildDashboard(bankInput, from, to, rowsCap);
    delete (built.data as any).__cap;
    return buildReport(built.scan, built.data, built.options);
  }

  async summary(bankInput: string, from?: string, to?: string) {
    const { key, label } = bankTable(bankInput);
    const { from: f, to: t } = rangeOf(from, to);
    const built = await this.buildDashboard(bankInput, f, t, 100);
    delete (built.data as any).__cap;
    const all = built.data.groups.ALL;
    const specs = this.evaluator.specs(key);
    const metrics: Record<string, any> = {};
    for (const [id, values] of Object.entries(all.metrics as Record<string, number[]>)) {
      const sorted = [...(values || [])].sort((a, b) => a - b);
      const spec = specs.metrics.find((s: any) => s.id === id);
      metrics[id] = {
        id,
        label: spec?.label ?? id,
        count: sorted.length,
        min: sorted[0] ?? null,
        p25: quantile(sorted, 0.25),
        median: quantile(sorted, 0.5),
        mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
        p75: quantile(sorted, 0.75),
        max: sorted.length ? sorted[sorted.length - 1] : null,
      };
    }
    return {
      bank: { id: key, label }, from: f, to: t,
      stats: {
        total: all.total, success: all.byStatus.success, fail: all.byStatus.fail,
        days: built.scan.selectedDays.length,
        success_rate: all.total ? Number((all.byStatus.success * 100 / all.total).toFixed(2)) : 0,
      },
      flags: Object.fromEntries(Object.entries(all.flags).map(([id, count]) => [id, Number(count)])),
      counters: Object.fromEntries(Object.entries(all.counters).map(([id, count]) => [id, Number(count)])),
      categories: Object.fromEntries(Object.entries(all.cats).map(([id, values]) => [id,
        Object.entries(values as Record<string, number>).map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count),
      ])),
      services: Object.fromEntries(Object.entries(all.services).map(([id, counts]) => [id, {
        id, label: SERVICE_FA[id] ?? id, counts,
      }])),
      paths: Object.fromEntries(Object.entries(all.paths).map(([id, entry]) => [id, entry])),
      metrics,
      daily: built.scan.selectedDays.map((day) => {
        const stats = built.data.groups[`day:${day}`];
        return { day, total: stats?.total ?? 0, success: stats?.byStatus.success ?? 0, fail: stats?.byStatus.fail ?? 0,
          flags: stats?.flags ?? {} };
      }),
      runs: await this.runs(),
      specs,
      generatedAt: new Date().toISOString(),
      source: 'legacy_bump',
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
    } else if (!params.type && raw) id = raw;
    if (!id && raw === 'slow') { type = 'slow'; id = 'slow'; }
    if (!id && raw === 'creditAlert') { type = 'creditAlert'; id = 'creditAlert'; }

    const add = (value: any) => { sqlParams.push(value); return `$${sqlParams.length}`; };
    let where = '';
    let order = 'day, COALESCE(stamp_key, \'\'), request_id';

    if (type === 'flag' && id) where += ` AND flags->>${add(id)} = 'true'`;
    else if (type === 'cat' && id) {
      where += params.value
        ? ` AND cats->>${add(id)} = ${add(params.value)}`
        : ` AND cats->>${add(id)} IS NOT NULL`;
    } else if (type === 'metric' && id) {
      const col = add(id);
      where += ` AND (metrics->>${col})::double precision IS NOT NULL`;
      order = `(metrics->>${col})::double precision DESC NULLS LAST, request_id`;
    } else if (type === 'service' && id) {
      where += ` AND services->>${add(id)} IS NOT NULL AND services->>${add(id)} <> 'ok'`;
    } else if (type === 'slow') {
      where += ' AND total_time_s > 4';
      order = 'total_time_s DESC NULLS LAST, request_id';
    } else if (type === 'creditAlert') {
      where += ` AND (COALESCE(credit_alerts->'overdue'->>'bool','false') = 'true'
                  OR COALESCE(credit_alerts->'cheque'->>'bool','false') = 'true')`;
    } else if (type === 'all') {
      // بدون فیلتر اضافی
    } else if (id) {
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
        request_id, unique_key, day, inserted_at, stamp_key, is_success, model_name, status_code, error_code,
        message_key, total_time_s, pd, suggested_amount, amount_kind, score_req, flags, cats, credit_alerts
       FROM ${table}
       WHERE day BETWEEN $1 AND $2 ${where}
       ORDER BY ${order}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      sqlParams,
    );
    const rows = result.rows.map((r: any) => ({
      ...r,
      sid: r.request_id,
      total_count: Number(r.total_count),
      true_flags: Object.entries(asObject(r.flags)).filter(([, v]) => v === true).map(([k]) => k),
    }));
    return { bank: params.bank, from, to, type, id, value: params.value ?? null,
      limit, offset, total: rows[0]?.total_count ?? 0, rows };
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

    if (!raw) return { requestId, found: false, fetchedAt: new Date().toISOString(), meta: {}, sample: null };
    const normalized = this.evaluator.normalizeSample(raw);
    const inferredBank = this.evaluator.bankKeyOfSample(normalized);
    const stored = await this.db.query(
      `SELECT 'tavan_mellat'::text AS bank, day, is_success, unique_key FROM samples_mellat WHERE request_id=$1
       UNION ALL SELECT 'tavan_resalat'::text, day, is_success, unique_key FROM samples_resalat WHERE request_id=$1
       UNION ALL SELECT 'tavan_postbank'::text, day, is_success, unique_key FROM samples_postbank WHERE request_id=$1
       LIMIT 1`, [requestId],
    ).catch(() => ({ rows: [] as any[] }));
    const row = stored.rows[0];
    const bankKey = String(row?.bank || inferredBank);
    const status = row ? (row.is_success ? 'success' : 'fail') : (this.evaluator.isReportSuccess(normalized) ? 'success' : 'fail');
    const legacy = this.evaluator.analyzeLegacy(normalized, status === 'success', bankKey);
    const bank = this.evaluator.getBank(bankKey);
    const get = require('../evaluator/legacy/banks/_helpers').get;
    const uniqueKey = row?.unique_key ?? get(normalized, 'input.uniqueKey') ?? '—';
    const national = get(normalized, 'input.data.nationalCode');
    let safeSample = normalized;
    try { if (bank.sanitizeSample) safeSample = bank.sanitizeSample(normalized); } catch { safeSample = normalized; }
    let viewer;
    try { if (bank.viewer) viewer = bank.viewer(legacy.collected, normalized); } catch { viewer = undefined; }
    const meta: Record<string, any> = {
      bank: bank.label,
      method: bank.id,
      methodKey: bank.key,
      day: row?.day ?? '',
      status,
      uniqueKey,
      requestId,
      flags: bank.flags.filter((spec: any) => legacy.flags[spec.id]).map((spec: any) => spec.label),
      ...(bank.key === 'tavan_resalat' || bank.key === 'tavan_postbank'
        ? { nationalCode: String(national ?? '').trim() || 'ثبت نشده' } : {}),
      ...(viewer ? { viewer } : {}),
      ...(legacy.creditAlerts?.overdue || legacy.creditAlerts?.cheque ? { creditAlerts: legacy.creditAlerts } : {}),
    };
    return {
      requestId,
      found: true,
      fetchedAt: new Date().toISOString(),
      meta,
      sample: redactSensitive(safeSample),
      note: 'جزئیات فقط در لحظه از API اصلی گرفته میشود و در دیتابیس جانبی ذخیره نمیشود.',
    };
  }

  /** صفحهٔ خطای خوانا بهجای پاس دادن JSON خام 500 به مرورگر. */
  errorHtml(error: any): string {
    const escape = (value: any) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const message = escape(String(error?.message ?? error).slice(0, 1200));
    const databaseUrl = process.env.DATABASE_URL ? 'تنظیم شده' : 'تنظیم نشده';
    return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>داشبورد زنده در دسترس نیست</title><style>
      body{margin:0;background:#f3f6f8;color:#1a2935;font:14px/1.9 Tahoma,"Segoe UI",sans-serif;padding:40px}
      main{max-width:820px;margin:auto;background:#fff;border:1px solid #dfe7e9;border-radius:16px;padding:28px 32px;box-shadow:0 14px 36px rgba(20,52,64,.06)}
      h1{color:#af711e;font-size:22px;margin:0 0 12px}p{color:#627484}code,pre{direction:ltr;text-align:left;background:#f7f9fa;border:1px solid #ebeff0;border-radius:8px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}
      ul{line-height:2}a{color:#087b72;font-weight:700}.badge{display:inline-block;background:#fff5e3;color:#af711e;border-radius:8px;padding:2px 10px;font-size:12px}
    </style></head><body><main><span class="badge">HTTP 503</span><h1>صفحهٔ زنده ساخته نشد</h1>
      <p>بکاند در دسترس است، ولی هنگام خواندن دیتابیس جانبی یا ساخت گزارش خطا داد. متن فنی:</p>
      <pre>${message}</pre>
      <p><b>وضعیت متغیرها:</b> <code>DATABASE_URL</code>=${escape(databaseUrl)} · بکاند روی پورت <code>${escape(config.backendPort)}</code> · API اصلی <code dir="ltr">${escape(config.apiBaseUrl)}</code></p>
      <p>چکلیست:</p><ul>
        <li><code>cp backend/.env.example backend/.env</code> و تنظیم <code>DATABASE_URL</code> واقعی</li>
        <li><code>./migrate.sh</code> برای ساخت <code>day_runs</code> و <code>samples_*</code></li>
        <li><code>./ingest.sh --bank=tavan_resalat --mode=nightly</code> یا همان بانک انتخابی</li>
        <li><code>./start.sh</code> و بررسی <code>BACKEND_URL</code> در <code>frontend/.env.local</code></li>
      </ul>
      <p><a href="/api/diagnostics">گزارش تشخیصی دیتابیس</a> · <a href="/">تلاش دوباره</a></p>
    </main></body></html>`;
  }

  /** وضعیت اتصال و جداول، بدون افشای رمز عبور یا توکن. */
  async diagnostics() {
    const tables = ['day_runs', 'samples_mellat', 'samples_resalat', 'samples_postbank',
      'message_dict', 'sample_access_logs'];
    const result: Record<string, any> = {
      ok: false,
      generatedAt: new Date().toISOString(),
      databaseUrlConfigured: !!process.env.DATABASE_URL,
      apiBaseUrlConfigured: !!process.env.CE_API_BASE_URL,
      apiTokenConfigured: !!config.apiToken,
      backendPort: config.backendPort,
      banks: Object.keys(BANKS),
      databaseConnected: false,
      tables: {},
      counts: {},
      hints: [],
    };
    try {
      const probe = await this.db.query('SELECT 1 AS ok');
      result.databaseConnected = Number(probe.rows[0]?.ok) === 1;
    } catch (error) {
      result.databaseError = String((error as any)?.message ?? error).slice(0, 500);
      result.hints.push('اتصال PostgreSQL برقرار نشد؛ DATABASE_URL، دسترسی شبکهای و روشن بودن سرویس را بررسی کن.');
    }
    for (const table of tables) {
      try {
        const found = await this.db.query(
          "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
          [table],
        );
        result.tables[table] = Number(found.rows[0]?.count) > 0;
        if (result.tables[table] && !table.startsWith('samples_')) {
          const count = await this.db.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
          result.counts[table] = Number(count.rows[0]?.count ?? 0);
        }
      } catch (error) {
        result.tables[table] = false;
      }
    }
    for (const table of tables.filter((x) => x.startsWith('samples_'))) {
      if (!result.tables[table]) continue;
      try {
        const count = await this.db.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
        result.counts[table] = Number(count.rows[0]?.count ?? 0);
      } catch { /* جدول وجود دارد ولی قابل خواندن نیست */ }
    }
    if (Object.values(result.tables).some((exists) => !exists)) result.hints.push('برخی جداول ساخته نشدهاند؛ ./migrate.sh را اجرا کن.');
    if (Object.values(result.counts).every((count) => Number(count) === 0)) result.hints.push('جداول خالیاند؛ Ingestion اجرا نشده است.');
    result.ok = result.databaseConnected && Object.values(result.tables).every(Boolean);
    return result;
  }

  async runs() {
    const result = await this.db.query('SELECT * FROM day_runs ORDER BY day DESC, bank LIMIT 200');
    return result.rows;
  }
}
