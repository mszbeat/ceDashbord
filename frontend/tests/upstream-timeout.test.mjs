// F1 — مهلت اتصال/هدرها و نگهبان سکون جریان (بدون بافر کردن بدنه)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchWithHeadersTimeout, startIdleWatchdog, isTimeoutError, DEFAULT_HEADERS_TIMEOUT_MS,
} from '../lib/upstream-timeout.mjs';

test('F1: مهلت پیش‌فرض ۳۰ ثانیه است و از env قابل تغییر', () => {
  assert.equal(DEFAULT_HEADERS_TIMEOUT_MS, Number(process.env.CE_REPORT_HEADERS_TIMEOUT_MS || 30000));
});

test('F1: بک‌اندِ بی‌پاسخ با خطای مشخص قطع می‌شود (نه انتظار بی‌پایان)', async () => {
  const neverResolves = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const started = Date.now();
  await assert.rejects(
    () => fetchWithHeadersTimeout(neverResolves, 'http://x/api/report', {}, { timeoutMs: 60 }),
    (error) => {
      assert.equal(error.code, 'UPSTREAM_TIMEOUT');
      assert.match(error.message, /مهلت/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000, 'به‌سرعت و نه بی‌نهایت');
});

test('F1: پاسخ سریع دست‌نخورده برمی‌گردد و تایمر پاک می‌شود', async () => {
  const ok = async () => ({ status: 200, body: 'stream' });
  const response = await fetchWithHeadersTimeout(ok, 'http://x/api/report', {}, { timeoutMs: 500 });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'stream');
});

test('F1: لغو از سمت درخواست (بستن مرورگر) به‌درستی منتقل می‌شود', async () => {
  const outer = new AbortController();
  const pending = fetchWithHeadersTimeout(
    (_u, init) => new Promise((_r, reject) => {
      if (init.signal.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
        return;
      }
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }),
    'http://x/api/report',
    {},
    { timeoutMs: 5000, signal: outer.signal },
  );
  outer.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(isTimeoutError(new Error('x')), false);
});

test('F1: نگهبان سکون، جریان خوابیده را تشخیص می‌دهد', async () => {
  let stalled = 0;
  const watchdog = startIdleWatchdog(() => { stalled += 1; }, 30);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(stalled, 1, 'سکون تشخیص داده شد');
  watchdog.touch();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(stalled, 2, 'با هر بایت، مهلت تازه می‌شود');
  watchdog.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(stalled, 2, 'پس از stop دیگر شلیک نمی‌شود');
});
