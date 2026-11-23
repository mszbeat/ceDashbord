'use strict';

/**
 * کش «report HTML» — رفع تام‌اوت داشبورد در تولید.
 *
 * چرا: `/api/report` گزارشِ ۳۰ روز اخیر را با پیمایش **تمام ردیف‌ها** می‌سازد (cursor
 * + تجمیع در Node). روی جدول‌های بزرگ این چند ده ثانیه تا چند دقیقه طول می‌کشد؛
 * ولی مهلت پاسخ فرانت به بک‌اند پیش‌فرض ۳۰ ثانیه است — نتیجه: مرورگر تاموت می‌شود،
 * بک‌اند درخواست را تا آخر (بی‌ثمر) ادامه می‌دهد و هر بارگذاری دوباره، همین کار را
 * از نو می‌کند (چند کاربر هم‌زمان = چند گزارشِ کامل = قفل شدن دیتابیس).
 *
 * راه‌حل: خروجی report به نقش کاربر وابسته نیست (نوار احراز در کلاینت رندر می‌شود)،
 * پس HTML برای هر (bank|from|to|rowsCap) یکتا و کش‌پذیر است:
 *   • fresh (< TTL)            → همان‌لحظه از کش
 *   • stale (TTL..staleMs)     → همان‌لحظه نسخهٔ کهنه، و یک نو/سازی **تکی‌پرواز** در پس‌زمینه
 *   • نبود/کهنه‌تر از stale    → نو/سازی تکی‌پرواز؛ درخواست‌های هم‌زمان همان Promise را می‌بینند
 *
 * ⚠️ اگر خروجی report روزی وابسته به نقش کاربر شد، کلید کش را گسترش دهید یا کش را غیرفعال کنید.
 *
 * nouveauté در این نسخه:
 *   • سیگنال ابort کلاینت **به ساخت gemeinsamen داده نمی‌شود**. ساخت مستقل از اتصال هر
 *     کلاینت تا پایان می‌رود و نتیجه در reportCache ثبت می‌شود.
 *   • ساخت فقط بعد از `CE_REPORT_BUILD_MAX_MS` (پیش‌فرض ۱۸۰۰۰۰ms) لغو می‌شود.
 *   • اگر کلاینت قطع شد، ساخت ادامه یابد و درخواست بعدی از کش (`cache: fresh`) پاسخ گیرد.
 */

const DEFAULT_TTL_MS = Number(process.env.CE_REPORT_CACHE_TTL_MS ?? 600_000); // ۱۰ دقیقه
const DEFAULT_STALE_MS = Number(process.env.CE_REPORT_CACHE_STALE_MS ?? 3_600_000); // ۱ ساعت
const DEFAULT_MAX_ENTRIES = Number(process.env.CE_REPORT_CACHE_MAX_ENTRIES ?? 12);
const DEFAULT_MAX_BUILD_MS = Number(process.env.CE_REPORT_BUILD_MAX_MS ?? 180_000); // ۳ دقیقه

function numeric(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** خطای abortِ internal برای مهلت ساخت */
class BuildTimeoutError extends Error {
  constructor() {
    super('مهلت ساخت گزارش گذشت');
    this.name = 'BuildTimeoutError';
    this.code = 'BUILD_TIMEOUT';
  }
}

class ReportCache {
  /**
   * @param {{ttlMs?: number, staleMs?: number, maxEntries?: number, maxBuildMs?: number, now?: () => number}} options
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? numeric('CE_REPORT_CACHE_TTL_MS', DEFAULT_TTL_MS);
    this.staleMs = options.staleMs ?? numeric('CE_REPORT_CACHE_STALE_MS', DEFAULT_STALE_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? numeric('CE_REPORT_CACHE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES));
    this.maxBuildMs = options.maxBuildMs ?? numeric('CE_REPORT_BUILD_MAX_MS', DEFAULT_MAX_BUILD_MS);
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, {html: string, createdAt: number}>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<string>>} */
    this.inflight = new Map();
  }

  static keyOf(bank, from, to, rowsCap) {
    return [bank || '', from || '', to || '', rowsCap ?? ''].join('|');
  }

  get size() {
    return this.entries.size;
  }

  /** پاک‌سازی دستی کش (برای تست‌ها و عملیات دستی — مثلاً بعد از ingest اضطراری) */
  clear() {
    this.entries.clear();
    this.inflight.clear();
  }

  /** در بچ‌های بسیار کوچک، evict ساده: قدیمی‌ترین createdAt اول بیرون می‌رود */
  #evictIfNeeded() {
    while (this.entries.size > this.maxEntries) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of this.entries) {
        if (entry.createdAt < oldestAt) {
          oldestAt = entry.createdAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.entries.delete(oldestKey);
    }
  }

  #set(key, html) {
    this.entries.set(key, { html, createdAt: this.now() });
    this.#evictIfNeeded();
  }

  /**
   * نوسازی پس‌زمینه — خطاها فقط لاگ می‌شوند؛ نسخهٔ کهنه سرجایش می‌ماند.
   * @private
   */
  #refreshInBackground(key, buildFn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = (async () => {
      const startedAt = Date.now();
      try {
        const html = await this.#runBuild(buildFn, this.maxBuildMs);
        this.#set(key, html);
        try {
          require('../logger/action-logger.service').getActionLogger().info({
            category: 'summary',
            action: 'summary.report.cache_rebuilt',
            statusCode: 200,
            meta: { key, durationMs: Date.now() - startedAt, bytes: html?.length ?? null },
          });
        } catch { /* لاگر آماده نیست */ }
        return html;
      } catch (error) {
        try {
          require('../logger/action-logger.service').getActionLogger().error({
            category: 'summary',
            action: 'summary.report.cache_rebuild_failed',
            errorCode: error?.code || 'REPORT_REBUILD_FAILED',
            message: error?.message || 'background rebuild failed',
            meta: { key, durationMs: Date.now() - startedAt },
          });
        } catch { /* لاگر در دسترس نیست */ }
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  /**
   * اجرای ساخت با محدودیت زمانی داخلی. سیگنال ابort کلاینت به این تابع **دیده نمی‌شود**;
   * ساخت تا `maxBuildMs` ادامه می‌یابد.
   * @private
   */
  async #runBuild(buildFn, maxBuildMs) {
    const startedAt = Date.now();
    try {
      const html = maxBuildMs > 0
        ? await Promise.race([
            buildFn(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new BuildTimeoutError()), maxBuildMs)
            ),
          ])
        : await buildFn();
      return html;
    } catch (error) {
      try {
        require('../logger/action-logger.service').getActionLogger().warn({
          category: 'summary',
          action: 'summary.report.build_stopped',
          errorCode: error?.code || 'BUILD_STOPPED',
          message: error?.message || 'build stopped',
          meta: { durationMs: Date.now() - startedAt },
        });
      } catch { /* لاگر در دسترس نیست */ }
      throw error;
    }
  }

  /**
   * گزارش را برمی‌گرداند؛ در صورت نیاز می‌سازد.
   * سیگنال `signal` (abort کلاینت) فقط برای **اتظار llamóرنده** استفاده می‌شود، نه برای لغو ساخت.
   * اگر کلاینت قطع شد، ساخت در پس‌زمینه ادامه می‌یابد و در reportCache ثبت می‌شود.
   *
   * @param {string} key خروجی `ReportCache.keyOf`
   * @param {() => Promise<string>} buildFn ساخت HTML گزارش
   * @param {{signal?: AbortSignal, maxBuildMs?: number}} options
   * @returns {Promise<{html: string|null, fromCache: 'fresh'|'stale'|'miss'|'joined'|'detached', detached?: boolean}>}
   */
  async getOrBuild(key, buildFn, options = {}) {
    const { signal, maxBuildMs = this.maxBuildMs } = options;

    if (this.ttlMs === 0) {
      // کش غیرفعال: همیشه تازه بساز (تکی‌پرواز همچنان فعال است تا طوفانِ موازی نشود)
      const pending = this.inflight.get(key);
      if (pending) {
        try {
          const html = await pending;
          return { html, fromCache: 'joined' };
        } catch {
          throw new Error('ساخت گزارش ناموفق بود');
        }
      }
      const task = (async () => {
        const html = await this.#runBuild(buildFn, maxBuildMs);
        this.#set(key, html);
        return html;
      })();
      task.catch(() => {});
      this.inflight.set(key, task);
      try {
        const html = await task;
        return { html, fromCache: 'miss' };
      } finally {
        this.inflight.delete(key);
      }
    }

    const now = this.now();
    const hit = this.entries.get(key);

    if (hit) {
      const age = now - hit.createdAt;
      if (age < this.ttlMs) return { html: hit.html, fromCache: 'fresh' };
      if (age < this.ttlMs + this.staleMs) {
        // پاسخ کهنه فوراً؛ به‌روزرسانی در پس‌زمinescence
        void this.#refreshInBackground(key, buildFn);
        return { html: hit.html, fromCache: 'stale' };
      }
      // کهنهٔ بی‌کیفیت: حذف و نوسازی اجباری
      this.entries.delete(key);
    }

    // ساخت تکی‌پرواز — درخواست‌های هم‌زمان همان Promise را می‌بینند.
    // buildFn سیگنال abort کلاینت را **نمی‌گیرد**; ساخت مستقل ادامه می‌یابد.
    const pending = this.inflight.get(key);
    if (pending) {
      try {
        const html = await pending;
        return { html, fromCache: 'joined' };
      } catch {
        // ساخت ناموفق بود؛ می‌توانیم دوباره سعی کنیم یا خطا بدهیم
        throw new Error('ساخت گزارش ناموفق بود');
      }
    }

    const task = (async () => {
      const html = await this.#runBuild(buildFn, maxBuildMs);
      this.#set(key, html);
      return html;
    })();
    // هرگاه کال‌کننده انتظار خود را قطع کرد، reject未_handled نداشته باشیم.
    task.catch(() => {});
    this.inflight.set(key, task);

    if (signal) {
      // دواندمایی بین ساخت و قطع شدن اتصال کلاینت
      const abortPromise = new Promise((_, reject) => {
        const onAbort = () => reject(new Error('CLIENT_ABORTED'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });

      try {
        const html = await Promise.race([task, abortPromise]);
        return { html, fromCache: 'miss' };
      } catch (err) {
        if (err.message === 'CLIENT_ABORTED') {
          // کلاینت قطع شد؛ ساخت در پس‌زمینه ادامه می‌یابد و در کش ثبت می‌شود.
          return { html: null, fromCache: 'detached', detached: true };
        }
        throw err;
      }
    }

    try {
      const html = await task;
      return { html, fromCache: 'miss' };
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** نمونه‌ساز تزریق‌ناپذیر برای تست */
function createReportCache(options) {
  return new ReportCache(options);
}

/** نمونهٔ سراسری برای مسیر `/api/report` */
const reportCache = new ReportCache();

module.exports = { ReportCache, createReportCache, reportCache, DEFAULT_TTL_MS, DEFAULT_STALE_MS, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BUILD_MS };
