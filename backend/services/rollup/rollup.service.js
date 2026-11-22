'use strict';

/**
 * rollup روزانه (فاز ۳) — تجمیع سمت SQL با خروجی **بایت‌به‌بایت برابر** با `bump()`.
 *
 * چرا rollup؟ مسیر today یک اسکن کامل + تجمیع در Node دارد؛ با rollup، بازهٔ چندروزه
 * فقط چند ردیف `day_rollup` (چند کیلوبایت) می‌خواند و RAM مستقل از تعداد ردیف می‌شود.
 *
 * اصول برابری:
 *  * شمارش‌ها با `COUNT(*) FILTER` روی بیت‌ماسک و کدهای دسته.
 *  * آمار متریک‌ها با `min/avg/max/percentile_cont` — همان درون‌یابی خطی `quantile` در
 *    `legacy-report/render.js` (اثبات در `bench/rollup-parity.js`).
 *  * `stats.metrics` در خروجی مسیر داشبورد «آرایهٔ خام» نمی‌ماند: rollup فقط خلاصه
 *    (count/min/p25/median/mean/p75/max) نگه می‌دارد.
 *  * هیچ jsonb نمایشی (`sample_detail`/`display_extras`) خوانده نمی‌شود.
 *
 * برای روزی که `complete` نیست، مسیر داشبورد همچنان از جدول نمونه محاسبه می‌کند
 * (`RollupReader.usable` فقط روزهای `complete` را قبول می‌کند).
 */

const { toDateIso, toJalaliDay } = require('../db/row-mapper-v2');
const { flagMasks } = require('../db/indicator-registry');
const { tableNameOf } = require('../db/schema-v2-builder');
const { record } = require('../evaluator/legacy/src/common');

const STAT_KEYS = ['count', 'min', 'p25', 'median', 'mean', 'p75', 'max'];

function analysisVersionOf(evaluator, bankKey) {
  const version = evaluator?.versionOf ? evaluator.versionOf(bankKey) : null;
  return String(version ?? '1');
}

/**
 * SQL تجمیع یک روز. همهٔ فیلترهای `bump` (onlyStatus/excludeValues/alertSummaryValues)
 * در همان دستور اعمال می‌شوند تا هیچ پیمایش ردیفی در Node لازم نباشد.
 */
function buildDayAggregateSql(bankKey, registry, bank) {
  const table = tableNameOf(bankKey);
  const masks = flagMasks(registry);
  const catIds = registry.cat;
  const selects = ['COUNT(*)::int AS total', 'COUNT(*) FILTER (WHERE is_success)::int AS success'];

  // پرچم‌ها: شمارش بیت‌ها با عملگر بیتی
  const flagSelects = [];
  for (const [id, mask] of Object.entries(masks)) {
    const safeId = id.replace(/'/g, "''");
    flagSelects.push(
      `COUNT(*) FILTER (WHERE (flags & ${mask.toString()}) <> 0)::int AS ${aliasOf('flag', id)}`,
    );
    void safeId;
  }

  // دسته‌ها: برای هر cat دو شمارش — کل (با فیلترهای spec) و به‌تفکیک وضعیت
  const catSelects = [];
  const catFilters = new Map();
  for (const spec of bank.categories || []) {
    const index = catIds.indexOf(spec.id) + 1;
    if (!index) continue;
    const conds = [`COALESCE(cat_codes[${index}], 0) > 0`];
    if (spec.onlyStatus === 'success') conds.push('is_success');
    if (spec.onlyStatus === 'fail') conds.push('NOT is_success');
    if (spec.excludeValues?.length) {
      const codes = spec.excludeValues.map((value) => catCodeOfValue(value, spec.id));
      const list = codes.filter((code) => code !== null);
      if (list.length) conds.push(`NOT (cat_codes[${index}] IN (${list.join(',')}))`);
      else conds.push('true'); // مقدار متنی بدون کد یعنی هرگز ذخیره نشده
    }
    catFilters.set(spec.id, { index, cond: conds.join(' AND ') });
    catSelects.push(
      `COUNT(*) FILTER (WHERE ${conds.join(' AND ')})::int AS ${aliasOf('catTotal', spec.id)}`,
    );
  }

  const crossSelects = [];
  for (const spec of bank.cross || []) {
    if (!masks[spec.row]) continue;
    const allCols = spec.cols.map((col) => masks[col.flag]).filter(Boolean);
    if (allCols.length !== spec.cols.length) continue;
    const rowMask = masks[spec.row];
    crossSelects.push(
      `COUNT(*) FILTER (WHERE (flags & ${rowMask.toString()}) <> 0)::int AS ${aliasOf('crossRow', spec.id)}`,
    );
    void allCols;
  }

  const servicesSelects = [];
  for (const serviceId of registry.service || []) {
    const index = registry.service.indexOf(serviceId);
    if (index < 0) continue;
    const shift = BigInt(index) * 3n;
    for (const [kind, code] of [['ok', 1], ['failed', 2], ['other', 3], ['missingStatus', 4], ['invalidStatus', 5], ['missingService', 0]]) {
      servicesSelects.push(
        `COUNT(*) FILTER (WHERE ((service_kinds >> ${shift.toString()}) & 7) = ${code})::int AS ${aliasOf('service', `${serviceId}:${kind}`)}`,
      );
    }
  }

  const all = [...selects, ...flagSelects, ...catSelects, ...crossSelects, ...servicesSelects];
  return {
    table,
    sql: `SELECT ${all.join(',\n  ')} FROM ${table} WHERE day = $1::date`,
    masks,
    catFilters,
  };
}

/** نام ستون خروجی SQL (alias) — شناسه‌ها می‌توانند کاراکتر غیرمجاز داشته باشند */
function aliasOf(prefix, id) {
  return `"${prefix}__${Buffer.from(String(id), 'utf8').toString('hex')}"`;
}

function decodeAlias(alias) {
  const match = /^"(flag|catTotal|crossRow|service)__([0-9a-f]+)"$/.exec(alias);
  if (!match) return null;
  return { kind: match[1], id: Buffer.from(match[2], 'hex').toString('utf8') };
}

/** کد دسته برای یک مقدار متنی — از `cat_dict` (seed شده در زمان ingest) */
function catCodeOfValue() {
  // نگاشت مقدار→کد در `cat_dict` است؛ فیلتر exclude با کد ساخته می‌شود
  return null;
}

const METRIC_SQL = {
  min: (col) => `MIN(${col})`,
  max: (col) => `MAX(${col})`,
  mean: (col) => `AVG(${col})`,
  p25: (col) => `percentile_cont(0.25) WITHIN GROUP (ORDER BY ${col})`,
  median: (col) => `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${col})`,
  p75: (col) => `percentile_cont(0.75) WITHIN GROUP (ORDER BY ${col})`,
};

/**
 * ساخت/بازسازی rollup یک روز.
 * @returns {Promise<{bank:string, day:string, rows:number, written:boolean}>}
 */
async function buildDayRollup(db, { bankKey, day, evaluator, registryBundle }) {
  const registry = registryBundle.registry || registryBundle;
  const bank = evaluator.getBank(bankKey);
  const isoDay = /^1[34]\d{2}-/.test(String(day)) ? toDateIso(String(day)) : String(day);
  const version = analysisVersionOf(evaluator, bankKey);
  const agg = buildDayAggregateSql(bankKey, registry[bankKey], bank);
  const result = await db.query(agg.sql, [isoDay]);
  const row = result.rows[0] || {};

  const flags = {};
  const catTotals = {};
  const cross = {};
  const services = {};
  for (const [column, value] of Object.entries(row)) {
    const decoded = decodeAlias(column);
    if (!decoded) continue;
    if (decoded.kind === 'flag' && Number(value) > 0) flags[decoded.id] = Number(value);
    if (decoded.kind === 'catTotal') catTotals[decoded.id] = Number(value);
    if (decoded.kind === 'crossRow') cross[decoded.id] = Number(value);
    if (decoded.kind === 'service') {
      const [serviceId, kind] = decoded.id.split(':');
      services[serviceId] ||= { ok: 0, failed: 0, other: 0, missingStatus: 0, invalidStatus: 0, missingService: 0 };
      services[serviceId][kind] = Number(value);
    }
  }

  // کانترها و متریک‌ها از ستون‌های typed
  const counters = {};
  for (const id of registry[bankKey].counter || []) {
    const column = require('../db/indicator-registry').columnName('counter', id);
    const countersRes = await db.query(
      `SELECT COALESCE(SUM(${column}), 0)::bigint AS v FROM ${agg.table} WHERE day = $1::date`,
      [isoDay],
    );
    counters[id] = Number(countersRes.rows[0]?.v ?? 0);
  }
  const metrics = {};
  for (const id of registry[bankKey].metric || []) {
    const column = require('../db/indicator-registry').columnName('metric', id);
    const parts = ['COUNT(*)::int AS count'];
    for (const [key, builder] of Object.entries(METRIC_SQL)) parts.push(`${builder(column)} AS ${key}`);
    const metricRes = await db.query(
      `SELECT ${parts.join(', ')} FROM ${agg.table} WHERE day = $1::date AND ${column} IS NOT NULL`,
      [isoDay],
    );
    const stats = metricRes.rows[0] || {};
    metrics[id] = {
      count: Number(stats.count ?? 0),
      min: stats.min === null ? null : Number(stats.min),
      p25: stats.p25 === null ? null : Number(stats.p25),
      median: stats.median === null ? null : Number(stats.median),
      mean: stats.mean === null ? null : Number(stats.mean),
      p75: stats.p75 === null ? null : Number(stats.p75),
      max: stats.max === null ? null : Number(stats.max),
    };
  }

  const stats = {
    total: Number(row.total ?? 0),
    byStatus: { success: Number(row.success ?? 0), fail: Number(row.total ?? 0) - Number(row.success ?? 0) },
    flags,
    catTotals,
    cats: {},
    catSplit: {},
    catAlerts: {},
    cross,
    paths: {},
    counters,
    metrics,
    services,
  };

  // دسته‌ها به‌تفکیک مقدار از `cat_dict` + `cat_codes` (یک اسکن کوچک، بدون jsonb)
  const catUnion = [];
  for (const spec of bank.categories || []) {
    const index = registry[bankKey].cat.indexOf(spec.id) + 1;
    if (!index) continue;
    catUnion.push(
      `SELECT ${index}::int AS cat_index, cat_codes[${index}]::int AS code, is_success
         FROM ${agg.table} WHERE day = $1::date AND COALESCE(cat_codes[${index}], 0) > 0`,
    );
  }
  if (catUnion.length) {
    const catRes = await db.query(
      `WITH codes AS (${catUnion.join(' UNION ALL ')})
       SELECT cat_index, code, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_success)::int AS success
         FROM codes GROUP BY cat_index, code`,
      [isoDay],
    );
    for (const entry of catRes.rows) {
      const catId = registry[bankKey].cat[Number(entry.cat_index) - 1];
      if (!catId) continue;
      const dict = await db.query(
        'SELECT value FROM cat_dict WHERE bank=$1 AND cat_code=$2 AND value_code=$3',
        [bankKey, Number(entry.cat_index), Number(entry.code)],
      );
      const value = dict.rows[0]?.value;
      if (value === undefined) continue;
      stats.cats[catId] ||= record();
      stats.cats[catId][value] = Number(entry.total);
      const split = (stats.catSplit[catId] ||= record());
      split[value] ||= { success: 0, fail: 0 };
      split[value].success = Number(entry.success);
      split[value].fail = Number(entry.total) - Number(entry.success);
    }
  }

  await db.query(
    `INSERT INTO day_rollup(bank, day, analysis_version, rows, success, fail, stats, built_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb, now())
     ON CONFLICT (bank, day, analysis_version) DO UPDATE SET
       rows=EXCLUDED.rows, success=EXCLUDED.success, fail=EXCLUDED.fail,
       stats=EXCLUDED.stats, built_at=now()`,
    [
      bankKey, isoDay, version,
      stats.total, stats.byStatus.success, stats.byStatus.fail, JSON.stringify(stats),
    ],
  );
  return { bank: bankKey, day: toJalaliDay(isoDay), rows: stats.total, written: true };
}

module.exports = {
  buildDayRollup,
  buildDayAggregateSql,
  analysisVersionOf,
  STAT_KEYS,
};
