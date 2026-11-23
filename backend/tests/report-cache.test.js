'use strict';

/**
 * کش report: fresh/stale/تکی‌پرواز/evict — ریشهٔ رفع تام‌اوت داشبورد در تولید.
 * همزمانی: چند درخواستِ هم‌زمان نباید چند بار پیمایش کامل دیتابیس را اجرا کنند.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReportCache } = require('../services/report/report-cache');

const flush = (rounds = 8) =>
  new Promise((resolve) => {
    let n = 0;
    const step = () => (++n >= rounds ? resolve() : setImmediate(step));
    setImmediate(step);
  });

test('cache: نوبساز اول، سپس fresh بدون بازسازی', async () => {
  let now = 1_000_000;
  const cache = createReportCache({ ttlMs: 1000, staleMs: 5000, now: () => now });
  let builds = 0;
  const build = async () => { builds += 1; return `html-${builds}`; };

  const first = await cache.getOrBuild('k', build);
  assert.equal(first.fromCache, 'miss');
  assert.equal(first.html, 'html-1');

  now += 500;
  const second = await cache.getOrBuild('k', build);
  assert.equal(second.fromCache, 'fresh');
  assert.equal(second.html, 'html-1');
  assert.equal(builds, 1);
});

test('cache: stale فوراً برمی‌گردد و پس‌زمینه نو می‌سازد', async () => {
  let now = 1_000_000;
  const cache = createReportCache({ ttlMs: 1000, staleMs: 5000, now: () => now });
  let builds = 0;
  const build = async () => { builds += 1; return `html-${builds}`; };

  await cache.getOrBuild('k', build); // html-1, t=1_000_000
  now += 2000; // کهنه (بیش از ttl ولی داخل stale)
  const stale = await cache.getOrBuild('k', build);
  assert.equal(stale.fromCache, 'stale');
  assert.equal(stale.html, 'html-1', 'پاسخ باید همان نسخهٔ کهنه باشد');

  await flush(); // صبر برای نوسازی پس‌زمینه
  const fresh = await cache.getOrBuild('k', build);
  assert.equal(fresh.fromCache, 'fresh');
  assert.equal(fresh.html, 'html-2', 'پس از نوسازی پس‌زمینه باید نسخهٔ جدید برگردد');
  assert.equal(builds, 2);
});

test('cache: درخواست‌های هم‌زمانِ cold فقط یک ساخت دارند', async () => {
  const cache = createReportCache({ ttlMs: 1000, staleMs: 5000 });
  let builds = 0;
  const build = async () => {
    builds += 1;
    await new Promise((r) => setTimeout(r, 20));
    return 'html';
  };
  const results = await Promise.all([
    cache.getOrBuild('k', build),
    cache.getOrBuild('k', build),
    cache.getOrBuild('k', build),
  ]);
  assert.equal(builds, 1, 'فقط یک ساخت انجام شود');
  const modes = results.map((r) => r.fromCache).sort();
  assert.deepEqual(modes, ['joined', 'joined', 'miss']);
});

test('cache: پس از گذشت پنجرهٔ stale، نوسازی اجباری است', async () => {
  let now = 1_000_000;
  const cache = createReportCache({ ttlMs: 1000, staleMs: 1000, now: () => now });
  let builds = 0;
  const build = async () => { builds += 1; return `html-${builds}`; };

  await cache.getOrBuild('k', build);
  now += 10_000; // خیلی کهنه
  const res = await cache.getOrBuild('k', build);
  assert.equal(res.fromCache, 'miss');
  assert.equal(res.html, 'html-2');
  assert.equal(builds, 2);
});

test('cache: وقتی نوسازی پس‌زمینه شکست بخورد، نسخهٔ کهنه حفظ می‌شود', async () => {
  let now = 1_000_000;
  const cache = createReportCache({ ttlMs: 1000, staleMs: 5000, now: () => now });
  let builds = 0;
  const build = async () => {
    builds += 1;
    if (builds === 1) return 'html-good';
    throw new Error('db is down');
  };
  await cache.getOrBuild('k', build);
  now += 2000;
  const stale = await cache.getOrBuild('k', build);
  assert.equal(stale.fromCache, 'stale');
  await flush(); // نوسازی پس‌زمینه شکست می‌خورد
  const again = await cache.getOrBuild('k', build);
  assert.equal(again.html, 'html-good', 'نسخهٔ سالم هنوز باید برگردد');
  assert.equal(again.fromCache, 'stale');
});

test('cache: evict قدیمی‌ترین وقتی پر شود', async () => {
  const cache = createReportCache({ ttlMs: 10_000, staleMs: 0, maxEntries: 2 });
  const build = (tag) => async () => `html-${tag}`;
  await cache.getOrBuild('a', build('a'));
  await new Promise((r) => setTimeout(r, 5));
  await cache.getOrBuild('b', build('b'));
  await new Promise((r) => setTimeout(r, 5));
  await cache.getOrBuild('c', build('c'));
  assert.equal(cache.size, 2);
  const a = await cache.getOrBuild('a', build('a2'));
  assert.equal(a.fromCache, 'miss', 'a باید حذف شده باشد');
});

test('cache: ttl=0 کش را غیرفعال می‌کند ولی تکی‌پرواز می‌ماند', async () => {
  const cache = createReportCache({ ttlMs: 0, staleMs: 0 });
  let builds = 0;
  const build = async () => {
    builds += 1;
    await new Promise((r) => setTimeout(r, 10));
    return 'html';
  };
  await Promise.all([cache.getOrBuild('k', build), cache.getOrBuild('k', build)]);
  assert.equal(builds, 1, 'درخواست‌های هم‌زمان یکی شوند');
  await cache.getOrBuild('k', build);
  assert.equal(builds, 2, 'هر بار باید دوباره بسازد');
});
