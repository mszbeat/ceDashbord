'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SummaryService } = require('../services/summary/summary.service');

test('فهرست گزارش‌ها حداکثر ۵۰ ردیف در هر درخواست می‌گیرد', async () => {
  let requested;
  const dialect = {
    async list(args) {
      requested = args;
      return { type: 'all', rows: [], total: 137, nextCursor: null };
    },
  };
  const service = new SummaryService({}, {}, { dialect });
  const page = await service.list({
    bank: 'tavan_mellat', from: '1405-08-01', to: '1405-08-30', type: 'all', limit: 200,
  });
  assert.equal(requested.limit, 50);
  assert.equal(page.limit, 50);
  assert.equal(page.total, 137);
  assert.deepEqual(page.items, []);
});
