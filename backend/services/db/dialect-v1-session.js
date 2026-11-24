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

    /** `/api/list` — SQL همان v1، با keyset cursor برای فهرست اصلی */
    async list({ table, params }) {
      const sqlParams = [params.from, params.to];
      const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 50);
      const offset = Math.max(Number(params.offset ?? 0) || 0, 0);
      const built = v1.buildList({ table, params, sqlParams });
      const baseWhere = built.where;
      let cursorState = null;
      const canCursor = built.order === 'day, COALESCE(stamp_key, \'\'), request_id';
      if (params.cursor && canCursor) {
        try {
          const parsed = JSON.parse(Buffer.from(String(params.cursor), 'base64url').toString('utf8'));
          if (parsed && typeof parsed.d === 'string' && typeof parsed.s === 'string' && typeof parsed.id === 'string') cursorState = parsed;
        } catch { /* cursor نامعتبر ⇒ صفحهٔ اول/offset امن */ }
      }
      if (cursorState) {
        const dayParam = `$${sqlParams.push(cursorState.d)}`;
        const stampParam = `$${sqlParams.push(cursorState.s)}`;
        const idParam = `$${sqlParams.push(cursorState.id)}`;
        built.where += ` AND (day, COALESCE(stamp_key, ''), request_id) > (${dayParam}::text, ${stampParam}::text, ${idParam}::text)`;
      }
      sqlParams.push(limit);
      const limitParam = `$${sqlParams.length}`;
      const offsetParam = cursorState ? null : `$${sqlParams.push(offset)}`;
      const result = await db.query(
        `${v1.listSql({ table, where: built.where, order: built.order })}
         LIMIT ${limitParam}${offsetParam ? ` OFFSET ${offsetParam}` : ''}`,
        sqlParams,
      );
      let total = Number(result.rows[0]?.total_count ?? 0);
      if (cursorState) {
        const count = await db.query(
          `SELECT COUNT(*)::int AS total FROM ${table} WHERE day BETWEEN $1 AND $2 ${baseWhere}`,
          sqlParams.slice(0, 2 + (sqlParams.length - 2 - 4)),
        );
        total = Number(count.rows[0]?.total ?? 0);
      }
      const rows = result.rows.map((row) => ({
        ...row,
        sid: row.request_id,
        total_count: Number(row.total_count),
        true_flags: Object.entries(row.flags && typeof row.flags === 'object' ? row.flags : {})
          .filter(([, v]) => v === true)
          .map(([k]) => k),
      }));
      const last = result.rows.at(-1);
      const nextCursor = canCursor && rows.length === limit && last
        ? Buffer.from(JSON.stringify({ d: String(last.day), s: String(last.stamp_key ?? ''), id: String(last.request_id) }), 'utf8').toString('base64url')
        : null;
      return { type: built.type, id: built.id, rows, total, nextCursor };
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
