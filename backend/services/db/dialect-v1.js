'use strict';

/**
 * dialect v1 — همان SQL فعلی (jsonb + ستون‌های متنی). مرجع رفتار و «حقیقت پایه».
 *
 * هر تابع این ماژول دقیقاً همان کوئری‌ای را می‌سازد که تا امروز داخل
 * `services/summary/summary.service.js` بود؛ فقط از سرویس بیرون کشیده شده تا
 * `dialect-v2` بتواند همان قرارداد را با اسکیمای جدید پیاده کند.
 */

const PAGE_COLUMNS = `request_id, unique_key, day, inserted_at, stamp_key, is_success, model_name, status_code, error_code,
        message_key, total_time_s, pd, suggested_amount, amount_kind, score_req, flags, cats, credit_alerts`;

const CURSOR_ORDER = "day, COALESCE(stamp_key, ''), request_id";

module.exports = {
  name: 'v1',

  /** ستون‌های لازم برای ساخت ردیف نمایشی (cursor page) */
  cursorSelect(table) {
    return `SELECT * FROM ${table}`;
  },

  cursorWhere: `WHERE day BETWEEN $1 AND $2
           AND (day, COALESCE(stamp_key, ''), request_id) > ($3::text, $4::text, $5::text)
         ORDER BY ${CURSOR_ORDER}
         LIMIT $6`,

  countRange: (table) => `SELECT COUNT(*)::int AS total FROM ${table} WHERE day BETWEEN $1 AND $2`,

  days: (table) => `SELECT DISTINCT day FROM ${table} WHERE day BETWEEN $1 AND $2 ORDER BY day`,

  serviceDiscovery: (table) => `SELECT display_extras, services FROM ${table} WHERE day BETWEEN $1 AND $2`,

  requestLookup: null, // v1 همان UNION فعلی داخل سرویس است

  /** کوئری `/api/list` — عیناً منطق فعلی */
  buildList({ table, params, sqlParams }) {
    const add = (value) => {
      sqlParams.push(value);
      return `$${sqlParams.length}`;
    };
    let type = params.type || 'flag';
    let id = params.id || '';
    const raw = params.indicator || '';
    if (!params.type && raw.includes(':')) {
      const [prefix, ...rest] = raw.split(':');
      if (['flag', 'metric', 'cat', 'service'].includes(prefix)) {
        type = prefix;
        id = rest.join(':');
      }
    } else if (!params.type && raw) {
      id = raw;
    }
    if (!id && raw === 'slow') {
      type = 'slow';
      id = 'slow';
    }
    if (!id && raw === 'creditAlert') {
      type = 'creditAlert';
      id = 'creditAlert';
    }

    let where = '';
    let order = CURSOR_ORDER;
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
      // بدون فیلتر
    } else if (id) {
      where += ` AND flags->>${add(id)} = 'true'`;
      type = 'flag';
    }
    if (params.status === 'success' || params.status === 'fail') {
      where += ` AND is_success = ${add(params.status === 'success')}`;
    }
    return { type, id, where, order };
  },

  listSql: ({ table, where, order }) =>
    `SELECT COUNT(*) OVER() AS total_count, ${PAGE_COLUMNS}
       FROM ${table}
       WHERE day BETWEEN $1 AND $2 ${where}
       ORDER BY ${order}`,

  /** نگاشت ردیف خروجی به شکل API (همان چیزی که سرویس امروز می‌سازد) */
  presentRow: (row) => ({ ...row }),

  /** پارامترهای بازه بدون تبدیل (روز شمسی متن) */
  range: (from, to) => [from, to],
};
