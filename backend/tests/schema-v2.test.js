'use strict';

/**
 * آزمون‌های اسکیمای v2 — بدون نیاز به PostgreSQL واقعی (PGlite در bench اجرا می‌شود).
 *
 * این فایل فقط بخش‌های «خالص» را می‌آزماید (تبدیل تاریخ، بسته‌بندی بیت، uuid، ثبت رجیستری)
 * تا در `npm test` سریع و بدون دیتابیس اجرا شود. آزمون‌های داده‌ای/برابری در
 * `/home/user/bench/golden.js` و `/home/user/bench/migrate-test.js` هستند.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const registryModule = require(path.join(ROOT, 'services', 'db', 'indicator-registry'));
const mapper = require(path.join(ROOT, 'services', 'db', 'row-mapper-v2'));
const uuidMap = require(path.join(ROOT, 'services', 'db', 'uuid-map'));
const builder = require(path.join(ROOT, 'services', 'db', 'schema-v2-builder'));

test('تبدیل تاریخ شمسی/میلادی رفت‌وبرگشت بدون خطا است', () => {
  assert.equal(mapper.toDateIso('1405-08-01'), '2026-10-23');
  assert.equal(mapper.toDateIso('1403-01-01'), '2024-03-20');
  assert.equal(mapper.toJalaliDay('2026-10-23'), '1405-08-01');
  for (const day of ['1399-12-30', '1400-01-01', '1404-06-31', '1405-09-30']) {
    assert.equal(mapper.toJalaliDay(mapper.toDateIso(day)), day);
  }
});

test('مهر زمانی شمسی و epoch یکدیگر را بازمی‌گردانند', () => {
  for (const stamp of ['14050801120000000', '14050801123045999', '14051229235959999']) {
    assert.equal(mapper.stampDigitsFromEpoch(mapper.stampEpochMs(stamp)), stamp);
  }
  assert.equal(mapper.stampEpochMs('99999999999999999'), null);
});

test('ماسک پرچم‌ها یکتا و پایدار است', () => {
  const registry = registryModule.buildRegistry({
    bank: { flags: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  }).bank;
  const masks = registryModule.flagMasks(registry);
  assert.deepEqual(Object.keys(masks), ['a', 'b', 'c']);
  assert.equal(new Set(Object.values(masks).map(String)).size, 3);
  assert.equal(masks.a, 1n);
  assert.equal(masks.c, 4n);
});

test('بسته‌بندی و بازکردن وضعیت سرویس‌ها دقیق است', () => {
  const registry = { service: ['s1', 's2', 's3'] };
  const bits = registryModule.packServiceKinds(registry, { s1: 'ok', s2: 'failed', s3: { kind: 'other' } });
  assert.deepEqual(registryModule.unpackServiceKinds(registry, bits), {
    s1: 'ok', s2: 'failed', s3: 'other',
  });
});

test('بیت‌های مسیر فقط برای مقادیر موجود ست می‌شوند', () => {
  const registry = { path: ['p1', 'p2', '__rotbe'] };
  const bits = mapper.packPathKinds(registry, { p1: 'emptyArray', p2: null });
  assert.deepEqual(mapper.unpackPathKinds(registry, bits), { p1: 'emptyArray', p2: null });
});

test('شناسه‌های غیر-UUID به UUID پایدار نگاشت می‌شوند', () => {
  const first = uuidMap.ensureUuid('me000000-c392-4e34-aca3-4778cea7e8b9');
  assert.match(first, uuidMap.UUID_RE);
  assert.equal(uuidMap.ensureUuid('me000000-c392-4e34-aca3-4778cea7e8b9'), first);
  assert.notEqual(uuidMap.ensureUuid('other-id'), first);
  const real = '00000001-c392-4e34-aca3-4778cea7e8b9';
  assert.equal(uuidMap.ensureUuid(real), real);
  assert.equal(uuidMap.needsMapping(real), false);
});

test('نام ستون متریک/کانتر از شناسه ساخته می‌شود و یکتاست', () => {
  const { KIND, columnName } = registryModule;
  assert.equal(columnName(KIND.METRIC, 'totalTime'), 'm_total_time');
  assert.equal(columnName(KIND.COUNTER, 'monitorLoanTotal'), 'c_monitor_loan_total');
  const registry = registryModule.buildRegistry({
    bank: {
      metrics: [{ id: 'pd' }, { id: 'totalTime' }, { id: 'tbp_Medium_Bad' }],
      counters: [{ id: 'loansTotal' }],
    },
  }).bank;
  const columns = builder.typedColumnsOf(registry).map(([name]) => name);
  assert.deepEqual(columns, ['m_pd', 'm_total_time', 'm_tbp_medium_bad', 'c_loans_total']);
  assert.equal(new Set(columns).size, columns.length);
});

test('ستون‌های پایه بدون تکرار و با کلید اصلی روز/درخواست هستند', () => {
  const names = builder.BASE_COLUMNS.map(([name]) => name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('day'));
  assert.ok(names.includes('request_id'));
  const ddl = builder.createTableSql('tavan_mellat', { metric: [], counter: [] });
  assert.match(ddl, /PRIMARY KEY \(day, request_id\)/);
  assert.match(ddl, /PARTITION BY RANGE \(day\)/);
});

test('ایندکس‌های v2 فقط b-tree/جزئی‌اند (بدون GIN و بدون تکرار)', () => {
  const sqls = builder.createIndexesSql('tavan_mellat', { flag: ['a', 'b', 'c', 'd'] });
  // ۲ ایندکس پایه + slow + creditAlert + ۳ ایندکس جزئی پرچم پرکاربرد (B4)
  assert.equal(sqls.length, 7);
  // فقط ۳ پرچم اول ایندکس جزئی می‌گیرند
  assert.equal(sqls.filter((sql) => /WHERE \(flags &/.test(sql)).length, 3);
  assert.ok(!sqls.some((sql) => /USING GIN/i.test(sql)));
  const names = sqls.map((sql) => sql.split(' EXISTS ')[1].split(' ')[0]);
  assert.equal(new Set(names).size, names.length);
});

test('رجیستری runtime برای هر سه بانک ساخته می‌شود', () => {
  const { EvaluatorService } = require(path.join(ROOT, 'services', 'evaluator', 'evaluator.service'));
  const { buildRuntimeRegistry } = require(path.join(ROOT, 'services', 'db', 'schema-registry'));
  const bundle = buildRuntimeRegistry(new EvaluatorService());
  assert.deepEqual(Object.keys(bundle.registry).sort(), ['tavan_mellat', 'tavan_postbank', 'tavan_resalat']);
  for (const registry of Object.values(bundle.registry)) {
    assert.ok(registry.flag.length > 0 && registry.flag.length <= registryModule.MAX_FLAGS);
    assert.ok(registry.metric.length > 0);
    assert.equal(new Set(registry.flag).size, registry.flag.length);
  }
});
