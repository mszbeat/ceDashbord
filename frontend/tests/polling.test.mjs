// F5/F7 — نظرسنجی: توقف در تب پنهان، backoff نمایی، لغو درخواست قبلی، پایان تمیز.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoller, nextDelay, DEFAULT_BACKOFF } from '../lib/polling.mjs';

const fakeDoc = (initial = 'visible') => {
  const listeners = new Set();
  return {
    visibilityState: initial,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    emit(state) {
      this.visibilityState = state;
      for (const fn of listeners) fn();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('F5: backoff نمایی با سقف', () => {
  assert.equal(nextDelay(0), DEFAULT_BACKOFF.baseMs);
  assert.equal(nextDelay(1), 4000);
  assert.equal(nextDelay(2), 8000);
  assert.equal(nextDelay(50), DEFAULT_BACKOFF.maxMs);
});

test('F5: در تب پنهان درخواست فرستاده نمی‌شود و با بازگشت فوراً تازه‌سازی می‌شود', async () => {
  const doc = fakeDoc('hidden');
  let calls = 0;
  const poller = createPoller({
    task: async () => { calls += 1; },
    intervalMs: 20,
    documentRef: doc,
  });
  poller.start();
  await wait(60);
  assert.equal(calls, 0, 'در تب پنهان هیچ فراخوانی‌ای نشد');
  doc.emit('visible');
  await wait(20);
  assert.equal(calls, 1, 'بازگشت به تب یک تازه‌سازی فوری زد');
  poller.stop();
});

test('F5: خطا باعث backoff می‌شود و شمارنده بالا می‌رود', async () => {
  const doc = fakeDoc('visible');
  const delays = [];
  let calls = 0;
  const poller = createPoller({
    task: async () => { calls += 1; throw new Error('offline'); },
    intervalMs: 5,
    // backoff فشرده تا در زمان کوتاه تست، چند تلاش پیاپی دیده شود
    backoff: { baseMs: 4, maxMs: 40, factor: 2 },
    documentRef: doc,
    onError: (_e, n) => delays.push(n),
  });
  poller.start();
  await wait(120);
  poller.stop();
  assert.ok(delays.length >= 2, 'حداقل دو خطای پیاپی ثبت شد');
  assert.equal(delays[0], 1);
  assert.ok(calls < 20, `تعداد فراخوانی با backoff محدود شد (was ${calls})`);
});

test('F5: stop باعث لغو درخواست در حال اجرا و برداشتن listener می‌شود', async () => {
  const doc = fakeDoc('visible');
  let aborted = false;
  const poller = createPoller({
    documentRef: doc,
    task: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }),
  });
  poller.start();
  await wait(10);
  assert.equal(doc.listenerCount, 1);
  poller.stop();
  await wait(10);
  assert.equal(aborted, true, 'درخواست در جریان لغو شد');
  assert.equal(doc.listenerCount, 0, 'listener حذف شد (بدون نشتی)');
  assert.equal(poller.active, false);
});

test('F5: فراخوانی‌ها روی هم نمی‌افتند (single-flight)', async () => {
  const doc = fakeDoc('visible');
  let concurrent = 0;
  let maxConcurrent = 0;
  const poller = createPoller({
    documentRef: doc,
    intervalMs: 5,
    task: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await wait(30);
      concurrent -= 1;
    },
  });
  poller.start();
  await wait(80);
  poller.stop();
  assert.equal(maxConcurrent, 1, 'هیچ‌وقت دو فراخوانی هم‌زمان نبود');
});
