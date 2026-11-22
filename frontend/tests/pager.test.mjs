// ۳-الف — منطق صفحه‌بندی: آدرس‌سازی، total، وضعیت URL، لغو درخواست و بی‌تکرار بودن.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAGE_SIZE, buildListUrl, normalizePage, pageStateFrom, pageStateToUrl,
  nextPageState, prevPageState, progressLabel, createPageLoader,
} from '../lib/pager.mjs';

test('۳-الف: اندازهٔ صفحه ۱۰۰ و حفظ فیلترها در URL', () => {
  assert.equal(PAGE_SIZE, 100);
  const url = buildListUrl('/api/list', { bank: 'tavan_mellat', from: '1405-08-01', type: 'all' }, {});
  assert.match(url, /bank=tavan_mellat/);
  assert.match(url, /limit=100/);
  const withCursor = buildListUrl('/api/list', { bank: 'b' }, { cursor: 'abc', limit: 100 });
  assert.match(withCursor, /cursor=abc/);
  assert.doesNotMatch(withCursor, /offset=/);
});

test('۳-الف: پاسخ سرور (items یا rows) به یک شکل نرمال می‌شود', () => {
  const a = normalizePage({ items: [{ id: 1 }], total: 250, nextCursor: 'c1' });
  assert.deepEqual(a.items, [{ id: 1 }]);
  assert.equal(a.total, 250);
  assert.equal(a.nextCursor, 'c1');
  const b = normalizePage({ data: { rows: [{ id: 2 }], total: 5 } });
  assert.equal(b.items.length, 1);
  assert.equal(b.total, 5);
  assert.equal(b.nextCursor, null);
});

test('۳-الف: وضعیت صفحه در URL رفت‌وبرگشت می‌کند', () => {
  const search = pageStateToUrl('?bank=tavan_mellat', { cursor: 'xyz', offset: 0 });
  assert.match(search, /cursor=xyz/);
  const parsed = pageStateFrom(search);
  assert.equal(parsed.cursor, 'xyz');
  assert.equal(parsed.offset, 0);
  const jump = pageStateToUrl('?bank=b', { cursor: null, offset: 300 });
  assert.match(jump, /offset=300/);
  assert.doesNotMatch(jump, /cursor=/);
});

test('۳-الف: ناوبری بعدی/قبلی بدون تکرار و با احترام به انتها', () => {
  const first = { page: 1, limit: 100, cursor: null, offset: 0 };
  const page = { items: Array(100).fill(0), total: 250, nextCursor: 'n1' };
  const second = nextPageState(first, page);
  assert.equal(second.page, 2);
  assert.equal(second.cursor, 'n1');
  // صفحهٔ آخر: nextCursor تهی ⇒ دکمهٔ بعدی غیرفعال
  assert.equal(nextPageState(second, { items: [], total: 250, nextCursor: null }), null);
  const back = prevPageState({ page: 3, limit: 100, cursor: 'n2', offset: 0 });
  assert.equal(back.page, 2);
  assert.equal(back.offset, 100);
  assert.equal(back.cursor, null);
  assert.equal(prevPageState(first), null);
});

test('۳-الف: متن پیشرفت با total سرور هم‌خوان است', () => {
  const page = { items: Array(100).fill(0), total: 12430 };
  assert.match(progressLabel(page, 1), /۱۰۰ از ۱۲٬۴۳۰/);
  assert.match(progressLabel(page, 3), /۳۰۰ از ۱۲٬۴۳۰/);
  // صفحهٔ آخر بیشتر از total نشان نمی‌دهد
  assert.match(progressLabel({ items: Array(30).fill(0), total: 230 }, 3), /۲۳۰ از ۲۳۰/);
});

test('۳-الف: درخواست قبلی با AbortController لغو می‌شود (آخرین برنده است)', async () => {
  const calls = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    calls.push(url);
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
    // درخواست اول هرگز برنمی‌گردد؛ دومی سریع پاسخ می‌دهد
    if (calls.length === 2) {
      setTimeout(() => resolve({ ok: true, json: async () => ({ items: [{ id: 'second' }], total: 1 }) }), 5);
    }
  });
  const seen = [];
  const load = createPageLoader({ fetchImpl, onPage: (page) => seen.push(page.items[0]?.id) });
  const first = load('/api/list?cursor=a');
  const second = load('/api/list?cursor=b');
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1, null, 'درخواست لغوشده نتیجه ندارد');
  assert.equal(r2.items[0].id, 'second');
  assert.deepEqual(seen, ['second'], 'فقط صفحهٔ آخر روی UI نوشته شد');
});

test('۳-الف: خطای HTTP به پیام کاربرپسند تبدیل می‌شود (بدون متن خام)', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    text: async () => 'stack trace secret path /srv/app',
  });
  let caught = null;
  const load = createPageLoader({ fetchImpl, onError: (error) => { caught = error; } });
  await load('/api/list');
  assert.ok(caught, 'خطا گزارش شد');
  assert.match(caught.message, /ناموفق/);
  assert.doesNotMatch(caught.message, /srv\/app/, 'متن خام سرور در پیام کاربر نیست');
});
