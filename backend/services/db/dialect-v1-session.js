'use strict';

/**
 * پل `dialect-v1` → شیء زنده‌ای که `SummaryService` انتظار دارد.
 *
 * `dialect-v1.js` صرفاً سازندهٔ SQL و منطق است (بدون دسترسی به دیتابیس)؛ این ماژول
 * آن را با یک `db` جفت می‌کند. دلیل جدا بودن: تست‌ها می‌توانند SQL را بدون دیتابیس
 * بررسی کنند و `dialect-v2` هم دقیقاً همین شکل خروجی را بدهد.
 */

const v1 = require('./dialect-v1');

function createV1Session(db) {
  return {
    name: 'v1',

    async serviceDiscovery(table, from, to) {
      return db.query(v1.serviceDiscovery(table), [from, to]);
    },

    async countRange(table, from, to) {
      return db.query(v1.countRange(table), [from, to]);
    },

    async days(table, from, to) {
      return db.query(v1.days(table), [from, to]);
    },

    async cursorPage(table, from, to, cursor, limit) {
      return db.query(v1.cursorWhere ? `${v1.cursorSelect(table)} ${v1.cursorWhere}` : '', [
        from, to, cursor[0], cursor[1], cursor[2], limit,
      ]);
    },

    /** `/api/list` — SQL همان v1، خروجی همان شکل */
    async list({ table, params }) {
      const sqlParams = [params.from, params.to];
      const limit = Math.min(Math.max(Number(params.limit ?? 100) || 100, 1), 100);
      const offset = Math.max(Number(params.offset ?? 0) || 0, 0);
      const built = v1.buildList({ table, params, sqlParams });
      sqlParams.push(limit);
      const limitParam = `$${sqlParams.length}`;
      sqlParams.push(offset);
      const offsetParam = `$${sqlParams.length}`;
      const result = await db.query(
        `${v1.listSql({ table, where: built.where, order: built.order })}
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        sqlParams,
      );
      const rows = result.rows.map((row) => ({
        ...row,
        sid: row.request_id,
        total_count: Number(row.total_count),
        true_flags: Object.entries(row.flags && typeof row.flags === 'object' ? row.flags : {})
          .filter(([, v]) => v === true)
          .map(([k]) => k),
      }));
      return { type: built.type, id: built.id, rows, total: rows[0]?.total_count ?? 0 };
    },

    async byRequestId(table, requestId) {
      // v1: request_id متن است
      return db.query(`SELECT day, is_success, unique_key FROM ${table} WHERE request_id = $1::text`, [
        String(requestId),
      ]);
    },

    async stampRange() {
      return { first: null, last: null };
    },

    async runs(limit = 200) {
      return db.query(`SELECT * FROM day_runs ORDER BY day DESC, bank LIMIT ${Number(limit)}`);
    },

    async runsRange(bankKey, from, to) {
      return db.query('SELECT * FROM day_runs WHERE bank=$1 AND day BETWEEN $2 AND $3 ORDER BY day DESC', [
        bankKey, from, to,
      ]);
    },
  };
}

module.exports = createV1Session;
