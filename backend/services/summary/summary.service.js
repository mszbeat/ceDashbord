'use strict';
const { BANKS, config, resolveBankApiUrl, resolveBankGatewayConfig, bankUsesGateway } = require('../config');
const { fetchBankJson } = require('../http/gateway-client');
const { error: summaryError } = require('../../controllers/summaryController/config');
const { error: ceError } = require('../../controllers/creditEvaluationController/config');
const { defaultRange, jalaliStampDigitsOf, normalizeDay } = require('../utils/date');
const { newStats, bump, stampOf } = require('../evaluator/legacy/src/analyze');
const { record, compareReviewRows, nf, SERVICE_FA } = require('../evaluator/legacy/src/common');
const { get } = require('../evaluator/legacy/banks/_helpers');
const { quantile } = require('../legacy-report/render');
const { getVazirmatnFontCss } = require('../legacy-report/font-face');
const { getActionLogger } = require('../logger/action-logger.service');
const { buildReport } = require('../legacy-report/report-builder');
const createV1Dialect = require('../db/dialect-v1-session');
const { StatsCache } = require('./stats-cache');

function rangeOf(from, to) {
  const fallback = defaultRange(30);
  return { from: normalizeDay(from || fallback.from), to: normalizeDay(to || fallback.to) };
}

function bankTable(bankInput) {
  const key = bankInput;
  const bank = BANKS[key];
  if (!bank) throw summaryError.unsupportedBank(bankInput);
  return { key, table: bank.table, label: bank.label };
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * ۳-الف — یک‌شکل‌سازی ردیف فهرست: `sid` تضمین‌شده و `true_flags` به‌صورت آرایه.
 * برای هر دو کلید `rows` و `items` استفاده می‌شود (یک بار ساخته می‌شود، نه دو بار).
 */
function normalizeRows(rows) {
  return rows.map((row) => (Array.isArray(row.true_flags) ? row : {
    ...row,
    sid: row.sid ?? row.request_id,
    true_flags: Object.entries(asObject(row.flags))
      .filter(([, v]) => v === true)
      .map(([k]) => k),
  }));
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function redactSensitive(value, key = '') {
  if (value === null || typeof value !== 'object') return value;
  if (/sourceip/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, key));
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/sourceip/i.test(childKey)) continue;
    out[childKey] = redactSensitive(childValue, childKey);
  }
  return out;
}

function stampOfRow(row) {
  const stored = asObject(asObject(row.display_extras).stamp);
  const day = String(row.day || '');
  const displayDate = day.replace(/-/g, '/');
  if (
    stored &&
    typeof stored.key === 'string' &&
    /^1[34]\d{2}/.test(stored.key) &&
    String(stored.display ?? '').includes(':')
  ) {
    return {
      key: stored.key,
      display: String(stored.display),
      rowDisplay: String(stored.rowDisplay ?? stored.display),
    };
  }
  for (const candidate of [row.inserted_at, row.stamp_key, stored?.key]) {
    const digits = jalaliStampDigitsOf(candidate);
    if (!digits) continue;
    const rebuilt = stampOf({ insertDate_full: digits }, day);
    if (String(rebuilt.display).includes(':')) {
      const validRowKey =
        typeof row.stamp_key === 'string' && /^1[34]\d{2}/.test(row.stamp_key)
          ? row.stamp_key
          : rebuilt.key;
      return { key: String(validRowKey), display: rebuilt.display, rowDisplay: rebuilt.rowDisplay };
    }
  }
  const validStoredDisplay =
    typeof stored?.display === 'string' && /^1[34]\d{2}/.test(stored.display)
      ? stored.display
      : displayDate;
  const validStoredKey =
    typeof stored?.key === 'string' && /^1[34]\d{2}/.test(stored.key)
      ? stored.key
      : `${day.replace(/\D/g, '').padEnd(17, '0')}`;
  return {
    key: String(validStoredKey),
    display: validStoredDisplay,
    rowDisplay: `${validStoredDisplay} —:—`,
  };
}

function baseOfRow(row, stamp) {
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
    وضعیت: row.is_success ? 'موفق' : 'ناموفق',
    model_name: row.model_name ?? '—',
    PD: row.pd == null ? '—' : String(row.pd),
    'توان بازپرداخت (ریال)': ability == null ? '—' : nf(ability),
  };
}

/**
 * ماسک IP برای ثبت دسترسی (D2): آخرین جزء IPv4 و ابتدای IPv6 حذف می‌شود تا نشانی کامل
 * ذخیره نشود (همان سیاست «sourceip حذف/ماسک»).
 */
function maskIp(ip) {
  const text = String(ip ?? '').trim();
  if (!text) return null;
  if (text.includes(':')) {
    const parts = text.split(':').filter(Boolean);
    return `${parts.slice(0, 2).join(':')}::`;
  }
  const parts = text.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  return text.slice(0, 3) + '…';
}

class SummaryService {
  /**
   * @param {object} db آداپتور دیتابیس (query/getClient)
   * @param {object} evaluator
   * @param {{dialect?: object}} options
   *   `dialect` قراداد دسترسی به داده است: `dialect-v1` (jsonb فعلی) یا `dialect-v2`.
   *   با نبودنش، رفتار دقیقاً همان v1 قبلی است.
   */
  constructor(db, evaluator, options = {}) {
    this.db = db;
    this.evaluator = evaluator;
    this.dialect = options.dialect || createV1Dialect(db);
    this.cache = options.cache || new StatsCache(options.cacheOptions || {});
    /**
     * سقف بازه (روز) — از `CE_MAX_RANGE_DAYS`؛ عبور از آن خطای ۴۱۳ می‌دهد
     * تا یک درخواست نتواند کل تاریخچه را اسکن کند.
     */
    this.maxRangeDays = options.maxRangeDays ?? Number(process.env.CE_MAX_RANGE_DAYS || 400);
  }

  /** فاصلهٔ روزهای شمسی بازه (تقریبی، برای گارد سقف بازه) */
  rangeLengthDays(from, to) {
    const parse = (day) => {
      const [y, m, d] = String(day).split('-').map(Number);
      return y * 372 + m * 31 + d;
    };
    return Math.max(0, parse(to) - parse(from));
  }

  banks() {
    return Object.entries(BANKS).map(([id, bank]) => ({ id, label: bank.label, method: bank.method }));
  }

  specs(bankInput) {
    bankTable(bankInput);
    return this.evaluator.specs(bankInput);
  }

  emptyData(cap) {
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
      timeReview: { total: 0, byStatus: { success: 0, fail: 0 }, rows: [] },
      creditAlerts: { total: 0, overdue: 0, cheque: 0, both: 0, overdueRows: [], chequeRows: [] },
      ranges: { first: null, last: null },
      evaluatorErrors: record(),
      runtimeErrors: [],
      processedFiles: 0,
      processedSamples: 0,
      __cap: cap,
    };
  }

  consumeRow(row, state) {
    const { bank, selectedServices, cap, messageText } = state;
    const data = state.data;
    const status = row.is_success ? 'success' : 'fail';
    const order = state.sequence++;
    const stamp = stampOfRow(row);
    const extras = asObject(row.display_extras);
    const base = baseOfRow(row, stamp);
    state.badReports += Number(extras.badReports ?? 0);

    if (!data.ranges.first || String(stamp.key) < String(data.ranges.first.key)) data.ranges.first = stamp;
    if (!data.ranges.last || String(stamp.key) > String(data.ranges.last.key)) data.ranges.last = stamp;

    const restoreCategory = (id, value) => {
      if (id === 'messageSuccess' || id === 'messageFail') {
        const key = String(value);
        const text = messageText.get(key);
        if (text) return text;
        // پیام‌هایی که در `message_dict` متن ندارند (مثلاً دیکشنری خالی در تست) → سایر پیام‌ها
        return 'سایر پیامها';
      }
      return String(value);
    };
    const catsInput = asObject(row.cats);
    const categories = {};
    for (const [id, value] of Object.entries(catsInput)) {
      if (!bank.catById[id]) continue;
      categories[id] = restoreCategory(id, value);
    }
    const metricsInput = asObject(row.metrics);
    const metrics = {};
    for (const [id, value] of Object.entries(metricsInput)) {
      const n = num(value);
      metrics[id] = n === null ? null : n;
    }
    const countersInput = asObject(row.counters);
    const counters = {};
    for (const [id, value] of Object.entries(countersInput)) counters[id] = num(value) ?? 0;
    const flags = asObject(row.flags);
    const paths = asObject(row.paths);
    const servicesInput = asObject(row.services);
    const services = {};
    for (const key of selectedServices) {
      const raw = servicesInput[key];
      services[key] =
        typeof raw === 'string'
          ? { kind: raw }
          : raw && typeof raw === 'object'
            ? raw
            : { kind: 'missingService' };
    }
    const risk = asObject(row.credit_alerts);
    const hasOverdue = !!risk.overdue?.bool;
    const hasCheque = !!risk.cheque?.bool;
    const result = {
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

    const retainRanked = (rows, rank, sequence, makeRow) => {
      if (
        rows.length >= cap &&
        compareReviewRows({ __rank: rank, __order: sequence }, rows[rows.length - 1]) >= 0
      ) {
        return;
      }
      rows.push(makeRow());
      rows.sort(compareReviewRows);
      if (rows.length > cap) rows.pop();
    };
    const withSid = (source) => ({
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
        if (data.creditAlerts.overdueRows.length < cap) {
          data.creditAlerts.overdueRows.push({ ...riskBase, ...asObject(alertRows.overdue) });
        }
      }
      if (hasCheque) {
        data.creditAlerts.cheque++;
        if (data.creditAlerts.chequeRows.length < cap) {
          data.creditAlerts.chequeRows.push({ ...riskBase, ...asObject(alertRows.cheque) });
        }
      }
    }

    const totalTime = num(row.total_time_s);
    if (totalTime !== null && totalTime > 4) {
      data.timeReview.total++;
      data.timeReview.byStatus[status]++;
      retainRanked(data.timeReview.rows, totalTime, order, () => ({
        ...withSid(base),
        __rank: totalTime,
        'زمان اجرای مدل (ثانیه)': nf(totalTime),
      }));
    }

    for (const spec of bank.categories) {
      const value = categories[spec.id];
      if (
        !(spec.inspectAll || spec.inspectValues?.includes(value)) ||
        spec.excludeValues?.includes(value) ||
        spec.inspectExcept?.includes(value) ||
        (spec.onlyStatus && spec.onlyStatus !== status)
      ) {
        continue;
      }
      const entryMap = (data.categoryRows[spec.id] ||= record());
      const entry = (entryMap[value] ||= {
        total: 0,
        byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } },
      });
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
      const entry = (data.flags[spec.id] ||= {
        total: 0,
        byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } },
      });
      entry.total++;
      const bucket = entry.byStatus[status];
      bucket.total++;
      const extra = asObject(asObject(extras.flagRows)[spec.id]);
      const makeRow = () =>
        spec.sortValue
          ? { ...withSid({ ...base, ...extra }), __rank: asObject(extras.ranks)[spec.id] ?? null }
          : withSid({ ...base, ...extra });
      if (spec.sortValue) {
        retainRanked(bucket.rows, asObject(extras.ranks)[spec.id] ?? null, order, makeRow);
      } else if (bucket.rows.length < cap) bucket.rows.push(makeRow());
    }

    bank.lists.forEach((spec, index) => {
      const matches = Array.isArray(extras.listMatches) ? !!extras.listMatches[index] : false;
      if (!matches) return;
      const entry = (data.lists[index] ||= { total: 0, rows: [] });
      const listRows = asObject(extras.listRows);
      const extra = asObject(listRows[String(index)] ?? listRows[index]);
      entry.rows.push(withSid({ ...base, ...extra }));
      entry.total++;
    });

    const serviceStates = asObject(extras.serviceStates);
    for (const key of selectedServices) {
      const kind = services[key]?.kind ?? 'missingService';
      if (['ok', 'failed', 'other'].includes(kind)) continue;
      const entry = (data.serviceRows[key] ||= {
        total: 0,
        byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } },
      });
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
          مسیر: `ai_input.${key}.status`,
          uniqueKey: base.uniqueKey ?? '—',
          requestId: base.requestId ?? row.request_id,
          'تاریخ و ساعت': stamp.rowDisplay,
          وضعیت: status === 'success' ? 'موفق' : 'ناموفق',
        });
      }
    }
  }

  /**
   * اسکلت داشبورد (بدون پیمایش ردیف‌ها) — همان چیزی که هم `/api/report` و هم
   * `/api/summary` لازم دارند. یک‌بار ساخته می‌شود و هر دو مسیر از آن استفاده می‌کنند
   * (فاز ۳ — حذف کار تکراری).
   */
  async dashboardContext(bankInput, from, to, rowsCap = 100) {
    const { key, table } = bankTable(bankInput);
    const { from: f, to: t } = rangeOf(from, to);
    const cap = Math.min(Math.max(Number(rowsCap) || 100, 1), 100);
    // SKIP LOCKED ندارد ولی یک صف سریال دارد: روی **هر** اتصال (pool یا client) یک کوئری
    // در لحظه. با pool، درخواست‌های موازی از اتصال‌های مختلف می‌آیند و بی‌خطرند؛ با client
    // تکی از بازگشت خالی ردیف‌ها جلوگیری می‌کند.
    const db = { query: this.serialQuery(), exec: this.db.exec };
    const dialect = this.dialect.onSerial ? this.dialect.onSerial(db) : this.dialect;
    const bank = this.evaluator.getBank(key);
    // خطای کشف سرویس نباید بی‌صدا بلعیده شود: لاگ می‌شود و با فهرست پیش‌فرض بانک ادامه می‌دهیم
    // (خروجی داشبورد با نبود همین کوئری، سرویس‌ها را «گم» می‌کرد و کسی خبردار نمی‌شد).
    const serviceKeysRes = await this.guarded(
      () => dialect.serviceDiscovery(table, f, t),
      { action: 'summary.serviceDiscovery', meta: { bank: key, from: f, to: t }, fallback: { rows: [] } },
    );
    const __tDiscovery = process.hrtime.bigint();
    const presentKeys = new Set(bank.expectedServices ?? []);
    for (const r of serviceKeysRes.rows) {
      const keys = asObject(r.display_extras).serviceKeys;
      if (Array.isArray(keys)) {
        for (const k of keys) if (k) presentKeys.add(String(k));
      } else {
        for (const [k, kind] of Object.entries(asObject(r.services))) {
          if (kind !== 'missingService' && kind !== undefined) presentKeys.add(k);
        }
      }
    }
    const selectedServices = [...presentKeys].sort();

    // پشت سر هم (نه Promise.all): یک اتصال، یک کوئری در لحظه — وگرنه ردیف‌ها خالی برمی‌گردند
    const countRes = await dialect.countRange(table, f, t);
    const daysRes = await dialect.days(table, f, t);
    const runsRes = await dialect.runsRange(key, f, t);
    const dictRes = await db.query("SELECT message_key, COALESCE(message_text, label, 'سایر پیام‌ها') AS text FROM message_dict");
    const __tQueries = process.hrtime.bigint();
    const totalSamples = Number(countRes.rows[0]?.total ?? 0);
    const selectedDays = daysRes.rows.map((r) => String(r.day));
    const messageText = new Map(dictRes.rows.map((r) => [String(r.message_key), String(r.text)]));
    return {
      key,
      table,
      f,
      t,
      cap,
      bank,
      selectedServices,
      totalSamples,
      selectedDays,
      messageText,
      runsRes,
    };
  }

  /**
   * اسکن یک‌بارِ ردیف‌ها با `bump` (مسیر قدیمی).
   *
   * چرا از `db` یک `query` غیرهم‌زمان استفاده می‌شود: کلاینت Postgres اجازهٔ کوئری موازی روی
   * یک اتصال را نمی‌دهد؛ `cursorPage` ردیف‌ها را با await تودرتو hydrate می‌کرد و وقتی
   * `buildDashboard` هم‌زمان چند دیکشنری می‌خواند، ردیف‌ها **خالی** برمی‌گشتند (باگ واقعی که
   * باعث می‌شد مقایسهٔ مسیر قدیمی/جدید بی‌معنا شود). حالا همهٔ SELECTها پشت سر هم اجرا می‌شوند.
   */
  serialQuery() {
    const raw = this.db.query.bind(this.db);
    let tail = Promise.resolve();
    return (text, params) => {
      const run = tail.then(() => raw(text, params));
      tail = run.catch(() => {});
      return run;
    };
  }

  /**
   * اجرای کوئری «کمکی» با ثبت خطا.
   *
   * قاعدهٔ فاز ۳: هیچ `.catch(() => {})` بی‌صدایی نمانَد. اگر شکست خوردن یک کوئری کمکی
   * پذیرفتنی است (مثلاً کشف سرویس یا ثبت لاگ)، خطا باید در لاگ عمل دیده شود تا تفاوت
   * خروجی قابل ردیابی باشد؛ در غیر این صورت همان خطا بالا می‌رود.
   */
  async guarded(run, { action, meta = {}, fallback } = {}) {
    try {
      return await run();
    } catch (error) {
      try {
        require('../logger/action-logger.service').getActionLogger().warn({
          category: 'db',
          action,
          errorCode: error?.code || 'QUERY_FAILED',
          message: error?.message || 'کوئری کمکی شکست خورد',
          meta,
        });
      } catch {
        // لاگر در دسترس نیست (تست بدون لاگر) — فقط ادامه بده
      }
      if (fallback === undefined) throw error;
      return fallback;
    }
  }

  async buildDashboard(bankInput, from, to, rowsCap = 100, options = {}) {
    const __t0 = process.hrtime.bigint();
    const { signal } = options;
    const { key, table } = bankTable(bankInput);
    const { from: f, to: t } = rangeOf(from, to);
    const cap = Math.min(Math.max(Number(rowsCap) || 100, 1), 100);
    // هیچ کوئری‌ای روی این اتصال موازی اجرا نمی‌شود (نه اینجا، نه داخل cursorPage)
    const db = { query: this.serialQuery(), exec: this.db.exec };
    const dialect = this.dialect.onSerial ? this.dialect.onSerial(db) : this.dialect;
    const bank = this.evaluator.getBank(key);
    // خطای کشف سرویس نباید بی‌صدا بلعیده شود: لاگ می‌شود و با فهرست پیش‌فرض بانک ادامه می‌دهیم
    // (خروجی داشبورد با نبود همین کوئری، سرویس‌ها را «گم» می‌کرد و کسی خبردار نمی‌شد).
    const serviceKeysRes = await this.guarded(
      () => dialect.serviceDiscovery(table, f, t),
      { action: 'summary.serviceDiscovery', meta: { bank: key, from: f, to: t }, fallback: { rows: [] } },
    );
    const presentKeys = new Set(bank.expectedServices ?? []);
    for (const r of serviceKeysRes.rows) {
      const keys = asObject(r.display_extras).serviceKeys;
      if (Array.isArray(keys)) {
        for (const k of keys) if (k) presentKeys.add(String(k));
      } else {
        for (const [k, kind] of Object.entries(asObject(r.services))) {
          if (kind !== 'missingService' && kind !== undefined) presentKeys.add(k);
        }
      }
    }
    const selectedServices = [...presentKeys].sort();

    // پشت سر هم (نه Promise.all): روی یک اتصال، کوئری موازی مجاز نیست و ردیف‌ها خالی برمی‌گشتند
    /* eslint-disable no-await-in-loop */
    const countRes = await dialect.countRange(table, f, t);
    const daysRes = await dialect.days(table, f, t);
    const runsRes = await dialect.runsRange(key, f, t);
    const dictRes = await db.query("SELECT message_key, COALESCE(message_text, label, 'سایر پیام‌ها') AS text FROM message_dict");
    const totalSamples = Number(countRes.rows[0]?.total ?? 0);
    const selectedDays = daysRes.rows.map((r) => String(r.day));
    const messageText = new Map(dictRes.rows.map((r) => [String(r.message_key), String(r.text)]));
    const data = this.emptyData(cap);
    data.processedFiles = runsRes.rowCount || 0;
    data.runtimeErrors = runsRes.rows
      .filter((r) => r.status === 'failed')
      .map((r) => ({ file: String(r.day), error: String(r.error ?? 'خطای اجرا') }));

    const state = { bank, selectedServices, cap, messageText, data, sequence: 0, badReports: 0 };
    let cursor = ['', '', ''];
    const pageSize = 1000;
    for (;;) {
      const batch = await dialect.cursorPage(table, f, t, cursor, pageSize);
      const rows = batch.rows;
      if (!rows.length) break;
      for (const row of rows) this.consumeRow(row, state);
      const last = rows[rows.length - 1];
      cursor = [String(last.day || ''), String(last.stamp_key || ''), String(last.request_id || '')];
      if (rows.length < pageSize) break;
      // P6: اگر کلاینت قطع شده است (499)، اسکن را متوقف کن تا اتصال آزاد شود.
      // خطا می‌دهیم (نه جزئیات برگرداندن) تا کش-write نکند و درخواست‌های دیگر
      // از یک-building共享 شده Gone شده، دوباره بسازند.
      if (signal?.aborted) {
        const abortErr = new Error('گزارش توسط کلاینت لغو شد');
        abortErr.name = 'AbortError';
        abortErr.code = 'ABORTED';
        throw abortErr;
      }
    }
    data.processedSamples = state.sequence;
    const __tScan = process.hrtime.bigint();

    const badReports = state.badReports;
    const renderBank = {
      ...bank,
      topics: bank.topics.map((topic) =>
        key === 'tavan_mellat' && topic.id === 'deposit'
          ? {
              ...topic,
              extraHtml: () =>
                !badReports
                  ? ''
                  : `<div class="alert"><strong>نیاز به بررسی تاریخ سپرده:</strong> در ${badReports} گزارش، دستکم یک تاریخ ماه سپرده قابل خواندن نبود. سالوماه (مانند <code>140309</code>) یا سالوماهروز (مانند <code>14030930</code>) پذیرفته میشود؛ مقدارهای خام فقط در پنجرهٔ جزئیات همان گزارش، پس از دریافت از API اصلی، در دسترساند.</div>`,
            }
          : topic,
      ),
    };
    const scan = {
      root: 'database',
      days: selectedDays,
      files: [],
      errors: [],
      totalSamples,
      invalidSamples: 0,
      methodCounts: new Map(),
      selectedMethod: bank.key,
      bank: renderBank,
      selectedFiles: [],
      selectedDays,
      selectedServices,
      ignoredRows: [],
    };
    const latestRun = runsRes.rows[0];
    const controls = {
      action: '/',
      bank: key,
      from: f,
      to: t,
      rowsCap: cap,
      banks: this.banks(),
      status: latestRun?.status ?? '',
      updatedAt: latestRun?.updated_at ? new Date(latestRun.updated_at).toISOString() : '',
    };
    try {
      const ms = (a, b) => Number(b - a) / 1e6;
      require('../logger/action-logger.service').getActionLogger().info({
        category: 'summary',
        action: 'summary.report.build_phases',
        statusCode: 200,
        meta: {
          bank: key, from: f, to: t,
          discoveryMs: Math.round(ms(__t0, __tDiscovery)),
          queriesMs: Math.round(ms(__tDiscovery, __tQueries)),
          scanRows: state.sequence,
          scanMs: Math.round(ms(__tQueries, __tScan)),
          buildMs: Math.round(ms(__t0, __tScan)),
        },
      });
    } catch { /* لاگر آماده نیست */ }
    return { scan, data, options: { rowsCap: cap, controls } };
  }

  async report(bankInput, from, to, rowsCap = 100, options = {}) {
    const built = await this.buildDashboard(bankInput, from, to, rowsCap, options);
    delete built.data.__cap;
    return buildReport(built.scan, built.data, built.options);
  }

  /**
   * خلاصهٔ آماری داشبورد — مسیر سریع و کم‌مصرف (فاز ۳).
   *
   * تفاوت با نسخهٔ قبلی: هیچ ردیفی در Node تجمیع نمی‌شود. `COUNT(*) FILTER`،
   * `percentile_cont` و شمارش بیت‌ها در SQL انجام می‌شوند و نتیجه در `StatsCache`
   * نگه داشته می‌شود (کلید شامل نسخهٔ تحلیل و شمارندهٔ rebuild روز است).
   *
   * @param {{useSql?: boolean, rowsCap?: number}} options
   *   `useSql: false` مسیر قدیمی (بازسازی با bump) را اجرا می‌کند؛ برای مقایسه استفاده می‌شود.
   */
  async summary(bankInput, from, to, options = {}) {
    const startedAt = process.hrtime.bigint();
    try {
      return await this.#summaryImpl(bankInput, from, to, options);
    } finally {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      require('../metrics').metrics.observe('summary_latency_ms', ms, { bank: bankInput });
      if (ms > 1500) {
        require('../metrics').metrics.inc('summary_slow_total', 1, { bank: bankInput });
      }
    }
  }

  async #summaryImpl(bankInput, from, to, options = {}) {
    if (options.useSql === false || this.dialect.name !== 'v2') {
      return this.legacySummary(bankInput, from, to, options);
    }
    const { key, label } = bankTable(bankInput);
    const { from: f, to: t } = rangeOf(from, to);
    const length = this.rangeLengthDays(f, t);
    if (this.maxRangeDays && length > this.maxRangeDays) {
      const error = new Error(`بازهٔ درخواستی ${length} روز است؛ سقف ${this.maxRangeDays} روز`);
      error.statusCode = 413;
      error.meta = { code: 'rangeTooLarge' };
      error.data = { message: { fa: error.message, en: 'range too large' } };
      throw error;
    }

    const { aggregateRange, analysisVersionOf } = require('../rollup/rollup.service');
    const bundle = options.registryBundle || require('../db/schema-registry').buildRuntimeRegistry(this.evaluator);
    // متادیتای بازه (روزها و وضعیت اجراها) با TTL کوتاه کش می‌شود تا کلید کش پایدار بماند
    // و چند درخواست هم‌زمان، کلید یکسان بسازند (single-flight واقعی).
    const metaKey = this.cache.keyOf(['range-meta', key, f, t]);
    const meta = await this.cache.remember(metaKey, async () => {
      const runsRes = await this.dialect.runsRange(key, f, t);
      const daysRes = await this.dialect.days(this.dialect.tableOf(key), f, t);
      return { runs: runsRes, days: daysRes };
    }, 2000);
    const runs = meta.runs;
    const days = meta.days;
    const dayList = days.rows.map((row) => String(row.day));
    const completeDays = new Set(
      runs.rows.filter((row) => row.status === 'complete').map((row) => String(row.day)),
    );
    const rebuildCounter = runs.rows
      .map((row) => `${row.day}:${row.status}:${row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at}`)
      .join('|');
    const cacheKey = this.cache.keyOf([
      'summary', key, f, t, analysisVersionOf(this.evaluator, key), rebuildCounter,
    ]);
    const isCurrentRange = dayList.includes(new Date().toISOString().slice(0, 10)) ||
      completeDays.size !== dayList.length;

    const aggregated = await this.cache.remember(
      cacheKey,
      async () => {
        const result = await aggregateRange({
          db: this.db,
          evaluator: this.evaluator,
          registryBundle: bundle,
          bankKey: key,
          fromIso: require('../db/row-mapper-v2').toDateIso(f),
          toIso: require('../db/row-mapper-v2').toDateIso(t),
          days: dayList,
          completeDays,
        });
        return { stats: result.stats, daily: result.daily };
      },
      isCurrentRange ? this.cache.currentDayTtlMs : this.cache.ttlMs,
    );

    const payload = this.presentSummary(key, label, f, t, aggregated.stats, dayList, aggregated.daily);
    const stats = this.cache.stats();
    require('../metrics').metrics.set('summary_cache_hit_rate', Math.round((stats.hitRate || 0) * 100), { bank: key });
    return payload;
  }

  /** ساخت خروجی `/api/summary` از آمار تجمیع‌شده (SQL یا legacy) */
  async presentSummary(key, label, f, t, all, dayList, daily = []) {
    const specs = this.evaluator.specs(key);
    const metrics = {};
    for (const [id, value] of Object.entries(all.metrics)) {
      if (Array.isArray(value)) {
        // مسیر legacy: آرایهٔ خام (برای سازگاری زمانی که useSql=false صدا زده می‌شود)
        const sorted = [...value].sort((a, b) => a - b);
        metrics[id] = {
          count: sorted.length,
          min: sorted[0] ?? null,
          p25: quantile(sorted, 0.25),
          median: quantile(sorted, 0.5),
          mean: sorted.length ? sorted.reduce((sum, v) => sum + v, 0) / sorted.length : null,
          p75: quantile(sorted, 0.75),
          max: sorted.length ? sorted[sorted.length - 1] : null,
        };
      } else {
        metrics[id] = { ...value };
      }
      metrics[id].id = id;
      metrics[id].label = specs.metrics.find((spec) => spec.id === id)?.label ?? id;
    }
    const total = Number(all.total ?? 0);
    const success = Number(all.byStatus?.success ?? 0);
    return {
      bank: { id: key, label },
      from: f,
      to: t,
      stats: {
        total,
        success,
        fail: Number(all.byStatus?.fail ?? total - success),
        days: dayList.length,
        success_rate: total ? Number(((success * 100) / total).toFixed(2)) : 0,
      },
      flags: Object.fromEntries(Object.entries(all.flags || {}).map(([id, count]) => [id, Number(count)])),
      counters: Object.fromEntries(Object.entries(all.counters || {}).map(([id, count]) => [id, Number(count)])),
      categories: Object.fromEntries(
        Object.entries(all.cats || {}).map(([id, values]) => [
          id,
          Object.entries(values)
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count),
        ]),
      ),
      services: Object.fromEntries(
        Object.entries(all.services || {}).map(([id, counts]) => [id, { id, label: SERVICE_FA[id] ?? id, counts }]),
      ),
      paths: Object.fromEntries(Object.entries(all.paths || {}).map(([id, entry]) => [id, entry])),
      metrics,
      daily,
      runs: await this.runs(),
      specs,
      generatedAt: new Date().toISOString(),
      source: 'sql_aggregate',
    };
  }

  async legacySummary(bankInput, from, to, options = {}) {
    const { key, label } = bankTable(bankInput);
    const { from: f, to: t } = rangeOf(from, to);
    const built = await this.buildDashboard(bankInput, f, t, options.rowsCap ?? 100);
    delete built.data.__cap;
    const all = built.data.groups.ALL;
    const specs = this.evaluator.specs(key);
    const metrics = {};
    for (const [id, values] of Object.entries(all.metrics)) {
      const sorted = [...(values || [])].sort((a, b) => a - b);
      const spec = specs.metrics.find((s) => s.id === id);
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
      bank: { id: key, label },
      from: f,
      to: t,
      stats: {
        total: all.total,
        success: all.byStatus.success,
        fail: all.byStatus.fail,
        days: built.scan.selectedDays.length,
        success_rate: all.total ? Number(((all.byStatus.success * 100) / all.total).toFixed(2)) : 0,
      },
      flags: Object.fromEntries(Object.entries(all.flags).map(([id, count]) => [id, Number(count)])),
      counters: Object.fromEntries(Object.entries(all.counters).map(([id, count]) => [id, Number(count)])),
      categories: Object.fromEntries(
        Object.entries(all.cats).map(([id, values]) => [
          id,
          Object.entries(values)
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count),
        ]),
      ),
      services: Object.fromEntries(
        Object.entries(all.services).map(([id, counts]) => [id, { id, label: SERVICE_FA[id] ?? id, counts }]),
      ),
      paths: Object.fromEntries(Object.entries(all.paths).map(([id, entry]) => [id, entry])),
      metrics,
      daily: built.scan.selectedDays.map((day) => {
        const stats = built.data.groups[`day:${day}`];
        return {
          day,
          total: stats?.total ?? 0,
          success: stats?.byStatus.success ?? 0,
          fail: stats?.byStatus.fail ?? 0,
          flags: stats?.flags ?? {},
        };
      }),
      runs: await this.runs(),
      specs,
      generatedAt: new Date().toISOString(),
      source: 'legacy_bump',
    };
  }

  async list(params) {
    const { table } = bankTable(params.bank);
    const { from, to } = rangeOf(params.from, params.to);
    // اندازهٔ صفحه: پیش‌فرض ۱۰۰، سقف ۲۰۰ — هیچ سقف پنهانی روی «تعداد رکورد قابل مشاهده» نیست؛
    // برای دیدن بقیه، `cursor` صفحهٔ بعد را می‌دهد (`nextCursor`).
    const maxLimit = Number(process.env.CE_LIST_MAX_LIMIT || 200);
    const limit = Math.min(Math.max(Number(params.limit ?? 100) || 100, 1), maxLimit);
    const offset = Math.max(Number(params.offset ?? 0) || 0, 0);
    const cursor = typeof params.cursor === 'string' && params.cursor ? params.cursor : null;

    const result = await this.dialect.list({
      table, params: { ...params, from, to }, from, to, limit, offset, cursor,
    });
    return {
      bank: params.bank,
      from,
      to,
      type: result.type,
      id: result.id,
      value: params.value ?? null,
      limit,
      offset,
      total: result.total,
      nextCursor: result.nextCursor ?? null,
      cursor,
      // ۳-الف: `rows` برای سازگاری با کلاینت قدیمی می‌مانَد و `items` همان آرایه است
      rows: normalizeRows(result.rows),
      items: normalizeRows(result.rows),
    };
  }

  async sample(requestId, req, bankHint, actor = null) {
    // جست‌وجوی ردیف ذخیره‌شده در همهٔ بانک‌ها (جزئیات مسیر هر dialect جداست)
    const banksList = Object.keys(BANKS);
    const matched = await Promise.all(
      banksList.map(async (key) => {
        const found = await this.guarded(
          () => this.dialect.byRequestId(BANKS[key].table, requestId),
          { action: 'summary.byRequestId', meta: { bank: key }, fallback: { rows: [] } },
        );
        const hit = found.rows[0];
        return hit ? { bank: key, day: hit.day, is_success: hit.is_success, unique_key: hit.unique_key } : null;
      }),
    );
    const row = matched
      .filter(Boolean)
      .sort((a, b) => String(b.day).localeCompare(String(a.day)))[0];

    const prioritized = [
      row?.bank,
      bankHint && BANKS[bankHint] ? bankHint : null,
      ...Object.keys(BANKS),
    ].filter((key) => key && BANKS[key]);
    const candidates = [];
    const seenEndpoints = new Set();
    for (const key of prioritized) {
      const apiUrl = resolveBankApiUrl(key);
      const endpointSig = `${apiUrl}|${bankUsesGateway(key) ? 'gw' : 'direct'}`;
      if (seenEndpoints.has(endpointSig)) continue;
      seenEndpoints.add(endpointSig);
      candidates.push({ bankKey: key, apiUrl });
    }

    let raw = null;
    let lastError = null;
    let matchedFromBank = null;
    for (const candidate of candidates) {
      const url = new URL(candidate.apiUrl);
      url.searchParams.set('page', '1');
      url.searchParams.set('limit', '1');
      url.searchParams.set('requestId', requestId);
      try {
        const data = await fetchBankJson(candidate.bankKey, url.toString(), {
          timeoutMs: config.requestTimeoutMs,
          retryCount: 1,
        });
        const hit = data?.reportResults?.[0] ?? data?.reports?.[0] ?? null;
        if (hit) {
          raw = hit;
          matchedFromBank = candidate.bankKey;
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!raw && lastError && !matchedFromBank && candidates.length === 1) {
      getActionLogger().error({
        category: 'detail',
        action: 'detail.sample.upstream_error',
        errorCode: 'creditEvaluationBaseServiceError',
        statusCode: lastError.statusCode || 502,
        message: lastError?.message || 'Upstream detail fetch failed',
        meta: { sampleRequestId: requestId },
      });
      throw ceError.creditEvaluationBaseServiceError({
        status: lastError.statusCode || 502,
        requestId,
      });
    }
    if (!raw && lastError && row?.bank) {
      getActionLogger().error({
        category: 'detail',
        action: 'detail.sample.upstream_error',
        errorCode: 'creditEvaluationBaseServiceError',
        statusCode: lastError.statusCode || 502,
        message: lastError?.message || 'Upstream detail fetch failed',
        meta: { sampleRequestId: requestId, bank: row.bank },
      });
      throw ceError.creditEvaluationBaseServiceError({
        status: lastError.statusCode || 502,
        requestId,
      });
    }

    // ثبت دسترسی اگر شکست بخورد، خودِ درخواست نباید بشکند — ولی خطا **لاگ** می‌شود
    await this.guarded(
      // D2: ثبت دسترسی با بازیگر و نقش‌ها (مسئولیت‌پذیری) — `ip` ماسک می‌شود
      () => this.db.query(
        'INSERT INTO sample_access_logs(request_id, ip, user_agent, actor, roles) VALUES($1,$2,$3,$4,$5::jsonb)',
        [
          requestId,
          maskIp(req?.ip ?? null),
          String(req?.headers?.['user-agent'] ?? '').slice(0, 500),
          actor?.username ?? null,
          JSON.stringify(Array.isArray(actor?.roles) ? actor.roles : []),
        ],
      ),
      { action: 'summary.sampleAccessLog', meta: { requestId, actor: actor?.username ?? null } },
    );

    if (!raw) return { requestId, found: false, fetchedAt: new Date().toISOString(), meta: {}, sample: null };
    const normalized = this.evaluator.normalizeSample(raw, { fromApi: true });
    const inferredBank = this.evaluator.bankKeyOfSample(normalized);
    const bankKey = String(row?.bank || matchedFromBank || inferredBank);
    const status = row
      ? row.is_success
        ? 'success'
        : 'fail'
      : this.evaluator.isReportSuccess(normalized)
        ? 'success'
        : 'fail';
    const legacy = this.evaluator.analyzeLegacy(normalized, status === 'success', bankKey);
    const bank = this.evaluator.getBank(bankKey);
    const uniqueKey = row?.unique_key ?? get(normalized, 'input.uniqueKey') ?? '—';
    const national = get(normalized, 'input.data.nationalCode');
    let safeSample = normalized;
    try {
      if (bank.sanitizeSample) safeSample = bank.sanitizeSample(normalized);
    } catch {
      safeSample = normalized;
    }
    let viewer;
    try {
      if (bank.viewer) viewer = bank.viewer(legacy.collected, normalized);
    } catch {
      viewer = undefined;
    }
    const meta = {
      bank: bank.label,
      method: bank.id,
      methodKey: bank.key,
      day: row?.day ?? '',
      status,
      uniqueKey,
      requestId,
      flags: bank.flags.filter((spec) => legacy.flags[spec.id]).map((spec) => spec.label),
      ...(bank.key === 'tavan_resalat' || bank.key === 'tavan_postbank'
        ? { nationalCode: String(national ?? '').trim() || 'ثبت نشده' }
        : {}),
      ...(viewer ? { viewer } : {}),
      ...(legacy.creditAlerts?.overdue || legacy.creditAlerts?.cheque ? { creditAlerts: legacy.creditAlerts } : {}),
    };
    return {
      requestId,
      found: true,
      fetchedAt: new Date().toISOString(),
      meta,
      sample: redactSensitive(safeSample),
    };
  }

  errorHtml(error) {
    const escape = (value) =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const rawMsg = error?.data?.message?.fa ?? error?.message ?? error;
    const message = escape(String(rawMsg).slice(0, 600));
    const fontCss = getVazirmatnFontCss();
    return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>گزارش در دسترس نیست</title><style>${fontCss}
      body{margin:0;background:#eef4fb;color:#0c1e3e;font:14px/1.9 'Vazirmatn',Tahoma,"Segoe UI",sans-serif;padding:40px}
      main{max-width:640px;margin:auto;background:#fff;border:1px solid #d4e2f4;border-radius:16px;padding:28px 32px;box-shadow:0 14px 36px rgba(0,28,88,.08)}
      h1{color:#002878;font-size:20px;margin:0 0 12px}p{color:#4e6788}pre{direction:ltr;text-align:left;background:#f4f8fe;border:1px solid #e7effa;border-radius:8px;padding:8px 12px;white-space:pre-wrap;word-break:break-word;font-size:12px}
      a{color:#0b5ed7;font-weight:700}.badge{display:inline-block;background:#fff4e2;color:#b4690e;border-radius:8px;padding:2px 10px;font-size:12px}
    </style></head><body><main><span class="badge">HTTP 503</span><h1>در حال حاضر امکان ساخت گزارش وجود ندارد</h1>
      <p>لطفاً چند لحظه دیگر دوباره تلاش کنید.</p>
      <pre>${message}</pre>
      <p><a href="/">تلاش دوباره</a></p>
    </main></body></html>`;
  }

  async diagnostics() {
    const tables = [
      'day_runs',
      'samples_mellat',
      'samples_resalat',
      'samples_postbank',
      'message_dict',
      'sample_access_logs',
      'cron_configs',
      'backend_action_logs',
    ];
    const result = {
      ok: false,
      framework: 'partFramework',
      // D8: متریک‌های درون‌پروسه (ingestion/کش/تأخیر) و وضعیت استخرها
      metrics: require('../metrics').metrics.snapshot(),
      pools: typeof this.db.stats === 'function' ? this.db.stats() : null,
      generatedAt: new Date().toISOString(),
      databaseUrlConfigured: !!process.env.DATABASE_URL,
      apiBaseUrlConfigured: !!process.env.CE_API_BASE_URL,
      apiUrlsConfigured: {
        tavan_mellat: !!resolveBankApiUrl('tavan_mellat'),
        tavan_resalat: !!resolveBankApiUrl('tavan_resalat'),
        tavan_postbank: !!resolveBankApiUrl('tavan_postbank'),
      },
      apiTokenConfigured: !!config.apiToken,
      gatewayAutoTokenConfigured: {
        tavan_mellat: (() => {
          const g = resolveBankGatewayConfig('tavan_mellat');
          return !!(g.tokenUrl && g.username && g.password);
        })(),
        tavan_postbank: (() => {
          const g = resolveBankGatewayConfig('tavan_postbank');
          return !!(g.tokenUrl && g.username && g.password);
        })(),
        tavan_resalat: false,
      },
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
      result.databaseError = String(error?.message ?? error).slice(0, 500);
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
      } catch {
        result.tables[table] = false;
      }
    }
    for (const table of tables.filter((x) => x.startsWith('samples_'))) {
      if (!result.tables[table]) continue;
      try {
        const count = await this.db.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
        result.counts[table] = Number(count.rows[0]?.count ?? 0);
      } catch {}
    }
    result.bankDiagnostics = {};
    for (const [bankKey, bank] of Object.entries(BANKS)) {
      if (!result.tables[bank.table]) continue;
      try {
        const versions = await this.db.query(
          `SELECT COALESCE(analysis_version,'(none)') AS version, COUNT(*)::int AS count FROM ${bank.table} GROUP BY 1 ORDER BY 2 DESC`,
        );
        const timed = await this.db.query(
          `SELECT COUNT(*)::int AS count FROM ${bank.table}
           WHERE (display_extras->'stamp'->>'display') LIKE '%:%'
              OR LENGTH(COALESCE(inserted_at,'')) >= 12
              OR LENGTH(COALESCE(stamp_key,'')) >= 12`,
        );
        const total = Number(result.counts[bank.table] ?? 0);
        const withTime = Number(timed.rows[0]?.count ?? 0);
        result.bankDiagnostics[bankKey] = {
          rows: total,
          rowsWithTime: withTime,
          rowsWithoutTime: Math.max(0, total - withTime),
          analysisVersions: versions.rows.map((r) => ({ version: String(r.version), count: Number(r.count) })),
        };
        if (total > 0 && withTime < total) {
          result.hints.push(
            `${bank.label}: ${total - withTime} ردیف زمان ثبت ندارند؛ نمایش اولین/آخرین درخواست ممکن است فقط تاریخ باشد. دوباره ingest کن.`,
          );
        }
        const distinct = versions.rows.length;
        if (distinct > 1) {
          result.hints.push(
            `${bank.label}: ردیفها با ${distinct} نسخهٔ متفاوت تحلیل ذخیره شدهاند؛ اعداد ممکن است قدیمی باشند. دوباره ingest کن.`,
          );
        }
      } catch {}
    }
    if (Object.values(result.tables).some((exists) => !exists)) {
      result.hints.push('برخی جداول ساخته نشدهاند؛ npm run migrate را اجرا کن.');
    }
    if (Object.values(result.counts).every((count) => Number(count) === 0)) {
      result.hints.push('جداول خالیاند؛ Ingestion اجرا نشده است.');
    }
    result.ok = result.databaseConnected && Object.values(result.tables).every(Boolean);
    return result;
  }

  async runs() {
    const result = await this.dialect.runs(200);
    return result.rows;
  }
}

module.exports = { SummaryService };
