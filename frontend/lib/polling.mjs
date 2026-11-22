/**
 * F5/F7 — یک منبع واحد برای نظرسنجی (polling) در کلاینت.
 *
 * مشکلات نسخهٔ قبلی:
 *  * `setInterval` بدون توجه به تبِ پنهان ⇒ درخواست مداوم در پس‌زمینه و مصرف باتری/سهمیهٔ سرور.
 *  * بدون توقف هنگام خطا ⇒ در قطعی شبکه، هر ۲ ثانیه یک درخواستِ شکست‌خورده.
 *  * بدون `AbortController` ⇒ پاسخ کندِ قبلی روی دادهٔ تازه می‌نشیند (race).
 *  * چند کامپوننت هم‌زمان => چند تایمر (نشتی پس از unmount).
 *
 * این ماژول: تایمر تک‌نمونه، توقف در تب پنهان، backoff نمایی با سقف، لغو در پایان.
 */

export const DEFAULT_BACKOFF = { baseMs: 2000, maxMs: 60000, factor: 2 };

/** محاسبهٔ تأخیر بعدی؛ `failures` تعداد خطای پیاپی است */
export function nextDelay(failures, { baseMs, maxMs, factor } = DEFAULT_BACKOFF) {
  if (!failures || failures <= 0) return baseMs;
  const raw = baseMs * Math.pow(factor, Math.min(failures, 8));
  return Math.min(maxMs, Math.round(raw));
}

export function createPoller(options) {
  const {
    task,
    intervalMs = 15000,
    backoff = DEFAULT_BACKOFF,
    documentRef = typeof document !== 'undefined' ? document : null,
    onError,
    immediate = true,
  } = options;

  let timer = null;
  let controller = null;
  let failures = 0;
  let stopped = true;
  let running = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delay) => {
    clear();
    if (stopped) return;
    timer = setTimeout(tick, delay);
  };

  const tick = async () => {
    if (stopped) return;
    // F5: در تب پنهان کاری انجام نمی‌دهیم؛ فقط زمان‌بندی را عقب می‌اندازیم
    if (documentRef && documentRef.visibilityState === 'hidden') {
      schedule(intervalMs);
      return;
    }
    if (running) return; // از هم‌پوشانی جلوگیری می‌کنیم
    running = true;
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    try {
      await task({ signal: mine.signal });
      if (mine.signal.aborted) return;
      failures = 0;
      schedule(intervalMs);
    } catch (error) {
      if (mine.signal.aborted || error?.name === 'AbortError') return;
      failures += 1;
      onError?.(error, failures);
      schedule(nextDelay(failures, backoff));
    } finally {
      running = false;
    }
  };

  const onVisibility = () => {
    // بازگشت به تب: فوراً یک‌بار به‌روزرسانی کن، نه انتظار برای تیک بعدی
    if (!stopped && documentRef?.visibilityState === 'visible') {
      clear();
      schedule(0);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      documentRef?.addEventListener?.('visibilitychange', onVisibility);
      if (immediate) tick();
      else schedule(intervalMs);
    },
    stop() {
      stopped = true;
      clear();
      controller?.abort();
      controller = null;
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
    },
    async runNow() {
      clear();
      await tick();
    },
    get failures() {
      return failures;
    },
    get active() {
      return !stopped;
    },
  };
}
