/**
 * F1 — مهلت (timeout) برای فراخوانی بک‌اند در مسیر گزارش.
 *
 * چرا فقط تا «رسیدن هدرها»؟ چون بدنه به‌صورت جریان پاس داده می‌شود و گزارش بزرگ
 * ممکن است ده‌ها ثانیه طول بکشد؛ اگر برای کل بدنه مهلت بگذاریم، گزارش سالم را قطع می‌کنیم.
 * پس دو چیز جدا کنترل می‌شود:
 *  ۱) مهلت اتصال/هدرها (`timeoutMs`) — اگر بک‌اند پاسخ نداد، سریع خطا می‌دهیم،
 *  ۲) نگهبان سکون (`startIdleWatchdog`) — اگر جریان وسط کار بخوابد، قطع می‌کنیم.
 * بدون این‌ها یک اتصال معلق، سوکت و حافظه را تا بی‌نهایت نگه می‌داشت (ریشهٔ کندی و OOM).
 */

export const DEFAULT_HEADERS_TIMEOUT_MS = Number(process.env.CE_REPORT_HEADERS_TIMEOUT_MS || 30000);

/**
 * `fetch` را با کنترل زمان‌بندی فراخوانی می‌کند.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {{timeoutMs?: number, signal?: AbortSignal}} options
 */
export async function fetchWithHeadersTimeout(fetchImpl, url, init = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let timer = null;
  let timedOut = false;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      const error = new Error(`مهلت پاسخ بک‌اند (${timeoutMs}ms) گذشت`);
      error.code = 'UPSTREAM_TIMEOUT';
      reject(error);
    }, timeoutMs);
    // عمداً unref نمی‌کنیم: این تایمر باید تا رسیدن هدرها زنده بمانَد (در finally پاک می‌شود)
  });

  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`مهلت پاسخ بک‌اند (${timeoutMs}ms) گذشت`);
      timeoutError.code = 'UPSTREAM_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', onOuterAbort);
  }
}

/**
 * نگهبان سکون جریان: اگر `idleMs` طول بکشد و هیچ بایتی نرسد، `onStall` صدا زده می‌شود.
 * @returns {{touch: Function, stop: Function}}
 */
export function startIdleWatchdog(onStall, idleMs = 30000) {
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onStall, idleMs);
    timer.unref?.();
  };
  arm();
  return {
    touch: arm,
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** پاسخ HTML خطای مهلت برای کاربر (بدون افشای جزئیات داخلی) */
export const isTimeoutError = (error) => error?.code === 'UPSTREAM_TIMEOUT';
