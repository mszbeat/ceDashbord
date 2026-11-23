'use strict';

/**
 * نقشه‌برداری دوطرفهٔ ردیف نسخهٔ ۱ (خروجی `evaluator.evaluate`) ↔ ردیف‌های v2:
 *   row v1  ──toV2Row──▶  { sampleRow, detailRow, serviceTextRow }
 *   { sampleRow, detailRow } ──fromV2Row──▶ ردیفی با همان شکل v1 (سازگار با consumeRow)
 *
 * قواعد:
 *  - flags → یک `bigint` بیت‌ماسک (ترتیب = رجیستری).
 *  - metrics/counters → ستون‌های typed `m_*`/`c_*`.
 *  - strings کم‌تنوع (model/status/error/message/amountKind) → کد در `value_dict`.
 *  - cats → `cat_codes smallint[]` + `cat_dict`.
 *  - paths → ۲ بیت/مسیر در `path_bits` + جزئیات در `sample_detail`.
 *  - services → ۳ بیت/سرویس در `service_kinds` + متن `reason` در `service_text_codes`.
 *  - display_extras → فقط بخش نمایشی لازم، اسپارس در `sample_detail`؛ `base`/`stamp`
 *    بازسازی می‌شود (چون از خود ردیف قابل ساخت است).
 */

const {
  KIND, flagMasks, packServiceKinds, SERVICE_KIND_CODE, ROTBE_KINDS, PATH_KINDS, columnName,
} = require('./indicator-registry');

const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/** کلیدهای پایهٔ مشترک در `display_extras.base` که از خود ردیف بازسازی می‌شوند */
const SUMMARY_STANDARD_KEYS = new Set([
  'uniqueKey', 'requestId', 'تاریخ و ساعت', 'وضعیت', '__st', '__sid',
]);

// ───────────────────────────── تبدیل تاریخ ─────────────────────────────

function jalaliToGregorian(jy, jm, jd) {
  // الگوریتم JDF (پایهٔ ۳۳ ساله) — معکوسِ دقیقِ gregorianToJalali پایین
  const jy2 = jy + 1595;
  let days = -355668 + 365 * jy2 + Math.floor(jy2 / 33) * 8 + Math.floor(((jy2 % 33) + 3) / 4) + jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 13 && gd > monthDays[gm]) {
    gd -= monthDays[gm];
    gm++;
  }
  return { year: gy, month: gm, day: gd };
}

function gregorianToJalali(gy, gm, gd) {
  const gDaysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) + gd;
  for (let i = 0; i < gm - 1; i++) days += gDaysInMonth[i];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return { year: jy, month: jm, day: jd };
}

/** روز شمسی `YYYY-MM-DD` → رشتهٔ میلادی `YYYY-MM-DD` برای ستون `date` */
function toDateIso(day) {
  const digits = String(day ?? '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  const g = jalaliToGregorian(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8)));
  return `${g.year}-${String(g.month).padStart(2, '0')}-${String(g.day).padStart(2, '0')}`;
}

/** میلادی `YYYY-MM-DD` → شمسی `YYYY-MM-DD`.
 *
 * ⚠️ هرگز از getUTC* استفاده نکنیم: pg ستون `date` را به Date meia-night UTC می‌فرستد
 * و منطقه زمانی تهران (+۳:۳۰) باعث Shift یک روزه می‌شود.
 * اگر رشته YYYY-MM-DD是谁، trực구나 پارس می‌کنیم؛ اگر Date گرفت، از متدهای محلی (getFullYear/getMonth/getDate) استفاده می‌کنیم.
 */
function toJalaliDay(isoDay) {
  if (isoDay == null) return '';
  // رشته YYYY-MM-DD → پارس مستقیم بدون تبدیل به Date
  if (typeof isoDay === 'string') {
    const m = String(isoDay).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const j = gregorianToJalali(Number(m[1]), Number(m[2]), Number(m[3]));
      return `${j.year}-${String(j.month).padStart(2, '0')}-${String(j.day).padStart(2, '0')}`;
    }
    return String(isoDay);
  }
  // آبجکت Date → متدهای محلی (نه UTC)
  const date = isoDay instanceof Date ? isoDay : new Date(String(isoDay).slice(0, 10));
  if (Number.isNaN(date.getTime())) return String(isoDay ?? '');
  const j = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return `${j.year}-${String(j.month).padStart(2, '0')}-${String(j.day).padStart(2, '0')}`;
}

/** آغاز روز شمسی (`YYYY-MM-DD`) → epoch میلی‌ثانیه — جایگزین امن `ts` */
function dayStartEpochMs(day) {
  const digits = String(day ?? '').replace(/\D/g, '');
  if (digits.length < 8) return 0;
  return stampEpochMs(`${digits.slice(0, 8)}000000000`.slice(0, 17)) ?? 0;
}

/** رشتهٔ ۱۷ رقمی زمان شمسی `YYYYMMDDHHmmssSSS` → epoch میلی‌ثانیه (UTC) */
function stampEpochMs(digits) {
  const text = String(digits ?? '').replace(/\D/g, '');
  if (text.length < 8) return null;
  const jy = Number(text.slice(0, 4));
  const jm = Number(text.slice(4, 6));
  const jd = Number(text.slice(6, 8));
  const hh = text.length >= 10 ? Number(text.slice(8, 10)) : 0;
  const mi = text.length >= 12 ? Number(text.slice(10, 12)) : 0;
  const ss = text.length >= 14 ? Number(text.slice(12, 14)) : 0;
  const ms = text.length >= 17 ? Number(text.slice(14, 17)) : 0;
  if (!(jy >= 1300 && jy <= 1499 && jm >= 1 && jm <= 12 && jd >= 1 && jd <= 31 && hh < 24 && mi < 60 && ss < 60)) {
    return null;
  }
  const g = jalaliToGregorian(jy, jm, jd);
  return Date.UTC(g.year, g.month - 1, g.day, hh, mi, ss, ms) - TEHRAN_OFFSET_MS;
}

/** epoch میلی‌ثانیه → رشتهٔ ۱۷ رقمی زمان شمسی */
function stampDigitsFromEpoch(ms) {
  if (ms === null || ms === undefined) return null;
  const date = ms instanceof Date ? ms : new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return null;
  const tehran = new Date(date.getTime() + TEHRAN_OFFSET_MS);
  const j = gregorianToJalali(tehran.getUTCFullYear(), tehran.getUTCMonth() + 1, tehran.getUTCDate());
  return `${j.year}${String(j.month).padStart(2, '0')}${String(j.day).padStart(2, '0')}` +
    `${String(tehran.getUTCHours()).padStart(2, '0')}${String(tehran.getUTCMinutes()).padStart(2, '0')}` +
    `${String(tehran.getUTCSeconds()).padStart(2, '0')}${String(tehran.getUTCMilliseconds()).padStart(3, '0')}`;
}

// ───────────────────────────── نوشتن (v1 → v2) ─────────────────────────────

/** هر مسیر ۲ بیت: ۰=خالی/غایب، ۱=emptyArray، ۲=emptyObject، ۳=allKeysNull */
function packPathKinds(registry, paths) {
  let bits = 0n;
  registry.path.forEach((id, index) => {
    if (id === '__rotbe') return;
    const raw = paths?.[id] ?? null;
    const code = raw ? PATH_KINDS.indexOf(raw) + 1 : 0;
    if (code) bits |= BigInt(code) << (BigInt(index) * 2n);
  });
  return bits;
}

function unpackPathKinds(registry, bits) {
  const value = BigInt(bits ?? 0);
  const out = {};
  registry.path.forEach((id, index) => {
    if (id === '__rotbe') return;
    const code = Number((value >> (BigInt(index) * 2n)) & 0b11n);
    out[id] = code ? PATH_KINDS[code - 1] : null;
  });
  return out;
}

function packCats(registry, cats, catDict, bankKey) {
  const codes = registry.cat.map((id, index) => {
    const value = cats?.[id];
    if (value === undefined) return 0;
    return catDict.codeOf(bankKey, index + 1, value);
  });
  let end = codes.length;
  while (end > 0 && codes[end - 1] === 0) end--;
  return codes.slice(0, end);
}

/**
 * ردیف v1 → ردیف‌های v2.
 * @param {object} row خروجی `evaluator.evaluate`
 * @param {{bankKey: string, registry: object, valueDict: object, catDict: object,
 *          analysisVersionCode: number, messageKeyId: string}} ctx
 */
function toV2Row(row, ctx) {
  const { bankKey, registry, valueDict, catDict } = ctx;
  const extras = asObject(row.display_extras);
  const flags = asObject(row.flags);

  let bitmask = 0n;
  registry.flag.forEach((id, index) => {
    if (flags[id]) bitmask |= 1n << BigInt(index);
  });

  const stampDigits = extras.stamp?.key ?? row.stamp_key ?? row.inserted_at ?? null;
  // B4: `ts` ستون NOT NULL است. اگر مهر زمانی قابل خواندن نبود، از روز شمسی استفاده می‌شود
  // (همان رفتار v1 که `stampOf` با «—:—» بازمی‌ساخت) تا هیچ ردیفی بی‌ترتیب نماند.
  const ts = stampEpochMs(stampDigits) ?? dayStartEpochMs(row.day);

  // حضور شمارنده‌ها (حتی مقدار ۰) — مسیر قدیمی کلید صفر می‌سازد، SQL فقط با SUM نمی‌تواند
  // تفکیک کند؛ هر شمارنده در یک بیت.
  const counterIds = registry.counter || [];
  const countersOfRow = asObject(row.counters);
  let counterPresent = 0n;
  counterIds.forEach((id, index) => {
    const value = countersOfRow[id];
    if (value !== undefined && value !== null) counterPresent |= 1n << BigInt(index);
  });

  const sampleRow = {
    ts,
    flags: bitmask.toString(),
    service_kinds: packServiceKinds(registry, row.services || {}).toString(),
    path_bits: packPathKinds(registry, row.paths || {}).toString(),
    counter_present: counterPresent.toString(),
    total_time_s: numOrNull(row.total_time_s),
    pd: numOrNull(row.pd),
    score_req: numOrNull(row.score_req),
    avg36: numOrNull(row.avg36),
    ln_avg_installments: numOrNull(row.ln_avg_installments),
    day: toDateIso(row.day),
    suggested_amount: row.suggested_amount === null || row.suggested_amount === undefined ? null : String(row.suggested_amount),
    overdue_amount: row.credit_alerts?.overdue?.totalAmount ?? null,
    cheque_amount: row.credit_alerts?.cheque?.totalAmount ?? null,
    request_id: row.request_id,
    // شناسهٔ اصلی (اگر UUID نبود) تا API همان مقدار قبلی را برگرداند و گزارش‌ها یکسان بمانند
    model_code: valueDict.codeOf(bankKey, 'model', row.model_name),
    status_code: valueDict.codeOf(bankKey, 'status', row.status_code),
    error_code: valueDict.codeOf(bankKey, 'error', row.error_code),
    message_code: valueDict.codeOf(bankKey, 'message', row.message_key),
    rotbe_code: row.rotbe ? ROTBE_KINDS.indexOf(String(row.rotbe)) + 1 || null : null,
    amount_kind: valueDict.codeOf(bankKey, 'amountKind', row.amount_kind),
    overdue_count: numOrNull(row.credit_alerts?.overdue?.count),
    cheque_count: numOrNull(row.credit_alerts?.cheque?.count),
    analysis_version: ctx.analysisVersionCode ?? 1,
    is_success: !!row.is_success,
    has_overdue: !!row.credit_alerts?.overdue?.bool,
    has_cheque: !!row.credit_alerts?.cheque?.bool,
    bad_reports: numOrNull(extras.badReports) ?? 0,
    unique_key: row.unique_key ?? null,
    cat_codes: packCats(registry, asObject(row.cats), catDict, bankKey),
    service_text_codes: [],
  };

  const metrics = asObject(row.metrics);
  const metricColumn = ctx.metricColumnMap || {};
  for (const [id, column] of Object.entries(metricColumn)) {
    sampleRow[column] = numOrNull(metrics[id]);
  }
  const counters = asObject(row.counters);
  const counterColumn = ctx.counterColumnMap || {};
  for (const [id, column] of Object.entries(counterColumn)) {
    const value = numOrNull(counters[id]);
    sampleRow[column] = value === null ? null : Math.round(value);
  }

  // ── جزئیات نمایشی (فقط اگر واقعاً لازم است) ──
  const flagRows = asObject(extras.flagRows);
  const activeFlagRows = {};
  for (const [id, value] of Object.entries(flagRows)) {
    if (flags[id]) activeFlagRows[id] = value;
  }
  const ranks = asObject(extras.ranks);
  const usedRanks = {};
  for (const [id, value] of Object.entries(ranks)) {
    if (value !== null && value !== undefined) usedRanks[id] = value;
  }
  const catRows = asObject(extras.catRows);
  const listMatches = Array.isArray(extras.listMatches) ? extras.listMatches : [];
  const listRows = asObject(extras.listRows);
  const activeListRows = {};
  listMatches.forEach((matched, index) => {
    if (matched && listRows[String(index)] !== undefined) activeListRows[String(index)] = listRows[String(index)];
  });
  const creditRows = asObject(extras.creditAlertRows);
  const activeCredit = {};
  for (const [slot, value] of Object.entries(creditRows)) {
    if (value && Object.keys(asObject(value)).length) activeCredit[slot] = value;
  }

  // ستون‌های نمایندگی هر بانک (مثل «احتمال نکول» پست‌بانک) از summaryCols می‌آیند
  const baseExtras = asObject(extras.base);
  const summaryExtra = {};
  for (const [key, value] of Object.entries(baseExtras)) {
    if (SUMMARY_STANDARD_KEYS.has(key)) continue;
    summaryExtra[key] = value;
  }

  // مقدار کامل `credit_alerts` (مثل currency/totalIssue) فقط وقتی هشداری هست نگه داشته می‌شود
  const creditValue = (row.credit_alerts && (row.credit_alerts.overdue?.bool || row.credit_alerts.cheque?.bool))
    ? row.credit_alerts
    : null;
  const hasDetail = Object.keys(activeFlagRows).length || Object.keys(usedRanks).length ||
    Object.keys(catRows).length || Object.keys(activeListRows).length || Object.keys(activeCredit).length ||
    creditValue !== null || Object.keys(summaryExtra).length > 0;
  const detailRow = hasDetail
    ? {
      bank: bankKey,
      day: toDateIso(row.day),
      request_id: row.request_id,
      flag_bits: bitmask.toString(),
      rank_value: numOrNull(Object.values(usedRanks)[0]),
      cat_extra: Object.keys(catRows).length ? catRows : null,
      list_extra: Object.keys(activeListRows).length ? activeListRows : null,
      flag_extra: Object.keys(activeFlagRows).length ? activeFlagRows : null,
      rank_extra: Object.keys(usedRanks).length ? usedRanks : null,
      credit_extra: Object.keys(activeCredit).length ? activeCredit : null,
      credit_value: creditValue,
      summary_extra: Object.keys(summaryExtra).length ? summaryExtra : null,
    }
    : null;

  return { sampleRow, detailRow };
}

/** کدهای متنی سرویس‌ها (reason) که در ردیف نمونه جا نمی‌شوند */
function serviceTextsOf(row, registry, valueDict, bankKey) {
  const states = asObject(asObject(row.display_extras).serviceStates);
  const codes = [];
  registry.service.forEach((id, index) => {
    const reason = asObject(states[id]).reason;
    codes.push(reason ? valueDict.codeOf(bankKey, 'service', reason) : 0);
  });
  return codes;
}

// ───────────────────────────── خواندن (v2 → v1) ─────────────────────────────

/**
 * ردیف‌های v2 را به شکل v1 برمی‌گرداند؛ همان چیزی که `SummaryService.consumeRow` می‌خواهد.
 * `base` و `stamp` به‌صورت کامل بازسازی می‌شوند تا ستون‌های تکراری ذخیره نشوند.
 */
function fromV2Row({ sample, detail, valueDict, catDict, bankKey, registry, stats }) {
  const status = sample.is_success ? 'success' : 'fail';
  const day = toJalaliDay(sample.day);
  const stampDigits = stampDigitsFromEpoch(sample.ts);

  const flags = {};
  const masks = flagMasks(registry);
  for (const [id, mask] of Object.entries(masks)) flags[id] = (BigInt(sample.flags ?? 0) & mask) !== 0n;

  const cats = {};
  const missStats = stats || {};
  (sample.cat_codes || []).forEach((code, index) => {
    if (!code) return;
    const id = registry.cat[index];
    if (!id) return;
    const value = catDict.valueOf(bankKey, index + 1, code);
    if (value !== undefined) cats[id] = value;
    // کد بدون برچسب: یعنی دیکشنری پس از بارگذاری عوض شده (ingest بعد از startup).
    // `cat_codes` خام نگه داشته می‌شود تا لایهٔ بالاتر بتواند بازخوانی و تکرار کند.
    else missStats.miss = (missStats.miss || 0) + 1;
  });

  const services = {};
  registry.service.forEach((id, index) => {
    const code = Number((BigInt(sample.service_kinds ?? 0) >> (BigInt(index) * 3n)) & 0b111n);
    services[id] = Object.entries(SERVICE_KIND_CODE).find(([, value]) => value === code)?.[0] ?? 'missingService';
  });

  const paths = unpackPathKinds(registry, sample.path_bits);
  if (detail?.path_extra) Object.assign(paths, detail.path_extra);

  const metrics = {};
  for (const [id, column] of Object.entries(registry.metricColumnMap || {})) {
    if (sample[column] !== null && sample[column] !== undefined) metrics[id] = Number(sample[column]);
  }
  const counters = {};
  Object.entries(registry.counterColumnMap || {}).forEach(([id, column]) => {
    if (sample[column] !== null && sample[column] !== undefined) counters[id] = Number(sample[column]);
  });

  const serviceStates = {};
  (sample.service_text_codes || []).forEach((code, index) => {
    const id = registry.service[index];
    if (!id) return;
    const reason = code ? valueDict.valueOf(bankKey, 'service', code) : '';
    serviceStates[id] = { kind: services[id], reason: reason || '', value: services[id] };
  });

  const rowDisplay = stampDigits
    ? `${stampDigits.slice(0, 4)}/${stampDigits.slice(4, 6)}/${stampDigits.slice(6, 8)} ${stampDigits.slice(8, 10)}:${stampDigits.slice(10, 12)}`
    : `${day.replace(/-/g, '/')} —:—`;
  const stamp = {
    key: stampDigits,
    display: stampDigits
      ? `${stampDigits.slice(0, 4)}/${stampDigits.slice(4, 6)}/${stampDigits.slice(6, 8)} ${stampDigits.slice(8, 10)}:${stampDigits.slice(10, 12)}:${stampDigits.slice(12, 14)}`
      : day.replace(/-/g, '/'),
    rowDisplay,
  };

  // همان شکل `baseRow` در evaluator: uniqueKey (به‌جز پست‌بانک) + requestId + ستون‌های summary
  const base = {};
  if (sample.unique_key) base.uniqueKey = sample.unique_key;
  else if (bankKey !== 'tavan_postbank') base.uniqueKey = '—';
  base.requestId = sample.request_id;
  base['تاریخ و ساعت'] = rowDisplay;
  base['وضعیت'] = sample.is_success ? 'موفق' : 'ناموفق';
  // ستون‌های نمایندگی هر بانک (model_name / PD / احتمال نکول / امتیاز …) عیناً بازگردانی می‌شوند
  Object.assign(base, asObject(detail?.summary_extra));
  // v1 این آبجکت را در ستون jsonb ذخیره می‌کرد و پستگرس کلیدها را مرتب برمی‌گرداند؛
  // همان ترتیب را بازمی‌سازیم تا خروجی HTML (ترتیب ستون‌ها) بایت‌به‌بایت یکسان بماند.
  const orderedBase = Object.fromEntries(
    Object.entries(base).sort(([a], [b]) => jsonbKeyOrder(a, b)),
  );

  const extras = {
    base: orderedBase,
    stamp,
    serviceKeys: registry.service.slice(),
    serviceStates,
    flagRows: detail?.flag_extra ?? {},
    ranks: detail?.rank_extra ?? {},
    catRows: detail?.cat_extra ?? {},
    listRows: detail?.list_extra ?? {},
    listMatches: [],
    creditAlertRows: detail?.credit_extra ?? {},
    badReports: Number(sample.bad_reports ?? 0),
  };
  const listSpecs = registry.listSpecs || [];
  extras.listMatches = listSpecs.map((_, index) => extras.listRows[String(index)] !== undefined);

  return {
    request_id: sample.request_id,
    day,
    inserted_at: stampDigits,
    stamp_key: stampDigits,
    unique_key: sample.unique_key,
    is_success: sample.is_success,
    model_name: valueDict.valueOf(bankKey, 'model', sample.model_code),
    status_code: valueDict.valueOf(bankKey, 'status', sample.status_code),
    error_code: valueDict.valueOf(bankKey, 'error', sample.error_code),
    message_key: valueDict.valueOf(bankKey, 'message', sample.message_code),
    total_time_s: sample.total_time_s,
    pd: sample.pd,
    suggested_amount: sample.suggested_amount,
    amount_kind: valueDict.valueOf(bankKey, 'amountKind', sample.amount_kind),
    score_req: sample.score_req,
    avg36: sample.avg36,
    ln_avg_installments: sample.ln_avg_installments,
    rotbe: sample.rotbe_code ? ROTBE_KINDS[Number(sample.rotbe_code) - 1] : null,
    flags,
    cats,
    counters,
    metrics,
    paths,
    services,
    // اگر مقدار کامل ذخیره شده باشد همان برگردانده می‌شود (شامل currency/totalIssue)
    credit_alerts: detail?.credit_value
      ? detail.credit_value
      : (sample.has_overdue || sample.has_cheque
        ? {
          overdue: sample.has_overdue ? { bool: true, count: sample.overdue_count, totalAmount: sample.overdue_amount } : null,
          cheque: sample.has_cheque ? { bool: true, count: sample.cheque_count, totalAmount: sample.cheque_amount } : null,
        }
        : null),
    display_extras: extras,
    analysis_version: String(sample.analysis_version ?? ''),
  };
}

// ───────────────────────────── کمکی‌ها ─────────────────────────────

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

/** ترتیب کلیدهای jsonb در پستگرس: ابتدا طول، سپس مقایسهٔ بایتی */
function jsonbKeyOrder(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return ab.length - bb.length;
  return Buffer.compare(ab, bb);
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatThousands(value) {
  const text = String(value);
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** نگاشت شناسه → نام ستون برای متریک/کانتر (یک‌بار ساخته می‌شود) */
function columnMapsOf(registry) {
  return {
    metricColumnMap: Object.fromEntries(registry.metric.map((id) => [id, columnName(KIND.METRIC, id)])),
    counterColumnMap: Object.fromEntries(registry.counter.map((id) => [id, columnName(KIND.COUNTER, id)])),
  };
}

module.exports = {
  toDateIso,
  dayStartEpochMs,
  toJalaliDay,
  jalaliToGregorian,
  gregorianToJalali,
  stampEpochMs,
  stampDigitsFromEpoch,
  packPathKinds,
  unpackPathKinds,
  packCats,
  jsonbKeyOrder,
  toV2Row,
  serviceTextsOf,
  fromV2Row,
  columnMapsOf,
  formatThousands,
};
