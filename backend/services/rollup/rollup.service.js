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
const { ROTBE_KINDS, PATH_KINDS } = require('../db/indicator-registry');

const STAT_KEYS = ['count', 'min', 'p25', 'median', 'mean', 'p75', 'max'];

/**
 * بازگردانی مقدار نمایشی دسته — دقیقاً مثل `consumeRow.restoreCategory`:
 * برای `messageSuccess`/`messageFail` متن قالبی پیام از `message_dict` می‌آید و اگر
 * متنی ثبت نشده باشد «سایر پیامها».
 */
let messageTextMap = null;
function catLabelOf(catId, value) {
  if (catId !== 'messageSuccess' && catId !== 'messageFail') return String(value);
  if (messageTextMap && messageTextMap.has(String(value))) return messageTextMap.get(String(value));
  return 'سایر پیامها';
}

async function loadMessageTexts(db) {
  if (messageTextMap) return messageTextMap;
  const res = await db.query("SELECT message_key, COALESCE(message_text, label, 'سایر پیامها') AS text FROM message_dict");
  messageTextMap = new Map(res.rows.map((row) => [String(row.message_key), String(row.text)]));
  return messageTextMap;
}

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

  // پرچم‌ها: شمارش بیت‌ها با عملگر بیتی (بدون آرایهٔ سطح‌نمونه در Node)
  for (const [id, mask] of Object.entries(masks)) {
    selects.push(
      `COUNT(*) FILTER (WHERE (flags & ${mask.toString()}) <> 0)::int AS ${aliasOf('flag', id)}`,
    );
  }

  // دسته‌ها: کل + تفکیک وضعیت، با همان فیلترهای spec (onlyStatus/excludeValues)
  for (const spec of bank.categories || []) {
    const index = catIds.indexOf(spec.id) + 1;
    if (!index) continue;
    const conds = [`COALESCE(cat_codes[${index}], 0) > 0`];
    if (spec.onlyStatus === 'success') conds.push('is_success');
    if (spec.onlyStatus === 'fail') conds.push('NOT is_success');
    selects.push(
      `COUNT(*) FILTER (WHERE ${conds.join(' AND ')})::int AS ${aliasOf('catTotal', spec.id)}`,
    );
  }

  // مسیرها: ۲ بیت برای هر مسیر (۱=emptyArray، ۲=emptyObject، ۳=allKeysNull) + rotbe جدا
  const rotbeIndex = registry.path.indexOf('__rotbe');
  const specPathIds = new Set((bank.paths || []).map((spec) => spec.key));
  (registry.path || []).forEach((pathId, pathIndex) => {
    if (pathId === '__rotbe' || !specPathIds.has(pathId)) return;
    for (const [kind, code] of [['emptyArray', 1], ['emptyObject', 2], ['allKeysNull', 3]]) {
      selects.push(
        `COUNT(*) FILTER (WHERE ((path_bits >> ${BigInt(pathIndex) * 2n}) & 3) = ${code})::int AS ${aliasOf('path', `${pathId}|${kind}`)}`,
      );
    }
  });
  if (rotbeIndex >= 0 && (bank.paths || []).length) {
    for (const kind of ROTBE_KINDS) {
      const code = ROTBE_KINDS.indexOf(kind) + 1;
      selects.push(
        `COUNT(*) FILTER (WHERE rotbe_code = ${code})::int AS ${aliasOf('rotbe', kind)}`,
      );
    }
  }

  // جدول متقاطع: هر ترکیب بیت‌های ردیف/ستون‌ها
  for (const spec of bank.cross || []) {
    if (!masks[spec.row] || spec.cols.some((col) => !masks[col.flag])) continue;
    const bits = [masks[spec.row], ...spec.cols.map((col) => masks[col.flag])];
    // هر ترکیب را با یک شمارش شرطی می‌سازیم (تعداد ترکیب‌ها ≤ ۲^n و n کوچک است)
    const combinations = 1 << bits.length;
    for (let combo = 0; combo < combinations; combo++) {
      const conds = bits.map((mask, position) => {
        const on = (combo >> (bits.length - 1 - position)) & 1;
        const test = `(flags & ${mask.toString()}) <> 0`;
        return on ? test : `NOT ${test}`;
      });
      const key = bits.map((_, position) => (combo >> (bits.length - 1 - position)) & 1).join('');
      selects.push(
        `COUNT(*) FILTER (WHERE ${conds.join(' AND ')})::int AS ${aliasOf('cross', `${spec.id}|${key}`)}`,
      );
    }
  }

  // سرویس‌ها: ۳ بیت به‌ازای هر سرویس (۰=missingService، ۱=ok، ۲=failed، ۳=other، ۴/۵=status)
  const SERVICE_CODES = [['missingService', 0], ['ok', 1], ['failed', 2], ['other', 3], ['missingStatus', 4], ['invalidStatus', 5]];
  (registry.service || []).forEach((serviceId, index) => {
    const shift = BigInt(index) * 3n;
    for (const [kind, code] of SERVICE_CODES) {
      selects.push(
        `COUNT(*) FILTER (WHERE ((service_kinds >> ${shift.toString()}) & 7) = ${code})::int AS ${aliasOf('service', `${serviceId}|${kind}`)}`,
      );
    }
  });

  return {
    table,
    sql: (dayFilter) => `SELECT ${selects.join(',\n  ')} FROM ${table} WHERE ${dayFilter}`,
    masks,
  };
}

/** نام ستون خروجی SQL (alias) — شناسه‌ها می‌توانند کاراکتر غیرمجاز داشته باشند */
function aliasOf(prefix, id) {
  return `"${prefix}__${Buffer.from(String(id), 'utf8').toString('hex')}"`;
}

function decodeAlias(alias) {
  // درایور `pg` کوتیشن نام ستون را حذف می‌کند؛ در تست‌های خالص ممکن است باقی بماند
  const match = /^"?(flag|catTotal|crossRow|cross|service|path|rotbe)__([0-9a-f]+)"?$/.exec(alias);
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
 * تجمیع کامل یک بازه به شکل دقیقاً برابر با `bump()` (بدون هیچ پیمایش ردیفی در Node).
 * روزِ `complete` از `day_rollup` خوانده می‌شود؛ روز ناقص/جاری از جدول نمونه.
 */
async function aggregateRange(ctx) {
  const {
    db, evaluator, registryBundle, bankKey, fromIso, toIso, completeDays = new Set(),
  } = ctx;
  const registry = registryBundle.registry || registryBundle;
  const bank = evaluator.getBank(bankKey);
  const agg = buildDayAggregateSql(bankKey, registry[bankKey], bank);
  await loadMessageTexts(db);

  const flags = record();
  const catTotals = record();
  const cats = record();
  const catSplit = record();
  const catAlerts = record();
  const cross = record();
  const services = record();
  const paths = record();

  // ۱) روزهای کامل از rollup (ارزان) — ۲) بقیه از SQL مستقیم
  const rollupRes = await db.query(
    `SELECT day, stats FROM day_rollup WHERE bank=$1 AND day BETWEEN $2::date AND $3::date`,
    [bankKey, fromIso, toIso],
  );
  const rollupByDay = new Map(
    rollupRes.rows.map((row) => [toJalaliDay(row.day), row.stats || {}]),
  );
  const sqlDays = [];
  const decodeDay = (day) => (day instanceof Date ? toJalaliDay(day) : String(day));
  for (const day of ctx.days || []) {
    const iso = toDateIso(day);
    const cached = rollupByDay.get(day);
    if (completeDays.has(day) && cached) {
      // ادغام جمع‌ها (کوانتایل‌ها بعداً از توزیع مشترک محاسبه می‌شوند)
      mergeStats({ flags, catTotals, cats, catSplit, cross, services, paths }, cached);
    } else {
      sqlDays.push(iso);
    }
  }
  if (sqlDays.length) {
    const dayFilter = sqlDays.length === 1
      ? 'day = $1::date'
      : 'day = ANY($1::date[])';
    const result = await db.query(agg.sql(dayFilter), [sqlDays]);
    applyAggregateRow(result.rows[0] || {}, { flags, catTotals, cross, services, paths, bank });
    // bump برای هر spec مسیر همیشه یک ورودی می‌سازد (حتی با شمارش صفر) ⇒ همین‌جا هم
    for (const pathId of [...(bank.paths || []).map((spec) => spec.key), '__rotbe']) {
      paths[pathId] ||= { empty: 0, kinds: record() };
      for (const kind of Object.keys(paths[pathId].kinds)) {
        if (!paths[pathId].kinds[kind]) delete paths[pathId].kinds[kind];
      }
    }
  }

  // تفکیک مقدار دسته‌ها (cats/catSplit) — با همان قواعد bump:
  //  * onlyStatus یعنی فقط ردیف‌های همان وضعیت شمرده می‌شوند (بقیه صفر می‌مانند)
  //  * excludeValues یعنی مقدار کلاً شمرده نمی‌شود
  const specById = new Map((bank.categories || []).map((spec) => [spec.id, spec]));
  const catUnion = [];
  for (const spec of bank.categories || []) {
    const index = registry[bankKey].cat.indexOf(spec.id) + 1;
    if (!index) continue;
    // کدهای مستثنی از `cat_dict` خوانده می‌شوند (کد→مقدار)
    catUnion.push({
      catId: spec.id,
      index,
      sql: `SELECT ${index}::int AS cat_index, cat_codes[${index}]::int AS code, is_success
              FROM ${agg.table}
             WHERE day = ANY($1::date[]) AND COALESCE(cat_codes[${index}], 0) > 0`,
    });
  }
  if (catUnion.length && sqlDays.length) {
    const catRes = await db.query(
      `WITH codes AS (${catUnion.map((item) => item.sql).join(' UNION ALL ')})
       SELECT cat_index, code, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_success)::int AS success
         FROM codes GROUP BY cat_index, code`,
      [sqlDays],
    );
    const dictRes = await db.query(
      'SELECT cat_code, value_code, value FROM cat_dict WHERE bank=$1',
      [bankKey],
    );
    const dict = new Map(dictRes.rows.map((row) => [`${row.cat_code}:${row.value_code}`, row.value]));
    for (const entry of catRes.rows) {
      const catId = registry[bankKey].cat[Number(entry.cat_index) - 1];
      if (!catId) continue;
      const rawValue = dict.get(`${entry.cat_index}:${entry.code}`);
      if (rawValue === undefined) continue;
      const spec = specById.get(catId) || {};
      if (spec.excludeValues?.includes(rawValue)) continue;
      const value = catLabelOf(catId, rawValue);
      const totalCount = Number(entry.total);
      const successCount = Number(entry.success);
      let bucketTotal = totalCount;
      let bucketSuccess = successCount;
      if (spec.onlyStatus === 'success') { bucketTotal = successCount; }
      if (spec.onlyStatus === 'fail') { bucketTotal = totalCount - successCount; bucketSuccess = 0; }
      if (!bucketTotal) continue;
      cats[catId] ||= record();
      cats[catId][value] = (cats[catId][value] || 0) + bucketTotal;
      const split = (catSplit[catId] ||= record());
      split[value] ||= { success: 0, fail: 0 };
      split[value].success += bucketSuccess;
      split[value].fail += bucketTotal - bucketSuccess;
    }
  }

  // هشدارهای اعتباری روی مقادیر هشدار (catAlerts) — مثل bump
  for (const spec of bank.categories || []) {
    if (!spec.alertSummaryValues?.length) continue;
    const index = registry[bankKey].cat.indexOf(spec.id) + 1;
    if (!index || !sqlDays.length) continue;
    const codes = await db.query(
      `SELECT DISTINCT cat_codes[${index}] AS code FROM ${agg.table}
        WHERE day = ANY($1::date[]) AND COALESCE(cat_codes[${index}], 0) > 0`,
      [sqlDays],
    );
    const dictRes = await db.query('SELECT value_code, value FROM cat_dict WHERE bank=$1 AND cat_code=$2', [bankKey, index]);
    const dict = new Map(dictRes.rows.map((row) => [Number(row.value_code), row.value]));
    for (const row of codes.rows) {
      const value = dict.get(Number(row.code));
      if (value === undefined || !spec.alertSummaryValues.includes(value)) continue;
      const counts = await db.query(
        `SELECT COUNT(*) FILTER (WHERE has_overdue)::int AS overdue,
                COUNT(*) FILTER (WHERE has_cheque)::int AS cheque,
                COUNT(*) FILTER (WHERE has_overdue AND has_cheque)::int AS both
           FROM ${agg.table}
          WHERE day = ANY($1::date[]) AND cat_codes[${index}] = $2`,
        [sqlDays, Number(row.code)],
      );
      catAlerts[spec.id] ||= record();
      catAlerts[spec.id][value] = {
        overdue: Number(counts.rows[0]?.overdue ?? 0),
        cheque: Number(counts.rows[0]?.cheque ?? 0),
        both: Number(counts.rows[0]?.both ?? 0),
      };
    }
  }

  // کانترها و متریک‌ها با SQL (کوانتایل دقیق از همان توزیع)
  const counters = record();
  for (const id of registry[bankKey].counter || []) {
    const column = require('../db/indicator-registry').columnName('counter', id);
    if (!sqlDays.length) continue; // legacy فقط کانترهای دیده‌شده را دارد (ورودی صفر نمی‌سازد)
    const res = await db.query(
      `SELECT COALESCE(SUM(${column}), 0)::bigint AS v FROM ${agg.table} WHERE day = ANY($1::date[])`,
      [sqlDays],
    );
    const sum = Number(res.rows[0]?.v ?? 0);
    if (!sum) continue;
    counters[id] = sum;
  }
  const metrics = record();
  for (const id of registry[bankKey].metric || []) {
    const column = require('../db/indicator-registry').columnName('metric', id);
    const res = await db.query(
      `SELECT COUNT(*)::int AS count, MIN(${column}) AS min, MAX(${column}) AS max,
              AVG(${column}) AS mean,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY ${column}) AS p25,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ${column}) AS median,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY ${column}) AS p75
         FROM ${agg.table} WHERE day = ANY($1::date[]) AND ${column} IS NOT NULL`,
      [sqlDays.length ? sqlDays : [toDateIso(ctx.days?.[0] || '1400-01-01')]],
    );
    const rowStats = res.rows[0] || {};
    if (!Number(rowStats.count ?? 0)) continue; // legacy فقط متریک‌های دیده‌شده را دارد
    metrics[id] = {
      count: Number(rowStats.count ?? 0),
      min: rowStats.min === null ? null : Number(rowStats.min),
      max: rowStats.max === null ? null : Number(rowStats.max),
      mean: rowStats.mean === null ? null : Number(rowStats.mean),
      p25: rowStats.p25 === null ? null : Number(rowStats.p25),
      median: rowStats.median === null ? null : Number(rowStats.median),
      p75: rowStats.p75 === null ? null : Number(rowStats.p75),
    };
  }

  // آمار هر روز (برای `daily` در `/api/summary`)
  const daily = [];
  if (sqlDays.length) {
    const dailyRes = await db.query(
      `SELECT day, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_success)::int AS success
         FROM ${agg.table} WHERE day = ANY($1::date[]) GROUP BY day`,
      [sqlDays],
    );
    const flagColumns = Object.entries(agg.masks)
      .map(([id, mask]) => `COUNT(*) FILTER (WHERE (flags & ${mask.toString()}) <> 0)::int AS ${aliasOf('flag', id)}`);
    const dailyFlags = await db.query(
      `SELECT day, ${flagColumns.join(', ')} FROM ${agg.table}
        WHERE day = ANY($1::date[]) GROUP BY day`,
      [sqlDays],
    );
    const isoKeyOf = (value) => (value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10));
    const flagByDay = new Map(dailyFlags.rows.map((row) => [isoKeyOf(row.day), row]));
    for (const row of dailyRes.rows) {
      const isoKey = isoKeyOf(row.day);
      const flagRow = flagByDay.get(isoKey) || {};
      const dayFlags = {};
      for (const [column, value] of Object.entries(flagRow)) {
        const decoded = decodeAlias(column);
        if (decoded?.kind === 'flag' && Number(value)) dayFlags[decoded.id] = Number(value);
      }
      daily.push({
        day: toJalaliDay(isoKey),
        total: Number(row.total ?? 0),
        success: Number(row.success ?? 0),
        fail: Number(row.total ?? 0) - Number(row.success ?? 0),
        flags: dayFlags,
      });
    }
  }
  for (const day of ctx.days || []) {
    if (sqlDays.length && daily.some((entry) => entry.day === day)) continue;
    const cached = rollupByDay.get(day);
    if (completeDays.has(day) && cached) {
      daily.push({
        day,
        total: Number(cached.total ?? 0),
        success: Number(cached.byStatus?.success ?? 0),
        fail: Number(cached.byStatus?.fail ?? 0),
        flags: cached.flags || {},
      });
    }
  }
  daily.sort((a, b) => String(a.day).localeCompare(String(b.day)));

  const totals = await totalsOf(db, agg.table, sqlDays, rollupByDay, completeDays, ctx.days || []);
  return {
    stats: {
      total: totals.total,
      byStatus: { success: totals.success, fail: totals.total - totals.success },
      flags,
      cats,
      catTotals,
      catSplit,
      catAlerts,
      cross,
      paths,
      counters,
      metrics,
      services,
    },
    daily,
    rollupDays: [...completeDays].filter((day) => rollupByDay.has(day)).length,
    scannedDays: sqlDays.length,
    agg,
  };
}

/** جمع total/success از rollup‌های آماده + SQL روزهای باقی‌مانده */
async function totalsOf(db, table, sqlDays, rollupByDay, completeDays, days) {
  let total = 0;
  let success = 0;
  for (const day of days) {
    if (completeDays.has(day) && rollupByDay.has(day)) {
      total += Number(rollupByDay.get(day).total ?? 0);
      success += Number(rollupByDay.get(day).byStatus?.success ?? 0);
    }
  }
  if (sqlDays.length) {
    const res = await db.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_success)::int AS success
         FROM ${table} WHERE day = ANY($1::date[])`,
      [sqlDays],
    );
    total += Number(res.rows[0]?.total ?? 0);
    success += Number(res.rows[0]?.success ?? 0);
  }
  return { total, success };
}

function mergeStats(target, stats) {
  const addTo = (dst, src) => {
    for (const [key, value] of Object.entries(src || {})) {
      if (typeof value === 'number') dst[key] = (dst[key] || 0) + value;
      else if (value && typeof value === 'object') {
        dst[key] ||= Object.create(null);
        addTo(dst[key], value);
      }
    }
  };
  addTo(target.flags, stats.flags);
  addTo(target.catTotals, stats.catTotals);
  addTo(target.cats, stats.cats);
  addTo(target.catSplit, stats.catSplit);
  addTo(target.cross, stats.cross);
  addTo(target.services, stats.services);
  addTo(target.paths, stats.paths);
}

function applyAggregateRow(row, { flags, catTotals, cross, services, paths }) {
  for (const [column, value] of Object.entries(row)) {
    const decoded = decodeAlias(column);
    if (!decoded || !Number(value)) continue;
    if (decoded.kind === 'flag') flags[decoded.id] = Number(value);
    if (decoded.kind === 'catTotal') catTotals[decoded.id] = Number(value);
    if (decoded.kind === 'cross') {
      const [crossId, key] = decoded.id.split('|');
      cross[crossId] ||= record();
      cross[crossId][key] = Number(value);
    }
    if (decoded.kind === 'path') {
      const [pathId, kind] = decoded.id.split('|');
      // bump فقط وقتی شمارش > ۰ است ورودی می‌سازد؛ پس این‌جا هم ورودی خالی نسازیم
      paths[pathId] ||= { empty: 0, kinds: record() };
      paths[pathId].empty += Number(value);
      paths[pathId].kinds[kind] = (paths[pathId].kinds[kind] || 0) + Number(value);
    }
    if (decoded.kind === 'rotbe') {
      const entry = (paths.__rotbe ||= { empty: 0, kinds: record() });
      entry.empty += Number(value);
      entry.kinds[decoded.id] = (entry.kinds[decoded.id] || 0) + Number(value);
      void PATH_KINDS;
    }
    if (decoded.kind === 'service') {
      const [serviceId, kind] = decoded.id.split('|');
      services[serviceId] ||= { ok: 0, failed: 0, other: 0, missingStatus: 0, invalidStatus: 0, missingService: 0 };
      services[serviceId][kind] = Number(value);
    }
  }
}

/**
 * ساخت/بازسازی rollup یک روز.
 * @returns {Promise<{bank:string, day:string, rows:number, written:boolean}>}
 */
async function buildDayRollup(db, { bankKey, day, evaluator, registryBundle }) {
  const isoDay = /^1[34]\d{2}-/.test(String(day)) ? toDateIso(String(day)) : String(day);
  const jalaliDay = /^1[34]\d{2}-/.test(String(day)) ? String(day) : toJalaliDay(String(day));
  const version = analysisVersionOf(evaluator, bankKey);
  const aggregated = await aggregateRange({
    db,
    evaluator,
    registryBundle,
    bankKey,
    fromIso: isoDay,
    toIso: isoDay,
    days: [jalaliDay],
    completeDays: new Set(), // فقط SQL — rollup در همین لحظه ساخته می‌شود
  });
  const stats = aggregated.stats;
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
  return { bank: bankKey, day: jalaliDay, rows: stats.total, written: true };
}

module.exports = {
  buildDayRollup,
  aggregateRange,
  buildDayAggregateSql,
  analysisVersionOf,
  STAT_KEYS,
};
