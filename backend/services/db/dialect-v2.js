'use strict';

/**
 * dialect v2 — همان قرارداد `dialect-v1` روی اسکیمای v2.
 *
 * هیچ SQL خامی از سرویس این‌جا اجرا نمی‌شود؛ هر عملیات متد صریح خودش را دارد.
 * ستون‌های `flags/cats/metrics/services/...` که API انتظار دارد این‌جا بازسازی می‌شوند
 * (`hydrate`)، پس سرویس‌های presentation و گزارش HTML دست نخورده می‌مانند.
 */

const { flagMasks } = require('./indicator-registry');
const { tableNameOf } = require('./schema-v2-builder');
const {
  fromV2Row, toDateIso, toJalaliDay, stampEpochMs, stampDigitsFromEpoch, columnMapsOf,
} = require('./row-mapper-v2');

/** ترتیب کلیدهای jsonb در پستگرس: ابتدا طول، سپس مقایسهٔ بایتی */
function jsonbKeyOrder(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return ab.length - bb.length;
  return Buffer.compare(ab, bb);
}

const BANK_OF_TABLE = {
  samples_mellat: 'tavan_mellat',
  samples_resalat: 'tavan_resalat',
  samples_postbank: 'tavan_postbank',
};

class V2Dialect {
  /**
   * @param {{query: Function}} db
   * @param {{registry: Record<string, object>, listSpecs?: Record<string, string[]>}} options
   */
  constructor(db, { registry, listSpecs = {} }) {
    this.db = db;
    this.registry = registry;
    this.listSpecs = listSpecs;
    this.valueDict = new (require('./value-dict').ValueDict)(db);
    this.catDict = require('./schema-v2-builder').createCatDict(db);
    this.loaded = false;
  }

  get name() {
    return 'v2';
  }

  async ready() {
    if (this.loaded) return;
    await this.valueDict.load();
    await this.catDict.load();
    this.loaded = true;
  }

  invalidate() {
    this.valueDict.invalidate();
    this.loaded = false;
  }

  bankOf(table) {
    const bankKey = BANK_OF_TABLE[table];
    if (!bankKey) throw new Error(`V2Dialect: جدول ناشناخته ${table}`);
    return bankKey;
  }

  isoRange(from, to) {
    const asIso = (value) => {
      const text = String(value ?? '');
      // روز شمسی ۱۳xx/۱۴xx → میلادی؛ تاریخ میلادی همان‌طور می‌ماند
      return /^1[34]\d{2}-\d{2}-\d{2}$/.test(text) ? toDateIso(text) : text;
    };
    return [asIso(from), asIso(to)];
  }

  /** ستون‌های کامل (شامل جزئیات jsonb) — برای buildDashboard/گزارش */
  selection(bankKey, alias = 's') {
    return `${alias}.*, d.flag_extra, d.cat_extra, d.list_extra, d.rank_extra, d.credit_extra, d.credit_value, d.summary_extra, ${alias}.day AS day_iso`;
  }

  /**
   * ستون‌های سبک برای `/api/list` — فهرست عمومی به `sample_detail` نیازی ندارد.
   * علت: خواندن jsonb جزئیات ۱۰۰ ردیف ≈ ۶۸ کیلوبایت JSON بود که همان ۳۰ میلی‌ثانیهٔ
   * اختلاف با v1 را می‌ساخت.
   */
  listSelection(alias = 's') {
    return `${alias}.request_id, ${alias}.external_id, ${alias}.unique_key, ${alias}.day AS day_iso,
      ${alias}.ts, ${alias}.is_success, ${alias}.model_code, ${alias}.status_code, ${alias}.error_code,
      ${alias}.message_code, ${alias}.total_time_s, ${alias}.pd, ${alias}.suggested_amount,
      ${alias}.amount_kind, ${alias}.score_req, ${alias}.flags, ${alias}.cat_codes,
      ${alias}.has_overdue, ${alias}.cheque_count, ${alias}.cheque_amount,
      ${alias}.overdue_count, ${alias}.overdue_amount, ${alias}.has_cheque,
      d.credit_value`;
  }

  joinDetail(table, bankKey) {
    return `FROM ${table} s
      LEFT JOIN sample_detail d
        ON d.bank = '${bankKey}' AND d.day = s.day AND d.request_id = s.request_id`;
  }

  /** ردیف v2 → شکل v1 (همان چیزی که consumeRow/UI می‌خواهد) */
  hydrate(bankKey, row) {
    return fromV2Row({
      sample: row,
      detail: {
        flag_extra: row.flag_extra,
        cat_extra: row.cat_extra,
        list_extra: row.list_extra,
        rank_extra: row.rank_extra,
        credit_extra: row.credit_extra,
        credit_value: row.credit_value,
        summary_extra: row.summary_extra,
      },
      valueDict: this.valueDict,
      catDict: this.catDict,
      bankKey,
      registry: {
        ...this.registry[bankKey],
        ...columnMapsOf(this.registry[bankKey]),
        listSpecs: this.listSpecs[bankKey] || [],
      },
    });
  }

  async countRange(table, from, to) {
    const [fromIso, toIso] = this.isoRange(from, to);
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS total FROM ${table} WHERE day BETWEEN $1::date AND $2::date`,
      [fromIso, toIso],
    );
    return { rows: result.rows };
  }

  async days(table, from, to) {
    const [fromIso, toIso] = this.isoRange(from, to);
    const result = await this.db.query(
      `SELECT DISTINCT day FROM ${table} WHERE day BETWEEN $1::date AND $2::date ORDER BY day`,
      [fromIso, toIso],
    );
    return { rows: result.rows.map((row) => ({ day: toJalaliDay(row.day) })) };
  }

  /**
   * کشف «سرویس‌های موجود» — در v1 از `display_extras.serviceKeys` هر ردیف می‌آمد،
   * در v2 از رجیستری (که همان فهرست است). خروجی دقیقاً هم‌شکل v1 تا سرویس دست نخورد.
   */
  async serviceDiscovery(table, from, to) {
    const bankKey = this.bankOf(table);
    return {
      rows: [{
        display_extras: { serviceKeys: [...this.registry[bankKey].service] },
        services: Object.fromEntries(this.registry[bankKey].service.map((id) => [id, 'ok'])),
      }],
      rowCount: 1,
    };
  }

  /**
   * صفحهٔ cursor برای `buildDashboard`.
   * cursor در v1 سه‌تایی `(day, stamp_key, request_id)` است؛ در v2 `(day, ts, request_id)`.
   */
  async cursorPage(table, from, to, cursor, limit) {
    const bankKey = this.bankOf(table);
    const [fromIso, toIso] = this.isoRange(from, to);
    const [cursorDay, cursorStamp, cursorId] = cursor;
    const ts = cursorStamp ? stampEpochMs(cursorStamp) : null;
    const result = await this.db.query(
      `SELECT ${this.selection(bankKey)}
         ${this.joinDetail(table, bankKey)}
        WHERE s.day BETWEEN $1::date AND $2::date
          AND (s.day, COALESCE(s.ts, 0), COALESCE(s.external_id, s.request_id::text)) >
              (COALESCE(NULLIF($3, '')::date, DATE '1900-01-01'),
               COALESCE($4::bigint, 0),
               $5::text)
        ORDER BY s.day, COALESCE(s.ts, 0), COALESCE(s.external_id, s.request_id::text)
        LIMIT $6::int`,
      [fromIso, toIso, cursorDay || '', ts === null ? null : String(ts), cursorId || '', Number(limit)],
    );
    return { rows: result.rows.map((row) => this.hydrate(bankKey, row)), rowCount: result.rows.length };
  }

  /**
   * `/api/list` روی v2.
   * ورودی همان `{type, id, value, status}` است که v1 از پارامترها می‌ساخت.
   */
  async list({ table, params = {}, type, id, value, status, limit, offset, from, to }) {
    const bankKey = this.bankOf(table);
    // همان قواعد تفسیر `type/id/value` که `dialect-v1.buildList` دارد
    if (!type) {
      const raw = params.indicator || '';
      type = params.type || 'flag';
      id = params.id || '';
      if (!params.type && raw.includes(':')) {
        const [prefix, ...rest] = raw.split(':');
        if (['flag', 'metric', 'cat', 'service'].includes(prefix)) {
          type = prefix;
          id = rest.join(':');
        }
      } else if (!params.type && raw) {
        id = raw;
      }
      if (!id && raw === 'slow') { type = 'slow'; id = 'slow'; }
      if (!id && raw === 'creditAlert') { type = 'creditAlert'; id = 'creditAlert'; }
    }
    value = value ?? params.value;
    status = status ?? params.status;
    const registry = this.registry[bankKey];
    const masks = flagMasks(registry);
    const { metricColumnMap } = columnMapsOf(registry);
    const [fromIso, toIso] = this.isoRange(from, to);

    const where = ['s.day BETWEEN $1::date AND $2::date'];
    // $3 = بانک (برای join با sample_detail در همین دستور)
    const values = [fromIso, toIso, bankKey];
    const add = (v) => {
      values.push(v);
      return `$${values.length}`;
    };

    // ترتیب معادل v1: شناسهٔ بیرونی (اگر وجود دارد) همان متن v1 است؛ برای UUIDها خود uuid
    const idText = 'COALESCE(s.external_id, s.request_id::text)';
    let order = `s.day, COALESCE(s.ts, 0), ${idText}`;
    if (type === 'flag' && id) {
      const mask = masks[id];
      if (!mask) throw new Error(`V2Dialect: پرچم ناشناخته ${id}`);
      where.push(`(s.flags & ${mask.toString()}) <> 0`);
    } else if (type === 'cat' && id) {
      const catCode = registry.cat.indexOf(id) + 1;
      if (!catCode) throw new Error(`V2Dialect: دستهٔ ناشناخته ${id}`);
      if (value !== undefined && value !== null && value !== '') {
        const code = this.catDict.codeOf(bankKey, catCode, value);
        where.push(`s.cat_codes[${catCode}] = ${add(code)}`);
      } else {
        where.push(`COALESCE(s.cat_codes[${catCode}], 0) > 0`);
      }
    } else if (type === 'metric' && id) {
      const column = metricColumnMap[id];
      if (!column) throw new Error(`V2Dialect: متریک ناشناخته ${id}`);
      where.push(`s.${column} IS NOT NULL`);
      order = `s.${column} DESC NULLS LAST, ${idText}`;
    } else if (type === 'service' && id) {
      const serviceIndex = registry.service.indexOf(id);
      if (serviceIndex < 0) throw new Error(`V2Dialect: سرویس ناشناخته ${id}`);
      const shift = (BigInt(serviceIndex) * 3n).toString();
      // «ok» = کد ۱؛ هر چیز دیگری (یا اصلاً ماسک صفر) یعنی نقص
      where.push(`((s.service_kinds >> ${shift}) & 7) NOT IN (0, 1)`);
    } else if (type === 'slow') {
      where.push('s.total_time_s > 4');
      order = `s.total_time_s DESC NULLS LAST, ${idText}`;
    } else if (type === 'creditAlert') {
      where.push('(s.has_overdue OR s.has_cheque)');
    } else if (type === 'all') {
      // بدون فیلتر
    } else if (id) {
      const mask = masks[id];
      if (!mask) throw new Error(`V2Dialect: پرچم ناشناخته ${id}`);
      where.push(`(s.flags & ${mask.toString()}) <> 0`);
    }
    if (status === 'success' || status === 'fail') {
      where.push(`s.is_success = ${add(status === 'success')}`);
    }

    const result = await this.db.query(
      `SELECT COUNT(*) OVER() AS total_count, ${this.listSelection()}
         FROM ${table} s
         LEFT JOIN sample_detail d ON d.bank = $3::text AND d.day = s.day AND d.request_id = s.request_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT ${add(limit)}::int OFFSET ${add(offset)}::int`,
      values,
    );

    // نگاشت سبک: فهرست به jsonb‌های `sample_detail` نیازی ندارد (۶۸KB→۰ در ۱۰۰ ردیف)
    const masksForList = masks;
    const dict = this.valueDict;
    const catDict = this.catDict;
    const catIds = registry.cat;
    const rows = result.rows.map((row) => {
      const stamp = row.ts ? stampDigitsFromEpoch(row.ts) : null;
      const onFlags = [];
      for (const [flagId, mask] of Object.entries(masksForList)) {
        if ((BigInt(row.flags ?? 0) & mask) !== 0n) onFlags.push(flagId);
      }
      // مثل v1: همهٔ پرچم‌ها با مقدار بولی (خاموش‌ها false) و به ترتیب کلید jsonb
      const flagEntries = Object.entries(masksForList)
        .map(([flagId, mask]) => [flagId, (BigInt(row.flags ?? 0) & mask) !== 0n])
        .sort((a, b) => jsonbKeyOrder(a[0], b[0]));
      const cats = {};
      const codes = row.cat_codes || [];
      for (let catIndex = 0; catIndex < codes.length; catIndex += 1) {
        const code = codes[catIndex];
        const catId = catIds[catIndex];
        if (!catId || !code) continue;
        const value = catDict.valueOf(bankKey, catIndex + 1, code);
        if (value !== undefined) cats[catId] = value;
      }
      // اولویت با `credit_alert` ذخیره‌شدهٔ v1 (resalat) و در نبودِ آن همان ساخت مشتق‌شده
      const alerts = row.credit_value
        ? row.credit_value
        : row.has_overdue || row.has_cheque
        ? {
          overdue: row.has_overdue
            ? { bool: true, count: row.overdue_count, totalAmount: row.overdue_amount }
            : null,
          cheque: row.has_cheque
            ? { bool: true, count: row.cheque_count, totalAmount: row.cheque_amount }
            : null,
        }
        : null;
      return {
        request_id: row.external_id || row.request_id,
        unique_key: row.unique_key,
        day: toJalaliDay(row.day_iso),
        inserted_at: stamp,
        stamp_key: stamp,
        is_success: row.is_success,
        model_name: dict.valueOf(bankKey, 'model', row.model_code),
        status_code: dict.valueOf(bankKey, 'status', row.status_code),
        error_code: dict.valueOf(bankKey, 'error', row.error_code),
        message_key: dict.valueOf(bankKey, 'message', row.message_code),
        total_time_s: row.total_time_s,
        pd: row.pd,
        suggested_amount: row.suggested_amount === null || row.suggested_amount === undefined
          ? null
          : String(row.suggested_amount),
        amount_kind: dict.valueOf(bankKey, 'amountKind', row.amount_kind),
        score_req: row.score_req,
        flags: Object.fromEntries(flagEntries),
        cats,
        credit_alerts: alerts,
        total_count: Number(row.total_count),
      };
    });
    return {
      type,
      id,
      rows: rows.map((row) => ({
        ...row,
        sid: row.request_id,
        // ترتیب کلیدهای jsonb پستگرس = اول طول، بعد بایت‌به‌بایت
        true_flags: Object.entries(row.flags)
          .filter(([, v]) => v === true)
          .map(([k]) => k)
          .sort(jsonbKeyOrder),
      })),
      total: rows[0]?.total_count ?? 0,
    };
  }

  /**
   * `day_runs` در v2 ستون `day` نوع `date` دارد؛ API روز شمسی می‌خواهد.
   * این متد همان شکل ردیف v1 را برمی‌گرداند تا خروجی `/api/summary` یکسان بماند.
   */
  async runs(limit = 200) {
    const result = await this.db.query(
      `SELECT bank, day, mode, status, source_total, ingested_count, distinct_stored,
              skipped_other_method, error_count, success_count, fail_count, checkpoint,
              analysis_version, started_at, finished_at, error, updated_at
         FROM day_runs ORDER BY day DESC, bank LIMIT $1::int`,
      [Number(limit)],
    );
    return {
      rows: result.rows.map((row) => ({
        bank: row.bank,
        day: toJalaliDay(row.day),
        mode: row.mode,
        status: row.status,
        source_total: row.source_total,
        ingested_count: row.ingested_count ?? row.distinct_stored ?? 0,
        success_count: row.success_count ?? 0,
        fail_count: row.fail_count ?? 0,
        skipped_count: row.skipped_other_method ?? 0,
        checkpoint: row.checkpoint,
        analysis_version: row.analysis_version,
        started_at: row.started_at,
        finished_at: row.finished_at,
        error: row.error,
        updated_at: row.updated_at,
      })),
    };
  }

  /** `day_runs` برای بازه (buildDashboard) — همان شکل v1 */
  async runsRange(bankKey, from, to) {
    const [fromIso, toIso] = this.isoRange(from, to);
    const result = await this.db.query(
      `SELECT bank, day, mode, status, source_total, ingested_count, distinct_stored,
              skipped_other_method, error_count, success_count, fail_count, checkpoint,
              analysis_version, started_at, finished_at, error, updated_at
         FROM day_runs WHERE bank=$1 AND day BETWEEN $2::date AND $3::date ORDER BY day DESC`,
      [bankKey, fromIso, toIso],
    );
    return {
      rows: result.rows.map((row) => ({
        ...row,
        day: toJalaliDay(row.day),
        ingested_count: row.ingested_count ?? row.distinct_stored ?? 0,
        success_count: row.success_count ?? 0,
        fail_count: row.fail_count ?? 0,
        skipped_count: row.skipped_other_method ?? 0,
      })),
      rowCount: result.rows.length,
    };
  }

  /** جست‌وجوی ردیف بر اساس request_id (برای `/api/sample/:id`) */
  async byRequestId(table, requestId) {
    const bankKey = this.bankOf(table);
    const { ensureUuid } = require('./uuid-map');
    // شناسهٔ بیرونی (غیر-UUID) هم پشتیبانی می‌شود تا `/api/sample/:id` مثل قبل کار کند
    const result = await this.db.query(
      `SELECT ${this.selection(bankKey)}
         ${this.joinDetail(table, bankKey)}
        WHERE (s.external_id = $1::text OR s.request_id = $2::uuid)`,
      [String(requestId), ensureUuid(requestId)],
    );
    return { rows: result.rows.map((row) => this.hydrate(bankKey, row)), rowCount: result.rows.length };
  }

  /** last/first stamp برای بازه (معادل انتخاب `display_extras.stamp` در v1) */
  async stampRange(table, from, to) {
    const [fromIso, toIso] = this.isoRange(from, to);
    const result = await this.db.query(
      `SELECT MIN(s.ts) AS first_ts, MAX(s.ts) AS last_ts FROM ${table} s
        WHERE s.day BETWEEN $1::date AND $2::date`,
      [fromIso, toIso],
    );
    const row = result.rows[0] || {};
    return {
      first: row.first_ts ? stampDigitsFromEpoch(row.first_ts) : null,
      last: row.last_ts ? stampDigitsFromEpoch(row.last_ts) : null,
    };
  }
}

module.exports = { V2Dialect, BANK_OF_TABLE };
