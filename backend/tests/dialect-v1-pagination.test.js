'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createV1Session = require('../services/db/dialect-v1-session');

function makeRow(id, requestId) {
  return {
    request_id: requestId,
    day: '1405-08-01',
    stamp_key: `1405080112000${id}`,
    flags: {},
    total_count: 3,
  };
}

test('v1 list continues with a stable cursor and preserves total count', async () => {
  const queries = [];
  let listCalls = 0;
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT COUNT(*)::int AS total')) return { rows: [{ total: 3 }] };
      listCalls += 1;
      if (listCalls === 1) return { rows: [makeRow(1, 'r1'), makeRow(2, 'r2')] };
      return { rows: [makeRow(3, 'r3')] };
    },
  };
  const dialect = createV1Session(db);
  const params = { from: '1405-08-01', to: '1405-08-30', type: 'all', limit: 2 };
  const first = await dialect.list({ table: 'samples_mellat', params });
  assert.equal(first.rows.length, 2);
  assert.ok(first.nextCursor);
  assert.match(queries[0].sql, /LIMIT \$\d+ OFFSET \$\d+/);

  const next = await dialect.list({ table: 'samples_mellat', params: { ...params, cursor: first.nextCursor } });
  assert.equal(next.rows[0].request_id, 'r3');
  assert.equal(next.total, 3);
  assert.equal(next.nextCursor, null);
  assert.match(queries[1].sql, /\(day, COALESCE\(stamp_key, ''\), request_id\) >/);
  assert.doesNotMatch(queries[1].sql, / OFFSET /);
});
